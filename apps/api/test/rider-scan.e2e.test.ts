import { RealtimeService } from "../src/common/realtime.service";
import { hub, parcelBody, resetDatabase, riderUser, startApp, userWithRoles, type TestContext } from "./helpers";

/**
 * Rider app scan workflows (pickup from merchant, hand over at hub, return runs) and the delivery
 * rider's live location on tracking pages (who may see it, when, and for how long).
 */
describe("rider scan workflows and live location visibility", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  let seq = 0;
  async function merchant(name: string) {
    const m = await ctx.prisma.merchant.create({
      data: {
        code: `MR-S${++seq}`,
        type: "ECOMMERCE",
        name,
        status: "ACTIVE",
        kycStatus: "APPROVED",
        contactName: "Owner",
        contactPhone: "+8801711111111",
        pickupAddress: "House 5 Road 2",
        pickupArea: "Gulshan",
        pickupDistrict: "Dhaka North",
      },
    });
    const owner = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: m.id }], `${name} owner`);
    return { m, owner };
  }
  const order = (overrides: Record<string, unknown> = {}) => parcelBody({ serviceLevel: "Regular", contents: undefined, codAmount: 0, ...overrides });

  const setup = async () => {
    const h = await hub(ctx);
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops Manager");
    const rider = await riderUser(ctx, "R-3101", h.id);
    return { h, ops, rider };
  };
  async function book(owner: { token: string }, ops: { token: string }, riderId: string) {
    const res = await ctx.api("POST", "/parcels", { token: owner.token, body: order() });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const id = res.body.trackingId as string;
    const assigned = await ctx.api("POST", `/parcels/${id}/assign-pickup`, { token: ops.token, body: { riderId } });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    return id;
  }

  describe("pickup from merchant", () => {
    it("collects scanned parcels of the chosen stop, refuses other merchants' and unassigned ones, and is idempotent", async () => {
      const s = await setup();
      const shop = await merchant("Shop One");
      const other = await merchant("Shop Two");
      const ids = [await book(shop.owner, s.ops, s.rider.rider.id), await book(shop.owner, s.ops, s.rider.rider.id), await book(shop.owner, s.ops, s.rider.rider.id)];
      const foreign = await book(other.owner, s.ops, s.rider.rider.id);
      const otherRider = await riderUser(ctx, "R-3102", s.h.id);
      const notMine = await book(shop.owner, s.ops, otherRider.rider.id);

      const tasks = (await ctx.api("GET", "/rider/tasks", { token: s.rider.token })).body;
      expect(tasks.pickups).toHaveLength(4);
      const stop = tasks.pickups.find((p: { trackingId: string }) => p.trackingId === ids[0]).pickupStop;
      expect(stop).toEqual({ key: `M:${shop.m.id}`, name: "Shop One", address: expect.stringContaining("House 5 Road 2") });
      expect(tasks.carrying).toEqual([]);

      const collect = (id: string, key?: string) =>
        ctx.api("POST", `/rider/parcels/${id}/pickup`, { token: s.rider.token, body: { outcome: "COLLECTED", expectedStop: stop.key }, headers: key ? { "idempotency-key": key } : {} });

      const first = await collect(ids[0], "scan-key-0001");
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body.status).toBe("PICKED_UP");
      expect((await collect(ids[1])).body.status).toBe("PICKED_UP");

      // Another merchant's parcel, at this stop: refused with the reason. Not assigned to this rider: not found.
      const wrong = await collect(foreign);
      expect(wrong.status).toBe(409);
      expect(wrong.body.error).toMatchObject({ code: "OTHER_PICKUP_STOP", message: expect.stringContaining("Shop Two") });
      expect((await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: foreign } })).status).toBe("PICKUP_ASSIGNED");
      expect((await collect(notMine)).status).toBe(404);

      // A repeated scan and an offline replay (same key) change nothing; one pickup earning, one event.
      expect((await collect(ids[0])).status).toBe(200);
      expect((await collect(ids[0], "scan-key-0001")).status).toBe(200);
      const picked = await ctx.prisma.trackingEvent.count({ where: { parcel: { trackingId: ids[0] }, status: "PICKED_UP", visibility: "PUBLIC" } });
      expect(picked).toBe(1);

      const after = (await ctx.api("GET", "/rider/tasks", { token: s.rider.token })).body;
      expect(after.pickups.map((p: { trackingId: string }) => p.trackingId).sort()).toEqual([ids[2], foreign].sort());
      expect(after.carrying.map((p: { trackingId: string }) => p.trackingId).sort()).toEqual([ids[0], ids[1]].sort());
      expect(after.carrying[0]).toMatchObject({ status: "PICKED_UP", pickupStop: { key: stop.key }, handover: null });
      // Audit of the transition (ParcelWorkflowService.transition).
      expect(await ctx.prisma.auditLog.count({ where: { action: { startsWith: "parcel." }, entityId: first.body.id } })).toBeGreaterThan(0);
    });
  });

  describe("hand over at hub", () => {
    it("builds the hub's handover list without changing the status; the hub's scan receives it; undo until then", async () => {
      const s = await setup();
      const shop = await merchant("Shop One");
      const [a, b] = [await book(shop.owner, s.ops, s.rider.rider.id), await book(shop.owner, s.ops, s.rider.rider.id)];
      const waiting = await book(shop.owner, s.ops, s.rider.rider.id);
      for (const id of [a, b]) expect((await ctx.api("POST", `/rider/parcels/${id}/pickup`, { token: s.rider.token, body: { outcome: "COLLECTED" } })).status).toBe(200);
      const publish = vi.spyOn(ctx.app.get(RealtimeService), "publish");

      const handover = (id: string) => ctx.api("POST", `/rider/parcels/${id}/handover`, { token: s.rider.token, body: { hubId: s.h.id, source: "CAMERA" }, headers: { "idempotency-key": `ho-${id}` } });
      const res = await handover(a);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.status).toBe("PICKED_UP");
      expect((await handover(b)).status).toBe(200);
      expect((await handover(b)).status).toBe(200); // replay
      expect(publish.mock.calls.flat().some(e => e.type === "rider.handover" && e.id === a && (e.data as { hubId: string }).hubId === s.h.id)).toBe(true);
      // Not picked up yet: refused.
      const early = await ctx.api("POST", `/rider/parcels/${waiting}/handover`, { token: s.rider.token, body: { hubId: s.h.id } });
      expect(early.status).toBe(409);
      expect(early.body.error.code).toBe("NOT_WITH_RIDER");

      const operator = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: s.h.id }], "Hub operator");
      const list = await ctx.api("GET", `/ops/rider-handovers?hubId=${s.h.id}`, { token: operator.token });
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      expect(list.body).toMatchObject({ hub: { id: s.h.id }, total: 2, items: [{ rider: { code: "R-3101" } }] });
      const otherHub = await hub(ctx, "HUB-T9");
      const stranger = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: otherHub.id }], "Other operator");
      expect((await ctx.api("GET", `/ops/rider-handovers?hubId=${s.h.id}`, { token: stranger.token })).status).toBe(403);
      expect((await ctx.api("GET", `/ops/rider-handovers?hubId=${s.h.id}`, { token: s.rider.token })).status).toBe(403);

      // The rider's own list shows where each parcel was handed over.
      const carrying = (await ctx.api("GET", "/rider/tasks", { token: s.rider.token })).body.carrying;
      expect(carrying.find((p: { trackingId: string }) => p.trackingId === a).handover).toMatchObject({ hubId: s.h.id, hubName: s.h.name });

      // Undo b (the hub hasn't scanned it): off the list.
      const undo = await ctx.api("POST", `/rider/parcels/${b}/handover/withdraw`, { token: s.rider.token });
      expect(undo.status, JSON.stringify(undo.body)).toBe(200);
      expect((await ctx.api("GET", `/ops/rider-handovers?hubId=${s.h.id}`, { token: operator.token })).body.total).toBe(1);

      // The hub scans a in at the receive desk: AT_HUB. Afterwards the rider can't hand it over or withdraw it.
      const received = await ctx.api("POST", "/ops/hub-receive", { token: operator.token, body: { code: a, hubId: s.h.id, source: "CAMERA" } });
      expect([200, 201], JSON.stringify(received.body)).toContain(received.status);
      expect(received.body).toMatchObject({ outcome: "RECEIVED", parcel: { status: "AT_HUB" } });
      expect((await ctx.api("POST", `/rider/parcels/${a}/handover/withdraw`, { token: s.rider.token })).body.error.code).toBe("HANDOVER_CLOSED");
      expect((await handover(a)).status).toBe(200); // the same idempotency key replays the stored answer
      expect((await ctx.api("POST", `/rider/parcels/${a}/handover`, { token: s.rider.token, body: { hubId: s.h.id } })).body.error.code).toBe("NOT_WITH_RIDER");
      expect((await ctx.api("GET", `/ops/rider-handovers?hubId=${s.h.id}`, { token: operator.token })).body.total).toBe(0);

      expect(await ctx.prisma.auditLog.count({ where: { action: "parcel.rider_handover" } })).toBe(2);
      expect(await ctx.prisma.auditLog.count({ where: { action: "parcel.rider_handover_withdraw" } })).toBe(1);
      expect(await ctx.prisma.scanEvent.count({ where: { kind: "RIDER_HANDOVER", hubId: s.h.id, riderId: s.rider.rider.id } })).toBe(2);
      // Internal events only: the recipient's tracking page doesn't show the handover list.
      const track = (await ctx.api("GET", `/track/${b}`)).body;
      expect(JSON.stringify(track)).not.toContain("Handed over at");
      publish.mockRestore();
    });
  });

  describe("return to merchant", () => {
    it("lists the return runs dispatched to the rider with their parcels (read-only)", async () => {
      const s = await setup();
      const shop = await merchant("Shop One");
      const id = await book(shop.owner, s.ops, s.rider.rider.id);
      const run = await ctx.prisma.returnRun.create({ data: { number: "RR-261018-0001", merchantId: shop.m.id, riderId: s.rider.rider.id, status: "OUT_FOR_RETURN", dispatchedAt: new Date() } });
      await ctx.prisma.parcel.update({ where: { trackingId: id }, data: { status: "RETURN_SCHEDULED", returnRunId: run.id, returnReason: "Recipient refused" } });
      await ctx.prisma.returnRun.create({ data: { number: "RR-261018-0002", merchantId: shop.m.id, status: "PLANNED" } });
      const res = await ctx.api("GET", "/rider/return-runs", { token: s.rider.token });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.items).toEqual([expect.objectContaining({ number: "RR-261018-0001", merchant: expect.objectContaining({ name: "Shop One" }), parcels: [expect.objectContaining({ trackingId: id, returnReason: "Recipient refused" })] })]);
      expect((await ctx.api("GET", "/rider/return-runs", { token: s.ops.token })).status).toBe(403);
    });
  });

  describe("live rider location on tracking", () => {
    const catalog = async () => (await ctx.api("GET", "/service-catalog")).body as { services: { code: string; segments: string[] }[] };
    async function liveMerchant(withLive: boolean) {
      const admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Admin");
      const shop = await merchant(withLive ? "Live Shop" : "Plain Shop");
      const services = (await catalog()).services.filter(x => x.segments.includes("ECOMMERCE") && (withLive || x.code !== "tracking.live_location")).map(x => x.code);
      const pkg = await ctx.api("POST", "/packages", { token: admin.token, body: { segment: "ECOMMERCE", name: withLive ? "Live" : "No live", services, prices: {} } });
      expect(pkg.status, JSON.stringify(pkg.body)).toBe(201);
      expect((await ctx.api("PUT", `/merchants/${shop.m.id}/package`, { token: admin.token, body: { packageId: pkg.body.id } })).status).toBe(200);
      return shop;
    }
    async function outForDelivery(s: Awaited<ReturnType<typeof setup>>, owner: { token: string }) {
      const id = (await ctx.api("POST", "/parcels", { token: owner.token, body: order() })).body.trackingId as string;
      await ctx.prisma.parcel.update({ where: { trackingId: id }, data: { status: "AT_HUB", currentHubId: s.h.id } });
      expect((await ctx.api("POST", `/parcels/${id}/assign-delivery`, { token: s.ops.token, body: { riderId: s.rider.rider.id } })).status).toBe(200);
      return id;
    }
    const fixAgo = (ms: number) => ({ lat: 23.7808, lng: 90.4142, accuracy: 12, at: new Date(Date.now() - ms).toISOString() });

    it("shows only the parcel's rider, only while out for delivery, to the SMS link, the merchant and staff; hides stale fixes", async () => {
      const s = await setup();
      const shop = await liveMerchant(true);
      // The out-for-delivery SMS is off by default; the owner can turn it on (it then carries the live link).
      const admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Settings admin");
      const on = await ctx.api("PUT", "/notifications/templates/parcel.out_for_delivery/sms", { token: admin.token, body: { enabled: true } });
      expect(on.status, JSON.stringify(on.body)).toBe(200);
      const id = await outForDelivery(s, shop.owner);
      await ctx.api("PATCH", "/rider/me/status", { token: s.rider.token, body: { status: "ONLINE" } });
      expect((await ctx.api("POST", "/rider/location", { token: s.rider.token, body: fixAgo(1000) })).status).toBe(202);

      // Assigned but not out for delivery yet: nothing.
      expect((await ctx.api("GET", `/parcels/${id}`, { token: shop.owner.token })).body.liveDelivery).toBeNull();

      const publish = vi.spyOn(ctx.app.get(RealtimeService), "publish");
      expect((await ctx.api("POST", `/rider/parcels/${id}/start-delivery`, { token: s.rider.token })).status).toBe(200);
      const sms = await ctx.prisma.outboxMessage.findFirstOrThrow({ where: { template: "parcel.out_for_delivery", body: { contains: id } } });
      const token = /[?&]t=([^\s&#]+)/.exec(sms.body)?.[1];
      expect(token, sms.body).toMatch(/^l\./);

      // A live fix tells the merchant's open pages to reload.
      expect((await ctx.api("POST", "/rider/location", { token: s.rider.token, body: fixAgo(0) })).status).toBe(202);
      expect(publish.mock.calls.flat().some(e => e.type === "parcel.rider_location" && e.id === id && e.merchantId === shop.m.id)).toBe(true);
      publish.mockRestore();

      // The tracking ID alone: no position (the link from the SMS is needed).
      const anonymous = (await ctx.api("GET", `/track/${id}`)).body.liveDelivery;
      expect(anonymous).toMatchObject({ location: null, locationStatus: "LINK_REQUIRED" });
      // Without the SMS: the last 4 digits of the recipient's phone (01812000000) unlock it.
      const wrongDigits = await ctx.api("POST", `/track/${id}/live-access`, { body: { phoneLast4: "1234" } });
      expect(wrongDigits.status).toBe(422);
      expect(wrongDigits.body.error.code).toBe("PHONE_MISMATCH");
      const unlocked = await ctx.api("POST", `/track/${id}/live-access`, { body: { phoneLast4: "0000" } });
      expect(unlocked.status, JSON.stringify(unlocked.body)).toBe(200);
      expect((await ctx.api("GET", `/track/${id}?t=${encodeURIComponent(unlocked.body.token)}`)).body.liveDelivery.locationStatus).toBe("LIVE");
      const viaLink = (await ctx.api("GET", `/track/${id}?t=${encodeURIComponent(token!)}`)).body.liveDelivery;
      expect(viaLink).toMatchObject({ locationStatus: "LIVE", staleAfterMinutes: 15, location: { lat: 23.7808, lng: 90.4142 } });
      expect(viaLink.location.ageSeconds).toBeLessThan(60);
      expect(viaLink).not.toHaveProperty("points"); // latest position only, never the history
      // A live-location link doesn't open the full details, and another parcel's link doesn't work.
      expect((await ctx.api("GET", `/track/${id}/full?t=${encodeURIComponent(token!)}`)).status).toBe(404);
      const second = await outForDelivery(s, shop.owner);
      expect((await ctx.api("GET", `/track/${second}?t=${encodeURIComponent(token!)}`)).body.liveDelivery).toBeNull(); // not out for delivery
      expect((await ctx.api("GET", `/track/${id}?t=l.zzzzzz.forged`)).body.liveDelivery.location).toBeNull();

      // The merchant and staff see it; another merchant can't open the parcel at all.
      expect((await ctx.api("GET", `/parcels/${id}`, { token: shop.owner.token })).body.liveDelivery).toMatchObject({ locationStatus: "LIVE", location: { lat: 23.7808 } });
      expect((await ctx.api("GET", `/parcels/${id}`, { token: s.ops.token })).body.liveDelivery.locationStatus).toBe("LIVE");
      const stranger = await merchant("Stranger Shop");
      expect((await ctx.api("GET", `/parcels/${id}`, { token: stranger.owner.token })).status).toBe(404);

      // Stale (no fix for 15+ minutes): hidden.
      await ctx.prisma.riderLocation.update({ where: { riderId: s.rider.rider.id }, data: { at: new Date(Date.now() - 16 * 60_000) } });
      expect((await ctx.api("GET", `/parcels/${id}`, { token: shop.owner.token })).body.liveDelivery).toMatchObject({ location: null, locationStatus: "STALE" });
      // Fresh again, then the rider goes off shift: hidden.
      await ctx.api("POST", "/rider/location", { token: s.rider.token, body: fixAgo(0) });
      await ctx.api("PATCH", "/rider/me/status", { token: s.rider.token, body: { status: "OFFLINE" } });
      expect((await ctx.api("GET", `/parcels/${id}`, { token: shop.owner.token })).body.liveDelivery).toMatchObject({ location: null, locationStatus: "OFF_SHIFT" });
      await ctx.api("PATCH", "/rider/me/status", { token: s.rider.token, body: { status: "ONLINE" } });

      // Delivered: gone, also for the link holder.
      const code = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: id } });
      expect(code.status).toBe("OUT_FOR_DELIVERY");
      await ctx.prisma.parcel.update({ where: { trackingId: id }, data: { status: "DELIVERED", deliveredAt: new Date() } });
      expect((await ctx.api("GET", `/track/${id}?t=${encodeURIComponent(token!)}`)).body.liveDelivery).toBeNull();
      expect((await ctx.api("GET", `/parcels/${id}`, { token: shop.owner.token })).body.liveDelivery).toBeNull();
    });

    it("never shows a position when the parcel's package lacks Live rider location", async () => {
      const s = await setup();
      const shop = await liveMerchant(false);
      const id = await outForDelivery(s, shop.owner);
      await ctx.api("PATCH", "/rider/me/status", { token: s.rider.token, body: { status: "ONLINE" } });
      await ctx.api("POST", `/rider/parcels/${id}/start-delivery`, { token: s.rider.token });
      await ctx.api("POST", "/rider/location", { token: s.rider.token, body: fixAgo(0) });
      const sms = await ctx.prisma.outboxMessage.findFirst({ where: { template: "parcel.out_for_delivery", body: { contains: id } } });
      if (sms) expect(sms.body).not.toMatch(/[?&]t=l\./);
      const detail = (await ctx.api("GET", `/parcels/${id}`, { token: shop.owner.token })).body.liveDelivery;
      // The package still shares the rider's phone, so liveDelivery exists, but without a position.
      expect(detail).toMatchObject({ location: null, locationStatus: null });
      expect((await ctx.api("POST", `/track/${id}/live-access`, { body: { phoneLast4: "0000" } })).body.error.code).toBe("LIVE_LOCATION_UNAVAILABLE");
    });

    it("tells the rider app whether the location is being shared and when it was last received", async () => {
      const s = await setup();
      expect((await ctx.api("GET", "/rider/location", { token: s.rider.token })).body).toEqual({ status: "OFFLINE", sharing: false, latest: null, settings: { intervalMinutes: 5, movementMeters: 50 } });
      await ctx.api("PATCH", "/rider/me/status", { token: s.rider.token, body: { status: "ONLINE" } });
      await ctx.api("POST", "/rider/location", { token: s.rider.token, body: fixAgo(0) });
      expect((await ctx.api("GET", "/rider/location", { token: s.rider.token })).body).toMatchObject({ status: "ONLINE", sharing: true, latest: { lat: 23.7808, lng: 90.4142 } });
    });
  });
});
