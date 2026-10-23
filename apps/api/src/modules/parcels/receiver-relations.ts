import type { Db } from "../../common/prisma.service";

/** Who received a delivery, as related to the recipient: offered at delivery, Self first (the default). */
export const RECEIVER_RELATIONS = ["Self", "Father", "Mother", "Spouse", "Son", "Daughter", "Brother", "Sister", "Relative", "Neighbour", "Colleague", "Security guard", "Reception", "Other"] as const;

/**
 * The relations offered at delivery (rider app, Scan desk › Delivery entry, Collect from hub): the list
 * super admins keep in Platform settings › Operational catalogs (platform-config `receiverRelations`),
 * else the standard one. "Self" is always first.
 */
export async function receiverRelations(db: Pick<Db, "setting">): Promise<string[]> {
  const setting = await db.setting.findUnique({ where: { key: "platform-config" } });
  const saved = (setting?.value as { receiverRelations?: unknown } | null)?.receiverRelations;
  const list = Array.isArray(saved) ? saved.filter((r): r is string => typeof r === "string").map(r => r.trim()).filter(r => r.length >= 2 && r.length <= 60) : [];
  const chosen = list.length ? list : [...RECEIVER_RELATIONS];
  return ["Self", ...new Set(chosen.filter(r => r.toLowerCase() !== "self"))];
}
