import { resetDatabase, startApp, userWithRoles, type TestContext } from "./helpers";

/** "Services & pricing" in the merchant panels (GET /merchants/me/plan): the package in plain words. */
describe("merchant plan page", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  let seq = 0;
  async function merchant(type: "ECOMMERCE" | "BANKING_FINANCIAL" = "ECOMMERCE") {
    const m = await ctx.prisma.merchant.create({
      data: {
        code: `MR-PL${++seq}`,
        type,
        name: `${type === "ECOMMERCE" ? "Plan Shop" : "Plan Bank"} ${seq}`,
        status: "ACTIVE",
        kycStatus: "APPROVED",
        contactName: "Owner",
        contactPhone: "+8801711111111",
        pickupAddress: "House 5 Road 2",
        pickupArea: "Gulshan",
        pickupDistrict: "Dhaka North",
      },
    });
    const owner = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: m.id }], "Owner");
    return { m, owner };
  }
  const item = (body: { services: { items: { code: string; included: boolean; price?: string }[] }[] }, code: string) => body.services.flatMap(s => s.items).find(i => i.code === code);

  it("shows the default package: included and missing services, messages, prices and examples", async () => {
    const { owner } = await merchant();
    const res = await ctx.api("GET", "/merchants/me/plan", { token: owner.token });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const d = res.body;
    expect(d.segment).toBe("ECOMMERCE");
    expect(d.package).toMatchObject({ name: "E-commerce default", isDefault: true });
    expect(d.standard).toBeUndefined();
    // The default package leaves out on-demand pickup, live location and the rider's phone.
    expect(item(d, "first.rider_pickup")).toMatchObject({ included: true });
    expect(item(d, "first.on_demand_pickup")).toMatchObject({ included: false });
    expect(item(d, "tracking.live_location")).toMatchObject({ included: false });
    expect(item(d, "speed.express")).toMatchObject({ included: true, price: "+৳40 per parcel" });
    expect(item(d, "payment.cod")).toMatchObject({ included: true, price: "1% of the cash collected (minimum ৳10)" });
    expect(item(d, "tracking.website")).toMatchObject({ included: true, always: true });
    // Banking-only services aren't listed for an e-commerce merchant.
    expect(item(d, "handling.b2b")).toBeUndefined();
    expect(d.summary.notIncluded).toBe(3);

    // Messages: by stage, to whom, SMS / email as switched in Global notifications (some SMS start off).
    const msg = (code: string) => d.messages.parcel.find((m: { code: string }) => m.code === code);
    expect(msg("notify.booked")).toMatchObject({ to: "You", stage: "Booking & pickup", included: true, channels: { sms: { available: true, on: true } } });
    expect(msg("notify.delivery_code")).toMatchObject({ to: "Your customer", stage: "Delivery", included: true, channels: { sms: { on: true } } });
    expect(msg("notify.pickup_assigned").channels.sms.on).toBe(false);
    expect(msg("notify.guest_verification")).toBeUndefined(); // website customers only
    // Sample texts from the live templates, with the real tracking link and the right names.
    const booked = msg("notify.booked").samples[0];
    expect(booked.sms.text).toContain("PP-261018-B54GG");
    expect(booked.sms.text).toContain("/track/PP-261018-B54GG");
    expect(booked.email.subject).toContain("PP-261018-B54GG");
    expect(booked.email.text).toContain("Hi Owner"); // to the merchant: their contact name
    expect(msg("notify.delivered").samples[0].email.text).toContain("Nabila Ahmed");
    expect(msg("notify.delivery_code").samples[0]).toMatchObject({ email: null });
    expect(msg("notify.delivery_code").samples[0].sms.text).toMatch(/Give code \d+ to the rider/);
    expect(msg("notify.collection").samples.map((x: { event: string }) => x.event)).toEqual(["parcel.ready_for_collection", "parcel.collection_reminder"]);
    expect(d.messages.account.find((a: { event: string }) => a.event === "auth.otp.login")).toMatchObject({ always: true });
    expect(d.messages.account.some((a: { event: string }) => a.event === "finance.settlement_paid")).toBe(true);

    // Prices: the three routes, extras, COD, failed deliveries; examples priced with the real formula.
    expect(d.prices.routes.map((r: { tier: string; amount: number }) => [r.tier, r.amount])).toEqual([
      ["SAME_DISTRICT", 70],
      ["DHAKA_SUBURBAN", 100],
      ["DIFFERENT_DISTRICT", 130],
    ]);
    expect(d.prices.extras[0]).toMatchObject({ label: "Weight", value: "৳15 per extra kg" });
    expect(d.prices.failed[1]).toMatchObject({ value: "50% of the delivery charge" });
    // 1.5 kg Dhaka → Chattogram with ৳1,500 COD: 130 + 1 started kg over 0.5 kg × 15 = 145, + COD 1% (15) = 160.
    expect(d.examples[1]).toMatchObject({ deliveryCharge: 145, codFee: 15, total: 160 });
    expect(d.calculator).toMatchObject({ weight: true, cod: true });
    expect(d.calculator.districts).toContain("Chattogram");
  });

  it("follows the assigned package and its scheduled change; banking merchants see their own services", async () => {
    const admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Admin");
    const { m, owner } = await merchant();
    const catalog = (await ctx.api("GET", "/service-catalog")).body as { services: { code: string; segments: string[] }[] };
    const services = catalog.services.filter(s => s.segments.includes("ECOMMERCE") && !["payment.cod", "notify.delivered"].includes(s.code)).map(s => s.code);
    const created = await ctx.api("POST", "/packages", { token: admin.token, body: { segment: "ECOMMERCE", name: "Gold Shop", services, prices: { sameDistrict: 55, hubDropDiscount: 10 } } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await ctx.api("PUT", `/merchants/${m.id}/package`, { token: admin.token, body: { packageId: created.body.id } })).status).toBe(200);

    const d = (await ctx.api("GET", "/merchants/me/plan", { token: owner.token })).body;
    expect(d.package).toMatchObject({ name: "Gold Shop", isDefault: false });
    expect(item(d, "payment.cod")).toMatchObject({ included: false });
    expect(item(d, "first.on_demand_pickup")).toMatchObject({ included: true });
    expect(item(d, "first.hub_drop")).toMatchObject({ price: "You save ৳10 per parcel" });
    expect(d.messages.parcel.find((x: { code: string }) => x.code === "notify.delivered")).toMatchObject({ included: false });
    expect(d.prices.cod).toEqual([]);
    expect(d.calculator.cod).toBe(false);
    expect(d.prices.routes[0].amount).toBe(55);

    // Another merchant's owner can't read it; a banking merchant gets banking services and no COD.
    const bank = await merchant("BANKING_FINANCIAL");
    expect((await ctx.api("GET", `/merchants/me/plan?merchantId=${m.id}`, { token: bank.owner.token })).status).toBe(403);
    const b = (await ctx.api("GET", "/merchants/me/plan", { token: bank.owner.token })).body;
    expect(b.segment).toBe("BANKING_FINANCIAL");
    expect(item(b, "handling.b2b")).toBeDefined();
    expect(item(b, "payment.cod")).toBeUndefined();
    expect(b.messages.account.some((a: { event: string }) => a.event === "finance.settlement_paid")).toBe(false);
    expect(b.calculator.weight).toBe(false);
    expect(b.prices.includedWeightKg).toBeNull();
  });

  it("opens only for an active merchant", async () => {
    const { m, owner } = await merchant();
    for (const status of ["PENDING_REVIEW", "INFO_REQUESTED", "REJECTED", "SUSPENDED"] as const) {
      await ctx.prisma.merchant.update({ where: { id: m.id }, data: { status } });
      const res = await ctx.api("GET", "/merchants/me/plan", { token: owner.token });
      expect(res.status, status).toBe(403);
      expect(res.body.error.code).toBe("MERCHANT_NOT_ACTIVE");
    }
    await ctx.prisma.merchant.update({ where: { id: m.id }, data: { status: "ACTIVE" } });
    expect((await ctx.api("GET", "/merchants/me/plan", { token: owner.token })).status).toBe(200);
  });

  it("is only for merchant members", async () => {
    const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Customer");
    expect((await ctx.api("GET", "/merchants/me/plan", { token: customer.token })).status).toBe(403);
    expect((await ctx.api("GET", "/merchants/me/plan")).status).toBe(401);
  });
});
