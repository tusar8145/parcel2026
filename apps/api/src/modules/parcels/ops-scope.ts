import type { Actor } from "../../common/auth/actor";
import type { Db } from "../../common/prisma.service";
import { forbidden } from "../../common/errors";

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
  // A franchise account is always limited to its own (franchise) hub.
  const franchise = actor.roles.filter(r => r.role === "FRANCHISE");
  if (franchise.length) return franchise.flatMap(r => (r.hubId ? [r.hubId] : []));
  const hubRoles = actor.roles.filter(r => r.role === "HUB_OPERATOR");
  if (!hubRoles.length || hubRoles.some(r => !r.hubId)) return null;
  return hubRoles.map(r => r.hubId!);
}

/**
 * Franchise riders work only for their franchise hub: a franchise may pick only its own riders, and staff of other
 * hubs can't pick a franchise's riders (operations managers can: a franchise is a hub of the network).
 */
export async function assertRiderAssignable(db: Db, actor: Actor, riderId: string) {
  const rider = await db.rider.findUnique({ where: { id: riderId }, select: { hubId: true, hub: { select: { type: true, name: true } } } });
  if (!rider) return;
  const scope = opsHubScope(actor);
  if (!scope) return;
  if (rider.hub?.type === "FRANCHISE" || (actor.kind === "user" && actor.roles.some(r => r.role === "FRANCHISE"))) {
    if (!rider.hubId || !scope.includes(rider.hubId))
      throw forbidden(rider.hub?.type === "FRANCHISE" ? `This rider works for ${rider.hub.name} (franchise) and can only be assigned there` : "You can only assign your own riders");
  }
}

/** Why a rider can't hand cash to this hub (franchise riders: their own franchise hub only; others: company hubs), or null. */
export function cashHubProblem(rider: { hubId: string | null; hub?: { type: string; name: string } | null }, hub: { id: string; type: string; name: string }): string | null {
  if (rider.hub?.type === "FRANCHISE") return rider.hubId === hub.id ? null : `Cash from ${rider.hub.name}'s riders is handed over at ${rider.hub.name}`;
  if (hub.type === "FRANCHISE") return `${hub.name} is a franchise hub: hand your cash to a Delivery Fast hub`;
  return null;
}
