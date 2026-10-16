import { HttpStatus, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { AppError, conflict, notFound } from "../../common/errors";
import { pageArgs, toPage } from "../../common/pagination";
import type { UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { Prisma, type BankStatementLine } from "../../generated/prisma/client";
import { money } from "./finance.scope";
import { InvoicesService } from "./invoices.service";
import { fingerprint, normRef, parseStatement } from "./statement-csv";
import type { exceptionsQuerySchema, ignoreLineSchema, listLinesQuerySchema, matchLineSchema, uploadStatementSchema } from "./reconciliation.schemas";

const DATE_WINDOW_MS = 3 * 86_400_000;
const lineInclude = {
  settlement: { select: { id: true, number: true, netPayable: true, reference: true, merchant: { select: { name: true } } } },
  invoice: { select: { id: true, number: true, total: true, subtotal: true, paymentReference: true, merchant: { select: { name: true } } } },
} satisfies Prisma.BankStatementLineInclude;
type LineRow = Prisma.BankStatementLineGetPayload<{ include: typeof lineInclude }>;

type Candidate = { kind: "settlement" | "invoice" | "riderPayout"; id: string; amount: Prisma.Decimal; refs: string[]; at: Date | null; needsPayment?: boolean };

/**
 * Bank / bKash statement reconciliation: import a CSV, auto-match each line to the payment it
 * records (settlement payouts and rider payouts going out, invoice payments coming in) by
 * reference, then by exact amount within ±3 days when only one payment fits. Finance resolves
 * the rest by hand (match, unmatch, ignore with a reason). Every action is audited.
 */
@Injectable()
export class ReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly invoices: InvoicesService,
  ) {}

  async upload(actor: UserActor, input: z.infer<typeof uploadStatementSchema>, meta: RequestMeta) {
    const parsed = parseStatement(input.content);
    if (!parsed.lines.length)
      throw new AppError("STATEMENT_UNREADABLE", "No transactions could be read from this file", HttpStatus.UNPROCESSABLE_ENTITY, { errors: parsed.errors.slice(0, 20) });
    const seen = new Map<string, number>();
    const rows = parsed.lines.map(l => {
      const key = `${l.postedAt.toISOString()}|${l.amount.toFixed(2)}|${l.reference ?? ""}|${l.description}`;
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      return { ...l, fingerprint: fingerprint(input.source, input.accountLabel, l, n) };
    });
    const existing = new Set((await this.prisma.bankStatementLine.findMany({ where: { fingerprint: { in: rows.map(r => r.fingerprint) } }, select: { fingerprint: true } })).map(r => r.fingerprint));
    const fresh = rows.filter(r => !existing.has(r.fingerprint));
    const times = rows.map(r => r.postedAt.getTime());

    const statement = await this.prisma.$transaction(async tx => {
      const st = await tx.bankStatement.create({
        data: {
          source: input.source,
          accountLabel: input.accountLabel,
          filename: input.filename,
          uploadedById: actor.userId,
          lineCount: fresh.length,
          duplicates: rows.length - fresh.length,
          periodStart: new Date(Math.min(...times)),
          periodEnd: new Date(Math.max(...times)),
        },
      });
      await tx.bankStatementLine.createMany({
        data: fresh.map(r => ({ statementId: st.id, lineNo: r.lineNo, postedAt: r.postedAt, description: r.description, reference: r.reference, amount: r.amount, fingerprint: r.fingerprint })),
        skipDuplicates: true,
      });
      await this.audit.record(
        actor,
        { action: "reconciliation.statement.upload", entityType: "bank_statement", entityId: st.id, data: { source: input.source, accountLabel: input.accountLabel, filename: input.filename, imported: fresh.length, duplicates: rows.length - fresh.length, unreadable: parsed.errors.length } },
        meta,
        tx,
      );
      return st;
    });
    const matched = input.autoMatch ? await this.autoMatch(actor, statement.id, meta) : { matched: 0 };
    return { ...(await this.statementDetail(statement.id)), autoMatched: matched.matched, parseErrors: parsed.errors.slice(0, 50) };
  }

  async statements() {
    const rows = await this.prisma.bankStatement.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
    const counts = await this.prisma.bankStatementLine.groupBy({ by: ["statementId", "status"], where: { statementId: { in: rows.map(r => r.id) } }, _count: { _all: true } });
    return rows.map(s => ({
      ...this.statementView(s),
      matched: counts.find(c => c.statementId === s.id && c.status === "MATCHED")?._count._all ?? 0,
      unmatched: counts.find(c => c.statementId === s.id && c.status === "UNMATCHED")?._count._all ?? 0,
      ignored: counts.find(c => c.statementId === s.id && c.status === "IGNORED")?._count._all ?? 0,
    }));
  }

  async statementDetail(id: string) {
    const s = await this.prisma.bankStatement.findUnique({ where: { id }, include: { lines: { include: lineInclude, orderBy: { lineNo: "asc" } } } });
    if (!s) throw notFound("Statement");
    const payouts = await this.payoutsFor(s.lines);
    return { ...this.statementView(s), lines: s.lines.map(l => this.lineView(l, payouts)) };
  }

  async lines(query: z.infer<typeof listLinesQuerySchema>) {
    const rows = await this.prisma.bankStatementLine.findMany({ where: { statementId: query.statementId, status: query.status }, include: lineInclude, ...pageArgs(query) });
    const page = toPage(rows, query.limit);
    const payouts = await this.payoutsFor(page.items);
    return { nextCursor: page.nextCursor, items: page.items.map(l => this.lineView(l, payouts)) };
  }

  /** Matches every unmatched line (optionally of one statement) it can be sure about. */
  async autoMatch(actor: UserActor, statementId: string | undefined, meta: RequestMeta) {
    const lines = await this.prisma.bankStatementLine.findMany({ where: { status: "UNMATCHED", statementId }, orderBy: { postedAt: "asc" }, take: 2000 });
    if (!lines.length) return { matched: 0 };
    const from = new Date(Math.min(...lines.map(l => l.postedAt.getTime())) - 45 * 86_400_000);
    const to = new Date(Math.max(...lines.map(l => l.postedAt.getTime())) + DATE_WINDOW_MS);
    const used = await this.prisma.bankStatementLine.findMany({ where: { status: "MATCHED" }, select: { settlementId: true, invoiceId: true, riderPayoutId: true } });
    const taken = new Set(used.flatMap(u => [u.settlementId, u.invoiceId, u.riderPayoutId]).filter((x): x is string => !!x));

    const [settlements, payouts, invoices] = await Promise.all([
      this.prisma.merchantSettlement.findMany({ where: { status: "PAID", netPayable: { gt: 0 }, paidAt: { gte: from, lte: to } }, select: { id: true, number: true, netPayable: true, reference: true, paidAt: true } }),
      this.prisma.riderPayout.findMany({ where: { status: "PAID", paidAt: { gte: from, lte: to } }, select: { id: true, number: true, amount: true, paymentReference: true, paidAt: true } }),
      this.prisma.invoice.findMany({ where: { status: { in: ["ISSUED", "PAID"] }, issuedAt: { gte: new Date(from.getTime() - 120 * 86_400_000), lte: to } }, select: { id: true, number: true, total: true, subtotal: true, status: true, paymentReference: true, paidAt: true } }),
    ]);
    const outgoing: Candidate[] = [
      ...settlements.map(s => ({ kind: "settlement" as const, id: s.id, amount: s.netPayable, refs: [normRef(s.reference), normRef(s.number)], at: s.paidAt })),
      ...payouts.map(p => ({ kind: "riderPayout" as const, id: p.id, amount: p.amount, refs: [normRef(p.paymentReference), normRef(p.number)], at: p.paidAt })),
    ];
    const incoming: Candidate[] = invoices.map(i => ({
      kind: "invoice" as const,
      id: i.id,
      amount: i.total.isZero() ? i.subtotal : i.total,
      refs: [normRef(i.number), normRef(i.paymentReference)],
      at: i.paidAt,
      needsPayment: i.status === "ISSUED",
    }));

    let matched = 0;
    for (const line of lines) {
      const pool = (line.amount.lt(0) ? outgoing : incoming).filter(c => !taken.has(c.id) && c.amount.equals(line.amount.abs()));
      const text = normRef(`${line.reference ?? ""} ${line.description}`);
      const lineRef = normRef(line.reference);
      // 1) reference: the payment's reference / number appears on the bank line.
      let hit = pool.filter(c => c.refs.some(r => r.length >= 4 && (r === lineRef || text.includes(r))));
      // 2) exact amount within ±3 days, only when a single paid payment fits.
      if (hit.length !== 1) hit = pool.filter(c => !c.needsPayment && c.at && Math.abs(c.at.getTime() - line.postedAt.getTime()) <= DATE_WINDOW_MS);
      if (hit.length !== 1) continue;
      const c = hit[0];
      try {
        if (c.needsPayment) await this.invoices.markPaid(actor, c.id, { reference: line.reference ?? `STATEMENT-LINE-${line.lineNo}`, via: "BANK" }, meta);
        const ok = await this.link(actor, line, c.kind, c.id, "AUTO", undefined, meta);
        if (ok) {
          taken.add(c.id);
          matched++;
        }
      } catch {
        // Someone matched or paid it meanwhile; leave the line for review.
      }
    }
    return { matched };
  }

  async match(actor: UserActor, lineId: string, input: z.infer<typeof matchLineSchema>, meta: RequestMeta) {
    const line = await this.prisma.bankStatementLine.findUnique({ where: { id: lineId } });
    if (!line) throw notFound("Statement line");
    if (line.status !== "UNMATCHED") throw conflict("LINE_NOT_UNMATCHED", "Unmatch or restore this line first");
    const [kind, id] = input.settlementId ? (["settlement", input.settlementId] as const) : input.invoiceId ? (["invoice", input.invoiceId] as const) : (["riderPayout", input.riderPayoutId!] as const);
    const target = await this.target(kind, id);
    if (line.amount.lt(0) !== (kind !== "invoice")) throw new AppError("DIRECTION_MISMATCH", kind === "invoice" ? "Invoice payments are money coming in" : "Payouts are money going out", HttpStatus.UNPROCESSABLE_ENTITY);
    if (!target.amount.equals(line.amount.abs()) && !input.note)
      throw new AppError("AMOUNT_MISMATCH", `The line is ৳${line.amount.abs().toFixed(2)} but the payment is ৳${target.amount.toFixed(2)}; add a note to match anyway`, HttpStatus.UNPROCESSABLE_ENTITY);
    const already = await this.prisma.bankStatementLine.findFirst({ where: { status: "MATCHED", OR: [{ settlementId: id }, { invoiceId: id }, { riderPayoutId: id }] } });
    if (already) throw conflict("ALREADY_MATCHED", "That payment is already matched to another statement line");
    if (target.needsPayment) await this.invoices.markPaid(actor, id, { reference: line.reference ?? `STATEMENT-LINE-${line.lineNo}`, via: "BANK" }, meta);
    if (!(await this.link(actor, line, kind, id, "MANUAL", input.note, meta))) throw conflict("LINE_NOT_UNMATCHED", "This line was just matched by someone else");
    return this.lineDetail(lineId);
  }

  async unmatch(actor: UserActor, lineId: string, meta: RequestMeta) {
    return this.reset(actor, lineId, "MATCHED", "reconciliation.line.unmatch", meta);
  }

  async restore(actor: UserActor, lineId: string, meta: RequestMeta) {
    return this.reset(actor, lineId, "IGNORED", "reconciliation.line.restore", meta);
  }

  async ignore(actor: UserActor, lineId: string, input: z.infer<typeof ignoreLineSchema>, meta: RequestMeta) {
    await this.prisma.$transaction(async tx => {
      const updated = await tx.bankStatementLine.updateMany({ where: { id: lineId, status: "UNMATCHED" }, data: { status: "IGNORED", note: input.note, matchedById: actor.userId, matchedAt: new Date() } });
      if (!updated.count) throw conflict("LINE_NOT_UNMATCHED", "Only unmatched lines can be ignored");
      await this.audit.record(actor, { action: "reconciliation.line.ignore", entityType: "bank_statement_line", entityId: lineId, data: { note: input.note } }, meta, tx);
    });
    return this.lineDetail(lineId);
  }

  /** Unmatched statement lines, and paid settlements / rider payouts / invoice payments no bank line confirms yet. */
  async exceptions(query: z.infer<typeof exceptionsQuerySchema>) {
    const to = query.to ?? new Date(Date.now() - 2 * 86_400_000);
    const from = query.from ?? new Date(to.getTime() - 60 * 86_400_000);
    const used = await this.prisma.bankStatementLine.findMany({ where: { status: "MATCHED" }, select: { settlementId: true, invoiceId: true, riderPayoutId: true } });
    const ids = (k: "settlementId" | "invoiceId" | "riderPayoutId") => used.map(u => u[k]).filter((x): x is string => !!x);
    const [unmatched, settlements, payouts, invoices] = await Promise.all([
      this.prisma.bankStatementLine.findMany({ where: { status: "UNMATCHED" }, include: lineInclude, orderBy: { postedAt: "asc" }, take: 500 }),
      this.prisma.merchantSettlement.findMany({
        where: { status: "PAID", netPayable: { gt: 0 }, paidAt: { gte: from, lt: to }, id: { notIn: ids("settlementId") } },
        select: { id: true, number: true, netPayable: true, reference: true, paidAt: true, merchant: { select: { name: true } } },
        orderBy: { paidAt: "asc" },
        take: 500,
      }),
      this.prisma.riderPayout.findMany({
        where: { status: "PAID", paidAt: { gte: from, lt: to }, id: { notIn: ids("riderPayoutId") } },
        select: { id: true, number: true, amount: true, paymentMethod: true, paymentReference: true, paidAt: true, rider: { select: { code: true } } },
        orderBy: { paidAt: "asc" },
        take: 500,
      }),
      this.prisma.invoice.findMany({
        where: { status: "PAID", paidAt: { gte: from, lt: to }, id: { notIn: ids("invoiceId") } },
        select: { id: true, number: true, total: true, subtotal: true, paymentReference: true, paidAt: true, merchant: { select: { name: true } } },
        orderBy: { paidAt: "asc" },
        take: 500,
      }),
    ]);
    const payoutRefs = await this.payoutsFor(unmatched);
    return {
      window: { from, to },
      unmatchedLines: unmatched.map(l => this.lineView(l, payoutRefs)),
      unreconciledPayments: [
        ...settlements.map(s => ({ kind: "settlement", id: s.id, number: s.number, party: s.merchant.name, amount: -money(s.netPayable), reference: s.reference, paidAt: s.paidAt })),
        ...payouts.map(p => ({ kind: "riderPayout", id: p.id, number: p.number, party: p.rider.code, amount: -money(p.amount), reference: p.paymentReference, paidAt: p.paidAt })),
        ...invoices.map(i => ({ kind: "invoice", id: i.id, number: i.number, party: i.merchant.name, amount: money(i.total.isZero() ? i.subtotal : i.total), reference: i.paymentReference, paidAt: i.paidAt })),
      ].sort((a, b) => (a.paidAt?.getTime() ?? 0) - (b.paidAt?.getTime() ?? 0)),
    };
  }

  // ───────────── helpers ─────────────

  private async link(actor: UserActor, line: BankStatementLine, kind: Candidate["kind"], id: string, method: "AUTO" | "MANUAL", note: string | undefined, meta: RequestMeta) {
    return this.prisma.$transaction(async tx => {
      // Serialise matches of the same payment.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`recon:${id}`}))`;
      const dup = await tx.bankStatementLine.findFirst({ where: { status: "MATCHED", OR: [{ settlementId: id }, { invoiceId: id }, { riderPayoutId: id }] }, select: { id: true } });
      if (dup) return false;
      const updated = await tx.bankStatementLine.updateMany({
        where: { id: line.id, status: "UNMATCHED" },
        data: {
          status: "MATCHED",
          matchMethod: method,
          settlementId: kind === "settlement" ? id : null,
          invoiceId: kind === "invoice" ? id : null,
          riderPayoutId: kind === "riderPayout" ? id : null,
          matchedById: actor.userId,
          matchedAt: new Date(),
          note: note ?? null,
        },
      });
      if (!updated.count) return false;
      await this.audit.record(actor, { action: "reconciliation.line.match", entityType: "bank_statement_line", entityId: line.id, data: { method, kind, targetId: id, amount: line.amount.toFixed(2), note: note ?? null } }, meta, tx);
      return true;
    });
  }

  private async reset(actor: UserActor, lineId: string, from: "MATCHED" | "IGNORED", action: string, meta: RequestMeta) {
    await this.prisma.$transaction(async tx => {
      const line = await tx.bankStatementLine.findUnique({ where: { id: lineId } });
      if (!line) throw notFound("Statement line");
      const updated = await tx.bankStatementLine.updateMany({
        where: { id: lineId, status: from },
        data: { status: "UNMATCHED", matchMethod: null, settlementId: null, invoiceId: null, riderPayoutId: null, matchedById: null, matchedAt: null, note: null },
      });
      if (!updated.count) throw conflict("INVALID_LINE_STATE", from === "MATCHED" ? "This line isn't matched" : "This line isn't ignored");
      await this.audit.record(actor, { action, entityType: "bank_statement_line", entityId: lineId, data: { settlementId: line.settlementId, invoiceId: line.invoiceId, riderPayoutId: line.riderPayoutId, note: line.note } }, meta, tx);
    });
    return this.lineDetail(lineId);
  }

  private async target(kind: Candidate["kind"], id: string): Promise<{ amount: Prisma.Decimal; needsPayment: boolean }> {
    if (kind === "settlement") {
      const s = await this.prisma.merchantSettlement.findUnique({ where: { id } });
      if (!s) throw notFound("Settlement");
      if (s.status !== "PAID") throw conflict("NOT_PAID", "Only paid settlements can be matched to a bank line");
      return { amount: s.netPayable, needsPayment: false };
    }
    if (kind === "riderPayout") {
      const p = await this.prisma.riderPayout.findUnique({ where: { id } });
      if (!p) throw notFound("Rider payout");
      if (p.status !== "PAID") throw conflict("NOT_PAID", "Only paid rider payouts can be matched to a bank line");
      return { amount: p.amount, needsPayment: false };
    }
    const i = await this.prisma.invoice.findUnique({ where: { id } });
    if (!i) throw notFound("Invoice");
    if (i.status === "VOID") throw conflict("INVOICE_VOID", "Voided invoices can't be matched");
    return { amount: i.total.isZero() ? i.subtotal : i.total, needsPayment: i.status === "ISSUED" };
  }

  private async lineDetail(id: string) {
    const l = await this.prisma.bankStatementLine.findUniqueOrThrow({ where: { id }, include: lineInclude });
    return this.lineView(l, await this.payoutsFor([l]));
  }

  private async payoutsFor(lines: { riderPayoutId: string | null }[]) {
    const ids = lines.map(l => l.riderPayoutId).filter((x): x is string => !!x);
    if (!ids.length) return new Map<string, { id: string; number: string; amount: Prisma.Decimal }>();
    const rows = await this.prisma.riderPayout.findMany({ where: { id: { in: ids } }, select: { id: true, number: true, amount: true } });
    return new Map(rows.map(r => [r.id, r]));
  }

  private statementView(s: { id: string; source: string; accountLabel: string; filename: string; lineCount: number; duplicates: number; periodStart: Date | null; periodEnd: Date | null; createdAt: Date; uploadedById: string | null }) {
    return { id: s.id, source: s.source, accountLabel: s.accountLabel, filename: s.filename, lineCount: s.lineCount, duplicates: s.duplicates, periodStart: s.periodStart, periodEnd: s.periodEnd, uploadedById: s.uploadedById, createdAt: s.createdAt };
  }

  private lineView(l: LineRow, payouts: Map<string, { id: string; number: string; amount: Prisma.Decimal }>) {
    const p = l.riderPayoutId ? payouts.get(l.riderPayoutId) : undefined;
    return {
      id: l.id,
      statementId: l.statementId,
      lineNo: l.lineNo,
      postedAt: l.postedAt,
      description: l.description,
      reference: l.reference,
      amount: money(l.amount),
      status: l.status,
      matchMethod: l.matchMethod,
      note: l.note,
      matchedAt: l.matchedAt,
      match: l.settlement
        ? { kind: "settlement", id: l.settlement.id, number: l.settlement.number, party: l.settlement.merchant.name, amount: money(l.settlement.netPayable) }
        : l.invoice
          ? { kind: "invoice", id: l.invoice.id, number: l.invoice.number, party: l.invoice.merchant.name, amount: money(l.invoice.total.isZero() ? l.invoice.subtotal : l.invoice.total) }
          : p
            ? { kind: "riderPayout", id: p.id, number: p.number, party: null, amount: money(p.amount) }
            : null,
    };
  }
}
