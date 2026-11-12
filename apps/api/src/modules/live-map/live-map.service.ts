import { Injectable } from "@nestjs/common";
import type { ParcelStatus } from "@delivery-fast/shared";
import { PrismaService } from "../../common/prisma.service";
import { notFound } from "../../common/errors";
import { addressText } from "../../common/address";
import { dhakaDayStart } from "../parcels/ops-scope";

const DELIVERY_OPEN: ParcelStatus[] = ["ASSIGNED", "OUT_FOR_DELIVERY", "RETRY_SCHEDULED", "EXCEPTION"];
const PICKUP_OPEN: ParcelStatus[] = ["PICKUP_ASSIGNED", "PICKUP_CONFIRMED"];
/** Operations app users are online while the app is open: it sends every 2 minutes. */
const STAFF_ONLINE_MS = 10 * 60_000;
const MAP_ROLES = ["OPS_MANAGER", "HUB_OPERATOR", "FRANCHISE"] as const;

const latest = (...dates: (Date | null | undefined)[]) => dates.filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

/** A Dhaka calendar day ("2026-11-12", default today) as [start, end). */
function dayRange(date?: string) {
  const start = date ? new Date(`${date}T00:00:00+06:00`) : dhakaDayStart();
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

/**
 * Super admin › Live map: hubs, franchises, riders and Operations app users (operations managers, Hub Managers,
 * franchise accounts) with their last positions; a rider's day (path, parcels carried, parcels out that day with their
 * result and delivery time); a staff member's path. Positions come from the rider app (on shift often, off shift every
 * 15 minutes while open) and the Operations app (every 2 minutes while open).
 */
@Injectable()
export class LiveMapService {
  constructor(private readonly prisma: PrismaService) {}

  async overview() {
    const now = Date.now();
    const [hubs, franchises, riders, open, staff] = await Promise.all([
      this.prisma.hub.findMany({
        where: { active: true },
        select: { id: true, code: true, name: true, type: true, district: true, zone: true, lat: true, lng: true, inChargeName: true, inChargePhone: true },
        orderBy: { name: "asc" },
      }),
      this.prisma.franchise.findMany({ select: { id: true, code: true, name: true, status: true, hubId: true, ownerId: true }, orderBy: { name: "asc" } }),
      this.prisma.rider.findMany({
        where: { active: true },
        select: {
          id: true,
          code: true,
          status: true,
          vehicle: true,
          hubId: true,
          hubs: { select: { hubId: true } },
          location: { select: { lat: true, lng: true, accuracy: true, at: true } },
          user: { select: { name: true, phone: true, lastLoginAt: true } },
        },
        orderBy: { code: "asc" },
      }),
      this.prisma.parcel.groupBy({ by: ["deliveryRiderId"], where: { deliveryRiderId: { not: null }, status: { in: DELIVERY_OPEN } }, _count: { _all: true } }),
      this.prisma.user.findMany({
        where: { status: "ACTIVE", roles: { some: { role: { in: [...MAP_ROLES] } } } },
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          lastLoginAt: true,
          roles: { select: { role: true, hubId: true } },
          staffLocation: { select: { lat: true, lng: true, accuracy: true, at: true } },
        },
        orderBy: { name: "asc" },
      }),
    ]);
    const franchiseOfHub = new Map(franchises.map(f => [f.hubId, f]));
    return {
      generatedAt: new Date(now).toISOString(),
      hubs: hubs.map(h => {
        const f = franchiseOfHub.get(h.id);
        return { ...h, franchise: f ? { id: f.id, name: f.name } : null };
      }),
      franchises: franchises.map(f => ({ id: f.id, code: f.code, name: f.name, status: f.status, hubId: f.hubId, ownerId: f.ownerId })),
      riders: riders.map(r => ({
        id: r.id,
        code: r.code,
        name: r.user.name,
        phone: r.user.phone,
        status: r.status,
        online: r.status !== "OFFLINE",
        vehicle: r.vehicle,
        hubId: r.hubId,
        hubIds: [...new Set([r.hubId, ...r.hubs.map(h => h.hubId)].filter((x): x is string => !!x))],
        franchiseId: r.hubId ? (franchiseOfHub.get(r.hubId)?.id ?? null) : null,
        location: r.location,
        lastActiveAt: latest(r.location?.at, r.user.lastLoginAt),
        openDeliveries: open.find(o => o.deliveryRiderId === r.id)?._count._all ?? 0,
      })),
      staff: staff.map(u => {
        const roles = [...new Set(u.roles.map(r => r.role as string).filter(r => (MAP_ROLES as readonly string[]).includes(r)))];
        return {
          userId: u.id,
          name: u.name,
          phone: u.phone,
          email: u.email,
          roles,
          hubIds: [...new Set(u.roles.flatMap(r => (r.hubId ? [r.hubId] : [])))],
          franchiseId: franchises.find(f => f.ownerId === u.id)?.id ?? null,
          location: u.staffLocation,
          online: !!u.staffLocation && now - u.staffLocation.at.getTime() < STAFF_ONLINE_MS,
          lastActiveAt: latest(u.staffLocation?.at, u.lastLoginAt),
        };
      }),
    };
  }

  /** A rider's day: where they are, their path, what they carry now and the parcels they went out with (result, time taken). */
  async rider(id: string, date?: string) {
    const { start, end } = dayRange(date);
    const rider = await this.prisma.rider.findUnique({
      where: { id },
      select: {
        id: true,
        code: true,
        status: true,
        vehicle: true,
        zone: true,
        hub: { select: { id: true, name: true, code: true, type: true } },
        location: true,
        user: { select: { name: true, phone: true, lastLoginAt: true } },
      },
    });
    if (!rider) throw notFound("Rider");
    const [path, carrying, attempts, outEvents, pickups] = await Promise.all([
      this.prisma.riderLocationPoint.findMany({ where: { riderId: id, at: { gte: start, lt: end } }, select: { lat: true, lng: true, at: true }, orderBy: { at: "asc" }, take: 5000 }),
      this.prisma.parcel.findMany({
        where: { deliveryRiderId: id, status: { in: DELIVERY_OPEN } },
        select: { trackingId: true, status: true, recipientName: true, recipientPhone: true, deliveryStreet: true, deliveryArea: true, deliveryZone: true, codAmount: true },
        orderBy: { updatedAt: "asc" },
        take: 300,
      }),
      this.prisma.deliveryAttempt.findMany({
        where: { riderId: id, createdAt: { gte: start, lt: end } },
        select: { parcelId: true, outcome: true, reason: true, nextAction: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.trackingEvent.findMany({
        where: { status: "OUT_FOR_DELIVERY", createdAt: { gte: start, lt: end }, parcel: { deliveryRiderId: id } },
        select: { parcelId: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.parcel.count({ where: { pickupRiderId: id, status: { in: PICKUP_OPEN } } }),
    ]);
    const ids = [...new Set([...attempts.map(a => a.parcelId), ...outEvents.map(e => e.parcelId)])];
    const parcels = ids.length
      ? await this.prisma.parcel.findMany({
          where: { id: { in: ids } },
          select: { id: true, trackingId: true, status: true, recipientName: true, deliveryStreet: true, deliveryArea: true, deliveryZone: true, codAmount: true },
        })
      : [];
    const day = parcels
      .map(p => {
        const outAt = outEvents.find(e => e.parcelId === p.id)?.createdAt ?? null;
        const mine = attempts.filter(a => a.parcelId === p.id);
        const last = mine[mine.length - 1];
        const returned = p.status === "RETURN_SCHEDULED" || p.status === "RETURNED" || (last?.outcome === "FAILED" && last.nextAction === "RETURN");
        const result = last?.outcome === "DELIVERED" ? "DELIVERED" : returned ? "RETURN" : last?.outcome === "FAILED" ? "FAILED" : "OUT";
        const doneAt = last?.createdAt ?? null;
        return {
          trackingId: p.trackingId,
          recipient: p.recipientName,
          address: addressText(p.deliveryStreet, p.deliveryArea, p.deliveryZone),
          cod: Number(p.codAmount ?? 0),
          status: p.status,
          result,
          reason: last?.outcome === "FAILED" ? (last.reason ?? null) : null,
          outAt,
          doneAt,
          /** Minutes from going out for delivery to delivered / failed (null while still out). */
          minutes: outAt && doneAt ? Math.max(0, Math.round((doneAt.getTime() - outAt.getTime()) / 60_000)) : null,
        };
      })
      .sort((a, b) => (a.outAt?.getTime() ?? 0) - (b.outAt?.getTime() ?? 0));
    const timed = day.filter(d => d.minutes != null && d.result === "DELIVERED");
    return {
      rider: { id: rider.id, code: rider.code, name: rider.user.name, phone: rider.user.phone, status: rider.status, online: rider.status !== "OFFLINE", vehicle: rider.vehicle, zone: rider.zone, hub: rider.hub },
      location: rider.location ? { lat: rider.location.lat, lng: rider.location.lng, accuracy: rider.location.accuracy, at: rider.location.at } : null,
      lastActiveAt: latest(rider.location?.at, rider.user.lastLoginAt),
      date: start.toISOString(),
      path,
      carrying: carrying.map(p => ({
        trackingId: p.trackingId,
        status: p.status,
        recipient: p.recipientName,
        phone: p.recipientPhone,
        address: addressText(p.deliveryStreet, p.deliveryArea, p.deliveryZone),
        cod: Number(p.codAmount ?? 0),
      })),
      openPickups: pickups,
      day,
      summary: {
        out: day.length,
        delivered: day.filter(d => d.result === "DELIVERED").length,
        failed: day.filter(d => d.result === "FAILED").length,
        returned: day.filter(d => d.result === "RETURN").length,
        stillOut: day.filter(d => d.result === "OUT").length,
        averageMinutes: timed.length ? Math.round(timed.reduce((n, d) => n + d.minutes!, 0) / timed.length) : null,
      },
    };
  }

  /** A staff member's path for a day. */
  async staffPath(userId: string, date?: string) {
    const { start, end } = dayRange(date);
    const path = await this.prisma.staffLocationPoint.findMany({ where: { userId, at: { gte: start, lt: end } }, select: { lat: true, lng: true, at: true }, orderBy: { at: "asc" }, take: 5000 });
    return { userId, path };
  }
}
