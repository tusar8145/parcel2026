import { hub, parcelBody, resetDatabase, riderUser, startApp, userWithRoles, type TestContext } from "./helpers";

// Rider location interval (super admin setting), "I'm travelling in this vehicle" (vehicle location per
// linehaul trip) and the parcel position resolver behind the drawer maps (GET /parcels/:id/position).
describe("parcel position and vehicle location", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  const GUL = { lat: 23.7925, lng: 90.4078 };
  const DHN = { lat: 23.7461, lng: 90.3742 };
  const fix = (lat: number, lng: number, at = new Date()) => ({ lat, lng, accuracy: 12, heading: 90, speed: 14, at: at.toISOString() });

  const setup = async () => {
    const gulshan = await ctx.prisma.hub.update({ where: { id: (await hub(ctx, "HUB-GUL")).id }, data: { name: "Gulshan Hub", ...GUL } });
    const dhanmondi = await ctx.prisma.hub.update({ where: { id: (await hub(ctx, "HUB-DHN")).id }, data: { name: "Dhanmondi Hub", ...DHN } });
    const uttara = await hub(ctx, "HUB-UTT");
    const shop = await ctx.prisma.merchant.create({
      data: { code: "MR-VL1", type: "ECOMMERCE", name: "Map Shop", status: "ACTIVE", kycStatus: "APPROVED", contactName: "Owner", contactPhone: "+8801911000020", pickupAddress: "House 5 Road 2", pickupArea: "Gulshan", pickupDistrict: "Dhaka North" },
    });
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops Manager");
    const gulOp = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: gulshan.id }], "Gulshan Operator");
    const dhnOp = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: dhanmondi.id }], "Dhanmondi Operator");
    const uttOp = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: uttara.id }], "Uttara Operator");
    const owner = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: shop.id }], "Shop Owner");
    const rider = await riderUser(ctx, "R-2101", gulshan.id);
    const dhnRider = await riderUser(ctx, "R-2201", dhanmondi.id);
    const uttRider = await riderUser(ctx, "R-2301", uttara.id);
    return { gulshan, dhanmondi, uttara, shop, ops, gulOp, dhnOp, uttOp, owner, rider, dhnRider, uttRider };
  };
  type Setup = Awaited<ReturnType<typeof setup>>;

  const book = async (s: Setup) => {
    await ctx.api("GET", "/packages/me", { token: s.owner.token });
    const res = await ctx.api("POST", "/parcels", { token: s.owner.token, body: parcelBody({ serviceLevel: "Regular", contents: undefined }) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.trackingId as string;
  };
  const position = (id: string, token: string) => ctx.api("GET", `/parcels/${id}/position`, { token });
  const online = async (r: { token: string }) => expect((await ctx.api("PATCH", "/rider/me/status", { token: r.token, body: { status: "ONLINE" } })).status).toBe(200);

  /** Booked, picked up into Gulshan Hub, bagged and departed to Dhanmondi on a trip. */
  const inTransit = async (s: Setup, id: string) => {
    await ctx.api("POST", `/parcels/${id}/assign-pickup`, { token: s.ops.token, body: { riderId: s.rider.rider.id } });
    const atHub = await ctx.api("POST", `/rider/parcels/${id}/pickup`, { token: s.rider.token, body: { outcome: "COLLECTED_TO_HUB", hubId: s.gulshan.id } });
    expect(atHub.body.status, JSON.stringify(atHub.body)).toBe("AT_HUB");
    const bag = (await ctx.api("POST", "/linehaul/bags", { token: s.gulOp.token, body: { originHubId: s.gulshan.id, destHubId: s.dhanmondi.id } })).body;
    expect((await ctx.api("POST", `/linehaul/bags/${bag.number}/items`, { token: s.gulOp.token, body: { code: id, source: "CAMERA" } })).status).toBe(200);
    expect((await ctx.api("POST", `/linehaul/bags/${bag.number}/seal`, { token: s.gulOp.token, body: { sealNo: "S-1" } })).status).toBe(200);
    const trip = (
      await ctx.api("POST", "/linehaul/trips", {
        token: s.gulOp.token,
        body: { originHubId: s.gulshan.id, destHubId: s.dhanmondi.id, vehicleRegNo: "DHAKA METRO-TA 11-2345", driverName: "Karim Mia", driverPhone: "01711222333" },
      })
    ).body;
    expect((await ctx.api("POST", `/linehaul/trips/${trip.number}/bags`, { token: s.gulOp.token, body: { bag: bag.number } })).status).toBe(200);
    return { bag: bag as { number: string }, trip: trip as { id: string; number: string } };
  };

  it("lets the super admin choose the location interval (default 5 minutes) and the rider app reads it", async () => {
    const s = await setup();
    const admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Admin");
    const initial = await ctx.api("GET", "/settings/location", { token: s.rider.token });
    expect(initial.body).toMatchObject({ intervalMinutes: 5, movementMeters: 50, staleAfterMinutes: 15 });
    expect((await ctx.api("PUT", "/settings/location", { token: s.ops.token, body: { intervalMinutes: 10, movementMeters: 100 } })).status).toBe(403);
    expect((await ctx.api("PUT", "/settings/location", { token: admin.token, body: { intervalMinutes: 7, movementMeters: 100 } })).status).toBeGreaterThanOrEqual(400);
    const saved = await ctx.api("PUT", "/settings/location", { token: admin.token, body: { intervalMinutes: 10, movementMeters: 100 } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ intervalMinutes: 10, movementMeters: 100, staleAfterMinutes: 30 });
    const mine = await ctx.api("GET", "/rider/location", { token: s.rider.token });
    expect(mine.body.settings).toEqual({ intervalMinutes: 10, movementMeters: 100 });
    expect(await ctx.prisma.auditLog.count({ where: { action: "location_settings.update" } })).toBe(1);
  });

  it("resolves the position for each state with the rider, hub, vehicle and delivery rules", async () => {
    const s = await setup();
    const id = await book(s);
    // Waiting for pickup: nothing on the map.
    expect((await position(id, s.ops.token)).body).toMatchObject({ kind: "none", lat: null });

    // Pickup rider with a live position: staff see "Pickup rider R-2101"; the merchant does not.
    await ctx.api("POST", `/parcels/${id}/assign-pickup`, { token: s.ops.token, body: { riderId: s.rider.rider.id } });
    await online(s.rider);
    expect((await ctx.api("POST", "/rider/location", { token: s.rider.token, body: fix(23.795, 90.41) })).status).toBe(202);
    const pickup = await position(id, s.ops.token);
    expect(pickup.body).toMatchObject({ kind: "rider", lat: 23.795, lng: 90.41, stale: false, rider: { code: "R-2101" } });
    expect(pickup.body.label).toBe("Pickup rider R-2101 · on the way to pick up");
    const pickupMerchant = await position(id, s.owner.token);
    expect(pickupMerchant.body).toMatchObject({ kind: "none", lat: null, rider: null });

    // At the hub: the hub's coordinates.
    await ctx.api("POST", `/rider/parcels/${id}/pickup`, { token: s.rider.token, body: { outcome: "COLLECTED_TO_HUB", hubId: s.gulshan.id } });
    for (const token of [s.ops.token, s.owner.token]) expect((await position(id, token)).body).toMatchObject({ kind: "hub", ...GUL, label: "At Gulshan Hub", hub: { code: "HUB-GUL" } });

    // In a vehicle, location not shared: "On the way from … to …" at the origin hub.
    const { bag, trip } = await (async () => {
      const bag = (await ctx.api("POST", "/linehaul/bags", { token: s.gulOp.token, body: { originHubId: s.gulshan.id, destHubId: s.dhanmondi.id } })).body;
      await ctx.api("POST", `/linehaul/bags/${bag.number}/items`, { token: s.gulOp.token, body: { code: id, source: "CAMERA" } });
      await ctx.api("POST", `/linehaul/bags/${bag.number}/seal`, { token: s.gulOp.token, body: { sealNo: "S-1" } });
      const trip = (
        await ctx.api("POST", "/linehaul/trips", { token: s.gulOp.token, body: { originHubId: s.gulshan.id, destHubId: s.dhanmondi.id, vehicleRegNo: "DHAKA METRO-TA 11-2345", driverName: "Karim Mia", driverPhone: "01711222333" } })
      ).body;
      await ctx.api("POST", `/linehaul/trips/${trip.number}/bags`, { token: s.gulOp.token, body: { bag: bag.number } });
      return { bag, trip };
    })();
    expect((await position(id, s.ops.token)).body.detail).toContain(`Loaded on ${trip.number}`);
    expect((await ctx.api("POST", `/linehaul/trips/${trip.id}/depart`, { token: s.gulOp.token })).status).toBe(200);
    const notShared = await position(id, s.ops.token);
    expect(notShared.body).toMatchObject({ kind: "vehicle", ...GUL, label: "On the way from Gulshan Hub to Dhanmondi Hub", approximate: true, trip: { number: trip.number, sharing: false } });

    // Vehicle shared: the vehicle's position, for staff and for the merchant's own parcel.
    const started = await ctx.api("POST", "/vehicle-shares", { token: s.rider.token, body: { trip: trip.number.toLowerCase() } });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    expect((await ctx.api("POST", `/vehicle-shares/${started.body.share.id}/location`, { token: s.rider.token, body: fix(23.77, 90.39) })).status).toBe(202);
    for (const token of [s.ops.token, s.owner.token]) {
      const shared = await position(id, token);
      expect(shared.body).toMatchObject({ kind: "vehicle", lat: 23.77, lng: 90.39, stale: false, label: "In vehicle DHAKA METRO-TA 11-2345 (Gulshan Hub → Dhanmondi Hub)", trip: { sharing: true } });
      expect(shared.body.ageSeconds).toBeLessThan(60);
    }
    // The recipient's public tracking page never gets the vehicle's position.
    const publicTrack = await ctx.api("GET", `/track/${id}`);
    expect(publicTrack.status).toBe(200);
    expect(JSON.stringify(publicTrack.body)).not.toContain("23.77");
    expect((await ctx.api("GET", `/parcels/${id}/position`)).status).toBe(401);

    // Received at Dhanmondi: the trip arrives, sharing stops by itself, the parcel is at the hub.
    expect((await ctx.api("POST", `/linehaul/bags/${bag.number}/receive`, { token: s.dhnOp.token, body: { hubId: s.dhanmondi.id } })).status).toBe(200);
    expect((await position(id, s.owner.token)).body).toMatchObject({ kind: "hub", ...DHN, label: "At Dhanmondi Hub" });

    // Out for delivery: staff see the rider; the merchant only with "Live rider location".
    await ctx.api("POST", `/parcels/${id}/assign-delivery`, { token: s.ops.token, body: { riderId: s.dhnRider.rider.id } });
    expect((await ctx.api("POST", `/rider/parcels/${id}/start-delivery`, { token: s.dhnRider.token })).status).toBeLessThan(300);
    await online(s.dhnRider);
    await ctx.api("POST", "/rider/location", { token: s.dhnRider.token, body: fix(23.75, 90.38) });
    expect((await position(id, s.ops.token)).body).toMatchObject({ kind: "rider", lat: 23.75, label: "With rider R-2201", rider: { code: "R-2201" } });
    await ctx.prisma.parcel.update({ where: { trackingId: id }, data: { services: { set: (await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: id } })).services.filter(x => x !== "tracking.live_location") } } });
    const hidden = await position(id, s.owner.token);
    expect(hidden.body).toMatchObject({ kind: "hub", ...DHN, rider: null });
    expect(hidden.body.label).toBe("Out for delivery from Dhanmondi Hub");
    expect(JSON.stringify(hidden.body)).not.toContain("23.75");
    await ctx.prisma.parcel.update({ where: { trackingId: id }, data: { services: { push: "tracking.live_location" } } });
    const live = await position(id, s.owner.token);
    expect(live.body).toMatchObject({ kind: "rider", lat: 23.75, label: "With the delivery rider", rider: null, detail: null });
    // A stale fix is hidden from the merchant again.
    await ctx.prisma.riderLocation.update({ where: { riderId: s.dhnRider.rider.id }, data: { at: new Date(Date.now() - 20 * 60_000) } });
    expect((await position(id, s.owner.token)).body.kind).toBe("hub");
    expect((await position(id, s.ops.token)).body).toMatchObject({ kind: "rider", stale: true });

    // Delivered: the proof of delivery's location.
    const parcel = await ctx.prisma.parcel.update({ where: { trackingId: id }, data: { status: "DELIVERED", deliveredAt: new Date() } });
    await ctx.prisma.deliveryProof.create({ data: { parcelId: parcel.id, method: "OTP", receivedBy: "Nabila", lat: 23.7466, lng: 90.3801, capturedAt: new Date() } });
    for (const token of [s.ops.token, s.owner.token]) expect((await position(id, token)).body).toMatchObject({ kind: "last", lat: 23.7466, lng: 90.3801, label: "Delivered here" });

    // Another merchant's parcel is not found.
    const other = await ctx.prisma.merchant.create({
      data: { code: "MR-VL2", type: "ECOMMERCE", name: "Other", status: "ACTIVE", kycStatus: "APPROVED", contactName: "O", contactPhone: "+8801911000021", pickupAddress: "x", pickupArea: "Gulshan", pickupDistrict: "Dhaka North" },
    });
    const otherOwner = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: other.id }], "Other Owner");
    expect((await position(id, otherOwner.token)).status).toBe(404);
  });

  it("starts, sends, stops and auto-stops vehicle sharing with permission checks and audit", async () => {
    const s = await setup();
    const id = await book(s);
    const { bag, trip } = await inTransit(s, id);

    // Shareable trips: riders and staff of the trip's hubs.
    const list = await ctx.api("GET", "/vehicle-shares/trips", { token: s.rider.token });
    expect(list.body.items.map((t: { number: string }) => t.number)).toContain(trip.number);
    expect((await ctx.api("GET", "/vehicle-shares/trips", { token: s.uttRider.token })).body.items).toHaveLength(0);

    // Not allowed: a rider or hub operator of another hub, a merchant.
    expect((await ctx.api("POST", "/vehicle-shares", { token: s.uttRider.token, body: { trip: trip.number } })).status).toBe(403);
    expect((await ctx.api("POST", "/vehicle-shares", { token: s.uttOp.token, body: { trip: trip.number } })).status).toBe(403);
    expect((await ctx.api("POST", "/vehicle-shares", { token: s.owner.token, body: { trip: trip.number } })).status).toBe(403);
    expect((await ctx.api("POST", "/vehicle-shares", { token: s.rider.token, body: { trip: "MF-000000-0000" } })).status).toBe(404);

    // A planned trip can be shared (the driver starts before leaving); the destination hub's operator can too.
    const started = await ctx.api("POST", "/vehicle-shares", { token: s.rider.token, body: { trip: trip.number } });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const shareId = started.body.share.id as string;
    expect(started.body.share.trip).toMatchObject({ number: trip.number, route: "Gulshan Hub → Dhanmondi Hub" });
    expect(started.body.settings).toMatchObject({ intervalMinutes: 5 });
    expect((await ctx.api("GET", "/vehicle-shares/mine", { token: s.rider.token })).body.share.id).toBe(shareId);
    // Someone else's share can't be fed.
    expect((await ctx.api("POST", `/vehicle-shares/${shareId}/location`, { token: s.dhnOp.token, body: fix(23.78, 90.4) })).status).toBe(404);

    expect((await ctx.api("POST", `/linehaul/trips/${trip.id}/depart`, { token: s.gulOp.token })).status).toBe(200);
    const sent = await ctx.api("POST", `/vehicle-shares/${shareId}/location`, { token: s.rider.token, body: fix(23.78, 90.4) });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    expect(sent.body).toMatchObject({ live: true, stopped: false });
    // An older fix (replayed) is kept as history but doesn't move the vehicle back.
    await ctx.api("POST", `/vehicle-shares/${shareId}/location`, { token: s.rider.token, body: fix(23.7, 90.3, new Date(Date.now() - 60_000)) });
    expect((await ctx.api("POST", `/vehicle-shares/${shareId}/location`, { token: s.rider.token, body: fix(23.7, 90.3, new Date(Date.now() + 3_600_000)) })).status).toBe(422);

    // Operations maps: managers and both hubs' operators; not other hubs.
    const opsMap = await ctx.api("GET", "/vehicle-locations", { token: s.ops.token });
    expect(opsMap.body.items).toHaveLength(1);
    expect(opsMap.body.items[0]).toMatchObject({ number: trip.number, lat: 23.78, lng: 90.4, sharing: true, sharedBy: "Rider R-2101", stale: false, status: "DEPARTED" });
    expect((await ctx.api("GET", "/vehicle-locations", { token: s.dhnOp.token })).body.items).toHaveLength(1);
    expect((await ctx.api("GET", "/vehicle-locations", { token: s.uttOp.token })).body.items).toHaveLength(0);
    expect((await ctx.api("GET", "/vehicle-locations", { token: s.rider.token })).status).toBe(403);
    const history = await ctx.api("GET", `/vehicle-locations/${trip.number}/history`, { token: s.gulOp.token });
    expect(history.body.points).toHaveLength(2);
    expect((await ctx.api("GET", `/vehicle-locations/${trip.number}/history`, { token: s.uttOp.token })).status).toBe(403);

    // Stop: the position stays as "last known" and is shown as stale.
    const stopped = await ctx.api("POST", `/vehicle-shares/${shareId}/stop`, { token: s.rider.token });
    expect(stopped.status).toBe(200);
    expect(stopped.body.share).toMatchObject({ endReason: "STOPPED" });
    expect((await ctx.api("GET", "/vehicle-shares/mine", { token: s.rider.token })).body.share).toBeNull();
    expect((await position(id, s.ops.token)).body).toMatchObject({ kind: "vehicle", lat: 23.78, stale: true, trip: { sharing: false } });
    expect((await ctx.api("POST", `/vehicle-shares/${shareId}/location`, { token: s.rider.token, body: fix(23.79, 90.41) })).body).toMatchObject({ stopped: true, reason: "STOPPED" });

    // The destination hub's operator takes over (the rider's share would end as TAKEN_OVER).
    const again = await ctx.api("POST", "/vehicle-shares", { token: s.rider.token, body: { trip: trip.id } });
    const takeover = await ctx.api("POST", "/vehicle-shares", { token: s.dhnOp.token, body: { trip: trip.number } });
    expect(takeover.status, JSON.stringify(takeover.body)).toBe(201);
    expect((await ctx.prisma.vehicleShare.findUniqueOrThrow({ where: { id: again.body.share.id } })).endReason).toBe("TAKEN_OVER");
    await ctx.api("POST", `/vehicle-shares/${takeover.body.share.id}/location`, { token: s.dhnOp.token, body: fix(23.76, 90.38) });

    // Arrival ends sharing automatically (audited); the next fix tells the phone to stop.
    expect((await ctx.api("POST", `/linehaul/bags/${bag.number}/receive`, { token: s.dhnOp.token, body: { hubId: s.dhanmondi.id } })).status).toBe(200);
    expect((await ctx.prisma.linehaulTrip.findUniqueOrThrow({ where: { id: trip.id } })).status).toBe("ARRIVED");
    expect((await ctx.prisma.vehicleShare.findUniqueOrThrow({ where: { id: takeover.body.share.id } })).endReason).toBe("TRIP_ARRIVED");
    expect((await ctx.api("POST", `/vehicle-shares/${takeover.body.share.id}/location`, { token: s.dhnOp.token, body: fix(23.75, 90.37) })).body).toMatchObject({ stopped: true, reason: "TRIP_ARRIVED" });
    expect((await ctx.api("POST", "/vehicle-shares", { token: s.dhnOp.token, body: { trip: trip.number } })).body.error.code).toBe("TRIP_NOT_SHAREABLE");
    expect((await ctx.api("GET", "/vehicle-locations", { token: s.ops.token })).body.items).toHaveLength(0);

    const actions = (await ctx.prisma.auditLog.findMany({ where: { action: { startsWith: "vehicle_share." } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })).map(a => a.action);
    expect(actions).toEqual(["vehicle_share.start", "vehicle_share.stop", "vehicle_share.start", "vehicle_share.stop", "vehicle_share.start", "vehicle_share.auto_stop"]);
  });
});
