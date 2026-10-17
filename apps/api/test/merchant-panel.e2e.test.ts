import { parcelBody, resetDatabase, riderUser, startApp, userWithRoles, type TestContext } from "./helpers";

/** What the merchant panels (ecommerce-merchant, banking-merchant) need from the API. */
describe("merchant panels", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  let seq = 0;
  async function workspace(type: "ECOMMERCE" | "BANKING_FINANCIAL" = "ECOMMERCE", discountPct = 0) {
    const plan = discountPct ? await ctx.prisma.servicePlan.create({ data: { segment: type, name: `Plan ${++seq}`, monthlyFee: 0, discountPct } }) : null;
    const m = await ctx.prisma.merchant.create({
      data: {
        code: `MR-P${++seq}`,
        type,
        name: `Workspace ${seq}`,
        status: "ACTIVE",
        planId: plan?.id,
        contactName: "Owner",
        contactPhone: "+8801711111111",
        pickupAddress: "House 12, Road 5, Banani",
        pickupArea: "Banani Block C",
        pickupDistrict: "Dhaka North",
      },
    });
    const owner = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: m.id }], "Shop Owner");
    const staff = await userWithRoles(ctx, [{ role: "MERCHANT_STAFF", merchantId: m.id }], "Shop Staff");
    return { m, owner, staff };
  }

  /** The body the panel's order form sends. */
  const portalOrder = (overrides: Record<string, unknown> = {}) =>
    parcelBody({
      sender: { name: "Workspace", phone: "01711111111" },
      pickup: { category: "Office", street: "House 12, Road 5, Banani", area: "Banani Block C", zone: "Banani", district: "Dhaka North" },
      type: "ECOMMERCE",
      saveAddresses: false,
      ...overrides,
    });

  const book = async (token: string, overrides: Record<string, unknown> = {}, key?: string) => {
    const res = await ctx.api("POST", "/parcels", { token, body: portalOrder(overrides), headers: key ? { "idempotency-key": key } : {} });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
  };

  const markDelivered = async (trackingId: string, deliveredAt: Date, riderId?: string) => {
    const parcel = await ctx.prisma.parcel.update({ where: { trackingId }, data: { status: "DELIVERED", deliveredAt, pickedUpAt: deliveredAt } });
    if (riderId && Number(parcel.codAmount) > 0) await ctx.prisma.codCollection.create({ data: { parcelId: parcel.id, riderId, amount: parcel.codAmount, state: "AT_HUB" } });
    return parcel;
  };

  describe("portal booking", () => {
    it("prices with the plan, replays an Idempotency-Key and lists the order for the merchant only", async () => {
      const { m, owner, staff } = await workspace("ECOMMERCE", 10);
      const other = await workspace();
      const first = await book(owner.token, {}, "panel-order-0001");
      expect(first).toMatchObject({ channel: "MERCHANT_PORTAL", type: "ECOMMERCE", merchant: { id: m.id }, codAmount: 1500 });
      // Old service plans are retired (service packages v2): the merchant books with its category default.
      expect(first.service.package.name).toBe("E-commerce default");

      const replay = await book(owner.token, {}, "panel-order-0001");
      expect(replay.trackingId).toBe(first.trackingId);
      expect(await ctx.prisma.parcel.count({ where: { merchantId: m.id } })).toBe(1);

      const reused = await ctx.api("POST", "/parcels", { token: owner.token, body: portalOrder({ codAmount: 10 }), headers: { "idempotency-key": "panel-order-0001" } });
      expect(reused.status).toBe(422);
      expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");

      // Staff book and see the same workspace's orders; other merchants don't.
      await book(staff.token, { recipient: { name: "Staff Booking", phone: "01812000001" } });
      const mine = await ctx.api("GET", `/parcels?merchantId=${m.id}&limit=50`, { token: staff.token });
      expect(mine.body.items.map((p: { merchant: { id: string } }) => p.merchant.id)).toEqual([m.id, m.id]);
      const theirs = await ctx.api("GET", "/parcels", { token: other.owner.token });
      expect(theirs.body.items).toHaveLength(0);
      expect((await ctx.api("GET", `/parcels/${first.trackingId}`, { token: other.owner.token })).status).toBe(404);
    });

    it("books document consignments with the corporate rate card and a unique reference", async () => {
      const { owner } = await workspace("BANKING_FINANCIAL");
      const doc = await book(owner.token, {
        type: "DOCUMENT",
        weightKg: 0.5,
        codAmount: 0,
        declaredValue: 0,
        packaging: "Security pouch",
        contents: "Cheque book",
        merchantOrderRef: "CARD-2026-0012",
        instructions: "Receiver relationship: Self · Origin branch: MBP-DHK-01",
      });
      expect(doc).toMatchObject({ type: "DOCUMENT", merchantOrderRef: "CARD-2026-0012", codAmount: 0, instructions: expect.stringContaining("MBP-DHK-01") });
      const snapshot = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: doc.trackingId } });
      expect((snapshot.pricingSnapshot as { segment: string }).segment).toBe("BANKING_FINANCIAL");

      const dup = await ctx.api("POST", "/parcels", { token: owner.token, body: portalOrder({ type: "DOCUMENT", codAmount: 0, merchantOrderRef: "CARD-2026-0012" }) });
      expect(dup.status).toBe(409);
      expect(dup.body.error).toMatchObject({ code: "DUPLICATE_ORDER_REF", details: { trackingId: doc.trackingId } });
    });

    it("cancels an order before operations confirm it", async () => {
      const { owner } = await workspace();
      const order = await book(owner.token);
      const res = await ctx.api("POST", `/parcels/${order.trackingId}/cancel`, { token: owner.token, body: { reason: "Customer changed their mind" } });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ status: "PICKUP_CANCELLED", canCancel: false, cancelReason: "Customer changed their mind" });
    });
  });

  describe("GET /merchants/me/stats", () => {
    it("is empty for a new workspace", async () => {
      const { owner } = await workspace();
      const res = await ctx.api("GET", "/merchants/me/stats", { token: owner.token });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.parcels).toMatchObject({ total: 0, inTransit: 0, awaitingPickup: 0, needsAttention: 0 });
      expect(res.body.today).toMatchObject({ created: 0, shipments: 0, completionRate: null });
      expect(res.body.thisMonth).toMatchObject({ created: 0, deliverySuccessRate: null });
      expect(res.body.series).toMatchObject({ period: "7d", bucket: "day" });
      expect(res.body.series.labels).toHaveLength(7);
      expect(res.body.series.current).toEqual([0, 0, 0, 0, 0, 0, 0]);
      expect(res.body.customers).toEqual({ total: 0, newThisMonth: 0, repeat: 0, repeatRate: null });
      expect(res.body.money).toMatchObject({ cod: { withRiders: 0, atHubs: 0 }, invoices: { outstanding: 0, outstandingCount: 0 }, unbilled: { parcels: 0 } });
    });

    it("counts orders, deliveries, customers and money for the workspace", async () => {
      const { m, owner, staff } = await workspace();
      const other = await workspace();
      const rider = await riderUser(ctx, "R-STAT1");
      const finance = await userWithRoles(ctx, [{ role: "FINANCE" }], "Finance");

      const pending = await book(owner.token, { recipient: { name: "Repeat Buyer", phone: "01812000010" } });
      const moving = await book(owner.token, { recipient: { name: "Repeat Buyer", phone: "01812000010" }, codAmount: 800 });
      const codDelivered = await book(owner.token, { recipient: { name: "Cash Buyer", phone: "01812000011" }, codAmount: 2000 });
      const prepaidBilled = await book(owner.token, { recipient: { name: "Prepaid Buyer", phone: "01812000012" }, codAmount: 0 });
      const prepaidUnbilled = await book(owner.token, { recipient: { name: "Prepaid Two", phone: "01812000013" }, codAmount: 0 });
      const cancelled = await book(owner.token, { recipient: { name: "Gone", phone: "01812000014" } });
      await book(other.owner.token); // another merchant's parcel never counts

      await ctx.prisma.parcel.update({ where: { trackingId: moving.trackingId }, data: { status: "OUT_FOR_DELIVERY", pickedUpAt: new Date() } });
      await markDelivered(codDelivered.trackingId, new Date(), rider.rider.id);
      const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
      await markDelivered(prepaidBilled.trackingId, twoDaysAgo);
      await markDelivered(prepaidUnbilled.trackingId, new Date());
      await ctx.api("POST", `/parcels/${cancelled.trackingId}/cancel`, { token: owner.token, body: {} });

      // Finance bills the earlier prepaid delivery.
      const invoice = await ctx.api("POST", "/invoices", {
        token: finance.token,
        body: { merchantId: m.id, periodStart: new Date(Date.now() - 3 * 86_400_000).toISOString(), periodEnd: new Date(Date.now() - 86_400_000).toISOString() },
      });
      expect(invoice.status, JSON.stringify(invoice.body)).toBe(201);

      const res = await ctx.api("GET", "/merchants/me/stats?period=30d", { token: owner.token });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const s = res.body;
      expect(s.merchantId).toBe(m.id);
      expect(s.parcels).toMatchObject({ total: 6, awaitingPickup: 1, inTransit: 1, delivered: 3, cancelled: 1, needsAttention: 0 });
      expect(s.parcels.byStatus).toMatchObject({ PENDING_CONFIRMATION: 1, OUT_FOR_DELIVERY: 1, DELIVERED: 3, PICKUP_CANCELLED: 1 });
      expect(s.today).toMatchObject({ created: 6, delivered: 2, shipments: 4, completionRate: 50 });
      expect(s.thisMonth.created).toBeGreaterThanOrEqual(5);
      expect(s.thisMonth.codValue).toBeGreaterThanOrEqual(1500 + 800 + 2000);
      expect(s.series).toMatchObject({ period: "30d", bucket: "day" });
      expect(s.series.labels).toHaveLength(30);
      expect(s.series.current.at(-1)).toBe(6);
      expect(s.series.current.reduce((a: number, b: number) => a + b, 0)).toBe(6);
      // Four recipients (the cancelled order excluded), one of whom ordered twice.
      expect(s.customers).toMatchObject({ total: 4, repeat: 1, repeatRate: 25 });

      expect(s.money.cod).toMatchObject({ atHubs: 2000, withRiders: 0 });
      expect(s.money.cod.readyToSettle.parcels).toBe(1);
      expect(s.money.cod.readyToSettle.net).toBe(2000 - codDelivered.charges.total);
      expect(s.money.invoices).toMatchObject({ outstandingCount: 1, outstanding: prepaidBilled.charges.total, overdueCount: 0 });
      expect(s.money.unbilled).toEqual({ parcels: 1, charges: prepaidUnbilled.charges.total });

      const year = await ctx.api("GET", "/merchants/me/stats?period=year", { token: owner.token });
      expect(year.body.series.bucket).toBe("month");
      expect(year.body.series.labels.length).toBe(year.body.series.current.length);
      expect(year.body.series.current.at(-1)).toBe(6);

      // Staff see the counters but not the money.
      const forStaff = await ctx.api("GET", "/merchants/me/stats", { token: staff.token });
      expect(forStaff.status).toBe(200);
      expect(forStaff.body.parcels.total).toBe(6);
      expect(forStaff.body.money).toBeNull();
      expect(pending.trackingId).toBeTruthy();
    });

    it("rejects people outside the merchant and unknown periods", async () => {
      const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }]);
      expect((await ctx.api("GET", "/merchants/me/stats", { token: customer.token })).status).toBe(403);
      const { owner } = await workspace();
      const bad = await ctx.api("GET", "/merchants/me/stats?period=week", { token: owner.token });
      expect(bad.status).toBe(422);
    });
  });

  describe("POST /merchants/me/quote", () => {
    it("quotes the merchant's segment price less the plan discount", async () => {
      const { owner, staff } = await workspace("ECOMMERCE", 10);
      const body = { pickupDistrict: "Dhaka North", pickupZone: "Banani", deliveryDistrict: "Dhaka Central", deliveryZone: "Dhanmondi", weightKg: 2, serviceLevel: "Same day", codAmount: 1000 };
      const res = await ctx.api("POST", "/merchants/me/quote", { token: owner.token, body });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      // Dhaka → Dhaka (same district) 70 + 2 kg (2 × 15) + Express ("Same day") 40 + COD fee 10 (the minimum).
      expect(res.body).toMatchObject({ tier: "SAME_DISTRICT", package: { name: "E-commerce default" }, baseCharge: 70, weightCharge: 30, serviceCharge: 40, codFee: 10, totalCharge: 150 });
      expect(res.body.lines.map((l: { code: string }) => l.code)).toEqual(["route", "weight", "speed", "cod_fee"]);
      expect(res.body.returnCharge).toBe(Math.ceil((res.body.totalCharge * res.body.returnPercent) / 100));
      expect(res.body).not.toHaveProperty("rateCard");

      // The booking is priced the same way.
      const booked = await book(owner.token, {
        pickup: { category: "Office", street: "Road 5", zone: "Banani", district: "Dhaka North" },
        delivery: { category: "Home", street: "Road 7", zone: "Dhanmondi", district: "Dhaka Central" },
        weightKg: 2,
        serviceLevel: "Same day",
        codAmount: 1000,
      });
      expect(booked.charges.total).toBe(res.body.totalCharge);

      expect((await ctx.api("POST", "/merchants/me/quote", { token: staff.token, body })).status).toBe(200);
      const invalid = await ctx.api("POST", "/merchants/me/quote", { token: owner.token, body: { ...body, weightKg: 0 } });
      expect(invalid.status).toBe(422);
    });
  });

  describe("billing and payouts", () => {
    it("shows owners their invoices and settlements; staff can't open them", async () => {
      const { m, owner, staff } = await workspace("BANKING_FINANCIAL");
      const finance = await userWithRoles(ctx, [{ role: "FINANCE" }], "Finance");
      const doc = await book(owner.token, { type: "DOCUMENT", codAmount: 0, weightKg: 0.5 });
      await markDelivered(doc.trackingId, new Date(Date.now() - 2 * 86_400_000));
      const created = await ctx.api("POST", "/invoices", {
        token: finance.token,
        body: { merchantId: m.id, periodStart: new Date(Date.now() - 3 * 86_400_000).toISOString(), periodEnd: new Date(Date.now() - 86_400_000).toISOString() },
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);

      const list = await ctx.api("GET", `/invoices?merchantId=${m.id}`, { token: owner.token });
      expect(list.status).toBe(200);
      expect(list.body.items).toHaveLength(1);
      expect(list.body.items[0]).toMatchObject({ status: "ISSUED", lineCount: 1, subtotal: doc.charges.total });
      const detail = await ctx.api("GET", `/invoices/${created.body.id}`, { token: owner.token });
      expect(detail.body.lines).toEqual([expect.objectContaining({ trackingId: doc.trackingId, amount: doc.charges.total })]);
      expect((await ctx.api("POST", `/invoices/${created.body.id}/mark-paid`, { token: owner.token, body: {} })).status).toBe(403);

      expect((await ctx.api("GET", "/settlements", { token: owner.token })).status).toBe(200);
      expect((await ctx.api("GET", "/invoices", { token: staff.token })).status).toBe(403);
      expect((await ctx.api("GET", "/settlements", { token: staff.token })).status).toBe(403);
    });
  });
});
