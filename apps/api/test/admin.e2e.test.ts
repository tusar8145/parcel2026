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
      // From the website customer default package (service packages v2).
      expect(read.body.customerParcelPricing).toEqual({
        sameZone: 70,
        crossZone: 130,
        extraWeight: 15,
        codFeePercent: 1,
        serviceFees: { Regular: 0, "Same day": 40, Express: 40 },
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

    it("mirrors the default packages' prices and the catalog in force", async () => {
      const { token } = await admin();
      await ctx.api("PUT", "/settings/platform-config", { token, body: { merchantPricing: { document: { documentRates: { Contract: 90 } } } } });
      const ecom = (await ctx.api("GET", "/packages?segment=ECOMMERCE", { token })).body.find((p: { isDefault: boolean }) => p.isDefault);
      const version = await ctx.api("POST", `/packages/${ecom.id}/versions`, { token, body: { services: ecom.current.services, prices: { ...ecom.current.prices, sameDistrict: 65, differentDistrict: 110 } } });
      expect(version.status, JSON.stringify(version.body)).toBe(201);
      const read = await ctx.api("GET", "/settings/platform-config");
      expect(read.body.merchantPricing.ecommerce).toMatchObject({ sameZone: 65, crossZone: 110, extraWeight: 15 });
      expect(read.body.merchantPricing.document).toMatchObject({ sameZone: 70, documentRates: { Contract: 90 } });
      expect(read.body.deliveryRates).toMatchObject({ sameZone: 65, crossZone: 110 });
    });
  });

  // ───────────── rate cards ─────────────

  describe("rate cards", () => {
    it("retires rate cards: new prices come from the website customer package; history stays readable", async () => {
      const { token } = await admin();
      const refused = await ctx.api("POST", "/rate-cards", { token, body: { segment: "CUSTOMER", name: "Customer v1", config: { sameZone: 80, crossZone: 130 } } });
      expect(refused.status).toBe(410);
      expect(refused.body.error.code).toBe("PRICING_RETIRED");
      const customer = (await ctx.api("GET", "/packages?segment=CUSTOMER", { token })).body.find((p: { isDefault: boolean }) => p.isDefault);
      const prices = { ...customer.current.prices, sameDistrict: 90, differentDistrict: 140, extraKg: 25, codPercent: 2, expressFee: 40 };
      expect((await ctx.api("POST", `/packages/${customer.id}/versions`, { token, body: { services: customer.current.services, prices } })).status).toBe(201);
      // A scheduled version doesn't apply yet.
      await ctx.api("POST", `/packages/${customer.id}/versions`, { token, body: { services: customer.current.services, prices: { ...prices, sameDistrict: 500 }, effectiveFrom: "2027-06-01T00:00:00Z" } });
      const catalog = await ctx.api("GET", "/catalog");
      expect(catalog.body.customerRateCard).toMatchObject({ sameZone: 90, crossZone: 140, codFeePercent: 2 });
      // Dhaka → Dhaka: 90 + 2 kg (2 × 25) + Express 40 + COD fee 2% of 1500 = 30.
      const quote = await ctx.api("POST", "/pricing/quote", { body: { pickupDistrict: "Dhaka North", pickupZone: "Gulshan", deliveryDistrict: "Dhaka Central", deliveryZone: "Dhanmondi", weightKg: 2, serviceLevel: "SAME_DAY", codAmount: 1500 } });
      expect(quote.body).toMatchObject({ tier: "SAME_DISTRICT", baseCharge: 90, weightCharge: 50, serviceCharge: 40, codFee: 30, totalCharge: 210, package: { isDefault: true } });
      const booker = await userWithRoles(ctx, [{ role: "CUSTOMER" }]);
      const booked = await ctx.api("POST", "/parcels", { token: booker.token, body: parcelBody() });
      expect(booked.status, JSON.stringify(booked.body)).toBe(201);
      expect(booked.body.charges.total).toBe(210);
      expect((await ctx.api("GET", "/rate-cards?segment=CUSTOMER", { token })).status).toBe(200);
      expect((await auditOf("package.version")).length).toBe(2);
    });

    it("validates cards and queries", async () => {
      const { token } = await admin();
      const bad = await ctx.api("POST", "/rate-cards", { token, body: { segment: "CUSTOMER", name: "Bad", config: { sameZone: -5, codFeePercent: 200 } } }); // still validated before the retired answer
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
      // No product lists in the platform config: forms read the parcel products. Retired lists are never stored.
      expect(config.ecommerceProducts).toBeUndefined();
      expect((await ctx.api("GET", "/catalog")).body.products).toContain("Fashion & Apparel");
      expect((await ctx.api("GET", "/catalog")).body.products).not.toContain("Clothing");
      await ctx.api("PUT", "/settings/platform-config", {
        token,
        body: { channels: { sms: true }, ecommerceProducts: ["Old"], documentProducts: ["Old"], documentTypes: ["Curtout"], serviceCatalog: [], returnReasons: ["Shop closed"] },
      });
      const stored = (await ctx.prisma.setting.findUnique({ where: { key: "platform-config" } }))!.value as Record<string, unknown>;
      expect(Object.keys(stored).sort()).toEqual(["channels", "returnReasons"]);
      const after = (await ctx.api("GET", "/settings/platform-config")).body;
      expect(after.documentTypes).toBeUndefined();
      expect(after.documentProducts).toBeUndefined();
      // Return requests offer the saved return reasons.
      expect((await ctx.api("GET", "/returns/reasons", { token })).body.reasons).toEqual(["Shop closed"]);
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
