import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { PrismaService, type Db } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { RealtimeService } from "../../common/realtime.service";
import { OutboxService } from "../notifications/outbox.service";
import { InboxService } from "../notifications/inbox.service";
import { NotifyService } from "../notifications/notify.service";
import { WebhooksService } from "../notifications/webhooks.service";
import { assertKycAllowed } from "../merchants/merchant-kyc.service";
import { nextNumber } from "../../common/counters";
import { AppError, conflict, notFound } from "../../common/errors";
import { pageArgs, toPage } from "../../common/pagination";
import type { Actor, UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { Prisma } from "../../generated/prisma/client";
import type { listSettlementsQuerySchema, paySettlementSchema } from "./finance.schemas";
import { ZERO, dhakaMonthStart, financeMerchantScope, money, sum } from "./finance.scope";
import { readFinanceConfig, vatSplit } from "./finance-config";
import { LedgerService, credit, debit, type LedgerVia } from "./ledger.service";
import { syncReturnCharges } from "./return-charges";
import { periodView, resolvePeriod, type PeriodQuery } from "../../common/period";
import { StorageService } from "../../common/storage.service";

const settlementInclude = {
  merchant: { select: { id: true, code: true, name: true } },
  _count: { select: { collections: true, adjustments: true } },
} satisfies Prisma.MerchantSettlementInclude;

type SettlementRow = Prisma.MerchantSettlementGetPayload<{ include: typeof settlementInclude }>;

/** Locks the merchant row so concurrent settlement / invoice runs for one merchant serialize. */
export async function lockMerchant(tx: Db, merchantId: string) {
  const rows = await tx.$queryRaw<{ id: string; name: string; contactPhone: string }[]>`
    SELECT id, name, "contactPhone" FROM merchants WHERE id = ${merchantId}::uuid FOR NO KEY UPDATE`;
  if (!rows.length) throw notFound("Merchant");
  return rows[0];
}

/** Payout channel from the merchant's payout account (bKash wallet → bKash, everything else → bank). */
const payoutVia = (account: Prisma.JsonValue | null): LedgerVia => ((account as { method?: string } | null)?.method === "BKASH" ? "BKASH" : "BANK");

/**
 * Merchant COD settlements.
 *
 * Net payable = COD collected − delivery charges − open merchant adjustments (positive = the
 * merchant owes us, e.g. a previous shortfall or a weight re-pricing; negative = we owe them,
 * e.g. an approved claim credited to their balance). A negative result is never paid: the
 * settlement pays ৳0 and the shortfall is carried forward as a new CARRY_FORWARD adjustment
 * deducted from the next settlement (it shows on the merchant statement as a receivable).
 */
@Injectable()
export class SettlementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  /** cod.settled webhooks (property injection keeps the constructor stable for parallel edits). */
  @Inject(WebhooksService) private readonly settlementWebhooks!: WebhooksService;
  @Inject(LedgerService) private readonly ledger!: LedgerService;
  @Inject(StorageService) private readonly storage!: StorageService;
  @Inject(NotifyService) private readonly notify!: NotifyService;
  @Inject(InboxService) private readonly inbox!: InboxService;
  @Inject(RealtimeService) private readonly realtime!: RealtimeService;

  /** Drafts a payout of every unsettled COD collection at hubs for the merchant. */
  async create(actor: UserActor, merchantId: string, meta: RequestMeta, collectionIds?: string[]) {
    const id = await this.draft(actor, merchantId, meta, { collectionIds });
    return this.detail(actor, id);
  }

  /**
   * Draft settlement dialog: the merchant's COD collections at hubs not yet settled (each parcel's COD,
   * delivery charge and net), and the open adjustments every settlement applies.
   */
  async eligible(merchantId: string) {
    await syncReturnCharges(this.prisma, merchantId);
    const [collections, adjustments] = await Promise.all([
      this.prisma.codCollection.findMany({
        where: { state: "AT_HUB", settlementId: null, parcel: { merchantId } },
        include: { parcel: { select: { trackingId: true, totalCharge: true, deliveredAt: true, merchantOrderRef: true, recipientName: true } } },
        orderBy: { collectedAt: "asc" },
        take: 5000,
      }),
      this.prisma.merchantAdjustment.findMany({ where: { merchantId, settlementId: null, invoiceId: null }, orderBy: { createdAt: "asc" } }),
    ]);
    const hubIds = [...new Set(collections.map(c => c.hubId).filter((x): x is string => !!x))];
    const hubs = new Map((hubIds.length ? await this.prisma.hub.findMany({ where: { id: { in: hubIds } }, select: { id: true, name: true } }) : []).map(h => [h.id, h.name]));
    return {
      items: collections.map(c => ({
        id: c.id,
        trackingId: c.parcel.trackingId,
        orderRef: c.parcel.merchantOrderRef,
        recipient: c.parcel.recipientName,
        deliveredAt: c.parcel.deliveredAt,
        collectedAt: c.collectedAt,
        hub: c.hubId ? (hubs.get(c.hubId) ?? null) : null,
        codAmount: money(c.amount),
        charge: money(c.parcel.totalCharge),
        net: money(c.amount.minus(c.parcel.totalCharge)),
      })),
      adjustments: adjustments.map(a => ({ id: a.id, kind: a.kind, description: a.description, amount: money(a.amount) })),
      adjustmentsTotal: money(sum(adjustments.map(a => a.amount))),
    };
  }

  /**
   * Drafts the settlement inside its own transaction. `actor` "system" = the settlement
   * schedule (autoDrafted; any finance user may then approve it).
   */
  async draft(actor: UserActor | "system", merchantId: string, meta: Partial<RequestMeta> = {}, opts: { minimumAmount?: Prisma.Decimal; collectionIds?: string[] } = {}) {
    const id = await this.prisma.$transaction(
      async tx => {
        await lockMerchant(tx, merchantId);
        await syncReturnCharges(tx, merchantId);
        const [collections, adjustments] = await Promise.all([
          tx.codCollection.findMany({
            // The parcels chosen in the dialog, else every one waiting.
            where: { state: "AT_HUB", settlementId: null, parcel: { merchantId }, ...(opts.collectionIds ? { id: { in: opts.collectionIds } } : {}) },
            include: { parcel: { select: { totalCharge: true } } },
          }),
          tx.merchantAdjustment.findMany({ where: { merchantId, settlementId: null, invoiceId: null } }),
        ]);
        if (opts.collectionIds && collections.length !== new Set(opts.collectionIds).size)
          throw conflict("COLLECTIONS_CHANGED", "Some of the chosen parcels were settled or changed meanwhile. Open Draft settlement again.");
        if (!collections.length && !adjustments.some(a => a.amount.lt(0)))
          throw new AppError("NOTHING_TO_SETTLE", "This merchant has no COD cash at hubs waiting to be settled", HttpStatus.UNPROCESSABLE_ENTITY);

        const codTotal = sum(collections.map(c => c.amount));
        const chargesTotal = sum(collections.map(c => c.parcel.totalCharge));
        const adjustmentsTotal = sum(adjustments.map(a => a.amount));
        const raw = codTotal.minus(chargesTotal).minus(adjustmentsTotal);
        const netPayable = raw.lt(0) ? ZERO : raw;
        const carriedForward = raw.lt(0) ? raw.negated() : ZERO;
        if (opts.minimumAmount && netPayable.lessThan(opts.minimumAmount))
          throw new AppError("BELOW_MINIMUM", `Net payable ৳${netPayable.toFixed(2)} is below the schedule minimum ৳${opts.minimumAmount.toFixed(2)}`, HttpStatus.UNPROCESSABLE_ENTITY);

        const settlement = await tx.merchantSettlement.create({
          data: {
            number: await nextNumber(tx, "ST", "month"),
            merchantId,
            codTotal,
            chargesTotal,
            adjustmentsTotal,
            netPayable,
            carriedForward,
            createdById: actor === "system" ? null : actor.userId,
            autoDrafted: actor === "system",
          },
        });
        const ids = collections.map(c => c.id);
        const linked = await tx.codCollection.updateMany({
          where: { id: { in: ids }, state: "AT_HUB", settlementId: null },
          data: { settlementId: settlement.id },
        });
        const applied = await tx.merchantAdjustment.updateMany({ where: { id: { in: adjustments.map(a => a.id) }, settlementId: null, invoiceId: null }, data: { settlementId: settlement.id } });
        if (linked.count !== ids.length || applied.count !== adjustments.length) throw conflict("SETTLEMENT_CONFLICT", "Collections changed while settling; try again");

        await this.audit.record(
          actor,
          {
            action: "settlement.create",
            entityType: "settlement",
            entityId: settlement.id,
            data: {
              number: settlement.number,
              merchantId,
              collections: ids.length,
              chosen: !!opts.collectionIds,
              adjustments: adjustments.length,
              codTotal: codTotal.toFixed(2),
              chargesTotal: chargesTotal.toFixed(2),
              adjustmentsTotal: adjustmentsTotal.toFixed(2),
              netPayable: netPayable.toFixed(2),
              carriedForward: carriedForward.toFixed(2),
              autoDrafted: actor === "system",
            },
          },
          meta,
          tx,
        );
        // Finance's bell: a draft waiting for a second person's approval (maker-checker).
        const merchant = await tx.merchant.findUnique({ where: { id: merchantId }, select: { name: true } });
        await this.inbox.toStaff(
          tx,
          { roles: ["FINANCE"], except: actor === "system" ? null : actor.userId },
          { type: "staff.settlement_approval", title: `Settlement ${settlement.number} to approve`, body: `${merchant?.name ?? "Merchant"} · Tk ${netPayable.toFixed(2)}`, target: { page: "cod-and-settlement" }, panel: "/courier-operation" },
        );
        return settlement.id;
      },
      { timeout: 15_000 },
    );
    this.publish(id, merchantId);
    return id;
  }

  /** Maker-checker: the approver can't be whoever drafted the settlement. */
  async approve(actor: UserActor, id: string, meta: RequestMeta) {
    const merchantId = await this.prisma.$transaction(async tx => {
      const settlement = await tx.merchantSettlement.findUnique({ where: { id } });
      if (!settlement) throw notFound("Settlement");
      if (settlement.status !== "DRAFT") throw conflict("SETTLEMENT_NOT_DRAFT", "Only draft settlements can be approved");
      const maker = await this.makerId(tx, settlement);
      if (!maker && !settlement.autoDrafted) throw conflict("SETTLEMENT_MAKER_UNKNOWN", "Can't tell who drafted this settlement; recreate it");
      // Double approval (super admin › Platform settings): someone other than the person who drafted it.
      const { settlementApproval } = await readFinanceConfig(tx);
      if (settlementApproval === "DOUBLE" && maker === actor.userId) throw new AppError("SAME_USER_APPROVAL", "Someone other than the person who drafted it must approve this settlement", HttpStatus.FORBIDDEN);

      const updated = await tx.merchantSettlement.updateMany({ where: { id, status: "DRAFT" }, data: { status: "APPROVED", approvedById: actor.userId } });
      if (updated.count !== 1) throw conflict("SETTLEMENT_NOT_DRAFT", "Only draft settlements can be approved");
      await this.audit.record(actor, { action: "settlement.approve", entityType: "settlement", entityId: id, data: { number: settlement.number } }, meta, tx);
      return settlement.merchantId;
    });
    this.publish(id, merchantId);
    return this.detail(actor, id);
  }

  async pay(actor: UserActor, id: string, input: z.infer<typeof paySettlementSchema>, meta: RequestMeta) {
    const { outboxIds, webhookIds, merchantId } = await this.prisma.$transaction(
      async tx => {
        const settlement = await tx.merchantSettlement.findUnique({
          where: { id },
          include: { merchant: true, _count: { select: { collections: true } }, collections: { include: { parcel: { select: { trackingId: true, codFee: true, totalCharge: true } } } } },
        });
        if (!settlement) throw notFound("Settlement");
        if (settlement.status !== "APPROVED") throw conflict("SETTLEMENT_NOT_APPROVED", "Only approved settlements can be paid");
        const paysMoney = settlement.netPayable.gt(0);
        if (paysMoney && !input.reference) throw new AppError("REFERENCE_REQUIRED", "Enter the bank / bKash transaction reference", HttpStatus.UNPROCESSABLE_ENTITY);
        const reference = input.reference ?? `NO-PAYOUT-${settlement.number}`;
        // KYC policy (super admin): COD payouts may need verified business documents.
        if (paysMoney) await assertKycAllowed(tx, settlement.merchant, "codPayouts");

        // The payment receipt photo (optional): sent from a phone by the payer, or attached on the computer.
        let paymentProofFileId: string | null = null;
        if (input.proofFileId) {
          const file = await tx.storedFile.findUnique({ where: { id: input.proofFileId }, select: { id: true, uploadedById: true } });
          if (!file || file.uploadedById !== actor.userId) throw new AppError("PROOF_NOT_FOUND", "The receipt photo wasn't found. Take it again.", HttpStatus.UNPROCESSABLE_ENTITY);
          paymentProofFileId = file.id;
        } else if (input.proofImage) {
          paymentProofFileId = (await this.storage.saveDataUrl(input.proofImage, `receipt-${settlement.number}`, actor.userId, tx)).id;
        }
        const paidAt = new Date();
        const updated = await tx.merchantSettlement.updateMany({ where: { id, status: "APPROVED" }, data: { status: "PAID", paidAt, reference, paidById: actor.userId, paymentProofFileId } });
        if (updated.count !== 1) throw conflict("SETTLEMENT_NOT_APPROVED", "Only approved settlements can be paid");
        const settled = await tx.codCollection.updateMany({ where: { settlementId: id, state: "AT_HUB" }, data: { state: "SETTLED" } });
        if (settled.count !== settlement._count.collections) throw conflict("SETTLEMENT_CONFLICT", "This settlement's collections changed; review it before paying");

        if (settlement.carriedForward.gt(0)) {
          await tx.merchantAdjustment.create({
            data: {
              merchantId: settlement.merchantId,
              kind: "CARRY_FORWARD",
              amount: settlement.carriedForward,
              description: `Shortfall carried forward from settlement ${settlement.number} (charges and adjustments exceeded COD)`,
              reference: settlement.number,
              sourceSettlementId: settlement.id,
              createdById: actor.userId,
            },
          });
        }
        await this.postLedger(tx, settlement, input.via ?? payoutVia(settlement.merchant.payoutAccount), reference, paidAt, actor.userId);

        await this.audit.record(
          actor,
          {
            action: "settlement.pay",
            entityType: "settlement",
            entityId: id,
            data: { number: settlement.number, reference, netPayable: settlement.netPayable.toFixed(2), carriedForward: settlement.carriedForward.toFixed(2) },
          },
          meta,
          tx,
        );
        const webhookIds = await this.settlementWebhooks.emit(tx, settlement.merchantId, "cod.settled", {
          settlementId: id,
          number: settlement.number,
          netPayable: Number(settlement.netPayable),
          carriedForward: Number(settlement.carriedForward),
          reference,
          paidAt: paidAt.toISOString(),
        });
        const outboxIds = paysMoney
          ? await this.notify.notify(tx, {
              event: "finance.settlement_paid",
              to: { phone: settlement.merchant.contactPhone, email: settlement.merchant.contactEmail ?? null, name: settlement.merchant.contactName },
              vars: { number: settlement.number, amount: money(settlement.netPayable).toLocaleString("en-BD", { minimumFractionDigits: 2 }), reference },
            })
          : [];
        return { outboxIds, webhookIds, merchantId: settlement.merchantId };
      },
      { timeout: 15_000 },
    );
    await this.outbox.flush(outboxIds);
    await this.settlementWebhooks.flush(webhookIds);
    this.publish(id, merchantId);
    return this.detail(actor, id);
  }

  /**
   * One entry for the whole payout: COD liability discharged, charges recognised as revenue
   * (delivery vs COD fee, VAT separated), adjustments cleared, shortfall booked as a receivable,
   * and the net paid out of the bank / bKash account.
   */
  private async postLedger(
    tx: Db,
    s: Prisma.MerchantSettlementGetPayload<{ include: { collections: { include: { parcel: { select: { trackingId: true; codFee: true; totalCharge: true } } } } } }>,
    via: LedgerVia,
    reference: string,
    paidAt: Date,
    userId: string,
  ) {
    const { vatRate } = await readFinanceConfig(tx);
    const m = { merchantId: s.merchantId };
    const codFees = sum(s.collections.map(c => Prisma.Decimal.min(c.parcel.codFee, c.parcel.totalCharge)));
    const delivery = s.chargesTotal.minus(codFees);
    const dv = vatSplit(delivery, vatRate);
    const fv = vatSplit(codFees, vatRate);
    const adjustments = await tx.merchantAdjustment.findMany({ where: { settlementId: s.id } });
    const owedByMerchant = sum(adjustments.filter(a => a.amount.gt(0)).map(a => a.amount));
    const owedToMerchant = sum(adjustments.filter(a => a.amount.lt(0)).map(a => a.amount.negated()));
    const payout = via === "MERCHANT_BALANCE" || via === "CASH" ? "BANK" : via;
    await this.ledger.post(tx, {
      eventType: "MERCHANT_SETTLEMENT_PAID",
      reference: s.number,
      memo: `Settlement ${s.number} paid (${reference})`,
      occurredAt: paidAt,
      merchantId: s.merchantId,
      idempotencyKey: `MERCHANT_SETTLEMENT_PAID:${s.number}`,
      createdById: userId,
      lines: [
        debit("MERCHANT_PAYABLES", s.codTotal.plus(owedToMerchant), { ...m, memo: "COD collected and credits applied" }),
        credit("DELIVERY_REVENUE", dv.taxable, { memo: "Delivery charges" }),
        credit("COD_FEE_REVENUE", fv.taxable, { memo: "COD fees" }),
        credit("VAT_PAYABLE", dv.vat.plus(fv.vat), { memo: `VAT ${vatRate}% on charges` }),
        credit("MERCHANT_RECEIVABLES", owedByMerchant, { ...m, memo: "Open adjustments deducted" }),
        debit("MERCHANT_RECEIVABLES", s.carriedForward, { ...m, memo: "Shortfall carried forward" }),
        credit(payout, s.netPayable, { memo: reference }),
      ],
    });
  }

  /** Discards a draft and releases its collections and adjustments for the next run. */
  async remove(actor: UserActor, id: string, meta: RequestMeta) {
    const merchantId = await this.prisma.$transaction(async tx => {
      const settlement = await tx.merchantSettlement.findUnique({ where: { id } });
      if (!settlement) throw notFound("Settlement");
      if (settlement.status !== "DRAFT") throw conflict("SETTLEMENT_NOT_DRAFT", "Only draft settlements can be deleted");
      const released = await tx.codCollection.updateMany({ where: { settlementId: id }, data: { settlementId: null } });
      await tx.merchantAdjustment.updateMany({ where: { settlementId: id }, data: { settlementId: null } });
      // Guard: fails (and rolls back the release) if it was approved meanwhile.
      const deleted = await tx.merchantSettlement.deleteMany({ where: { id, status: "DRAFT" } });
      if (deleted.count !== 1) throw conflict("SETTLEMENT_NOT_DRAFT", "Only draft settlements can be deleted");
      await this.audit.record(
        actor,
        { action: "settlement.delete", entityType: "settlement", entityId: id, data: { number: settlement.number, merchantId: settlement.merchantId, released: released.count } },
        meta,
        tx,
      );
      return settlement.merchantId;
    });
    this.publish(id, merchantId);
  }

  async list(actor: Actor, query: z.infer<typeof listSettlementsQuerySchema>) {
    const rows = await this.prisma.merchantSettlement.findMany({
      where: {
        AND: [
          this.scope(actor),
          {
            merchantId: query.merchantId,
            status: query.status,
            createdAt: query.from || query.to ? { gte: query.from, lt: query.to } : undefined,
          },
        ],
      },
      include: settlementInclude,
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { ...page, items: page.items.map(s => this.view(s)) };
  }

  async detail(actor: Actor, id: string) {
    const s = await this.prisma.merchantSettlement.findFirst({
      where: { AND: [{ id }, this.scope(actor)] },
      include: {
        ...settlementInclude,
        merchant: { select: { id: true, code: true, name: true, payoutAccount: true } },
        collections: {
          include: { parcel: { select: { trackingId: true, totalCharge: true, codFee: true, deliveredAt: true } } },
          orderBy: { collectedAt: "asc" },
        },
        adjustments: { orderBy: { createdAt: "asc" } },
      },
    });
    if (!s) throw notFound("Settlement");
    const makerId = await this.makerId(this.prisma, s);
    const people = await this.prisma.user.findMany({ where: { id: { in: [makerId, s.approvedById, s.paidById].filter((x): x is string => !!x) } }, select: { id: true, name: true } });
    const person = (uid: string | null) => (uid ? (people.find(p => p.id === uid) ?? null) : null);
    const { vatRate } = await readFinanceConfig(this.prisma);
    return {
      ...this.view(s),
      payoutAccount: s.merchant.payoutAccount,
      createdBy: person(makerId),
      approvedBy: person(s.approvedById),
      paidBy: person(s.paidById),
      vat: { rate: vatRate, onCharges: money(vatSplit(s.chargesTotal, vatRate).vat) },
      adjustments: s.adjustments.map(a => ({ id: a.id, kind: a.kind, amount: money(a.amount), description: a.description, reference: a.reference, createdAt: a.createdAt })),
      lines: s.collections.map(c => ({
        collectionId: c.id,
        trackingId: c.parcel.trackingId,
        codAmount: money(c.amount),
        charge: money(c.parcel.totalCharge),
        net: money(c.amount.minus(c.parcel.totalCharge)),
        deliveredAt: c.parcel.deliveredAt,
        state: c.state,
      })),
    };
  }

  /** Staff-wide money position (now) and what moved in the period (default this month). */
  async summary(query: PeriodQuery = {}) {
    const p = resolvePeriod(query, "this_month");
    const range = { gte: p.start, lt: p.end };
    const [collected, received, paid, invoiced, invoicesPaid, charges] = await Promise.all([
      this.prisma.codCollection.aggregate({ where: { collectedAt: range }, _sum: { amount: true }, _count: { _all: true } }),
      this.prisma.cashHandover.aggregate({ where: { createdAt: range }, _sum: { amount: true }, _count: { _all: true } }),
      this.prisma.merchantSettlement.aggregate({ where: { status: "PAID", paidAt: range }, _sum: { netPayable: true }, _count: { _all: true } }),
      this.prisma.invoice.aggregate({ where: { status: { in: ["ISSUED", "PAID"] }, issuedAt: range }, _sum: { subtotal: true }, _count: { _all: true } }),
      this.prisma.invoice.aggregate({ where: { status: "PAID", paidAt: range }, _sum: { subtotal: true }, _count: { _all: true } }),
      this.prisma.parcel.aggregate({ where: { status: "DELIVERED", deliveredAt: range }, _sum: { totalCharge: true }, _count: { _all: true } }),
    ]);
    const now = await this.summaryNow();
    return {
      ...now,
      period: {
        ...periodView(p),
        codCollected: money(collected._sum.amount),
        codCollections: collected._count._all,
        cashReceivedAtHubs: money(received._sum.amount),
        handovers: received._count._all,
        settledPaid: money(paid._sum.netPayable),
        settlementsPaid: paid._count._all,
        invoiced: money(invoiced._sum.subtotal),
        invoicesIssued: invoiced._count._all,
        invoicesPaid: money(invoicesPaid._sum.subtotal),
        deliveryCharges: money(charges._sum.totalCharge),
        delivered: charges._count._all,
      },
    };
  }

  private async summaryNow() {
    const [withRiders, atHubs, settled, pending, approved, outstanding, carried] = await Promise.all([
      this.prisma.codCollection.aggregate({ where: { state: "WITH_RIDER" }, _sum: { amount: true } }),
      this.prisma.codCollection.aggregate({ where: { state: "AT_HUB" }, _sum: { amount: true } }),
      this.prisma.merchantSettlement.aggregate({ where: { status: "PAID", paidAt: { gte: dhakaMonthStart() } }, _sum: { netPayable: true } }),
      this.prisma.merchantSettlement.aggregate({ where: { status: "DRAFT" }, _sum: { netPayable: true } }),
      this.prisma.merchantSettlement.aggregate({ where: { status: "APPROVED" }, _sum: { netPayable: true } }),
      this.prisma.invoice.aggregate({ where: { status: "ISSUED" }, _sum: { subtotal: true } }),
      this.prisma.merchantAdjustment.aggregate({ where: { settlementId: null, invoiceId: null, amount: { gt: 0 } }, _sum: { amount: true } }),
    ]);
    return {
      codWithRiders: money(withRiders._sum.amount),
      codAtHubs: money(atHubs._sum.amount),
      settledThisMonth: money(settled._sum.netPayable),
      payablePendingApproval: money(pending._sum.netPayable),
      payableAwaitingPayment: money(approved._sum.netPayable),
      invoicesOutstanding: money(outstanding._sum.subtotal),
      merchantReceivablesOpen: money(carried._sum.amount),
    };
  }

  /** The maker: the createdById column; settlements drafted before it existed fall back to their audit entry. */
  private async makerId(db: Db, s: { id: string; createdById: string | null; autoDrafted: boolean }) {
    if (s.createdById || s.autoDrafted) return s.createdById;
    const entry = await db.auditLog.findFirst({
      where: { action: "settlement.create", entityType: "settlement", entityId: s.id, actorType: "USER" },
      orderBy: { createdAt: "asc" },
    });
    return entry?.actorId ?? null;
  }

  private publish(id: string, merchantId: string) {
    this.realtime.publish({ type: "settlement.updated", id, merchantId, staffPermission: "finance:read" });
  }

  private scope(actor: Actor): Prisma.MerchantSettlementWhereInput {
    const merchants = financeMerchantScope(actor);
    return merchants ? { merchantId: { in: merchants } } : {};
  }

  private view(s: SettlementRow) {
    return {
      id: s.id,
      number: s.number,
      merchant: { id: s.merchant.id, code: s.merchant.code, name: s.merchant.name },
      status: s.status,
      codTotal: money(s.codTotal),
      chargesTotal: money(s.chargesTotal),
      adjustmentsTotal: money(s.adjustmentsTotal),
      netPayable: money(s.netPayable),
      carriedForward: money(s.carriedForward),
      collectionCount: s._count.collections,
      adjustmentCount: s._count.adjustments,
      autoDrafted: s.autoDrafted,
      createdById: s.createdById,
      approvedById: s.approvedById,
      paidById: s.paidById,
      paidAt: s.paidAt,
      reference: s.reference,
      /** A photo of the payment receipt was attached (GET /settlements/:id/payment-proof). */
      paymentProof: !!s.paymentProofFileId,
      createdAt: s.createdAt,
    };
  }

  /** The payment receipt photo: finance staff, and the merchant it was paid to. */
  async paymentProof(actor: Actor, id: string) {
    const s = await this.prisma.merchantSettlement.findFirst({ where: { AND: [{ id }, this.scope(actor)] }, include: { paymentProof: true } });
    if (!s?.paymentProof) throw notFound("Payment receipt");
    return { file: s.paymentProof, data: await this.storage.read(s.paymentProof.storageKey) };
  }
}
