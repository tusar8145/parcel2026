import { Global, HttpStatus, Injectable, Module } from "@nestjs/common";
import { Prisma, type LedgerAccountType } from "../../generated/prisma/client";
import { PrismaService, type Db } from "../../common/prisma.service";
import { nextNumber } from "../../common/counters";
import { AppError } from "../../common/errors";
import { readFinanceConfig, vatSplit } from "./finance-config";

/** Business money movements the ledger records as balanced journal entries. */
export type LedgerEventType =
  | "COD_COLLECTED" // rider took cash from a recipient
  | "COD_HANDED_OVER" // rider handed cash to a hub
  | "DELIVERY_CHARGE_EARNED" // a delivery charge became revenue
  | "MERCHANT_SETTLEMENT_PAID" // COD (minus charges) paid out to a merchant
  | "INVOICE_ISSUED"
  | "INVOICE_PAID"
  | "RIDER_PAYOUT_PAID"
  | "REFUND_PAID"
  | "CLAIM_PAID"
  | "ADJUSTMENT"
  | "CASH_DEPOSITED"; // hub cash banked (appended)

/** Where money left or arrived for payouts, refunds and claims. */
export type LedgerVia = "BANK" | "BKASH" | "CASH" | "MERCHANT_BALANCE";

export interface LedgerEvent {
  type: LedgerEventType;
  amount: number | Prisma.Decimal;
  /** Business reference: tracking ID, settlement/invoice number, payout id… */
  reference: string;
  merchantId?: string | null;
  riderId?: string | null;
  hubId?: string | null;
  occurredAt?: Date;
  memo?: string;
  // ── optional extensions ──
  /** Payment channel (RIDER_PAYOUT_PAID, REFUND_PAID, CLAIM_PAID, INVOICE_PAID, MERCHANT_SETTLEMENT_PAID, CASH_DEPOSITED). Default BANK. */
  via?: LedgerVia;
  /** VAT contained in `amount` for revenue events; default: from the finance VAT settings. */
  vat?: number | Prisma.Decimal;
  /** Overrides the default de-duplication key (`type:reference`); null posts without one. */
  idempotencyKey?: string | null;
  createdById?: string | null;
}

/** System chart of accounts. Codes follow the usual 1xxx asset … 5xxx expense layout. */
export const SYSTEM_ACCOUNTS = [
  { systemKey: "CASH_WITH_RIDERS", code: "1010", name: "Cash with riders", type: "ASSET" },
  { systemKey: "CASH_AT_HUBS", code: "1020", name: "Cash at hubs", type: "ASSET" },
  { systemKey: "BANK", code: "1030", name: "Bank", type: "ASSET" },
  { systemKey: "BKASH", code: "1040", name: "bKash merchant wallet", type: "ASSET" },
  { systemKey: "MERCHANT_RECEIVABLES", code: "1100", name: "Merchant receivables", type: "ASSET" },
  { systemKey: "MERCHANT_PAYABLES", code: "2010", name: "Merchant payables (COD)", type: "LIABILITY" },
  { systemKey: "RIDER_PAYROLL_PAYABLE", code: "2020", name: "Rider payroll payable", type: "LIABILITY" },
  { systemKey: "VAT_PAYABLE", code: "2030", name: "VAT payable (output tax)", type: "LIABILITY" },
  { systemKey: "CUSTOMER_REFUNDS_PAYABLE", code: "2040", name: "Refunds and claims payable", type: "LIABILITY" },
  { systemKey: "OWNER_EQUITY", code: "3010", name: "Owner's equity", type: "EQUITY" },
  { systemKey: "DELIVERY_REVENUE", code: "4010", name: "Delivery revenue", type: "REVENUE" },
  { systemKey: "COD_FEE_REVENUE", code: "4020", name: "COD fee revenue", type: "REVENUE" },
  { systemKey: "RIDER_PAYROLL_EXPENSE", code: "5010", name: "Rider payroll expense", type: "EXPENSE" },
  { systemKey: "REFUNDS_EXPENSE", code: "5020", name: "Refunds", type: "EXPENSE" },
  { systemKey: "CLAIMS_EXPENSE", code: "5030", name: "Claims (lost / damaged parcels)", type: "EXPENSE" },
] as const satisfies readonly { systemKey: string; code: string; name: string; type: LedgerAccountType }[];

export type AccountKey = (typeof SYSTEM_ACCOUNTS)[number]["systemKey"];

/** Debit-normal account types: balance = debits − credits; the rest credits − debits. */
export const DEBIT_NORMAL = new Set<LedgerAccountType>(["ASSET", "EXPENSE"]);

export interface PostingLine {
  account: AccountKey | null;
  /** For accounts finance added by hand (no system key). */
  accountId?: string;
  /** Positive = debit, negative = credit (use debit()/credit() helpers for readability). */
  amount: Prisma.Decimal;
  merchantId?: string | null;
  riderId?: string | null;
  hubId?: string | null;
  memo?: string;
}

export interface Posting {
  eventType: LedgerEventType | string;
  reference: string;
  memo?: string;
  occurredAt?: Date;
  merchantId?: string | null;
  riderId?: string | null;
  hubId?: string | null;
  idempotencyKey?: string | null;
  createdById?: string | null;
  lines: PostingLine[];
}

const D = (v: string | number | Prisma.Decimal) => new Prisma.Decimal(v);
export const debit = (account: AccountKey, amount: string | number | Prisma.Decimal, dims: Omit<PostingLine, "account" | "amount"> = {}): PostingLine => ({ account, amount: D(amount), ...dims });
export const credit = (account: AccountKey, amount: string | number | Prisma.Decimal, dims: Omit<PostingLine, "account" | "amount"> = {}): PostingLine => ({ account, amount: D(amount).negated(), ...dims });

const VIA_ACCOUNT: Record<Exclude<LedgerVia, "MERCHANT_BALANCE">, AccountKey> = { BANK: "BANK", BKASH: "BKASH", CASH: "CASH_AT_HUBS" };

/** Accounting period "YYYY-MM" in Bangladesh time. */
export function dhakaPeriod(at: Date): string {
  return new Date(at.getTime() + 6 * 3600_000).toISOString().slice(0, 7);
}

/** [start, end) of a "YYYY-MM" period in Bangladesh time. */
export function periodRange(period: string): { start: Date; end: Date } {
  const [y, m] = period.split("-").map(Number);
  return { start: new Date(Date.UTC(y, m - 1, 1) - 6 * 3600_000), end: new Date(Date.UTC(y, m, 1) - 6 * 3600_000) };
}

export function nextPeriod(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/** Guess the money channel from free text like "bKash 01XXXXXXXXX" or "Cash". */
export function viaFromText(text?: string | null): LedgerVia {
  const method = (text ?? "").trim().split(/\s+/)[0]?.toUpperCase() ?? "";
  if (method === "BKASH") return "BKASH";
  if (method === "CASH") return "CASH";
  return "BANK";
}

/**
 * Double-entry ledger. Call record() (contract events) or post() (explicit lines) inside the
 * transaction that moves the money. Entries are immutable and balanced; a repeated event with
 * the same idempotency key (default `type:reference`) is recorded once. Postings dated in a
 * closed period land in the next open period (the occurredAt date is kept).
 */
@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  async record(db: Db, event: LedgerEvent): Promise<void> {
    const amount = D(event.amount);
    if (amount.isZero()) return;
    const dims = { merchantId: event.merchantId ?? null, riderId: event.riderId ?? null, hubId: event.hubId ?? null };
    const m = { merchantId: dims.merchantId };
    // Rider payouts pass "<method> <reference>" as memo (BANK_TRANSFER, BKASH, NAGAD, ROCKET, CASH); wallets other than bKash book to Bank.
    const via = event.via ?? (event.type === "RIDER_PAYOUT_PAID" || event.type === "REFUND_PAID" || event.type === "CLAIM_PAID" ? viaFromText(event.memo) : "BANK");
    const cash = (v: LedgerVia): AccountKey => (v === "MERCHANT_BALANCE" ? "MERCHANT_PAYABLES" : VIA_ACCOUNT[v]);
    const cashDims = (v: LedgerVia) => (v === "CASH" ? { hubId: dims.hubId } : v === "MERCHANT_BALANCE" ? m : {});
    const revenue = async (gross: Prisma.Decimal) => {
      const vat = event.vat !== undefined ? D(event.vat) : vatSplit(gross, (await readFinanceConfig(db)).vatRate).vat;
      return [credit("DELIVERY_REVENUE", gross.minus(vat)), credit("VAT_PAYABLE", vat)];
    };

    let lines: PostingLine[];
    switch (event.type) {
      case "COD_COLLECTED":
        lines = [debit("CASH_WITH_RIDERS", amount, { riderId: dims.riderId }), credit("MERCHANT_PAYABLES", amount, m)];
        break;
      case "COD_HANDED_OVER":
        lines = [debit("CASH_AT_HUBS", amount, { hubId: dims.hubId }), credit("CASH_WITH_RIDERS", amount, { riderId: dims.riderId })];
        break;
      case "CASH_DEPOSITED":
        lines = [debit(VIA_ACCOUNT[via === "MERCHANT_BALANCE" || via === "CASH" ? "BANK" : via], amount), credit("CASH_AT_HUBS", amount, { hubId: dims.hubId })];
        break;
      case "DELIVERY_CHARGE_EARNED":
      case "INVOICE_ISSUED":
        lines = [debit("MERCHANT_RECEIVABLES", amount, m), ...(await revenue(amount))];
        break;
      case "INVOICE_PAID":
        lines = [debit(cash(via), amount, cashDims(via)), credit("MERCHANT_RECEIVABLES", amount, m)];
        break;
      case "MERCHANT_SETTLEMENT_PAID":
        lines = [debit("MERCHANT_PAYABLES", amount, m), credit(cash(via), amount, cashDims(via))];
        break;
      case "RIDER_PAYOUT_PAID":
        lines = [debit("RIDER_PAYROLL_EXPENSE", amount, { riderId: dims.riderId }), credit(cash(via === "MERCHANT_BALANCE" ? "BANK" : via), amount, cashDims(via))];
        break;
      case "REFUND_PAID":
        lines = [debit("REFUNDS_EXPENSE", amount, m), credit(cash(via), amount, cashDims(via))];
        break;
      case "CLAIM_PAID":
        lines = [debit("CLAIMS_EXPENSE", amount, m), credit(cash(via), amount, cashDims(via))];
        break;
      case "ADJUSTMENT":
        // Positive: the merchant owes us more (e.g. re-priced weight); negative: we owe them.
        lines = amount.gt(0)
          ? [debit("MERCHANT_RECEIVABLES", amount, m), ...(await revenue(amount))]
          : [...(await revenue(amount.negated())).map(l => ({ ...l, amount: l.amount.negated() })), credit("MERCHANT_PAYABLES", amount.negated(), m)];
        break;
      default:
        throw new Error(`Unknown ledger event ${String(event.type)}`);
    }
    await this.post(db, {
      eventType: event.type,
      reference: event.reference,
      memo: event.memo,
      occurredAt: event.occurredAt,
      ...dims,
      idempotencyKey: event.idempotencyKey === undefined ? `${event.type}:${event.reference}` : event.idempotencyKey,
      createdById: event.createdById,
      lines,
    });
  }

  /** Writes one balanced entry from explicit lines. Returns null when the idempotency key was already posted. */
  async post(db: Db, posting: Posting) {
    const lines = posting.lines
      .map(l => ({ ...l, amount: l.amount.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP) }))
      .filter(l => !l.amount.isZero());
    if (!lines.length) return null;
    const debits = lines.filter(l => l.amount.gt(0)).reduce((a, l) => a.plus(l.amount), D(0));
    const credits = lines.filter(l => l.amount.lt(0)).reduce((a, l) => a.minus(l.amount), D(0));
    if (!debits.equals(credits))
      throw new AppError("LEDGER_UNBALANCED", `Journal entry ${posting.reference} doesn't balance (debits ${debits.toFixed(2)}, credits ${credits.toFixed(2)})`, HttpStatus.UNPROCESSABLE_ENTITY);

    if (posting.idempotencyKey) {
      const existing = await db.journalEntry.findUnique({ where: { idempotencyKey: posting.idempotencyKey }, select: { id: true } });
      if (existing) return null;
    }
    // Shared lock: a period close (exclusive) waits for in-flight postings and vice versa.
    await db.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext('ledger-period-close'))`;
    const accounts = await this.accountIds(db);
    const occurredAt = posting.occurredAt ?? new Date();
    const entry = await db.journalEntry.create({
      data: {
        number: await nextNumber(db, "JE", "month"),
        eventType: posting.eventType,
        reference: posting.reference,
        idempotencyKey: posting.idempotencyKey ?? null,
        memo: posting.memo,
        occurredAt,
        period: await this.openPeriodFor(db, occurredAt),
        merchantId: posting.merchantId ?? null,
        riderId: posting.riderId ?? null,
        hubId: posting.hubId ?? null,
        createdById: posting.createdById ?? null,
        lines: {
          create: lines.map(l => ({
            accountId: l.accountId ?? accounts.get(l.account!)!,
            debit: l.amount.gt(0) ? l.amount : D(0),
            credit: l.amount.lt(0) ? l.amount.negated() : D(0),
            merchantId: l.merchantId ?? null,
            riderId: l.riderId ?? null,
            hubId: l.hubId ?? null,
            memo: l.memo,
          })),
        },
      },
    });
    return entry;
  }

  /** System account ids by key; creates the chart of accounts on first use. */
  async accountIds(db: Db = this.prisma): Promise<Map<string, string>> {
    let rows = await db.ledgerAccount.findMany({ where: { systemKey: { not: null } }, select: { id: true, systemKey: true } });
    if (rows.length < SYSTEM_ACCOUNTS.length) {
      await db.ledgerAccount.createMany({ data: SYSTEM_ACCOUNTS.map(a => ({ ...a })), skipDuplicates: true });
      rows = await db.ledgerAccount.findMany({ where: { systemKey: { not: null } }, select: { id: true, systemKey: true } });
      const missing = SYSTEM_ACCOUNTS.filter(a => !rows.some(r => r.systemKey === a.systemKey));
      if (missing.length) throw new AppError("LEDGER_ACCOUNT_CONFLICT", `Account codes ${missing.map(a => a.code).join(", ")} are taken by manual accounts`, HttpStatus.CONFLICT);
    }
    return new Map(rows.map(r => [r.systemKey!, r.id]));
  }

  /** The entry's period, or the first open period after it when that month is closed. */
  private async openPeriodFor(db: Db, at: Date) {
    let period = dhakaPeriod(at);
    const closed = new Set((await db.ledgerPeriod.findMany({ where: { period: { gte: period } }, select: { period: true } })).map(p => p.period));
    while (closed.has(period)) period = nextPeriod(period);
    return period;
  }
}

@Global()
@Module({ providers: [LedgerService], exports: [LedgerService] })
export class LedgerModule {}
