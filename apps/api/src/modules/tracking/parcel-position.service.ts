import { Injectable } from "@nestjs/common";
import type { ParcelStatus } from "@paira-express/shared";
import { PrismaService } from "../../common/prisma.service";
import type { Actor } from "../../common/auth/actor";
import { notFound } from "../../common/errors";
import type { Prisma } from "../../generated/prisma/client";
import { LIVE_LOCATION_STALE_MINUTES, ParcelsService } from "../parcels/parcels.service";
import { readLocationSettings, staleAfterMinutes } from "./location-settings";

export type PositionKind = "rider" | "hub" | "vehicle" | "last" | "none";

/**
 * Where a parcel is now, for the map in the parcel drawers. `lat` / `lng` are null when there is
 * nothing to put on a map (the label then says what is known). `approximate`: a hub's position
 * standing in for the parcel (city level).
 */
export interface ParcelPosition {
  trackingId: string;
  status: string;
  kind: PositionKind;
  lat: number | null;
  lng: number | null;
  label: string;
  detail: string | null;
  updatedAt: Date | null;
  ageSeconds: number | null;
  stale: boolean;
  approximate: boolean;
  hub: { id: string; code: string; name: string } | null;
  trip: { id: string; number: string; vehicleRegNo: string; route: string; status: string; sharing: boolean } | null;
  /** Staff only. */
  rider: { code: string; name: string } | null;
}

const hubSelect = { id: true, code: true, name: true, district: true, lat: true, lng: true } satisfies Prisma.HubSelect;
const parcelSelect = {
  id: true,
  trackingId: true,
  status: true,
  intake: true,
  services: true,
  pickupRiderId: true,
  deliveryRiderId: true,
  deliveryLat: true,
  deliveryLng: true,
  deliveryZone: true,
  deliveryDistrict: true,
  pickupLat: true,
  pickupLng: true,
  deliveredAt: true,
  updatedAt: true,
  currentHub: { select: hubSelect },
  dropOffHub: { select: hubSelect },
  proof: { select: { lat: true, lng: true, capturedAt: true, createdAt: true } },
} satisfies Prisma.ParcelSelect;
export type PositionParcel = Prisma.ParcelGetPayload<{ select: typeof parcelSelect }>;
type HubRow = NonNullable<PositionParcel["currentHub"]>;

const AT_A_HUB: ParcelStatus[] = ["AT_HUB", "ASSIGNED", "READY_FOR_COLLECTION", "RETRY_SCHEDULED", "RETURN_SCHEDULED", "EXCEPTION"];
const PICKUP_RIDER: ParcelStatus[] = ["PICKUP_ASSIGNED", "PICKUP_CONFIRMED", "PICKED_UP"];

/**
 * One answer to "where is this parcel?" (docs/architecture-contracts.md, "Parcel position and vehicle
 * location"):
 *  - with a rider (pickup assigned / picked up / out for delivery) → the rider's latest position;
 *  - at a hub / ready for collection → the hub;
 *  - in a vehicle (IN_TRANSIT in a bag on a departed trip) → the trip's shared vehicle position,
 *    else "On the way from A to B" at the origin hub;
 *  - delivered / returned → the last known point (proof of delivery, else the address pin).
 * Merchants and customers (`staff: false`) see the rider only under the "Live rider location" rules
 * (out for delivery, package feature, fresh fix, rider on shift); otherwise the hub (city level).
 */
@Injectable()
export class ParcelPositionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly parcels: ParcelsService,
  ) {}

  /** GET /parcels/:id/position: within the actor's parcel scope (404 otherwise). */
  async forActor(actor: Actor, trackingId: string) {
    const parcel = await this.prisma.parcel.findFirst({ where: { AND: [{ trackingId: trackingId.trim().toUpperCase() }, this.parcels.scope(actor)] }, select: parcelSelect });
    if (!parcel) throw notFound("Parcel");
    return this.resolve(parcel, { staff: actor.permissions.has("parcel:read:any") });
  }

  async resolve(p: PositionParcel, opts: { staff: boolean }): Promise<ParcelPosition> {
    const status = p.status as ParcelStatus;
    const base = { trackingId: p.trackingId, status: p.status, detail: null, updatedAt: null, ageSeconds: null, stale: false, approximate: false, hub: null, trip: null, rider: null };
    const none = (label: string, detail: string | null = null): ParcelPosition => ({ ...base, kind: "none", lat: null, lng: null, label, detail });
    const atHub = (hub: HubRow | null, label: string, detail: string | null = null, kind: PositionKind = "hub"): ParcelPosition =>
      hub
        ? { ...base, kind, lat: hub.lat, lng: hub.lng, label, detail: detail ?? (hub.lat == null ? "This hub has no map position yet" : null), approximate: true, hub: { id: hub.id, code: hub.code, name: hub.name } }
        : none(label, detail);

    if (status === "PICKUP_CANCELLED") return none("Cancelled");
    if (status === "PENDING_CONFIRMATION")
      return p.intake === "DROP_OFF" ? atHub(p.dropOffHub, `Waiting for drop-off at ${p.dropOffHub?.name ?? "the hub"}`, "Not received yet", "none") : none("Waiting for a pickup rider");

    if (PICKUP_RIDER.includes(status)) {
      const label = status === "PICKED_UP" ? "Picked up · on the way to the hub" : "Pickup rider on the way";
      if (!opts.staff || !p.pickupRiderId) return none(label);
      const fix = await this.riderPosition(base, p.pickupRiderId, status === "PICKED_UP" ? "With rider" : "Pickup rider");
      if (!fix) return none(label, "The rider hasn't shared a location yet");
      return { ...fix, label: status === "PICKED_UP" ? fix.label : `${fix.label} · on the way to pick up`, detail: `${fix.detail}${status === "PICKED_UP" ? " · picked up, on the way to the hub" : ""}` };
    }

    if (status === "OUT_FOR_DELIVERY") {
      if (p.deliveryRiderId) {
        if (opts.staff) {
          const fix = await this.riderPosition(base, p.deliveryRiderId, "With rider");
          if (fix) return { ...fix, detail: `${fix.detail} · out for delivery` };
        } else if (p.services.includes("tracking.live_location")) {
          // The existing "Live rider location" rules (ParcelsService.liveDelivery): fresh fix, rider on shift.
          const fix = await this.riderPosition(base, p.deliveryRiderId, "With the delivery rider", false);
          if (fix && !fix.stale && (fix.ageSeconds ?? Infinity) <= LIVE_LOCATION_STALE_MINUTES * 60) return fix;
        }
      }
      return atHub(p.currentHub, `Out for delivery${p.currentHub ? ` from ${p.currentHub.name}` : ""}`, opts.staff ? "The rider hasn't shared a location yet" : "The rider's live position isn't shared for this parcel");
    }

    if (status === "IN_TRANSIT") return this.inTransit(base, p);

    if (AT_A_HUB.includes(status)) {
      const loaded = await this.prisma.linehaulBagItem.findFirst({
        where: { parcelId: p.id, state: "LOADED", bag: { status: { in: ["SEALED", "OPEN"] }, trip: { status: "PLANNED" } } },
        select: { bag: { select: { trip: { select: { number: true } } } } },
      });
      const label = status === "READY_FOR_COLLECTION" ? `Ready for collection at ${p.currentHub?.name ?? "the hub"}` : `At ${p.currentHub?.name ?? "a hub"}`;
      return atHub(p.currentHub, label, loaded?.bag.trip ? `Loaded on ${loaded.bag.trip.number} · waiting to depart` : null);
    }

    if (status === "DELIVERED") {
      const at = p.proof?.capturedAt ?? p.deliveredAt ?? p.updatedAt;
      if (p.proof?.lat != null && p.proof.lng != null) return { ...base, kind: "last", lat: p.proof.lat, lng: p.proof.lng, label: "Delivered here", detail: "Where the proof of delivery was recorded", updatedAt: at };
      if (p.deliveryLat != null && p.deliveryLng != null) return { ...base, kind: "last", lat: p.deliveryLat, lng: p.deliveryLng, label: "Delivered", detail: "The recipient's address", updatedAt: at, approximate: true };
      return { ...none(`Delivered · ${[p.deliveryZone, p.deliveryDistrict].filter(Boolean).join(", ")}`), kind: "last", updatedAt: at };
    }

    if (status === "RETURNED") {
      if (p.pickupLat != null && p.pickupLng != null) return { ...base, kind: "last", lat: p.pickupLat, lng: p.pickupLng, label: "Returned to the sender", detail: "The sender's address", updatedAt: p.updatedAt, approximate: true };
      return { ...atHub(p.currentHub, "Returned to the sender"), kind: "last", updatedAt: p.updatedAt };
    }
    return atHub(p.currentHub, p.currentHub ? `At ${p.currentHub.name}` : "Location unknown");
  }

  /** The rider's latest fix, or null when there is none. */
  private async riderPosition(base: Omit<ParcelPosition, "kind" | "lat" | "lng" | "label">, riderId: string, prefix: string, staff = true): Promise<ParcelPosition | null> {
    const [fix, settings] = await Promise.all([
      this.prisma.riderLocation.findUnique({ where: { riderId }, select: { lat: true, lng: true, at: true, rider: { select: { code: true, status: true, user: { select: { name: true } } } } } }),
      readLocationSettings(this.prisma),
    ]);
    if (!fix) return null;
    const ageSeconds = Math.max(0, Math.round((Date.now() - fix.at.getTime()) / 1000));
    const offShift = fix.rider.status === "OFFLINE";
    const stale = offShift || ageSeconds > staleAfterMinutes(settings) * 60;
    const name = fix.rider.user.name;
    return {
      ...base,
      kind: "rider",
      lat: fix.lat,
      lng: fix.lng,
      label: staff ? `${prefix} ${fix.rider.code}` : prefix,
      detail: staff ? `${name}${offShift ? " · off shift (last known position)" : ""}` : null,
      updatedAt: fix.at,
      ageSeconds,
      stale,
      rider: staff ? { code: fix.rider.code, name } : null,
    };
  }

  private async inTransit(base: Omit<ParcelPosition, "kind" | "lat" | "lng" | "label">, p: PositionParcel): Promise<ParcelPosition> {
    const item = await this.prisma.linehaulBagItem.findFirst({
      where: { parcelId: p.id, state: "LOADED", bag: { status: "IN_TRANSIT", tripId: { not: null } } },
      orderBy: { addedAt: "desc" },
      select: {
        bag: {
          select: {
            trip: {
              select: {
                id: true,
                number: true,
                status: true,
                vehicleRegNo: true,
                originHub: { select: hubSelect },
                destHub: { select: hubSelect },
                location: { select: { lat: true, lng: true, at: true } },
                vehicleShares: { where: { endedAt: null }, select: { id: true }, take: 1 },
              },
            },
          },
        },
      },
    });
    const trip = item?.bag.trip;
    if (!trip) {
      const to = p.currentHub;
      return { ...base, kind: "vehicle", lat: null, lng: null, label: `In transit${to ? ` to ${to.name}` : ""}`, detail: "Not on a linehaul trip", approximate: true, hub: to ? { id: to.id, code: to.code, name: to.name } : null };
    }
    const route = `${trip.originHub.name} → ${trip.destHub.name}`;
    const sharing = trip.vehicleShares.length > 0;
    const tripView = { id: trip.id, number: trip.number, vehicleRegNo: trip.vehicleRegNo, route, status: trip.status, sharing };
    if (trip.location && trip.status === "DEPARTED") {
      const settings = await readLocationSettings(this.prisma);
      const ageSeconds = Math.max(0, Math.round((Date.now() - trip.location.at.getTime()) / 1000));
      return {
        ...base,
        kind: "vehicle",
        lat: trip.location.lat,
        lng: trip.location.lng,
        label: `In vehicle ${trip.vehicleRegNo} (${route})`,
        detail: sharing ? `Manifest ${trip.number}` : `Manifest ${trip.number} · sharing stopped (last known position)`,
        updatedAt: trip.location.at,
        ageSeconds,
        stale: !sharing || ageSeconds > staleAfterMinutes(settings) * 60,
        trip: tripView,
      };
    }
    const o = trip.originHub;
    return {
      ...base,
      kind: "vehicle",
      lat: o.lat,
      lng: o.lng,
      label: `On the way from ${o.name} to ${trip.destHub.name}`,
      detail: `In vehicle ${trip.vehicleRegNo} · ${trip.number} · the vehicle's location isn't shared`,
      approximate: true,
      hub: { id: o.id, code: o.code, name: o.name },
      trip: tripView,
    };
  }
}
