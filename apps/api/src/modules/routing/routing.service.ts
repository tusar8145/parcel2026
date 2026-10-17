import { Injectable, Logger } from "@nestjs/common";
import type { z } from "zod";
import { PARCEL_STATUS_LABEL, type ParcelStatus } from "@delivery-fast/shared";
import { PrismaService, type Db } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import type { Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { AppError, forbidden, notFound } from "../../common/errors";
import { env } from "../../config/env";
import type { Parcel, Prisma } from "../../generated/prisma/client";
import { GeoService } from "../geo/geo.service";
import { ParcelsService } from "../parcels/parcels.service";
import { opsHubScope } from "../parcels/ops-scope";
import { describeMissing, missingFor } from "../parcels/incomplete";
import { resolveZone } from "../network/zone-resolver";
import { codeVariants, dhakaDay, haversineMeters, NEEDS_PICKUP_RIDER } from "../ops/ops-common";
import type { acceptSuggestionsSchema, geocodeSchema, mapQuerySchema, optimizeSchema, plansQuerySchema, suggestionsQuerySchema } from "./routing.schemas";

type LatLng = { lat: number; lng: number };
export interface Stop {
  seq: number;
  trackingId: string;
  kind: "pickup" | "delivery";
  lat: number;
  lng: number;
  label: string;
  approximate: boolean;
  etaSeconds: number;
}

const PICKUP_OPEN: ParcelStatus[] = ["PICKUP_ASSIGNED", "PICKUP_CONFIRMED"];
const DELIVERY_OPEN: ParcelStatus[] = ["ASSIGNED", "OUT_FOR_DELIVERY", "RETRY_SCHEDULED"];
const DEFAULT_DAILY_CAPACITY = 40;
/** Fallback planning: city traffic speed, a road-distance factor and minutes spent per stop. */
const CITY_SPEED_MPS = 18_000 / 3600;
const ROAD_FACTOR = 1.35;
const SERVICE_SECONDS = 5 * 60;
/** The public OSRM demo server accepts at most 100 coordinates. */
const OSRM_MAX_POINTS = 100;
const inBangladesh = (p: LatLng) => p.lat > 20.3 && p.lat < 26.8 && p.lng > 88 && p.lng < 92.8;
const joinAddress = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(", ");

/**
 * Route optimisation and assignment help for dispatch: geocodes delivery addresses (cached on
 * the parcel), plans each rider's stop order with OSRM (nearest-neighbour fallback), serves the
 * dispatch map, and suggests riders for unassigned parcels by zone, load and distance.
 */
@Injectable()
export class RoutingService {
  private readonly logger = new Logger("Routing");

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly geo: GeoService,
    private readonly parcels: ParcelsService,
  ) {}

  // ───────────── geocoding ─────────────

  /** Fills missing delivery pins: Nominatim first, else the configured zone centre (marked approximate). */
  async geocodeParcels(actor: Actor, input: z.infer<typeof geocodeSchema>) {
    const scope = opsHubScope(actor);
    if (scope && input.hubId && !scope.includes(input.hubId)) throw forbidden("You can only work on your own hub's parcels");
    const hubs = input.hubId ? [input.hubId] : scope;
    const parcels = await this.prisma.parcel.findMany({
      where: {
        deliveryLat: null,
        ...(input.trackingIds ? { trackingId: { in: input.trackingIds.flatMap(codeVariants) } } : { geocodeStatus: null, status: { notIn: ["DELIVERED", "RETURNED", "PICKUP_CANCELLED"] } }),
        ...(hubs ? { currentHubId: { in: hubs } } : {}),
      },
      orderBy: { deliveryDueAt: "asc" },
      take: input.limit,
    });
    const results: { trackingId: string; status: string; lat: number | null; lng: number | null }[] = [];
    for (const p of parcels) {
      const pin = await this.locate(this.prisma, p);
      results.push({ trackingId: p.trackingId, status: pin.status, lat: pin.lat, lng: pin.lng });
    }
    const remaining = await this.prisma.parcel.count({
      where: { deliveryLat: null, geocodeStatus: null, status: { notIn: ["DELIVERED", "RETURNED", "PICKUP_CANCELLED"] }, ...(hubs ? { currentHubId: { in: hubs } } : {}) },
    });
    return { processed: results.length, located: results.filter(r => r.status === "OK").length, approximate: results.filter(r => r.status === "ZONE").length, results, remaining };
  }

  /** Geocodes one parcel's delivery address and stores the pin (OK), the zone centre (ZONE) or FAILED. */
  private async locate(db: Db, p: { id: string; deliveryStreet: string | null; deliveryArea: string | null; deliveryZone: string | null; deliveryDistrict: string | null }) {
    let pin: LatLng | null = null;
    let status = "FAILED";
    // Incomplete orders (imports) may not have an address yet: nothing to locate until it is completed.
    if (env().NODE_ENV !== "test" && p.deliveryStreet && p.deliveryDistrict) {
      try {
        const place = await this.geo.geocode(joinAddress(p.deliveryStreet, p.deliveryArea, p.deliveryZone, p.deliveryDistrict, "Bangladesh"));
        if (place && inBangladesh(place)) {
          pin = { lat: place.lat, lng: place.lng };
          status = "OK";
        }
      } catch (error) {
        this.logger.warn(`Geocoding failed: ${error instanceof Error ? error.message : error}`);
      }
    }
    if (!pin && p.deliveryDistrict && p.deliveryZone) {
      const zone = await resolveZone(db, { district: p.deliveryDistrict, zone: p.deliveryZone, area: p.deliveryArea });
      if (zone?.lat != null && zone.lng != null) {
        pin = { lat: zone.lat, lng: zone.lng };
        status = "ZONE";
      }
    }
    await db.parcel.update({ where: { id: p.id }, data: { deliveryLat: pin?.lat ?? null, deliveryLng: pin?.lng ?? null, geocodedAt: new Date(), geocodeStatus: status } });
    return { status, lat: pin?.lat ?? null, lng: pin?.lng ?? null };
  }

  // ───────────── route optimisation ─────────────

  async optimize(actor: Actor, input: z.infer<typeof optimizeSchema>, meta: RequestMeta) {
    const rider = await this.prisma.rider.findUnique({
      where: { id: input.riderId },
      include: { user: { select: { name: true } }, hub: true, location: true },
    });
    if (!rider) throw notFound("Rider");
    const scope = opsHubScope(actor);
    if (scope && (!rider.hubId || !scope.includes(rider.hubId))) throw forbidden("You can only plan routes for your own hub's riders");

    const parcels = await this.prisma.parcel.findMany({
      where: {
        OR: [
          { deliveryRiderId: rider.id, status: { in: DELIVERY_OPEN } },
          ...(input.includePickups ? [{ pickupRiderId: rider.id, status: { in: PICKUP_OPEN } }] : []),
        ],
      },
      orderBy: { id: "asc" },
      take: 300,
    });
    const stops: Omit<Stop, "seq" | "etaSeconds">[] = [];
    const unlocated: string[] = [];
    let lookups = 0;
    for (const p of parcels) {
      const pickup = PICKUP_OPEN.includes(p.status as ParcelStatus) && p.pickupRiderId === rider.id;
      let pin: LatLng | null = null;
      let approximate = false;
      if (pickup) {
        if (p.pickupLat != null && p.pickupLng != null) pin = { lat: p.pickupLat, lng: p.pickupLng };
        else {
          const zone = await resolveZone(this.prisma, { district: p.pickupDistrict, zone: p.pickupZone, area: p.pickupArea });
          if (zone?.lat != null && zone.lng != null) [pin, approximate] = [{ lat: zone.lat, lng: zone.lng }, true];
        }
      } else {
        if (p.deliveryLat == null && input.geocodeMissing && p.geocodeStatus == null && lookups < 10) {
          lookups++;
          const located = await this.locate(this.prisma, p);
          if (located.lat != null && located.lng != null) [pin, approximate] = [{ lat: located.lat, lng: located.lng }, located.status !== "OK"];
        } else if (p.deliveryLat != null && p.deliveryLng != null) [pin, approximate] = [{ lat: p.deliveryLat, lng: p.deliveryLng }, p.geocodeStatus === "ZONE"];
      }
      if (!pin) {
        unlocated.push(p.trackingId);
        continue;
      }
      stops.push({
        trackingId: p.trackingId,
        kind: pickup ? "pickup" : "delivery",
        lat: pin.lat,
        lng: pin.lng,
        approximate,
        label: pickup ? `Pickup · ${p.senderName} · ${joinAddress(p.pickupStreet, p.pickupArea, p.pickupZone)}` : `${p.recipientName} · ${joinAddress(p.deliveryStreet, p.deliveryArea, p.deliveryZone)}`,
      });
    }

    const fresh = rider.location && Date.now() - rider.location.at.getTime() < 2 * 3600_000 ? { lat: rider.location.lat, lng: rider.location.lng } : null;
    const hubPin = rider.hub?.lat != null && rider.hub.lng != null ? { lat: rider.hub.lat, lng: rider.hub.lng } : null;
    const start: LatLng | null = input.start ?? fresh ?? hubPin ?? (stops[0] ? { lat: stops[0].lat, lng: stops[0].lng } : null);
    const startSource = input.start ? "given" : fresh ? "rider" : hubPin ? "hub" : "first stop";
    if (!stops.length || !start)
      return { rider: { id: rider.id, label: `${rider.code} · ${rider.user.name}` }, plan: null, unlocated, message: parcels.length ? "None of the rider's stops could be located" : "The rider has no open stops" };

    const solved = (await this.osrm(start, stops)) ?? this.nearestNeighbour(start, stops);
    const plan = await this.prisma.$transaction(async tx => {
      const created = await tx.routePlan.create({
        data: {
          riderId: rider.id,
          hubId: rider.hubId,
          workDate: new Date(`${dhakaDay()}T00:00:00Z`),
          engine: solved.engine,
          stops: solved.stops as unknown as Prisma.InputJsonValue,
          geometry: solved.geometry as unknown as Prisma.InputJsonValue,
          distanceMeters: Math.round(solved.distance),
          durationSeconds: Math.round(solved.duration),
          createdById: actor.kind === "user" ? actor.userId : null,
        },
      });
      await this.audit.record(actor, { action: "route.optimize", entityType: "rider", entityId: rider.id, data: { planId: created.id, engine: solved.engine, stops: solved.stops.length } }, meta, tx);
      return created;
    });
    return { rider: { id: rider.id, label: `${rider.code} · ${rider.user.name}` }, plan: { ...plan, start, startSource }, unlocated };
  }

  /** OSRM trip service (road network). null when unavailable, too many stops or in tests. */
  private async osrm(start: LatLng, stops: Omit<Stop, "seq" | "etaSeconds">[]) {
    if (env().NODE_ENV === "test" || stops.length + 1 > OSRM_MAX_POINTS) return null;
    const coords = [start, ...stops].map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
    const url = `${env().OSRM_URL.replace(/\/$/, "")}/trip/v1/driving/${coords}?source=first&roundtrip=false&destination=any&geometries=geojson&overview=full`;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(env().OSRM_TIMEOUT_MS), headers: { "user-agent": "DeliveryFast/1.0 (route planning)" } });
      if (!response.ok) throw new Error(`OSRM ${response.status}`);
      const body = (await response.json()) as {
        code: string;
        waypoints?: { waypoint_index: number }[];
        trips?: { distance: number; duration: number; geometry: { coordinates: [number, number][] }; legs: { duration: number }[] }[];
      };
      const trip = body.trips?.[0];
      if (body.code !== "Ok" || !trip || !body.waypoints) throw new Error(`OSRM ${body.code}`);
      const order = stops.map((s, i) => ({ s, at: body.waypoints![i + 1].waypoint_index })).sort((a, b) => a.at - b.at);
      let eta = 0;
      const planned: Stop[] = order.map(({ s }, i) => {
        eta += (trip.legs[i]?.duration ?? 0) + (i ? SERVICE_SECONDS : 0);
        return { ...s, seq: i + 1, etaSeconds: Math.round(eta) };
      });
      return {
        engine: "OSRM" as const,
        stops: planned,
        geometry: trip.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
        distance: trip.distance,
        duration: trip.duration + SERVICE_SECONDS * planned.length,
      };
    } catch (error) {
      this.logger.warn(`OSRM unavailable, using nearest neighbour: ${error instanceof Error ? error.message : error}`);
      return null;
    }
  }

  /** Greedy nearest-neighbour order with straight-line distances scaled to roads. */
  private nearestNeighbour(start: LatLng, stops: Omit<Stop, "seq" | "etaSeconds">[]) {
    const left = [...stops];
    const planned: Stop[] = [];
    let here = start;
    let distance = 0;
    let eta = 0;
    while (left.length) {
      let best = 0;
      let bestDistance = Infinity;
      left.forEach((s, i) => {
        const d = haversineMeters(here, s);
        if (d < bestDistance) [best, bestDistance] = [i, d];
      });
      const [next] = left.splice(best, 1);
      const road = bestDistance * ROAD_FACTOR;
      distance += road;
      eta += road / CITY_SPEED_MPS + (planned.length ? SERVICE_SECONDS : 0);
      planned.push({ ...next, seq: planned.length + 1, etaSeconds: Math.round(eta) });
      here = next;
    }
    return {
      engine: "NEAREST_NEIGHBOUR" as const,
      stops: planned,
      geometry: [[start.lat, start.lng], ...planned.map(s => [s.lat, s.lng])],
      distance,
      duration: eta + SERVICE_SECONDS,
    };
  }

  /** The latest plan per rider for a Dhaka day (default today). */
  async plans(actor: Actor, query: z.infer<typeof plansQuerySchema>) {
    const scope = opsHubScope(actor);
    if (scope && query.hubId && !scope.includes(query.hubId)) throw forbidden("You can only see your own hub's routes");
    const hubs = query.hubId ? [query.hubId] : scope;
    const rows = await this.prisma.routePlan.findMany({
      where: { workDate: new Date(`${query.date ?? dhakaDay()}T00:00:00Z`), riderId: query.riderId, ...(hubs ? { hubId: { in: hubs } } : {}) },
      include: { rider: { select: { id: true, code: true, user: { select: { name: true } } } } },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    const latest = new Map<string, (typeof rows)[number]>();
    for (const r of rows) if (!latest.has(r.riderId)) latest.set(r.riderId, r);
    return [...latest.values()].map(({ rider, ...plan }) => ({ ...plan, rider: { id: rider.id, label: `${rider.code} · ${rider.user.name}` } }));
  }

  // ───────────── map ─────────────

  /** Hubs, zone centres and open parcels with pins for the dispatch map (riders: GET /ops/rider-locations). */
  async map(actor: Actor, query: z.infer<typeof mapQuerySchema>) {
    const scope = opsHubScope(actor);
    if (scope && query.hubId && !scope.includes(query.hubId)) throw forbidden("You can only see your own hub's map");
    const hubs = query.hubId ? [query.hubId] : scope;
    const layer: Record<typeof query.layer, Prisma.ParcelWhereInput> = {
      // Drop-offs waiting for the sender are not on the road: no pickup pin.
      all: { OR: [NEEDS_PICKUP_RIDER, { status: { in: [...PICKUP_OPEN, "AT_HUB", "IN_TRANSIT", ...DELIVERY_OPEN, "EXCEPTION"] } }] },
      unassigned: { OR: [NEEDS_PICKUP_RIDER, { status: { in: ["AT_HUB", "IN_TRANSIT"] }, deliveryRiderId: null }] },
      pickups: { OR: [NEEDS_PICKUP_RIDER, { status: { in: PICKUP_OPEN } }] },
      deliveries: { status: { in: ["AT_HUB", ...DELIVERY_OPEN] } },
    };
    const [hubRows, zones, parcels, unlocated] = await Promise.all([
      this.prisma.hub.findMany({ where: { active: true, ...(hubs ? { id: { in: hubs } } : {}) }, select: { id: true, code: true, name: true, district: true, lat: true, lng: true, capacity: true } }),
      this.prisma.deliveryZone.findMany({ where: { active: true, lat: { not: null }, ...(hubs ? { hubId: { in: hubs } } : {}) }, select: { id: true, code: true, name: true, district: true, lat: true, lng: true, hubId: true } }),
      this.prisma.parcel.findMany({
        where: { AND: [layer[query.layer], hubs ? { OR: [{ currentHubId: { in: hubs } }, { currentHubId: null }] } : {}, { OR: [{ deliveryLat: { not: null } }, { pickupLat: { not: null } }] }] },
        select: {
          trackingId: true,
          status: true,
          serviceLevel: true,
          slaState: true,
          recipientName: true,
          deliveryZone: true,
          pickupZone: true,
          deliveryLat: true,
          deliveryLng: true,
          pickupLat: true,
          pickupLng: true,
          geocodeStatus: true,
          deliveryRiderId: true,
          pickupRiderId: true,
          currentHubId: true,
        },
        orderBy: { id: "desc" },
        take: query.limit,
      }),
      this.prisma.parcel.count({ where: { AND: [layer[query.layer], hubs ? { currentHubId: { in: hubs } } : {}, { deliveryLat: null, pickupLat: null }] } }),
    ]);
    const points = parcels
      .map(p => {
        const pickupStage = p.status === "PENDING_CONFIRMATION" || PICKUP_OPEN.includes(p.status as ParcelStatus);
        const lat = pickupStage ? (p.pickupLat ?? p.deliveryLat) : (p.deliveryLat ?? p.pickupLat);
        const lng = pickupStage ? (p.pickupLng ?? p.deliveryLng) : (p.deliveryLng ?? p.pickupLng);
        return {
          trackingId: p.trackingId,
          status: p.status,
          statusLabel: PARCEL_STATUS_LABEL[p.status as ParcelStatus],
          kind: pickupStage ? "pickup" : "delivery",
          sla: p.slaState,
          zone: pickupStage ? p.pickupZone : p.deliveryZone,
          recipient: p.recipientName,
          lat: lat!,
          lng: lng!,
          approximate: !pickupStage && p.geocodeStatus === "ZONE",
          riderId: pickupStage ? p.pickupRiderId : p.deliveryRiderId,
          hubId: p.currentHubId,
        };
      })
      .filter(p => p.lat != null && p.lng != null);
    return { hubs: hubRows, zones, parcels: points, unlocated, truncated: parcels.length === query.limit };
  }

  // ───────────── assignment suggestions ─────────────

  /**
   * A rider for each unassigned parcel: the route's default rider and riders covering the zone
   * first, then spare capacity (dailyCapacity, default 40 stops) and distance from the rider's
   * live position. Suggestions in one call are spread so no rider is over-filled.
   */
  async suggestions(actor: Actor, query: z.infer<typeof suggestionsQuerySchema>) {
    const scope = opsHubScope(actor);
    if (scope && query.hubId && !scope.includes(query.hubId)) throw forbidden("You can only plan your own hub's work");
    const hubs = query.hubId ? [query.hubId] : scope;
    const [deliveries, pickups] = await Promise.all([
      query.kind === "pickup"
        ? []
        : this.prisma.parcel.findMany({
            // Collect-from-hub parcels get no delivery rider; on-demand work first (service packages).
            where: { status: "AT_HUB", deliveryRiderId: null, OR: [{ lastMile: null }, { lastMile: { not: "HUB_COLLECT" } }], ...(hubs ? { currentHubId: { in: hubs } } : {}) },
            orderBy: [{ onDemand: "desc" }, { deliveryDueAt: "asc" }, { id: "asc" }],
            take: query.limit,
          }),
      query.kind === "delivery" ? [] : this.prisma.parcel.findMany({ where: NEEDS_PICKUP_RIDER, orderBy: [{ onDemand: "desc" }, { pickupDueAt: "asc" }, { id: "asc" }], take: query.limit * 3 }),
    ]);
    const work = [...deliveries.map(p => ({ p, kind: "delivery" as const })), ...pickups.map(p => ({ p, kind: "pickup" as const }))];
    return this.rank(scope, hubs, work, query.limit);
  }

  /**
   * A suggested rider for each of these parcels that waits for one (a pickup request, or a parcel at
   * a hub without a delivery rider), by the same rules as GET /routing/suggestions. Bulk updates
   * pre-fill their "Suggested rider" column with it.
   */
  async suggestFor(actor: Actor, parcels: Parcel[]) {
    const scope = opsHubScope(actor);
    const work = parcels.flatMap((p): { p: Parcel; kind: "pickup" | "delivery" }[] =>
      p.status === "PENDING_CONFIRMATION" && p.intake === "PICKUP"
        ? [{ p, kind: "pickup" as const }]
        : p.status === "AT_HUB" && !p.deliveryRiderId && (!scope || (!!p.currentHubId && scope.includes(p.currentHubId)))
          ? [{ p, kind: "delivery" as const }]
          : [],
    );
    if (!work.length) return { suggestions: [], unmatched: [] };
    return this.rank(scope, scope, work, Number.MAX_SAFE_INTEGER);
  }

  /** Scores the riders (route, zone, load, distance, shift) for each parcel; each pick counts towards that rider's load. */
  private async rank(scope: string[] | null, hubs: string[] | null, work: { p: Parcel; kind: "pickup" | "delivery" }[], limit: number) {
    const [riders] = await Promise.all([
      this.prisma.rider.findMany({
        where: { active: true, user: { status: "ACTIVE" }, ...(hubs ? { hubId: { in: hubs } } : {}) },
        include: {
          user: { select: { name: true } },
          location: true,
          _count: {
            select: {
              deliveries: { where: { status: { in: [...DELIVERY_OPEN, "EXCEPTION"] } } },
              pickups: { where: { status: { in: PICKUP_OPEN } } },
            },
          },
        },
      }),
    ]);
    const zoneCache = new Map<string, Awaited<ReturnType<typeof resolveZone>>>();
    const zoneOf = async (district: string, zone: string, area: string | null) => {
      const key = `${district}|${zone}|${area ?? ""}`.toLowerCase();
      if (!zoneCache.has(key)) zoneCache.set(key, await resolveZone(this.prisma, { district, zone, area }));
      return zoneCache.get(key)!;
    };
    const extra = new Map<string, number>();
    const suggestions: {
      trackingId: string;
      kind: "pickup" | "delivery";
      zone: string;
      configuredZone: string | null;
      dueAt: Date | null;
      rider: { id: string; code: string; label: string; status: string; load: number; capacity: number };
      score: number;
      reasons: string[];
    }[] = [];
    const unmatched: { trackingId: string; kind: "pickup" | "delivery"; reason: string }[] = [];

    for (const { p, kind } of work) {
      if (suggestions.length + unmatched.length >= limit) break;
      const district = kind === "pickup" ? p.pickupDistrict : p.deliveryDistrict;
      const zoneName = kind === "pickup" ? p.pickupZone : p.deliveryZone;
      // Incomplete orders can't go out for delivery until the recipient and destination are known.
      const missing = kind === "delivery" ? missingFor(p, "ASSIGNED") : [];
      if (!district || !zoneName || missing.length) {
        unmatched.push({ trackingId: p.trackingId, kind, reason: `Delivery details are missing (incomplete order${missing.length ? `: ${describeMissing(missing)}` : ""})` });
        continue;
      }
      const zone = await zoneOf(district, zoneName, kind === "pickup" ? p.pickupArea : p.deliveryArea);
      const hubId = kind === "delivery" ? p.currentHubId : zone?.hubId ?? null;
      // Hub operators only get pickups in zones their hub serves.
      if (kind === "pickup" && scope && (!hubId || !scope.includes(hubId))) continue;
      const pin = kind === "pickup" ? (p.pickupLat != null ? { lat: p.pickupLat, lng: p.pickupLng! } : null) : p.deliveryLat != null ? { lat: p.deliveryLat, lng: p.deliveryLng! } : null;
      const target = pin ?? (zone?.lat != null && zone.lng != null ? { lat: zone.lat, lng: zone.lng } : null);
      let best: { score: number; reasons: string[]; rider: (typeof riders)[number] } | null = null;
      for (const r of riders) {
        if (hubId && r.hubId && r.hubId !== hubId) continue;
        const capacity = r.dailyCapacity ?? DEFAULT_DAILY_CAPACITY;
        const load = r._count.deliveries + r._count.pickups + (extra.get(r.id) ?? 0);
        if (load >= capacity) continue;
        const reasons: string[] = [];
        let score = 0;
        if (zone?.route?.active && zone.route.defaultRiderId === r.id) {
          score += 50;
          reasons.push(`default rider of route ${zone.route.code}`);
        }
        if (r.zone && [zoneName, zone?.code, zone?.route?.code].some(z => z && z.toLowerCase() === r.zone!.toLowerCase())) {
          score += 30;
          reasons.push(`covers ${zoneName}`);
        }
        const spare = (capacity - load) / capacity;
        score += 20 * spare;
        reasons.push(`${load}/${capacity} stops`);
        if (target && r.location) {
          const km = haversineMeters(target, r.location) / 1000;
          score += 20 * Math.max(0, 1 - km / 15);
          reasons.push(`${km.toFixed(1)} km away`);
        }
        if (r.status === "ONLINE") score += 10;
        else {
          score -= 10;
          reasons.push(r.status === "ON_BREAK" ? "on break" : "off shift");
        }
        if (!best || score > best.score) best = { score, reasons, rider: r };
      }
      if (!best) {
        unmatched.push({ trackingId: p.trackingId, kind, reason: riders.length ? "Every rider at this hub is at capacity" : "No active riders" });
        continue;
      }
      extra.set(best.rider.id, (extra.get(best.rider.id) ?? 0) + 1);
      const r = best.rider;
      suggestions.push({
        trackingId: p.trackingId,
        kind,
        zone: zoneName,
        configuredZone: zone?.code ?? null,
        dueAt: kind === "pickup" ? p.pickupDueAt : p.deliveryDueAt,
        rider: { id: r.id, code: r.code, label: `${r.code} · ${r.user.name}`, status: r.status, load: r._count.deliveries + r._count.pickups, capacity: r.dailyCapacity ?? DEFAULT_DAILY_CAPACITY },
        score: Math.round(best.score),
        reasons: best.reasons,
      });
    }
    return { suggestions, unmatched };
  }

  /** Assigns accepted suggestions one by one (pickup or delivery by the parcel's stage); a refusal doesn't stop the rest. */
  async accept(actor: Actor, input: z.infer<typeof acceptSuggestionsSchema>, meta: RequestMeta) {
    const assigned: { trackingId: string; riderId: string; kind: string }[] = [];
    const failed: { trackingId: string; message: string }[] = [];
    for (const item of input.items) {
      try {
        const parcel = await this.prisma.parcel.findFirst({ where: { trackingId: { in: codeVariants(item.trackingId) } }, select: { trackingId: true, status: true } });
        if (!parcel) throw notFound(`Parcel ${item.trackingId}`);
        const pickup = ["PENDING_CONFIRMATION", ...PICKUP_OPEN].includes(parcel.status);
        const body = { riderId: item.riderId, note: "Assigned from dispatch suggestions" };
        if (pickup) await this.parcels.assignPickup(actor, parcel.trackingId, body, meta);
        else await this.parcels.assignDelivery(actor, parcel.trackingId, body, meta);
        assigned.push({ trackingId: parcel.trackingId, riderId: item.riderId, kind: pickup ? "pickup" : "delivery" });
      } catch (error) {
        failed.push({ trackingId: item.trackingId, message: error instanceof AppError ? (error.getResponse() as { message: string }).message : "Couldn't assign" });
      }
    }
    return { assigned, failed };
  }
}
