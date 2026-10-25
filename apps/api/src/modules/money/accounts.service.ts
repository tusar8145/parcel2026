import { HttpStatus, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { PrismaService, type Db } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { RealtimeService } from "../../common/realtime.service";
import { AppError, forbidden, notFound } from "../../common/errors";
import type { Actor, UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { Prisma, type Account, type AccountKind } from "../../generated/prisma/client";
import { money, sum, ZERO } from "../finance/finance.scope";
import type { accountParcelsQuerySchema, adjustmentSchema, dateRangeQuerySchema, listAccountsQuerySchema, payToSchema } from "./money.schemas";
import { assertMoneyStaff, isMoneyStaff, ownAccountIds } from "./access";
import { readAccountsConfig } from "./accounts-config";
import { postParcelEntries } from "./entries";

/** The first day of this month, Dhaka time. */
const monthStart = () => dhakaDay(`${new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 8)}01`);
/** A stored instant as its Dhaka date (YYYY-MM-DD). */
const dhakaDate = (d: Date) => new Date(d.getTime() + 6 * 3600_000).toISOString().slice(0, 10);

/** "2026-10-25" (Dhaka) → that day's start; `end` → the next day's start. */
export const dhakaDay = (day: string, end = false) => new Date(Date.parse(`${day}T00:00:00+06:00`) + (end ? 86_400_000 : 0));
const range = (q: { from?: string; to?: string }) =>
  q.from || q.to ? { ...(q.from ? { gte: dhakaDay(q.from) } : {}), ...(q.to ? { lt: dhakaDay(q.to, true) } : {}) } : undefined;

const STAGE_LABEL: Record<string, string> = {
  WITH_RIDER: "With rider",
  AT_HUB: "At hub",
  IN_TRANSIT: "In transit to central hub",
  AT_CENTRAL: "At central hub",
  SETTLED: "Settled",
};
const OPEN_TYPES = ["COD", "DELIVERY_CHARGE", "RETURN_CHARGE", "ADJUSTMENT"] as const;
const CHARGE_TYPES = ["DELIVERY_CHARGE", "RETURN_CHARGE"] as const;

type AccountRow = Account & { merchant?: { code: string } | null };

/**
 * Courier Operations › Accounts (read side and adjustments): the account lists with balances, an account's
 * summary, its parcels (money stage / bill status) and its statement. Settlements: PayoutsService; bills and
 * payments: BillsService; rider / hub cash: CashService.
 */
@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
  ) {}

  // ───────────── access ─────────────

  /** The account, if this actor may see it (money staff: any; merchant owners / customers: their own). */
  async readable(actor: Actor, id: string): Promise<AccountRow> {
    const found = await this.prisma.account.findUnique({ where: { id } }).catch(() => null);
    if (!found) throw notFound("Account");
    const account = (await this.withCodes([found]))[0];
    if (await isMoneyStaff(this.prisma, actor)) return account;
    if (actor.kind === "user" && (await ownAccountIds(this.prisma, actor)).includes(id)) return account;
    throw notFound("Account");
  }

  /** The signed-in merchant owner's / customer's accounts (a merchant: one). */
  async mine(actor: UserActor) {
    const ids = await ownAccountIds(this.prisma, actor);
    if (!ids.length) return [];
    const rows = await this.withCodes(await this.prisma.account.findMany({ where: { id: { in: ids } }, orderBy: { createdAt: "asc" } }));
    return Promise.all(rows.map(a => this.summary(a)));
  }

  /** Merchant accounts carry their merchant's code (MR-1032). */
  private async withCodes(rows: Account[]): Promise<AccountRow[]> {
    const ids = rows.flatMap(a => (a.merchantId ? [a.merchantId] : []));
    const codes = new Map((ids.length ? await this.prisma.merchant.findMany({ where: { id: { in: ids } }, select: { id: true, code: true } }) : []).map(m => [m.id, m.code]));
    return rows.map(a => ({ ...a, merchant: a.merchantId ? { code: codes.get(a.merchantId) ?? "" } : null }));
  }

  // ───────────── lists ─────────────

  /** Accounts of one kind with their balances, largest first (ready to pay / due). */
  async list(actor: Actor, query: z.infer<typeof listAccountsQuerySchema>) {
    await assertMoneyStaff(this.prisma, actor);
    const q = query.q ? `%${query.q.replace(/[%_\\]/g, m => `\\${m}`)}%` : null;
    const rows = await this.prisma.$queryRaw<
      { id: string; name: string; phone: string | null; merchant_id: string | null; code: string | null; balance: Prisma.Decimal; ready: Prisma.Decimal; not_billed: Prisma.Decimal; parcels: number; last: Date | null }[]
    >`
      SELECT a.id, a.name, a.phone, a."merchantId" AS merchant_id, m.code,
        COALESCE(SUM(e.amount), 0) AS balance,
        COALESCE(SUM(e.amount) FILTER (WHERE e."payoutId" IS NULL AND e.type IN ('COD','DELIVERY_CHARGE','RETURN_CHARGE','ADJUSTMENT')
          AND (e."parcelId" IS NULL OR c.id IS NULL OR c.state = 'AT_CENTRAL')), 0) AS ready,
        COALESCE(SUM(-e.amount) FILTER (WHERE e."billId" IS NULL AND e.type IN ('DELIVERY_CHARGE','RETURN_CHARGE')), 0) AS not_billed,
        COUNT(DISTINCT e."parcelId")::int AS parcels,
        MAX(e."createdAt") AS last
      FROM accounts a
      LEFT JOIN merchants m ON m.id = a."merchantId"
      LEFT JOIN account_entries e ON e."accountId" = a.id
      LEFT JOIN cod_collections c ON c."parcelId" = e."parcelId" AND e.type IN ('COD','DELIVERY_CHARGE')
      WHERE a.kind = ${query.kind}::"AccountKind"
        AND (${q}::text IS NULL OR a.name ILIKE ${q} OR m.code ILIKE ${q} OR a.phone ILIKE ${q})
      GROUP BY a.id, m.code
      ORDER BY a.name ASC
      LIMIT 2000`;
    const items = rows.map(r => {
      const balance = money(r.balance);
      return {
        id: r.id,
        name: r.name,
        code: r.code,
        phone: r.phone,
        merchantId: r.merchant_id,
        parcels: r.parcels,
        lastActivity: r.last,
        balance,
        // E-commerce / Customer: what can be paid out now; Financial: what the merchant owes.
        ready: query.kind === "FINANCIAL" ? 0 : money(r.ready),
        notBilled: query.kind === "FINANCIAL" ? money(r.not_billed) : 0,
        due: query.kind === "FINANCIAL" ? Math.max(0, -balance) : 0,
      };
    });
    items.sort((a, b) => (query.kind === "FINANCIAL" ? b.due - a.due : b.ready - a.ready) || a.name.localeCompare(b.name));
    return { items, totals: { ready: round(items.reduce((t, i) => t + Math.max(0, i.ready), 0)), due: round(items.reduce((t, i) => t + i.due, 0)), accounts: items.length } };
  }

  /** Accounts → overview cards: where the cash is, what's ready to pay, what financial merchants owe. */
  async overview(actor: Actor) {
    await assertMoneyStaff(this.prisma, actor);
    const [cash, payouts, pending, financial, config] = await Promise.all([
      this.prisma.codCollection.groupBy({ by: ["state"], where: { state: { not: "SETTLED" } }, _sum: { amount: true }, _count: { _all: true } }),
      this.prisma.payout.aggregate({ where: { status: "UNPAID" }, _sum: { amount: true }, _count: { _all: true } }),
      this.prisma.accountPayment.aggregate({ where: { status: "PENDING" }, _sum: { amount: true }, _count: { _all: true } }),
      this.prisma.$queryRaw<{ due: Prisma.Decimal }[]>`
        SELECT COALESCE(SUM(GREATEST(-b, 0)), 0) AS due FROM (
          SELECT SUM(e.amount) AS b FROM account_entries e JOIN accounts a ON a.id = e."accountId" WHERE a.kind = 'FINANCIAL' GROUP BY e."accountId") t`,
      readAccountsConfig(this.prisma),
    ]);
    const state = (s: string) => cash.find(g => g.state === s);
    const central = config.centralHubId ? await this.prisma.hub.findUnique({ where: { id: config.centralHubId }, select: { id: true, name: true, code: true } }) : null;
    return {
      centralHub: central,
      cash: Object.fromEntries(["WITH_RIDER", "AT_HUB", "IN_TRANSIT", "AT_CENTRAL"].map(s => [s, { amount: money(state(s)?._sum.amount), count: state(s)?._count._all ?? 0 }])),
      unpaidPayouts: { amount: money(payouts._sum.amount), count: payouts._count._all },
      pendingPayments: { amount: money(pending._sum.amount), count: pending._count._all },
      financialDue: money(financial[0]?.due),
    };
  }

  // ───────────── one account ─────────────

  async detail(actor: Actor, id: string) {
    return this.summary(await this.readable(actor, id));
  }

  /** The cards at the top of an account (Courier Operations and the merchant's / customer's Balance page). */
  async summary(a: AccountRow) {
    const base = {
      id: a.id,
      kind: a.kind,
      name: a.name,
      code: a.merchant?.code ?? null,
      phone: a.phone,
      merchantId: a.merchantId,
      payTo: await this.payToOf(a),
    };
    const entries = await this.prisma.accountEntry.groupBy({ by: ["type"], where: { accountId: a.id }, _sum: { amount: true } });
    const of = (t: string) => entries.find(e => e.type === t)?._sum.amount ?? ZERO;
    const balance = sum(entries.map(e => e._sum.amount ?? ZERO));
    if (a.kind === "FINANCIAL") {
      const [notBilled, openAdjustments, bills, payments, allocated, pending, unpaidBills, lastPayment, paidThisMonth] = await Promise.all([
        this.prisma.accountEntry.aggregate({ where: { accountId: a.id, billId: null, type: { in: [...CHARGE_TYPES] } }, _sum: { amount: true } }),
        this.prisma.accountEntry.aggregate({ where: { accountId: a.id, billId: null, type: "ADJUSTMENT" }, _sum: { amount: true } }),
        this.prisma.bill.aggregate({ where: { accountId: a.id, status: { not: "VOID" } }, _sum: { total: true, paid: true } }),
        this.prisma.accountPayment.aggregate({ where: { accountId: a.id, status: "CONFIRMED" }, _sum: { amount: true } }),
        this.prisma.billAllocation.aggregate({ where: { payment: { accountId: a.id, status: "CONFIRMED" }, bill: { status: { not: "VOID" } } }, _sum: { amount: true } }),
        this.prisma.accountPayment.aggregate({ where: { accountId: a.id, status: "PENDING" }, _sum: { amount: true }, _count: { _all: true } }),
        this.prisma.bill.aggregate({ where: { accountId: a.id, status: { in: ["ISSUED", "PARTLY_PAID"] } }, _sum: { total: true, paid: true }, _count: { _all: true } }),
        this.prisma.accountPayment.findFirst({ where: { accountId: a.id, status: "CONFIRMED" }, orderBy: [{ paidOn: "desc" }, { createdAt: "desc" }] }),
        this.prisma.accountPayment.aggregate({ where: { accountId: a.id, status: "CONFIRMED", paidOn: { gte: monthStart() } }, _sum: { amount: true } }),
      ]);
      const billed = bills._sum.total ?? ZERO;
      const billedPaid = bills._sum.paid ?? ZERO;
      return {
        ...base,
        financial: {
          /** Delivery / return charges not on a bill yet. */
          notBilled: money((notBilled._sum.amount ?? ZERO).negated()),
          /** Adjustments not on a bill yet: + = credit to the merchant (lowers what's due), − = extra charge. They go on the next bill. */
          openAdjustments: money(openAdjustments._sum.amount),
          billed: money(billed),
          billedDue: money(billed.minus(billedPaid)),
          paid: money(payments._sum.amount),
          credit: money((payments._sum.amount ?? ZERO).minus(allocated._sum.amount ?? ZERO)),
          due: money(Prisma.Decimal.max(balance.negated(), ZERO)),
          charges: money(of("DELIVERY_CHARGE").plus(of("RETURN_CHARGE")).negated()),
          adjustments: money(of("ADJUSTMENT")),
          pending: { amount: money(pending._sum.amount), count: pending._count._all },
          /** Open bills only (paid ones are history). */
          unpaidBills: { count: unpaidBills._count._all, amount: money((unpaidBills._sum.total ?? ZERO).minus(unpaidBills._sum.paid ?? ZERO)) },
          lastPayment: lastPayment
            ? { number: lastPayment.number, amount: money(lastPayment.amount), method: lastPayment.method, paidOn: dhakaDate(lastPayment.paidOn) }
            : null,
          paidThisMonth: money(paidThisMonth._sum.amount),
        },
      };
    }
    const [stages, ready, payouts, lastPayout, paidThisMonth] = await Promise.all([
      this.prisma.$queryRaw<{ state: string; amount: Prisma.Decimal }[]>`
        SELECT c.state, COALESCE(SUM(e.amount), 0) AS amount FROM account_entries e
        JOIN cod_collections c ON c."parcelId" = e."parcelId"
        WHERE e."accountId" = ${a.id}::uuid AND e.type = 'COD' GROUP BY c.state`,
      this.readyTotal(this.prisma, a.id),
      this.prisma.payout.groupBy({ by: ["status"], where: { accountId: a.id }, _sum: { amount: true }, _count: { _all: true } }),
      this.prisma.payout.findFirst({ where: { accountId: a.id, status: "PAID" }, orderBy: { paidAt: "desc" } }),
      this.prisma.payout.aggregate({ where: { accountId: a.id, status: "PAID", paidAt: { gte: monthStart() } }, _sum: { amount: true } }),
    ]);
    const stage = (s: string) => money(stages.find(x => x.state === s)?.amount);
    const payout = (s: string) => payouts.find(p => p.status === s);
    return {
      ...base,
      cod: {
        collected: money(of("COD")),
        withRider: stage("WITH_RIDER"),
        atHubs: round(stage("AT_HUB") + stage("IN_TRANSIT")),
        atCentral: stage("AT_CENTRAL"),
        settledCod: stage("SETTLED"),
        charges: money(of("DELIVERY_CHARGE").plus(of("RETURN_CHARGE")).negated()),
        adjustments: money(of("ADJUSTMENT")),
        ready: money(ready),
        inSettlement: money(payout("UNPAID")?._sum.amount),
        settled: money(payout("PAID")?._sum.amount),
        /** Settlements to pay (created, not paid yet). */
        unpaidSettlements: payout("UNPAID")?._count._all ?? 0,
        /** The last settlement paid (older ones are history), and what was paid this month. */
        lastPayout: lastPayout ? { number: lastPayout.number, amount: money(lastPayout.amount), method: lastPayout.method, paidAt: lastPayout.paidAt } : null,
        paidThisMonth: money(paidThisMonth._sum.amount),
        // Everything still owed (cash anywhere in the network, less charges): ready + on its way.
        balance: money(balance),
      },
    };
  }

  /** E-commerce / Customer: the net of the open lines that can be paid now (parcels' cash at the central hub, or no cash). */
  async readyTotal(db: Db, accountId: string) {
    const [row] = await db.$queryRaw<{ ready: Prisma.Decimal }[]>`
      SELECT COALESCE(SUM(e.amount), 0) AS ready FROM account_entries e
      LEFT JOIN cod_collections c ON c."parcelId" = e."parcelId" AND e.type IN ('COD','DELIVERY_CHARGE')
      WHERE e."accountId" = ${accountId}::uuid AND e."payoutId" IS NULL AND e.type IN ('COD','DELIVERY_CHARGE','RETURN_CHARGE','ADJUSTMENT')
        AND (e."parcelId" IS NULL OR c.id IS NULL OR c.state = 'AT_CENTRAL')`;
    return row?.ready ?? ZERO;
  }

  /** Where payouts go: the merchant's payout account (Settings), a customer's own choice, else the sender's phone by bKash. */
  async payToOf(a: Account): Promise<Record<string, unknown> | null> {
    if (a.kind === "FINANCIAL") return null;
    if (a.merchantId) {
      const m = await this.prisma.merchant.findUnique({ where: { id: a.merchantId }, select: { payoutAccount: true } });
      return (m?.payoutAccount as Record<string, unknown> | null) ?? null;
    }
    return (a.payTo as Record<string, unknown> | null) ?? (a.phone ? { method: "BKASH", accountName: a.name, accountNumber: a.phone.replace(/^\+880/, "0") } : null);
  }

  /** A customer sets where their COD payouts go. */
  async setPayTo(actor: UserActor, id: string, input: z.infer<typeof payToSchema>, meta: RequestMeta) {
    const a = await this.readable(actor, id);
    if (a.kind !== "CUSTOMER") throw new AppError("NOT_A_CUSTOMER_ACCOUNT", "Merchants set their payout account in Settings", HttpStatus.UNPROCESSABLE_ENTITY);
    await this.prisma.$transaction(async tx => {
      await tx.account.update({ where: { id }, data: { payTo: input } });
      await this.audit.record(actor, { action: "account.pay_to", entityType: "account", entityId: id, data: { method: input.method } }, meta, tx);
    });
    return this.detail(actor, id);
  }

  /**
   * The account's parcels with their money: COD, charges and net; E-commerce / Customer: where the cash is and
   * the settlement; Financial: the bill and its status. Newest first; at most 2000 parcels (narrow the dates).
   */
  async parcels(actor: Actor, id: string, query: z.infer<typeof accountParcelsQuerySchema>) {
    const a = await this.readable(actor, id);
    const q = query.q?.toUpperCase();
    const lines = await this.prisma.accountEntry.findMany({
      where: { accountId: id, parcelId: { not: null }, createdAt: range(query), ...(q ? { trackingId: { contains: q } } : {}) },
      include: { payout: { select: { id: true, number: true, status: true } }, bill: { select: { id: true, number: true, status: true } } },
      orderBy: { createdAt: "desc" },
      take: 6000,
    });
    const parcelIds = [...new Set(lines.map(l => l.parcelId!))];
    const [parcels, cash] = await Promise.all([
      this.prisma.parcel.findMany({
        where: { id: { in: parcelIds } },
        select: { id: true, trackingId: true, status: true, merchantOrderRef: true, recipientName: true, deliveryZone: true, deliveryDistrict: true, deliveredAt: true, updatedAt: true, partialDelivery: true },
      }),
      this.prisma.codCollection.findMany({ where: { parcelId: { in: parcelIds } }, select: { parcelId: true, state: true, cashHubId: true } }),
    ]);
    const hubIds = [...new Set(cash.map(c => c.cashHubId).filter((h): h is string => !!h))];
    const hubs = new Map((await this.prisma.hub.findMany({ where: { id: { in: hubIds } }, select: { id: true, name: true } })).map(h => [h.id, h.name]));
    const parcelById = new Map(parcels.map(p => [p.id, p]));
    const cashById = new Map(cash.map(c => [c.parcelId, c]));
    const rows = parcelIds.flatMap(pid => {
      const p = parcelById.get(pid);
      if (!p) return [];
      const own = lines.filter(l => l.parcelId === pid);
      const amount = (t: string) => money(sum(own.filter(l => l.type === t).map(l => l.amount)));
      const c = cashById.get(pid);
      const cod = amount("COD");
      const charge = -amount("DELIVERY_CHARGE");
      const returnCharge = -amount("RETURN_CHARGE");
      const payout = own.find(l => l.payout)?.payout ?? null;
      const bill = own.find(l => l.bill && l.bill.status !== "VOID")?.bill ?? null;
      const ready = !payout && (!c || c.state === "AT_CENTRAL");
      const row = {
        parcelId: pid,
        trackingId: p.trackingId,
        orderRef: p.merchantOrderRef,
        recipient: p.recipientName,
        destination: [p.deliveryZone, p.deliveryDistrict].filter(Boolean).join(", "),
        outcome: p.status === "RETURNED" ? "Returned" : p.partialDelivery ? "Partly delivered" : "Delivered",
        date: own[own.length - 1]?.createdAt ?? p.deliveredAt ?? p.updatedAt,
        cod,
        charge,
        returnCharge,
        net: round(cod - charge - returnCharge),
        cash: c ? { state: c.state, label: c.state === "AT_HUB" && c.cashHubId ? `At ${hubs.get(c.cashHubId) ?? "hub"}` : STAGE_LABEL[c.state] } : null,
        ready: a.kind !== "FINANCIAL" && ready,
        payout: payout && payout.status !== "CANCELLED" ? payout : null,
        bill,
        billState: !bill ? "not_billed" : bill.status === "PAID" ? "paid" : bill.status === "PARTLY_PAID" ? "partly_paid" : "billed",
      };
      return [row];
    });
    const filtered = rows.filter(r => {
      switch (query.status) {
        case "open":
          return !r.payout || r.payout.status !== "PAID";
        case "ready":
          return r.ready;
        case "settled":
          return r.payout?.status === "PAID";
        case "not_billed":
          return r.billState === "not_billed";
        case "billed":
          return r.billState === "billed" || r.billState === "partly_paid";
        case "paid":
          return r.billState === "paid";
        default:
          return true;
      }
    });
    return { account: { id: a.id, kind: a.kind, name: a.name }, items: filtered.slice(0, 2000), truncated: filtered.length > 2000 };
  }

  /** The statement: opening balance, every line in the dates with the running balance, closing balance. */
  async statement(actor: Actor, id: string, query: z.infer<typeof dateRangeQuerySchema>) {
    const a = await this.readable(actor, id);
    const from = query.from ? dhakaDay(query.from) : undefined;
    const to = query.to ? dhakaDay(query.to, true) : undefined;
    const [opening, lines] = await Promise.all([
      from ? this.prisma.accountEntry.aggregate({ where: { accountId: id, createdAt: { lt: from } }, _sum: { amount: true } }) : null,
      this.prisma.accountEntry.findMany({
        where: { accountId: id, createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 20000,
      }),
    ]);
    let running = opening?._sum.amount ?? ZERO;
    const openingBalance = money(running);
    const rows = lines.map(l => {
      running = running.plus(l.amount);
      return { id: l.id, date: l.createdAt, type: l.type, trackingId: l.trackingId, description: l.description, reference: l.reference, amount: money(l.amount), balance: money(running) };
    });
    return { account: (await this.summary(a)) as Awaited<ReturnType<AccountsService["summary"]>>, from: query.from ?? null, to: query.to ?? null, opening: openingBalance, closing: money(running), lines: rows };
  }

  /** A + / − correction with a reason; it goes into the next settlement or bill. */
  async adjust(actor: UserActor, id: string, input: z.infer<typeof adjustmentSchema>, meta: RequestMeta) {
    await assertMoneyStaff(this.prisma, actor);
    const a = await this.readable(actor, id);
    if (input.trackingId) {
      const parcel = await this.prisma.parcel.findUnique({ where: { trackingId: input.trackingId }, select: { merchantId: true, senderPhone: true } });
      if (!parcel || (a.merchantId ? parcel.merchantId !== a.merchantId : parcel.senderPhone !== a.phone))
        throw new AppError("PARCEL_NOT_ON_ACCOUNT", `${input.trackingId} isn't a parcel of ${a.name}`, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const entry = await this.prisma.$transaction(async tx => {
      const e = await tx.accountEntry.create({
        data: { accountId: id, type: "ADJUSTMENT", amount: new Prisma.Decimal(input.amount), description: input.reason, trackingId: input.trackingId ?? null, createdById: actor.userId },
      });
      await this.audit.record(actor, { action: "account.adjust", entityType: "account", entityId: id, data: { amount: input.amount, reason: input.reason, trackingId: input.trackingId ?? null } }, meta, tx);
      return e;
    });
    this.published(a);
    return { id: entry.id, amount: money(entry.amount), description: entry.description, account: await this.detail(actor, id) };
  }

  /**
   * Switching to Accounts (super admin, once; safe to repeat): delivered / returned parcels without lines get them,
   * except parcels already settled or invoiced the old way (their history stays in the old records); COD already
   * received at a hub becomes that hub's cash (at the central hub: ready to settle).
   */
  async cutover(actor: UserActor, meta: RequestMeta) {
    if (!actor.permissions.has("config:manage")) throw forbidden("Only a super admin can do this");
    const central = (await readAccountsConfig(this.prisma)).centralHubId;
    // Old invoices' parcels (the old Invoice.lines JSON).
    const oldInvoiced = new Set(
      (await this.prisma.invoice.findMany({ where: { status: { not: "VOID" } }, select: { lines: true } })).flatMap(i =>
        (Array.isArray(i.lines) ? (i.lines as { trackingId?: unknown; kind?: unknown }[]) : []).flatMap(l => (typeof l.trackingId === "string" && l.kind !== "RETURN" ? [l.trackingId] : [])),
      ),
    );
    let posted = 0;
    let skipped = 0;
    let cursor: string | undefined;
    for (;;) {
      const batch = await this.prisma.parcel.findMany({
        where: { status: { in: ["DELIVERED", "RETURNED"] }, ...(cursor ? { id: { gt: cursor } } : {}) },
        include: { codCollection: { select: { state: true, settlementId: true } } },
        orderBy: { id: "asc" },
        take: 500,
      });
      if (!batch.length) break;
      cursor = batch[batch.length - 1].id;
      const done = new Set((await this.prisma.accountEntry.findMany({ where: { parcelId: { in: batch.map(p => p.id) } }, select: { parcelId: true } })).map(e => e.parcelId));
      for (const p of batch) {
        if (done.has(p.id)) continue;
        if (p.codCollection?.settlementId || p.codCollection?.state === "SETTLED" || oldInvoiced.has(p.trackingId)) {
          skipped++;
          continue;
        }
        await postParcelEntries(this.prisma, p);
        posted++;
      }
    }
    // Cash received at hubs the old way (cash handovers / counter): placed at its hub.
    const loose = await this.prisma.codCollection.findMany({ where: { state: "AT_HUB", cashHubId: null }, include: { handover: { select: { hubId: true } } } });
    let placed = 0;
    for (const c of loose) {
      const hubId = c.handover?.hubId ?? c.hubId;
      if (!hubId) continue;
      await this.prisma.codCollection.update({ where: { id: c.id }, data: hubId === central ? { state: "AT_CENTRAL", cashHubId: hubId, centralAt: new Date() } : { cashHubId: hubId } });
      placed++;
    }
    await this.audit.record(actor, { action: "accounts.cutover", entityType: "setting", entityId: "accounts.config", data: { posted, skipped, placed } }, meta);
    return { parcels: posted, skippedSettledOrInvoiced: skipped, cashPlaced: placed };
  }

  /** Live update for the money pages and the account's owner. */
  published(a: Pick<Account, "id" | "merchantId" | "customerId">) {
    // finance:manage, not finance:read: merchant owners hold finance:read and must see only their own account.
    this.realtime.publish({ type: "account.updated", id: a.id, merchantId: a.merchantId, customerId: a.customerId, staffPermission: "finance:manage" });
  }
}

export const round = (n: number) => Math.round(n * 100) / 100;
export type AccountSummary = Awaited<ReturnType<AccountsService["summary"]>>;
export type { AccountKind };
export { OPEN_TYPES, CHARGE_TYPES };
