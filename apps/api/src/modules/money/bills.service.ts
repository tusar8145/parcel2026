import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { PrismaService, type Db } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { StorageService } from "../../common/storage.service";
import { AppError, conflict, forbidden, notFound } from "../../common/errors";
import { nextNumber } from "../../common/counters";
import type { Actor, UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { Prisma, type AccountPayment, type Bill } from "../../generated/prisma/client";
import { InboxService } from "../notifications/inbox.service";
import { NotifyService } from "../notifications/notify.service";
import { OutboxService } from "../notifications/outbox.service";
import { readFinanceConfig } from "../finance/finance-config";
import { env } from "../../config/env";
import { money, sum, ZERO } from "../finance/finance.scope";
import type { createBillSchema, listBillsQuerySchema, listPaymentsQuerySchema, paymentSchema, rejectPaymentSchema, voidBillSchema } from "./money.schemas";
import { assertMoneyStaff, isMoneyStaff, ownAccountIds } from "./access";
import { AccountsService, dhakaDay } from "./accounts.service";
import { lockAccount } from "./payouts.service";

const taka = (d: Prisma.Decimal | number) => `৳${Number(d).toLocaleString("en-BD", { maximumFractionDigits: 2 })}`;

/**
 * Financial merchants: bills (INV-) of chosen parcels' charges, issued at once (void to correct), and payments
 * (PAY-), full or partial. Confirmed payments pay bills oldest first (or a chosen bill first); what's left is
 * advance credit, used by the next bill. A merchant's own "I've paid" waits as PENDING until staff confirm it.
 */
@Injectable()
export class BillsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly storage: StorageService,
  ) {}

  @Inject(InboxService) private readonly inbox!: InboxService;
  @Inject(NotifyService) private readonly notify!: NotifyService;
  @Inject(OutboxService) private readonly outbox!: OutboxService;

  // ───────────── bills ─────────────

  async create(actor: UserActor, accountId: string, input: z.infer<typeof createBillSchema>, meta: RequestMeta) {
    await assertMoneyStaff(this.prisma, actor);
    const account = await this.accounts.readable(actor, accountId);
    if (account.kind !== "FINANCIAL") throw new AppError("NOT_A_FINANCIAL_ACCOUNT", "Only Financial merchants are billed; E-commerce merchants and customers are settled", HttpStatus.UNPROCESSABLE_ENTITY);
    if (input.to < input.from) throw new AppError("VALIDATION_FAILED", "The end date can't be before the start", HttpStatus.UNPROCESSABLE_ENTITY);
    const outboxIds: string[] = [];
    const id = await this.prisma.$transaction(
      async tx => {
        await lockAccount(tx, accountId);
        const chosen = new Set(input.parcelIds);
        const parcelLines = await tx.accountEntry.findMany({ where: { accountId, billId: null, parcelId: { in: [...chosen] }, type: { in: ["DELIVERY_CHARGE", "RETURN_CHARGE"] } } });
        const found = new Set(parcelLines.map(l => l.parcelId!));
        const missing = [...chosen].filter(p => !found.has(p));
        if (missing.length) {
          const tracking = (await tx.parcel.findMany({ where: { id: { in: missing } }, select: { trackingId: true } })).map(p => p.trackingId);
          throw new AppError("PARCELS_NOT_BILLABLE", `${tracking.slice(0, 5).join(", ") || "Some parcels"} can't be billed: already on a bill or not this merchant's. Refresh and try again.`, HttpStatus.CONFLICT, { trackingIds: tracking });
        }
        // Open adjustments always go on the next bill.
        const adjustments = await tx.accountEntry.findMany({ where: { accountId, billId: null, type: "ADJUSTMENT" } });
        const lines = [...parcelLines, ...adjustments];
        const total = sum(lines.map(l => l.amount)).negated();
        if (!total.gt(0)) throw new AppError("BILL_NOT_POSITIVE", `The bill total would be ${taka(total)}; there's nothing to bill.`, HttpStatus.UNPROCESSABLE_ENTITY);
        const bill = await tx.bill.create({
          data: { number: await nextNumber(tx, "INV", "month"), accountId, periodFrom: dhakaDay(input.from), periodTo: dhakaDay(input.to, true), total, createdById: actor.userId },
        });
        const linked = await tx.accountEntry.updateMany({ where: { id: { in: lines.map(l => l.id) }, billId: null }, data: { billId: bill.id } });
        if (linked.count !== lines.length) throw conflict("ACCOUNT_CHANGED", "The account changed meanwhile; try again");
        await this.allocate(tx, accountId);
        await this.audit.record(actor, { action: "bill.create", entityType: "bill", entityId: bill.id, data: { number: bill.number, accountId, parcels: chosen.size, adjustments: adjustments.length, total: total.toFixed(2) } }, meta, tx);
        if (account.merchantId) {
          await this.inbox.toMerchant(tx, account.merchantId, { type: "account.bill", title: `Bill ${bill.number} issued`, body: `${taka(total)} for ${chosen.size} parcel${chosen.size === 1 ? "" : "s"}.`, target: { page: "balance" } }, { ownersOnly: true });
          // SMS / email (finance.invoice_issued) to the merchant's contact; "due" = the finance settings' payment term.
          const m = await tx.merchant.findUnique({ where: { id: account.merchantId }, select: { contactName: true, contactPhone: true, contactEmail: true } });
          const due = new Date(bill.issuedAt.getTime() + (await readFinanceConfig(tx)).invoiceTermDays * 86_400_000);
          if (m)
            outboxIds.push(
              ...(await this.notify.notify(tx, {
                event: "finance.invoice_issued",
                to: { phone: m.contactPhone, email: m.contactEmail, name: m.contactName },
                vars: { number: bill.number, amount: Number(total).toLocaleString("en-BD", { minimumFractionDigits: 2 }), dueDate: due.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Dhaka" }), link: `${env().APP_URL}/banking-merchant?page=balance` },
              })),
            );
        }
        return bill.id;
      },
      { timeout: 20_000 },
    );
    await this.outbox.flush(outboxIds);
    this.accounts.published(account);
    return this.bill(actor, id);
  }

  /** A wrong bill is voided: its parcels are not billed again, payments on it go back to credit (then to other bills). */
  async void(actor: UserActor, id: string, input: z.infer<typeof voidBillSchema>, meta: RequestMeta) {
    await assertMoneyStaff(this.prisma, actor);
    const b = await this.prisma.bill.findUnique({ where: { id }, include: { account: true } });
    if (!b) throw notFound("Bill");
    await this.prisma.$transaction(async tx => {
      await lockAccount(tx, b.accountId);
      const moved = await tx.bill.updateMany({ where: { id, status: { not: "VOID" } }, data: { status: "VOID", paid: 0, voidedAt: new Date(), voidedById: actor.userId, voidReason: input.reason } });
      if (!moved.count) throw conflict("BILL_VOID", `${b.number} is already void`);
      await tx.accountEntry.updateMany({ where: { billId: id }, data: { billId: null } });
      await tx.billAllocation.deleteMany({ where: { billId: id } });
      await this.allocate(tx, b.accountId);
      await this.audit.record(actor, { action: "bill.void", entityType: "bill", entityId: id, data: { number: b.number, reason: input.reason } }, meta, tx);
    });
    this.accounts.published(b.account);
    return this.bill(actor, id);
  }

  async bills(actor: Actor, query: z.infer<typeof listBillsQuerySchema>) {
    const scope = await this.scope(actor, query.accountId);
    const rows = await this.prisma.bill.findMany({
      where: {
        ...scope,
        ...(query.status === "UNPAID" ? { status: { in: ["ISSUED", "PARTLY_PAID"] } } : query.status ? { status: query.status } : {}),
        ...(query.from || query.to ? { issuedAt: { ...(query.from ? { gte: dhakaDay(query.from) } : {}), ...(query.to ? { lt: dhakaDay(query.to, true) } : {}) } } : {}),
      },
      include: { account: { select: { id: true, name: true } }, _count: { select: { entries: { where: { parcelId: { not: null } } } } } },
      orderBy: { issuedAt: "desc" },
      take: 300,
    });
    return { items: rows.map(b => this.billView(b, b._count.entries)) };
  }

  async bill(actor: Actor, id: string) {
    const b = await this.prisma.bill.findUnique({ where: { id }, include: { account: { select: { id: true, name: true } } } });
    if (!b) throw notFound("Bill");
    await this.accounts.readable(actor, b.accountId);
    const [lines, allocations] = await Promise.all([
      this.prisma.accountEntry.findMany({ where: { billId: id }, orderBy: { createdAt: "asc" } }),
      this.prisma.billAllocation.findMany({ where: { billId: id }, include: { payment: true }, orderBy: { createdAt: "asc" } }),
    ]);
    const parcelIds = lines.flatMap(l => (l.parcelId ? [l.parcelId] : []));
    const parcels = new Map(
      (await this.prisma.parcel.findMany({ where: { id: { in: parcelIds } }, select: { id: true, merchantOrderRef: true, recipientName: true, deliveryZone: true, deliveryDistrict: true, deliveredAt: true, status: true } })).map(p => [p.id, p]),
    );
    return {
      ...this.billView(b, new Set(parcelIds).size),
      lines: lines.map(l => {
        const p = l.parcelId ? parcels.get(l.parcelId) : undefined;
        return {
          trackingId: l.trackingId,
          description: l.type === "RETURN_CHARGE" ? "Return charge" : l.type === "ADJUSTMENT" ? `Adjustment: ${l.description}` : "Delivery charge",
          orderRef: p?.merchantOrderRef ?? null,
          recipient: p?.recipientName ?? null,
          destination: p ? [p.deliveryZone, p.deliveryDistrict].filter(Boolean).join(", ") : null,
          date: l.createdAt,
          amount: money(l.amount.negated()),
        };
      }),
      payments: allocations.map(a => ({ number: a.payment.number, method: a.payment.method, reference: a.payment.reference, paidOn: a.payment.paidOn, amount: money(a.amount) })),
    };
  }

  // ───────────── payments ─────────────

  /** Staff record a payment received (confirmed at once); a merchant owner's own "I've paid" waits for confirmation. */
  async pay(actor: UserActor, accountId: string, input: z.infer<typeof paymentSchema>, meta: RequestMeta) {
    const staff = await isMoneyStaff(this.prisma, actor);
    const account = await this.accounts.readable(actor, accountId);
    if (account.kind !== "FINANCIAL") throw new AppError("NOT_A_FINANCIAL_ACCOUNT", "Payments are recorded for Financial merchants", HttpStatus.UNPROCESSABLE_ENTITY);
    if (!staff && !(actor.kind === "user" && account.merchantId && actor.roles.some(r => r.role === "MERCHANT_OWNER" && r.merchantId === account.merchantId)))
      throw forbidden("Only the merchant's owner can submit a payment");
    if (input.billId && !(await this.prisma.bill.count({ where: { id: input.billId, accountId, status: { in: ["ISSUED", "PARTLY_PAID"] } } })))
      throw new AppError("BILL_NOT_OPEN", "That bill isn't open on this account", HttpStatus.UNPROCESSABLE_ENTITY);
    const id = await this.prisma.$transaction(
      async tx => {
        await lockAccount(tx, accountId);
        const proofFileId = input.proof ? (await this.storage.saveDataUrl(input.proof, `payment-${account.name}`, actor.userId, tx)).id : null;
        const payment = await tx.accountPayment.create({
          data: {
            number: await nextNumber(tx, "PAY", "month"),
            accountId,
            amount: new Prisma.Decimal(input.amount),
            method: input.method,
            reference: input.reference ?? null,
            paidOn: dhakaDay(input.paidOn),
            note: input.note ?? (input.billId ? `For bill ${(await tx.bill.findUnique({ where: { id: input.billId }, select: { number: true } }))?.number}` : null),
            proofFileId,
            status: staff ? "CONFIRMED" : "PENDING",
            submittedById: actor.userId,
            ...(staff ? { confirmedById: actor.userId, confirmedAt: new Date() } : {}),
          },
        });
        if (staff) await this.confirmIn(tx, payment, input.billId);
        else
          await this.inbox.toStaff(tx, { roles: ["FINANCE", "OPS_MANAGER", "SUPER_ADMIN"] }, {
            type: "account.payment_submitted",
            title: `${account.name} says they paid ${taka(input.amount)}`,
            body: `${payment.number} · ${input.method}${input.reference ? ` · ${input.reference}` : ""}. Confirm it in Accounts › Financial.`,
            target: { page: "accounts", tab: "financial" },
            panel: "/courier-operation",
          });
        await this.audit.record(actor, { action: staff ? "payment.record" : "payment.submit", entityType: "account_payment", entityId: payment.id, data: { number: payment.number, accountId, amount: input.amount, method: input.method } }, meta, tx);
        return payment.id;
      },
      { timeout: 20_000 },
    );
    this.accounts.published(account);
    return this.payment(actor, id);
  }

  async confirm(actor: UserActor, id: string, meta: RequestMeta) {
    await assertMoneyStaff(this.prisma, actor);
    const p = await this.prisma.accountPayment.findUnique({ where: { id }, include: { account: true } });
    if (!p) throw notFound("Payment");
    await this.prisma.$transaction(async tx => {
      await lockAccount(tx, p.accountId);
      const moved = await tx.accountPayment.updateMany({ where: { id, status: "PENDING" }, data: { status: "CONFIRMED", confirmedById: actor.userId, confirmedAt: new Date() } });
      if (!moved.count) throw conflict("PAYMENT_NOT_PENDING", `${p.number} is already ${p.status.toLowerCase()}`);
      await this.confirmIn(tx, { ...p, status: "CONFIRMED" });
      await this.audit.record(actor, { action: "payment.confirm", entityType: "account_payment", entityId: id, data: { number: p.number } }, meta, tx);
      if (p.account.merchantId)
        await this.inbox.toMerchant(tx, p.account.merchantId, { type: "account.payment_confirmed", title: `Payment ${p.number} confirmed`, body: `${taka(p.amount)} received. Thank you.`, target: { page: "balance" } }, { ownersOnly: true });
    });
    this.accounts.published(p.account);
    return this.payment(actor, id);
  }

  async reject(actor: UserActor, id: string, input: z.infer<typeof rejectPaymentSchema>, meta: RequestMeta) {
    await assertMoneyStaff(this.prisma, actor);
    const p = await this.prisma.accountPayment.findUnique({ where: { id }, include: { account: true } });
    if (!p) throw notFound("Payment");
    await this.prisma.$transaction(async tx => {
      const moved = await tx.accountPayment.updateMany({ where: { id, status: "PENDING" }, data: { status: "REJECTED", rejectReason: input.reason, confirmedById: actor.userId, confirmedAt: new Date() } });
      if (!moved.count) throw conflict("PAYMENT_NOT_PENDING", `${p.number} is already ${p.status.toLowerCase()}`);
      await this.audit.record(actor, { action: "payment.reject", entityType: "account_payment", entityId: id, data: { number: p.number, reason: input.reason } }, meta, tx);
      if (p.account.merchantId)
        await this.inbox.toMerchant(tx, p.account.merchantId, { type: "account.payment_rejected", title: `Payment ${p.number} not confirmed`, body: input.reason, target: { page: "balance" } }, { ownersOnly: true });
    });
    this.accounts.published(p.account);
    return this.payment(actor, id);
  }

  async payments(actor: Actor, query: z.infer<typeof listPaymentsQuerySchema>) {
    const scope = await this.scope(actor, query.accountId);
    const rows = await this.prisma.accountPayment.findMany({
      where: {
        ...scope,
        ...(query.status ? { status: query.status } : {}),
        ...(query.from || query.to ? { paidOn: { ...(query.from ? { gte: dhakaDay(query.from) } : {}), ...(query.to ? { lt: dhakaDay(query.to, true) } : {}) } } : {}),
      },
      include: { account: { select: { id: true, name: true } }, allocations: { include: { bill: { select: { number: true } } } } },
      orderBy: { createdAt: "desc" },
      take: 300,
    });
    return { items: rows.map(p => this.paymentView(p)) };
  }

  async payment(actor: Actor, id: string) {
    const p = await this.prisma.accountPayment.findUnique({ where: { id }, include: { account: { select: { id: true, name: true } }, allocations: { include: { bill: { select: { number: true } } } } } });
    if (!p) throw notFound("Payment");
    await this.accounts.readable(actor, p.accountId);
    return this.paymentView(p);
  }

  // ───────────── internals ─────────────

  /** A confirmed payment: its statement line, then it pays bills. */
  private async confirmIn(tx: Db, p: AccountPayment, preferBillId?: string) {
    await tx.accountEntry.create({
      data: { accountId: p.accountId, type: "PAYMENT", amount: p.amount, reference: p.number, description: `Payment received by ${p.method}${p.reference ? ` · ${p.reference}` : ""}`, createdById: p.confirmedById },
    });
    await this.allocate(tx, p.accountId, preferBillId);
  }

  /** Confirmed payments' unused money pays open bills: the preferred bill first, then the oldest; the rest stays credit. */
  async allocate(tx: Db, accountId: string, preferBillId?: string) {
    const [payments, bills] = await Promise.all([
      tx.accountPayment.findMany({ where: { accountId, status: "CONFIRMED" }, include: { allocations: { where: { bill: { status: { not: "VOID" } } } } }, orderBy: [{ paidOn: "asc" }, { createdAt: "asc" }] }),
      tx.bill.findMany({ where: { accountId, status: { in: ["ISSUED", "PARTLY_PAID"] } }, orderBy: { issuedAt: "asc" } }),
    ]);
    const open = [...bills.filter(b => b.id === preferBillId), ...bills.filter(b => b.id !== preferBillId)].map(b => ({ bill: b, due: b.total.minus(b.paid) }));
    for (const p of payments) {
      let left = p.amount.minus(sum(p.allocations.map(a => a.amount)));
      for (const o of open) {
        if (!left.gt(0)) break;
        if (!o.due.gt(0)) continue;
        const take = Prisma.Decimal.min(left, o.due);
        await tx.billAllocation.upsert({
          where: { paymentId_billId: { paymentId: p.id, billId: o.bill.id } },
          create: { paymentId: p.id, billId: o.bill.id, amount: take },
          update: { amount: { increment: take } },
        });
        o.due = o.due.minus(take);
        left = left.minus(take);
      }
    }
    for (const o of open) {
      const paid = o.bill.total.minus(o.due);
      if (!paid.equals(o.bill.paid)) await tx.bill.update({ where: { id: o.bill.id }, data: { paid, status: o.due.lte(0) ? "PAID" : paid.gt(0) ? "PARTLY_PAID" : "ISSUED" } });
    }
  }

  private async scope(actor: Actor, accountId?: string): Promise<{ accountId?: string | { in: string[] } }> {
    if (await isMoneyStaff(this.prisma, actor)) return accountId ? { accountId } : {};
    const own = actor.kind === "user" ? await ownAccountIds(this.prisma, actor) : [];
    const ids = accountId ? own.filter(a => a === accountId) : own;
    return { accountId: { in: ids } };
  }

  private billView(b: Bill & { account: { id: string; name: string } }, parcels: number) {
    return {
      id: b.id,
      number: b.number,
      account: b.account,
      status: b.status,
      from: new Date(b.periodFrom.getTime() + 6 * 3600_000).toISOString().slice(0, 10),
      to: new Date(b.periodTo.getTime() - 1 + 6 * 3600_000).toISOString().slice(0, 10),
      parcels,
      total: money(b.total),
      paid: money(b.paid),
      due: b.status === "VOID" ? 0 : money(b.total.minus(b.paid)),
      issuedAt: b.issuedAt,
      voidReason: b.voidReason,
    };
  }

  private paymentView(p: AccountPayment & { account: { id: string; name: string }; allocations: { amount: Prisma.Decimal; bill: { number: string } }[] }) {
    const used = sum(p.allocations.map(a => a.amount));
    return {
      id: p.id,
      number: p.number,
      account: p.account,
      status: p.status,
      amount: money(p.amount),
      method: p.method,
      reference: p.reference,
      paidOn: new Date(p.paidOn.getTime() + 6 * 3600_000).toISOString().slice(0, 10),
      note: p.note,
      receipt: p.proofFileId ? { fileId: p.proofFileId } : null,
      rejectReason: p.rejectReason,
      bills: p.allocations.map(a => ({ number: a.bill.number, amount: money(a.amount) })),
      credit: p.status === "CONFIRMED" ? money(p.amount.minus(used)) : 0,
      createdAt: p.createdAt,
    };
  }
}

export { ZERO };
