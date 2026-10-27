import { HttpStatus, Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import type { z } from "zod";
import { PrismaService, type Db } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { AppError, conflict, forbidden, notFound } from "../../common/errors";
import type { Actor, UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { nextNumber } from "../../common/counters";
import { QueueService } from "../../common/queues";
import { env, runsJobs } from "../../config/env";
import { Prisma } from "../../generated/prisma/client";
import { LedgerService, credit, debit } from "../finance/ledger.service";
import { cashHubScope } from "../finance/finance.scope";
import { CodService } from "../finance/cod.service";
import { hubCashPlacement } from "../money/cash-placement";
import { InboxService } from "../notifications/inbox.service";
import { RealtimeService } from "../../common/realtime.service";
import { readFranchiseConfig } from "./franchise-config";
import { FranchisePanelService, cashPosition } from "./franchise-panel.service";
import type { franchiseHandoverSchema, franchiseRemittanceSchema, listFranchiseInvoicesQuerySchema, listRemittancesQuerySchema, payFranchiseInvoiceSchema, receiveRemittanceSchema } from "./franchise.schemas";

const n = (v: Prisma.Decimal | number | null | undefined) => (v == null ? 0 : Number(v));
const round2 = (x: number) => Math.round(x * 100) / 100;

const remittanceInclude = {
  franchise: { select: { id: true, code: true, name: true, hubId: true, hub: { select: { name: true } } } },
  hub: { select: { id: true, code: true, name: true } },
} satisfies Prisma.FranchiseRemittanceInclude;
type RemittanceRow = Prisma.FranchiseRemittanceGetPayload<{ include: typeof remittanceInclude }>;
const remittanceView = (r: RemittanceRow) => ({
  id: r.id,
  number: r.number,
  status: r.status,
  franchise: { id: r.franchise.id, code: r.franchise.code, name: r.franchise.name, hub: r.franchise.hub.name },
  hub: r.hub,
  gross: n(r.gross),
  commissionDeducted: n(r.commissionDeducted),
  net: n(r.net),
  collections: r.collectionIds.length,
  note: r.note,
  requestedAt: r.requestedAt,
  receivedAt: r.receivedAt,
});

const invoiceInclude = { franchise: { select: { id: true, code: true, name: true, contactName: true, contactPhone: true, hub: { select: { name: true, address: true } } } } } satisfies Prisma.FranchiseInvoiceInclude;
type InvoiceRow = Prisma.FranchiseInvoiceGetPayload<{ include: typeof invoiceInclude }>;
const invoiceView = (i: InvoiceRow) => ({
  id: i.id,
  number: i.number,
  status: i.status,
  settlement: i.settlement,
  franchise: { id: i.franchise.id, code: i.franchise.code, name: i.franchise.name, hub: i.franchise.hub.name },
  periodFrom: i.periodFrom,
  periodTo: i.periodTo,
  amount: n(i.amount),
  createdAt: i.createdAt,
  approvedAt: i.approvedAt,
  paidAt: i.paidAt,
  paymentMethod: i.paymentMethod,
  reference: i.reference,
});

/**
 * Franchise money: rider cash received at the franchise hub, deposits at a company hub (DEDUCT mode keeps the
 * unsettled commission), commission invoices (DEDUCT: a record of what was kept; BILL: Finance approves and pays,
 * maker-checker) and the automatic BILL-mode invoicing every `billingPeriodDays`.
 */
@Injectable()
export class FranchiseMoneyService implements OnApplicationBootstrap {
  private readonly logger = new Logger("Franchise");

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
    private readonly cod: CodService,
    private readonly inbox: InboxService,
    private readonly realtime: RealtimeService,
    private readonly queues: QueueService,
    private readonly panel: FranchisePanelService,
  ) {}

  onApplicationBootstrap() {
    if (!runsJobs() || env().NODE_ENV === "test") return;
    void this.queues
      .schedule("franchise-billing", "20 1 * * *", async () => {
        const made = await this.runBilling();
        if (made.length) this.logger.log(`Franchise invoices: ${made.join(", ")}`);
      })
      .catch(err => this.logger.error({ err }, "Could not schedule the franchise billing job"));
  }

  // ───────────── franchise: cash ─────────────

  async cash(actor: Actor) {
    const f = await this.panel.context(actor);
    const riderIds = (await this.prisma.rider.findMany({ where: { hubId: f.hubId }, select: { id: true } })).map(r => r.id);
    const [position, requests, remittances, config] = await Promise.all([
      cashPosition(this.prisma, f.id, f.hubId, riderIds),
      openSlips(this.prisma, riderIds),
      this.prisma.franchiseRemittance.findMany({ where: { franchiseId: f.id }, include: remittanceInclude, orderBy: { requestedAt: "desc" }, take: 50 }),
      readFranchiseConfig(this.prisma),
    ]);
    const riderCash = await this.prisma.codCollection.findMany({
      where: { riderId: { in: riderIds }, state: "WITH_RIDER", handoverId: null },
      select: { id: true, amount: true, riderId: true, parcel: { select: { trackingId: true } } },
    });
    const byRider = new Map<string, { riderId: string; amount: number; collectionIds: string[]; parcels: string[] }>();
    for (const c of riderCash) {
      const e = byRider.get(c.riderId!) ?? { riderId: c.riderId!, amount: 0, collectionIds: [], parcels: [] };
      e.amount = round2(e.amount + n(c.amount));
      e.collectionIds.push(c.id);
      e.parcels.push(c.parcel.trackingId);
      byRider.set(c.riderId!, e);
    }
    const { codCollectionIds: _ids, ...summary } = position;
    const deductible = config.settlementMode === "DEDUCT" ? Math.min(position.onHand, position.unsettledCommission) : 0;
    return {
      ...summary,
      settlementMode: config.settlementMode,
      depositNow: { gross: position.onHand, commissionDeducted: round2(deductible), net: round2(position.onHand - deductible) },
      riders: [...byRider.values()],
      handoverRequests: requests,
      remittances: remittances.map(remittanceView),
    };
  }

  /** Cash a rider of the franchise hands over at the counter (their open handover slip, if any, is closed: the counter took the cash). */
  async receiveRiderCash(actor: UserActor, input: z.infer<typeof franchiseHandoverSchema>, meta: RequestMeta) {
    const f = await this.panel.context(actor);
    const rider = await this.prisma.rider.findUnique({ where: { id: input.riderId }, select: { hubId: true } });
    if (!rider || rider.hubId !== f.hubId) throw notFound("Rider");
    await this.cod.createHandover(actor, { riderId: input.riderId, hubId: f.hubId, collectionIds: input.collectionIds, amountReceived: input.amountReceived } as never, meta);
    await this.prisma.$transaction(async tx => {
      const open = await tx.cashSlip.findFirst({ where: { riderId: input.riderId, status: "OPEN" } });
      if (!open) return;
      await tx.codCollection.updateMany({ where: { slipId: open.id }, data: { slipId: null } });
      await tx.cashSlip.update({ where: { id: open.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    });
    return this.cash(actor);
  }

  /** Deposit: everything on hand goes to a company hub (DEDUCT mode keeps the unsettled commission); that hub confirms. */
  async requestDeposit(actor: Actor, input: z.infer<typeof franchiseRemittanceSchema>, meta: RequestMeta) {
    const f = await this.panel.context(actor);
    const hub = await this.prisma.hub.findUnique({ where: { id: input.hubId }, select: { id: true, name: true, active: true, type: true } });
    if (!hub || !hub.active) throw notFound("Hub");
    if (hub.type !== "COMPANY") throw new AppError("NOT_COMPANY_HUB", "Deposit cash at a Paira Express hub", HttpStatus.UNPROCESSABLE_ENTITY);
    const config = await readFranchiseConfig(this.prisma);
    const row = await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM franchises WHERE id = ${f.id}::uuid FOR UPDATE`;
      if (await tx.franchiseRemittance.findFirst({ where: { franchiseId: f.id, status: "PENDING" }, select: { id: true } }))
        throw conflict("DEPOSIT_PENDING", "A deposit is already waiting for the hub to confirm it");
      const riderIds = (await tx.rider.findMany({ where: { hubId: f.hubId }, select: { id: true } })).map(r => r.id);
      const position = await cashPosition(tx, f.id, f.hubId, riderIds);
      if (!(position.onHand > 0)) throw new AppError("NOTHING_TO_DEPOSIT", "There is no cash to deposit", HttpStatus.UNPROCESSABLE_ENTITY);
      // DEDUCT: keep unsettled commission (oldest first) up to the cash deposited.
      let deducted = 0;
      const kept: string[] = [];
      if (config.settlementMode === "DEDUCT") {
        const open = await tx.franchiseCommission.findMany({ where: { franchiseId: f.id, invoiceId: null, remittanceId: null }, orderBy: { earnedAt: "asc" }, select: { id: true, amount: true } });
        for (const c of open) {
          if (round2(deducted + n(c.amount)) > position.onHand) break;
          deducted = round2(deducted + n(c.amount));
          kept.push(c.id);
        }
      }
      const created = await tx.franchiseRemittance.create({
        data: {
          number: await nextNumber(tx, "FRM", "month"),
          franchiseId: f.id,
          hubId: hub.id,
          gross: position.onHand,
          commissionDeducted: deducted,
          net: round2(position.onHand - deducted),
          collectionIds: position.codCollectionIds,
          note: input.note,
        },
        include: remittanceInclude,
      });
      await tx.franchiseCounterCharge.updateMany({ where: { franchiseId: f.id, remittanceId: null }, data: { remittanceId: created.id } });
      if (kept.length) await tx.franchiseCommission.updateMany({ where: { id: { in: kept } }, data: { remittanceId: created.id } });
      await this.audit.record(actor, { action: "franchise.deposit_request", entityType: "franchise_remittance", entityId: created.id, data: { hubId: hub.id, gross: position.onHand, deducted } }, meta, tx);
      await this.inbox.toStaff(
        tx,
        { roles: ["HUB_OPERATOR"], hubIds: [hub.id] },
        { type: "staff.franchise_deposit", title: `Franchise deposit: ${f.name}`, body: `Tk ${n(created.net).toFixed(2)} to receive · ${created.number}`, target: { page: "accounts", tab: "franchise" }, panel: "/courier-operation" },
      );
      return created;
    });
    this.publish(row);
    return remittanceView(row);
  }

  async cancelDeposit(actor: Actor, id: string, meta: RequestMeta) {
    const f = await this.panel.context(actor);
    const row = await this.prisma.$transaction(async tx => {
      const r = await tx.franchiseRemittance.findUnique({ where: { id } });
      if (!r || r.franchiseId !== f.id) throw notFound("Deposit");
      if (r.status !== "PENDING") throw conflict("DEPOSIT_CLOSED", `This deposit is already ${r.status.toLowerCase()}`);
      await tx.franchiseRemittance.update({ where: { id }, data: { status: "CANCELLED" } });
      await tx.franchiseCounterCharge.updateMany({ where: { remittanceId: id }, data: { remittanceId: null } });
      await tx.franchiseCommission.updateMany({ where: { remittanceId: id }, data: { remittanceId: null } });
      await this.audit.record(actor, { action: "franchise.deposit_cancel", entityType: "franchise_remittance", entityId: id }, meta, tx);
      return tx.franchiseRemittance.findUniqueOrThrow({ where: { id }, include: remittanceInclude });
    });
    this.publish(row);
    return remittanceView(row);
  }

  // ───────────── company hubs / finance: deposits ─────────────

  async listDeposits(actor: Actor, query: z.infer<typeof listRemittancesQuerySchema>) {
    const scope = cashHubScope(actor);
    if (query.hubId && scope && !scope.includes(query.hubId)) throw forbidden("You can only view cash at your own hub");
    const rows = await this.prisma.franchiseRemittance.findMany({
      where: { status: query.status ?? "PENDING", ...(query.hubId ? { hubId: query.hubId } : scope ? { hubId: { in: scope } } : {}) },
      include: remittanceInclude,
      orderBy: { requestedAt: "desc" },
      take: 200,
    });
    return rows.map(remittanceView);
  }

  /** The company hub counts the cash and confirms it: the ledger moves it from the franchise hub to this hub. */
  async receiveDeposit(actor: Actor, id: string, input: z.infer<typeof receiveRemittanceSchema>, meta: RequestMeta) {
    const row = await this.prisma.$transaction(async tx => {
      const r = await tx.franchiseRemittance.findUnique({ where: { id }, include: remittanceInclude });
      if (!r) throw notFound("Deposit");
      const scope = cashHubScope(actor);
      if (scope && !scope.includes(r.hubId)) throw forbidden("Only that hub's staff or finance can receive this deposit");
      if (r.status !== "PENDING") throw conflict("DEPOSIT_CLOSED", `This deposit is already ${r.status.toLowerCase()}`);
      if (round2(input.amountReceived) !== n(r.net))
        throw new AppError("DEPOSIT_AMOUNT_MISMATCH", `This deposit is ৳${n(r.net).toFixed(2)}`, HttpStatus.UNPROCESSABLE_ENTITY, { expected: n(r.net), received: input.amountReceived });
      const { count } = await tx.franchiseRemittance.updateMany({
        where: { id, status: "PENDING" },
        data: { status: "RECEIVED", receivedById: actor.kind === "user" ? actor.userId : null, receivedAt: new Date(), note: input.note ?? r.note },
      });
      if (!count) throw conflict("DEPOSIT_CLOSED", "This deposit was just closed by someone else");
      const lines = [debit("CASH_AT_HUBS", r.net, { hubId: r.hubId }), credit("CASH_AT_HUBS", r.gross, { hubId: r.franchise.hubId })];
      if (n(r.commissionDeducted) > 0) lines.splice(1, 0, debit("FRANCHISE_PAYABLE", r.commissionDeducted, { hubId: r.franchise.hubId }));
      await this.ledger.post(tx, {
        eventType: "FRANCHISE_DEPOSIT",
        reference: r.number,
        memo: `${r.franchise.name} deposit at ${r.hub.name}`,
        hubId: r.hubId,
        createdById: actor.kind === "user" ? actor.userId : null,
        lines,
      });
      // The deposited COD is now this hub's cash (Accounts: sent on to the central hub, or ready there).
      if (r.collectionIds.length) await tx.codCollection.updateMany({ where: { id: { in: r.collectionIds }, state: "AT_HUB" }, data: { ...(await hubCashPlacement(tx, r.hubId)), slipId: null } });
      await this.audit.record(actor, { action: "franchise.deposit_receive", entityType: "franchise_remittance", entityId: id, data: { net: n(r.net), gross: n(r.gross) } }, meta, tx);
      return tx.franchiseRemittance.findUniqueOrThrow({ where: { id }, include: remittanceInclude });
    });
    this.publish(row);
    return remittanceView(row);
  }

  // ───────────── commission and invoices ─────────────

  async commissions(actor: Actor) {
    const f = await this.panel.context(actor);
    const rows = await this.prisma.franchiseCommission.findMany({
      where: { franchiseId: f.id },
      include: { parcel: { select: { trackingId: true } } },
      orderBy: { earnedAt: "desc" },
      take: 300,
    });
    const invoices = await this.prisma.franchiseInvoice.findMany({ where: { franchiseId: f.id }, include: invoiceInclude, orderBy: { createdAt: "desc" }, take: 50 });
    return {
      items: rows.map(c => ({
        type: c.type,
        trackingId: c.parcel.trackingId,
        base: n(c.base),
        percent: n(c.percent),
        minimum: n(c.minimum),
        amount: n(c.amount),
        earnedAt: c.earnedAt,
        state: c.invoiceId ? "invoiced" : c.remittanceId ? "deducted" : "unsettled",
      })),
      invoices: invoices.map(invoiceView),
    };
  }

  /**
   * An invoice for the franchise's settled-but-uninvoiced commission. DEDUCT: commissions kept from received deposits
   * (already paid → PAID); BILL: all uninvoiced commissions (Finance approves and pays).
   */
  async createInvoice(actor: Actor | null, franchiseId: string, meta?: RequestMeta) {
    const config = await readFranchiseConfig(this.prisma);
    const row = await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM franchises WHERE id = ${franchiseId}::uuid FOR UPDATE`;
      const where: Prisma.FranchiseCommissionWhereInput =
        config.settlementMode === "DEDUCT" ? { franchiseId, invoiceId: null, remittance: { status: "RECEIVED" } } : { franchiseId, invoiceId: null, remittanceId: null };
      const items = await tx.franchiseCommission.findMany({ where, select: { id: true, amount: true, earnedAt: true } });
      if (!items.length) throw new AppError("NOTHING_TO_INVOICE", config.settlementMode === "DEDUCT" ? "No deducted commission waits for an invoice (deposits must be received first)" : "No commission waits for an invoice", HttpStatus.UNPROCESSABLE_ENTITY);
      const amount = round2(items.reduce((a, c) => a + n(c.amount), 0));
      const now = new Date();
      const userId = actor?.kind === "user" ? actor.userId : null;
      const deducted = config.settlementMode === "DEDUCT";
      const created = await tx.franchiseInvoice.create({
        data: {
          number: await nextNumber(tx, "FIN", "month"),
          franchiseId,
          periodFrom: items.reduce((a, c) => (c.earnedAt < a ? c.earnedAt : a), now),
          periodTo: items.reduce((a, c) => (c.earnedAt > a ? c.earnedAt : a), new Date(0)),
          amount,
          settlement: deducted ? "DEDUCTED" : "PAYABLE",
          status: deducted ? "PAID" : "ISSUED",
          createdById: userId,
          paidAt: deducted ? now : null,
          paymentMethod: deducted ? "DEDUCTED" : null,
        },
        include: invoiceInclude,
      });
      await tx.franchiseCommission.updateMany({ where: { id: { in: items.map(i => i.id) } }, data: { invoiceId: created.id } });
      if (actor) await this.audit.record(actor, { action: "franchise.invoice_create", entityType: "franchise_invoice", entityId: created.id, data: { amount, items: items.length, settlement: created.settlement } }, meta ?? {}, tx);
      if (!deducted)
        await this.inbox.toStaff(
          tx,
          { roles: ["FINANCE"] },
          { type: "staff.franchise_invoice", title: `Franchise invoice to approve: ${created.franchise.name}`, body: `${created.number} · Tk ${amount.toFixed(2)}`, target: { page: "accounts", tab: "franchise" }, panel: "/courier-operation" },
        );
      return created;
    });
    return invoiceView(row);
  }

  async createMyInvoice(actor: Actor, meta: RequestMeta) {
    const f = await this.panel.context(actor);
    return this.createInvoice(actor, f.id, meta);
  }

  async listInvoices(query: z.infer<typeof listFranchiseInvoicesQuerySchema>) {
    const rows = await this.prisma.franchiseInvoice.findMany({ where: { status: query.status, franchiseId: query.franchiseId }, include: invoiceInclude, orderBy: { createdAt: "desc" }, take: 300 });
    return rows.map(invoiceView);
  }

  /** The franchise's own invoice, or any invoice for finance staff (PDF, detail). */
  async invoiceDetail(actor: Actor, id: string) {
    const i = await this.prisma.franchiseInvoice.findUnique({
      where: { id },
      include: { ...invoiceInclude, commissions: { include: { parcel: { select: { trackingId: true } } }, orderBy: { earnedAt: "asc" } } },
    });
    if (!i) throw notFound("Invoice");
    const own = actor.kind === "user" && actor.roles.some(r => r.role === "FRANCHISE" && r.hubId) && (await this.prisma.franchise.findFirst({ where: { id: i.franchiseId, hubId: { in: actor.roles.flatMap(r => (r.hubId ? [r.hubId] : [])) } }, select: { id: true } }));
    if (!own && !actor.permissions.has("finance:read")) throw notFound("Invoice");
    return {
      ...invoiceView(i),
      franchise: { ...invoiceView(i).franchise, contactName: i.franchise.contactName, contactPhone: i.franchise.contactPhone, address: i.franchise.hub.address },
      lines: i.commissions.map(c => ({ trackingId: c.parcel.trackingId, type: c.type, base: n(c.base), percent: n(c.percent), minimum: n(c.minimum), amount: n(c.amount), earnedAt: c.earnedAt })),
    };
  }

  async approveInvoice(actor: UserActor, id: string, meta: RequestMeta) {
    const row = await this.prisma.$transaction(async tx => {
      const i = await tx.franchiseInvoice.findUnique({ where: { id } });
      if (!i) throw notFound("Invoice");
      if (i.status !== "ISSUED") throw conflict("INVOICE_NOT_ISSUED", `This invoice is ${i.status.toLowerCase()}`);
      if (i.createdById && i.createdById === actor.userId) throw new AppError("MAKER_CHECKER", "Another finance user must approve an invoice you created", HttpStatus.FORBIDDEN);
      await tx.franchiseInvoice.update({ where: { id }, data: { status: "APPROVED", approvedById: actor.userId, approvedAt: new Date() } });
      await this.audit.record(actor, { action: "franchise.invoice_approve", entityType: "franchise_invoice", entityId: id }, meta, tx);
      return tx.franchiseInvoice.findUniqueOrThrow({ where: { id }, include: invoiceInclude });
    });
    return invoiceView(row);
  }

  async payInvoice(actor: UserActor, id: string, input: z.infer<typeof payFranchiseInvoiceSchema>, meta: RequestMeta) {
    const row = await this.prisma.$transaction(async tx => {
      const i = await tx.franchiseInvoice.findUnique({ where: { id }, include: { franchise: { select: { hubId: true, name: true } } } });
      if (!i) throw notFound("Invoice");
      if (i.status !== "APPROVED") throw conflict("INVOICE_NOT_APPROVED", i.status === "ISSUED" ? "Approve the invoice first" : `This invoice is ${i.status.toLowerCase()}`);
      await tx.franchiseInvoice.update({ where: { id }, data: { status: "PAID", paidById: actor.userId, paidAt: new Date(), paymentMethod: input.method, reference: input.reference } });
      const account = input.method === "BKASH" ? "BKASH" : input.method === "CASH" ? "CASH_AT_HUBS" : "BANK";
      await this.ledger.post(tx, {
        eventType: "FRANCHISE_COMMISSION_PAID",
        reference: i.number,
        memo: `${i.franchise.name} · ${input.reference}`,
        hubId: i.franchise.hubId,
        createdById: actor.userId,
        lines: [debit("FRANCHISE_PAYABLE", i.amount, { hubId: i.franchise.hubId }), credit(account, i.amount)],
      });
      await this.audit.record(actor, { action: "franchise.invoice_pay", entityType: "franchise_invoice", entityId: id, data: { method: input.method, reference: input.reference } }, meta, tx);
      return tx.franchiseInvoice.findUniqueOrThrow({ where: { id }, include: invoiceInclude });
    });
    return invoiceView(row);
  }

  /** BILL mode: invoices every active franchise whose last invoice is `billingPeriodDays` old (or that has none yet). */
  async runBilling(now = new Date()) {
    const config = await readFranchiseConfig(this.prisma);
    if (config.settlementMode !== "BILL") return [];
    const made: string[] = [];
    const franchises = await this.prisma.franchise.findMany({ where: { status: "ACTIVE" }, select: { id: true, code: true, createdAt: true } });
    for (const f of franchises) {
      const last = await this.prisma.franchiseInvoice.findFirst({ where: { franchiseId: f.id, settlement: "PAYABLE" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
      const since = last?.createdAt ?? f.createdAt;
      if (now.getTime() - since.getTime() < config.billingPeriodDays * 24 * 3600_000) continue;
      try {
        const inv = await this.createInvoice(null, f.id);
        made.push(`${f.code} ${inv.number}`);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
      }
    }
    return made;
  }

  private publish(r: { id: string; hubId: string; franchise: { hubId: string } }) {
    this.realtime.publish({ type: "franchise.cash", id: r.id, hubIds: [r.hubId, r.franchise.hubId], staffPermission: "finance:read" });
  }
}

export type FranchiseInvoiceDetail = Awaited<ReturnType<FranchiseMoneyService["invoiceDetail"]>>;

/** Open handover slips of these riders, shaped like the franchise panel's "asked to hand over" list. */
async function openSlips(db: Db, riderIds: string[]) {
  const slips = await db.cashSlip.findMany({ where: { riderId: { in: riderIds }, status: "OPEN" }, orderBy: { createdAt: "asc" } });
  const riders = await db.rider.findMany({ where: { id: { in: slips.map(s => s.riderId) } }, select: { id: true, code: true, user: { select: { name: true } } } });
  return slips.flatMap(s => {
    const rider = riders.find(r => r.id === s.riderId);
    return rider ? [{ id: s.id, number: s.number, rider, amount: n(s.expected) }] : [];
  });
}
