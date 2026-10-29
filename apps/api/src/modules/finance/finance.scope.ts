import type { Actor } from "../../common/auth/actor";
import { forbidden } from "../../common/errors";
import { Prisma } from "../../generated/prisma/client";

const UNSCOPED_CASH_ROLES = new Set(["SUPER_ADMIN", "OPS_MANAGER", "FINANCE"]);

/**
 * Hubs where this actor may receive / view rider cash. null = every hub.
 * Only a hub operator with hub-scoped roles (and no wider cash role) is restricted.
 */
export function cashHubScope(actor: Actor): string[] | null {
  if (actor.kind !== "user") return [];
  if (actor.roles.some(r => UNSCOPED_CASH_ROLES.has(r.role))) return null;
  // A franchise account is always limited to its own (franchise) hub.
  const franchise = actor.roles.filter(r => r.role === "FRANCHISE");
  if (franchise.length) return franchise.flatMap(r => (r.hubId ? [r.hubId] : []));
  const hubRoles = actor.roles.filter(r => r.role === "HUB_OPERATOR");
  if (hubRoles.some(r => !r.hubId)) return null;
  return hubRoles.map(r => r.hubId!);
}

/** Hub filter for a list query, rejecting hubs outside the actor's scope. */
export function scopedHubIds(actor: Actor, requested?: string): string[] | undefined {
  const scope = cashHubScope(actor);
  if (scope === null) return requested ? [requested] : undefined;
  if (requested && !scope.includes(requested)) throw forbidden("You can only view cash at your own hub");
  return requested ? [requested] : scope;
}

/** Company finance staff, as opposed to merchant owners who also hold finance:read. */
/** Staff who work every merchant's money (Courier Operations › COD & settlement): finance, operations managers, super admins. */
export const isFinanceStaff = (actor: Actor) => actor.kind === "user" && actor.roles.some(r => r.role === "FINANCE" || r.role === "OPS_MANAGER" || r.role === "SUPER_ADMIN");
/** Invoice settings (VAT, seller identity, terms, delivery charge on invoices) are changed by super admins only (Super admin › Invoice settings). */
export const canChangeFinanceSettings = (actor: Actor) => actor.kind === "user" && actor.roles.some(r => r.role === "SUPER_ADMIN");

/** Merchants whose finances this (non-staff) actor may read: merchants they own. */
export const ownedMerchantIds = (actor: Actor) =>
  actor.kind === "user" ? actor.roles.filter(r => r.role === "MERCHANT_OWNER" && r.merchantId).map(r => r.merchantId!) : [];

/** undefined = no restriction (staff); otherwise the merchant ids the actor may see. */
export const financeMerchantScope = (actor: Actor): string[] | undefined => (isFinanceStaff(actor) ? undefined : ownedMerchantIds(actor));

export const ZERO = new Prisma.Decimal(0);
export const sum = (values: Prisma.Decimal[]) => values.reduce((a, b) => a.plus(b), ZERO);
/** Decimal → JSON number rounded to paisa. */
export const money = (d: Prisma.Decimal | null | undefined) => Number((d ?? ZERO).toFixed(2));

/** Start of the current month in Bangladesh time (UTC+6). */
export function dhakaMonthStart(now = new Date()): Date {
  const local = new Date(now.getTime() + 6 * 3600_000);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - 6 * 3600_000);
}
