import { parcelBody, resetDatabase, startApp, userWithRoles, type TestContext } from "./helpers";

// Super admin › Recent messages: each message's text (codes masked), event, parcel and merchant; SMS per merchant.
describe("recent messages", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  it("shows what was sent and counts SMS per merchant in a period", async () => {
    const admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Super Admin");
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops");
    const shop = await ctx.prisma.merchant.create({
      data: { code: "MR-7301", type: "ECOMMERCE", name: "Msg Shop", status: "ACTIVE", contactName: "Owner", contactPhone: "+8801911000301", pickupAddress: "House 5", pickupArea: "Gulshan 1", pickupDistrict: "Dhaka North" },
    });
    const booked = await ctx.api("POST", "/ops/parcels", { token: ops.token, body: { merchantId: shop.id, ...parcelBody(), sender: undefined, pickup: undefined } });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    const t = booked.body.trackingId as string;
    // A message with a code: the code never shows.
    await ctx.prisma.outboxMessage.create({ data: { channel: "SMS", to: "+8801712345678", template: "parcel.delivery_code", body: `Your delivery code for ${t} is 4821.`, trackingId: t, state: "SENT" } });
    await ctx.prisma.outboxMessage.create({ data: { channel: "SMS", to: "+8801712345679", template: "auth.otp", body: "Your sign-in code is 123456", state: "SENT" } });

    const day = new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
    const list = await ctx.api("GET", `/notifications/outbox?channel=SMS&from=${day}&to=${day}&limit=100`, { token: admin.token });
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const code = list.body.find((m: { template: string }) => m.template === "parcel.delivery_code");
    expect(code).toMatchObject({ trackingId: t, merchant: { id: shop.id, name: "Msg Shop" }, eventLabel: expect.any(String) });
    expect(code.text).toContain(t);
    expect(code.text).not.toContain("4821");
    expect(code.to).not.toContain("12345678");
    const byShop = await ctx.api("GET", `/notifications/outbox?merchantId=${shop.id}&limit=100`, { token: admin.token });
    expect(byShop.body.every((m: { merchant: { id: string } | null }) => m.merchant?.id === shop.id)).toBe(true);

    const per = await ctx.api("GET", `/notifications/outbox/by-merchant?channel=SMS&from=${day}&to=${day}`, { token: admin.token });
    expect(per.status, JSON.stringify(per.body)).toBe(200);
    const shopRow = per.body.items.find((r: { merchant: { id: string } | null }) => r.merchant?.id === shop.id);
    expect(shopRow.total).toBeGreaterThanOrEqual(1);
    expect(per.body.items.find((r: { merchant: unknown }) => r.merchant === null)?.total).toBeGreaterThanOrEqual(1);
    expect((await ctx.api("GET", `/notifications/outbox/by-merchant?from=${day}&to=${day}`, { token: ops.token })).status).toBe(403);
  });
});
