import { hub, parcelBody, resetDatabase, riderUser, startApp, userWithRoles, type TestContext } from "./helpers";

describe("linehaul between hubs", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  const setup = async () => {
    const gulshan = await hub(ctx, "HUB-GUL");
    const dhanmondi = await hub(ctx, "HUB-DHN");
    const uttara = await hub(ctx, "HUB-UTT");
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops Manager");
    const gulOp = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: gulshan.id }], "Gulshan Operator");
    const dhnOp = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: dhanmondi.id }], "Dhanmondi Operator");
    const uttOp = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: uttara.id }], "Uttara Operator");
    const support = await userWithRoles(ctx, [{ role: "SUPPORT_AGENT" }], "Support");
    const rider = await riderUser(ctx, "R-3001", gulshan.id);
    return { gulshan, dhanmondi, uttara, ops, gulOp, dhnOp, uttOp, support, rider };
  };
  type Setup = Awaited<ReturnType<typeof setup>>;

  /** Books a parcel and receives it at the hub (through the normal workflow). */
  const atHub = async (s: Setup, hubId: string) => {
    const booked = await ctx.api("POST", "/ops/parcels", { token: s.ops.token, body: parcelBody() });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    const id = booked.body.trackingId as string;
    await ctx.api("POST", `/parcels/${id}/assign-pickup`, { token: s.ops.token, body: { riderId: s.rider.rider.id } });
    const res = await ctx.api("POST", `/parcels/${id}/status`, { token: s.ops.token, body: { status: "AT_HUB", hubId } });
    expect(res.body.status, JSON.stringify(res.body)).toBe("AT_HUB");
    return id;
  };

  const newBag = async (s: Setup, token = s.gulOp.token, from = s.gulshan.id, to = s.dhanmondi.id) => {
    const res = await ctx.api("POST", "/linehaul/bags", { token, body: { originHubId: from, destHubId: to } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; number: string };
  };
  const scanIn = (s: Setup, bag: string, code: string, token = s.gulOp.token) => ctx.api("POST", `/linehaul/bags/${bag}/items`, { token, body: { code, source: "CAMERA" } });
  const seal = (s: Setup, bag: string, sealNo = "SEAL-1", token = s.gulOp.token) => ctx.api("POST", `/linehaul/bags/${bag}/seal`, { token, body: { sealNo } });
  const newTrip = async (s: Setup, token = s.gulOp.token) => {
    const res = await ctx.api("POST", "/linehaul/trips", {
      token,
      body: { originHubId: s.gulshan.id, destHubId: s.dhanmondi.id, vehicleRegNo: "dhaka metro-ta 11-2345", driverName: "Karim Mia", driverPhone: "01711222333" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; number: string };
  };

  /** A sealed bag with the given parcels loaded on a departed trip. */
  const departed = async (s: Setup, parcels: string[]) => {
    const bag = await newBag(s);
    for (const id of parcels) expect((await scanIn(s, bag.number, id)).status).toBe(200);
    expect((await seal(s, bag.number)).status).toBe(200);
    const trip = await newTrip(s);
    expect((await ctx.api("POST", `/linehaul/trips/${trip.number}/bags`, { token: s.gulOp.token, body: { bag: bag.number } })).status).toBe(200);
    const res = await ctx.api("POST", `/linehaul/trips/${trip.id}/depart`, { token: s.gulOp.token });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return { bag, trip };
  };

  it("enforces the bag scan rules and records scans", async () => {
    const s = await setup();
    const p1 = await atHub(s, s.gulshan.id);
    const p2 = await atHub(s, s.dhanmondi.id);
    const pending = await ctx.api("POST", "/ops/parcels", { token: s.ops.token, body: parcelBody() });
    const bag = await newBag(s);
    expect(bag.number).toMatch(/^BG-\d{6}-\d{4}$/);

    const notAtOrigin = await scanIn(s, bag.number, p2);
    expect(notAtOrigin.status).toBe(409);
    expect(notAtOrigin.body.error.code).toBe("PARCEL_NOT_AT_ORIGIN");
    expect((await scanIn(s, bag.number, pending.body.trackingId)).body.error.code).toBe("PARCEL_NOT_AT_ORIGIN");
    expect((await scanIn(s, bag.number, "PP-000000-ZZZZZ")).status).toBe(404);

    const added = await scanIn(s, bag.number, p1.toLowerCase());
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    expect(added.body.added).toBe(true);
    expect(added.body.bag.items).toEqual([expect.objectContaining({ state: "LOADED", parcel: expect.objectContaining({ trackingId: p1 }) })]);
    expect((await scanIn(s, bag.number, p1)).body.added).toBe(false); // scanning twice is harmless

    const other = await newBag(s);
    const dup = await scanIn(s, other.number, p1);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("PARCEL_ALREADY_BAGGED");

    expect((await seal(s, other.number)).body.error.code).toBe("BAG_EMPTY");
    const sealed = await seal(s, bag.id, "sl-778");
    expect(sealed.body).toMatchObject({ status: "SEALED", sealNo: "SL-778" });
    const p3 = await atHub(s, s.gulshan.id);
    expect((await scanIn(s, bag.number, p3)).body.error.code).toBe("BAG_NOT_OPEN");
    expect((await ctx.api("DELETE", `/linehaul/bags/${bag.number}/items/${p1}`, { token: s.gulOp.token })).body.error.code).toBe("BAG_NOT_OPEN");

    const reopened = await ctx.api("POST", `/linehaul/bags/${bag.number}/reopen`, { token: s.gulOp.token });
    expect(reopened.body).toMatchObject({ status: "OPEN", sealNo: null });
    const removed = await ctx.api("DELETE", `/linehaul/bags/${bag.number}/items/${p1}`, { token: s.gulOp.token });
    expect(removed.body.items).toHaveLength(0);

    const scans = await ctx.prisma.scanEvent.findMany({ where: { kind: "BAG_LOAD" } });
    expect(scans.filter(x => x.ok && x.trackingId === p1 && x.source === "CAMERA")).toHaveLength(1);
    expect(scans.filter(x => !x.ok).length).toBeGreaterThanOrEqual(3);
  });

  it("departs a trip: parcels go in transit and appear in the transfer register", async () => {
    const s = await setup();
    const [p1, p2] = [await atHub(s, s.gulshan.id), await atHub(s, s.gulshan.id)];
    const bag = await newBag(s);
    await scanIn(s, bag.number, p1);
    await scanIn(s, bag.number, p2);
    const trip = await newTrip(s);
    expect(trip.number).toMatch(/^MF-\d{6}-\d{4}$/);

    const unsealed = await ctx.api("POST", `/linehaul/trips/${trip.id}/bags`, { token: s.gulOp.token, body: { bag: bag.number } });
    expect(unsealed.body.error.code).toBe("BAG_NOT_SEALED");
    expect((await ctx.api("POST", `/linehaul/trips/${trip.id}/depart`, { token: s.gulOp.token })).body.error.code).toBe("TRIP_EMPTY");
    await seal(s, bag.number);
    const loaded = await ctx.api("POST", `/linehaul/trips/${trip.id}/bags`, { token: s.gulOp.token, body: { bag: bag.number } });
    expect(loaded.body.totals).toMatchObject({ bags: 1, parcels: 2 });
    expect(loaded.body.vehicleRegNo).toBe("DHAKA METRO-TA 11-2345");

    // A parcel taken out of the hub after bagging blocks departure.
    await ctx.api("POST", `/parcels/${p2}/status`, { token: s.ops.token, body: { status: "EXCEPTION", note: "Damaged" } });
    const blocked = await ctx.api("POST", `/linehaul/trips/${trip.id}/depart`, { token: s.gulOp.token });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("PARCELS_NOT_AT_ORIGIN");
    expect(blocked.body.error.details.parcels).toEqual([expect.objectContaining({ trackingId: p2, bag: bag.number })]);
    await ctx.api("POST", `/parcels/${p2}/status`, { token: s.ops.token, body: { status: "AT_HUB", hubId: s.gulshan.id } });

    const gone = await ctx.api("POST", `/linehaul/trips/${trip.number}/depart`, { token: s.gulOp.token });
    expect(gone.status, JSON.stringify(gone.body)).toBe(200);
    expect(gone.body.status).toBe("DEPARTED");
    expect(gone.body.bags[0].status).toBe("IN_TRANSIT");
    for (const id of [p1, p2]) {
      const parcel = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: id } });
      expect(parcel).toMatchObject({ status: "IN_TRANSIT", currentHubId: s.dhanmondi.id });
    }
    const transfers = await ctx.api("GET", "/ops/transfers", { token: s.ops.token });
    expect(transfers.body.map((t: { trackingId: string }) => t.trackingId).sort()).toEqual([p1, p2].sort());
    expect(transfers.body[0]).toMatchObject({ fromHub: s.gulshan.name, toHub: s.dhanmondi.name });
    expect((await ctx.api("POST", `/linehaul/trips/${trip.id}/cancel`, { token: s.gulOp.token })).body.error.code).toBe("INVALID_TRIP_STATUS");
  });

  it("hub transfer report: sent, received, on the way and missing per route and hub; the parcels behind it", async () => {
    const s = await setup();
    const [p1, p2, p3] = [await atHub(s, s.gulshan.id), await atHub(s, s.gulshan.id), await atHub(s, s.gulshan.id)];
    const { bag, trip } = await departed(s, [p1, p2]);
    // p1 arrives, p2 is missing when the bag is opened; p3 is moved by hand to Uttara and is still on the way.
    const opened = await ctx.api("POST", `/linehaul/bags/${bag.number}/receive`, { token: s.dhnOp.token, body: { hubId: s.dhanmondi.id, trackingIds: [p1] } });
    expect(opened.body, JSON.stringify(opened.body)).toMatchObject({ received: 1, missing: 1 });
    expect((await ctx.api("POST", `/parcels/${p3}/status`, { token: s.gulOp.token, body: { status: "IN_TRANSIT", hubId: s.uttara.id } })).status).toBe(200);
    const day = new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);

    const report = await ctx.api("GET", `/reports/hub-transfers?from=${day}&to=${day}`, { token: s.ops.token });
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    expect(report.body.totals).toMatchObject({ sent: 3, received: 1, onTheWay: 1, missing: 1, routes: 2 });
    const route = (to: string) => report.body.routes.find((r: { to: { name: string } }) => r.to.name === to);
    expect(route(s.dhanmondi.name)).toMatchObject({ from: { id: s.gulshan.id }, sent: 2, received: 1, onTheWay: 0, missing: 1 });
    expect(route(s.dhanmondi.name).avgHours).toBeGreaterThanOrEqual(0);
    expect(route(s.uttara.name)).toMatchObject({ sent: 1, received: 0, onTheWay: 1, missing: 0, avgHours: null });
    const gul = report.body.hubs.find((h: { hub: { id: string } }) => h.hub.id === s.gulshan.id);
    expect(gul).toMatchObject({ sentOut: 3, receivedIn: 0, onTheWayOut: 1, missingOut: 1 });

    // Hub staff: only transfers into or out of their hub.
    const dhn = (await ctx.api("GET", `/reports/hub-transfers?from=${day}&to=${day}`, { token: s.dhnOp.token })).body;
    expect(dhn.totals).toMatchObject({ sent: 2, received: 1 });
    expect((await ctx.api("GET", `/reports/hub-transfers?from=${day}&to=${day}&hubId=${s.uttara.id}`, { token: s.dhnOp.token })).status).toBe(403);

    const parcels = (await ctx.api("GET", `/reports/hub-transfers/parcels?from=${day}&to=${day}&fromHubId=${s.gulshan.id}&toHubId=${s.dhanmondi.id}`, { token: s.ops.token })).body.items;
    expect(parcels.map((p: { trackingId: string; state: string }) => [p.trackingId, p.state]).sort()).toEqual([[p1, "Received"], [p2, "Missing"]].sort());
    expect(parcels.find((p: { trackingId: string }) => p.trackingId === p1)).toMatchObject({ trip: trip.number, bag: bag.number, receivedAt: expect.any(String) });
    // From hub → to hub: one direction only.
    const toUtt = (await ctx.api("GET", `/reports/hub-transfers?from=${day}&to=${day}&fromHubId=${s.gulshan.id}&toHubId=${s.uttara.id}`, { token: s.ops.token })).body;
    expect(toUtt.totals).toMatchObject({ sent: 1, received: 0, onTheWay: 1, routes: 1 });
    expect((await ctx.api("GET", `/reports/hub-transfers?from=${day}&to=${day}&fromHubId=${s.dhanmondi.id}`, { token: s.ops.token })).body.totals.sent).toBe(0);
    expect((await ctx.api("GET", `/reports/hub-transfers?from=${day}&to=${day}&toHubId=${s.dhanmondi.id}`, { token: s.ops.token })).body.totals).toMatchObject({ sent: 2, received: 1, missing: 1 });
    // Another day: nothing; too long a range is refused.
    expect((await ctx.api("GET", `/reports/hub-transfers?from=2025-01-01&to=2025-01-01`, { token: s.ops.token })).body.totals.sent).toBe(0);
    expect((await ctx.api("GET", `/reports/hub-transfers?from=2025-01-01&to=2025-03-01`, { token: s.ops.token })).status).toBe(422);
  });

  it("receives a whole bag at the destination and closes the trip", async () => {
    const s = await setup();
    const p1 = await atHub(s, s.gulshan.id);
    const { bag, trip } = await departed(s, [p1]);

    expect((await ctx.api("POST", `/linehaul/bags/${bag.number}/receive`, { token: s.gulOp.token, body: { hubId: s.dhanmondi.id } })).status).toBe(403);
    expect((await ctx.api("POST", `/linehaul/bags/${bag.number}/receive`, { token: s.ops.token, body: { hubId: s.gulshan.id } })).body.error.code).toBe("WRONG_HUB");
    const received = await ctx.api("POST", `/linehaul/bags/${bag.number}/receive`, { token: s.dhnOp.token, body: { hubId: s.dhanmondi.id, sealNo: "SEAL-1" } });
    expect(received.status, JSON.stringify(received.body)).toBe(200);
    expect(received.body).toMatchObject({ received: 1, missing: 0, extra: 0, sealMismatch: false, bag: { status: "RECEIVED" } });
    const parcel = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: p1 }, include: { events: { orderBy: { createdAt: "desc" }, take: 1 } } });
    expect(parcel).toMatchObject({ status: "AT_HUB", currentHubId: s.dhanmondi.id });
    expect(parcel.events[0].metadata).toMatchObject({ hubId: s.dhanmondi.id, bagNumber: bag.number });
    expect((await ctx.api("POST", `/linehaul/bags/${bag.number}/receive`, { token: s.dhnOp.token, body: { hubId: s.dhanmondi.id } })).body.error.code).toBe("BAG_NOT_IN_TRANSIT");

    // Every bag received: the trip arrived on its own; the destination closes it.
    const manifest = await ctx.api("GET", `/linehaul/trips/${trip.number}`, { token: s.dhnOp.token });
    expect(manifest.body).toMatchObject({ status: "ARRIVED", totals: { bags: 1, parcels: 1, received: 1, missing: 0 } });
    expect((await ctx.api("POST", `/linehaul/trips/${trip.id}/close`, { token: s.gulOp.token })).status).toBe(403);
    expect((await ctx.api("POST", `/linehaul/trips/${trip.id}/close`, { token: s.dhnOp.token })).body.status).toBe("CLOSED");
    expect(await ctx.prisma.scanEvent.count({ where: { kind: "BAG_RECEIVE", trackingId: p1, hubId: s.dhanmondi.id } })).toBe(1);
  });

  it("records missing, extra and seal-mismatch discrepancies on a partial receive", async () => {
    const s = await setup();
    const [p1, p2] = [await atHub(s, s.gulshan.id), await atHub(s, s.gulshan.id)];
    const stray = await atHub(s, s.uttara.id);
    const { bag, trip } = await departed(s, [p1, p2]);

    const res = await ctx.api("POST", `/linehaul/bags/${bag.id}/receive`, {
      token: s.dhnOp.token,
      body: { hubId: s.dhanmondi.id, trackingIds: [p1, stray, "PP-261015-NOPE1"], sealNo: "SEAL-9" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ received: 1, missing: 1, extra: 2, sealMismatch: true });
    const kinds = res.body.bag.discrepancies.map((d: { kind: string; trackingId: string | null }) => `${d.kind}:${d.trackingId ?? ""}`).sort();
    expect(kinds).toEqual([`EXTRA:${stray}`, "EXTRA:PP-261015-NOPE1", `MISSING:${p2}`, "SEAL_MISMATCH:"].sort());
    expect((await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: p2 } })).status).toBe("IN_TRANSIT");
    expect((await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: p1 } })).status).toBe("AT_HUB");

    const open = await ctx.api("GET", `/linehaul/discrepancies?open=true&tripId=${trip.id}`, { token: s.dhnOp.token });
    expect(open.body.items).toHaveLength(4);
    expect((await ctx.api("GET", "/linehaul/discrepancies?open=true", { token: s.uttOp.token })).body.items).toHaveLength(0);
    const missing = open.body.items.find((d: { kind: string }) => d.kind === "MISSING");
    expect((await ctx.api("POST", `/linehaul/discrepancies/${missing.id}/resolve`, { token: s.uttOp.token, body: { resolution: "Found" } })).status).toBe(403);
    const resolved = await ctx.api("POST", `/linehaul/discrepancies/${missing.id}/resolve`, { token: s.dhnOp.token, body: { resolution: "Found on the next truck" } });
    expect(resolved.body).toMatchObject({ resolution: "Found on the next truck", resolvedAt: expect.any(String) });
    expect((await ctx.api("POST", `/linehaul/discrepancies/${missing.id}/resolve`, { token: s.dhnOp.token, body: { resolution: "Again" } })).body.error.code).toBe("ALREADY_RESOLVED");
  });

  it("marks parcels in unreceived bags missing when an arrived trip is closed", async () => {
    const s = await setup();
    const [p1, p2] = [await atHub(s, s.gulshan.id), await atHub(s, s.gulshan.id)];
    const b1 = await newBag(s);
    const b2 = await newBag(s);
    await scanIn(s, b1.number, p1);
    await scanIn(s, b2.number, p2);
    await seal(s, b1.number);
    await seal(s, b2.number);
    const trip = await newTrip(s);
    for (const b of [b1, b2]) await ctx.api("POST", `/linehaul/trips/${trip.id}/bags`, { token: s.gulOp.token, body: { bag: b.number } });
    await ctx.api("POST", `/linehaul/trips/${trip.id}/depart`, { token: s.ops.token });
    await ctx.api("POST", `/linehaul/bags/${b1.number}/receive`, { token: s.dhnOp.token, body: { hubId: s.dhanmondi.id } });
    expect((await ctx.api("GET", `/linehaul/trips/${trip.id}`, { token: s.ops.token })).body.status).toBe("DEPARTED");
    expect((await ctx.api("POST", `/linehaul/trips/${trip.id}/close`, { token: s.dhnOp.token })).body.error.code).toBe("INVALID_TRIP_STATUS");
    expect((await ctx.api("POST", `/linehaul/trips/${trip.id}/arrive`, { token: s.dhnOp.token })).body.status).toBe("ARRIVED");
    const closed = await ctx.api("POST", `/linehaul/trips/${trip.id}/close`, { token: s.dhnOp.token });
    expect(closed.body.status).toBe("CLOSED");
    expect(closed.body.totals).toMatchObject({ received: 1, missing: 1, openDiscrepancies: 1 });
    expect(closed.body.discrepancies[0]).toMatchObject({ kind: "MISSING", trackingId: p2 });
  });

  it("plans, cancels and lists trips; vehicles; hub scope and validation", async () => {
    const s = await setup();
    const p1 = await atHub(s, s.gulshan.id);

    // Hub operators work only at their own hubs; support can't change linehaul.
    expect((await ctx.api("POST", "/linehaul/bags", { token: s.dhnOp.token, body: { originHubId: s.gulshan.id, destHubId: s.dhanmondi.id } })).status).toBe(403);
    expect((await ctx.api("POST", "/linehaul/bags", { token: s.support.token, body: { originHubId: s.gulshan.id, destHubId: s.dhanmondi.id } })).status).toBe(403);
    const same = await ctx.api("POST", "/linehaul/bags", { token: s.ops.token, body: { originHubId: s.gulshan.id, destHubId: s.gulshan.id } });
    expect(same.status).toBe(422);
    const badTrip = await ctx.api("POST", "/linehaul/trips", {
      token: s.ops.token,
      body: { originHubId: s.gulshan.id, destHubId: s.dhanmondi.id, driverName: "Karim", driverPhone: "12345" },
    });
    expect(badTrip.status).toBe(422);

    const bag = await newBag(s);
    await scanIn(s, bag.number, p1);
    await seal(s, bag.number);
    expect((await ctx.api("GET", `/linehaul/bags/${bag.number}`, { token: s.uttOp.token })).status).toBe(403);
    expect((await ctx.api("GET", `/linehaul/bags/${bag.number}`, { token: s.dhnOp.token })).body.number).toBe(bag.number);

    // Vehicles: managers register them; trips pick one.
    expect((await ctx.api("POST", "/linehaul/vehicles", { token: s.gulOp.token, body: { regNo: "DHA-1", kind: "Truck" } })).status).toBe(403);
    const vehicle = await ctx.api("POST", "/linehaul/vehicles", { token: s.ops.token, body: { regNo: "dhaka metro-ta 22-1111", kind: "Covered van", capacityKg: 3000 } });
    expect(vehicle.body.regNo).toBe("DHAKA METRO-TA 22-1111");
    expect((await ctx.api("POST", "/linehaul/vehicles", { token: s.ops.token, body: { regNo: "DHAKA METRO-TA 22-1111", kind: "Van" } })).body.error.code).toBe("VEHICLE_EXISTS");
    const trip = await ctx.api("POST", "/linehaul/trips", {
      token: s.gulOp.token,
      body: { originHubId: s.gulshan.id, destHubId: s.dhanmondi.id, vehicleId: vehicle.body.id, driverName: "Karim Mia", driverPhone: "+8801711222333", plannedDepartureAt: new Date().toISOString() },
    });
    expect(trip.body).toMatchObject({ vehicle: { regNo: "DHAKA METRO-TA 22-1111" }, driverPhone: "+8801711222333", status: "PLANNED" });
    await ctx.api("POST", `/linehaul/trips/${trip.body.id}/bags`, { token: s.gulOp.token, body: { bag: bag.number } });
    const wrongRoute = await newBag(s, s.gulOp.token, s.gulshan.id, s.uttara.id);
    const p2 = await atHub(s, s.gulshan.id);
    await scanIn(s, wrongRoute.number, p2);
    await seal(s, wrongRoute.number);
    expect((await ctx.api("POST", `/linehaul/trips/${trip.body.id}/bags`, { token: s.gulOp.token, body: { bag: wrongRoute.number } })).body.error.code).toBe("BAG_ROUTE_MISMATCH");

    // Reopening a loaded (planned) bag takes it off the trip; cancelling detaches the rest.
    const cancelled = await ctx.api("POST", `/linehaul/trips/${trip.body.id}/cancel`, { token: s.gulOp.token });
    expect(cancelled.body).toMatchObject({ status: "CANCELLED", bags: [] });
    expect((await ctx.prisma.linehaulBag.findUniqueOrThrow({ where: { id: bag.id } })).tripId).toBeNull();

    const outbound = await ctx.api("GET", "/linehaul/trips?direction=outbound", { token: s.gulOp.token });
    expect(outbound.body.items).toHaveLength(1);
    expect((await ctx.api("GET", "/linehaul/trips?direction=outbound", { token: s.dhnOp.token })).body.items).toHaveLength(0);
    expect((await ctx.api("GET", `/linehaul/trips?q=${trip.body.number}&status=CANCELLED`, { token: s.ops.token })).body.items).toHaveLength(1);
    const bags = await ctx.api("GET", `/linehaul/bags?q=${p1}`, { token: s.ops.token });
    expect(bags.body.items).toEqual([expect.objectContaining({ number: bag.number, parcels: 1 })]);
    const page = await ctx.api("GET", "/linehaul/bags?limit=1", { token: s.ops.token });
    expect(page.body.nextCursor).toBeTruthy();
    expect((await ctx.api("GET", "/linehaul/bags", { token: s.rider.token })).status).toBe(403);
  });
});
