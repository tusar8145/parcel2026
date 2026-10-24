import { hub, parcelBody, resetDatabase, startApp, userWithRoles, type TestContext } from "./helpers";

/** Courier Operations' bell: a merchant's order, Excel import or pickup request reaches operations managers and its hub's managers. */
describe("new work from merchants in the operations bell", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  it("notifies operations managers and the merchant's hub manager, not other hubs", async () => {
    const gulshan = await hub(ctx, "HUB-NW1");
    const other = await hub(ctx, "HUB-NW2");
    const shop = await ctx.prisma.merchant.create({
      data: { code: "MR-NW01", type: "ECOMMERCE", name: "Notify Shop", status: "ACTIVE", kycStatus: "APPROVED", contactName: "Owner", contactPhone: "+8801911000071", pickupAddress: "House 5 Road 2", pickupArea: "Gulshan", pickupDistrict: "Dhaka North", pickupHubId: gulshan.id },
    });
    const owner = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: shop.id }], "Shop Owner");
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops Manager");
    const hubManager = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: gulshan.id }], "Gulshan Manager");
    const otherManager = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: other.id }], "Other Manager");
    const bell = (userId: string, type: string) => ctx.prisma.userNotification.findMany({ where: { userId, type } });

    // An order from the merchant panel.
    const booked = await ctx.api("POST", "/parcels", { token: owner.token, body: parcelBody({ codAmount: 500 }) });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    const [opsNote] = await bell(ops.user.id, "staff.merchant_order");
    expect(opsNote).toMatchObject({ title: "New order from Notify Shop" });
    expect(opsNote.body).toContain(booked.body.trackingId);
    expect(await bell(hubManager.user.id, "staff.merchant_order")).toHaveLength(1);
    expect(await bell(otherManager.user.id, "staff.merchant_order")).toHaveLength(0);
    // Operations booking for the merchant: no notice (they did it themselves).
    expect((await ctx.api("POST", "/ops/parcels", { token: ops.token, body: { merchantId: shop.id, ...parcelBody(), sender: undefined, pickup: undefined } })).status).toBe(201);
    expect(await bell(ops.user.id, "staff.merchant_order")).toHaveLength(1);

    // A pickup request.
    const tomorrow = new Date(Date.now() + 86_400_000 + 6 * 3600_000).toISOString().slice(0, 10);
    const pickup = await ctx.api("POST", "/merchants/me/pickup-requests", { token: owner.token, body: { date: tomorrow, windowStart: "10:00", windowEnd: "12:00", expectedParcels: 8 } });
    expect(pickup.status, JSON.stringify(pickup.body)).toBe(201);
    const [pickupNote] = await bell(hubManager.user.id, "staff.pickup_request");
    expect(pickupNote).toMatchObject({ title: "Pickup requested by Notify Shop" });
    expect(pickupNote.body).toContain("about 8 parcels");
    expect(await bell(ops.user.id, "staff.pickup_request")).toHaveLength(1);
    expect(await bell(otherManager.user.id, "staff.pickup_request")).toHaveLength(0);
  });
});
