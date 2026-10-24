import type { Db } from "../../common/prisma.service";
import type { InboxService } from "./inbox.service";
import type { Target } from "./in-app";

/**
 * New work from a merchant (an order, an Excel import, a pickup request) in Courier Operations' bell:
 * every operations manager, and the hub managers of the hub it concerns (the merchant's pickup hub or the
 * drop-off hub). Without a known hub only operations managers get it, so other hubs aren't flooded.
 */
export async function notifyNewWork(inbox: InboxService, db: Db, input: { hubId: string | null | undefined; type: string; title: string; body?: string; target: Target }) {
  const item = { type: input.type, title: input.title, body: input.body ?? null, target: input.target, panel: "/courier-operation" as const };
  if (input.hubId) return inbox.toStaff(db, { roles: ["OPS_MANAGER", "HUB_OPERATOR"], hubIds: [input.hubId] }, item);
  return inbox.toStaff(db, { roles: ["OPS_MANAGER"] }, item);
}
