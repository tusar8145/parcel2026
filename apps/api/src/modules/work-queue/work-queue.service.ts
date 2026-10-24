import { HttpStatus, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { parcelStatusLabel, type ParcelStatus } from "@delivery-fast/shared";
import { PrismaService } from "../../common/prisma.service";
import { AppError, forbidden, notFound } from "../../common/errors";
import type { Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import type { Prisma } from "../../generated/prisma/client";
import { opsHubScope } from "../parcels/ops-scope";
import { forHubsWhere } from "../parcels/parcel-stages";
import { ParcelsService } from "../parcels/parcels.service";
import { HubIntakeService } from "../ops/hub-intake.service";
import { codeVariants } from "../ops/ops-common";
import { TransferService } from "../linehaul/transfer.service";
import { writeXlsx, STYLE, type Cell } from "../imports/xlsx/xlsx-writer";
import { MISSING_DETAILS, QUEUE_TASKS, taskByKey, type QueueTask } from "./work-queue.tasks";
import type { queueListQuerySchema, queueQuerySchema, queueScanSchema } from "./work-queue.schemas";

/** Most parcels one task loads (the counts and groups say when a task has more). */
const MAX_ROWS = 10_000;
/** Most parcels one list returns on screen (the Excel file has them all, up to MAX_ROWS). */
const MAX_LIST = 1_000;

const riderSelect = { select: { id: true, code: true, hubId: true, user: { select: { name: true } } } } as const;
const parcelSelect = {
  id: true,
  trackingId: true,
  status: true,
  intake: true,
  lastMile: true,
  missingFields: true,
  currentHubId: true,
  dropOffHubId: true,
  collectHubId: true,
  pickupHubId: true,
  pickupZone: true,
  pickupDistrict: true,
  deliveryZone: true,
  deliveryDistrict: true,
  deliveryArea: true,
  recipientName: true,
  recipientPhone: true,
  senderName: true,
  codAmount: true,
  createdAt: true,
  updatedAt: true,
  merchant: { select: { name: true } },
  pickupRider: riderSelect,
  deliveryRider: riderSelect,
} satisfies Prisma.ParcelSelect;
type Row = Prisma.ParcelGetPayload<{ select: typeof parcelSelect }>;
type Rider = Row["pickupRider"];

interface QueueRow extends Row {
  group: { key: string; label: string; fromHubId?: string | null; toHubId?: string | null };
  /** RECEIVE: the hub expected to receive it. */
  receiveHubId: string | null;
  /** Transfers: where it comes from / goes to. */
  fromHubId: string | null;
  toHubId: string | null;
}

const place = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(", ");
const riderLabel = (r: Rider) => (r ? `${r.user.name} (${r.code})` : null);

/**
 * The Courier Operations work queue (see work-queue.tasks.ts): the next step of every parcel in the
 * actor's scope, counted, grouped, listed, exported to Excel, and done by scanning (through
 * ParcelsService / HubIntakeService, so every lifecycle rule, scope check, SMS and webhook applies).
 */
@Injectable()
export class WorkQueueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly parcels: ParcelsService,
    private readonly intake: HubIntakeService,
    private readonly transfers: TransferService,
  ) {}

  /** Every task with its count, and the missing-details count shown apart. */
  async overview(actor: Actor, query: z.infer<typeof queueQuerySchema>) {
    const hubIds = this.hubFilter(actor, query.hubId);
    const tasks = await Promise.all(
      QUEUE_TASKS.map(async task => ({
        key: task.key,
        label: task.label,
        hint: task.hint,
        stage: task.stage,
        action: task.action,
        actionLabel: task.actionLabel ?? null,
        count: await this.count(task, hubIds),
      })),
    );
    return { tasks, missingDetails: { key: MISSING_DETAILS.key, label: MISSING_DETAILS.label, hint: MISSING_DETAILS.hint, count: await this.count(MISSING_DETAILS, hubIds) } };
  }

  /** One task's groups (route, area, rider, hub…), largest first. */
  async groups(actor: Actor, key: string, query: z.infer<typeof queueQuerySchema>) {
    const task = this.task(key);
    const { rows, truncated } = await this.rows(task, this.hubFilter(actor, query.hubId));
    const groups = new Map<string, { key: string; label: string; count: number; fromHubId?: string | null; toHubId?: string | null }>();
    for (const r of rows) {
      const g = groups.get(r.group.key) ?? { ...r.group, count: 0 };
      g.count++;
      groups.set(r.group.key, g);
    }
    return {
      task: this.taskView(task),
      total: rows.length,
      truncated,
      groups: [...groups.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    };
  }

  /** The parcels of a task (or of one group), oldest first. */
  async list(actor: Actor, key: string, query: z.infer<typeof queueListQuerySchema>) {
    const task = this.task(key);
    const { rows } = await this.rows(task, this.hubFilter(actor, query.hubId));
    const picked = query.group ? rows.filter(r => r.group.key === query.group) : rows;
    const hubs = await this.hubNames();
    return { task: this.taskView(task), total: picked.length, items: picked.slice(0, MAX_LIST).map(r => this.view(r, hubs)) };
  }

  /** The same parcels as an Excel file. */
  async export(actor: Actor, key: string, query: z.infer<typeof queueListQuerySchema>) {
    const task = this.task(key);
    const { rows } = await this.rows(task, this.hubFilter(actor, query.hubId));
    const picked = query.group ? rows.filter(r => r.group.key === query.group) : rows;
    const hubs = await this.hubNames();
    const groupLabel = query.group ? (picked[0]?.group.label ?? "") : "";
    const header = ["Tracking ID", "Status", "Group", "Merchant / sender", "Recipient", "Recipient phone", "Delivery area", "Pickup area", "Current hub", "From hub", "To hub", "Rider", "COD (BDT)", "Missing details", "Waiting since", "Booked"];
    const out: Cell[][] = [header.map(value => ({ value, style: STYLE.headerOptional }))];
    for (const r of picked) {
      const v = this.view(r, hubs);
      out.push([
        v.trackingId,
        v.statusLabel,
        v.group,
        v.merchant,
        v.recipient,
        v.recipientPhone,
        v.destination,
        v.pickup,
        v.currentHub,
        v.fromHub,
        v.toHub,
        v.rider,
        v.codAmount,
        v.missing.join(", "),
        v.waitingSince.toISOString().slice(0, 16).replace("T", " "),
        v.createdAt.toISOString().slice(0, 10),
      ]);
    }
    const buffer = writeXlsx({
      title: task.label,
      sheets: [{ name: "Parcels", rows: out, widths: [20, 22, 34, 26, 22, 16, 30, 26, 22, 22, 22, 26, 12, 22, 18, 12], freezeHeader: true, autoFilter: true }],
    });
    const slug = `${task.key}${groupLabel ? `-${groupLabel}` : ""}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80);
    return { buffer, fileName: `work-queue-${slug}-${new Date().toISOString().slice(0, 10)}.xlsx`, count: picked.length };
  }

  /**
   * One scan: the parcel must be waiting for this task (and in the chosen group); then the task's step
   * is done through the existing services. Never throws for a parcel problem: the answer says what happened.
   */
  async scan(actor: Actor, key: string, input: z.infer<typeof queueScanSchema>, meta: RequestMeta) {
    const task = this.task(key);
    if (!task.action) throw new AppError("NO_SCAN_ACTION", `"${task.label}" can't be done by scanning`, HttpStatus.UNPROCESSABLE_ENTITY);
    if ((task.action === "ASSIGN_PICKUP" || task.action === "ASSIGN_DELIVERY") && !input.riderId) throw new AppError("RIDER_REQUIRED", "Choose the rider first", HttpStatus.UNPROCESSABLE_ENTITY);
    const variants = codeVariants(input.code);
    const hubIds = this.hubFilter(actor);
    const { rows } = await this.rows(task, hubIds, { trackingId: { in: variants } });
    const row = rows[0];
    const answer = (ok: boolean, outcome: string, message: string, extra: Record<string, unknown> = {}) => ({ ok, outcome, message, code: variants[0], ...extra });

    if (!row) {
      const parcel = await this.prisma.parcel.findFirst({ where: { trackingId: { in: variants } }, select: { trackingId: true, status: true, intake: true } });
      if (!parcel) return answer(false, "NOT_FOUND", `No parcel found for ${variants[0]}.`);
      return answer(false, "NOT_IN_QUEUE", `${parcel.trackingId} isn't waiting for "${task.label}"${hubIds ? " at your hub" : ""}. It's ${parcelStatusLabel(parcel.status as ParcelStatus, { intake: parcel.intake }).toLowerCase()}.`);
    }
    if (input.group && row.group.key !== input.group) return answer(false, "OTHER_GROUP", `${row.trackingId} belongs to ${row.group.label}, not this list.`, { group: row.group });

    const hubs = await this.hubNames();
    try {
      switch (task.action) {
        case "ASSIGN_PICKUP":
          await this.parcels.assignPickup(actor, row.trackingId, { riderId: input.riderId!, note: undefined }, meta);
          return answer(true, "DONE", `${row.trackingId} assigned to ${await this.riderName(input.riderId!)} for pickup.`, { parcel: this.view(row, hubs) });
        case "ASSIGN_DELIVERY":
          await this.parcels.assignDelivery(actor, row.trackingId, { riderId: input.riderId!, note: undefined }, meta);
          return answer(true, "DONE", `${row.trackingId} assigned to ${await this.riderName(input.riderId!)} for delivery.`, { parcel: this.view(row, hubs) });
        case "OUT_FOR_DELIVERY":
          await this.parcels.setStatus(actor, row.trackingId, { status: "OUT_FOR_DELIVERY", note: undefined }, meta, { code: input.code, source: input.source });
          return answer(true, "DONE", `${row.trackingId} is out for delivery with ${riderLabel(row.deliveryRider) ?? "the rider"}.`, { parcel: this.view(row, hubs) });
        case "SEND": {
          if (!row.toHubId) return answer(false, "NO_DESTINATION", `No hub serves ${place(row.deliveryZone, row.deliveryDistrict) || "this parcel's delivery area"} yet. Set the zone's serving hub, or send it from Transfers by hand.`);
          await this.parcels.setStatus(actor, row.trackingId, { status: "IN_TRANSIT", hubId: row.toHubId, note: undefined }, meta, { code: input.code, source: input.source });
          return answer(true, "DONE", `${row.trackingId} dispatched to ${hubs.get(row.toHubId) ?? "the destination hub"}.`, { parcel: this.view(row, hubs) });
        }
        case "RECEIVE": {
          const hubId = input.hubId ?? row.receiveHubId;
          if (!hubId) return answer(false, "HUB_REQUIRED", `Choose the hub receiving ${row.trackingId}.`);
          // Transfers and drop-offs are expected at one hub: another hub can't receive them here.
          if ((task.key === "transfer-receive" || task.key === "dropoff-receive") && row.receiveHubId && hubId !== row.receiveHubId)
            return answer(false, "WRONG_HUB", `${row.trackingId} is going to ${hubs.get(row.receiveHubId) ?? "another hub"}, not ${hubs.get(hubId) ?? "this hub"}.`);
          const r = await this.intake.receive(actor, { code: input.code, hubId, source: input.source, note: undefined }, meta);
          return answer(r.ok, r.ok ? "DONE" : r.outcome, r.message, { parcel: this.view(row, hubs) });
        }
      }
    } catch (error) {
      if (error instanceof AppError) return answer(false, "REFUSED", `${row.trackingId}: ${error.message}`);
      throw error;
    }
  }

  // ───────────── loading ─────────────

  private task(key: string) {
    const task = taskByKey(key);
    if (!task) throw notFound("Work queue task");
    return task;
  }

  private taskView(task: QueueTask) {
    return { key: task.key, label: task.label, hint: task.hint, stage: task.stage, action: task.action, actionLabel: task.actionLabel ?? null };
  }

  /** The hubs the actor works for (null = the network), narrowed to one hub on request. */
  private hubFilter(actor: Actor, hubId?: string) {
    const scope = opsHubScope(actor);
    if (!hubId) return scope;
    if (scope && !scope.includes(hubId)) throw forbidden("You can only see your own hub's work");
    return [hubId];
  }

  /** The task's filter within the hubs (null = network). */
  private async where(task: QueueTask, hubIds: string[] | null): Promise<Prisma.ParcelWhereInput> {
    if (task.key === "transfer-send") return this.transfers.eligibleWhere(hubIds);
    // Transfers on the way: the origin is known only after loading (bag / transfer event).
    if (!hubIds || task.key === "transfer-receive") return task.where;
    const mine = (await forHubsWhere(this.prisma, hubIds)).OR ?? [];
    return { AND: [task.where, { OR: [...(Array.isArray(mine) ? mine : [mine]), { pickupHubId: { in: hubIds } }, { collectHubId: { in: hubIds } }] }] };
  }

  private async count(task: QueueTask, hubIds: string[] | null) {
    if (task.refine || task.key === "transfer-receive") return (await this.rows(task, hubIds)).rows.length;
    return this.prisma.parcel.count({ where: await this.where(task, hubIds) });
  }

  private async rows(task: QueueTask, hubIds: string[] | null, extra?: Prisma.ParcelWhereInput) {
    const where = await this.where(task, hubIds);
    const found = await this.prisma.parcel.findMany({ where: extra ? { AND: [where, extra] } : where, select: parcelSelect, orderBy: [{ updatedAt: "asc" }, { id: "asc" }], take: MAX_ROWS + 1 });
    const truncated = found.length > MAX_ROWS;
    const list = found.slice(0, MAX_ROWS);
    const needsDestination = task.groupBy === "route" || task.refine === "localDelivery";
    const destinations = needsDestination && task.key !== "transfer-receive" ? await this.transfers.destinations(list) : new Map<string, string | null>();
    const origins = task.key === "transfer-receive" ? await this.transferOrigins(list.map(r => r.id)) : new Map<string, string | null>();
    const hubs = await this.hubNames();

    let rows: QueueRow[] = list.map(r => {
      const toHubId = task.key === "transfer-receive" ? r.currentHubId : (destinations.get(r.id) ?? null);
      const fromHubId = task.key === "transfer-receive" ? (origins.get(r.id) ?? null) : r.currentHubId;
      return { ...r, toHubId, fromHubId, receiveHubId: this.receiveHub(task, r), group: this.groupOf(task, r, hubs, fromHubId, toHubId) };
    });
    if (task.refine === "localDelivery") rows = rows.filter(r => r.toHubId && r.toHubId === r.currentHubId);
    // Only the destination hub receives a transfer: the sending hub follows it in Transfers › On the road.
    if (task.key === "transfer-receive" && hubIds) rows = rows.filter(r => !!r.toHubId && hubIds.includes(r.toHubId));
    return { rows, truncated };
  }

  /** Where parcels on the way between hubs left from: their bag's origin, else the last transfer event. */
  private async transferOrigins(parcelIds: string[]) {
    const origins = new Map<string, string | null>();
    if (!parcelIds.length) return origins;
    const items = await this.prisma.linehaulBagItem.findMany({
      where: { parcelId: { in: parcelIds }, state: "LOADED", bag: { status: { in: ["SEALED", "IN_TRANSIT"] } } },
      select: { parcelId: true, bag: { select: { originHubId: true } } },
    });
    for (const i of items) origins.set(i.parcelId, i.bag.originHubId);
    const rest = parcelIds.filter(id => !origins.has(id));
    if (rest.length) {
      const events = await this.prisma.trackingEvent.findMany({ where: { parcelId: { in: rest }, status: "IN_TRANSIT" }, select: { parcelId: true, metadata: true }, orderBy: { createdAt: "desc" } });
      for (const e of events) {
        if (origins.has(e.parcelId)) continue;
        const from = (e.metadata as { fromHubId?: string } | null)?.fromHubId;
        if (from) origins.set(e.parcelId, from);
      }
    }
    return origins;
  }

  private receiveHub(task: QueueTask, r: Row) {
    switch (task.key) {
      case "dropoff-receive":
        return r.dropOffHubId;
      case "transfer-receive":
      case "failed-receive":
        return r.currentHubId;
      case "pickup-out":
      case "pickup-receive":
        return r.pickupHubId ?? r.pickupRider?.hubId ?? null;
      default:
        return null;
    }
  }

  private groupOf(task: QueueTask, r: Row, hubs: Map<string, string>, fromHubId: string | null, toHubId: string | null): QueueRow["group"] {
    const hub = (id: string | null | undefined, none: string) => (id ? (hubs.get(id) ?? "Unknown hub") : none);
    switch (task.groupBy) {
      case "pickupArea":
        return { key: `area:${r.pickupDistrict}|${r.pickupZone}`, label: place(r.pickupZone, r.pickupDistrict) || "No pickup area" };
      case "pickupRider":
        return r.pickupRider ? { key: `rider:${r.pickupRider.id}`, label: riderLabel(r.pickupRider)! } : { key: "rider:none", label: "No rider" };
      case "deliveryRider":
        return r.deliveryRider ? { key: `rider:${r.deliveryRider.id}`, label: riderLabel(r.deliveryRider)! } : { key: "rider:none", label: "No rider" };
      case "dropOffHub":
        return { key: `hub:${r.dropOffHubId ?? "none"}`, label: hub(r.dropOffHubId, "No drop-off hub") };
      case "collectHub":
        return { key: `hub:${r.collectHubId ?? "none"}`, label: hub(r.collectHubId, "No collection hub") };
      case "currentHub":
        return { key: `hub:${r.currentHubId ?? "none"}`, label: hub(r.currentHubId, "Not at a hub") };
      case "merchant":
        return { key: `merchant:${r.merchant?.name ?? "-"}`, label: r.merchant?.name ?? "Website & walk-in customers" };
      case "route":
        return { key: `route:${fromHubId ?? "none"}>${toHubId ?? "none"}`, label: `${hub(fromHubId, "Unknown hub")} → ${hub(toHubId, "No serving hub")}`, fromHubId, toHubId };
      case "deliveryArea":
        return { key: `area:${r.currentHubId ?? "none"}|${r.deliveryDistrict}|${r.deliveryZone}`, label: `${hub(r.currentHubId, "Not at a hub")} · ${place(r.deliveryZone, r.deliveryDistrict) || "No area"}` };
    }
  }

  private async riderName(id: string) {
    return riderLabel(await this.prisma.rider.findUnique({ where: { id }, ...riderSelect })) ?? "the rider";
  }

  private async hubNames() {
    return new Map((await this.prisma.hub.findMany({ select: { id: true, name: true } })).map(h => [h.id, h.name]));
  }

  private view(r: QueueRow, hubs: Map<string, string>) {
    const hub = (id: string | null) => (id ? (hubs.get(id) ?? null) : null);
    return {
      trackingId: r.trackingId,
      status: r.status,
      statusLabel: parcelStatusLabel(r.status as ParcelStatus, { intake: r.intake, dropOffHubName: hub(r.dropOffHubId) }),
      group: r.group.label,
      groupKey: r.group.key,
      merchant: r.merchant?.name ?? r.senderName,
      recipient: r.recipientName,
      recipientPhone: r.recipientPhone,
      destination: place(r.deliveryArea, r.deliveryZone, r.deliveryDistrict),
      pickup: place(r.pickupZone, r.pickupDistrict),
      currentHub: hub(r.currentHubId),
      fromHub: hub(r.fromHubId),
      toHub: hub(r.toHubId),
      rider: riderLabel(r.deliveryRider) ?? riderLabel(r.pickupRider),
      codAmount: Number(r.codAmount),
      missing: r.missingFields,
      waitingSince: r.updatedAt,
      createdAt: r.createdAt,
    };
  }
}
