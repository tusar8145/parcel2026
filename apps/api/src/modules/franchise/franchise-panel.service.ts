import { HttpStatus, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { PrismaService, type Db } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { AppError, forbidden, notFound } from "../../common/errors";
import type { Actor, UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { nextNumber } from "../../common/counters";
import { env } from "../../config/env";
import { Prisma, type ParcelStatus } from "../../generated/prisma/client";
import { parcelStatusLabel } from "@delivery-fast/shared";
import { ParcelsService } from "../parcels/parcels.service";
import { OpsService } from "../ops/ops.service";
import { HubIntakeService } from "../ops/hub-intake.service";
import { ReturnsService } from "../returns/returns.service";
import { NetworkService } from "../network/network.service";
import { PackagesService, quoteResponse } from "../packages/packages.service";
import { quoteRequestOf } from "../packages/packages.controller";
import { NotifyService } from "../notifications/notify.service";
import { LedgerService, credit, debit } from "../finance/ledger.service";
import { readFinanceConfig, vatSplit } from "../finance/finance-config";
import { readFranchiseConfig } from "./franchise-config";
import { franchiseInclude, franchiseView } from "./franchise-admin.service";
import type {
  franchiseAssignSchema,
  franchiseCompleteReturnSchema,
  franchiseParcelsQuerySchema,
  franchiseQuoteSchema,
  franchiseReceiveSchema,
  franchiseReturnRunSchema,
  franchiseRiderSchema,
  franchiseSendSchema,
  franchiseWalkInSchema,
  riderPaymentSchema,
  riderRatesSchema,
  updateFranchiseRiderSchema,
} from "./franchise.schemas";

const n = (v: Prisma.Decimal | number | null | undefined) => (v == null ? 0 : Number(v));
const round2 = (x: number) => Math.round(x * 100) / 100;
const DAY = 24 * 3600_000;
/** Midnight in Dhaka (UTC+6) today. */
const dhakaToday = () => {
  const local = Date.now() + 6 * 3600_000;
  return new Date(local - (local % DAY) - 6 * 3600_000);
};
const PICKUP_OPEN: ParcelStatus[] = ["PENDING_CONFIRMATION", "PICKUP_ASSIGNED", "PICKUP_CONFIRMED"];
const OUT: ParcelStatus[] = ["ASSIGNED", "OUT_FOR_DELIVERY"];
const RETURNABLE: ParcelStatus[] = ["AT_HUB", "RETRY_SCHEDULED", "EXCEPTION"];

const parcelSelect = {
  id: true,
  trackingId: true,
  status: true,
  intake: true,
  senderName: true,
  recipientName: true,
  recipientPhone: true,
  deliveryDistrict: true,
  deliveryZone: true,
  codAmount: true,
  totalCharge: true,
  codFee: true,
  returnReason: true,
  returnRequestedAt: true,
  returnRunId: true,
  updatedAt: true,
  currentHubId: true,
  pickupHubId: true,
  merchant: { select: { id: true, name: true } },
  dropOffHub: { select: { name: true } },
  currentHub: { select: { name: true } },
  pickupRider: { select: { id: true, code: true, user: { select: { name: true } } } },
  deliveryRider: { select: { id: true, code: true, user: { select: { name: true } } } },
} satisfies Prisma.ParcelSelect;
type ParcelRow = Prisma.ParcelGetPayload<{ select: typeof parcelSelect }>;

function parcelView(p: ParcelRow) {
  return {
    trackingId: p.trackingId,
    status: p.status,
    statusLabel: parcelStatusLabel(p.status, { intake: p.intake, dropOffHubName: p.dropOffHub?.name }),
    sender: p.merchant?.name ?? p.senderName,
    merchant: p.merchant,
    recipient: p.recipientName,
    recipientPhone: p.recipientPhone,
    destination: [p.deliveryZone, p.deliveryDistrict].filter(Boolean).join(", "),
    codAmount: n(p.codAmount),
    deliveryCharge: round2(n(p.totalCharge) - n(p.codFee)),
    returnReason: p.returnReason,
    onReturnRun: !!p.returnRunId,
    hub: p.currentHub?.name ?? null,
    pickupRider: p.pickupRider ? { id: p.pickupRider.id, label: `${p.pickupRider.code} · ${p.pickupRider.user.name}` } : null,
    deliveryRider: p.deliveryRider ? { id: p.deliveryRider.id, label: `${p.deliveryRider.code} · ${p.deliveryRider.user.name}` } : null,
    updatedAt: p.updatedAt,
  };
}

/**
 * The franchise panel (Role FRANCHISE, one account per franchise): everything happens at its own hub. The hub
 * operations reuse the network's services with the franchise as the actor — the hub scope helpers (opsHubScope,
 * cashHubScope) limit a franchise to its hub, ParcelsService.scope to its hub's parcels and riders.
 */
@Injectable()
export class FranchisePanelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly parcels: ParcelsService,
    private readonly ops: OpsService,
    private readonly intake: HubIntakeService,
    private readonly returns: ReturnsService,
    private readonly network: NetworkService,
    private readonly packages: PackagesService,
    private readonly notify: NotifyService,
    private readonly ledger: LedgerService,
  ) {}

  /** The signed-in franchise (active only). */
  async context(actor: Actor) {
    const hubId = actor.kind === "user" ? actor.roles.find(r => r.role === "FRANCHISE" && r.hubId)?.hubId : undefined;
    if (!hubId) throw forbidden("This account doesn't run a franchise");
    const franchise = await this.prisma.franchise.findUnique({ where: { hubId }, include: franchiseInclude });
    if (!franchise) throw forbidden("This account doesn't run a franchise");
    if (franchise.status !== "ACTIVE") throw new AppError("FRANCHISE_SUSPENDED", "This franchise is suspended. Contact Paira Express support.", HttpStatus.FORBIDDEN);
    return franchise;
  }

  async me(actor: Actor) {
    const f = await this.context(actor);
    const config = await readFranchiseConfig(this.prisma);
    const hubs = await this.prisma.hub.findMany({ where: { active: true, type: "COMPANY" }, select: { id: true, code: true, name: true, district: true }, orderBy: { name: "asc" } });
    const allHubs = await this.prisma.hub.findMany({ where: { active: true, id: { not: f.hubId } }, select: { id: true, code: true, name: true, district: true, type: true }, orderBy: { name: "asc" } });
    return { ...franchiseView(f), settlementMode: config.settlementMode, billingPeriodDays: config.billingPeriodDays, depositHubs: hubs, sendHubs: allHubs };
  }

  async overview(actor: Actor) {
    const f = await this.context(actor);
    const hubId = f.hubId;
    const today = dhakaToday();
    const monthStart = new Date(Date.UTC(new Date(today.getTime() + 6 * 3600_000).getUTCFullYear(), new Date(today.getTime() + 6 * 3600_000).getUTCMonth(), 1) - 6 * 3600_000);
    const riderIds = (await this.prisma.rider.findMany({ where: { hubId }, select: { id: true } })).map(r => r.id);
    const [atHub, incoming, pickups, out, deliveredToday, failedToday, returnedToday, commissionMonth, commissionToday] = await Promise.all([
      this.prisma.parcel.count({ where: { currentHubId: hubId, status: "AT_HUB" } }),
      this.prisma.parcel.count({ where: { currentHubId: hubId, status: "IN_TRANSIT" } }),
      this.prisma.parcel.count({ where: { OR: [{ pickupHubId: hubId }, { pickupRiderId: { in: riderIds } }], status: { in: PICKUP_OPEN } } }),
      this.prisma.parcel.count({ where: { deliveryRiderId: { in: riderIds }, status: { in: OUT } } }),
      this.prisma.parcel.count({ where: { deliveryRiderId: { in: riderIds }, status: "DELIVERED", deliveredAt: { gte: today } } }),
      this.prisma.deliveryAttempt.count({ where: { riderId: { in: riderIds }, outcome: "FAILED", createdAt: { gte: today } } }),
      this.prisma.franchiseCommission.count({ where: { franchiseId: f.id, type: "RETURN", earnedAt: { gte: today } } }),
      this.prisma.franchiseCommission.aggregate({ where: { franchiseId: f.id, earnedAt: { gte: monthStart } }, _sum: { amount: true } }),
      this.prisma.franchiseCommission.groupBy({ by: ["type"], where: { franchiseId: f.id, earnedAt: { gte: today } }, _count: { _all: true }, _sum: { amount: true } }),
    ]);
    const cash = await cashPosition(this.prisma, f.id, hubId, riderIds);
    const by = (t: string) => commissionToday.find(c => c.type === t);
    return {
      today: {
        pickups: by("PICKUP")?._count._all ?? 0,
        delivered: deliveredToday,
        failed: failedToday,
        returned: returnedToday,
        commission: n(commissionToday.reduce((a, c) => a + n(c._sum.amount), 0)),
      },
      now: { atHub, incoming, pickups, outForDelivery: out, riders: riderIds.length },
      cash,
      commissionThisMonth: n(commissionMonth._sum.amount),
    };
  }

  async parcelsList(actor: Actor, query: z.infer<typeof franchiseParcelsQuerySchema>) {
    const f = await this.context(actor);
    const hubId = f.hubId;
    const riderIds = (await this.prisma.rider.findMany({ where: { hubId }, select: { id: true } })).map(r => r.id);
    const views: Record<string, Prisma.ParcelWhereInput> = {
      incoming: { currentHubId: hubId, status: "IN_TRANSIT" },
      "at-hub": { currentHubId: hubId, status: "AT_HUB" },
      pickups: { OR: [{ pickupHubId: hubId }, { pickupRiderId: { in: riderIds } }], status: { in: PICKUP_OPEN } },
      "drop-offs": { dropOffHubId: hubId, intake: "DROP_OFF", status: "PENDING_CONFIRMATION" },
      out: { deliveryRiderId: { in: riderIds }, status: { in: OUT } },
      returns: { currentHubId: hubId, OR: [{ status: { in: RETURNABLE }, returnRequestedAt: { not: null } }, { status: { in: RETURNABLE }, returnReason: { not: null } }, { status: "RETURN_SCHEDULED" }] },
      delivered: { deliveryRiderId: { in: riderIds }, status: "DELIVERED", deliveredAt: { gte: new Date(Date.now() - 7 * DAY) } },
      all: {},
    };
    const q = query.q?.trim();
    const rows = await this.prisma.parcel.findMany({
      where: {
        AND: [
          this.parcels.scope(actor),
          views[query.view],
          q ? { OR: [{ trackingId: { contains: q.toUpperCase() } }, { recipientPhone: { contains: q.replace(/\D/g, "") || q } }, { recipientName: { contains: q, mode: "insensitive" } }] } : {},
        ],
      },
      select: parcelSelect,
      orderBy: { updatedAt: "desc" },
      take: query.limit,
    });
    return { view: query.view, items: rows.map(parcelView) };
  }

  /** Hub desk scan: transfers, drop-offs and walk-ins arriving at the franchise hub. */
  async receive(actor: Actor, input: z.infer<typeof franchiseReceiveSchema>, meta: RequestMeta) {
    const f = await this.context(actor);
    return this.intake.receive(actor, { code: input.code, hubId: f.hubId, source: input.source, note: undefined }, meta);
  }

  /** A pickup (assigned to the hub) or a delivery (at the hub) to one of the franchise's riders. */
  async assign(actor: Actor, trackingId: string, input: z.infer<typeof franchiseAssignSchema>, meta: RequestMeta) {
    await this.context(actor);
    if (input.task === "PICKUP") await this.parcels.assignPickup(actor, trackingId, { riderId: input.riderId, note: input.note }, meta);
    else await this.parcels.assignDelivery(actor, trackingId, { riderId: input.riderId, note: input.note }, meta);
    return this.parcel(actor, trackingId);
  }

  /** Sends a parcel at the franchise hub to another hub (any hub of the network); that hub receives it. */
  async send(actor: Actor, trackingId: string, input: z.infer<typeof franchiseSendSchema>, meta: RequestMeta) {
    const f = await this.context(actor);
    if (input.hubId === f.hubId) throw new AppError("SAME_HUB", "Choose another hub", HttpStatus.UNPROCESSABLE_ENTITY);
    const hub = await this.prisma.hub.findUnique({ where: { id: input.hubId }, select: { active: true } });
    if (!hub?.active) throw notFound("Hub");
    await this.parcels.setStatus(actor, trackingId, { status: "IN_TRANSIT", hubId: input.hubId, note: input.note } as never, meta);
    return { ok: true, trackingId: trackingId.toUpperCase() };
  }

  private async parcel(actor: Actor, trackingId: string) {
    const row = await this.prisma.parcel.findFirst({ where: { AND: [{ trackingId: trackingId.toUpperCase() }, this.parcels.scope(actor)] }, select: parcelSelect });
    if (!row) throw notFound("Parcel");
    return parcelView(row);
  }

  // ───────────── walk-in booking ─────────────

  private pickupAt(hub: { district: string; zone: string | null; address: string }) {
    return { category: "OFFICE" as const, street: hub.address, district: hub.district, zone: hub.zone ?? undefined };
  }

  /** The price at the counter: the website customer default package, handed over at this hub. */
  async quote(actor: Actor, input: z.infer<typeof franchiseQuoteSchema>) {
    const f = await this.context(actor);
    const body = { ...input, pickupDistrict: f.hub.district, pickupZone: f.hub.zone ?? undefined, firstMile: "HUB_DROP" as const, dropHubId: f.hubId };
    const req = await this.packages.normalizePickup(quoteRequestOf(body as never));
    return quoteResponse(await this.packages.quote({ segment: "CUSTOMER" }, req));
  }

  /**
   * Walk-in at the counter: booked as a drop-off at the franchise hub (website customer default package), received at
   * once (the franchise's pickup commission), and the charge paid in cash at the counter (held until deposited).
   */
  async walkIn(actor: Actor, input: z.infer<typeof franchiseWalkInSchema>, meta: RequestMeta) {
    const f = await this.context(actor);
    const created = (await this.ops.book(actor, { ...input, pickup: input.pickup ?? this.pickupAt(f.hub), intake: "DROP_OFF", dropOffHubId: f.hubId, firstMile: "HUB_DROP", dropHubId: f.hubId } as never, meta)) as { trackingId: string };
    await this.parcels.setStatus(actor, created.trackingId, { status: "AT_HUB", hubId: f.hubId, note: "Walk-in at the counter" } as never, meta);
    const parcel = await this.prisma.parcel.findUniqueOrThrow({ where: { trackingId: created.trackingId }, select: { id: true, trackingId: true, totalCharge: true } });
    const amount = n(parcel.totalCharge);
    if (amount > 0)
      await this.prisma.$transaction(async tx => {
        await tx.franchiseCounterCharge.create({ data: { franchiseId: f.id, parcelId: parcel.id, amount } });
        const { vat } = vatSplit(amount, (await readFinanceConfig(tx)).vatRate);
        await this.ledger.post(tx, {
          eventType: "FRANCHISE_COUNTER_CHARGE",
          reference: parcel.trackingId,
          memo: `Walk-in paid at ${f.hub.name}`,
          hubId: f.hubId,
          lines: [debit("CASH_AT_HUBS", amount, { hubId: f.hubId }), credit("DELIVERY_REVENUE", new Prisma.Decimal(amount).minus(vat)), credit("VAT_PAYABLE", vat)],
        });
        await this.audit.record(actor, { action: "franchise.walk_in", entityType: "parcel", entityId: parcel.id, data: { trackingId: parcel.trackingId, paidAtCounter: amount } }, meta, tx);
      });
    return { ...(await this.parcel(actor, parcel.trackingId)), paidAtCounter: amount };
  }

  // ───────────── returns ─────────────

  /** Return runs for the chosen parcels (one per merchant), taken by one of the franchise's riders. */
  async createReturnRuns(actor: Actor, input: z.infer<typeof franchiseReturnRunSchema>, meta: RequestMeta) {
    const f = await this.context(actor);
    const ids = [...new Set(input.trackingIds.map(t => t.toUpperCase()))];
    const parcels = await this.prisma.parcel.findMany({ where: { trackingId: { in: ids }, currentHubId: f.hubId }, select: { trackingId: true, merchantId: true } });
    const missing = ids.filter(t => !parcels.some(p => p.trackingId === t));
    if (missing.length) throw new AppError("PARCELS_NOT_AT_HUB", `${missing.join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} at ${f.hub.name}`, HttpStatus.UNPROCESSABLE_ENTITY, { missing });
    const noMerchant = parcels.filter(p => !p.merchantId).map(p => p.trackingId);
    if (noMerchant.length) throw new AppError("NOT_MERCHANT_PARCEL", `${noMerchant.join(", ")}: only merchant parcels go on return runs`, HttpStatus.UNPROCESSABLE_ENTITY);
    const byMerchant = new Map<string, string[]>();
    for (const p of parcels) byMerchant.set(p.merchantId!, [...(byMerchant.get(p.merchantId!) ?? []), p.trackingId]);
    const runs = [];
    for (const [merchantId, trackingIds] of byMerchant) {
      const run = (await this.returns.createRun(actor, { merchantId, hubId: f.hubId, riderId: input.riderId, trackingIds, reason: input.reason } as never, meta)) as { id: string };
      runs.push(await this.returns.dispatchRun(actor, run.id, { riderId: input.riderId } as never, meta));
    }
    return runs;
  }

  async returnRuns(actor: Actor) {
    const f = await this.context(actor);
    const runs = await this.prisma.returnRun.findMany({
      where: { hubId: f.hubId, status: { in: ["PLANNED", "OUT_FOR_RETURN"] } },
      include: { merchant: { select: { name: true } }, parcels: { select: { trackingId: true, status: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    const riders = await this.prisma.rider.findMany({ where: { id: { in: runs.flatMap(r => (r.riderId ? [r.riderId] : [])) } }, select: { id: true, code: true, user: { select: { name: true } } } });
    return runs.map(r => ({
      id: r.id,
      number: r.number,
      status: r.status,
      merchant: r.merchant?.name ?? null,
      rider: (rr => (rr ? `${rr.code} · ${rr.user.name}` : null))(riders.find(x => x.id === r.riderId)),
      parcels: r.parcels.map(p => p.trackingId),
      createdAt: r.createdAt,
    }));
  }

  async completeReturnRun(actor: Actor, id: string, input: z.infer<typeof franchiseCompleteReturnSchema>, meta: RequestMeta) {
    const f = await this.context(actor);
    const run = await this.prisma.returnRun.findUnique({ where: { id }, select: { hubId: true } });
    if (!run || run.hubId !== f.hubId) throw notFound("Return run");
    return this.returns.completeRun(actor, id, input as never, meta);
  }

  // ───────────── riders ─────────────

  async riders(actor: Actor) {
    const f = await this.context(actor);
    const riders = await this.prisma.rider.findMany({
      where: { hubId: f.hubId },
      include: { user: { select: { name: true, phone: true, status: true, lastLoginAt: true } } },
      orderBy: { code: "asc" },
    });
    const ids = riders.map(r => r.id);
    const [unpaid, cash, open] = await Promise.all([
      this.prisma.riderEarning.groupBy({ by: ["riderId"], where: { riderId: { in: ids }, payoutId: null }, _sum: { amount: true } }),
      this.prisma.codCollection.groupBy({ by: ["riderId"], where: { riderId: { in: ids }, state: "WITH_RIDER" }, _sum: { amount: true } }),
      this.prisma.parcel.groupBy({ by: ["deliveryRiderId"], where: { deliveryRiderId: { in: ids }, status: { in: OUT } }, _count: { _all: true } }),
    ]);
    return riders.map(r => ({
      id: r.id,
      code: r.code,
      name: r.user.name,
      phone: r.user.phone,
      vehicle: r.vehicle,
      zone: r.zone,
      status: r.status,
      active: r.active && r.user.status === "ACTIVE",
      lastLoginAt: r.user.lastLoginAt,
      unpaid: n(unpaid.find(u => u.riderId === r.id)?._sum.amount),
      cashWithRider: n(cash.find(c => c.riderId === r.id)?._sum.amount),
      outForDelivery: open.find(o => o.deliveryRiderId === r.id)?._count._all ?? 0,
    }));
  }

  /** A rider of this franchise: works only for its hub, signs in to the rider app (SMS code), paid by the franchise. */
  async createRider(actor: Actor, input: z.infer<typeof franchiseRiderSchema>, meta: RequestMeta) {
    const f = await this.context(actor);
    const existing = await this.prisma.user.findUnique({ where: { phone: input.phone }, select: { id: true, rider: { select: { id: true } } } });
    if (existing?.rider) throw new AppError("ALREADY_RIDER", "This phone number already belongs to a rider", HttpStatus.CONFLICT);
    const rider = await this.network.createRider(actor, { name: input.name, phone: input.phone, email: input.email, hubId: f.hubId, vehicle: input.vehicle, zone: input.zone } as never, meta);
    await this.notify
      .notifyNow({
        event: "account.invite",
        to: { phone: input.phone, email: input.email, name: input.name },
        vars: { inviter: f.name, role: `a rider for ${f.name}`, link: `${env().APP_URL.replace(/\/+$/, "")}/login` },
      })
      .catch(() => undefined);
    return rider;
  }

  async updateRider(actor: Actor, id: string, input: z.infer<typeof updateFranchiseRiderSchema>, meta: RequestMeta) {
    const f = await this.context(actor);
    const rider = await this.prisma.rider.findUnique({ where: { id }, select: { hubId: true } });
    if (!rider || rider.hubId !== f.hubId) throw notFound("Rider");
    await this.prisma.$transaction(async tx => {
      await tx.rider.update({ where: { id }, data: { active: input.active, vehicle: input.vehicle, zone: input.zone } });
      await this.audit.record(actor, { action: "franchise.rider_update", entityType: "rider", entityId: id, data: input }, meta, tx);
    });
    return (await this.riders(actor)).find(r => r.id === id);
  }

  async setRiderRates(actor: Actor, input: z.infer<typeof riderRatesSchema>, meta: RequestMeta) {
    const f = await this.context(actor);
    await this.prisma.$transaction(async tx => {
      await tx.franchise.update({ where: { id: f.id }, data: { riderPickupRate: input.pickup, riderDeliveryRate: input.delivery, riderReturnRate: input.return } });
      await this.audit.record(actor, { action: "franchise.rider_rates", entityType: "franchise", entityId: f.id, data: input }, meta, tx);
    });
    return input;
  }

  async riderEarnings(actor: Actor, id: string) {
    const f = await this.context(actor);
    const rider = await this.prisma.rider.findUnique({ where: { id }, include: { user: { select: { name: true } } } });
    if (!rider || rider.hubId !== f.hubId) throw notFound("Rider");
    const [lines, payouts] = await Promise.all([
      this.prisma.riderEarning.findMany({ where: { riderId: id, payoutId: null }, orderBy: { earnedAt: "desc" }, take: 500 }),
      this.prisma.riderPayout.findMany({ where: { riderId: id, franchiseId: f.id }, orderBy: { createdAt: "desc" }, take: 50 }),
    ]);
    return {
      rider: { id: rider.id, code: rider.code, name: rider.user.name },
      unpaid: round2(lines.reduce((a, l) => a + n(l.amount), 0)),
      lines: lines.map(l => ({ type: l.type, amount: n(l.amount), trackingId: l.trackingId, description: l.description, earnedAt: l.earnedAt })),
      payments: payouts.map(p => ({ number: p.number, amount: n(p.amount), method: p.paymentMethod, reference: p.paymentReference, paidAt: p.paidAt })),
    };
  }

  /** Records the franchise paying its rider all unpaid earnings (no Paira Express ledger entry: the franchise pays). */
  async payRider(actor: UserActor, id: string, input: z.infer<typeof riderPaymentSchema>, meta: RequestMeta) {
    const f = await this.context(actor);
    const rider = await this.prisma.rider.findUnique({ where: { id }, select: { hubId: true } });
    if (!rider || rider.hubId !== f.hubId) throw notFound("Rider");
    const payout = await this.prisma.$transaction(async (tx: Db) => {
      await tx.$queryRaw`SELECT id FROM riders WHERE id = ${id}::uuid FOR UPDATE`;
      const lines = await tx.riderEarning.findMany({ where: { riderId: id, payoutId: null }, select: { id: true, amount: true, earnedAt: true } });
      const amount = round2(lines.reduce((a, l) => a + n(l.amount), 0));
      if (!(amount > 0)) throw new AppError("NOTHING_TO_PAY", "This rider has no unpaid earnings", HttpStatus.UNPROCESSABLE_ENTITY);
      const now = new Date();
      const row = await tx.riderPayout.create({
        data: {
          number: await nextNumber(tx, "RPO", "month"),
          riderId: id,
          periodStart: lines.reduce((a, l) => (l.earnedAt < a ? l.earnedAt : a), now),
          periodEnd: now,
          amount,
          status: "PAID",
          createdById: actor.userId,
          approvedById: actor.userId,
          approvedAt: now,
          paidById: actor.userId,
          paidAt: now,
          paymentMethod: input.method,
          paymentReference: input.reference,
          note: input.note ?? `Paid by ${f.name}`,
          franchiseId: f.id,
        },
      });
      await tx.riderEarning.updateMany({ where: { id: { in: lines.map(l => l.id) } }, data: { payoutId: row.id } });
      await this.audit.record(actor, { action: "franchise.rider_paid", entityType: "rider_payout", entityId: row.id, data: { riderId: id, amount, method: input.method } }, meta, tx);
      return row;
    });
    return { number: payout.number, amount: n(payout.amount), method: payout.paymentMethod, reference: payout.paymentReference, paidAt: payout.paidAt };
  }
}

/** Cash the franchise holds (COD received from its riders + counter charges, not deposited yet) and with its riders. */
export async function cashPosition(db: Db, franchiseId: string, hubId: string, riderIds: string[]) {
  const pending = await db.franchiseRemittance.findMany({ where: { franchiseId, status: { in: ["PENDING", "RECEIVED"] } }, select: { collectionIds: true } });
  const deposited = pending.flatMap(r => r.collectionIds);
  const [cod, counter, withRiders, requests, unsettled] = await Promise.all([
    db.codCollection.findMany({ where: { state: "AT_HUB", handover: { hubId }, id: { notIn: deposited } }, select: { id: true, amount: true } }),
    db.franchiseCounterCharge.aggregate({ where: { franchiseId, remittanceId: null }, _sum: { amount: true }, _count: { _all: true } }),
    db.codCollection.aggregate({ where: { riderId: { in: riderIds }, state: "WITH_RIDER" }, _sum: { amount: true } }),
    db.cashSlip.count({ where: { riderId: { in: riderIds }, status: "OPEN" } }),
    db.franchiseCommission.aggregate({ where: { franchiseId, invoiceId: null, remittanceId: null }, _sum: { amount: true } }),
  ]);
  const codOnHand = round2(cod.reduce((a, c) => a + n(c.amount), 0));
  const counterOnHand = n(counter._sum.amount);
  return {
    codOnHand,
    counterOnHand,
    onHand: round2(codOnHand + counterOnHand),
    codCollectionIds: cod.map(c => c.id),
    withRiders: n(withRiders._sum.amount),
    pendingHandovers: requests,
    unsettledCommission: n(unsettled._sum.amount),
  };
}
