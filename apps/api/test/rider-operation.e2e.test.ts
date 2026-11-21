import { hub, parcelBody, resetDatabase, riderUser, startApp, userWithRoles, type TestContext } from "./helpers";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

// Scan desk / Operations app › Rider Operation: operations staff choose a rider and do the rider app's steps for them
// (hub-desk/riders/:riderId/…) with the rider app's own rules; the staff member is recorded as the actor.
describe("Rider Operation (staff do a rider's steps)", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  let seq = 9300;
  const setup = async () => {
    const h = await hub(ctx, "HUB-ROP");
    const shop = await ctx.prisma.merchant.create({
      data: { code: `MR-${++seq}`, type: "ECOMMERCE", name: "Rider Op Shop", status: "ACTIVE", contactName: "Owner", contactPhone: "+8801911000000", pickupAddress: "House 5 Road 2", pickupArea: "Gulshan 1", pickupDistrict: "Dhaka North" },
    });
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops Manager");
    const owner = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: shop.id }], "Shop Owner");
    const rider = await riderUser(ctx, "R-3001", h.id);
    const other = await riderUser(ctx, "R-3002", h.id);
    return { h, shop, ops, owner, rider, other };
  };
  type Setup = Awaited<ReturnType<typeof setup>>;
  const op = (s: Setup, riderId: string, path: string, body?: Record<string, unknown>, token = s.ops.token) =>
    ctx.api(body ? "POST" : "GET", `/hub-desk/riders/${riderId}${path}`, { token, ...(body ? { body } : {}) });
  const book = async (s: Setup) => {
    const res = await ctx.api("POST", "/ops/parcels", { token: s.ops.token, body: { merchantId: s.shop.id, ...parcelBody(), sender: undefined, pickup: undefined } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const id = res.body.trackingId as string;
    expect((await ctx.api("POST", `/parcels/${id}/assign-pickup`, { token: s.ops.token, body: { riderId: s.rider.rider.id } })).status).toBe(200);
    return id;
  };
  const status = async (s: Setup, id: string) => (await ctx.api("GET", `/parcels/${id}`, { token: s.ops.token })).body.status as string;

  it("does the rider's day for them: pickup, start, deliver, could not deliver, returned to merchant", async () => {
    const s = await setup();
    const a = await book(s);
    const b = await book(s);

    // The rider's lists, as the rider app sees them.
    const tasks = await op(s, s.rider.rider.id, "/tasks");
    expect(tasks.status, JSON.stringify(tasks.body)).toBe(200);
    expect(tasks.body.pickups.map((p: { trackingId: string }) => p.trackingId).sort()).toEqual([a, b].sort());
    const stop = tasks.body.pickups[0].pickupStop.key as string;

    // Pickup from merchant: collected by the rider (with the rider app's checks), the staff member recorded.
    for (const id of [a, b]) expect((await op(s, s.rider.rider.id, `/parcels/${id}/pickup`, { outcome: "COLLECTED", expectedStop: stop })).status).toBe(200);
    expect(await status(s, a)).toBe("PICKED_UP");
    const carried = (await ctx.api("GET", "/rider/tasks", { token: s.rider.token })).body.carrying.map((p: { trackingId: string }) => p.trackingId);
    expect(carried.sort()).toEqual([a, b].sort());
    const parcelA = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: a }, include: { events: { orderBy: { createdAt: "desc" }, take: 1 } } });
    expect(parcelA.events[0]).toMatchObject({ status: "PICKED_UP", actorUserId: s.ops.user.id });
    expect(parcelA.events[0].description).toContain("R-3001");

    // Not this rider's pickup, and no right to do it: refused.
    const wrong = await op(s, s.other.rider.id, `/parcels/${a}/pickup`, { outcome: "COLLECTED" });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.message).toContain("this rider");
    expect((await op(s, s.rider.rider.id, "/tasks", undefined, s.owner.token)).status).toBe(403);

    // At the hub, then out for delivery and delivered (signature, the COD collected by the rider).
    for (const id of [a, b]) {
      expect((await ctx.api("POST", "/ops/hub-receive", { token: s.ops.token, body: { code: id, hubId: s.h.id } })).body.ok).toBe(true);
      expect((await ctx.api("POST", `/parcels/${id}/assign-delivery`, { token: s.ops.token, body: { riderId: s.rider.rider.id } })).body.status).toBe("ASSIGNED");
      expect((await op(s, s.rider.rider.id, `/parcels/${id}/start-delivery`, {})).status).toBe(200);
    }
    expect(await status(s, a)).toBe("OUT_FOR_DELIVERY");
    const cod = Number((await ctx.api("GET", `/parcels/${a}`, { token: s.ops.token })).body.codAmount);
    // The rider app's rule: the exact COD.
    expect((await op(s, s.rider.rider.id, `/parcels/${a}/delivery`, { outcome: "DELIVERED", receivedBy: "Nabila", proof: { method: "SIGNATURE", image: PNG }, codCollected: cod - 1 })).body.error.code).toBe("COD_MISMATCH");
    const delivered = await op(s, s.rider.rider.id, `/parcels/${a}/delivery`, { outcome: "DELIVERED", receivedBy: "Nabila", proof: { method: "SIGNATURE", image: PNG }, codCollected: cod });
    expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);
    expect(await status(s, a)).toBe("DELIVERED");
    expect(await ctx.prisma.codCollection.findFirstOrThrow({ where: { parcel: { trackingId: a } } })).toMatchObject({ riderId: s.rider.rider.id });

    // Could not deliver → return to sender: stays with the rider, the choice recorded.
    expect((await op(s, s.rider.rider.id, `/parcels/${b}/delivery`, { outcome: "FAILED", reason: "Recipient refused", nextAction: "RETURN" })).status).toBe(200);
    expect(await status(s, b)).toBe("RETRY_SCHEDULED");
    expect(await ctx.prisma.deliveryAttempt.findFirstOrThrow({ where: { parcel: { trackingId: b }, outcome: "FAILED" } })).toMatchObject({ riderId: s.rider.rider.id, nextAction: "RETURN" });

    // Back at the hub, on the rider's return run, returned to the merchant.
    expect((await ctx.api("POST", "/hub-desk/receive-back", { token: s.ops.token, body: { code: b, hubId: s.h.id } })).body.ok).toBe(true);
    expect((await ctx.api("POST", "/hub-desk/return-assign", { token: s.ops.token, body: { code: b, hubId: s.h.id, riderId: s.rider.rider.id } })).body.ok).toBe(true);
    const runs = await op(s, s.rider.rider.id, "/return-runs");
    expect(runs.body.items).toHaveLength(1);
    expect(runs.body.items[0].parcels.map((p: { trackingId: string }) => p.trackingId)).toEqual([b]);
    expect((await op(s, s.other.rider.id, `/parcels/${b}/return`, { runId: runs.body.items[0].id })).status).toBe(403);
    const back = await op(s, s.rider.rider.id, `/parcels/${b}/return`, { runId: runs.body.items[0].id, receivedBy: "Shop desk" });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body).toMatchObject({ outcome: "RETURNED", runCompleted: true });
    expect(await status(s, b)).toBe("RETURNED");
  });
});
