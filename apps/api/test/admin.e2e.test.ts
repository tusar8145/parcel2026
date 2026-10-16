import { parcelBody, resetDatabase, startApp, userWithRoles, type TestContext } from "./helpers";

describe("admin: platform settings, pricing and overview", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  const admin = () => userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Super Admin");
  const auditOf = (action: string) => ctx.prisma.auditLog.findMany({ where: { action }, orderBy: { id: "asc" } });

  // ───────────── platform config ─────────────

  describe("platform config", () => {
    it("is 404 until saved, then public, with server-owned settings filled in from the catalog and rate cards", async () => {
      expect((await ctx.api("GET", "/settings/platform-config")).status).toBe(404);
      const { token } = await admin();
      const config = {
        channels: { sms: false, email: true },
        notifications: [{ name: "Pickup confirmed", channels: ["SMS"], enabled: true }],
        servicePlans: { ecommerce: { Growth: { monthlyFee: 1490, services: { email: true } } } },
        // Server-owned: ignored on save, always derived on read.
        geoCatalog: { district: ["Nowhere"], zone: [], area: [] },
        customerParcelPricing: { sameZone: 1, crossZone: 2, extraWeight: 3, codFeePercent: 4 },
      };
      const saved = await ctx.api("PUT", "/settings/platform-config", { token, body: config });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect(saved.body.channels).toEqual({ sms: false, email: true });

      const read = await ctx.api("GET", "/settings/platform-config"); // no token: public
      expect(read.status).toBe(200);
      expect(read.headers["cache-control"]).toBe("no-store");
      expect(read.body.servicePlans).toEqual(config.servicePlans);
      expect(read.body.notifications).toEqual(config.notifications);
      expect(read.body.geoCatalog.district).toContain("Dhaka North");
      expect(read.body.geoCatalog.district).not.toContain("Nowhere");
      expect(read.body.geoHierarchy.zonesByDistrict["Dhaka North"]).toContain("Gulshan");
      expect(read.body.customerParcelPricing).toEqual({
        sameZone: 70,
        crossZone: 120,
        extraWeight: 20,
        codFeePercent: 1,
        serviceFees: { Regular: 0, "Same day": 30, Express: 50 },
      });
      expect(read.body.deliveryServices).toEqual(["Regular", "Same day", "Express"]);

      const stored = await ctx.prisma.setting.findUniqueOrThrow({ where: { key: "platform-config" } });
      expect(stored.value).not.toHaveProperty("geoCatalog");
      expect(stored.value).not.toHaveProperty("customerParcelPricing");

      const [entry] = await auditOf("platform_config.update");
      expect(entry.entityId).toBe("platform-config");
      expect((entry.data as { changedKeys: string[] }).changedKeys).toEqual(["channels", "notifications", "servicePlans"]);
    });

    it("replaces the whole document and audits only the changed keys", async () => {
      const { token } = await admin();
      await ctx.api("PUT", "/settings/platform-config", { token, body: { a: 1, b: { c: [1, 2] } } });
      const second = await ctx.api("PUT", "/settings/platform-config", { token, body: { b: { c: [1, 2] }, d: "new" } });
      expect(second.status).toBe(200);
      expect(second.body).not.toHaveProperty("a");
      expect(second.body.d).toBe("new");
      const entries = await auditOf("platform_config.update");
      expect((entries[1].data as { changedKeys: string[] }).changedKeys).toEqual(["a", "d"]);
    });

    it("follows the rate cards and catalog in force", async () => {
      const { token } = await admin();
      await ctx.api("PUT", "/settings/platform-config", { token, body: { merchantPricing: { document: { documentRates: { Contract: 90 } } } } });
      const card = await ctx.api("POST", "/rate-cards", {
        token,
        body: { segment: "ECOMMERCE", name: "E-commerce Q4", config: { sameZone: 65, crossZone: 110 } },
      });
      expect(card.status, JSON.stringify(card.body)).toBe(201);
      const read = await ctx.api("GET", "/settings/platform-config");
      expect(read.body.merchantPricing.ecommerce).toMatchObject({ sameZone: 65, crossZone: 110, extraWeight: 20 });
      expect(read.body.merchantPricing.document).toMatchObject({ sameZone: 70, documentRates: { Contract: 90 } });
      expect(read.body.deliveryRates).toMatchObject({ sameZone: 65, crossZone: 110 });
    });

    it("rejects anything but a JSON object, oversized documents, deep nesting and prototype keys", async () => {
      const { token } = await admin();
      for (const body of [[1, 2], "text", 42]) {
        const res = await ctx.api("PUT", "/settings/platform-config", { token, body: JSON.stringify(body), headers: { "content-type": "application/json" } });
        expect(res.status, JSON.stringify(body)).toBe(422);
        expect(res.body.error.code).toBe("VALIDATION_FAILED");
      }
      const big = await ctx.api("PUT", "/settings/platform-config", { token, body: { blob: "x".repeat(300 * 1024) } });
      expect(big.status).toBe(422);
      expect(big.body.error.details[0].message).toMatch(/limit is 256 KB/);

      let deep: Record<string, unknown> = { leaf: true };
      for (let i = 0; i < 15; i++) deep = { next: deep };
      expect((await ctx.api("PUT", "/settings/platform-config", { token, body: deep })).status).toBe(422);

      const proto = await ctx.api("PUT", "/settings/platform-config", {
        token,
        body: '{"a":{"__proto__":{"admin":true}}}',
        headers: { "content-type": "application/json" },
      });
      expect([400, 422]).toContain(proto.status);
      const ctor = await ctx.api("PUT", "/settings/platform-config", { token, body: { a: { prototype: 1 } } });
      expect(ctor.status).toBe(422);
      expect(await ctx.prisma.setting.findUnique({ where: { key: "platform-config" } })).toBeNull();
    });

    it("needs config:manage to save", async () => {
      expect((await ctx.api("PUT", "/settings/platform-config", { body: { a: 1 } })).status).toBe(401);
      for (const role of ["OPS_MANAGER", "FINANCE", "CUSTOMER"] as const) {
        const { token } = await userWithRoles(ctx, [{ role }]);
        expect((await ctx.api("PUT", "/settings/platform-config", { token, body: { a: 1 } })).status, role).toBe(403);
      }
    });
  });

  // ───────────── rate cards ─────────────

  describe("rate cards", () => {
    it("versions customer pricing: a new card is used for quotes, the catalog and bookings; history stays", async () => {
      const { token } = await admin();
      const before = await ctx.api("GET", "/rate-cards/current", { token });
      expect(before.body.CUSTOMER).toMatchObject({ id: null, config: { sameZone: 70 } });

      const first = await ctx.api("POST", "/rate-cards", {
        token,
        body: { segment: "CUSTOMER", name: "Customer v1", config: { sameZone: 80, crossZone: 130 } },
      });
      const second = await ctx.api("POST", "/rate-cards", {
        token,
        body: {
          segment: "CUSTOMER",
          name: "Customer v2",
          config: { sameZone: 90, crossZone: 140, extraWeight: 25, codFeePercent: 2, serviceFees: { REGULAR: 0, SAME_DAY: 40, EXPRESS: 60 } },
        },
      });
      expect(second.status).toBe(201);
      // A scheduled card doesn't apply yet.
      await ctx.api("POST", "/rate-cards", {
        token,
        body: { segment: "CUSTOMER", name: "Customer 2027", config: { sameZone: 500 }, effectiveFrom: "2027-01-01T00:00:00Z" },
      });

      const current = await ctx.api("GET", "/rate-cards/current", { token });
      expect(current.body.CUSTOMER).toMatchObject({ id: second.body.id, name: "Customer v2", config: { sameZone: 90, extraWeight: 25 } });
      expect(current.body.ECOMMERCE.id).toBeNull();

      const catalog = await ctx.api("GET", "/catalog");
      expect(catalog.body.customerRateCard).toMatchObject({ sameZone: 90, crossZone: 140, codFeePercent: 2 });
      const quote = await ctx.api("POST", "/pricing/quote", {
        body: {
          pickupDistrict: "Dhaka North",
          pickupZone: "Gulshan",
          deliveryDistrict: "Dhaka Central",
          deliveryZone: "Dhanmondi",
          weightKg: 2,
          serviceLevel: "SAME_DAY",
          codAmount: 1500,
        },
      });
      expect(quote.body).toMatchObject({ baseCharge: 140, weightCharge: 25, serviceCharge: 40, codFee: 30, totalCharge: 235, rateCardId: second.body.id });

      const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }]);
      const booked = await ctx.api("POST", "/parcels", { token: customer.token, body: parcelBody() });
      expect(booked.status, JSON.stringify(booked.body)).toBe(201);
      expect(booked.body.charges.total).toBe(235);

      const history = await ctx.api("GET", "/rate-cards?segment=CUSTOMER", { token });
      expect(history.body.map((c: { name: string }) => c.name)).toEqual(["Customer 2027", "Customer v2", "Customer v1"]);
      expect(first.body.id).toBeTruthy();
      expect((await auditOf("rate_card.create")).map(a => (a.data as { name: string }).name)).toEqual(["Customer v1", "Customer v2", "Customer 2027"]);

      // Deactivating the current card falls back to the previous version.
      expect((await ctx.api("DELETE", `/rate-cards/${second.body.id}`, { token })).status).toBe(200);
      expect((await ctx.api("GET", "/rate-cards/current", { token })).body.CUSTOMER.name).toBe("Customer v1");
    });

    it("validates cards and queries", async () => {
      const { token } = await admin();
      const bad = await ctx.api("POST", "/rate-cards", { token, body: { segment: "CUSTOMER", name: "Bad", config: { sameZone: -5, codFeePercent: 200 } } });
      expect(bad.status).toBe(422);
      expect((await ctx.api("POST", "/rate-cards", { token, body: { segment: "VIP", name: "Bad", config: {} } })).status).toBe(422);
      expect((await ctx.api("GET", "/rate-cards?segment=VIP", { token })).status).toBe(422);
      expect((await ctx.api("DELETE", "/rate-cards/0190a5f2-0000-7000-8000-000000000000", { token })).status).toBe(404);
      const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }]);
      expect((await ctx.api("POST", "/rate-cards", { token: ops.token, body: { segment: "CUSTOMER", name: "Nope", config: {} } })).status).toBe(403);
      expect((await ctx.api("GET", "/rate-cards/current", { token: ops.token })).status).toBe(403);
    });
  });

  // ───────────── catalog ─────────────

  describe("catalog", () => {
    const catalog = (overrides: Record<string, unknown> = {}) => ({
      districts: ["Dhaka North", "Sylhet"],
      zonesByDistrict: { "Dhaka North": ["Gulshan"], Sylhet: ["Zindabazar"] },
      areasByZone: { Zindabazar: ["Lamabazar"] },
      packaging: ["Box"],
      products: ["Clothing"],
      weightsKg: [0.5, 1],
      ...overrides,
    });

    it("saves the catalog, audits it and shows it in the platform config", async () => {
      const { token } = await admin();
      const res = await ctx.api("PUT", "/catalog", { token, body: catalog() });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect((await ctx.api("GET", "/catalog")).body.zonesByDistrict.Sylhet).toEqual(["Zindabazar"]);
      expect((await auditOf("catalog.update")).length).toBe(1);

      await ctx.api("PUT", "/settings/platform-config", { token, body: { channels: { sms: true } } });
      const config = (await ctx.api("GET", "/settings/platform-config")).body;
      expect(config.geoCatalog).toEqual({ district: ["Dhaka North", "Sylhet"], zone: ["Gulshan", "Zindabazar"], area: ["Lamabazar"] });
      expect(config.geoHierarchy.areasByZone).toEqual({ Zindabazar: ["Lamabazar"] });
      expect(config.ecommercePackaging).toEqual(["Box"]);
      expect(config.ecommerceProducts).toEqual(["Clothing"]);
    });

    it("keeps the hierarchy consistent", async () => {
      const { token } = await admin();
      const orphanZone = await ctx.api("PUT", "/catalog", { token, body: catalog({ zonesByDistrict: { Rajshahi: ["Boalia"] } }) });
      expect(orphanZone.status).toBe(422);
      expect(orphanZone.body.error.details[0].message).toMatch(/Rajshahi is not in the district list/);
      const orphanArea = await ctx.api("PUT", "/catalog", { token, body: catalog({ areasByZone: { Boalia: ["Shaheb Bazar"] } }) });
      expect(orphanArea.status).toBe(422);
      const duplicate = await ctx.api("PUT", "/catalog", { token, body: catalog({ packaging: ["Box", "box"] }) });
      expect(duplicate.status).toBe(422);
      expect((await ctx.api("PUT", "/catalog", { token, body: catalog({ districts: [] }) })).status).toBe(422);
    });
  });

  // ───────────── overview and users ─────────────

  describe("overview", () => {
    it("counts merchants, staff, riders and this month's parcels", async () => {
      const { token } = await admin();
      await userWithRoles(ctx, [{ role: "FINANCE" }]);
      const merchant = await ctx.prisma.merchant.create({
        data: {
          code: "MR-T1",
          type: "ECOMMERCE",
          name: "Shop",
          status: "PENDING_REVIEW",
          contactName: "Owner",
          contactPhone: "+8801711111111",
          pickupAddress: "Road 1",
          pickupArea: "Gulshan",
          pickupDistrict: "Dhaka North",
        },
      });
      expect((await ctx.api("PATCH", `/merchants/${merchant.id}`, { token, body: { status: "ACTIVE" } })).status).toBe(200);
      const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }]);
      expect((await ctx.api("POST", "/parcels", { token: customer.token, body: parcelBody() })).status).toBe(201);
      const owner = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: merchant.id }]);
      expect((await ctx.api("POST", "/parcels", { token: owner.token, body: parcelBody({ codAmount: 0 }) })).status).toBe(201);

      const res = await ctx.api("GET", "/admin/overview", { token });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.merchants).toMatchObject({ total: 1, active: 1, pendingReview: 0, newThisMonth: 1, approvedThisMonth: 1 });
      expect(res.body.staff.active).toBe(2);
      expect(res.body.staff.byRole).toMatchObject({ SUPER_ADMIN: 1, FINANCE: 1, OPS_MANAGER: 0 });
      expect(res.body.parcels).toMatchObject({ today: 2, thisMonth: 2, codThisMonth: 1500 });
      expect(res.body.parcels.chargesThisMonth).toBeGreaterThan(0);
      expect(res.body.merchantActivity).toEqual([expect.objectContaining({ merchantId: merchant.id, parcelsThisMonth: 1 })]);

      const customerRes = await ctx.api("GET", "/admin/overview", { token: customer.token });
      expect(customerRes.status).toBe(403);
    });
  });

  describe("users by role", () => {
    it("lists users holding any of several roles", async () => {
      const { token } = await admin();
      await userWithRoles(ctx, [{ role: "FINANCE" }], "Fin");
      await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Cus");
      const res = await ctx.api("GET", "/users?roles=SUPER_ADMIN,finance", { token });
      expect(res.status).toBe(200);
      expect(res.body.items.map((u: { name: string }) => u.name).sort()).toEqual(["Fin", "Super Admin"]);
      expect((await ctx.api("GET", "/users?roles=WIZARD", { token })).status).toBe(422);
    });
  });
});
