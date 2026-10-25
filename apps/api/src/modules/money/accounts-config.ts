import { z } from "zod";
import type { Db } from "../../common/prisma.service";

/** Accounts settings (super admin): which hub is the central hub. Stored in `settings` under ACCOUNTS_CONFIG_KEY. */
export const ACCOUNTS_CONFIG_KEY = "accounts.config";

export const accountsConfigSchema = z.object({
  /** Cash is settled only once it reaches the central hub; its own riders' slips land there directly. */
  centralHubId: z.uuid().nullable().default(null),
});
export type AccountsConfig = z.infer<typeof accountsConfigSchema>;

export const updateAccountsConfigSchema = z.object({ centralHubId: z.uuid("Choose the central hub").nullable() });

export async function readAccountsConfig(db: Db): Promise<AccountsConfig> {
  const row = await db.setting.findUnique({ where: { key: ACCOUNTS_CONFIG_KEY } });
  const parsed = accountsConfigSchema.safeParse(row?.value ?? {});
  return parsed.success ? parsed.data : accountsConfigSchema.parse({});
}

/** The central hub's id, or null while none is chosen. */
export const centralHubId = async (db: Db) => (await readAccountsConfig(db)).centralHubId;
