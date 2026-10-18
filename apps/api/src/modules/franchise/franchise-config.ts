import { z } from "zod";
import type { Db } from "../../common/prisma.service";

/**
 * Franchise settlement rules (super admin; Setting "franchise.config"):
 *  - DEDUCT: a franchise keeps its unsettled commission when it deposits cash at a hub (net deposit);
 *  - BILL: deposits are gross; Finance bills the commission every `billingPeriodDays` and pays it.
 */
export const FRANCHISE_CONFIG_KEY = "franchise.config";

export const franchiseConfigSchema = z.object({
  settlementMode: z.enum(["DEDUCT", "BILL"], "Choose DEDUCT or BILL").default("DEDUCT"),
  billingPeriodDays: z.coerce.number().int().min(1, "At least 1 day").max(92, "At most 92 days").default(30),
});
export type FranchiseConfig = z.infer<typeof franchiseConfigSchema>;

export async function readFranchiseConfig(db: Db): Promise<FranchiseConfig> {
  const row = await db.setting.findUnique({ where: { key: FRANCHISE_CONFIG_KEY } });
  const parsed = franchiseConfigSchema.safeParse(row?.value ?? {});
  return parsed.success ? parsed.data : franchiseConfigSchema.parse({});
}
