import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { PrismaService, type Db } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { StorageService } from "../../common/storage.service";
import { AppError, conflict, notFound } from "../../common/errors";
import { nextNumber } from "../../common/counters";
import type { Actor, UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { Prisma, type Payout } from "../../generated/prisma/client";
import { InboxService } from "../notifications/inbox.service";
import { NotifyService } from "../notifications/notify.service";
import { OutboxService } from "../notifications/outbox.service";
import { money, sum } from "../finance/finance.scope";
import type { createPayoutSchema, listPayoutsQuerySchema, payPayoutSchema } from "./money.schemas";
import { assertMoneyStaff, isMoneyStaff, ownAccountIds } from "./access";
import { AccountsService, dhakaDay } from "./accounts.service";

const taka = (d: Prisma.Decimal | number) => `৳${Number(d).toLocaleString("en-BD", { maximumFractionDigits: 2 })}`;

/** Serialises money changes on one account (settlement, bill, payment) inside the transaction. */
export const lockAccount = (db: Db, accountId: string) => db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`account:${accountId}`}))`;

/**
 * Settlements (ST-) for E-commerce merchants and customers: the chosen ready parcels (their cash is at the
 * central hub, or they carry no cash) with every open return charge and adjustment; paid with a reference and a
 * receipt photo. A negative net isn't paid: the lines stay open and count in the next settlement.
 */
@Injectable()
export class PayoutsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly storage: StorageService,
  ) {}

  @Inject(InboxService) private readonly inbox!: InboxService;
  @Inject(NotifyService) private readonly notify!: NotifyService;
  @Inject(OutboxService) private readonly outbox!: OutboxService;

  async create(actor: UserActor, accountId: string, input: z.infer<typeof createPayoutSchema>, meta: RequestMeta) {
    await assertMoneyStaff(this.prisma, actor);
    const account = await this.accounts.readable(actor, accountId);
    if (account.kind === "FINANCIAL") throw new AppError("FINANCIAL_ACCOUNT", "Financial merchants are billed: use Generate bill", HttpStatus.UNPROCESSABLE_ENTITY);
    const payTo = await this.accounts.payToOf(account);
    const id = await this.prisma.$transaction(
      async tx => {
        await lockAccount(tx, accountId);
        const open = await tx.accountEntry.findMany({ where: { accountId, payoutId: null, type: { in: ["COD", "DELIVERY_CHARGE", "RETURN_CHARGE", "ADJUSTMENT"] } } });
        const parcelIds = [...new Set(open.flatMap(e => (e.parcelId ? [e.parcelId] : [])))];
        const cash = new Map((await tx.codCollection.findMany({ where: { parcelId: { in: parcelIds } }, select: { parcelId: true, state: true } })).map(c => [c.parcelId, c.state]));
        // Ready: the parcel's cash is at the central hub, or it has none (prepaid, returned).
        const ready = (pid: string) => !cash.has(pid) || cash.get(pid) === "AT_CENTRAL";
        let chosen: Set<string> | null = null;
        if (input.parcelIds) {
          chosen = new Set(input.parcelIds);
          const notReady = input.parcelIds.filter(pid => !open.some(e => e.parcelId === pid) || !ready(pid));
          if (notReady.length) {
            const tracking = (await tx.parcel.findMany({ where: { id: { in: notReady } }, select: { trackingId: true } })).map(p => p.trackingId);
            throw new AppError("PARCELS_NOT_READY", `${tracking.slice(0, 5).join(", ") || "Some parcels"} can't be settled: already settled, or their cash hasn't reached the central hub. Refresh and try again.`, HttpStatus.CONFLICT, { trackingIds: tracking });
          }
        }
        // Delivered parcels as chosen; return charges and adjustments always go with the settlement.
        const lines = open.filter(e => (e.parcelId ? ready(e.parcelId) && (e.type === "RETURN_CHARGE" || !chosen || chosen.has(e.parcelId)) : true));
        if (!lines.length) throw new AppError("NOTHING_TO_SETTLE", "Nothing is ready to settle for this account", HttpStatus.UNPROCESSABLE_ENTITY);
        const amount = sum(lines.map(l => l.amount));
        if (!amount.gt(0))
          throw new AppError("NET_NOT_POSITIVE", `The net is ${taka(amount)}: charges are more than the COD. It stays on the account and counts in the next settlement.`, HttpStatus.UNPROCESSABLE_ENTITY, { net: money(amount) });
        const codTotal = sum(lines.filter(l => l.type === "COD").map(l => l.amount));
        const chargesTotal = sum(lines.filter(l => l.type === "DELIVERY_CHARGE" || l.type === "RETURN_CHARGE").map(l => l.amount)).negated();
        const adjustmentsTotal = sum(lines.filter(l => l.type === "ADJUSTMENT").map(l => l.amount));
        const payout = await tx.payout.create({
          data: { number: await nextNumber(tx, "ST", "month"), accountId, codTotal, chargesTotal, adjustmentsTotal, amount, payTo: (payTo ?? undefined) as Prisma.InputJsonValue | undefined, createdById: actor.userId },
        });
        const linked = await tx.accountEntry.updateMany({ where: { id: { in: lines.map(l => l.id) }, payoutId: null }, data: { payoutId: payout.id } });
        if (linked.count !== lines.length) throw conflict("ACCOUNT_CHANGED", "The account changed meanwhile; try again");
        await this.audit.record(actor, { action: "payout.create", entityType: "payout", entityId: payout.id, data: { number: payout.number, accountId, lines: lines.length, amount: amount.toFixed(2) } }, meta, tx);
        return payout.id;
      },
      { timeout: 20_000 },
    );
    this.accounts.published(account);
    return this.detail(actor, id);
  }

  /** UNPAID → PAID with how it was paid, the reference and a receipt photo; the account's cash is settled. */
  async pay(actor: UserActor, id: string, input: z.infer<typeof payPayoutSchema>, meta: RequestMeta) {
    await assertMoneyStaff(this.prisma, actor);
    const p = await this.prisma.payout.findUnique({ where: { id }, include: { account: true } });
    if (!p) throw notFound("Settlement");
    const outboxIds: string[] = [];
    await this.prisma.$transaction(
      async tx => {
        await lockAccount(tx, p.accountId);
        const proofFileId = input.proof ? (await this.storage.saveDataUrl(input.proof, `receipt-${p.number}`, actor.userId, tx)).id : null;
        const paidAt = new Date();
        const moved = await tx.payout.updateMany({ where: { id, status: "UNPAID" }, data: { status: "PAID", method: input.method, reference: input.reference ?? null, proofFileId, paidAt, paidById: actor.userId } });
        if (!moved.count) throw conflict("SETTLEMENT_NOT_UNPAID", `${p.number} is already ${p.status.toLowerCase()}`);
        await tx.accountEntry.create({
          data: { accountId: p.accountId, type: "PAYOUT", amount: p.amount.negated(), payoutId: id, reference: p.number, description: `Paid out by ${input.method}${input.reference ? ` · ${input.reference}` : ""}`, createdById: actor.userId },
        });
        const parcelIds = (await tx.accountEntry.findMany({ where: { payoutId: id, type: "COD" }, select: { parcelId: true } })).flatMap(e => (e.parcelId ? [e.parcelId] : []));
        if (parcelIds.length) await tx.codCollection.updateMany({ where: { parcelId: { in: parcelIds } }, data: { state: "SETTLED" } });
        await this.audit.record(actor, { action: "payout.pay", entityType: "payout", entityId: id, data: { number: p.number, method: input.method, reference: input.reference ?? null, receipt: !!proofFileId } }, meta, tx);
        const item = { type: "account.payout", title: `Settlement ${p.number} paid`, body: `${taka(p.amount)} sent by ${input.method}${input.reference ? ` · ${input.reference}` : ""}.`, target: { page: "balance" } };
        if (p.account.merchantId) await this.inbox.toMerchant(tx, p.account.merchantId, item, { ownersOnly: true });
        else if (p.account.customerId) await this.inbox.add(tx, [p.account.customerId], { ...item, panel: "/account" });
        // SMS / email (finance.settlement_paid): the merchant's contact, or the customer's phone.
        const m = p.account.merchantId ? await tx.merchant.findUnique({ where: { id: p.account.merchantId }, select: { contactName: true, contactPhone: true, contactEmail: true } }) : null;
        const to = m ? { phone: m.contactPhone, email: m.contactEmail, name: m.contactName } : { phone: p.account.phone, name: p.account.name };
        outboxIds.push(...(await this.notify.notify(tx, { event: "finance.settlement_paid", to, vars: { number: p.number, amount: Number(p.amount).toLocaleString("en-BD", { minimumFractionDigits: 2 }), reference: input.reference ?? input.method } })));
      },
      { timeout: 20_000 },
    );
    await this.outbox.flush(outboxIds);
    this.accounts.published(p.account);
    return this.detail(actor, id);
  }

  /** An unpaid settlement is cancelled: its lines are open again. */
  async cancel(actor: UserActor, id: string, meta: RequestMeta) {
    await assertMoneyStaff(this.prisma, actor);
    const p = await this.prisma.payout.findUnique({ where: { id }, include: { account: true } });
    if (!p) throw notFound("Settlement");
    await this.prisma.$transaction(async tx => {
      await lockAccount(tx, p.accountId);
      const moved = await tx.payout.updateMany({ where: { id, status: "UNPAID" }, data: { status: "CANCELLED", cancelledAt: new Date() } });
      if (!moved.count) throw conflict("SETTLEMENT_NOT_UNPAID", `${p.number} is already ${p.status.toLowerCase()}`);
      await tx.accountEntry.updateMany({ where: { payoutId: id }, data: { payoutId: null } });
      await this.audit.record(actor, { action: "payout.cancel", entityType: "payout", entityId: id, data: { number: p.number } }, meta, tx);
    });
    this.accounts.published(p.account);
    return this.detail(actor, id);
  }

  async list(actor: Actor, query: z.infer<typeof listPayoutsQuerySchema>) {
    const staff = await isMoneyStaff(this.prisma, actor);
    const own = staff || actor.kind !== "user" ? null : await ownAccountIds(this.prisma, actor);
    if (!staff && !own?.length) return { items: [] };
    const rows = await this.prisma.payout.findMany({
      where: {
        ...(query.accountId ? { accountId: query.accountId } : {}),
        ...(own ? { accountId: { in: query.accountId ? own.filter(a => a === query.accountId) : own } } : {}),
        ...(query.status ? { status: query.status } : { status: { not: "CANCELLED" } }),
        ...(query.kind ? { account: { kind: query.kind } } : {}),
        ...(query.from || query.to ? { paidAt: { ...(query.from ? { gte: dhakaDay(query.from) } : {}), ...(query.to ? { lt: dhakaDay(query.to, true) } : {}) } } : {}),
      },
      include: { account: { select: { id: true, name: true, kind: true } }, _count: { select: { entries: { where: { type: "COD" } } } } },
      orderBy: { createdAt: "desc" },
      take: 300,
    });
    return { items: rows.map(p => this.view(p, p._count.entries)) };
  }

  async detail(actor: Actor, id: string) {
    const p = await this.prisma.payout.findUnique({ where: { id }, include: { account: { select: { id: true, name: true, kind: true } } } });
    if (!p) throw notFound("Settlement");
    await this.accounts.readable(actor, p.accountId);
    const lines = await this.prisma.accountEntry.findMany({ where: { payoutId: id, type: { not: "PAYOUT" } }, orderBy: { createdAt: "asc" } });
    const byParcel = new Map<string, { trackingId: string; cod: number; charge: number; returnCharge: number; date: Date }>();
    const other: { description: string; amount: number; date: Date }[] = [];
    for (const l of lines) {
      if (!l.parcelId) {
        other.push({ description: l.description, amount: money(l.amount), date: l.createdAt });
        continue;
      }
      const row = byParcel.get(l.parcelId) ?? { trackingId: l.trackingId ?? "", cod: 0, charge: 0, returnCharge: 0, date: l.createdAt };
      if (l.type === "COD") row.cod = money(l.amount);
      if (l.type === "DELIVERY_CHARGE") row.charge = -money(l.amount);
      if (l.type === "RETURN_CHARGE") row.returnCharge = -money(l.amount);
      byParcel.set(l.parcelId, row);
    }
    const people = await this.prisma.user.findMany({ where: { id: { in: [p.createdById, p.paidById].filter((x): x is string => !!x) } }, select: { id: true, name: true } });
    return {
      ...this.view(p, [...byParcel.values()].filter(r => r.cod > 0).length),
      parcels: [...byParcel.values()].map(r => ({ ...r, net: Math.round((r.cod - r.charge - r.returnCharge) * 100) / 100 })),
      other,
      createdBy: people.find(u => u.id === p.createdById)?.name ?? null,
      paidBy: people.find(u => u.id === p.paidById)?.name ?? null,
    };
  }

  private view(p: Payout & { account: { id: string; name: string; kind: string } }, codParcels: number) {
    return {
      id: p.id,
      number: p.number,
      account: p.account,
      status: p.status,
      codTotal: money(p.codTotal),
      chargesTotal: money(p.chargesTotal),
      adjustmentsTotal: money(p.adjustmentsTotal),
      amount: money(p.amount),
      parcels: codParcels,
      payTo: p.payTo,
      method: p.method,
      reference: p.reference,
      receipt: p.proofFileId ? { fileId: p.proofFileId } : null,
      createdAt: p.createdAt,
      paidAt: p.paidAt,
    };
  }
}
