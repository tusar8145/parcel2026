import { HttpStatus, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { Prisma } from "../../generated/prisma/client";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { AppError, conflict, notFound } from "../../common/errors";
import { pageArgs, toPage } from "../../common/pagination";
import type { UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { DEBIT_NORMAL, LedgerService, credit, debit, dhakaPeriod, periodRange } from "./ledger.service";
import { money } from "./finance.scope";
import type {
  closePeriodSchema,
  createAccountSchema,
  depositSchema,
  listEntriesQuerySchema,
  manualJournalSchema,
  statementQuerySchema,
  trialBalanceQuerySchema,
} from "./ledger.schemas";

const D = (v: string | number | Prisma.Decimal) => new Prisma.Decimal(v);
type Totals = { accountId: string; d: Prisma.Decimal | null; c: Prisma.Decimal | null };

/** Read side of the ledger (trial balance, statements, balances), manual journals and period close. */
@Injectable()
export class LedgerReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
  ) {}

  async accounts() {
    await this.ledger.accountIds();
    const [accounts, totals] = await Promise.all([
      this.prisma.ledgerAccount.findMany({ orderBy: { code: "asc" } }),
      this.totals(Prisma.sql`TRUE`),
    ]);
    return accounts.map(a => {
      const t = totals.get(a.id);
      return { id: a.id, code: a.code, name: a.name, type: a.type, systemKey: a.systemKey, active: a.active, balance: money(this.balance(a.type, t?.d, t?.c)) };
    });
  }

  async createAccount(actor: UserActor, input: z.infer<typeof createAccountSchema>, meta: RequestMeta) {
    if (await this.prisma.ledgerAccount.findUnique({ where: { code: input.code } })) throw conflict("ACCOUNT_CODE_TAKEN", `Account ${input.code} already exists`);
    return this.prisma.$transaction(async tx => {
      const account = await tx.ledgerAccount.create({ data: input });
      await this.audit.record(actor, { action: "ledger.account.create", entityType: "ledger_account", entityId: account.id, data: input }, meta, tx);
      return account;
    });
  }

  /** Debits and credits per account: movements of one period, or cumulative up to `asOf`. */
  async trialBalance(query: z.infer<typeof trialBalanceQuerySchema>) {
    await this.ledger.accountIds();
    const filter = query.period ? Prisma.sql`e.period = ${query.period}` : query.asOf ? Prisma.sql`e."occurredAt" < ${query.asOf}` : Prisma.sql`TRUE`;
    const [accounts, totals] = await Promise.all([this.prisma.ledgerAccount.findMany({ orderBy: { code: "asc" } }), this.totals(filter)]);
    let td = D(0);
    let tc = D(0);
    const rows = accounts
      .map(a => {
        const t = totals.get(a.id);
        const d = t?.d ?? D(0);
        const c = t?.c ?? D(0);
        td = td.plus(d);
        tc = tc.plus(c);
        const net = d.minus(c);
        return { code: a.code, name: a.name, type: a.type, debit: money(d), credit: money(c), debitBalance: money(net.gt(0) ? net : D(0)), creditBalance: money(net.lt(0) ? net.negated() : D(0)), balance: money(this.balance(a.type, d, c)) };
      })
      .filter(r => r.debit || r.credit || !query.nonZeroOnly);
    return { period: query.period ?? null, asOf: query.asOf ?? null, accounts: rows, totals: { debit: money(td), credit: money(tc) }, balanced: td.equals(tc) };
  }

  /** Opening balance, lines with running balance and closing balance for an account (optionally one merchant / rider / hub). */
  async statement(query: z.infer<typeof statementQuerySchema>) {
    await this.ledger.accountIds();
    const account = await this.prisma.ledgerAccount.findFirst({ where: { OR: [{ code: query.account }, { systemKey: query.account.toUpperCase() }] } });
    if (!account) throw notFound("Account");
    const dims: Prisma.JournalLineWhereInput = { accountId: account.id, merchantId: query.merchantId, riderId: query.riderId, hubId: query.hubId };
    const opening = query.from
      ? await this.prisma.journalLine.aggregate({ where: { ...dims, entry: { occurredAt: { lt: query.from } } }, _sum: { debit: true, credit: true } })
      : null;
    let running = this.balance(account.type, opening?._sum.debit, opening?._sum.credit);
    const openingBalance = running;
    const lines = await this.prisma.journalLine.findMany({
      where: { ...dims, entry: { occurredAt: { gte: query.from, lt: query.to } } },
      include: { entry: { select: { number: true, eventType: true, reference: true, memo: true, occurredAt: true, period: true } } },
      orderBy: [{ entry: { occurredAt: "asc" } }, { entryId: "asc" }, { id: "asc" }],
      take: query.limit + 1,
    });
    const truncated = lines.length > query.limit;
    const items = lines.slice(0, query.limit).map(l => {
      running = running.plus(DEBIT_NORMAL.has(account.type) ? l.debit.minus(l.credit) : l.credit.minus(l.debit));
      return {
        entryNumber: l.entry.number,
        eventType: l.entry.eventType,
        reference: l.entry.reference,
        memo: l.memo ?? l.entry.memo,
        occurredAt: l.entry.occurredAt,
        period: l.entry.period,
        debit: money(l.debit),
        credit: money(l.credit),
        balance: money(running),
        merchantId: l.merchantId,
        riderId: l.riderId,
        hubId: l.hubId,
      };
    });
    return { account: { code: account.code, name: account.name, type: account.type }, openingBalance: money(openingBalance), closingBalance: money(running), lines: items, truncated };
  }

  async entries(query: z.infer<typeof listEntriesQuerySchema>) {
    const rows = await this.prisma.journalEntry.findMany({
      where: {
        period: query.period,
        eventType: query.eventType,
        merchantId: query.merchantId,
        riderId: query.riderId,
        reference: query.reference ? { contains: query.reference, mode: "insensitive" } : undefined,
      },
      include: { lines: { include: { account: { select: { code: true, name: true } } } } },
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return {
      nextCursor: page.nextCursor,
      items: page.items.map(e => ({
        id: e.id,
        number: e.number,
        eventType: e.eventType,
        reference: e.reference,
        memo: e.memo,
        occurredAt: e.occurredAt,
        period: e.period,
        merchantId: e.merchantId,
        riderId: e.riderId,
        hubId: e.hubId,
        createdById: e.createdById,
        total: money(e.lines.reduce((a, l) => a.plus(l.debit), D(0))),
        lines: e.lines.map(l => ({ account: l.account, debit: money(l.debit), credit: money(l.credit), merchantId: l.merchantId, riderId: l.riderId, hubId: l.hubId, memo: l.memo })),
      })),
    };
  }

  /** A correcting / opening entry by finance; must balance. */
  async manualJournal(actor: UserActor, input: z.infer<typeof manualJournalSchema>, meta: RequestMeta) {
    const accounts = await this.prisma.ledgerAccount.findMany({ where: { code: { in: input.lines.map(l => l.account) } } });
    const byCode = new Map(accounts.map(a => [a.code, a]));
    const unknown = input.lines.filter(l => !byCode.get(l.account)?.active).map(l => l.account);
    if (unknown.length) throw new AppError("UNKNOWN_ACCOUNT", `Unknown or inactive accounts: ${[...new Set(unknown)].join(", ")}`, HttpStatus.UNPROCESSABLE_ENTITY);
    return this.prisma.$transaction(async tx => {
      const entry = await tx.journalEntry.findFirst({ where: { idempotencyKey: `MANUAL:${input.reference}` } });
      if (entry) throw conflict("DUPLICATE_REFERENCE", `A manual journal with reference ${input.reference} already exists`);
      const debitTotal = input.lines.reduce((a, l) => a.plus(l.debit), D(0));
      const creditTotal = input.lines.reduce((a, l) => a.plus(l.credit), D(0));
      if (!debitTotal.equals(creditTotal) || debitTotal.isZero())
        throw new AppError("LEDGER_UNBALANCED", `Debits (${debitTotal.toFixed(2)}) must equal credits (${creditTotal.toFixed(2)})`, HttpStatus.UNPROCESSABLE_ENTITY);
      const created = await this.ledger.post(tx, {
        eventType: "ADJUSTMENT",
        reference: input.reference,
        memo: input.memo,
        occurredAt: input.occurredAt,
        idempotencyKey: `MANUAL:${input.reference}`,
        createdById: actor.userId,
        lines: input.lines.map(l => ({
          account: null,
          accountId: byCode.get(l.account)!.id,
          amount: l.debit.minus(l.credit),
          merchantId: l.merchantId,
          riderId: l.riderId,
          hubId: l.hubId,
          memo: l.memo,
        })),
      });
      await this.audit.record(actor, { action: "ledger.journal.manual", entityType: "journal_entry", entityId: created?.id, data: { reference: input.reference, memo: input.memo, lines: input.lines.length, total: debitTotal.toFixed(2) } }, meta, tx);
      return { id: created?.id, number: created?.number };
    });
  }

  /** Hub cash banked (bank or bKash): moves it out of "Cash at hubs". */
  async deposit(actor: UserActor, input: z.infer<typeof depositSchema>, meta: RequestMeta) {
    const hub = await this.prisma.hub.findUnique({ where: { id: input.hubId }, select: { id: true, code: true } });
    if (!hub) throw notFound("Hub");
    const held = await this.hubCash(hub.id);
    if (input.amount.greaterThan(held)) throw new AppError("DEPOSIT_EXCEEDS_CASH", `Hub ${hub.code} holds ৳${held.toFixed(2)} in the ledger`, HttpStatus.UNPROCESSABLE_ENTITY, { held: money(held) });
    return this.prisma.$transaction(async tx => {
      const entry = await this.ledger.post(tx, {
        eventType: "CASH_DEPOSITED",
        reference: input.reference,
        memo: input.note ?? `Hub ${hub.code} cash deposited to ${input.to === "BKASH" ? "bKash" : "bank"}`,
        hubId: hub.id,
        idempotencyKey: `CASH_DEPOSITED:${input.reference}`,
        createdById: actor.userId,
        lines: [debit(input.to, input.amount), credit("CASH_AT_HUBS", input.amount, { hubId: hub.id })],
      });
      if (!entry) throw conflict("DUPLICATE_REFERENCE", `Deposit ${input.reference} was already recorded`);
      await this.audit.record(actor, { action: "ledger.deposit", entityType: "journal_entry", entityId: entry.id, data: { hubId: hub.id, amount: input.amount.toFixed(2), to: input.to, reference: input.reference } }, meta, tx);
      return { id: entry.id, number: entry.number };
    });
  }

  /** Cash the ledger says each hub / rider holds. */
  async cashPositions() {
    const ids = await this.ledger.accountIds();
    const [hubs, riders] = await Promise.all([
      this.prisma.journalLine.groupBy({ by: ["hubId"], where: { accountId: ids.get("CASH_AT_HUBS"), hubId: { not: null } }, _sum: { debit: true, credit: true } }),
      this.prisma.journalLine.groupBy({ by: ["riderId"], where: { accountId: ids.get("CASH_WITH_RIDERS"), riderId: { not: null } }, _sum: { debit: true, credit: true } }),
    ]);
    const [hubRows, riderRows] = await Promise.all([
      this.prisma.hub.findMany({ where: { id: { in: hubs.map(h => h.hubId!) } }, select: { id: true, code: true, name: true } }),
      this.prisma.rider.findMany({ where: { id: { in: riders.map(r => r.riderId!) } }, select: { id: true, code: true, user: { select: { name: true } } } }),
    ]);
    const net = (s: { debit: Prisma.Decimal | null; credit: Prisma.Decimal | null }) => money((s.debit ?? D(0)).minus(s.credit ?? D(0)));
    return {
      hubs: hubs.map(h => ({ hub: hubRows.find(x => x.id === h.hubId) ?? { id: h.hubId }, cash: net(h._sum) })).filter(h => h.cash !== 0),
      riders: riders.map(r => { const x = riderRows.find(y => y.id === r.riderId); return { rider: x ? { id: x.id, code: x.code, name: x.user.name } : { id: r.riderId }, cash: net(r._sum) }; }).filter(r => r.cash !== 0),
    };
  }

  /**
   * A merchant's running account with us: COD we hold for them (payables) less what they owe
   * (receivables: invoices, carried-forward shortfalls, weight re-pricing). Positive balance =
   * we owe the merchant. One row per journal entry; plus adjustments not yet applied.
   */
  async merchantStatement(merchantId: string, query: { from?: Date; to?: Date }) {
    const merchant = await this.prisma.merchant.findUnique({ where: { id: merchantId }, select: { id: true, code: true, name: true } });
    if (!merchant) throw notFound("Merchant");
    const ids = await this.ledger.accountIds();
    const accountIds = [ids.get("MERCHANT_PAYABLES")!, ids.get("MERCHANT_RECEIVABLES")!];
    const where: Prisma.JournalLineWhereInput = { merchantId, accountId: { in: accountIds } };
    const [opening, lines, payables, receivables, open] = await Promise.all([
      query.from ? this.prisma.journalLine.aggregate({ where: { ...where, entry: { occurredAt: { lt: query.from } } }, _sum: { debit: true, credit: true } }) : null,
      this.prisma.journalLine.findMany({
        where: { ...where, entry: { occurredAt: { gte: query.from, lt: query.to } } },
        include: { entry: { select: { id: true, number: true, eventType: true, reference: true, memo: true, occurredAt: true } } },
        orderBy: [{ entry: { occurredAt: "asc" } }, { entryId: "asc" }],
        take: 2000,
      }),
      this.prisma.journalLine.aggregate({ where: { merchantId, accountId: accountIds[0] }, _sum: { debit: true, credit: true } }),
      this.prisma.journalLine.aggregate({ where: { merchantId, accountId: accountIds[1] }, _sum: { debit: true, credit: true } }),
      this.prisma.merchantAdjustment.findMany({ where: { merchantId, settlementId: null, invoiceId: null }, orderBy: { createdAt: "asc" } }),
    ]);
    const net = (s: { debit: Prisma.Decimal | null; credit: Prisma.Decimal | null }) => (s.credit ?? D(0)).minus(s.debit ?? D(0));
    let running = opening ? net(opening._sum) : D(0);
    const openingBalance = running;
    const rows: { entryNumber: string; eventType: string; reference: string; memo: string | null; occurredAt: Date; amount: number; balance: number }[] = [];
    const byEntry = new Map<string, { e: (typeof lines)[number]["entry"]; change: Prisma.Decimal }>();
    for (const l of lines) {
      const cur = byEntry.get(l.entryId) ?? { e: l.entry, change: D(0) };
      cur.change = cur.change.plus(l.credit).minus(l.debit);
      byEntry.set(l.entryId, cur);
    }
    for (const { e, change } of byEntry.values()) {
      if (change.isZero()) continue;
      running = running.plus(change);
      rows.push({ entryNumber: e.number, eventType: e.eventType, reference: e.reference, memo: e.memo, occurredAt: e.occurredAt, amount: money(change), balance: money(running) });
    }
    const owedTo = net(payables._sum);
    const owedBy = net(receivables._sum).negated();
    return {
      merchant,
      openingBalance: money(openingBalance),
      closingBalance: money(running),
      position: { codHeldForMerchant: money(owedTo), owedByMerchant: money(owedBy), net: money(owedTo.minus(owedBy)) },
      openAdjustments: open.map(a => ({ id: a.id, kind: a.kind, amount: money(a.amount), description: a.description, reference: a.reference, createdAt: a.createdAt })),
      lines: rows,
    };
  }

  async periods() {
    const rows = await this.prisma.ledgerPeriod.findMany({ orderBy: { period: "desc" }, take: 36 });
    const current = dhakaPeriod(new Date());
    return { current, closed: rows.map(p => ({ period: p.period, closedAt: p.closedAt, closedById: p.closedById, note: p.note })) };
  }

  /** Closes a finished month: later postings dated in it go to the next open period. */
  async closePeriod(actor: UserActor, period: string, input: z.infer<typeof closePeriodSchema>, meta: RequestMeta) {
    if (periodRange(period).end.getTime() > Date.now()) throw new AppError("PERIOD_NOT_ENDED", `${period} hasn't ended yet`, HttpStatus.UNPROCESSABLE_ENTITY);
    const snapshot = await this.prisma.$transaction(
      async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('ledger-period-close'))`;
        if (await tx.ledgerPeriod.findUnique({ where: { period } })) throw conflict("PERIOD_CLOSED", `${period} is already closed`);
        const tb = await this.trialBalance({ period, nonZeroOnly: true });
        if (!tb.balanced) throw new AppError("LEDGER_UNBALANCED", `${period} doesn't balance; investigate before closing`, HttpStatus.CONFLICT);
        await tx.ledgerPeriod.create({ data: { period, closedById: actor.userId, snapshot: tb as unknown as Prisma.InputJsonObject, note: input.note } });
        await this.audit.record(actor, { action: "ledger.period.close", entityType: "ledger_period", entityId: period, data: { totals: tb.totals, note: input.note ?? null } }, meta, tx);
        return tb;
      },
      { timeout: 30_000 },
    );
    return { period, closed: true, trialBalance: snapshot };
  }

  async hubCash(hubId: string) {
    const ids = await this.ledger.accountIds();
    const s = await this.prisma.journalLine.aggregate({ where: { accountId: ids.get("CASH_AT_HUBS"), hubId }, _sum: { debit: true, credit: true } });
    return (s._sum.debit ?? D(0)).minus(s._sum.credit ?? D(0));
  }

  private balance(type: Parameters<typeof DEBIT_NORMAL.has>[0], d?: Prisma.Decimal | null, c?: Prisma.Decimal | null) {
    const debits = d ?? D(0);
    const credits = c ?? D(0);
    return DEBIT_NORMAL.has(type) ? debits.minus(credits) : credits.minus(debits);
  }

  private async totals(filter: Prisma.Sql) {
    const rows = await this.prisma.$queryRaw<Totals[]>`
      SELECT l."accountId", SUM(l.debit) AS d, SUM(l.credit) AS c
      FROM journal_lines l JOIN journal_entries e ON e.id = l."entryId"
      WHERE ${filter}
      GROUP BY l."accountId"`;
    return new Map(rows.map(r => [r.accountId, { ...r, d: r.d === null ? null : D(r.d), c: r.c === null ? null : D(r.c) }]));
  }
}
