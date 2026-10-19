import { hub, parcelBody, resetDatabase, riderUser, startApp, userWithRoles, type TestContext } from "./helpers";

describe("work queue", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  const setup = async () => {
    const gulshan = await hub(ctx, "HUB-GUL");
    const dhanmondi = await hub(ctx, "HUB-DHN");
    await ctx.prisma.deliveryZone.create({ data: { code: "DN-GUL", name: "Gulshan", district: "Dhaka North", hubId: gulshan.id } });
    await ctx.prisma.deliveryZone.create({ data: { code: "DC-DHN", name: "Dhanmondi", district: "Dhaka Central", hubId: dhanmondi.id } });
    const shop = await ctx.prisma.merchant.create({
      data: { code: "MR-5001", type: "ECOMMERCE", name: "Queue Shop", status: "ACTIVE", contactName: "Owner", contactPhone: "+8801911000001", pickupAddress: "House 5 Road 2", pickupArea: "Gulshan", pickupDistrict: "Dhaka North" },
    });
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops Manager");
    const gulOp = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: gulshan.id }], "Gulshan Operator");
    const dhnOp = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: dhanmondi.id }], "Dhanmondi Operator");
    const pickupRider = await riderUser(ctx, "R-5001", gulshan.id);
    const deliveryRider = await riderUser(ctx, "R-5002", dhanmondi.id);
    await ctx.prisma.rider.updateMany({ data: { status: "ONLINE" } });
    return { gulshan, dhanmondi, shop, ops, gulOp, dhnOp, pickupRider, deliveryRider };
  };
  const book = async (token: string, merchantId: string) => {
    const res = await ctx.api("POST", "/ops/parcels", { token, body: { merchantId, ...parcelBody(), sender: undefined, pickup: undefined } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.trackingId as string;
  };
  const counts = async (token: string, query = "") => {
    const res = await ctx.api("GET", `/work-queue${query}`, { token });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return { ...Object.fromEntries((res.body.tasks as { key: string; count: number }[]).map(t => [t.key, t.count])), missing: res.body.missingDetails.count as number };
  };
  const groups = async (token: string, task: string) => (await ctx.api("GET", `/work-queue/${task}`, { token })).body.groups as { key: string; label: string; count: number }[];
  const scan = async (token: string, task: string, body: Record<string, unknown>) => {
    const res = await ctx.api("POST", `/work-queue/${task}/scan`, { token, body });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { ok: boolean; outcome: string; message: string };
  };
  const parcel = (trackingId: string) => ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId }, select: { status: true, currentHubId: true, pickupRiderId: true, deliveryRiderId: true } });

  it("walks a parcel through every step by scanning: pickup, receive, transfer, receive, delivery", async () => {
    const s = await setup();
    const id = await book(s.ops.token, s.shop.id);

    // Pickup to assign, grouped by pickup area; the rider is chosen above the scan box.
    expect(await counts(s.ops.token)).toMatchObject({ "pickup-assign": 1, "transfer-send": 0 });
    expect(await groups(s.ops.token, "pickup-assign")).toEqual([{ key: "area:Dhaka North|Gulshan", label: "Gulshan, Dhaka North", count: 1 }]);
    expect((await ctx.api("POST", "/work-queue/pickup-assign/scan", { token: s.ops.token, body: { code: id } })).body.error.code).toBe("RIDER_REQUIRED");
    const assigned = await scan(s.ops.token, "pickup-assign", { code: id.toLowerCase(), riderId: s.pickupRider.rider.id });
    expect(assigned).toMatchObject({ ok: true, outcome: "DONE", message: `${id} assigned to Rider R-5001 (R-5001) for pickup.` });
    expect(await parcel(id)).toMatchObject({ status: "PICKUP_ASSIGNED", pickupRiderId: s.pickupRider.rider.id });
    expect(await groups(s.ops.token, "pickup-out")).toEqual([{ key: `rider:${s.pickupRider.rider.id}`, label: "Rider R-5001 (R-5001)", count: 1 }]);

    // Picked up, received at the rider's hub by the Gulshan operator.
    expect((await ctx.api("POST", `/parcels/${id}/status`, { token: s.ops.token, body: { status: "PICKED_UP" } })).status).toBe(200);
    expect(await counts(s.gulOp.token)).toMatchObject({ "pickup-receive": 1 });
    expect(await scan(s.gulOp.token, "pickup-receive", { code: id })).toMatchObject({ ok: true, outcome: "DONE" });
    expect(await parcel(id)).toMatchObject({ status: "AT_HUB", currentHubId: s.gulshan.id });

    // Its delivery zone is served by Dhanmondi: a transfer Gulshan → Dhanmondi, not a delivery.
    expect(await counts(s.gulOp.token)).toMatchObject({ "transfer-send": 1, "delivery-assign": 0 });
    expect(await counts(s.dhnOp.token)).toMatchObject({ "transfer-send": 0 });
    const [route] = await groups(s.ops.token, "transfer-send");
    expect(route).toEqual({ key: `route:${s.gulshan.id}>${s.dhanmondi.id}`, label: "Test Hub HUB-GUL → Test Hub HUB-DHN", count: 1, fromHubId: s.gulshan.id, toHubId: s.dhanmondi.id });
    const list = await ctx.api("GET", `/work-queue/transfer-send/parcels?group=${encodeURIComponent(route.key)}`, { token: s.gulOp.token });
    expect(list.body).toMatchObject({ total: 1, items: [{ trackingId: id, fromHub: "Test Hub HUB-GUL", toHub: "Test Hub HUB-DHN", merchant: "Queue Shop" }] });
    const file = await ctx.app.inject({ method: "GET", url: `/api/v1/work-queue/transfer-send/export?group=${encodeURIComponent(route.key)}`, headers: { authorization: `Bearer ${s.gulOp.token}` } });
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-type"]).toContain("spreadsheetml");
    expect(file.headers["x-row-count"]).toBe("1");
    expect(file.rawPayload.subarray(0, 2).toString()).toBe("PK");

    // Scanned into another list: refused; then dispatched.
    expect(await scan(s.gulOp.token, "transfer-send", { code: id, group: "route:x>y" })).toMatchObject({ ok: false, outcome: "OTHER_GROUP" });
    expect(await scan(s.gulOp.token, "transfer-send", { code: id, group: route.key })).toMatchObject({ ok: true, message: `${id} dispatched to Test Hub HUB-DHN.` });
    expect(await parcel(id)).toMatchObject({ status: "IN_TRANSIT", currentHubId: s.dhanmondi.id });

    // On the way: both ends see it on the same route; Dhanmondi receives it.
    expect(await groups(s.gulOp.token, "transfer-receive")).toEqual([expect.objectContaining({ label: "Test Hub HUB-GUL → Test Hub HUB-DHN", count: 1 })]);
    expect(await counts(s.dhnOp.token)).toMatchObject({ "transfer-receive": 1 });
    expect(await scan(s.ops.token, "transfer-receive", { code: id, hubId: s.gulshan.id })).toMatchObject({ ok: false, outcome: "WRONG_HUB", message: `${id} is going to Test Hub HUB-DHN, not Test Hub HUB-GUL.` });
    expect(await scan(s.dhnOp.token, "transfer-receive", { code: id })).toMatchObject({ ok: true, outcome: "DONE" });

    // At its delivery hub: assign the rider, then out for delivery.
    expect(await groups(s.dhnOp.token, "delivery-assign")).toEqual([expect.objectContaining({ label: "Test Hub HUB-DHN · Dhanmondi, Dhaka Central", count: 1 })]);
    expect(await scan(s.dhnOp.token, "delivery-assign", { code: id, riderId: s.deliveryRider.rider.id })).toMatchObject({ ok: true });
    expect(await scan(s.dhnOp.token, "delivery-dispatch", { code: id })).toMatchObject({ ok: true, message: `${id} is out for delivery with Rider R-5002 (R-5002).` });
    expect(await parcel(id)).toMatchObject({ status: "OUT_FOR_DELIVERY", deliveryRiderId: s.deliveryRider.rider.id });
    expect(await counts(s.ops.token)).toMatchObject({ "delivery-out": 1, "delivery-assign": 0, "transfer-receive": 0 });

    // Steps a scan can't finish, parcels not waiting for the step, unknown codes.
    expect((await ctx.api("POST", "/work-queue/delivery-out/scan", { token: s.ops.token, body: { code: id } })).body.error.code).toBe("NO_SCAN_ACTION");
    expect(await scan(s.ops.token, "pickup-assign", { code: id, riderId: s.pickupRider.rider.id })).toMatchObject({ ok: false, outcome: "NOT_IN_QUEUE" });
    expect(await scan(s.ops.token, "pickup-assign", { code: "PP-000000-0000", riderId: s.pickupRider.rider.id })).toMatchObject({ ok: false, outcome: "NOT_FOUND" });
  });

  it("counts parcels missing delivery details apart and keeps hub staff to their hubs", async () => {
    const s = await setup();
    const id = await book(s.ops.token, s.shop.id);
    await ctx.prisma.parcel.update({ where: { trackingId: id }, data: { incomplete: true, missingFields: ["address"], deliveryStreet: null } });
    expect(await counts(s.ops.token)).toMatchObject({ missing: 1 });
    expect(await groups(s.ops.token, "missing-details")).toEqual([expect.objectContaining({ label: "Queue Shop", count: 1 })]);
    const list = await ctx.api("GET", "/work-queue/missing-details/parcels", { token: s.ops.token });
    expect(list.body.items[0]).toMatchObject({ trackingId: id, missing: ["address"] });

    // Operations managers can narrow to one hub; hub staff can't look at another hub.
    expect(await counts(s.ops.token, `?hubId=${s.dhanmondi.id}`)).toMatchObject({ "pickup-assign": 0 });
    expect(await counts(s.ops.token, `?hubId=${s.gulshan.id}`)).toMatchObject({ "pickup-assign": 1 });
    expect((await ctx.api("GET", `/work-queue?hubId=${s.gulshan.id}`, { token: s.dhnOp.token })).status).toBe(403);
    expect((await ctx.api("GET", "/work-queue/nope", { token: s.ops.token })).status).toBe(404);
  });
});
