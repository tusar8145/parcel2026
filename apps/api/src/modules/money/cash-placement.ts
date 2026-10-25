import type { Db } from "../../common/prisma.service";
import { centralHubId } from "./accounts-config";

/** Where cash received at a hub stands: at the central hub (ready to settle) or at another hub (to be sent on). */
export async function hubCashPlacement(db: Db, hubId: string, at = new Date()) {
  const central = (await centralHubId(db)) === hubId;
  return central ? { state: "AT_CENTRAL" as const, cashHubId: hubId, centralAt: at } : { state: "AT_HUB" as const, cashHubId: hubId };
}
