import { HttpStatus, Injectable } from "@nestjs/common";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import type { Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { AppError, notFound } from "../../common/errors";
import { nextNumber } from "../../common/counters";
import type { Prisma } from "../../generated/prisma/client";
import { assertHubInScope } from "../ops/ops-common";
import { LinehaulService } from "./linehaul.service";
import type { TransferOptions } from "./linehaul.schemas";

const ACTIVE_BAG_STATUSES = ["OPEN", "SEALED", "IN_TRANSIT"] as const;
const NOT_COLLECT: Prisma.ParcelWhereInput = { OR: [{ lastMile: null }, { lastMile: { not: "HUB_COLLECT" } }] };
const zoneKey = (district: string | null | undefined, zone: string | null | undefined) => `${(district ?? "").trim().toLowerCase()}|${(zone ?? "").trim().toLowerCase()}`;

export { BAG_LABEL, bagNumberOf } from "./transfer-rules";
import { bagNumberOf } from "./transfer-rules";

export interface TransferResult {
  bags: { number: string; label: string | null; status: string; originHub: string; destHub: string; parcels: number; sealNo: string | null; trip: string | null }[];
  trips: { number: string; destHub: string; created: boolean; bags: number }[];
  problems: string[];
}

/**
 * Hub-to-hub transfers by Excel (the "transfer" bulk action, Transfers page): which parcels at a
 * hub must go to another hub (the recipient zone's serving hub, or the collection hub), putting a
 * row's parcel in a bag (an open bag by number, or the open bag with the row's label for that route,
 * created on first use), and the upload's finishing step: seal the bags and load them on a trip.
 * Parcels stay AT_HUB until the trip departs (LinehaulService.depart), exactly as with scanning.
 */
@Injectable()
export class TransferService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly linehaul: LinehaulService,
  ) {}

  /** Serving hub per delivery zone ("district|zone" → hub id), active zones only. */
  private async zoneHubs() {
    const zones = await this.prisma.deliveryZone.findMany({ where: { active: true, hubId: { not: null } }, select: { district: true, name: true, hubId: true } });
    return new Map(zones.map(z => [zoneKey(z.district, z.name), z.hubId!]));
  }

  /** The hub each parcel should travel to: the collection hub (hub collect), else its delivery zone's serving hub; null = unknown. */
  async destinations(parcels: { id: string; deliveryDistrict: string | null; deliveryZone: string | null; lastMile: string | null; collectHubId: string | null }[]) {
    const zones = await this.zoneHubs();
    return new Map(parcels.map(p => [p.id, (p.lastMile === "HUB_COLLECT" && p.collectHubId) || zones.get(zoneKey(p.deliveryDistrict, p.deliveryZone)) || null]));
  }

  /**
   * Parcels at a hub (the caller's hubs; the network for managers) that must travel to another
   * hub: at hub, not in an active bag, and their destination isn't the hub holding them (parcels
   * whose zone has no serving hub are listed too, to choose a destination by hand).
   */
  async eligibleWhere(scope: string[] | null): Promise<Prisma.ParcelWhereInput> {
    const hubs = scope ?? (await this.prisma.hub.findMany({ select: { id: true } })).map(h => h.id);
    const zones = await this.prisma.deliveryZone.findMany({ where: { active: true, hubId: { in: hubs } }, select: { district: true, name: true, hubId: true } });
    const branches: Prisma.ParcelWhereInput[] = hubs.map(hubId => {
      const own = zones.filter(z => z.hubId === hubId).map(z => ({ deliveryDistrict: { equals: z.district, mode: "insensitive" as const }, deliveryZone: { equals: z.name, mode: "insensitive" as const } }));
      return {
        currentHubId: hubId,
        OR: [{ lastMile: "HUB_COLLECT", OR: [{ collectHubId: null }, { collectHubId: { not: hubId } }] }, { AND: [NOT_COLLECT, ...(own.length ? [{ NOT: { OR: own } }] : [])] }],
      };
    });
    return {
      status: "AT_HUB",
      OR: branches.length ? branches : [{ id: { in: [] } }],
      bagItems: { none: { state: "LOADED", bag: { status: { in: [...ACTIVE_BAG_STATUSES] } } } },
    };
  }

  /** Open bags made up at these hubs, for the Bag dropdown ("BG-… → Destination · label"). */
  async openBags(scope: string[] | null) {
    const bags = await this.prisma.linehaulBag.findMany({
      where: { status: "OPEN", ...(scope ? { originHubId: { in: scope } } : {}) },
      include: { destHub: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: 300,
    });
    return bags.map(b => `${b.number} → ${b.destHub.name}${b.label ? ` · ${b.label}` : ""}`);
  }

  /** Open bags by number with their route (validating Bag cells). */
  bagsByNumber(numbers: string[]) {
    return numbers.length
      ? this.prisma.linehaulBag.findMany({ where: { number: { in: numbers } }, select: { id: true, number: true, status: true, label: true, originHubId: true, destHubId: true } })
      : Promise.resolve([]);
  }

  /** The active bag each parcel is in (validating "already in a bag"). */
  async activeBagOf(parcelIds: string[]) {
    const items = parcelIds.length
      ? await this.prisma.linehaulBagItem.findMany({
          where: { parcelId: { in: parcelIds }, state: "LOADED", bag: { status: { in: [...ACTIVE_BAG_STATUSES] } } },
          select: { parcelId: true, bag: { select: { id: true, number: true, label: true, status: true, destHubId: true } } },
        })
      : [];
    return new Map(items.map(i => [i.parcelId, i.bag]));
  }

  /**
   * One row of a transfer file: the parcel goes into the bag `bag` names (an open bag number), or
   * the open bag with that label on its route (origin = where the parcel is, destination =
   * `destHubId`), created on first use; an empty Bag cell uses `defaultLabel` (the upload's number):
   * one bag per destination per upload. Same checks as scanning a parcel into a bag.
   */
  async addToBag(actor: Actor, input: { parcelId: string; destHubId: string; bag?: string | null; defaultLabel: string; expectedVersion?: number }, meta: RequestMeta) {
    const parcel = await this.prisma.parcel.findUnique({ where: { id: input.parcelId }, select: { id: true, trackingId: true, version: true, currentHubId: true } });
    if (!parcel) throw notFound("Parcel");
    if (input.expectedVersion !== undefined && parcel.version !== input.expectedVersion)
      throw new AppError("PARCEL_CHANGED", `${parcel.trackingId} changed since you downloaded it`, HttpStatus.CONFLICT, { trackingId: parcel.trackingId });
    if (!parcel.currentHubId) throw new AppError("PARCEL_NOT_AT_ORIGIN", `${parcel.trackingId} isn't at a hub`, HttpStatus.CONFLICT);
    const originHubId = parcel.currentHubId;
    assertHubInScope(actor, originHubId, "make up bags at this hub");
    if (originHubId === input.destHubId) throw new AppError("TRANSFER_SAME_HUB", `${parcel.trackingId} is already at its destination hub`, 422);
    const [origin, dest] = await Promise.all([this.prisma.hub.findUnique({ where: { id: originHubId } }), this.prisma.hub.findUnique({ where: { id: input.destHubId } })]);
    if (!origin || !dest) throw notFound("Hub");
    if (!dest.active) throw new AppError("HUB_INACTIVE", `${dest.name} isn't operating`, 422);
    const number = bagNumberOf(input.bag);
    const label = number ? null : (input.bag?.trim() || input.defaultLabel).toUpperCase();
    const userId = actor.kind === "user" ? actor.userId : null;
    let created = false;
    let added = false;
    const bag = await this.prisma.$transaction(async tx => {
      let target: { id: string; number: string; label: string | null };
      if (number) {
        const found = await tx.linehaulBag.findUnique({ where: { number } });
        if (!found) throw new AppError("BAG_NOT_FOUND", `No bag ${number}`, HttpStatus.NOT_FOUND);
        await this.linehaul.lockBag(tx, found.id);
        const current = await tx.linehaulBag.findUniqueOrThrow({ where: { id: found.id } });
        if (current.status !== "OPEN") throw new AppError("BAG_NOT_OPEN", `${number} is ${current.status.toLowerCase().replace("_", " ")}; choose an open bag`, HttpStatus.CONFLICT);
        if (current.originHubId !== originHubId || current.destHubId !== dest.id) {
          const [o, d] = await Promise.all([tx.hub.findUnique({ where: { id: current.originHubId } }), tx.hub.findUnique({ where: { id: current.destHubId } })]);
          throw new AppError("BAG_ROUTE_MISMATCH", `${number} goes ${o?.name} → ${d?.name}, but ${parcel.trackingId} goes ${origin.name} → ${dest.name}`, HttpStatus.CONFLICT);
        }
        target = current;
      } else {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`transfer-bag:${originHubId}:${dest.id}:${label}`}))`;
        const open = await tx.linehaulBag.findFirst({ where: { originHubId, destHubId: dest.id, label, status: "OPEN" }, orderBy: { createdAt: "desc" } });
        if (open) target = open;
        else {
          target = await tx.linehaulBag.create({ data: { number: await nextNumber(tx, "BG"), originHubId, destHubId: dest.id, label, createdById: userId } });
          created = true;
          await this.audit.record(actor, { action: "linehaul.bag_create", entityType: "linehaul_bag", entityId: target.id, data: { number: target.number, from: origin.code, to: dest.code, label } }, meta, tx);
        }
        await this.linehaul.lockBag(tx, target.id);
      }
      const fresh = await tx.parcel.findUniqueOrThrow({ where: { id: parcel.id }, select: { id: true, trackingId: true, status: true, currentHubId: true } });
      added = await this.linehaul.putInBag(tx, actor, { id: target.id, number: target.number, originHubId, originHub: { name: origin.name } }, fresh);
      if (added) await this.audit.record(actor, { action: "linehaul.bag_add", entityType: "linehaul_bag", entityId: target.id, data: { bag: target.number, trackingId: parcel.trackingId, via: "bulk_transfer" } }, meta, tx);
      return target;
    });
    this.linehaul.publish(bag.number, originHubId, dest.id);
    return { added, created, bag: { id: bag.id, number: bag.number, label: bag.label, destHub: dest.name } };
  }

  /** A planned trip from one of the caller's hubs (chosen in the apply dialog). */
  async checkTrip(actor: Actor, tripId: string) {
    const trip = await this.linehaul.getTrip(actor, tripId);
    assertHubInScope(actor, trip.originHub.id, "load trucks at this hub");
    if (trip.status !== "PLANNED") throw new AppError("TRIP_NOT_PLANNED", `${trip.number} has already ${trip.status === "CANCELLED" ? "been cancelled" : "departed"}`, HttpStatus.CONFLICT);
    return trip;
  }

  /**
   * The finishing step of a transfer upload: the open bags holding its parcels are sealed (seal
   * number = the bag number on its printed tag) when asked or when they go on a trip, then loaded
   * on the chosen planned trip (bags on its route) or on new trips, one per route, with the given
   * vehicle and driver. Problems are reported, never thrown: the rows are already in their bags.
   */
  async finish(actor: Actor, parcelIds: string[], options: TransferOptions, meta: RequestMeta): Promise<TransferResult> {
    const problems: string[] = [];
    const message = (error: unknown) => (error instanceof AppError ? (error.getResponse() as { message: string }).message : "unexpected error");
    const bagsOf = () =>
      this.prisma.linehaulBag.findMany({
        where: { items: { some: { parcelId: { in: parcelIds }, state: "LOADED" } }, status: { in: ["OPEN", "SEALED", "IN_TRANSIT"] } },
        include: { originHub: { select: { name: true } }, destHub: { select: { name: true } }, trip: { select: { number: true } }, _count: { select: { items: true } } },
        orderBy: { number: "asc" },
      });
    const trips: TransferResult["trips"] = [];
    if (parcelIds.length) {
      const toTrip = !!(options.tripId || options.newTrip);
      for (const bag of await bagsOf())
        if (bag.status === "OPEN" && (options.seal || toTrip))
          await this.linehaul.seal(actor, bag.id, { sealNo: bag.number }, meta).catch(error => problems.push(`${bag.number} not sealed: ${message(error)}`));
      const sealed = (await bagsOf()).filter(b => b.status === "SEALED" && !b.tripId);
      const load = async (tripId: string, tripNumber: string, bags: typeof sealed) => {
        let loaded = 0;
        for (const bag of bags)
          await this.linehaul
            .addBagToTrip(actor, tripId, { bag: bag.id, source: "MANUAL" }, meta)
            .then(() => loaded++)
            .catch(error => problems.push(`${bag.number} not loaded on ${tripNumber}: ${message(error)}`));
        return loaded;
      };
      if (options.tripId) {
        try {
          const trip = await this.linehaul.getTrip(actor, options.tripId);
          const fits = sealed.filter(b => b.originHubId === trip.originHub.id && b.destHubId === trip.destHub.id);
          for (const b of sealed.filter(x => !fits.includes(x))) problems.push(`${b.number} goes ${b.originHub.name} → ${b.destHub.name}; ${trip.number} runs ${trip.originHub.name} → ${trip.destHub.name}. Load it on another trip.`);
          trips.push({ number: trip.number, destHub: trip.destHub.name, created: false, bags: await load(trip.id, trip.number, fits) });
        } catch (error) {
          problems.push(`Trip not used: ${message(error)}`);
        }
      } else if (options.newTrip) {
        const routes = new Map<string, typeof sealed>();
        for (const b of sealed) routes.set(`${b.originHubId}|${b.destHubId}`, [...(routes.get(`${b.originHubId}|${b.destHubId}`) ?? []), b]);
        for (const bags of routes.values()) {
          try {
            const trip = await this.linehaul.createTrip(actor, { originHubId: bags[0].originHubId, destHubId: bags[0].destHubId, note: `Transfer by Excel`, ...options.newTrip }, meta);
            trips.push({ number: trip.number, destHub: trip.destHub.name, created: true, bags: await load(trip.id, trip.number, bags) });
          } catch (error) {
            problems.push(`No trip to ${bags[0].destHub.name}: ${message(error)}`);
          }
        }
      }
    }
    const bags = parcelIds.length ? await bagsOf() : [];
    return {
      bags: bags.map(b => ({ number: b.number, label: b.label, status: b.status, originHub: b.originHub.name, destHub: b.destHub.name, parcels: b._count.items, sealNo: b.sealNo, trip: b.trip?.number ?? null })),
      trips,
      problems,
    };
  }
}
