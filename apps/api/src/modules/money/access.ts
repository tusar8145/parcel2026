import type { Actor, UserActor } from "../../common/auth/actor";
import { forbidden } from "../../common/errors";
import type { Db } from "../../common/prisma.service";
import { cashHubScope, isFinanceStaff, ownedMerchantIds } from "../finance/finance.scope";
import { centralHubId } from "./accounts-config";

/**
 * Who works money in Courier Operations › Accounts:
 * - hub staff (cod:receive): their hubs' rider slips, cash on hand and transfers to the central hub;
 * - money staff: finance, operations managers, super admins (finance:manage) and the central hub's staff:
 *   every account, settlements, bills, payments, adjustments and receiving transfers.
 */
export async function isMoneyStaff(db: Db, actor: Actor): Promise<boolean> {
  if (actor.kind !== "user") return false;
  if (actor.permissions.has("finance:manage") && isFinanceStaff(actor)) return true;
  if (!actor.permissions.has("cod:receive")) return false;
  const central = await centralHubId(db);
  const scope = cashHubScope(actor);
  return !!central && (scope === null || scope.includes(central));
}

export async function assertMoneyStaff(db: Db, actor: Actor) {
  if (!(await isMoneyStaff(db, actor))) throw forbidden("Only finance, operations managers and central hub staff can do this");
}

/** Hub staff who receive rider cash (any hub in their scope). */
export function assertCashStaff(actor: Actor) {
  if (actor.kind !== "user" || !actor.permissions.has("cod:receive")) throw forbidden("Only hub staff can handle rider cash");
}

/** The accounts a merchant owner or a customer may see (their own). */
export async function ownAccountIds(db: Db, actor: UserActor): Promise<string[]> {
  const merchants = ownedMerchantIds(actor);
  const ids: string[] = [];
  if (merchants.length) ids.push(...(await db.account.findMany({ where: { merchantId: { in: merchants } }, select: { id: true } })).map(a => a.id));
  if (actor.roles.some(r => r.role === "CUSTOMER")) {
    const user = await db.user.findUnique({ where: { id: actor.userId }, select: { phone: true } });
    const rows = await db.account.findMany({ where: { kind: "CUSTOMER", OR: [{ customerId: actor.userId }, ...(user?.phone ? [{ phone: user.phone }] : [])] }, select: { id: true } });
    ids.push(...rows.map(a => a.id));
  }
  return ids;
}
