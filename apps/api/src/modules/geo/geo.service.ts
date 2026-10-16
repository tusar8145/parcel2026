import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import { RedisService } from "../../common/redis.service";
import { AppError } from "../../common/errors";
import { env } from "../../config/env";

export interface Place {
  /** One line for the suggestion list, e.g. "Road 11, Banani, Dhaka". */
  label: string;
  lat: number;
  lng: number;
  /** Best-effort address parts for filling the booking form. */
  street: string | null;
  area: string | null;
  zone: string | null;
  district: string | null;
  postcode: string | null;
  source: "nominatim";
}

interface NominatimResult {
  lat: string;
  lon: string;
  display_name: string;
  address?: Record<string, string | undefined>;
  error?: string;
}

const SEARCH_TTL_SECONDS = 7 * 86_400;
const REVERSE_TTL_SECONDS = 30 * 86_400;
const EMPTY_TTL_SECONDS = 3600;
const EMPTY = "__none__";
const MAX_WAIT_MS = 4000;
const SLOT_KEY = "geo:upstream-slot";

/** "Road 11, Banani, Dhaka, Dhaka Metropolitan, Dhaka District, Dhaka Division, 1213, Bangladesh" → "Road 11, Banani, Dhaka". */
function shortLabel(displayName: string) {
  const parts = displayName
    .split(",")
    .map(p => p.trim())
    .filter(p => p && !/^(Bangladesh|\d{4})$/.test(p) && !/ (Division|District|Metropolitan)$/i.test(p));
  return [...new Set(parts)].slice(0, 5).join(", ");
}

const unavailable = () =>
  new AppError("GEO_UNAVAILABLE", "Address search is busy right now. Type the address yourself or try again in a moment.", HttpStatus.SERVICE_UNAVAILABLE);

/**
 * Place search and reverse geocoding backed by OpenStreetMap Nominatim, following its
 * usage policy: an identifying User-Agent, results cached in Redis, and at most one
 * upstream request per NOMINATIM_MIN_INTERVAL_MS across every API instance.
 */
@Injectable()
export class GeoService {
  private readonly logger = new Logger(GeoService.name);

  constructor(private readonly redis: RedisService) {}

  async search(q: string, limit = 5): Promise<Place[]> {
    const text = q.trim().replace(/\s+/g, " ");
    const key = `geo:search:${this.digest(`${text.toLowerCase()}|${limit}|${env().NOMINATIM_COUNTRY_CODES}`)}`;
    return this.cached(key, SEARCH_TTL_SECONDS, async () => {
      const rows = await this.fetch<NominatimResult[]>("search", {
        q: text,
        format: "jsonv2",
        addressdetails: "1",
        limit: String(limit),
        countrycodes: env().NOMINATIM_COUNTRY_CODES,
      });
      return Array.isArray(rows) ? rows.map(r => this.toPlace(r)) : [];
    });
  }

  async reverse(lat: number, lng: number): Promise<Place | null> {
    // ~11 m grid, so nearby pins share a cache entry.
    const rlat = Math.round(lat * 10_000) / 10_000;
    const rlng = Math.round(lng * 10_000) / 10_000;
    const result = await this.cached(`geo:reverse:${rlat},${rlng}`, REVERSE_TTL_SECONDS, async () => {
      const row = await this.fetch<NominatimResult>("reverse", { lat: String(rlat), lon: String(rlng), format: "jsonv2", addressdetails: "1", zoom: "18" });
      return !row || row.error || !row.lat ? [] : [this.toPlace(row)];
    });
    // Keep the exact pin the person placed; the address comes from the nearest match.
    return result[0] ? { ...result[0], lat, lng } : null;
  }

  /** Server-side helper: the best match for a free-text address, or null. */
  async geocode(text: string): Promise<Place | null> {
    return (await this.search(text, 1))[0] ?? null;
  }

  private async cached(key: string, ttl: number, load: () => Promise<Place[]>): Promise<Place[]> {
    const hit = await this.redis.get(key).catch(() => null);
    if (hit) return hit === EMPTY ? [] : (JSON.parse(hit) as Place[]);
    const places = await load();
    await this.redis.set(key, places.length ? JSON.stringify(places) : EMPTY, "EX", places.length ? ttl : EMPTY_TTL_SECONDS).catch(() => undefined);
    return places;
  }

  /** Waits (briefly) for the shared upstream slot in Redis, then calls Nominatim. */
  private async fetch<T>(path: string, params: Record<string, string>): Promise<T> {
    const { NOMINATIM_URL, NOMINATIM_USER_AGENT, NOMINATIM_EMAIL, NOMINATIM_TIMEOUT_MS, NOMINATIM_MIN_INTERVAL_MS } = env();
    if (NOMINATIM_MIN_INTERVAL_MS > 0) {
      const deadline = Date.now() + MAX_WAIT_MS;
      while (!(await this.redis.set(SLOT_KEY, "1", "PX", NOMINATIM_MIN_INTERVAL_MS, "NX"))) {
        if (Date.now() > deadline) throw unavailable();
        const wait = await this.redis.pttl(SLOT_KEY);
        await new Promise(r => setTimeout(r, Math.min(Math.max(wait, 50), 1000)));
      }
    }
    const url = new URL(path, NOMINATIM_URL.endsWith("/") ? NOMINATIM_URL : `${NOMINATIM_URL}/`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (NOMINATIM_EMAIL) url.searchParams.set("email", NOMINATIM_EMAIL);
    url.searchParams.set("accept-language", "en");
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": NOMINATIM_USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(NOMINATIM_TIMEOUT_MS),
      });
      if (!res.ok) {
        this.logger.warn({ status: res.status, path }, "Nominatim request failed");
        throw unavailable();
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof AppError) throw err;
      this.logger.warn({ err: (err as Error).message, path }, "Nominatim request failed");
      throw unavailable();
    }
  }

  private toPlace(r: NominatimResult): Place {
    const a = r.address ?? {};
    const street = [a.house_number, a.road ?? a.pedestrian ?? a.footway].filter(Boolean).join(" ") || null;
    const area = a.neighbourhood ?? a.residential ?? a.quarter ?? a.hamlet ?? null;
    const zone = a.suburb ?? a.city_district ?? a.town ?? a.village ?? null;
    const district = (a.state_district ?? a.city ?? a.county ?? null)?.replace(/ District$/i, "") ?? null;
    return {
      label: shortLabel(r.display_name),
      lat: Number(r.lat),
      lng: Number(r.lon),
      street,
      area,
      zone,
      district,
      postcode: a.postcode ?? null,
      source: "nominatim",
    };
  }

  private digest = (s: string) => createHash("sha1").update(s).digest("hex");
}
