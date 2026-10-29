import { Injectable } from "@nestjs/common";
import type { z } from "zod";
import { SERVICE_LEVEL_LABEL, parcelStatusLabel, type ParcelStatus } from "@paira-express/shared";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import type { Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { AppError, forbidden, notFound } from "../../common/errors";
import { pageArgs, toPage } from "../../common/pagination";
import type { Prisma } from "../../generated/prisma/client";
import { ParcelsService } from "../parcels/parcels.service";
import { opsHubScope } from "../parcels/ops-scope";
import { ScansService } from "../scans/scans.service";
import { HubDeskService } from "../parcels/hub-desk.service";
import { LinehaulService } from "../linehaul/linehaul.service";
import { assertHubInScope, codeVariants } from "./ops-common";
import type { hubReceiveSchema, labelsSchema, listBatchesQuerySchema } from "./hub-intake.schemas";

/** What happened to one scan at the receive desk. */
export type ReceiveOutcome = "RECEIVED" | "BAG_RECEIVED" | "ALREADY_RECEIVED" | "WRONG_HUB" | "NOT_FOUND" | "NOT_DROP_OFF" | "REFUSED" | "EXTRA" | "TRIP" | "NOT_IN_TRANSIT";

/** Statuses a parcel can only reach after arriving at a hub (pickup imports count these as received). */
const ARRIVED: ParcelStatus[] = ["AT_HUB", "ASSIGNED", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "RETRY_SCHEDULED", "RETURN_SCHEDULED", "RETURNED"];

const batchInclude = {
  hub: { select: { id: true, code: true, name: true } },
} satisfies Prisma.BookingBatchInclude;

/**
 * Hub drop-off intake: receiving parcels at the hub console (scan or typed ID), booking batches
 * (expected vs received per spreadsheet import) and shipping-label data.
 */
@Injectable()
export class HubIntakeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly parcels: ParcelsService,
    private readonly scans: ScansService,
    private readonly audit: AuditService,
    private readonly linehaul: LinehaulService,
    private readonly desk: HubDeskService,
  ) {}

  // ───────────── receive desk ─────────────

  /**
   * One scan or typed ID. Drop-off parcels are received at their declared hub; other parcels take
   * the regular hub scan-in (AT_HUB). Never throws for a parcel-level problem: the outcome says
   * what to tell the person scanning, and every scan is recorded for scan compliance.
   */
  async receive(actor: Actor, input: z.infer<typeof hubReceiveSchema>, meta: RequestMeta) {
    assertHubInScope(actor, input.hubId, "receive parcels at this hub");
    const hub = await this.prisma.hub.findUnique({ where: { id: input.hubId }, select: { id: true, name: true, active: true } });
    if (!hub) throw notFound("Hub");
    const batch = input.batchId ? await this.prisma.bookingBatch.findUnique({ where: { id: input.batchId }, select: { id: true } }) : null;
    if (input.batchId && !batch) throw notFound("Booking batch");

    const variants = codeVariants(input.code);
    const find = () =>
      this.prisma.parcel.findFirst({
        where: { trackingId: { in: variants } },
        include: { dropOffHub: { select: { id: true, name: true } }, merchant: { select: { name: true } }, currentHub: { select: { id: true, name: true } } },
      });
    const userId = actor.kind === "user" ? actor.userId : null;
    const scan = (ok: boolean, message: string) =>
      this.scans.recordQuietly({ code: input.code, kind: "HUB_RECEIVE", hubId: hub.id, userId, source: input.source, ok, message });

    const result = async (outcome: ReceiveOutcome, message: string, parcel?: Awaited<ReturnType<typeof find>>, transfer?: Awaited<ReturnType<LinehaulService["receiveScan"]>>) => ({
      outcome,
      ok: outcome === "RECEIVED" || outcome === "ALREADY_RECEIVED" || outcome === "BAG_RECEIVED" || outcome === "TRIP",
      /** Linehaul: the bag / trip the scan was received from (expected vs received), when it was a transfer. */
      transfer: transfer ? { bag: transfer.bag, trip: transfer.trip } : null,
      message,
      code: variants[0],
      hub: { id: hub.id, name: hub.name },
      parcel: parcel
        ? {
            trackingId: parcel.trackingId,
            status: parcel.status,
            statusLabel: parcelStatusLabel(parcel.status as ParcelStatus, { intake: parcel.intake, dropOffHubName: parcel.dropOffHub?.name }),
            intake: parcel.intake,
            dropOffHub: parcel.dropOffHub,
            currentHub: parcel.currentHub,
            merchant: parcel.merchant?.name ?? parcel.senderName,
            recipient: parcel.recipientName,
            destination: [parcel.deliveryZone, parcel.deliveryDistrict].filter(Boolean).join(", "),
            codAmount: Number(parcel.codAmount),
            batchId: parcel.bookingBatchId,
            inBatch: input.batchId ? parcel.bookingBatchId === input.batchId : undefined,
          }
        : null,
      batch: batch ? await this.batchProgress(batch.id) : null,
    });

    // Linehaul transfers: a bag label (whole bag), a manifest, or a parcel manifested in a bag coming to this hub go through linehaul receiving.
    const viaLinehaul = async () => {
      const r = await this.linehaul.receiveScan(actor, { hubId: hub.id, code: input.code, source: input.source }, meta);
      return result(r.outcome, r.message, r.parcel ? ((await find()) ?? undefined) : undefined, r);
    };
    if (/^(BG|MF)-/i.test(variants[0])) return viaLinehaul();

    let parcel = await find();
    if (parcel?.status === "IN_TRANSIT" && (await this.prisma.linehaulBagItem.count({ where: { parcelId: parcel.id, state: "LOADED", bag: { status: "IN_TRANSIT", destHubId: hub.id } } }))) return viaLinehaul();
    if (!parcel) {
      const label = await this.prisma.cnStock.findFirst({ where: { cn: { in: variants } }, select: { cn: true, status: true } });
      const message = label ? `${label.cn} is a pre-printed label that hasn't been booked yet. Book the parcel first.` : `No parcel found for ${variants[0]}.`;
      void scan(false, message);
      return result("NOT_FOUND", message);
    }
    const id = parcel.trackingId;
    if (parcel.status === "AT_HUB" && parcel.currentHubId === hub.id) {
      void scan(true, "Already at this hub");
      return result("ALREADY_RECEIVED", `${id} was already received at ${hub.name}.`, parcel);
    }
    const awaitingDropOff = parcel.status === "PENDING_CONFIRMATION" && parcel.intake === "DROP_OFF";
    if (awaitingDropOff && parcel.dropOffHubId !== hub.id) {
      const message = `${id} is booked for drop-off at ${parcel.dropOffHub?.name ?? "another hub"}, not ${hub.name}. Don't receive it here.`;
      void scan(false, message);
      return result("WRONG_HUB", message, parcel);
    }
    if (parcel.status === "PENDING_CONFIRMATION" && parcel.intake !== "DROP_OFF") {
      const message = `${id} is booked for rider pickup, not drop-off. Accept it and assign a pickup rider instead.`;
      void scan(false, message);
      return result("NOT_DROP_OFF", message, parcel);
    }

    // Coming back from a rider (failed delivery, given to a rider but not taken out, unfinished return): the hub desk's
    // receive-back rules (the rider released, the return run left). Still out for delivery: the failed attempt first.
    // A parcel with no rider (e.g. a re-attempt not given to anyone yet) is received the regular way below.
    if ((["RETRY_SCHEDULED", "ASSIGNED", "OUT_FOR_DELIVERY"].includes(parcel.status) && parcel.deliveryRiderId) || (parcel.status === "RETURN_SCHEDULED" && parcel.returnRunId)) {
      const back = await this.desk.receiveBack(actor, { code: id, hubId: hub.id, source: input.source }, meta);
      void scan(back.ok, back.message);
      parcel = (await find()) ?? parcel;
      return result(back.ok && back.outcome === "RECEIVED" ? "RECEIVED" : back.ok ? "ALREADY_RECEIVED" : "REFUSED", back.message, parcel);
    }

    try {
      // The regular hub scan-in path (drop-offs: ParcelWorkflowService.receiveDropOff records the scan in the transaction).
      await this.parcels.setStatus(actor, id, { status: "AT_HUB", hubId: hub.id, note: input.note, expectedVersion: parcel.version }, meta, { code: input.code, source: input.source });
      if (!awaitingDropOff) void scan(true, "Received at hub");
    } catch (error) {
      // Two scans of the same label at once: the second one finds it already received.
      parcel = (await find()) ?? parcel;
      if (parcel.status === "AT_HUB" && parcel.currentHubId === hub.id) return result("ALREADY_RECEIVED", `${id} was already received at ${hub.name}.`, parcel);
      const message = error instanceof AppError ? (error.getResponse() as { message: string }).message : `${id} couldn't be received.`;
      void scan(false, message);
      return result("REFUSED", message, parcel);
    }
    parcel = (await find()) ?? parcel;
    return result("RECEIVED", awaitingDropOff ? `${id} received at ${hub.name} (drop-off).` : `${id} received at ${hub.name}.`, parcel);
  }

  // ───────────── booking batches ─────────────

  /** Spreadsheet imports, newest first, with expected / received counts (hub operators: their hubs' and their own). */
  async listBatches(actor: Actor, query: z.infer<typeof listBatchesQuerySchema>) {
    const scope = opsHubScope(actor);
    if (scope && query.hubId && !scope.includes(query.hubId)) throw forbidden("You can only see your own hub's imports");
    const where: Prisma.BookingBatchWhereInput = {
      intake: query.intake,
      ...(query.hubId ? { hubId: query.hubId } : scope ? { OR: [{ hubId: { in: scope } }, { createdById: actor.kind === "user" ? actor.userId : undefined }] } : {}),
    };
    const rows = await this.prisma.bookingBatch.findMany({ where, include: batchInclude, ...pageArgs(query) });
    const page = toPage(rows, query.limit);
    const progress = await this.progressFor(page.items.map(b => ({ id: b.id, intake: b.intake })));
    return { items: page.items.map(b => this.batchView(b, progress.get(b.id))), nextCursor: page.nextCursor };
  }

  /** One import with every parcel and whether it has arrived. */
  async batchDetail(actor: Actor, id: string) {
    const batch = await this.prisma.bookingBatch.findUnique({ where: { id }, include: batchInclude });
    if (!batch || !this.canSeeBatch(actor, batch)) throw notFound("Booking batch");
    const parcels = await this.prisma.parcel.findMany({
      where: { bookingBatchId: id },
      orderBy: { createdAt: "asc" },
      select: {
        trackingId: true,
        status: true,
        intake: true,
        droppedOffAt: true,
        recipientName: true,
        deliveryZone: true,
        deliveryDistrict: true,
        merchantOrderRef: true,
        codAmount: true,
        dropOffHub: { select: { name: true } },
        currentHub: { select: { id: true, name: true } },
        merchant: { select: { name: true } },
        senderName: true,
      },
    });
    const progress = await this.progressFor([{ id: batch.id, intake: batch.intake }]);
    return {
      ...this.batchView(batch, progress.get(batch.id)),
      parcels: parcels.map(p => ({
        trackingId: p.trackingId,
        status: p.status,
        statusLabel: parcelStatusLabel(p.status as ParcelStatus, { intake: p.intake, dropOffHubName: p.dropOffHub?.name }),
        received: this.arrived(p, batch.intake),
        cancelled: p.status === "PICKUP_CANCELLED",
        droppedOffAt: p.droppedOffAt,
        currentHub: p.currentHub,
        merchant: p.merchant?.name ?? p.senderName,
        recipient: p.recipientName,
        destination: [p.deliveryZone, p.deliveryDistrict].filter(Boolean).join(", "),
        merchantOrderRef: p.merchantOrderRef,
        codAmount: Number(p.codAmount),
      })),
    };
  }

  private canSeeBatch(actor: Actor, batch: { hubId: string | null; createdById: string | null }) {
    const scope = opsHubScope(actor);
    return !scope || (!!batch.hubId && scope.includes(batch.hubId)) || (actor.kind === "user" && batch.createdById === actor.userId);
  }

  private arrived(p: { status: string; droppedOffAt: Date | null }, intake: string) {
    return intake === "DROP_OFF" ? !!p.droppedOffAt : !!p.droppedOffAt || ARRIVED.includes(p.status as ParcelStatus);
  }

  private async batchProgress(id: string) {
    const batch = await this.prisma.bookingBatch.findUniqueOrThrow({ where: { id }, include: batchInclude });
    return this.batchView(batch, (await this.progressFor([{ id, intake: batch.intake }])).get(id));
  }

  /** Expected (booked and not cancelled) and received parcels per batch. */
  private async progressFor(batches: { id: string; intake: string }[]) {
    const ids = batches.map(b => b.id);
    const [byStatus, dropped] = ids.length
      ? await Promise.all([
          this.prisma.parcel.groupBy({ by: ["bookingBatchId", "status"], where: { bookingBatchId: { in: ids } }, _count: { _all: true } }),
          this.prisma.parcel.groupBy({ by: ["bookingBatchId"], where: { bookingBatchId: { in: ids }, droppedOffAt: { not: null } }, _count: { _all: true } }),
        ])
      : [[], []];
    const out = new Map<string, { booked: number; cancelled: number; expected: number; received: number; missing: number }>();
    for (const b of batches) {
      const rows = byStatus.filter(r => r.bookingBatchId === b.id);
      const booked = rows.reduce((n, r) => n + r._count._all, 0);
      const cancelled = rows.filter(r => r.status === "PICKUP_CANCELLED").reduce((n, r) => n + r._count._all, 0);
      const droppedOff = dropped.find(r => r.bookingBatchId === b.id)?._count._all ?? 0;
      const received = b.intake === "DROP_OFF" ? droppedOff : rows.filter(r => ARRIVED.includes(r.status as ParcelStatus)).reduce((n, r) => n + r._count._all, 0);
      const expected = booked - cancelled;
      out.set(b.id, { booked, cancelled, expected, received, missing: Math.max(0, expected - received) });
    }
    return out;
  }

  private batchView(b: Prisma.BookingBatchGetPayload<{ include: typeof batchInclude }>, progress = { booked: 0, cancelled: 0, expected: 0, received: 0, missing: 0 }) {
    return {
      id: b.id,
      number: b.number,
      intake: b.intake,
      hub: b.hub,
      fileName: b.fileName,
      rows: { sent: b.rowCount, booked: b.bookedCount, failed: b.failedCount },
      ...progress,
      createdAt: b.createdAt,
    };
  }

  // ───────────── labels ─────────────

  /**
   * Everything printed on a shipping label: tracking ID / CN, merchant, recipient, COD to collect,
   * weight, service, origin and destination hubs. Recorded in the audit log (who printed what).
   */
  async labels(actor: Actor, input: z.infer<typeof labelsSchema>, meta: RequestMeta) {
    const wanted = [...new Set(input.trackingIds.flatMap(codeVariants))];
    const parcels = await this.prisma.parcel.findMany({
      where: { trackingId: { in: wanted } },
      include: {
        merchant: { select: { name: true, code: true } },
        dropOffHub: { select: { id: true, code: true, name: true } },
        currentHub: { select: { id: true, code: true, name: true } },
        bookingBatch: { select: { number: true } },
        cnStock: { select: { cn: true } },
      },
    });
    // Zones served by a hub: origin (pickup zone) and destination (delivery zone).
    const zoneKeys = [...new Set(parcels.flatMap(p => [`${p.pickupDistrict}|${p.pickupZone}`, `${p.deliveryDistrict}|${p.deliveryZone}`]))].map(k => k.split("|"));
    const zones = zoneKeys.length
      ? await this.prisma.deliveryZone.findMany({
          where: { OR: zoneKeys.map(([district, name]) => ({ district, name })), active: true },
          select: { district: true, name: true, code: true, hub: { select: { id: true, code: true, name: true } } },
        })
      : [];
    const zoneOf = (district: string, name: string) => zones.find(z => z.district.toLowerCase() === district.toLowerCase() && z.name.toLowerCase() === name.toLowerCase());
    const order = new Map(input.trackingIds.map((id, i) => [id.trim().toUpperCase(), i]));
    const labels = parcels
      .map(p => {
        const destination = p.deliveryDistrict && p.deliveryZone ? zoneOf(p.deliveryDistrict, p.deliveryZone) : undefined;
        const origin = p.dropOffHub ?? zoneOf(p.pickupDistrict, p.pickupZone)?.hub ?? p.currentHub ?? null;
        return {
          trackingId: p.trackingId,
          cn: p.cnStock?.cn ?? null,
          merchant: p.merchant?.name ?? p.senderName,
          merchantCode: p.merchant?.code ?? null,
          merchantOrderRef: p.merchantOrderRef,
          sender: { name: p.senderName, phone: p.senderPhone },
          recipient: { name: p.recipientName, phone: p.recipientPhone },
          address: { street: p.deliveryStreet, area: p.deliveryArea, zone: p.deliveryZone, district: p.deliveryDistrict },
          codAmount: Number(p.codAmount),
          weightKg: Number(p.weightKg),
          type: p.type,
          serviceLevel: p.serviceLevel,
          serviceLevelLabel: SERVICE_LEVEL_LABEL[p.serviceLevel],
          intake: p.intake,
          originHub: origin,
          destination: { zone: p.deliveryZone, district: p.deliveryDistrict, zoneCode: destination?.code ?? null, hub: destination?.hub ?? null },
          batch: p.bookingBatch?.number ?? null,
          instructions: p.instructions,
          bookedAt: p.createdAt,
          /** Imported with delivery details missing: the label can go on the parcel, delivery waits for the details. */
          incomplete: p.incomplete,
          missingFields: p.missingFields,
        };
      })
      .sort((a, b) => (order.get(a.trackingId) ?? 1e9) - (order.get(b.trackingId) ?? 1e9));
    const found = new Set(labels.map(l => l.trackingId));
    const missing = input.trackingIds.filter(id => !codeVariants(id).some(v => found.has(v)));
    if (labels.length)
      await this.audit.record(actor, { action: "parcel.labels_print", entityType: "parcel", data: { trackingIds: labels.map(l => l.trackingId).slice(0, 500) } }, meta);
    return { labels, missing };
  }
}
