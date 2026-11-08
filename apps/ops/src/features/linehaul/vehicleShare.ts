/**
 * "I'm travelling in this vehicle" (shared/vehicle-share.js): this device's position becomes a linehaul trip's vehicle
 * position. A position every `intervalMinutes` (GET /settings/location) and at once after a move of `movementMeters`,
 * until stopped or the trip arrives (the server answers { stopped: true }). Only while the page is open.
 */
import { useSyncExternalStore } from "react";
import { api, describe } from "@/lib/api";
import { toast } from "@/ui/toast";

const MIN_GAP_MS = 15_000;
const MAX_ACCURACY_M = 1000;
export const REASON: Record<string, string> = {
  STOPPED: "Vehicle location sharing stopped.",
  TRIP_ARRIVED: "The trip has arrived: vehicle location sharing ended.",
  TRIP_CLOSED: "The trip was closed: vehicle location sharing ended.",
  TRIP_CANCELLED: "The trip was cancelled: vehicle location sharing ended.",
  REPLACED: "You started sharing another trip.",
  TAKEN_OVER: "Someone else on this trip is now sharing the vehicle's location.",
};
interface Fix {
  lat: number;
  lng: number;
  accuracy: number;
  heading: number | null;
  speed: number | null;
  at: number;
}
export interface Share {
  id: string;
  trip: { id: string; number: string; vehicleRegNo: string; route: string };
}
const distance = (a: Fix, b: Fix) => {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
};

export const share = {
  share: null as Share | null,
  settings: { intervalMinutes: 5, movementMeters: 50 },
  status: "idle" as "idle" | "waiting" | "on" | "denied",
  lastSentAt: null as number | null,
  lastSent: null as Fix | null,
  error: null as string | null,
  loaded: false,
  version: 0,
};
const subs = new Set<() => void>();
const changed = () => {
  share.version++;
  subs.forEach(s => s());
};
let watchId: number | null = null;
let sending: Promise<string> | null = null;
const intervalMs = () => (share.settings?.intervalMinutes || 5) * 60_000;

function watch() {
  if (watchId !== null || !navigator.geolocation || !share.share) return;
  share.status = "waiting";
  watchId = navigator.geolocation.watchPosition(p => onFix(p), onError, { enableHighAccuracy: true, maximumAge: 15_000, timeout: 60_000 });
  changed();
}
function unwatch() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}
function onFix(position: GeolocationPosition, force = false) {
  const c = position.coords;
  const fix: Fix = { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy, heading: Number.isFinite(c.heading) ? c.heading : null, speed: Number.isFinite(c.speed) ? c.speed : null, at: position.timestamp || Date.now() };
  if (share.status === "waiting") share.status = "on";
  const since = share.lastSentAt ? Date.now() - share.lastSentAt : Infinity;
  const moved = share.lastSent ? distance(share.lastSent, fix) : Infinity;
  if (!force && since < intervalMs() && (since < MIN_GAP_MS || moved < (share.settings?.movementMeters || 50) || fix.accuracy > MAX_ACCURACY_M)) return;
  sending = send(fix);
}
function onError(error: GeolocationPositionError) {
  share.error = error.code === 1 ? "denied" : error.code === 3 ? "timeout" : "unavailable";
  if (error.code === 1) {
    share.status = "denied";
    unwatch();
    toast("Location is blocked for this site. Allow location in the browser settings to share the vehicle's position.", "bad");
  }
  changed();
}
async function send(fix: Fix) {
  const s = share.share;
  if (!s) return "idle";
  share.lastSent = fix;
  share.lastSentAt = Date.now();
  try {
    const result = await api<{ stopped?: boolean; reason?: string }>(`/vehicle-shares/${encodeURIComponent(s.id)}/location`, {
      method: "POST",
      body: { lat: fix.lat, lng: fix.lng, accuracy: Math.min(10_000, fix.accuracy), heading: fix.heading, speed: fix.speed != null ? Math.min(100, fix.speed) : null, at: new Date(fix.at).toISOString() },
    });
    if (result?.stopped) {
      ended(result.reason);
      return "stopped";
    }
    share.status = "on";
    share.error = null;
    changed();
    return "sent";
  } catch (error) {
    share.error = describe(error);
    changed();
    return "failed";
  }
}
function ended(reason?: string) {
  unwatch();
  const was = share.share;
  Object.assign(share, { share: null, status: "idle", lastSent: null, lastSentAt: null });
  changed();
  if (was) toast(REASON[reason || "STOPPED"] || REASON.STOPPED);
}
const current = () =>
  new Promise<GeolocationPosition>((resolve, reject) => {
    if (!navigator.geolocation) return reject(Object.assign(new Error("unsupported"), { code: 0 }));
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 });
  });

setInterval(() => {
  if (!share.share || share.status === "denied" || document.visibilityState !== "visible") return;
  if (share.lastSentAt && Date.now() - share.lastSentAt < intervalMs()) return;
  current()
    .then(p => onFix(p))
    .catch(() => undefined);
}, 30_000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && share.share) {
    watch();
    if (!share.lastSentAt || Date.now() - share.lastSentAt >= intervalMs()) void vehicleShare.sendNow(true);
  }
});

export const vehicleShare = {
  async load() {
    try {
      const mine = await api<{ settings?: typeof share.settings; share: Share | null; ended?: { trip: { number: string }; reason: string } }>("/vehicle-shares/mine");
      share.settings = mine.settings || share.settings;
      share.share = mine.share;
      if (mine.ended) toast(`${mine.ended.trip.number}: ${REASON[mine.ended.reason] || REASON.STOPPED}`);
      if (share.share) watch();
      else unwatch();
    } catch (error) {
      if ((error as { status?: number })?.status !== 403) share.error = describe(error);
    }
    share.loaded = true;
    changed();
  },
  trips: async (q = "") => (await api<{ items: { id: string; number: string; vehicleRegNo: string; route: string; status: string; sharing?: { name: string } | null }[] }>(`/vehicle-shares/trips${q ? `?q=${encodeURIComponent(q)}` : ""}`)).items,
  async start(trip: string) {
    const r = await api<{ share: Share; settings?: typeof share.settings }>("/vehicle-shares", { method: "POST", body: { trip } });
    Object.assign(share, { share: r.share, settings: r.settings || share.settings, lastSent: null, lastSentAt: null, error: null });
    watch();
    changed();
    void vehicleShare.sendNow(true);
    return r.share;
  },
  async stop() {
    if (!share.share) return;
    await api(`/vehicle-shares/${encodeURIComponent(share.share.id)}/stop`, { method: "POST" });
    ended("STOPPED");
  },
  async sendNow(quiet = false) {
    if (!share.share) return;
    try {
      onFix(await current(), true);
      const result = await sending;
      if (!quiet && result !== "stopped") toast(result === "sent" ? "Vehicle location sent." : `The vehicle's location couldn't be sent${share.error ? `: ${share.error}` : ""}.`);
    } catch (error) {
      const code = (error as { code?: number })?.code;
      if (code === 1) onError(error as GeolocationPositionError);
      else if (!quiet) toast(code === 3 ? "No GPS fix yet. Try again near a window." : "The location isn't available right now.");
    }
  },
  describe() {
    const s = share.share;
    if (!s) return "";
    const minutes = share.lastSentAt ? Math.floor((Date.now() - share.lastSentAt) / 60_000) : null;
    const sent = share.status === "denied" ? "location blocked" : minutes == null ? "waiting for a GPS fix…" : `last sent ${minutes < 1 ? "just now" : `${minutes} min ago`}`;
    return `Sharing ${s.trip.vehicleRegNo} · ${s.trip.route} (${s.trip.number}) · ${sent}`;
  },
};

export function useVehicleShare() {
  useSyncExternalStore(
    cb => (subs.add(cb), () => void subs.delete(cb)),
    () => share.version,
  );
  return share;
}
