import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { nextNumber } from "../../common/counters";
import { AppError, conflict, notFound } from "../../common/errors";
import { pageArgs, toPage } from "../../common/pagination";
import type { Actor, UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { Prisma, type Invoice, type InvoiceStatus } from "../../generated/prisma/client";
import type { Db } from "../../common/prisma.service";
import type { createInvoiceSchema, listInvoicesQuerySchema, markInvoicePaidSchema, voidInvoiceSchema } from "./finance.schemas";
import { financeMerchantScope, money, sum } from "./finance.scope";
import { lockMerchant } from "./settlements.service";
import { WebhooksService } from "../notifications/webhooks.service";
import { NotifyService } from "../notifications/notify.service";
import { OutboxService } from "../notifications/outbox.service";
import { RealtimeService } from "../../common/realtime.service";
import { LedgerService } from "./ledger.service";
import { readFinanceConfig, vatSplit } from "./finance-config";
import { env } from "../../config/env";
import { returnTrackingId, syncReturnCharges } from "./return-charges";
import { addressText } from "../../common/address";

const SERVICE_LABEL: Record<string, string> = { REGULAR: "Regular", SAME_DAY: "Same day", EXPRESS: "Express" };

type InvoiceRow = Invoice & { merchant: { id: string; code: string; name: string } };

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** invoice.issued webhooks (property injection keeps the constructor stable for parallel edits). */
  @Inject(WebhooksService) private readonly invoiceWebhooks!: WebhooksService;
  @Inject(LedgerService) private readonly ledger!: LedgerService;
  @Inject(NotifyService) private readonly notify!: NotifyService;
  @Inject(OutboxService) private readonly outbox!: OutboxService;
  @Inject(RealtimeService) private readonly realtime!: RealtimeService;

  /**
   * Bills delivery charges for parcels delivered in [periodStart, periodEnd). Parcels with a
   * COD collection are left out: their charge is deducted from the merchant's COD settlement.
   * Also bills return (RTO) charges booked before periodEnd that no settlement or invoice has
   * billed yet, one line each with VAT (see return-charges.ts).
   */
  async create(actor: UserActor, input: z.infer<typeof createInvoiceSchema>, meta: RequestMeta) {
    if (input.periodEnd.getTime() > Date.now()) throw new AppError("PERIOD_NOT_ENDED", "Invoice periods must have ended", HttpStatus.UNPROCESSABLE_ENTITY);
    const webhookIds: string[] = [];
    const outboxIds: string[] = [];
    const id = await this.prisma.$transaction(
      async tx => {
        await lockMerchant(tx, input.merchantId);
        const merchant = await tx.merchant.findUniqueOrThrow({ where: { id: input.merchantId }, select: { contactName: true, contactPhone: true, contactEmail: true, type: true } });
        const cfg = await readFinanceConfig(tx);
        const overlap = await tx.invoice.findFirst({
          where: { merchantId: input.merchantId, status: { in: ["ISSUED", "PAID"] }, periodStart: { lt: input.periodEnd }, periodEnd: { gt: input.periodStart } },
        });
        if (overlap) throw new AppError("INVOICE_PERIOD_OVERLAP", `Invoice ${overlap.number} already covers part of this period`, HttpStatus.CONFLICT, { invoiceId: overlap.id, number: overlap.number });

        const parcels = await tx.parcel.findMany({
          where: { merchantId: input.merchantId, status: "DELIVERED", deliveredAt: { gte: input.periodStart, lt: input.periodEnd }, codCollection: { is: null } },
          select: { trackingId: true, totalCharge: true, serviceLevel: true, deliveryZone: true, deliveryDistrict: true },
          orderBy: { deliveredAt: "asc" },
        });
        // Return (RTO) charges booked before the period end and not yet billed by a settlement or invoice.
        await syncReturnCharges(tx, input.merchantId);
        const returns = await tx.merchantAdjustment.findMany({
          where: { merchantId: input.merchantId, kind: "RETURN_CHARGE", settlementId: null, invoiceId: null, createdAt: { lt: input.periodEnd } },
          orderBy: { createdAt: "asc" },
        });
        if (!parcels.length && !returns.length) throw new AppError("NOTHING_TO_INVOICE", "No billable deliveries in this period", HttpStatus.UNPROCESSABLE_ENTITY);

        const issuedAt = new Date();
        const deliverySubtotal = sum(parcels.map(p => p.totalCharge));
        const subtotal = deliverySubtotal.plus(sum(returns.map(r => r.amount)));
        // VAT (NBR): prices are VAT-inclusive; each line shows its taxable value and VAT.
        const lines = parcels.map(p => {
          const { taxable, vat } = vatSplit(p.totalCharge, cfg.vatRate);
          return {
            trackingId: p.trackingId,
            description: `${SERVICE_LABEL[p.serviceLevel] ?? p.serviceLevel} delivery to ${p.deliveryZone}, ${p.deliveryDistrict}`,
            amount: money(p.totalCharge),
            taxableValue: money(taxable),
            vat: money(vat),
          };
        });
        const deliveryVat = sum(lines.map(l => new Prisma.Decimal(l.vat)));
        for (const r of returns) {
          const { taxable, vat } = vatSplit(r.amount, cfg.vatRate);
          lines.push({ trackingId: returnTrackingId(r.reference), description: "Return (RTO) charge", amount: money(r.amount), taxableValue: money(taxable), vat: money(vat), kind: "RETURN" } as (typeof lines)[number]);
        }
        const vatAmount = sum(lines.map(l => new Prisma.Decimal(l.vat)));
        const invoice = await tx.invoice.create({
          data: {
            number: await nextNumber(tx, "INV", "month"),
            merchantId: input.merchantId,
            periodStart: input.periodStart,
            periodEnd: input.periodEnd,
            subtotal,
            vatRate: cfg.vatRate,
            vatAmount,
            total: subtotal,
            seller: cfg.seller,
            createdById: actor.userId,
            lines,
            issuedAt,
            dueAt: new Date(issuedAt.getTime() + cfg.invoiceTermDays * 86_400_000),
          },
        });
        await this.audit.record(
          actor,
          {
            action: "invoice.create",
            entityType: "invoice",
            entityId: invoice.id,
            data: { number: invoice.number, merchantId: input.merchantId, lines: parcels.length, returnCharges: returns.length, subtotal: subtotal.toFixed(2), vat: vatAmount.toFixed(2), periodStart: input.periodStart.toISOString(), periodEnd: input.periodEnd.toISOString() },
          },
          meta,
          tx,
        );
        if (returns.length) {
          const linked = await tx.merchantAdjustment.updateMany({ where: { id: { in: returns.map(r => r.id) }, settlementId: null, invoiceId: null }, data: { invoiceId: invoice.id } });
          if (linked.count !== returns.length) throw conflict("INVOICE_CONFLICT", "Return charges changed while invoicing; try again");
        }
        // Return charges are already receivables (booked when the return completed); only deliveries become revenue here.
        await this.ledger.record(tx, {
          type: "INVOICE_ISSUED",
          amount: deliverySubtotal,
          vat: deliveryVat,
          reference: invoice.number,
          merchantId: input.merchantId,
          occurredAt: issuedAt,
          memo: `Invoice ${invoice.number}`,
          createdById: actor.userId,
        });
        outboxIds.push(
          ...(await this.notify.notify(tx, {
            event: "finance.invoice_issued",
            to: { phone: merchant.contactPhone, email: merchant.contactEmail, name: merchant.contactName },
            vars: {
              number: invoice.number,
              amount: money(subtotal).toLocaleString("en-BD", { minimumFractionDigits: 2 }),
              dueDate: invoice.dueAt.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Dhaka" }),
              link: `${env().APP_URL}/${merchant.type === "BANKING_FINANCIAL" ? "banking-merchant" : "ecommerce-merchant"}`,
            },
          })),
        );
        webhookIds.push(
          ...(await this.invoiceWebhooks.emit(tx, input.merchantId, "invoice.issued", {
            invoiceId: invoice.id,
            number: invoice.number,
            subtotal: Number(subtotal),
            issuedAt: issuedAt.toISOString(),
            dueAt: invoice.dueAt.toISOString(),
          })),
        );
        return invoice.id;
      },
      { timeout: 15_000 },
    );
    await this.invoiceWebhooks.flush(webhookIds);
    await this.outbox.flush(outboxIds);
    return this.detail(actor, id);
  }

  /** ISSUED → PAID with the payment reference and who recorded it; posts INVOICE_PAID. */
  markPaid(actor: UserActor, id: string, input: z.infer<typeof markInvoicePaidSchema>, meta: RequestMeta) {
    const paidAt = new Date();
    return this.transition(actor, id, "PAID", { paidAt, paymentReference: input.reference ?? null, paidById: actor.userId }, "invoice.mark_paid", { reference: input.reference ?? null, via: input.via }, meta, async (tx, invoice) => {
      await this.ledger.record(tx, {
        type: "INVOICE_PAID",
        amount: invoice.total.isZero() ? invoice.subtotal : invoice.total,
        reference: invoice.number,
        merchantId: invoice.merchantId,
        occurredAt: paidAt,
        via: input.via,
        memo: input.reference ? `Payment ${input.reference}` : undefined,
        createdById: actor.userId,
      });
    });
  }

  /** ISSUED → VOID; reverses the invoice in the ledger. */
  void(actor: UserActor, id: string, input: z.infer<typeof voidInvoiceSchema>, meta: RequestMeta) {
    return this.transition(actor, id, "VOID", {}, "invoice.void", { reason: input.reason }, meta, async (tx, invoice) => {
      // Return charges go back to the open pool (they stay receivables); the delivery part is reversed.
      await tx.merchantAdjustment.updateMany({ where: { invoiceId: invoice.id }, data: { invoiceId: null } });
      const issued = await tx.journalEntry.findUnique({ where: { idempotencyKey: `INVOICE_ISSUED:${invoice.number}` }, include: { lines: { include: { account: { select: { systemKey: true } } } } } });
      if (!issued) return; // issued before the ledger existed (or returns only): nothing to reverse
      const gross = issued.lines.filter(l => l.account.systemKey === "MERCHANT_RECEIVABLES").reduce((a, l) => a.plus(l.debit), new Prisma.Decimal(0));
      const vat = issued.lines.filter(l => l.account.systemKey === "VAT_PAYABLE").reduce((a, l) => a.plus(l.credit), new Prisma.Decimal(0));
      await this.ledger.post(tx, {
        eventType: "ADJUSTMENT",
        reference: invoice.number,
        memo: `Invoice ${invoice.number} voided: ${input.reason}`,
        merchantId: invoice.merchantId,
        idempotencyKey: `INVOICE_VOIDED:${invoice.number}`,
        createdById: actor.userId,
        lines: [
          { account: "DELIVERY_REVENUE", amount: gross.minus(vat) },
          { account: "VAT_PAYABLE", amount: vat },
          { account: "MERCHANT_RECEIVABLES", amount: gross.negated(), merchantId: invoice.merchantId },
        ],
      });
    });
  }

  async list(actor: Actor, query: z.infer<typeof listInvoicesQuerySchema>) {
    const rows = await this.prisma.invoice.findMany({
      where: { AND: [this.scope(actor), { merchantId: query.merchantId, status: query.status }] },
      include: { merchant: { select: { id: true, code: true, name: true } } },
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { ...page, items: page.items.map(i => this.view(i)) };
  }

  /** Includes what a Mushak-6.3-style tax invoice prints: seller (name, BIN, address), buyer, lines with VAT. */
  async detail(actor: Actor, id: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { AND: [{ id }, this.scope(actor)] },
      include: { merchant: { select: { id: true, code: true, name: true, pickupAddress: true, pickupArea: true, pickupDistrict: true, contactPhone: true } } },
    });
    if (!invoice) throw notFound("Invoice");
    const people = await this.prisma.user.findMany({ where: { id: { in: [invoice.createdById, invoice.paidById].filter((x): x is string => !!x) } }, select: { id: true, name: true } });
    const person = (uid: string | null) => (uid ? (people.find(p => p.id === uid) ?? null) : null);
    const m = invoice.merchant;
    return {
      ...this.view(invoice),
      lines: invoice.lines,
      seller: invoice.seller ?? (await readFinanceConfig(this.prisma)).seller,
      buyer: { name: m.name, code: m.code, address: addressText(m.pickupAddress, m.pickupArea, m.pickupDistrict), phone: m.contactPhone },
      createdBy: person(invoice.createdById),
      paidBy: person(invoice.paidById),
    };
  }

  /** Only ISSUED invoices move (to PAID or VOID); the guard makes concurrent changes lose cleanly. */
  private async transition(
    actor: UserActor,
    id: string,
    to: InvoiceStatus,
    data: Prisma.InvoiceUpdateManyMutationInput,
    action: string,
    auditData: Record<string, string | null>,
    meta: RequestMeta,
    effect?: (tx: Db, invoice: Invoice) => Promise<void>,
  ) {
    const merchantId = await this.prisma.$transaction(async tx => {
      const invoice = await tx.invoice.findUnique({ where: { id } });
      if (!invoice) throw notFound("Invoice");
      const updated = await tx.invoice.updateMany({ where: { id, status: "ISSUED" }, data: { ...data, status: to } });
      if (updated.count !== 1) throw conflict("INVALID_INVOICE_TRANSITION", `A ${invoice.status.toLowerCase()} invoice can't be marked ${to.toLowerCase()}`);
      await effect?.(tx, invoice);
      await this.audit.record(actor, { action, entityType: "invoice", entityId: id, data: { number: invoice.number, ...auditData } }, meta, tx);
      return invoice.merchantId;
    });
    this.realtime.publish({ type: "invoice.updated", id, merchantId, staffPermission: "finance:read" });
    return this.detail(actor, id);
  }

  private scope(actor: Actor): Prisma.InvoiceWhereInput {
    const merchants = financeMerchantScope(actor);
    return merchants ? { merchantId: { in: merchants } } : {};
  }

  private view(i: InvoiceRow) {
    const overdue = i.status === "ISSUED" && i.dueAt.getTime() < Date.now();
    const total = i.total.isZero() ? i.subtotal : i.total;
    return {
      id: i.id,
      number: i.number,
      merchant: { id: i.merchant.id, code: i.merchant.code, name: i.merchant.name },
      status: i.status,
      overdue,
      periodStart: i.periodStart,
      periodEnd: i.periodEnd,
      subtotal: money(i.subtotal),
      vatRate: Number(i.vatRate),
      vatAmount: money(i.vatAmount),
      taxableValue: money(total.minus(i.vatAmount)),
      total: money(total),
      lineCount: Array.isArray(i.lines) ? i.lines.length : 0,
      issuedAt: i.issuedAt,
      dueAt: i.dueAt,
      paidAt: i.paidAt,
      paymentReference: i.paymentReference,
      createdById: i.createdById,
      paidById: i.paidById,
    };
  }
}
