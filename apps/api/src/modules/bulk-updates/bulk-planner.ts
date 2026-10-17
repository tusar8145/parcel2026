import {
  bdPhoneProblem,
  canTransition,
  INTAKE_CHANGEABLE_STATUSES,
  normalizeBdPhone,
  PARCEL_STATUS_LABEL,
  parcelStatusLabel,
  parseParcelStatus,
  SERVICE_LEVEL_LABEL,
  SERVICE_LEVELS,
  TERMINAL_STATUSES,
  type ParcelStatus,
  type ServiceLevel,
} from "@delivery-fast/shared";
import { createHash } from "node:crypto";
import type { Hub, Parcel, Prisma, Rider } from "../../generated/prisma/client";
import type { Catalog } from "../pricing/pricing.service";
import { resolvePlace } from "../parcels/places";
import { describeMissing, missingFor, type MissingField } from "../parcels/incomplete";
import { ACTION_LABEL, DETAIL_KEYS, headerOf, parseAction, parseSettableStatus, riderCodeOf, type BulkAction, type BulkColumnKey } from "./bulk-columns";

export type BulkRowCells = Partial<Record<BulkColumnKey, string>>;
export interface Problem {
  column: string;
  message: string;
}

/** The completion a row asks for, in the shape of POST /parcels/:id/complete. */
export interface DetailsBody {
  recipient?: { name?: string; phone?: string };
  delivery?: { street?: string; area?: string; district?: string; zone?: string };
  weightKg?: number;
  serviceLevel?: ServiceLevel;
}

/** What a checked row resolved to; applying uses exactly this. */
export interface BulkPlan {
  riderId?: string;
  riderLabel?: string;
  usedSuggestion?: boolean;
  status?: ParcelStatus;
  hubId?: string;
  hubName?: string;
  note?: string;
  details?: DetailsBody;
  /** Rows that re-price the parcel (completion, intake change): its charge now → after applying (the preview; set by the service). */
  price?: { before: number; after: number; difference: number };
}

export interface CheckedRow {
  rowNumber: number;
  status: "READY" | "WARNING" | "ERROR" | "ALREADY_DONE";
  action: BulkAction | null;
  trackingId: string | null;
  parcelId: string | null;
  expectedVersion: number | null;
  priority: number;
  cells: BulkRowCells;
  plan: BulkPlan | null;
  errors: Problem[];
  warnings: Problem[];
  result: string | null;
  dedupeKey: string | null;
}

export type PlannerParcel = Parcel & {
  pickupRider: (Rider & { user: { name: string } }) | null;
  deliveryRider: (Rider & { user: { name: string } }) | null;
  currentHub: Pick<Hub, "id" | "name"> | null;
  dropOffHub: Pick<Hub, "id" | "name"> | null;
};
export type PlannerRider = Rider & { user: { name: string; status: string }; hub: Pick<Hub, "id" | "name"> | null; load: number };

export const PARCEL_RELATIONS = {
  pickupRider: { include: { user: { select: { name: true } } } },
  deliveryRider: { include: { user: { select: { name: true } } } },
  currentHub: { select: { id: true, name: true } },
  dropOffHub: { select: { id: true, name: true } },
} satisfies Prisma.ParcelInclude;

const RIDER_ACTIONS: BulkAction[] = ["ACCEPT_PICKUP", "ASSIGN_DELIVERY"];
const HUB_ACTIONS: BulkAction[] = ["SET_STATUS", "RECEIVE_AT_HUB", "TO_DROP_OFF", ...RIDER_ACTIONS];
const NOTE_REQUIRED: BulkAction[] = ["CANCEL", "SCHEDULE_RETURN", "ADD_NOTE"];
const MISSING_COLUMN: Record<MissingField, BulkColumnKey> = {
  recipientName: "set_recipient_name",
  recipientPhone: "set_recipient_phone",
  address: "set_address",
  district: "set_district",
  zone: "set_zone",
};
const STAFF_LOCKED: ParcelStatus[] = [...TERMINAL_STATUSES, "OUT_FOR_DELIVERY"];
const DEFAULT_DAILY_CAPACITY = 40;
const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
export const riderLabel = (r: { code: string; user: { name: string } }) => `${r.code} · ${r.user.name}`;
export const statusLabelOf = (p: Pick<PlannerParcel, "status" | "intake" | "dropOffHub">) => parcelStatusLabel(p.status as ParcelStatus, { intake: p.intake, dropOffHubName: p.dropOffHub?.name });

/**
 * The rules of a bulk update row, shared by the preview (dry run) and the apply step (which
 * re-checks "already done" before calling the parcel services; the services enforce the rest).
 * One planner per check: it remembers riders' planned loads and the parcels already used.
 */
export class BulkPlanner {
  private readonly ridersByCode = new Map<string, PlannerRider>();
  private readonly hubs: Pick<Hub, "id" | "name" | "code" | "active">[];
  private readonly planned = new Map<string, number>();
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ctx: {
      parcels: Map<string, PlannerParcel>;
      inScope: Set<string>;
      riders: PlannerRider[];
      hubs: Pick<Hub, "id" | "name" | "code" | "active">[];
      catalog: Catalog;
      /** Hub operators' hubs; null = the whole network. */
      scope: string[] | null;
    },
  ) {
    for (const r of ctx.riders) this.ridersByCode.set(r.code.toUpperCase(), r);
    this.hubs = ctx.hubs;
  }

  findParcel(trackingId: string) {
    const typed = trackingId.trim().toUpperCase();
    return this.ctx.parcels.get(typed) ?? this.ctx.parcels.get(typed.replace(/\s+/g, ""));
  }

  hubName = (id: string | null | undefined) => (id ? (this.hubs.find(h => h.id === id)?.name ?? "another hub") : "no hub");

  private findHub(value: string) {
    const v = norm(value);
    return this.hubs.find(h => norm(h.name) === v || norm(h.code) === v || norm(`${h.name} (${h.code})`) === v);
  }

  check(rowNumber: number, cells: BulkRowCells): CheckedRow {
    const errors: Problem[] = [];
    const warnings: Problem[] = [];
    const err = (column: string, message: string) => errors.push({ column, message });
    const warn = (column: string, message: string) => warnings.push({ column, message });
    const base: CheckedRow = { rowNumber, status: "ERROR", action: null, trackingId: cells.tracking_id ?? null, parcelId: null, expectedVersion: null, priority: 0, cells, plan: null, errors, warnings, result: null, dedupeKey: null };

    const action = cells.action ? parseAction(cells.action) : undefined;
    if (!action) err("action", `"${cells.action}" is not an action: choose one from the list`);
    base.action = action ?? null;
    const priority = cells.priority ? (norm(cells.priority) === "high" ? 1 : norm(cells.priority) === "normal" ? 0 : null) : 0;
    if (priority === null) err("priority", "Choose Normal or High");
    base.priority = priority ?? 0;

    const versionText = cells.version?.trim();
    const version = versionText && /^\d+$/.test(versionText) ? Number(versionText) : null;
    base.expectedVersion = version;

    let parcel: PlannerParcel | undefined;
    if (!cells.tracking_id?.trim()) err("tracking_id", "The tracking ID is empty");
    else {
      parcel = this.findParcel(cells.tracking_id);
      if (!parcel) err("tracking_id", `Unknown tracking ID "${cells.tracking_id.trim()}"`);
      else if (!this.ctx.inScope.has(parcel.id)) {
        err("tracking_id", `${parcel.trackingId} isn't part of your hubs' work`);
        parcel = undefined;
      } else {
        base.trackingId = parcel.trackingId;
        base.parcelId = parcel.id;
        const first = this.seen.get(parcel.id);
        if (first !== undefined) err("tracking_id", `${parcel.trackingId} already has an action in row ${first}: one row per parcel`);
        else this.seen.set(parcel.id, rowNumber);
      }
    }
    if (!action || !parcel) return base;
    if (versionText && version === null) err("version", "The version was changed: download a fresh file");
    if (!versionText) warn("version", "No version (not a downloaded file?): changes made since can't be detected");

    // Columns the action doesn't read.
    const detailFilled = DETAIL_KEYS.filter(k => cells[k]?.trim());
    if (detailFilled.length && action !== "COMPLETE_DETAILS" && action !== "ASSIGN_DELIVERY")
      err(detailFilled[0], `The Set … columns are only used by "${ACTION_LABEL.COMPLETE_DETAILS}" (or "${ACTION_LABEL.ASSIGN_DELIVERY}")`);
    if (cells.rider?.trim() && !RIDER_ACTIONS.includes(action)) warn("rider", `Ignored: "${ACTION_LABEL[action]}" doesn't use a rider`);
    if (cells.new_status?.trim() && action !== "SET_STATUS") warn("new_status", `Ignored: only "${ACTION_LABEL.SET_STATUS}" uses it`);
    if (cells.hub?.trim() && !HUB_ACTIONS.includes(action)) warn("hub", `Ignored: "${ACTION_LABEL[action]}" doesn't use a hub`);
    const note = cells.note?.trim() || undefined;
    if (note && note.length > 500) err("note", "Use at most 500 characters");
    if (NOTE_REQUIRED.includes(action) && !note) err("note", action === "ADD_NOTE" ? "Write the note" : `Give the reason for "${ACTION_LABEL[action]}"`);

    const plan: BulkPlan = { note };
    const done = this.planAction(action, parcel, cells, plan, err, warn);
    base.plan = plan;
    base.dedupeKey = createHash("sha256").update(JSON.stringify([parcel.id, version, action, plan])).digest("hex");
    if (done && !errors.length) {
      base.status = "ALREADY_DONE";
      base.result = `Already done: ${done}`;
      return base;
    }
    if (version !== null && version !== parcel.version) {
      const message = `${parcel.trackingId} changed since you downloaded it: now "${statusLabelOf(parcel)}"${this.ridersText(parcel)}. Download a fresh file for it`;
      if (action === "ADD_NOTE") warn("version", message);
      else err("version", message);
    }
    base.status = errors.length ? "ERROR" : warnings.length ? "WARNING" : "READY";
    return base;
  }

  private ridersText(p: PlannerParcel) {
    const parts = [p.pickupRider ? `pickup ${riderLabel(p.pickupRider)}` : "", p.deliveryRider ? `delivery ${riderLabel(p.deliveryRider)}` : ""].filter(Boolean);
    return parts.length ? ` (${parts.join(", ")})` : "";
  }

  /** Validates the action for this parcel and fills `plan`; returns why it is already done, if it is. */
  private planAction(action: BulkAction, p: PlannerParcel, cells: BulkRowCells, plan: BulkPlan, err: (c: string, m: string) => void, warn: (c: string, m: string) => void): string | null {
    const status = p.status as ParcelStatus;
    const label = statusLabelOf(p);
    const can = (to: ParcelStatus) => canTransition(status, to, "ops", { intake: p.intake });
    const scope = this.ctx.scope;
    const hubAccess = () => {
      if (scope && p.currentHubId && !scope.includes(p.currentHubId)) err("tracking_id", `${p.trackingId} is at ${this.hubName(p.currentHubId)}. Only that hub or an operations manager can update it`);
    };
    const hubCell = () => {
      const value = cells.hub?.trim();
      if (!value) return null;
      const hub = this.findHub(value);
      if (!hub) err("hub", `Unknown hub "${value}" (choose one from the list)`);
      else if (!hub.active) err("hub", `${hub.name} isn't operating`);
      return hub ?? null;
    };

    switch (action) {
      case "ACCEPT_PICKUP": {
        const rider = this.rider(cells, plan, err, warn, "pickup", p);
        if (rider && (status === "PICKUP_ASSIGNED" || status === "PICKUP_CONFIRMED") && p.pickupRiderId === rider.id) return `pickup already assigned to ${riderLabel(rider)}`;
        if (p.intake === "DROP_OFF" && status === "PENDING_CONFIRMATION")
          err("action", `${p.trackingId} is booked for drop-off at ${p.dropOffHub?.name ?? "a hub"}: use "${ACTION_LABEL.RECEIVE_AT_HUB}" when it arrives (or "${ACTION_LABEL.TO_PICKUP}" first)`);
        else if (!can("PICKUP_ASSIGNED")) err("action", `A parcel that is "${label}" can't get a pickup rider`);
        return null;
      }
      case "ASSIGN_DELIVERY": {
        const rider = this.rider(cells, plan, err, warn, "delivery", p);
        if (rider && (status === "ASSIGNED" || status === "OUT_FOR_DELIVERY") && p.deliveryRiderId === rider.id) return `already assigned to ${riderLabel(rider)} for delivery`;
        if (!can("ASSIGNED")) err("action", `A parcel that is "${label}" can't be assigned for delivery (it must be at a hub)`);
        hubAccess();
        const details = this.details(cells, p, err);
        if (details.body) plan.details = details.body;
        for (const field of missingFor(details.next, "ASSIGNED"))
          err(MISSING_COLUMN[field], `${p.trackingId} needs the ${describeMissing([field])} before a delivery rider: fill ${headerOf(MISSING_COLUMN[field])} (or complete it first)`);
        return null;
      }
      case "SET_STATUS": {
        const raw = cells.new_status?.trim();
        const to = raw ? parseSettableStatus(raw) : undefined;
        if (!raw) {
          err("new_status", "Choose the new status");
          return null;
        }
        if (!to) {
          const parsed = parseParcelStatus(raw);
          const hint: Partial<Record<ParcelStatus, string>> = {
            DELIVERED: "Delivered is set only by the rider, with proof and COD",
            PICKUP_ASSIGNED: `use "${ACTION_LABEL.ACCEPT_PICKUP}"`,
            ASSIGNED: `use "${ACTION_LABEL.ASSIGN_DELIVERY}"`,
            PICKUP_CANCELLED: `use "${ACTION_LABEL.CANCEL}"`,
            RETURN_SCHEDULED: `use "${ACTION_LABEL.SCHEDULE_RETURN}"`,
            PENDING_CONFIRMATION: "a parcel can't go back to pending",
          };
          err("new_status", parsed ? `"${PARCEL_STATUS_LABEL[parsed]}" can't be set here: ${hint[parsed] ?? "choose one from the list"}` : `"${raw}" is not a status (choose one from the list)`);
          return null;
        }
        plan.status = to;
        const hub = hubCell();
        if (to === "AT_HUB" || to === "IN_TRANSIT") {
          const hubId = hub?.id ?? (to === "AT_HUB" && status === "PENDING_CONFIRMATION" ? p.dropOffHubId : p.currentHubId);
          if (to === "AT_HUB" && !hubId) err("hub", "Choose the hub the parcel is at");
          if (hubId) {
            plan.hubId = hubId;
            plan.hubName = this.hubName(hubId);
          }
        } else if (hub) warn("hub", `Ignored for "${PARCEL_STATUS_LABEL[to]}"`);
        if (status === to && (!plan.hubId || plan.hubId === p.currentHubId)) return `already "${label}"`;
        this.statusRules(p, to, plan, err, "new_status");
        return null;
      }
      case "RECEIVE_AT_HUB": {
        const hub = hubCell();
        const hubId = hub?.id ?? (p.intake === "DROP_OFF" && status === "PENDING_CONFIRMATION" ? p.dropOffHubId : scope?.length === 1 ? scope[0] : null);
        if (!hubId) {
          if (!cells.hub?.trim()) err("hub", "Choose the hub that received it");
          return null;
        }
        plan.status = "AT_HUB";
        plan.hubId = hubId;
        plan.hubName = this.hubName(hubId);
        if (status === "AT_HUB" && p.currentHubId === hubId) return `already at ${plan.hubName}`;
        this.statusRules(p, "AT_HUB", plan, err, "action");
        return null;
      }
      case "CANCEL":
        if (status === "PICKUP_CANCELLED") return "already cancelled";
        if (!can("PICKUP_CANCELLED")) err("action", `A parcel that is "${label}" can't be cancelled (only before pickup): use "${ACTION_LABEL.SCHEDULE_RETURN}"`);
        return null;
      case "SCHEDULE_RETURN":
        if (status === "RETURN_SCHEDULED" || status === "RETURNED") return `already "${label}"`;
        if (!can("RETURN_SCHEDULED")) err("action", `A parcel that is "${label}" can't be returned now (it must be at a hub, or have a failed delivery)`);
        else hubAccess();
        return null;
      case "TO_DROP_OFF": {
        const hub = hubCell();
        const hubId = hub?.id ?? (scope?.length === 1 ? scope[0] : null);
        if (!hubId) {
          if (!cells.hub?.trim()) err("hub", "Choose the drop-off hub");
          return null;
        }
        plan.hubId = hubId;
        plan.hubName = this.hubName(hubId);
        if (p.intake === "DROP_OFF" && p.dropOffHubId === hubId) return `already a drop-off at ${plan.hubName}`;
        this.intakeRules(p, err);
        if (scope && !scope.includes(hubId)) err("hub", `You can only switch parcels to drop-off at your own hub`);
        return null;
      }
      case "TO_PICKUP":
        if (p.intake === "PICKUP") return "already a rider pickup";
        this.intakeRules(p, err);
        return null;
      case "COMPLETE_DETAILS": {
        const details = this.details(cells, p, err);
        if (!DETAIL_KEYS.some(k => cells[k]?.trim())) {
          err("action", "Fill at least one Set … column");
          return null;
        }
        if (STAFF_LOCKED.includes(status)) err("action", `${p.trackingId} is "${label}"; its details can no longer change`);
        hubAccess();
        if (!details.body) return p.incomplete ? "these are already the order's details" : "the details are already complete";
        plan.details = details.body;
        if (!p.incomplete) err("action", `${p.trackingId} already has every delivery detail; correct it with Edit details on the parcel`);
        return null;
      }
      case "ADD_NOTE":
        return null;
    }
  }

  /** The lifecycle, hub and detail rules of a status change by operations (like ParcelsService.setStatus). */
  private statusRules(p: PlannerParcel, to: ParcelStatus, plan: BulkPlan, err: (c: string, m: string) => void, column: "new_status" | "action") {
    const status = p.status as ParcelStatus;
    const label = statusLabelOf(p);
    const scope = this.ctx.scope;
    if (!canTransition(status, to, "ops", { intake: p.intake })) {
      if (status === "PENDING_CONFIRMATION" && to === "AT_HUB")
        err("action", `${p.trackingId} is booked for rider pickup: assign a pickup rider; only drop-offs are received at a hub before pickup`);
      else err(column, `A parcel that is "${label}" can't be changed to "${PARCEL_STATUS_LABEL[to]}"`);
      return;
    }
    if (status === "PENDING_CONFIRMATION" && to === "AT_HUB" && plan.hubId && plan.hubId !== p.dropOffHubId)
      err("hub", `${p.trackingId} is booked for drop-off at ${p.dropOffHub?.name ?? "another hub"}. Receive it there`);
    if (to === "AT_HUB" && plan.hubId) {
      if (scope && !scope.includes(plan.hubId)) err("hub", "You can only receive parcels at your own hub");
    } else if (scope && p.currentHubId && !scope.includes(p.currentHubId))
      err("tracking_id", `${p.trackingId} is at ${this.hubName(p.currentHubId)}. Only that hub or an operations manager can update it`);
    const missing = missingFor(p, to);
    if (missing.length) err("action", `${p.trackingId} still needs the ${describeMissing(missing)}: complete the order first`);
    if (to === "OUT_FOR_DELIVERY" && !p.deliveryRiderId && !p.pickupRiderId) err("new_status", "Assign a delivery rider first");
  }

  private intakeRules(p: PlannerParcel, err: (c: string, m: string) => void) {
    const status = p.status as ParcelStatus;
    if (!INTAKE_CHANGEABLE_STATUSES.includes(status)) err("action", `${p.trackingId} is "${statusLabelOf(p)}": pickup and drop-off can only be switched before the parcel is picked up or received`);
    const scope = this.ctx.scope;
    if (scope && p.dropOffHubId && !scope.includes(p.dropOffHubId)) err("tracking_id", `${p.trackingId} is booked for drop-off at ${p.dropOffHub?.name ?? "another hub"}. Only that hub or an operations manager can change it`);
    if (scope && p.pickupRider?.hubId && !scope.includes(p.pickupRider.hubId)) err("tracking_id", `${p.trackingId}'s pickup rider works at another hub. Only that hub or an operations manager can change it`);
  }

  /** The rider of a rider action: the Rider column, else the suggestion; active, in scope; warnings for shift and capacity. */
  private rider(cells: BulkRowCells, plan: BulkPlan, err: (c: string, m: string) => void, warn: (c: string, m: string) => void, kind: "pickup" | "delivery", p: PlannerParcel) {
    const typed = cells.rider?.trim();
    const value = typed || cells.suggested_rider?.trim();
    if (!value) {
      err("rider", "Choose a rider (or keep the suggested one)");
      return null;
    }
    const rider = this.ridersByCode.get(riderCodeOf(value));
    const column = typed ? "rider" : "suggested_rider";
    if (!rider) {
      err(column, `Unknown rider "${value}" (choose one from the list)`);
      return null;
    }
    const label = riderLabel(rider);
    if (!rider.active || rider.user.status !== "ACTIVE") {
      err(column, `${label} isn't active`);
      return null;
    }
    const scope = this.ctx.scope;
    if (scope && (!rider.hubId || !scope.includes(rider.hubId))) {
      err(column, `${label} works at ${rider.hub?.name ?? "no hub"}: you can only assign your own hubs' riders`);
      return null;
    }
    plan.riderId = rider.id;
    plan.riderLabel = label;
    if (!typed) plan.usedSuggestion = true;
    const hubFilter = cells.hub?.trim() ? this.findHub(cells.hub) : undefined;
    if (hubFilter && rider.hubId !== hubFilter.id) warn(column, `${label} isn't a rider of ${hubFilter.name} (the Hub column)`);
    if (kind === "delivery" && p.currentHubId && rider.hubId && rider.hubId !== p.currentHubId) warn(column, `${label} is based at ${rider.hub?.name ?? "another hub"}; the parcel is at ${this.hubName(p.currentHubId)}`);
    if (rider.status !== "ONLINE") warn(column, `${label} is ${rider.status === "ON_BREAK" ? "on a break" : "off shift"}`);
    const already = kind === "pickup" ? p.pickupRiderId === rider.id : p.deliveryRiderId === rider.id;
    if (!already) {
      const capacity = rider.dailyCapacity ?? DEFAULT_DAILY_CAPACITY;
      const load = rider.load + (this.planned.get(rider.id) ?? 0) + 1;
      if (load > capacity) warn(column, `${label} would have ${load} open stops (capacity ${capacity})`);
      this.planned.set(rider.id, (this.planned.get(rider.id) ?? 0) + 1);
    }
    return rider;
  }

  /** The Set … columns as a completion (only values that differ), checked like the completion form. */
  private details(cells: BulkRowCells, p: PlannerParcel, err: (c: string, m: string) => void) {
    const body: DetailsBody = {};
    const next = { recipientName: p.recipientName, recipientPhone: p.recipientPhone, deliveryStreet: p.deliveryStreet, deliveryDistrict: p.deliveryDistrict, deliveryZone: p.deliveryZone };
    const v = (k: BulkColumnKey) => cells[k]?.trim() || undefined;
    const name = v("set_recipient_name");
    if (name) {
      if (name.length > 120) err("set_recipient_name", "Use at most 120 characters");
      else if (name !== p.recipientName) (body.recipient ??= {}).name = next.recipientName = name;
    }
    const phone = v("set_recipient_phone");
    if (phone) {
      const problem = bdPhoneProblem(phone);
      if (problem) err("set_recipient_phone", problem);
      else {
        const e164 = normalizeBdPhone(phone);
        if (e164 !== p.recipientPhone) (body.recipient ??= {}).phone = next.recipientPhone = e164;
      }
    }
    const street = v("set_address");
    if (street) {
      if (street.length > 200) err("set_address", "Use at most 200 characters");
      else if (street !== p.deliveryStreet) (body.delivery ??= {}).street = next.deliveryStreet = street;
    }
    const area = v("set_area");
    if (area) {
      if (area.length > 120) err("set_area", "Use at most 120 characters");
      else if (area !== p.deliveryArea) (body.delivery ??= {}).area = area;
    }
    const district = v("set_district");
    const zone = v("set_zone");
    if (district || zone) {
      const d = district ?? p.deliveryDistrict;
      const z = zone ?? (district && norm(district) !== norm(p.deliveryDistrict) ? null : p.deliveryZone);
      const place = resolvePlace(this.ctx.catalog, d, z);
      if (!place.ok) err(place.column === "district" ? "set_district" : "set_zone", place.message);
      else {
        if (place.district && place.district !== p.deliveryDistrict) (body.delivery ??= {}).district = next.deliveryDistrict = place.district;
        if (place.zone && place.zone !== p.deliveryZone) (body.delivery ??= {}).zone = next.deliveryZone = place.zone;
        if (district && !place.zone && !zone) err("set_zone", `Choose the zone of ${place.district}`);
      }
    }
    const weight = v("set_weight");
    if (weight) {
      const n = Number(weight.replace(/kg/i, "").replace(",", ".").trim());
      if (!Number.isFinite(n) || n <= 0 || n > 50) err("set_weight", "Enter a weight from 0.01 to 50 kg");
      else if (n !== Number(p.weightKg)) body.weightKg = n;
    }
    const service = v("set_service");
    if (service) {
      const level = SERVICE_LEVELS.find(s => norm(SERVICE_LEVEL_LABEL[s]) === norm(service) || s === service.toUpperCase().replace(/\s+/g, "_"));
      if (!level) err("set_service", "Choose Regular, Same day or Express");
      else if (level !== p.serviceLevel) body.serviceLevel = level;
    }
    return { body: Object.keys(body).length ? body : undefined, next };
  }

  /**
   * Apply time: is the change already made (by this file uploaded earlier, or another way)?
   * The same rules as the preview, against the parcel as it is now.
   */
  static doneMessage(action: BulkAction, p: PlannerParcel, plan: BulkPlan): string | null {
    const status = p.status as ParcelStatus;
    switch (action) {
      case "ACCEPT_PICKUP":
        return (status === "PICKUP_ASSIGNED" || status === "PICKUP_CONFIRMED") && p.pickupRiderId === plan.riderId ? `pickup already assigned to ${plan.riderLabel}` : null;
      case "ASSIGN_DELIVERY":
        return (status === "ASSIGNED" || status === "OUT_FOR_DELIVERY") && p.deliveryRiderId === plan.riderId ? `already assigned to ${plan.riderLabel} for delivery` : null;
      case "SET_STATUS":
      case "RECEIVE_AT_HUB":
        return status === plan.status && (!plan.hubId || plan.hubId === p.currentHubId) ? `already "${statusLabelOf(p)}"` : null;
      case "CANCEL":
        return status === "PICKUP_CANCELLED" ? "already cancelled" : null;
      case "SCHEDULE_RETURN":
        return status === "RETURN_SCHEDULED" || status === "RETURNED" ? `already "${statusLabelOf(p)}"` : null;
      case "TO_DROP_OFF":
        return p.intake === "DROP_OFF" && p.dropOffHubId === plan.hubId ? `already a drop-off at ${plan.hubName}` : null;
      case "TO_PICKUP":
        return p.intake === "PICKUP" ? "already a rider pickup" : null;
      case "COMPLETE_DETAILS": {
        const d = plan.details ?? {};
        const same =
          (d.recipient?.name === undefined || d.recipient.name === p.recipientName) &&
          (d.recipient?.phone === undefined || d.recipient.phone === p.recipientPhone) &&
          (d.delivery?.street === undefined || d.delivery.street === p.deliveryStreet) &&
          (d.delivery?.area === undefined || d.delivery.area === p.deliveryArea) &&
          (d.delivery?.district === undefined || d.delivery.district === p.deliveryDistrict) &&
          (d.delivery?.zone === undefined || d.delivery.zone === p.deliveryZone) &&
          (d.weightKg === undefined || d.weightKg === Number(p.weightKg)) &&
          (d.serviceLevel === undefined || d.serviceLevel === p.serviceLevel);
        return same ? "the details are already saved" : null;
      }
      case "ADD_NOTE":
        return null;
    }
  }
}
