import { z } from "zod";
import { Prisma } from "../../generated/prisma/client";
import type { Db } from "../../common/prisma.service";

/**
 * Finance settings (super admin / finance): VAT per Bangladesh NBR norms and the seller identity
 * printed on Mushak-6.3-style invoices. Stored in `settings` under FINANCE_CONFIG_KEY.
 */
export const FINANCE_CONFIG_KEY = "finance.config";

const BIN = /^\d{9}(-\d{4})?$/;

export const financeConfigSchema = z.object({
  /**
   * VAT on or off (default off): off, delivery charges already include everything; no VAT is split out, posted
   * or printed anywhere (bills, statements, shipment PDFs, the ledger). On, `vatRate` applies from then on.
   */
  vatEnabled: z.boolean().default(false),
  /** Standard VAT rate in percent (NBR standard rate for courier services: 15), used while VAT is on. */
  vatRate: z.number().min(0, "VAT rate can't be negative").max(50, "VAT rate looks too high").multipleOf(0.01).default(15),
  seller: z
    .object({
      name: z.string().trim().min(2).max(160).default("Delivery Fast Ltd."),
      /** 13-digit e-BIN (9 digits + 4-digit branch suffix accepted, e.g. 000123456-0101). */
      bin: z
        .string()
        .trim()
        .refine(v => v === "" || BIN.test(v) || /^\d{13}$/.test(v), "BIN must be 13 digits (or 9 digits-4 digits)")
        .default(""),
      address: z.string().trim().max(300).default(""),
    })
    .default({ name: "Delivery Fast Ltd.", bin: "", address: "" }),
  /** Days after issue an invoice is due. */
  invoiceTermDays: z.number().int().min(0).max(120).default(15),
});

export type FinanceConfig = z.infer<typeof financeConfigSchema>;
/** Partial update; no defaults here, so fields left out keep their current values. */
export const updateFinanceConfigSchema = z.object({
  vatEnabled: z.boolean().optional(),
  vatRate: z.number().min(0, "VAT rate can't be negative").max(50, "VAT rate looks too high").multipleOf(0.01).optional(),
  seller: z
    .object({
      name: z.string().trim().min(2).max(160).optional(),
      bin: z
        .string()
        .trim()
        .refine(v => v === "" || BIN.test(v) || /^\d{13}$/.test(v), "BIN must be 13 digits (or 9 digits-4 digits)")
        .optional(),
      address: z.string().trim().max(300).optional(),
    })
    .optional(),
  invoiceTermDays: z.number().int().min(0).max(120).optional(),
});

/** The settings as saved (the settings form): the VAT rate is kept while VAT is off. */
export async function readStoredFinanceConfig(db: Db): Promise<FinanceConfig> {
  const row = await db.setting.findUnique({ where: { key: FINANCE_CONFIG_KEY } });
  const parsed = financeConfigSchema.safeParse(row?.value ?? {});
  return parsed.success ? parsed.data : financeConfigSchema.parse({});
}

/** The settings in effect: with VAT off the rate is 0, so nothing splits out, posts or prints VAT. */
export async function readFinanceConfig(db: Db): Promise<FinanceConfig> {
  const cfg = await readStoredFinanceConfig(db);
  return cfg.vatEnabled ? cfg : { ...cfg, vatRate: 0 };
}

const D = (v: string | number | Prisma.Decimal) => new Prisma.Decimal(v);

/**
 * Rate-card prices are VAT-inclusive (what the merchant or customer pays). Splits a charge into
 * taxable value and the VAT it contains: VAT = amount × rate / (100 + rate), rounded to paisa.
 */
export function vatSplit(amount: string | number | Prisma.Decimal, vatRate: number | Prisma.Decimal) {
  const a = D(amount);
  const rate = D(vatRate);
  if (rate.isZero()) return { taxable: a, vat: D(0) };
  const vat = a.times(rate).dividedBy(rate.plus(100)).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  return { taxable: a.minus(vat), vat };
}
