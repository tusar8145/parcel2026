import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { PrismaService, type Db } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { StorageService } from "../../common/storage.service";
import { RealtimeService } from "../../common/realtime.service";
import { AppError, conflict, forbidden, notFound } from "../../common/errors";
import { nextNumber } from "../../common/counters";
import type { Actor, UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { Prisma, type CashSlip, type HubTransfer } from "../../generated/prisma/client";
import { InboxService } from "../notifications/inbox.service";
import { cashHubScope, money, sum, ZERO } from "../finance/finance.scope";
import { cashHubProblem } from "../parcels/ops-scope";
import type { createTransferSchema, listSlipsQuerySchema, listTransfersQuerySchema, receiveCashSchema } from "./money.schemas";
import { assertCashStaff, assertMoneyStaff } from "./access";
import { centralHubId } from "./accounts-config";
import { hubCashPlacement } from "./cash-placement";

const taka = (d: Prisma.Decimal | number) => `৳${Number(d).toLocaleString("en-BD", { maximumFractionDigits: 2 })}`;
const lockRider = (db: Db, riderId: string) => db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rider-cash:${riderId}`}))`;
const lockHub = (db: Db, hubId: string) => db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`hub-cash:${hubId}`}))`;

/**
 * COD cash on its way to the central hub:
 * rider (WITH_RIDER) → handover slip HS- (all the rider's cash + open rider dues) → a hub scans and receives it
 * (AT_HUB; at the central hub directly AT_CENTRAL) → hub transfer HT- of whole slips and counter cash (IN_TRANSIT)
 * → the central hub receives it (AT_CENTRAL: ready to settle). A short slip / transfer leaves a due on the rider /
 * hub, collected by their next slip / transfer.
 */
@Injectable()
export class CashService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly realtime: RealtimeService,
  ) {}

  @Inject(InboxService) private readonly inbox!: InboxService;

  // ───────────── rider: My cash ─────────────

  /** What the rider holds: COD per parcel, open dues, the total to hand over and the open slip. */
  async riderCash(riderId: string) {
    const [rider, collections, dues, slip] = await Promise.all([
      this.prisma.rider.findUnique({ where: { id: riderId }, include: { user: { select: { name: true } }, hub: { select: { id: true, name: true, code: true } } } }),
      this.prisma.codCollection.findMany({
        where: { riderId, state: "WITH_RIDER" },
        include: { parcel: { select: { trackingId: true, recipientName: true, partialDelivery: true } } },
        orderBy: { collectedAt: "asc" },
      }),
      this.prisma.cashDue.findMany({ where: { riderId, clearedAt: null }, orderBy: { createdAt: "asc" } }),
      this.prisma.cashSlip.findFirst({ where: { riderId, status: "OPEN" }, orderBy: { createdAt: "desc" } }),
    ]);
    if (!rider) throw notFound("Rider");
    const cod = sum(collections.map(c => c.amount));
    const due = sum(dues.map(d => d.amount));
    const onSlip = slip ? new Set(collections.filter(c => c.slipId === slip.id).map(c => c.id)) : new Set<string>();
    return {
      rider: { id: rider.id, code: rider.code, name: rider.user.name, hub: rider.hub },
      cod: money(cod),
      due: money(due),
      total: money(cod.plus(due)),
      parcels: collections.map(c => ({ trackingId: c.parcel.trackingId, recipient: c.parcel.recipientName, amount: money(c.amount), collectedAt: c.collectedAt, partial: c.parcel.partialDelivery, onSlip: onSlip.has(c.id) })),
      dues: dues.map(d => ({ amount: money(d.amount), source: d.source, createdAt: d.createdAt })),
      slip: slip ? await this.slipView(slip) : null,
      // New cash since the slip was made: making the slip again brings it up to date.
      slipOutdated: !!slip && (collections.some(c => c.slipId !== slip.id) || !slip.expected.equals(cod.plus(due))),
    };
  }

  /** One tap: a slip of all the cash the rider holds (an open slip is brought up to date, keeping its number). */
  async makeSlip(actor: UserActor, riderId: string, meta: RequestMeta) {
    const id = await this.prisma.$transaction(async tx => {
      await lockRider(tx, riderId);
      const rider = await tx.rider.findUnique({ where: { id: riderId }, select: { hubId: true } });
      if (!rider?.hubId) throw new AppError("RIDER_WITHOUT_HUB", "You aren't attached to a hub yet; ask operations", HttpStatus.UNPROCESSABLE_ENTITY);
      const collections = await tx.codCollection.findMany({ where: { riderId, state: "WITH_RIDER" }, select: { id: true, amount: true } });
      const dues = await tx.cashDue.findMany({ where: { riderId, clearedAt: null }, select: { amount: true } });
      const cod = sum(collections.map(c => c.amount));
      const due = sum(dues.map(d => d.amount));
      if (!cod.plus(due).gt(0)) throw new AppError("NO_CASH_TO_HAND_OVER", "You don't hold any COD cash right now", HttpStatus.UNPROCESSABLE_ENTITY);
      const open = await tx.cashSlip.findFirst({ where: { riderId, status: "OPEN" } });
      const slip = open
        ? await tx.cashSlip.update({ where: { id: open.id }, data: { hubId: rider.hubId, codAmount: cod, dueAmount: due, expected: cod.plus(due) } })
        : await tx.cashSlip.create({ data: { number: await nextNumber(tx, "HS"), riderId, hubId: rider.hubId, codAmount: cod, dueAmount: due, expected: cod.plus(due) } });
      await tx.codCollection.updateMany({ where: { slipId: slip.id, state: "WITH_RIDER", id: { notIn: collections.map(c => c.id) } }, data: { slipId: null } });
      await tx.codCollection.updateMany({ where: { id: { in: collections.map(c => c.id) } }, data: { slipId: slip.id } });
      await this.audit.record(actor, { action: open ? "cash_slip.refresh" : "cash_slip.create", entityType: "cash_slip", entityId: slip.id, data: { number: slip.number, parcels: collections.length, expected: slip.expected.toFixed(2) } }, meta, tx);
      return slip.id;
    });
    const slip = await this.prisma.cashSlip.findUniqueOrThrow({ where: { id } });
    this.realtime.publish({ type: "cash.slip", id: slip.number, riderIds: [riderId], hubIds: [slip.hubId], staffPermission: "finance:manage" });
    return this.slipView(slip);
  }

  async cancelSlip(actor: UserActor, riderId: string, meta: RequestMeta) {
    await this.prisma.$transaction(async tx => {
      await lockRider(tx, riderId);
      const open = await tx.cashSlip.findFirst({ where: { riderId, status: "OPEN" } });
      if (!open) throw notFound("Open slip");
      await tx.cashSlip.update({ where: { id: open.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
      await tx.codCollection.updateMany({ where: { slipId: open.id, state: "WITH_RIDER" }, data: { slipId: null } });
      await this.audit.record(actor, { action: "cash_slip.cancel", entityType: "cash_slip", entityId: open.id, data: { number: open.number } }, meta, tx);
    });
    return this.riderCash(riderId);
  }

  // ───────────── hub: riders without a phone ─────────────

  /** Riders of the actor's hubs holding COD cash (or owing), for hub staff to make their slip. */
  async ridersWithCash(actor: Actor) {
    assertCashStaff(actor);
    const hubIds = this.hubFilter(actor);
    const [cash, dues] = await Promise.all([
      this.prisma.codCollection.groupBy({ by: ["riderId"], where: { state: "WITH_RIDER", riderId: { not: null }, ...(hubIds ? { rider: { hubId: { in: hubIds } } } : {}) }, _sum: { amount: true }, _count: { _all: true } }),
      this.prisma.cashDue.groupBy({ by: ["riderId"], where: { clearedAt: null, riderId: { not: null }, ...(hubIds ? { riderId: { in: (await this.prisma.rider.findMany({ where: { hubId: { in: hubIds } }, select: { id: true } })).map(r => r.id) } } : {}) }, _sum: { amount: true } }),
    ]);
    const ids = [...new Set([...cash, ...dues].map(g => g.riderId!))];
    const riders = await this.prisma.rider.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, user: { select: { name: true, phone: true } }, hub: { select: { id: true, name: true } } } });
    return {
      items: riders
        .map(r => {
          const c = cash.find(g => g.riderId === r.id);
          const d = dues.find(g => g.riderId === r.id);
          const cod = c?._sum.amount ?? ZERO;
          const due = d?._sum.amount ?? ZERO;
          return { id: r.id, code: r.code, name: r.user.name, phone: r.user.phone, hub: r.hub, parcels: c?._count._all ?? 0, cod: money(cod), due: money(due), total: money(cod.plus(due)) };
        })
        .sort((a, b) => b.total - a.total || a.code.localeCompare(b.code)),
    };
  }

  /** Hub staff make (or bring up to date) the slip of a rider who has no phone; then they receive it as usual. */
  async slipForRider(actor: UserActor, riderId: string, meta: RequestMeta) {
    assertCashStaff(actor);
    const rider = await this.prisma.rider.findUnique({ where: { id: riderId }, select: { hubId: true } });
    if (!rider) throw notFound("Rider");
    const scope = cashHubScope(actor);
    if (scope && !(rider.hubId && scope.includes(rider.hubId))) throw forbidden("You can make slips only for your own hub's riders");
    return this.makeSlip(actor, riderId, meta);
  }

  // ───────────── hub: receive slips ─────────────

  /** A slip by its number (scanned) or id, for hub staff. */
  async slip(actor: Actor, key: string) {
    assertCashStaff(actor);
    const value = key.trim().toUpperCase();
    const slip = await this.prisma.cashSlip.findFirst({ where: /^[0-9A-F-]{36}$/i.test(key) ? { id: key } : { number: value } });
    // Any hub's staff may open a slip by its number: a rider can hand the cash in at any company hub.
    if (!slip) throw notFound(`Slip ${value}`);
    const parcels = await this.prisma.codCollection.findMany({ where: { slipId: slip.id }, include: { parcel: { select: { trackingId: true, recipientName: true } } }, orderBy: { collectedAt: "asc" } });
    return { ...(await this.slipView(slip)), parcels: parcels.map(c => ({ trackingId: c.parcel.trackingId, recipient: c.parcel.recipientName, amount: money(c.amount) })) };
  }

  /** A slip for its PDF: a rider sees their own, hub staff their hubs'. */
  async slipFor(actor: Actor, key: string) {
    if (actor.kind === "user" && actor.riderId && !actor.permissions.has("cod:receive")) {
      const value = key.trim().toUpperCase();
      const own = await this.prisma.cashSlip.findFirst({ where: { riderId: actor.riderId, ...(/^[0-9A-F-]{36}$/i.test(key) ? { id: key } : { number: value }) } });
      if (!own) throw notFound(`Slip ${value}`);
      const parcels = await this.prisma.codCollection.findMany({ where: { slipId: own.id }, include: { parcel: { select: { trackingId: true, recipientName: true } } }, orderBy: { collectedAt: "asc" } });
      return { ...(await this.slipView(own)), parcels: parcels.map(c => ({ trackingId: c.parcel.trackingId, recipient: c.parcel.recipientName, amount: money(c.amount) })) };
    }
    return this.slip(actor, key);
  }

  /** Hub staff count the cash and receive the slip; less than expected leaves a due on the rider. */
  async receiveSlip(actor: UserActor, id: string, input: z.infer<typeof receiveCashSchema>, meta: RequestMeta) {
    assertCashStaff(actor);
    const slip = await this.prisma.cashSlip.findUnique({ where: { id } });
    if (!slip) throw notFound("Slip");
    const scope = cashHubScope(actor);
    const hubId = input.hubId ?? (scope?.length === 1 ? scope[0] : slip.hubId);
    if (scope && !scope.includes(hubId)) throw forbidden("You can only receive cash at your own hub");
    const [hub, rider] = await Promise.all([
      this.prisma.hub.findUnique({ where: { id: hubId }, select: { id: true, name: true, type: true, active: true } }),
      this.prisma.rider.findUnique({ where: { id: slip.riderId }, include: { hub: { select: { type: true, name: true } }, user: { select: { id: true, name: true } } } }),
    ]);
    if (!hub?.active || !rider) throw notFound("Hub");
    const problem = cashHubProblem({ hubId: rider.hubId, hub: rider.hub }, hub);
    if (problem) throw new AppError("WRONG_CASH_HUB", problem, HttpStatus.UNPROCESSABLE_ENTITY);
    const received = new Prisma.Decimal(input.received);
    if (received.gt(slip.expected)) throw new AppError("MORE_THAN_EXPECTED", `The slip is for ${taka(slip.expected)}; count again`, HttpStatus.UNPROCESSABLE_ENTITY, { expected: money(slip.expected) });
    const short = slip.expected.minus(received);
    await this.prisma.$transaction(async tx => {
      await lockRider(tx, slip.riderId);
      const now = new Date();
      const moved = await tx.cashSlip.updateMany({ where: { id, status: "OPEN" }, data: { status: "RECEIVED", received, short, receivedHubId: hub.id, receivedById: actor.userId, receivedAt: now } });
      if (!moved.count) throw conflict("SLIP_NOT_OPEN", `${slip.number} is already ${slip.status.toLowerCase()}`);
      await tx.codCollection.updateMany({ where: { slipId: id, state: "WITH_RIDER" }, data: { ...(await hubCashPlacement(tx, hub.id, now)), handoverId: null } });
      // The dues the slip carried are paid; a short slip leaves its own due.
      // (A rider has one open slip, and a due only arises when a slip is received, so every open due is on this slip.)
      if (slip.dueAmount.gt(0)) await tx.cashDue.updateMany({ where: { riderId: slip.riderId, clearedAt: null }, data: { clearedAt: now, clearedBy: slip.number } });
      if (short.gt(0)) await tx.cashDue.create({ data: { riderId: slip.riderId, amount: short, source: slip.number } });
      await this.audit.record(actor, { action: "cash_slip.receive", entityType: "cash_slip", entityId: id, data: { number: slip.number, hubId: hub.id, expected: slip.expected.toFixed(2), received: received.toFixed(2), short: short.toFixed(2) } }, meta, tx);
      await this.inbox.add(tx, [rider.user.id], {
        type: "cash.slip_received",
        title: `${hub.name} received ${slip.number}`,
        body: short.gt(0) ? `${taka(received)} of ${taka(slip.expected)} received. You owe ${taka(short)}.` : `${taka(received)} received. Thank you.`,
        target: { page: "cash" },
        panel: "/rider",
      });
    });
    this.realtime.publish({ type: "cash.slip", id: slip.number, riderIds: [slip.riderId], hubIds: [hub.id], staffPermission: "finance:manage" });
    return this.slip(actor, id);
  }

  async slips(actor: Actor, query: z.infer<typeof listSlipsQuerySchema>) {
    assertCashStaff(actor);
    const hubIds = this.hubFilter(actor, query.hubId);
    const rows = await this.prisma.cashSlip.findMany({
      where: { ...(query.status ? { status: query.status } : {}), ...(hubIds ? { OR: [{ hubId: { in: hubIds } }, { receivedHubId: { in: hubIds } }] } : {}) },
      orderBy: { createdAt: "desc" },
      take: 300,
    });
    return { items: await Promise.all(rows.map(s => this.slipView(s))) };
  }

  // ───────────── hub: cash on hand and transfers ─────────────

  /** Per hub: received slips not sent yet, counter cash, the hub's dues, and the total to send to the central hub. */
  async onHand(actor: Actor, hubId?: string) {
    assertCashStaff(actor);
    const central = await centralHubId(this.prisma);
    const hubIds = this.hubFilter(actor, hubId);
    const hubs = await this.prisma.hub.findMany({ where: { active: true, ...(hubIds ? { id: { in: hubIds } } : {}), type: { not: "FRANCHISE" } }, select: { id: true, name: true, code: true }, orderBy: { name: "asc" } });
    const ids = hubs.map(h => h.id);
    const [slips, loose, dues, transit] = await Promise.all([
      this.prisma.cashSlip.findMany({ where: { status: "RECEIVED", transferId: null, receivedHubId: { in: ids } }, orderBy: { receivedAt: "asc" } }),
      this.prisma.codCollection.findMany({ where: { state: "AT_HUB", slipId: null, cashHubId: { in: ids } }, include: { parcel: { select: { trackingId: true } } } }),
      this.prisma.cashDue.findMany({ where: { hubId: { in: ids }, clearedAt: null } }),
      this.prisma.hubTransfer.findMany({ where: { status: "IN_TRANSIT", fromHubId: { in: ids } } }),
    ]);
    const slipCash = await this.slipCash(slips.map(s => s.id));
    const items = await Promise.all(
      hubs.map(async h => {
        const own = slips.filter(s => s.receivedHubId === h.id);
        const counter = loose.filter(c => c.cashHubId === h.id);
        const hubDues = dues.filter(d => d.hubId === h.id);
        const cod = sum([...own.map(s => slipCash.get(s.id) ?? ZERO), ...counter.map(c => c.amount)]);
        const due = sum(hubDues.map(d => d.amount));
        return {
          hub: h,
          central: h.id === central,
          slips: await Promise.all(own.map(async s => ({ ...(await this.slipView(s)), cash: money(slipCash.get(s.id)) }))),
          counter: { count: counter.length, amount: money(sum(counter.map(c => c.amount))), parcels: counter.map(c => ({ trackingId: c.parcel.trackingId, amount: money(c.amount) })) },
          dues: hubDues.map(d => ({ amount: money(d.amount), source: d.source, createdAt: d.createdAt })),
          due: money(due),
          toSend: money(cod.plus(due)),
          inTransit: transit.filter(t => t.fromHubId === h.id).map(t => ({ id: t.id, number: t.number, amount: money(t.amount), sentAt: t.sentAt })),
        };
      }),
    );
    return { centralHubId: central, items: items.filter(i => !i.central || i.slips.length || i.counter.count) };
  }

  /** A hub sends whole received slips (default all), its counter cash and its dues to the central hub. */
  async createTransfer(actor: UserActor, input: z.infer<typeof createTransferSchema>, meta: RequestMeta) {
    assertCashStaff(actor);
    const scope = cashHubScope(actor);
    if (scope && !scope.includes(input.fromHubId)) throw forbidden("You can only send cash from your own hub");
    const central = await centralHubId(this.prisma);
    if (!central) throw new AppError("NO_CENTRAL_HUB", "No central hub is set yet: a super admin chooses it in Platform settings", HttpStatus.UNPROCESSABLE_ENTITY);
    if (central === input.fromHubId) throw new AppError("ALREADY_CENTRAL", "This is the central hub: its cash is ready to settle", HttpStatus.UNPROCESSABLE_ENTITY);
    const from = await this.prisma.hub.findUnique({ where: { id: input.fromHubId }, select: { id: true, name: true } });
    if (!from) throw notFound("Hub");
    const id = await this.prisma.$transaction(
      async tx => {
        await lockHub(tx, input.fromHubId);
        const slips = await tx.cashSlip.findMany({ where: { status: "RECEIVED", transferId: null, receivedHubId: input.fromHubId, ...(input.slipIds ? { id: { in: input.slipIds } } : {}) } });
        if (input.slipIds && slips.length !== new Set(input.slipIds).size) throw conflict("SLIPS_CHANGED", "Some slips were already sent or aren't at this hub; refresh and try again");
        const slipCollections = await tx.codCollection.findMany({ where: { slipId: { in: slips.map(s => s.id) }, state: "AT_HUB" }, select: { id: true, amount: true } });
        const counter = await tx.codCollection.findMany({ where: { state: "AT_HUB", slipId: null, cashHubId: input.fromHubId }, select: { id: true, amount: true } });
        const dues = await tx.cashDue.findMany({ where: { hubId: input.fromHubId, clearedAt: null } });
        const cod = sum([...slipCollections, ...counter].map(c => c.amount));
        const due = sum(dues.map(d => d.amount));
        if (!cod.plus(due).gt(0)) throw new AppError("NO_CASH_TO_SEND", `${from.name} has no cash to send`, HttpStatus.UNPROCESSABLE_ENTITY);
        const proofFileId = input.proof ? (await this.storage.saveDataUrl(input.proof, `transfer-${from.name}`, actor.userId, tx)).id : null;
        const transfer = await tx.hubTransfer.create({
          data: { number: await nextNumber(tx, "HT"), fromHubId: input.fromHubId, toHubId: central, codAmount: cod, dueAmount: due, amount: cod.plus(due), method: input.method, reference: input.reference ?? null, proofFileId, sentById: actor.userId },
        });
        const ids = [...slipCollections, ...counter].map(c => c.id);
        const moved = await tx.codCollection.updateMany({ where: { id: { in: ids }, state: "AT_HUB" }, data: { state: "IN_TRANSIT", transferId: transfer.id } });
        if (moved.count !== ids.length) throw conflict("CASH_CHANGED", "The hub's cash changed meanwhile; try again");
        await tx.cashSlip.updateMany({ where: { id: { in: slips.map(s => s.id) } }, data: { transferId: transfer.id } });
        await this.audit.record(actor, { action: "hub_transfer.create", entityType: "hub_transfer", entityId: transfer.id, data: { number: transfer.number, fromHubId: input.fromHubId, slips: slips.length, counter: counter.length, amount: transfer.amount.toFixed(2), method: input.method, reference: input.reference ?? null } }, meta, tx);
        await this.inbox.toStaff(tx, { roles: ["FINANCE", "OPS_MANAGER", "HUB_OPERATOR"], hubIds: [central] }, {
          type: "cash.transfer_sent",
          title: `${from.name} sent ${taka(transfer.amount)}`,
          body: `${transfer.number} by ${input.method}${input.reference ? ` · ${input.reference}` : ""}. Receive it in Accounts › Hub transfers.`,
          target: { page: "accounts", tab: "hub-transfers" },
          panel: "/courier-operation",
        });
        return transfer.id;
      },
      { timeout: 20_000 },
    );
    this.realtime.publish({ type: "cash.transfer", id, hubIds: [input.fromHubId, central], staffPermission: "finance:manage" });
    return this.transfer(actor, id);
  }

  /** The central hub (or finance) receives a transfer; less than sent leaves a due on the sending hub. */
  async receiveTransfer(actor: UserActor, id: string, input: z.infer<typeof receiveCashSchema>, meta: RequestMeta) {
    await assertMoneyStaff(this.prisma, actor);
    const t = await this.prisma.hubTransfer.findUnique({ where: { id } });
    if (!t) throw notFound("Transfer");
    const received = new Prisma.Decimal(input.received);
    if (received.gt(t.amount)) throw new AppError("MORE_THAN_EXPECTED", `The transfer is for ${taka(t.amount)}; check again`, HttpStatus.UNPROCESSABLE_ENTITY, { expected: money(t.amount) });
    const short = t.amount.minus(received);
    await this.prisma.$transaction(async tx => {
      await lockHub(tx, t.fromHubId);
      const now = new Date();
      const moved = await tx.hubTransfer.updateMany({ where: { id, status: "IN_TRANSIT" }, data: { status: "RECEIVED", received, short, receivedById: actor.userId, receivedAt: now } });
      if (!moved.count) throw conflict("TRANSFER_NOT_IN_TRANSIT", `${t.number} is already ${t.status.toLowerCase().replace("_", " ")}`);
      await tx.codCollection.updateMany({ where: { transferId: id, state: "IN_TRANSIT" }, data: { state: "AT_CENTRAL", cashHubId: t.toHubId, centralAt: now } });
      if (t.dueAmount.gt(0)) await tx.cashDue.updateMany({ where: { hubId: t.fromHubId, clearedAt: null, createdAt: { lte: t.sentAt } }, data: { clearedAt: now, clearedBy: t.number } });
      if (short.gt(0)) await tx.cashDue.create({ data: { hubId: t.fromHubId, amount: short, source: t.number } });
      await this.audit.record(actor, { action: "hub_transfer.receive", entityType: "hub_transfer", entityId: id, data: { number: t.number, amount: t.amount.toFixed(2), received: received.toFixed(2), short: short.toFixed(2) } }, meta, tx);
      await this.inbox.toStaff(tx, { roles: ["OPS_MANAGER", "HUB_OPERATOR"], hubIds: [t.fromHubId] }, {
        type: "cash.transfer_received",
        title: `Central hub received ${t.number}`,
        body: short.gt(0) ? `${taka(received)} of ${taka(t.amount)} received; ${taka(short)} is due from your hub.` : `${taka(received)} received.`,
        target: { page: "accounts", tab: "hub-transfers" },
        panel: "/courier-operation",
      });
    });
    this.realtime.publish({ type: "cash.transfer", id, hubIds: [t.fromHubId, t.toHubId], staffPermission: "finance:manage" });
    return this.transfer(actor, id);
  }

  /** The sending hub takes back a transfer that hasn't been received: its cash is on hand again. */
  async cancelTransfer(actor: UserActor, id: string, meta: RequestMeta) {
    assertCashStaff(actor);
    const t = await this.prisma.hubTransfer.findUnique({ where: { id } });
    if (!t) throw notFound("Transfer");
    const scope = cashHubScope(actor);
    if (scope && !scope.includes(t.fromHubId)) throw forbidden("Only the sending hub can cancel a transfer");
    await this.prisma.$transaction(async tx => {
      await lockHub(tx, t.fromHubId);
      const moved = await tx.hubTransfer.updateMany({ where: { id, status: "IN_TRANSIT" }, data: { status: "CANCELLED", cancelledAt: new Date() } });
      if (!moved.count) throw conflict("TRANSFER_NOT_IN_TRANSIT", `${t.number} is already ${t.status.toLowerCase().replace("_", " ")}`);
      await tx.codCollection.updateMany({ where: { transferId: id, state: "IN_TRANSIT" }, data: { state: "AT_HUB", transferId: null } });
      await tx.cashSlip.updateMany({ where: { transferId: id }, data: { transferId: null } });
      await this.audit.record(actor, { action: "hub_transfer.cancel", entityType: "hub_transfer", entityId: id, data: { number: t.number } }, meta, tx);
    });
    this.realtime.publish({ type: "cash.transfer", id, hubIds: [t.fromHubId, t.toHubId], staffPermission: "finance:manage" });
    return this.transfer(actor, id);
  }

  async transfers(actor: Actor, query: z.infer<typeof listTransfersQuerySchema>) {
    assertCashStaff(actor);
    const hubIds = this.hubFilter(actor, query.hubId);
    const rows = await this.prisma.hubTransfer.findMany({
      where: { ...(query.status ? { status: query.status } : {}), ...(hubIds ? { OR: [{ fromHubId: { in: hubIds } }, { toHubId: { in: hubIds } }] } : {}) },
      orderBy: { sentAt: "desc" },
      take: 300,
    });
    return { items: await this.transferViews(rows) };
  }

  /** A transfer by number (scanned) or id. */
  async transfer(actor: Actor, key: string) {
    assertCashStaff(actor);
    const value = key.trim().toUpperCase();
    const t = await this.prisma.hubTransfer.findFirst({ where: /^[0-9A-F-]{36}$/i.test(key) ? { id: key } : { number: value } });
    if (!t) throw notFound(`Transfer ${value}`);
    const scope = cashHubScope(actor);
    if (scope && !scope.includes(t.fromHubId) && !scope.includes(t.toHubId)) throw notFound(`Transfer ${value}`);
    const [view] = await this.transferViews([t]);
    const slips = await this.prisma.cashSlip.findMany({ where: { transferId: t.id }, orderBy: { receivedAt: "asc" } });
    const counter = await this.prisma.codCollection.findMany({ where: { transferId: t.id, slipId: null }, include: { parcel: { select: { trackingId: true } } } });
    return { ...view, slips: await Promise.all(slips.map(s => this.slipView(s))), counter: counter.map(c => ({ trackingId: c.parcel.trackingId, amount: money(c.amount) })) };
  }

  /** Open dues of riders and hubs (staff of those hubs). */
  async dues(actor: Actor) {
    assertCashStaff(actor);
    const hubIds = this.hubFilter(actor);
    const rows = await this.prisma.cashDue.findMany({
      where: { clearedAt: null, ...(hubIds ? { OR: [{ hubId: { in: hubIds } }, { riderId: { in: (await this.prisma.rider.findMany({ where: { hubId: { in: hubIds } }, select: { id: true } })).map(r => r.id) } }] } : {}) },
      orderBy: { createdAt: "asc" },
    });
    const [riders, hubs] = await Promise.all([
      this.prisma.rider.findMany({ where: { id: { in: rows.flatMap(r => (r.riderId ? [r.riderId] : [])) } }, select: { id: true, code: true, user: { select: { name: true } } } }),
      this.prisma.hub.findMany({ where: { id: { in: rows.flatMap(r => (r.hubId ? [r.hubId] : [])) } }, select: { id: true, name: true } }),
    ]);
    return {
      items: rows.map(d => ({
        id: d.id,
        who: d.riderId ? `${riders.find(r => r.id === d.riderId)?.code ?? ""} · ${riders.find(r => r.id === d.riderId)?.user.name ?? "Rider"}` : (hubs.find(h => h.id === d.hubId)?.name ?? "Hub"),
        kind: d.riderId ? "rider" : "hub",
        amount: money(d.amount),
        source: d.source,
        createdAt: d.createdAt,
      })),
    };
  }

  // ───────────── views ─────────────

  private hubFilter(actor: Actor, hubId?: string): string[] | undefined {
    const scope = cashHubScope(actor);
    if (scope === null) return hubId ? [hubId] : undefined;
    if (hubId && !scope.includes(hubId)) throw forbidden("You can only see your own hub's cash");
    return hubId ? [hubId] : scope;
  }

  private async slipCash(slipIds: string[]) {
    const groups = slipIds.length ? await this.prisma.codCollection.groupBy({ by: ["slipId"], where: { slipId: { in: slipIds } }, _sum: { amount: true } }) : [];
    return new Map(groups.map(g => [g.slipId!, g._sum.amount ?? ZERO]));
  }

  private async slipView(s: CashSlip) {
    const [rider, hub, count, receivedBy] = await Promise.all([
      this.prisma.rider.findUnique({ where: { id: s.riderId }, select: { id: true, code: true, user: { select: { name: true, phone: true } } } }),
      this.prisma.hub.findUnique({ where: { id: s.receivedHubId ?? s.hubId }, select: { id: true, name: true } }),
      this.prisma.codCollection.count({ where: { slipId: s.id } }),
      s.receivedById ? this.prisma.user.findUnique({ where: { id: s.receivedById }, select: { name: true } }) : null,
    ]);
    const transfer = s.transferId ? await this.prisma.hubTransfer.findUnique({ where: { id: s.transferId }, select: { number: true, status: true } }) : null;
    return {
      id: s.id,
      number: s.number,
      status: s.status,
      rider: rider ? { id: rider.id, code: rider.code, name: rider.user.name, phone: rider.user.phone } : null,
      hub,
      parcels: count,
      cod: money(s.codAmount),
      due: money(s.dueAmount),
      expected: money(s.expected),
      received: s.received ? money(s.received) : null,
      short: money(s.short),
      receivedBy: receivedBy?.name ?? null,
      receivedAt: s.receivedAt,
      transfer,
      createdAt: s.createdAt,
    };
  }

  private async transferViews(rows: HubTransfer[]) {
    const hubIds = [...new Set(rows.flatMap(t => [t.fromHubId, t.toHubId]))];
    const userIds = [...new Set(rows.flatMap(t => [t.sentById, t.receivedById]).filter((x): x is string => !!x))];
    const [hubs, users, counts] = await Promise.all([
      this.prisma.hub.findMany({ where: { id: { in: hubIds } }, select: { id: true, name: true } }),
      this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }),
      rows.length ? this.prisma.cashSlip.groupBy({ by: ["transferId"], where: { transferId: { in: rows.map(t => t.id) } }, _count: { _all: true } }) : [],
    ]);
    const hub = (id: string) => hubs.find(h => h.id === id) ?? { id, name: "Hub" };
    return rows.map(t => ({
      id: t.id,
      number: t.number,
      status: t.status,
      from: hub(t.fromHubId),
      to: hub(t.toHubId),
      slips: counts.find(c => c.transferId === t.id)?._count._all ?? 0,
      cod: money(t.codAmount),
      due: money(t.dueAmount),
      amount: money(t.amount),
      method: t.method,
      reference: t.reference,
      proof: t.proofFileId ? { fileId: t.proofFileId } : null,
      received: t.received ? money(t.received) : null,
      short: money(t.short),
      sentBy: users.find(u => u.id === t.sentById)?.name ?? null,
      sentAt: t.sentAt,
      receivedBy: users.find(u => u.id === t.receivedById)?.name ?? null,
      receivedAt: t.receivedAt,
    }));
  }
}
