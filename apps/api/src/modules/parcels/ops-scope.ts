import type { Actor } from "../../common/auth/actor";

/** Bangladesh has no daylight saving time: local time is always UTC+6. */
const DHAKA_OFFSET_MS = 6 * 3600_000;
const DAY_MS = 24 * 3600_000;

/** Midnight (Dhaka time) at the start of the day containing `now`. */
export function dhakaDayStart(now = new Date()): Date {
  const local = now.getTime() + DHAKA_OFFSET_MS;
  return new Date(local - (local % DAY_MS) - DHAKA_OFFSET_MS);
}

/** Midnight (Dhaka time) on the first day of the month containing `now`, shifted by `monthOffset` months. */
export function dhakaMonthStart(now = new Date(), monthOffset = 0): Date {
  const local = new Date(now.getTime() + DHAKA_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + monthOffset, 1) - DHAKA_OFFSET_MS);
}

/** Monday 00:00 (Dhaka time) of the week containing `now`. */
export function dhakaWeekStart(now = new Date()): Date {
  const day = dhakaDayStart(now);
  const weekday = new Date(day.getTime() + DHAKA_OFFSET_MS).getUTCDay(); // 0 = Sunday
  return new Date(day.getTime() - ((weekday + 6) % 7) * DAY_MS);
}

/** "2026-10-15" read as that calendar day in Dhaka; returns [start, end). */
export function dhakaDateRange(from: string, to: string): [Date, Date] {
  const start = new Date(`${from}T00:00:00+06:00`);
  const end = new Date(new Date(`${to}T00:00:00+06:00`).getTime() + DAY_MS);
  return [start, end];
}

export const addDays = (d: Date, days: number) => new Date(d.getTime() + days * DAY_MS);

const UNSCOPED_OPS_ROLES = new Set(["SUPER_ADMIN", "OPS_MANAGER"]);

/**
 * Hubs a staff member works at. null = the whole network (operations managers, super
 * admins, and staff without a hub role). Hub operators are limited to their own hubs.
 */
export function opsHubScope(actor: Actor): string[] | null {
  if (actor.kind !== "user") return [];
  if (actor.roles.some(r => UNSCOPED_OPS_ROLES.has(r.role))) return null;
  const hubRoles = actor.roles.filter(r => r.role === "HUB_OPERATOR");
  if (!hubRoles.length || hubRoles.some(r => !r.hubId)) return null;
  return hubRoles.map(r => r.hubId!);
}
