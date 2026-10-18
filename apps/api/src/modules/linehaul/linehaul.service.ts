import { HttpStatus, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { PARCEL_STATUS_LABEL, type ParcelStatus } from "@delivery-fast/shared";
import { PrismaService, type Db } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { RealtimeService } from "../../common/realtime.service";
import type { Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { AppError, conflict, forbidden, notFound } from "../../common/errors";
import { nextNumber } from "../../common/counters";
import { pageArgs, toPage } from "../../common/pagination";
import type { Prisma, ScanSource } from "../../generated/prisma/client";
import { ParcelWorkflowService } from "../parcels/parcel-workflow.service";
import { dhakaDateRange, opsHubScope } from "../parcels/ops-scope";
import { ScansService } from "../scans/scans.service";
import { assertHubInScope, codeVariants, inHubScope, isUuid } from "../ops/ops-common";
import { endTripShares, reasonForTripStatus } from "../tracking/trip-shares";
import type {
  bagItemSchema,
  createBagSchema,
  createTripSchema,
  listBagsQuerySchema,
  listDiscrepanciesQuerySchema,
  listTripsQuerySchema,
  inboundQuerySchema,
  listVehiclesQuerySchema,
  receiveBagSchema,
  receiveScanSchema,
  resolveDiscrepancySchema,
  sealBagSchema,
  tripBagSchema,
  updateVehicleSchema,
  vehicleSchema,
} from "./linehaul.schemas";

const parcelSummary = {
  id: true,
  trackingId: true,
  status: true,
  currentHubId: true,
  recipientName: true,
  deliveryZone: true,
  deliveryDistrict: true,
  weightKg: true,
  codAmount: true,
} satisfies Prisma.ParcelSelect;

const hubSelect = { id: true, code: true, name: true, district: true } satisfies Prisma.HubSelect;

const bagInclude = {
  originHub: { select: hubSelect },
  destHub: { select: hubSelect },
  trip: { select: { id: true, number: true, status: true } },
  items: { include: { parcel: { select: parcelSummary } }, orderBy: { addedAt: "asc" } },
  discrepancies: { orderBy: { createdAt: "asc" } },
} satisfies Prisma.LinehaulBagInclude;
type BagFull = Prisma.LinehaulBagGetPayload<{ include: typeof bagInclude }>;

const tripInclude = {
  originHub: { select: hubSelect },
  destHub: { select: hubSelect },
  vehicle: true,
  bags: { include: bagInclude, orderBy: { number: "asc" } },
  discrepancies: { orderBy: { createdAt: "asc" } },
} satisfies Prisma.LinehaulTripInclude;
type TripFull = Prisma.LinehaulTripGetPayload<{ include: typeof tripInclude }>;

const ACTIVE_BAG_STATUSES = ["OPEN", "SEALED", "IN_TRANSIT"] as const;
/** Generous: a departing truck can carry hundreds of parcels, each a workflow transition. */
const BIG_TX = { timeout: 180_000, maxWait: 15_000 };

const num = (d: Prisma.Decimal | null | undefined) => (d == null ? 0 : Number(d));

function itemView(i: BagFull["items"][number]) {
  return {
    id: i.id,
    state: i.state,
    addedAt: i.addedAt,
    receivedAt: i.receivedAt,
    parcel: {
      trackingId: i.parcel.trackingId,
      status: i.parcel.status,
      statusLabel: PARCEL_STATUS_LABEL[i.parcel.status as ParcelStatus],
      recipient: i.parcel.recipientName,
      zone: i.parcel.deliveryZone,
      district: i.parcel.deliveryDistrict,
      weightKg: num(i.parcel.weightKg),
      codAmount: num(i.parcel.codAmount),
    },
  };
}

function discrepancyView(d: BagFull["discrepancies"][number]) {
  return {
    id: d.id,
    kind: d.kind,
    trackingId: d.trackingId,
    note: d.note,
    hubId: d.hubId,
    bagId: d.bagId,
    tripId: d.tripId,
    createdAt: d.createdAt,
    resolvedAt: d.resolvedAt,
    resolution: d.resolution,
  };
}

function bagView(b: BagFull) {
  const items = b.items.map(itemView);
  return {
    id: b.id,
    number: b.number,
    status: b.status,
    label: b.label,
    sealNo: b.sealNo,
    sealedAt: b.sealedAt,
    receivedAt: b.receivedAt,
    createdAt: b.createdAt,
    originHub: b.originHub,
    destHub: b.destHub,
    trip: b.trip,
    items,
    totals: {
      parcels: items.length,
      loaded: items.filter(i => i.state === "LOADED").length,
      received: items.filter(i => i.state === "RECEIVED").length,
      missing: items.filter(i => i.state === "MISSING").length,
      weightKg: Math.round(items.reduce((n, i) => n + i.parcel.weightKg, 0) * 100) / 100,
      codAmount: items.reduce((n, i) => n + i.parcel.codAmount, 0),
    },
    discrepancies: b.discrepancies.map(discrepancyView),
  };
}

function tripView(t: TripFull) {
  const bags = t.bags.map(bagView);
  return {
    id: t.id,
    number: t.number,
    status: t.status,
    originHub: t.originHub,
    destHub: t.destHub,
    vehicle: t.vehicle ? { id: t.vehicle.id, regNo: t.vehicle.regNo, kind: t.vehicle.kind, capacityKg: t.vehicle.capacityKg } : null,
    vehicleRegNo: t.vehicleRegNo,
    driverName: t.driverName,
    driverPhone: t.driverPhone,
    plannedDepartureAt: t.plannedDepartureAt,
    departedAt: t.departedAt,
    arrivedAt: t.arrivedAt,
    closedAt: t.closedAt,
    note: t.note,
    createdAt: t.createdAt,
    bags,
    totals: {
      bags: bags.length,
      parcels: bags.reduce((n, b) => n + b.totals.parcels, 0),
      weightKg: Math.round(bags.reduce((n, b) => n + b.totals.weightKg, 0) * 100) / 100,
      codAmount: bags.reduce((n, b) => n + b.totals.codAmount, 0),
      received: bags.reduce((n, b) => n + b.totals.received, 0),
      missing: bags.reduce((n, b) => n + b.totals.missing, 0),
      discrepancies: t.discrepancies.length,
      openDiscrepancies: t.discrepancies.filter(d => !d.resolvedAt).length,
    },
    discrepancies: t.discrepancies.map(discrepancyView),
  };
}

const inboundInclude = {
  originHub: { select: hubSelect },
  destHub: { select: hubSelect },
  bags: { select: { id: true, number: true, status: true, sealNo: true, label: true, receivedAt: true, items: { select: { state: true } } }, orderBy: { number: "asc" } },
  _count: { select: { discrepancies: { where: { resolvedAt: null } } } },
} satisfies Prisma.LinehaulTripInclude;
type InboundTrip = Prisma.LinehaulTripGetPayload<{ include: typeof inboundInclude }>;

/** An inbound trip with expected (manifested) / received / missing / still expected parcels per bag. */
function inboundView(t: InboundTrip) {
  const bags = t.bags.map(b => {
    const count = (s: string) => b.items.filter(i => i.state === s).length;
    return { id: b.id, number: b.number, label: b.label, status: b.status, sealNo: b.sealNo, receivedAt: b.receivedAt, expected: b.items.length, received: count("RECEIVED"), missing: count("MISSING"), pending: count("LOADED") };
  });
  const sum = (k: "expected" | "received" | "missing" | "pending") => bags.reduce((n, b) => n + b[k], 0);
  return {
    id: t.id,
    number: t.number,
    status: t.status,
    originHub: t.originHub,
    destHub: t.destHub,
    vehicleRegNo: t.vehicleRegNo,
    driverName: t.driverName,
    driverPhone: t.driverPhone,
    plannedDepartureAt: t.plannedDepartureAt,
    departedAt: t.departedAt,
    arrivedAt: t.arrivedAt,
    closedAt: t.closedAt,
    bags,
    totals: {
      bags: bags.length,
      bagsReceived: bags.filter(b => b.status === "RECEIVED").length,
      expected: sum("expected"),
      received: sum("received"),
      missing: sum("missing"),
      pending: sum("pending"),
      openDiscrepancies: t._count.discrepancies,
    },
  };
}

export type ReceiveScanOutcome = "RECEIVED" | "BAG_RECEIVED" | "ALREADY_RECEIVED" | "TRIP" | "EXTRA" | "WRONG_HUB" | "NOT_FOUND" | "NOT_IN_TRANSIT" | "REFUSED";

/**
 * Linehaul between hubs: parcels are scanned into bags at the origin hub, bags are sealed and
 * loaded on a truck trip (the manifest), the trip departs (parcels IN_TRANSIT), and the
 * destination hub receives the bags (parcels AT_HUB) and records any discrepancies.
 */
@Injectable()
export class LinehaulService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
    private readonly workflow: ParcelWorkflowService,
    private readonly scans: ScansService,
  ) {}

  // ───────────── vehicles ─────────────

  async listVehicles(query: z.infer<typeof listVehiclesQuerySchema>) {
    const rows = await this.prisma.linehaulVehicle.findMany({
      where: {
        active: query.active,
        ...(query.q ? { OR: [{ regNo: { contains: query.q, mode: "insensitive" } }, { kind: { contains: query.q, mode: "insensitive" } }, { ownerName: { contains: query.q, mode: "insensitive" } }] } : {}),
      },
      ...pageArgs(query),
    });
    return toPage(rows, query.limit);
  }

  async createVehicle(actor: Actor, input: z.infer<typeof vehicleSchema>, meta: RequestMeta) {
    if (await this.prisma.linehaulVehicle.findUnique({ where: { regNo: input.regNo } })) throw conflict("VEHICLE_EXISTS", `${input.regNo} is already registered`);
    return this.prisma.$transaction(async tx => {
      const vehicle = await tx.linehaulVehicle.create({ data: input });
      await this.audit.record(actor, { action: "linehaul.vehicle_create", entityType: "linehaul_vehicle", entityId: vehicle.id, data: input }, meta, tx);
      return vehicle;
    });
  }

  async updateVehicle(actor: Actor, id: string, input: z.infer<typeof updateVehicleSchema>, meta: RequestMeta) {
    if (!(await this.prisma.linehaulVehicle.findUnique({ where: { id } }))) throw notFound("Vehicle");
    if (input.regNo) {
      const other = await this.prisma.linehaulVehicle.findUnique({ where: { regNo: input.regNo } });
      if (other && other.id !== id) throw conflict("VEHICLE_EXISTS", `${input.regNo} is already registered`);
    }
    return this.prisma.$transaction(async tx => {
      const vehicle = await tx.linehaulVehicle.update({ where: { id }, data: input });
      await this.audit.record(actor, { action: "linehaul.vehicle_update", entityType: "linehaul_vehicle", entityId: id, data: input }, meta, tx);
      return vehicle;
    });
  }

  // ───────────── bags ─────────────

  async createBag(actor: Actor, input: z.infer<typeof createBagSchema>, meta: RequestMeta) {
    assertHubInScope(actor, input.originHubId, "make up bags at this hub");
    const [origin, dest] = await Promise.all([this.activeHub(input.originHubId), this.activeHub(input.destHubId)]);
    const bag = await this.prisma.$transaction(async tx => {
      const created = await tx.linehaulBag.create({
        data: { number: await nextNumber(tx, "BG"), originHubId: origin.id, destHubId: dest.id, createdById: userIdOf(actor) },
      });
      await this.audit.record(actor, { action: "linehaul.bag_create", entityType: "linehaul_bag", entityId: created.id, data: { number: created.number, from: origin.code, to: dest.code } }, meta, tx);
      return created;
    });
    this.publish(bag.number, bag.originHubId, bag.destHubId);
    return this.getBag(actor, bag.id);
  }

  async listBags(actor: Actor, query: z.infer<typeof listBagsQuerySchema>) {
    const where: Prisma.LinehaulBagWhereInput = { AND: [this.hubWhere(actor, query.hubId, query.direction), { status: query.status, tripId: query.tripId }] };
    if (query.q) {
      const variants = codeVariants(query.q);
      (where.AND as Prisma.LinehaulBagWhereInput[]).push({
        OR: [{ number: { contains: query.q.toUpperCase() } }, { sealNo: { contains: query.q.toUpperCase() } }, { items: { some: { parcel: { trackingId: { in: variants } } } } }],
      });
    }
    const rows = await this.prisma.linehaulBag.findMany({
      where,
      include: { originHub: { select: hubSelect }, destHub: { select: hubSelect }, trip: { select: { id: true, number: true, status: true } }, _count: { select: { items: true } } },
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return {
      items: page.items.map(({ _count, ...b }) => ({ ...b, parcels: _count.items })),
      nextCursor: page.nextCursor,
    };
  }

  async getBag(actor: Actor, idOrNumber: string) {
    const bag = await this.findBag(this.prisma, idOrNumber);
    if (!inHubScope(actor, bag.originHubId, bag.destHubId)) throw forbidden("This bag doesn't move through your hub");
    return bagView(bag);
  }

  /** Scans a parcel into an open bag at the bag's origin hub. Scanning it again is harmless. */
  async addItem(actor: Actor, bagRef: string, input: z.infer<typeof bagItemSchema>, meta: RequestMeta) {
    const bag = await this.findBag(this.prisma, bagRef);
    assertHubInScope(actor, bag.originHubId, "load bags at this hub");
    const scan = { code: input.code, kind: "BAG_LOAD" as const, hubId: bag.originHubId, userId: userIdOf(actor), source: input.source as ScanSource };
    let added = true;
    try {
      await this.prisma.$transaction(async tx => {
        await this.lockBag(tx, bag.id);
        const current = await tx.linehaulBag.findUniqueOrThrow({ where: { id: bag.id } });
        if (current.status !== "OPEN") throw conflict("BAG_NOT_OPEN", `${bag.number} is ${current.status.toLowerCase().replace("_", " ")}; reopen it to change its contents`);
        const parcel = await this.findParcel(tx, input.code);
        if (!(await this.putInBag(tx, actor, bag, parcel))) {
          added = false;
          return;
        }
        await this.scans.record({ ...scan, code: parcel.trackingId }, tx);
        await this.audit.record(actor, { action: "linehaul.bag_add", entityType: "linehaul_bag", entityId: bag.id, data: { bag: bag.number, trackingId: parcel.trackingId } }, meta, tx);
      });
    } catch (error) {
      await this.scans.recordQuietly({ ...scan, ok: false, message: error instanceof AppError ? (error.getResponse() as { message: string }).message : "Refused" });
      throw error;
    }
    if (added) this.publish(bag.number, bag.originHubId, bag.destHubId);
    return { added, bag: await this.getBag(actor, bag.id) };
  }

  /**
   * Puts a parcel in an open bag (the caller holds the bag's row lock): it must be at the bag's
   * origin hub and in no other active bag. Returns false when it already is in this bag.
   * Shared by the scan (addItem) and the bulk transfer file (TransferService).
   */
  async putInBag(tx: Db, actor: Actor, bag: { id: string; number: string; originHubId: string; originHub: { name: string } }, parcel: { id: string; trackingId: string; status: string; currentHubId: string | null }) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`bag-item:${parcel.id}`}))`;
    if (await tx.linehaulBagItem.findUnique({ where: { bagId_parcelId: { bagId: bag.id, parcelId: parcel.id } } })) return false;
    if (parcel.status !== "AT_HUB" || parcel.currentHubId !== bag.originHubId)
      throw new AppError(
        "PARCEL_NOT_AT_ORIGIN",
        `${parcel.trackingId} is "${PARCEL_STATUS_LABEL[parcel.status as ParcelStatus]}"${parcel.currentHubId !== bag.originHubId ? " and not at this hub" : ""}. Only parcels received at ${bag.originHub.name} can be bagged here`,
        HttpStatus.CONFLICT,
        { trackingId: parcel.trackingId, status: parcel.status },
      );
    const other = await tx.linehaulBagItem.findFirst({
      where: { parcelId: parcel.id, state: "LOADED", bag: { status: { in: [...ACTIVE_BAG_STATUSES] } } },
      include: { bag: { select: { number: true } } },
    });
    if (other) throw new AppError("PARCEL_ALREADY_BAGGED", `${parcel.trackingId} is already in bag ${other.bag.number}`, HttpStatus.CONFLICT, { bag: other.bag.number });
    await tx.linehaulBagItem.create({ data: { bagId: bag.id, parcelId: parcel.id, addedById: userIdOf(actor) } });
    return true;
  }

  async removeItem(actor: Actor, bagRef: string, trackingId: string, meta: RequestMeta) {
    const bag = await this.findBag(this.prisma, bagRef);
    assertHubInScope(actor, bag.originHubId, "change bags at this hub");
    await this.prisma.$transaction(async tx => {
      await this.lockBag(tx, bag.id);
      const current = await tx.linehaulBag.findUniqueOrThrow({ where: { id: bag.id } });
      if (current.status !== "OPEN") throw conflict("BAG_NOT_OPEN", `${bag.number} is sealed; reopen it to change its contents`);
      const item = await tx.linehaulBagItem.findFirst({ where: { bagId: bag.id, parcel: { trackingId: { in: codeVariants(trackingId) } } }, include: { parcel: { select: { trackingId: true } } } });
      if (!item) throw notFound(`${trackingId} in ${bag.number}`);
      await tx.linehaulBagItem.delete({ where: { id: item.id } });
      await this.audit.record(actor, { action: "linehaul.bag_remove", entityType: "linehaul_bag", entityId: bag.id, data: { bag: bag.number, trackingId: item.parcel.trackingId } }, meta, tx);
    });
    this.publish(bag.number, bag.originHubId, bag.destHubId);
    return this.getBag(actor, bag.id);
  }

  async seal(actor: Actor, bagRef: string, input: z.infer<typeof sealBagSchema>, meta: RequestMeta) {
    const bag = await this.findBag(this.prisma, bagRef);
    assertHubInScope(actor, bag.originHubId, "seal bags at this hub");
    await this.prisma.$transaction(async tx => {
      await this.lockBag(tx, bag.id);
      const current = await tx.linehaulBag.findUniqueOrThrow({ where: { id: bag.id }, include: { _count: { select: { items: true } } } });
      if (current.status !== "OPEN") throw conflict("BAG_NOT_OPEN", `${bag.number} is already ${current.status.toLowerCase().replace("_", " ")}`);
      if (!current._count.items) throw new AppError("BAG_EMPTY", "Scan at least one parcel into the bag before sealing it", 422);
      await tx.linehaulBag.update({ where: { id: bag.id }, data: { status: "SEALED", sealNo: input.sealNo, sealedAt: new Date(), sealedById: userIdOf(actor) } });
      await this.audit.record(actor, { action: "linehaul.bag_seal", entityType: "linehaul_bag", entityId: bag.id, data: { bag: bag.number, sealNo: input.sealNo, parcels: current._count.items } }, meta, tx);
    });
    this.publish(bag.number, bag.originHubId, bag.destHubId);
    return this.getBag(actor, bag.id);
  }

  /** Breaks the seal of a bag that hasn't left; a bag loaded on a planned trip comes off it. */
  async reopen(actor: Actor, bagRef: string, meta: RequestMeta) {
    const bag = await this.findBag(this.prisma, bagRef);
    assertHubInScope(actor, bag.originHubId, "reopen bags at this hub");
    await this.prisma.$transaction(async tx => {
      await this.lockBag(tx, bag.id);
      const current = await tx.linehaulBag.findUniqueOrThrow({ where: { id: bag.id }, include: { trip: true } });
      if (current.status !== "SEALED") throw conflict("BAG_NOT_SEALED", `Only a sealed bag that hasn't departed can be reopened (${bag.number} is ${current.status.toLowerCase().replace("_", " ")})`);
      if (current.trip && current.trip.status !== "PLANNED") throw conflict("TRIP_DEPARTED", `${bag.number} has left on ${current.trip.number}`);
      await tx.linehaulBag.update({ where: { id: bag.id }, data: { status: "OPEN", sealNo: null, sealedAt: null, sealedById: null, tripId: null } });
      await this.audit.record(actor, { action: "linehaul.bag_reopen", entityType: "linehaul_bag", entityId: bag.id, data: { bag: bag.number, previousSeal: current.sealNo, trip: current.trip?.number ?? null } }, meta, tx);
    });
    this.publish(bag.number, bag.originHubId, bag.destHubId);
    return this.getBag(actor, bag.id);
  }

  // ───────────── trips & manifests ─────────────

  async createTrip(actor: Actor, input: z.infer<typeof createTripSchema>, meta: RequestMeta) {
    assertHubInScope(actor, input.originHubId, "plan trips from this hub");
    const [origin, dest] = await Promise.all([this.activeHub(input.originHubId), this.activeHub(input.destHubId)]);
    let vehicle = input.vehicleId ? await this.prisma.linehaulVehicle.findUnique({ where: { id: input.vehicleId } }) : null;
    if (input.vehicleId && !vehicle) throw notFound("Vehicle");
    if (vehicle && !vehicle.active) throw new AppError("VEHICLE_INACTIVE", `${vehicle.regNo} is marked inactive`, 422);
    if (!vehicle && input.vehicleRegNo) vehicle = await this.prisma.linehaulVehicle.findUnique({ where: { regNo: input.vehicleRegNo } });
    const trip = await this.prisma.$transaction(async tx => {
      const created = await tx.linehaulTrip.create({
        data: {
          number: await nextNumber(tx, "MF"),
          originHubId: origin.id,
          destHubId: dest.id,
          vehicleId: vehicle?.id ?? null,
          vehicleRegNo: vehicle?.regNo ?? input.vehicleRegNo!,
          driverName: input.driverName,
          driverPhone: input.driverPhone,
          plannedDepartureAt: input.plannedDepartureAt,
          note: input.note,
          createdById: userIdOf(actor),
        },
      });
      await this.audit.record(
        actor,
        { action: "linehaul.trip_create", entityType: "linehaul_trip", entityId: created.id, data: { number: created.number, from: origin.code, to: dest.code, vehicle: created.vehicleRegNo } },
        meta,
        tx,
      );
      return created;
    });
    this.publish(trip.number, trip.originHubId, trip.destHubId);
    return this.getTrip(actor, trip.id);
  }

  async listTrips(actor: Actor, query: z.infer<typeof listTripsQuerySchema>) {
    const range = query.from || query.to ? dhakaDateRange(query.from ?? "2000-01-01", query.to ?? "2999-12-31") : null;
    const and: Prisma.LinehaulTripWhereInput[] = [this.hubWhere(actor, query.hubId, query.direction) as Prisma.LinehaulTripWhereInput, { status: query.status }];
    if (range) and.push({ createdAt: { gte: range[0], lt: range[1] } });
    if (query.q)
      and.push({
        OR: [
          { number: { contains: query.q.toUpperCase() } },
          { vehicleRegNo: { contains: query.q, mode: "insensitive" } },
          { driverName: { contains: query.q, mode: "insensitive" } },
          { bags: { some: { number: { contains: query.q.toUpperCase() } } } },
        ],
      });
    const rows = await this.prisma.linehaulTrip.findMany({
      where: { AND: and },
      include: {
        originHub: { select: hubSelect },
        destHub: { select: hubSelect },
        bags: { select: { id: true, status: true, _count: { select: { items: true } } } },
        _count: { select: { discrepancies: { where: { resolvedAt: null } } } },
      },
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return {
      items: page.items.map(({ bags, _count, ...t }) => ({
        ...t,
        bags: bags.length,
        parcels: bags.reduce((n, b) => n + b._count.items, 0),
        bagsReceived: bags.filter(b => b.status === "RECEIVED").length,
        openDiscrepancies: _count.discrepancies,
      })),
      nextCursor: page.nextCursor,
    };
  }

  /** The manifest: trip, vehicle, hubs, bags with their parcels, totals and discrepancies. */
  async getTrip(actor: Actor, idOrNumber: string) {
    const trip = await this.findTrip(this.prisma, idOrNumber);
    if (!inHubScope(actor, trip.originHubId, trip.destHubId)) throw forbidden("This trip doesn't move through your hub");
    return tripView(trip);
  }

  async addBagToTrip(actor: Actor, tripRef: string, input: z.infer<typeof tripBagSchema>, meta: RequestMeta) {
    const trip = await this.findTrip(this.prisma, tripRef);
    assertHubInScope(actor, trip.originHubId, "load trucks at this hub");
    const scan = { code: input.bag, kind: "BAG_LOAD" as const, hubId: trip.originHubId, userId: userIdOf(actor), source: input.source as ScanSource };
    let bagNumber = input.bag;
    try {
      await this.prisma.$transaction(async tx => {
        await this.lockTrip(tx, trip.id);
        const current = await tx.linehaulTrip.findUniqueOrThrow({ where: { id: trip.id } });
        if (current.status !== "PLANNED") throw conflict("TRIP_NOT_PLANNED", `${trip.number} has already ${current.status === "CANCELLED" ? "been cancelled" : "departed"}`);
        const bag = await this.findBag(tx, input.bag);
        bagNumber = bag.number;
        await this.lockBag(tx, bag.id);
        if (bag.tripId === trip.id) return;
        if (bag.status !== "SEALED") throw conflict("BAG_NOT_SEALED", `Seal ${bag.number} before loading it`);
        if (bag.tripId) throw conflict("BAG_ON_ANOTHER_TRIP", `${bag.number} is already loaded on ${bag.trip?.number}`);
        if (bag.originHubId !== trip.originHubId || bag.destHubId !== trip.destHubId)
          throw new AppError("BAG_ROUTE_MISMATCH", `${bag.number} goes ${bag.originHub.name} → ${bag.destHub.name}, but ${trip.number} runs ${trip.originHub.name} → ${trip.destHub.name}`, HttpStatus.CONFLICT);
        await tx.linehaulBag.update({ where: { id: bag.id }, data: { tripId: trip.id } });
        await this.audit.record(actor, { action: "linehaul.trip_load", entityType: "linehaul_trip", entityId: trip.id, data: { trip: trip.number, bag: bag.number } }, meta, tx);
      });
    } catch (error) {
      await this.scans.recordQuietly({ ...scan, ok: false, message: error instanceof AppError ? (error.getResponse() as { message: string }).message : "Refused" });
      throw error;
    }
    await this.scans.recordQuietly({ ...scan, code: bagNumber });
    this.publish(trip.number, trip.originHubId, trip.destHubId);
    return this.getTrip(actor, trip.id);
  }

  async removeBagFromTrip(actor: Actor, tripRef: string, bagRef: string, meta: RequestMeta) {
    const trip = await this.findTrip(this.prisma, tripRef);
    assertHubInScope(actor, trip.originHubId, "load trucks at this hub");
    await this.prisma.$transaction(async tx => {
      await this.lockTrip(tx, trip.id);
      const current = await tx.linehaulTrip.findUniqueOrThrow({ where: { id: trip.id } });
      if (current.status !== "PLANNED") throw conflict("TRIP_NOT_PLANNED", `${trip.number} has already departed`);
      const bag = await this.findBag(tx, bagRef);
      if (bag.tripId !== trip.id) throw notFound(`${bag.number} on ${trip.number}`);
      await tx.linehaulBag.update({ where: { id: bag.id }, data: { tripId: null } });
      await this.audit.record(actor, { action: "linehaul.trip_unload", entityType: "linehaul_trip", entityId: trip.id, data: { trip: trip.number, bag: bag.number } }, meta, tx);
    });
    this.publish(trip.number, trip.originHubId, trip.destHubId);
    return this.getTrip(actor, trip.id);
  }

  /** The truck leaves: every manifested parcel goes AT_HUB → IN_TRANSIT in one transaction. */
  async depart(actor: Actor, tripRef: string, meta: RequestMeta) {
    const trip = await this.findTrip(this.prisma, tripRef);
    assertHubInScope(actor, trip.originHubId, "dispatch trucks from this hub");
    const after = this.workflow.newAfterCommit();
    await this.prisma.$transaction(async tx => {
      await this.lockTrip(tx, trip.id);
      const current = await this.findTrip(tx, trip.id);
      if (current.status !== "PLANNED") throw conflict("TRIP_NOT_PLANNED", `${trip.number} is ${current.status.toLowerCase()}`);
      if (!current.bags.length) throw new AppError("TRIP_EMPTY", "Load at least one sealed bag before departure", 422);
      const unsealed = current.bags.filter(b => b.status !== "SEALED");
      if (unsealed.length) throw new AppError("BAGS_NOT_SEALED", `Seal ${unsealed.map(b => b.number).join(", ")} before departure`, HttpStatus.CONFLICT, { bags: unsealed.map(b => b.number) });
      const items = current.bags.flatMap(b => b.items.filter(i => i.state === "LOADED").map(i => ({ bag: b, item: i })));
      const notReady = items.filter(({ item }) => item.parcel.status !== "AT_HUB" || item.parcel.currentHubId !== trip.originHubId);
      if (notReady.length)
        throw new AppError(
          "PARCELS_NOT_AT_ORIGIN",
          `${notReady.length} parcel${notReady.length === 1 ? " is" : "s are"} no longer at ${trip.originHub.name}: ${notReady.slice(0, 5).map(x => x.item.parcel.trackingId).join(", ")}${notReady.length > 5 ? "…" : ""}. Reopen the bag and take ${notReady.length === 1 ? "it" : "them"} out.`,
          HttpStatus.CONFLICT,
          { parcels: notReady.map(({ item, bag }) => ({ trackingId: item.parcel.trackingId, status: item.parcel.status, bag: bag.number })) },
        );
      for (const { bag, item } of items) {
        const parcel = await tx.parcel.findUniqueOrThrow({ where: { id: item.parcel.id } });
        await this.workflow.transition(
          tx,
          parcel,
          {
            to: "IN_TRANSIT",
            actorRole: "ops",
            data: { currentHubId: trip.destHubId },
            title: `In transit to ${trip.destHub.name}`,
            description: `On the way from ${trip.originHub.name} to ${trip.destHub.name} on linehaul manifest ${trip.number} (bag ${bag.number}).`,
            location: trip.originHub.name,
            metadata: {
              kind: "hub_transfer",
              hubId: trip.destHubId,
              fromHubId: trip.originHubId,
              fromHub: trip.originHub.name,
              toHubId: trip.destHubId,
              toHub: trip.destHub.name,
              tripId: trip.id,
              tripNumber: trip.number,
              bagNumber: bag.number,
            },
          },
          actor,
          meta,
          after,
        );
      }
      await tx.linehaulBag.updateMany({ where: { tripId: trip.id }, data: { status: "IN_TRANSIT" } });
      await tx.linehaulTrip.update({ where: { id: trip.id }, data: { status: "DEPARTED", departedAt: new Date() } });
      await this.audit.record(
        actor,
        { action: "linehaul.trip_depart", entityType: "linehaul_trip", entityId: trip.id, data: { trip: trip.number, bags: current.bags.length, parcels: items.length } },
        meta,
        tx,
      );
    }, BIG_TX);
    await this.workflow.flush(after);
    this.publish(trip.number, trip.originHubId, trip.destHubId);
    return this.getTrip(actor, trip.id);
  }

  async arrive(actor: Actor, tripRef: string, meta: RequestMeta) {
    return this.tripStatus(actor, tripRef, "destHubId", ["DEPARTED"], "ARRIVED", "linehaul.trip_arrive", meta, async (tx, trip) => {
      await tx.linehaulTrip.update({ where: { id: trip.id }, data: { status: "ARRIVED", arrivedAt: new Date() } });
    });
  }

  /** Closes an arrived trip: whatever wasn't received is recorded as missing. */
  async close(actor: Actor, tripRef: string, meta: RequestMeta) {
    return this.tripStatus(actor, tripRef, "destHubId", ["ARRIVED"], "CLOSED", "linehaul.trip_close", meta, async (tx, trip) => {
      const now = new Date();
      for (const bag of trip.bags.filter(b => b.status !== "RECEIVED")) {
        for (const item of bag.items.filter(i => i.state === "LOADED")) {
          await tx.linehaulBagItem.update({ where: { id: item.id }, data: { state: "MISSING" } });
          await tx.linehaulDiscrepancy.create({
            data: {
              tripId: trip.id,
              bagId: bag.id,
              parcelId: item.parcel.id,
              trackingId: item.parcel.trackingId,
              hubId: trip.destHubId,
              kind: "MISSING",
              note: `Bag ${bag.number} was not received before ${trip.number} was closed`,
              createdById: userIdOf(actor),
            },
          });
        }
        await tx.linehaulBag.update({ where: { id: bag.id }, data: { status: "RECEIVED", receivedAt: now, receivedById: userIdOf(actor) } });
      }
      await tx.linehaulTrip.update({ where: { id: trip.id }, data: { status: "CLOSED", closedAt: now } });
    });
  }

  async cancel(actor: Actor, tripRef: string, meta: RequestMeta) {
    return this.tripStatus(actor, tripRef, "originHubId", ["PLANNED"], "CANCELLED", "linehaul.trip_cancel", meta, async (tx, trip) => {
      await tx.linehaulBag.updateMany({ where: { tripId: trip.id }, data: { tripId: null } });
      await tx.linehaulTrip.update({ where: { id: trip.id }, data: { status: "CANCELLED" } });
    });
  }

  // ───────────── receiving at the destination ─────────────

  /**
   * Receives a bag at its destination hub. Without trackingIds the whole sealed bag is taken
   * as manifested; with them, unlisted manifest items become MISSING and listed codes that
   * aren't in the bag are recorded as EXTRA. A different seal number is a SEAL_MISMATCH.
   */
  async receive(actor: Actor, bagRef: string, input: z.infer<typeof receiveBagSchema>, meta: RequestMeta) {
    const bag = await this.findBag(this.prisma, bagRef);
    assertHubInScope(actor, input.hubId, "receive bags at this hub");
    if (bag.destHubId !== input.hubId) throw new AppError("WRONG_HUB", `${bag.number} is addressed to ${bag.destHub.name}`, 422);
    const after = this.workflow.newAfterCommit();
    const userId = userIdOf(actor);
    const summary = { received: 0, missing: 0, extra: 0, sealMismatch: false };
    await this.prisma.$transaction(async tx => {
      await this.lockBag(tx, bag.id);
      const current = await this.findBag(tx, bag.id);
      if (current.status !== "IN_TRANSIT") throw conflict("BAG_NOT_IN_TRANSIT", current.status === "RECEIVED" ? `${bag.number} was already received` : `${bag.number} hasn't departed yet`);
      const hub = current.destHub;
      const loaded = current.items.filter(i => i.state === "LOADED");
      let receiveIds: Set<string>;
      const extras: string[] = [];
      if (input.trackingIds) {
        const scanned = new Set<string>();
        for (const code of input.trackingIds) {
          const variants = codeVariants(code);
          const match = current.items.find(i => variants.includes(i.parcel.trackingId));
          if (match) scanned.add(match.id);
          else if (!extras.some(e => variants.includes(e))) extras.push(variants[0]);
        }
        receiveIds = new Set(loaded.filter(i => scanned.has(i.id)).map(i => i.id));
      } else receiveIds = new Set(loaded.map(i => i.id));

      const now = new Date();
      const base = { tripId: current.tripId, bagId: current.id, hubId: hub.id, createdById: userId };
      for (const item of loaded) {
        if (!receiveIds.has(item.id)) {
          await tx.linehaulBagItem.update({ where: { id: item.id }, data: { state: "MISSING" } });
          await tx.linehaulDiscrepancy.create({
            data: { ...base, parcelId: item.parcel.id, trackingId: item.parcel.trackingId, kind: "MISSING", note: input.note ?? `Manifested in ${current.number} but not found when the bag was opened` },
          });
          summary.missing++;
          continue;
        }
        await this.receiveItemTx(tx, actor, current, item, input.source as ScanSource, now, meta, after);
        summary.received++;
      }
      for (const code of extras) {
        const parcel = await tx.parcel.findFirst({ where: { trackingId: { in: codeVariants(code) } }, select: { id: true, trackingId: true } });
        await tx.linehaulDiscrepancy.create({
          data: { ...base, parcelId: parcel?.id, trackingId: parcel?.trackingId ?? code, kind: "EXTRA", note: `Found in ${current.number} but not on its manifest${parcel ? "" : " (unknown tracking ID)"}` },
        });
        await this.scans.record({ code, kind: "BAG_RECEIVE", hubId: hub.id, userId, source: input.source as ScanSource, ok: false, message: `Not on the manifest of ${current.number}` }, tx);
        summary.extra++;
      }
      if (input.sealNo && current.sealNo && input.sealNo !== current.sealNo) {
        await tx.linehaulDiscrepancy.create({ data: { ...base, kind: "SEAL_MISMATCH", note: `Seal ${input.sealNo} on arrival; ${current.sealNo} when sealed at ${current.originHub.name}` } });
        summary.sealMismatch = true;
      }
      await tx.linehaulBag.update({ where: { id: current.id }, data: { status: "RECEIVED", receivedAt: now, receivedById: userId } });
      if (current.tripId) {
        const pending = await tx.linehaulBag.count({ where: { tripId: current.tripId, status: { not: "RECEIVED" } } });
        if (!pending && (await tx.linehaulTrip.updateMany({ where: { id: current.tripId, status: "DEPARTED" }, data: { status: "ARRIVED", arrivedAt: now } })).count)
          await endTripShares(tx, this.audit, actor, current.tripId, "TRIP_ARRIVED", meta);
      }
      await this.audit.record(actor, { action: "linehaul.bag_receive", entityType: "linehaul_bag", entityId: current.id, data: { bag: current.number, hub: hub.code, ...summary } }, meta, tx);
    }, BIG_TX);
    await this.workflow.flush(after);
    this.publish(bag.trip?.number ?? bag.number, bag.originHubId, bag.destHubId);
    return { ...summary, bag: await this.getBag(actor, bag.id) };
  }

  /** One manifested parcel taken out of an in-transit bag at its destination: RECEIVED, the parcel AT_HUB there, a BAG_RECEIVE scan. */
  private async receiveItemTx(tx: Db, actor: Actor, bag: BagFull, item: BagFull["items"][number], source: ScanSource, now: Date, meta: RequestMeta, after: ReturnType<ParcelWorkflowService["newAfterCommit"]>) {
    const hub = bag.destHub;
    await tx.linehaulBagItem.update({ where: { id: item.id }, data: { state: "RECEIVED", receivedAt: now } });
    const parcel = await tx.parcel.findUniqueOrThrow({ where: { id: item.parcel.id } });
    if (parcel.status === "IN_TRANSIT")
      await this.workflow.transition(
        tx,
        parcel,
        {
          to: "AT_HUB",
          actorRole: "ops",
          data: { currentHubId: hub.id, deliveryRiderId: null },
          location: hub.name,
          description: `Received at ${hub.name} from linehaul bag ${bag.number}${bag.trip ? ` (${bag.trip.number})` : ""}.`,
          metadata: { hubId: hub.id, tripId: bag.tripId, tripNumber: bag.trip?.number ?? null, bagNumber: bag.number },
        },
        actor,
        meta,
        after,
      );
    await this.scans.record({ code: parcel.trackingId, kind: "BAG_RECEIVE", hubId: hub.id, userId: userIdOf(actor), source }, tx);
  }

  /**
   * The receive scan at a destination hub (Transfers → Inbound, Hub desk → Receive). Never throws
   * for what was scanned; the outcome says what happened:
   * - a bag label (BG-…): the whole bag is received (its parcels not yet scanned out of it become
   *   AT_HUB here) → BAG_RECEIVED;
   * - a manifest (MF-…) → TRIP: the trip to check against (expected / received per bag);
   * - a tracking ID manifested in an in-transit bag addressed to this hub → RECEIVED (the parcel is
   *   AT_HUB here; the bag is received once its last parcel is scanned, the trip arrives with its
   *   last bag). Not on any inbound manifest → EXTRA (recorded as a discrepancy on the trip / bag
   *   being checked), in a bag for another hub → WRONG_HUB.
   * "Finish" marks the rest of a bag missing: POST /linehaul/bags/:bag/receive { trackingIds: [] }.
   */
  async receiveScan(actor: Actor, input: z.infer<typeof receiveScanSchema>, meta: RequestMeta) {
    assertHubInScope(actor, input.hubId, "receive transfers at this hub");
    const hub = await this.prisma.hub.findUnique({ where: { id: input.hubId }, select: { id: true, name: true, code: true } });
    if (!hub) throw notFound("Hub");
    const userId = userIdOf(actor);
    const variants = codeVariants(input.code);
    const code = variants[0];
    const source = input.source as ScanSource;
    const scan = (ok: boolean, message: string) => this.scans.recordQuietly({ code, kind: "BAG_RECEIVE", hubId: hub.id, userId, source, ok, message });
    const context = await this.receiveContext(input, hub.id);
    const answer = async (outcome: ReceiveScanOutcome, message: string, extra: { bagId?: string | null; tripId?: string | null; parcel?: { trackingId: string; status: string } | null } = {}) => {
      const ok = outcome === "RECEIVED" || outcome === "BAG_RECEIVED" || outcome === "ALREADY_RECEIVED" || outcome === "TRIP";
      const bagId = extra.bagId === undefined ? (context.bag?.id ?? null) : extra.bagId;
      const tripId = extra.tripId === undefined ? (context.trip?.id ?? context.bag?.tripId ?? null) : extra.tripId;
      return {
        outcome,
        ok,
        message,
        code,
        hub,
        parcel: extra.parcel ? { trackingId: extra.parcel.trackingId, status: extra.parcel.status, statusLabel: PARCEL_STATUS_LABEL[extra.parcel.status as ParcelStatus] } : null,
        bag: bagId ? await this.getBag(actor, bagId).catch(() => null) : null,
        trip: tripId ? await this.inboundTrip(tripId) : null,
      };
    };

    // A bag label: receive the whole bag.
    if (/^BG-/i.test(code)) {
      const bag = await this.prisma.linehaulBag.findFirst({ where: { number: code }, include: { destHub: { select: { name: true } } } });
      if (!bag) {
        await scan(false, `No bag ${code}`);
        return answer("NOT_FOUND", `No bag found for ${code}.`);
      }
      if (bag.destHubId !== hub.id) {
        const message = `${bag.number} is addressed to ${bag.destHub.name}, not ${hub.name}. Don't open it here.`;
        await scan(false, message);
        return answer("WRONG_HUB", message, { bagId: null, tripId: null });
      }
      if (bag.status === "RECEIVED") return answer("ALREADY_RECEIVED", `${bag.number} was already received at ${hub.name}.`, { bagId: bag.id, tripId: bag.tripId });
      if (bag.status !== "IN_TRANSIT") {
        const message = `${bag.number} hasn't left its origin hub yet (${bag.status.toLowerCase()}).`;
        await scan(false, message);
        return answer("NOT_IN_TRANSIT", message, { bagId: bag.id, tripId: bag.tripId });
      }
      try {
        const result = await this.receive(actor, bag.id, { hubId: hub.id, source: input.source, sealNo: input.sealNo, note: undefined }, meta);
        const parts = [`${result.received} parcel${result.received === 1 ? "" : "s"} received`];
        if (result.sealMismatch) parts.push("seal mismatch recorded");
        return answer("BAG_RECEIVED", `${bag.number} received at ${hub.name}: ${parts.join(", ")}.`, { bagId: bag.id, tripId: bag.tripId });
      } catch (error) {
        const fresh = await this.prisma.linehaulBag.findUnique({ where: { id: bag.id }, select: { status: true } });
        if (fresh?.status === "RECEIVED") return answer("ALREADY_RECEIVED", `${bag.number} was already received at ${hub.name}.`, { bagId: bag.id, tripId: bag.tripId });
        const message = error instanceof AppError ? (error.getResponse() as { message: string }).message : `${bag.number} couldn't be received.`;
        await scan(false, message);
        return answer("REFUSED", message, { bagId: bag.id, tripId: bag.tripId });
      }
    }

    // A manifest: the trip to check against.
    if (/^MF-/i.test(code)) {
      const trip = await this.prisma.linehaulTrip.findFirst({ where: { number: code }, include: { destHub: { select: { name: true } } } });
      if (!trip) return answer("NOT_FOUND", `No manifest found for ${code}.`, { bagId: null, tripId: null });
      if (trip.destHubId !== hub.id) return answer("WRONG_HUB", `${trip.number} goes to ${trip.destHub.name}, not ${hub.name}.`, { bagId: null, tripId: null });
      return answer("TRIP", `Checking ${trip.number}: scan its bags to receive them whole, or the parcels one by one.`, { bagId: null, tripId: trip.id });
    }

    // A parcel.
    const parcel = await this.prisma.parcel.findFirst({ where: { trackingId: { in: variants } }, select: { id: true, trackingId: true, status: true, currentHubId: true } });
    if (!parcel) {
      await scan(false, `No parcel found for ${code}`);
      return answer("NOT_FOUND", `No parcel or bag found for ${code}.`);
    }
    const items = await this.prisma.linehaulBagItem.findMany({
      where: { parcelId: parcel.id, bag: { status: { in: ["IN_TRANSIT", "RECEIVED"] } } },
      include: { bag: { select: { id: true, number: true, status: true, originHubId: true, destHubId: true, tripId: true, destHub: { select: { name: true } } } } },
      orderBy: { addedAt: "desc" },
    });
    const here = items.filter(i => i.bag.destHubId === hub.id);
    const pending = here.find(i => i.state === "LOADED" && i.bag.status === "IN_TRANSIT");
    if (pending) {
      const after = this.workflow.newAfterCommit();
      let receivedNow = false;
      await this.prisma.$transaction(async tx => {
        await this.lockBag(tx, pending.bag.id);
        const current = await this.findBag(tx, pending.bag.id);
        const item = current.items.find(i => i.id === pending.id);
        if (current.status !== "IN_TRANSIT" || item?.state !== "LOADED") return;
        const now = new Date();
        await this.receiveItemTx(tx, actor, current, item, source, now, meta, after);
        receivedNow = true;
        const left = current.items.filter(i => i.state === "LOADED" && i.id !== item.id).length;
        if (!left) {
          await tx.linehaulBag.update({ where: { id: current.id }, data: { status: "RECEIVED", receivedAt: now, receivedById: userId } });
          if (current.tripId) {
            const open = await tx.linehaulBag.count({ where: { tripId: current.tripId, status: { not: "RECEIVED" } } });
            if (!open && (await tx.linehaulTrip.updateMany({ where: { id: current.tripId, status: "DEPARTED" }, data: { status: "ARRIVED", arrivedAt: now } })).count)
              await endTripShares(tx, this.audit, actor, current.tripId, "TRIP_ARRIVED", meta);
          }
        }
        await this.audit.record(
          actor,
          { action: "linehaul.item_receive", entityType: "linehaul_bag", entityId: current.id, data: { bag: current.number, hub: hub.code, trackingId: parcel.trackingId, bagComplete: !left } },
          meta,
          tx,
        );
      }, BIG_TX);
      await this.workflow.flush(after);
      this.publish(pending.bag.number, pending.bag.originHubId, hub.id);
      const fresh = await this.prisma.parcel.findUniqueOrThrow({ where: { id: parcel.id }, select: { trackingId: true, status: true } });
      if (!receivedNow) return answer("ALREADY_RECEIVED", `${parcel.trackingId} was already received at ${hub.name}.`, { bagId: pending.bag.id, tripId: pending.bag.tripId, parcel: fresh });
      const bag = await this.prisma.linehaulBag.findUniqueOrThrow({ where: { id: pending.bag.id }, include: { items: { select: { state: true } } } });
      const got = bag.items.filter(i => i.state === "RECEIVED").length;
      return answer("RECEIVED", `${parcel.trackingId} received from ${bag.number} (${got} of ${bag.items.length})${bag.status === "RECEIVED" ? `; ${bag.number} is complete` : ""}.`, {
        bagId: bag.id,
        tripId: bag.tripId,
        parcel: fresh,
      });
    }
    const done = here.find(i => i.state === "RECEIVED");
    if (done) return answer("ALREADY_RECEIVED", `${parcel.trackingId} was already received from ${done.bag.number}.`, { bagId: done.bag.id, tripId: done.bag.tripId, parcel });
    const elsewhere = items.find(i => i.state === "LOADED" && i.bag.status === "IN_TRANSIT" && i.bag.destHubId !== hub.id);
    if (elsewhere) {
      const message = `${parcel.trackingId} is manifested in ${elsewhere.bag.number} for ${elsewhere.bag.destHub.name}, not ${hub.name}.`;
      await scan(false, message);
      return answer("WRONG_HUB", message, { parcel });
    }
    // Not on any manifest coming here: an extra parcel, recorded against the trip / bag being checked.
    const against = context.bag ? `the manifest of ${context.bag.number}` : context.trip ? `manifest ${context.trip.number}` : "any manifest coming to this hub";
    const where = { trackingId: parcel.trackingId, kind: "EXTRA" as const, hubId: hub.id, resolvedAt: null, tripId: context.trip?.id ?? context.bag?.tripId ?? null, bagId: context.bag?.id ?? null };
    const recorded = await this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`extra:${hub.id}:${parcel.id}`}))`;
      if (await tx.linehaulDiscrepancy.findFirst({ where })) return false;
      await tx.linehaulDiscrepancy.create({
        data: { ...where, parcelId: parcel.id, createdById: userId, note: `Scanned at ${hub.name} but not on ${against} (status "${PARCEL_STATUS_LABEL[parcel.status as ParcelStatus]}")` },
      });
      await this.audit.record(actor, { action: "linehaul.extra_scan", entityType: "linehaul_discrepancy", data: { trackingId: parcel.trackingId, hub: hub.code, trip: context.trip?.number ?? null, bag: context.bag?.number ?? null } }, meta, tx);
      return true;
    });
    const message = `${parcel.trackingId} is not on ${against}: recorded as an extra parcel${recorded ? "" : " (already recorded)"}. Receive it at the Hub desk if it belongs here.`;
    await scan(false, message);
    if (recorded) this.publish(context.trip?.number ?? context.bag?.number ?? parcel.trackingId, hub.id, hub.id);
    return answer("EXTRA", message, { parcel });
  }

  /** The trip / bag a receive scan is checked against (both must be addressed to the hub). */
  private async receiveContext(input: { tripId?: string; bagId?: string }, hubId: string) {
    const bag = input.bagId ? await this.prisma.linehaulBag.findFirst({ where: isUuid(input.bagId) ? { id: input.bagId } : { number: input.bagId.toUpperCase() }, select: { id: true, number: true, tripId: true, destHubId: true } }) : null;
    const trip = input.tripId ? await this.prisma.linehaulTrip.findFirst({ where: isUuid(input.tripId) ? { id: input.tripId } : { number: input.tripId.toUpperCase() }, select: { id: true, number: true, destHubId: true } }) : null;
    return { bag: bag?.destHubId === hubId ? bag : null, trip: trip?.destHubId === hubId ? trip : null };
  }

  private async inboundTrip(tripId: string) {
    const trip = await this.prisma.linehaulTrip.findUnique({ where: { id: tripId }, include: inboundInclude });
    return trip ? inboundView(trip) : null;
  }

  /**
   * Inbound transfers of my hubs (Transfers → Inbound): trips coming in (planned, on the road,
   * arrived; closed ones of the last two days) with expected / received / missing / still
   * expected parcels per bag. Hub operators: their hubs; managers: one hub or the network.
   */
  async inbound(actor: Actor, query: z.infer<typeof inboundQuerySchema>) {
    const scope = opsHubScope(actor);
    if (scope && query.hubId && !scope.includes(query.hubId)) throw forbidden("You can only see your own hub's inbound transfers");
    const hubs = query.hubId ? [query.hubId] : scope;
    const recent = new Date(Date.now() - 2 * 86_400_000);
    const trips = await this.prisma.linehaulTrip.findMany({
      where: {
        ...(hubs ? { destHubId: { in: hubs } } : {}),
        OR: query.status ? [{ status: query.status }] : [{ status: { in: ["PLANNED", "DEPARTED", "ARRIVED"] } }, { status: "CLOSED", closedAt: { gte: recent } }],
      },
      include: inboundInclude,
      orderBy: [{ departedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      take: 100,
    });
    const items = trips.map(inboundView);
    const sum = (k: "bags" | "expected" | "received" | "missing" | "pending") => items.reduce((n, t) => n + t.totals[k], 0);
    return {
      items,
      totals: { trips: items.length, onTheRoad: items.filter(t => t.status === "DEPARTED").length, bags: sum("bags"), expected: sum("expected"), received: sum("received"), missing: sum("missing"), pending: sum("pending") },
    };
  }

  // ───────────── discrepancies ─────────────

  async listDiscrepancies(actor: Actor, query: z.infer<typeof listDiscrepanciesQuerySchema>) {
    const scope = opsHubScope(actor);
    if (scope && query.hubId && !scope.includes(query.hubId)) throw forbidden("You can only see your own hub's discrepancies");
    const rows = await this.prisma.linehaulDiscrepancy.findMany({
      where: {
        hubId: query.hubId ?? (scope ? { in: scope } : undefined),
        tripId: query.tripId,
        ...(query.open === undefined ? {} : { resolvedAt: query.open ? null : { not: null } }),
      },
      include: { trip: { select: { id: true, number: true } }, bag: { select: { id: true, number: true } } },
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    const hubs = await this.prisma.hub.findMany({ where: { id: { in: [...new Set(page.items.map(d => d.hubId))] } }, select: hubSelect });
    return { items: page.items.map(d => ({ ...discrepancyView(d), trip: d.trip, bag: d.bag, hub: hubs.find(h => h.id === d.hubId) ?? null })), nextCursor: page.nextCursor };
  }

  async resolveDiscrepancy(actor: Actor, id: string, input: z.infer<typeof resolveDiscrepancySchema>, meta: RequestMeta) {
    const d = await this.prisma.linehaulDiscrepancy.findUnique({ where: { id }, include: { trip: { select: { number: true, originHubId: true, destHubId: true } } } });
    if (!d) throw notFound("Discrepancy");
    assertHubInScope(actor, d.hubId, "resolve this hub's discrepancies");
    if (d.resolvedAt) throw conflict("ALREADY_RESOLVED", "This discrepancy was already resolved");
    const updated = await this.prisma.$transaction(async tx => {
      const { count } = await tx.linehaulDiscrepancy.updateMany({ where: { id, resolvedAt: null }, data: { resolvedAt: new Date(), resolvedById: userIdOf(actor), resolution: input.resolution } });
      if (!count) throw conflict("ALREADY_RESOLVED", "This discrepancy was already resolved");
      await this.audit.record(actor, { action: "linehaul.discrepancy_resolve", entityType: "linehaul_discrepancy", entityId: id, data: { kind: d.kind, trackingId: d.trackingId, resolution: input.resolution } }, meta, tx);
      return tx.linehaulDiscrepancy.findUniqueOrThrow({ where: { id } });
    });
    this.publish(d.trip?.number ?? d.id, d.trip?.originHubId ?? d.hubId, d.hubId);
    return discrepancyView(updated);
  }

  // ───────────── helpers ─────────────

  private async tripStatus(
    actor: Actor,
    tripRef: string,
    hubField: "originHubId" | "destHubId",
    from: string[],
    to: string,
    action: string,
    meta: RequestMeta,
    change: (tx: Db, trip: TripFull) => Promise<void>,
  ) {
    const trip = await this.findTrip(this.prisma, tripRef);
    assertHubInScope(actor, trip[hubField], hubField === "originHubId" ? "manage trips from this hub" : "receive trips at this hub");
    await this.prisma.$transaction(async tx => {
      await this.lockTrip(tx, trip.id);
      const current = await this.findTrip(tx, trip.id);
      if (!from.includes(current.status)) throw conflict("INVALID_TRIP_STATUS", `${trip.number} is ${current.status.toLowerCase()} and can't be marked ${to.toLowerCase()}`);
      await change(tx, current);
      // "I'm travelling in this vehicle" ends when the trip arrives, closes or is cancelled.
      const shareEnd = reasonForTripStatus(to);
      if (shareEnd) await endTripShares(tx, this.audit, actor, trip.id, shareEnd, meta);
      await this.audit.record(actor, { action, entityType: "linehaul_trip", entityId: trip.id, data: { trip: trip.number, from: current.status, to } }, meta, tx);
    }, BIG_TX);
    this.publish(trip.number, trip.originHubId, trip.destHubId);
    return this.getTrip(actor, trip.id);
  }

  private hubWhere(actor: Actor, hubId: string | undefined, direction: "outbound" | "inbound" | undefined): Prisma.LinehaulBagWhereInput {
    const scope = opsHubScope(actor);
    if (scope && hubId && !scope.includes(hubId)) throw forbidden("You can only see your own hub's linehaul");
    const hubs = hubId ? [hubId] : scope;
    if (!hubs) return {};
    if (direction === "outbound") return { originHubId: { in: hubs } };
    if (direction === "inbound") return { destHubId: { in: hubs } };
    return { OR: [{ originHubId: { in: hubs } }, { destHubId: { in: hubs } }] };
  }

  private async activeHub(id: string) {
    const hub = await this.prisma.hub.findUnique({ where: { id } });
    if (!hub) throw notFound("Hub");
    if (!hub.active) throw new AppError("HUB_INACTIVE", `${hub.name} isn't operating`, 422);
    return hub;
  }

  async findBag(db: Db, ref: string): Promise<BagFull> {
    const bag = await db.linehaulBag.findFirst({ where: isUuid(ref) ? { id: ref } : { number: ref.trim().toUpperCase() }, include: bagInclude });
    if (!bag) throw notFound(`Bag ${isUuid(ref) ? "" : ref}`.trim());
    return bag;
  }

  async findTrip(db: Db, ref: string): Promise<TripFull> {
    const trip = await db.linehaulTrip.findFirst({ where: isUuid(ref) ? { id: ref } : { number: ref.trim().toUpperCase() }, include: tripInclude });
    if (!trip) throw notFound(`Trip ${isUuid(ref) ? "" : ref}`.trim());
    return trip;
  }

  private async findParcel(db: Db, code: string) {
    const parcel = await db.parcel.findFirst({ where: { trackingId: { in: codeVariants(code) } } });
    if (!parcel) throw new AppError("PARCEL_NOT_FOUND", `No parcel found for ${code.trim().toUpperCase()}`, HttpStatus.NOT_FOUND);
    return parcel;
  }

  /** Row locks serialise concurrent scans and status changes on one bag / trip. */
  lockBag(tx: Db, id: string) {
    return tx.$queryRaw`SELECT id FROM linehaul_bags WHERE id = ${id}::uuid FOR UPDATE`;
  }
  lockTrip(tx: Db, id: string) {
    return tx.$queryRaw`SELECT id FROM linehaul_trips WHERE id = ${id}::uuid FOR UPDATE`;
  }

  publish(id: string, originHubId: string, destHubId: string) {
    this.realtime.publish({ type: "linehaul.updated", id, hubIds: [originHubId, destHubId], staffPermission: "hub:manage" });
  }
}

const userIdOf = (actor: Actor) => (actor.kind === "user" ? actor.userId : null);
