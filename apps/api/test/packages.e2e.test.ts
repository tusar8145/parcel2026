import { DEFAULT_PACKAGE_PRICES as P, SEED_PRODUCTS } from "@delivery-fast/shared";
import { CollectionsService } from "../src/modules/parcels/collections.service";
import { decrypt } from "../src/common/crypto";
import { hub, parcelBody, resetDatabase, riderUser, startApp, userWithRoles, type TestContext } from "./helpers";

/** Service packages & pricing (spec v2): packages, route tiers, products, enforcement, Hub Pickup, gating. */
describe("service packages", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  let seq = 0;
  const admin = async (name = "Admin") => userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], name);
  async function merchant(type: "ECOMMERCE" | "BANKING_FINANCIAL" = "ECOMMERCE") {
    const m = await ctx.prisma.merchant.create({
      data: {
        code: `MR-P${++seq}`,
        type,
        name: `${type === "ECOMMERCE" ? "Shop" : "Bank"} ${seq}`,
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
  const catalog = async () => (await ctx.api("GET", "/service-catalog")).body as { services: { code: string; segments: string[] }[] };
  const allServices = async (segment: string, without: string[] = []) => (await catalog()).services.filter(s => s.segments.includes(segment) && !without.includes(s.code)).map(s => s.code);
  async function createPackage(token: string, segment: string, name: string, services: string[], prices: Record<string, number> = {}) {
    const res = await ctx.api("POST", "/packages", { token, body: { segment, name, services, prices } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string };
  }
  async function assign(token: string, merchantId: string, packageId: string | null) {
    const res = await ctx.api("PUT", `/merchants/${merchantId}/package`, { token, body: { packageId } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
  const order = (overrides: Record<string, unknown> = {}) => ({ ...parcelBody({ serviceLevel: "Regular", contents: undefined, ...overrides }) });

  describe("set-up and administration", () => {
    it("creates the three defaults, seeds the products and retires the old pricing (nothing deleted that is used)", async () => {
      await ctx.prisma.rateCard.create({ data: { segment: "ECOMMERCE", name: "Old card", config: { sameZone: 70 } } });
      await ctx.prisma.servicePlan.create({ data: { segment: "ECOMMERCE", name: "Growth", monthlyFee: 0, discountPct: 8 } });
      await ctx.prisma.parcelProduct.create({ data: { segment: "ECOMMERCE", name: "Old unused product" } });
      const { token } = await admin();
      const list = (await ctx.api("GET", "/packages", { token })).body as { segment: string; isDefault: boolean; name: string; current: { prices: Record<string, number> } }[];
      expect(list.filter(p => p.isDefault).map(p => [p.segment, p.name]).sort()).toEqual([
        ["BANKING_FINANCIAL", "Banking & Financial default"],
        ["CUSTOMER", "Customer default"],
        ["ECOMMERCE", "E-commerce default"],
      ]);
      expect(list[0].current.prices).toMatchObject({ sameDistrict: 70, dhakaSuburban: 100, differentDistrict: 130, extraKg: 15, expressFee: 40, codPercent: 1, codMin: 10, returnPercent: 50, freeReattempts: 2 });
      expect(await ctx.prisma.rateCard.count({ where: { active: true } })).toBe(0);
      expect(await ctx.prisma.rateCard.count()).toBe(1); // kept, only deactivated
      expect(await ctx.prisma.servicePlan.count({ where: { active: true } })).toBe(0);
      expect(await ctx.prisma.parcelProduct.count({ where: { name: "Old unused product" } })).toBe(0);
      const ecom = (await ctx.api("GET", "/parcel-products?segment=ECOMMERCE")).body as { name: string; type: string }[];
      expect(ecom).toHaveLength(SEED_PRODUCTS.ECOMMERCE.REGULAR.length + SEED_PRODUCTS.ECOMMERCE.DOCUMENT.length + SEED_PRODUCTS.ECOMMERCE.BOOKS.length);
      expect(ecom.find(p => p.name === "Academic Materials")?.type).toBe("BOOKS");
      // Customers use the e-commerce list; Banking has its own.
      expect((await ctx.api("GET", "/parcel-products?segment=CUSTOMER")).body).toHaveLength(ecom.length);
      expect(((await ctx.api("GET", "/parcel-products?segment=BANKING_FINANCIAL")).body as { name: string }[]).map(p => p.name)).toContain("Cheque Books");
      expect(await ctx.prisma.auditLog.count({ where: { action: "packages.migrate_v2" } })).toBe(1);
    });

    it("versions, assigns with maker-checker, archives instead of deleting a package in use", async () => {
      const a = await admin("Admin A");
      const b = await admin("Admin B");
      const { m, owner } = await merchant();
      const services = await allServices("ECOMMERCE");
      const pending = await ctx.api("POST", "/packages", { token: a.token, body: { segment: "ECOMMERCE", name: "Gold", services, prices: { sameDistrict: 60 } } });
      expect(pending.status, JSON.stringify(pending.body)).toBe(202);
      expect((await ctx.api("POST", `/admin/changes/${pending.body.changeRequest.id}/approve`, { token: b.token, body: {} })).status).toBe(200);
      const gold = (await ctx.api("GET", "/packages?segment=ECOMMERCE", { token: a.token })).body.find((p: { name: string }) => p.name === "Gold");
      const assignReq = await ctx.api("PUT", `/merchants/${m.id}/package`, { token: a.token, body: { packageId: gold.id } });
      expect(assignReq.status).toBe(202);
      expect((await ctx.api("POST", `/admin/changes/${assignReq.body.changeRequest.id}/approve`, { token: b.token, body: {} })).status).toBe(200);
      const quote = await ctx.api("POST", "/merchants/me/quote", { token: owner.token, body: { pickupDistrict: "Dhaka North", deliveryDistrict: "Dhaka South", weightKg: 0.5 } });
      expect(quote.body).toMatchObject({ package: { name: "Gold" }, totalCharge: 60 });
      // A scheduled version doesn't apply until its date.
      const later = await ctx.api("POST", `/packages/${gold.id}/versions`, { token: a.token, body: { services, prices: { sameDistrict: 55 }, effectiveFrom: "2030-01-01T00:00:00Z" } });
      expect(later.status).toBe(202);
      // A booked parcel keeps its price snapshot; the package can't be deleted, only archived.
      const booked = await ctx.api("POST", "/parcels", { token: owner.token, body: order({ codAmount: 0, weightKg: 0.5, delivery: { category: "Home", street: "Road 1", zone: "Motijheel", district: "Dhaka South" } }) });
      expect(booked.status, JSON.stringify(booked.body)).toBe(201);
      expect(booked.body.charges.total).toBe(60);
      expect((await ctx.api("DELETE", `/packages/${gold.id}`, { token: a.token })).body.error.code).toBe("PACKAGE_IN_USE");
      expect(await ctx.prisma.auditLog.count({ where: { action: { in: ["package.create", "package.assign"] } } })).toBe(2);
    });
  });

  describe("route tiers and the price engine", () => {
    it("prices by district route tiers, product type, weight and service; Express only inside the same district", async () => {
      const { token } = await admin();
      const { m, owner } = await merchant();
      const pkg = await createPackage(token, "ECOMMERCE", "Typed", await allServices("ECOMMERCE"), { typeBooks: 8, typeDocument: 5 });
      await assign(token, m.id, pkg.id);
      const q = (body: object) => ctx.api("POST", "/merchants/me/quote", { token: owner.token, body: { pickupDistrict: "Dhaka North", weightKg: 0.5, ...body } });
      expect((await q({ deliveryDistrict: "Gazipur" })).body).toMatchObject({ tier: "DHAKA_SUBURBAN", totalCharge: P.dhakaSuburban });
      expect((await q({ pickupDistrict: "Gazipur", deliveryDistrict: "Narayanganj" })).body).toMatchObject({ tier: "DIFFERENT_DISTRICT", totalCharge: P.differentDistrict });
      expect((await q({ deliveryDistrict: "Dhaka South", product: "Academic Materials", weightKg: 1.6 })).body).toMatchObject({ tier: "SAME_DISTRICT", totalCharge: P.sameDistrict + 8 + 2 * P.extraKg });
      expect((await q({ deliveryDistrict: "Dhaka South", speed: "EXPRESS", codAmount: 3000 })).body.totalCharge).toBe(P.sameDistrict + P.expressFee + 30);
      const express = await q({ deliveryDistrict: "Gazipur", speed: "EXPRESS" });
      expect(express.status).toBe(422);
      expect(express.body.error.code).toBe("EXPRESS_SAME_DISTRICT_ONLY");
      expect((await q({ deliveryDistrict: "Dhaka South", product: "Spaceship" })).body.error.code).toBe("UNKNOWN_PRODUCT");
    });

    it("a form quote with the product prices like the booking (operations, merchant form, walk-in sender)", async () => {
      const { token } = await admin();
      const { m, owner } = await merchant();
      const pkg = await createPackage(token, "ECOMMERCE", "Document fee", await allServices("ECOMMERCE"), { typeDocument: 35 });
      await assign(token, m.id, pkg.id);
      const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops");
      const places = { pickupDistrict: "Dhaka North", deliveryDistrict: "Dhaka Central", deliveryZone: "Dhanmondi" };
      const recipient = { name: "Nabila Ahmed", phone: "1812000000" };
      const delivery = { category: "HOME", street: "Road 7 Flat 3B", zone: "Dhanmondi", district: "Dhaka Central" };

      // Operations New shipment: the live quote sends the product (a Document-type product costs more), then the booking.
      const quoted = await ctx.api("POST", "/packages/quote", { token: ops.token, body: { ...places, merchantId: m.id, weightKg: 7.5, product: "Papers" } });
      expect(quoted.status, JSON.stringify(quoted.body)).toBe(200);
      const regular = await ctx.api("POST", "/packages/quote", { token: ops.token, body: { ...places, merchantId: m.id, weightKg: 7.5 } });
      expect(quoted.body.totalCharge).toBe(regular.body.totalCharge + 35);
      const booked = await ctx.api("POST", "/ops/parcels", { token: ops.token, body: { merchantId: m.id, intake: "PICKUP", recipient, delivery, type: "ECOMMERCE", weightKg: 7.5, codAmount: 0, product: "Papers" } });
      expect(booked.status, JSON.stringify(booked.body)).toBe(201);
      expect(booked.body).toMatchObject({ product: "Papers", weightKg: 7.5, charges: { total: quoted.body.totalCharge } });

      // The merchant order form: COD amount apart from the product value, the product in the quote.
      const formQuote = await ctx.api("POST", "/merchants/me/quote", { token: owner.token, body: { ...places, weightKg: 1, codAmount: 900, product: "Papers" } });
      expect(formQuote.status, JSON.stringify(formQuote.body)).toBe(200);
      const formBooked = await ctx.api("POST", "/parcels", { token: owner.token, body: order({ serviceLevel: undefined, packaging: undefined, weightKg: 1, codAmount: 900, declaredValue: 2000, product: "Papers" }) });
      expect(formBooked.status, JSON.stringify(formBooked.body)).toBe(201);
      expect(formBooked.body).toMatchObject({ codAmount: 900, declaredValue: 2000, charges: { total: formQuote.body.totalCharge } });

      // A walk-in sender (no merchant): the Customer default package, quoted by staff without a merchant.
      const walkQuote = await ctx.api("POST", "/packages/quote", { token: ops.token, body: { ...places, weightKg: 12, product: "Papers" } });
      expect(walkQuote.body.package.name).toBe("Customer default");
      const walkIn = await ctx.api("POST", "/ops/parcels", {
        token: ops.token,
        body: { sender: { name: "Walk-in Sender", phone: "1711000001" }, pickup: { category: "HOME", street: "House 5 Road 2", zone: "Gulshan", district: "Dhaka North" }, intake: "PICKUP", recipient, delivery, type: "PARCEL", weightKg: 12, codAmount: 0, product: "Papers" },
      });
      expect(walkIn.status, JSON.stringify(walkIn.body)).toBe(201);
      expect(walkIn.body).toMatchObject({ merchant: null, channel: "OPERATIONS", weightKg: 12, charges: { total: walkQuote.body.totalCharge } });

      // The website booking form lists the products with their type.
      const site = (await ctx.api("GET", "/catalog")).body as { customerPackage: { products: { name: string; type: string }[] } };
      expect(site.customerPackage.products.find(p => p.name === "Papers")?.type).toBe("DOCUMENT");
    });

    it("refuses services the package doesn't include, on every surface (form/API, import)", async () => {
      const { token } = await admin();
      const { m, owner } = await merchant();
      const pkg = await createPackage(token, "ECOMMERCE", "No extras", await allServices("ECOMMERCE", ["speed.express", "payment.cod", "first.hub_drop"]));
      await assign(token, m.id, pkg.id);
      const api = await ctx.api("POST", "/parcels", { token: owner.token, body: order({ serviceLevel: undefined, speed: "EXPRESS", codAmount: 0 }) });
      expect(api.status).toBe(422);
      expect(api.body.error).toMatchObject({ code: "SERVICE_NOT_IN_PACKAGE", message: "SERVICE_NOT_IN_PACKAGE: Express" });
      const codRes = await ctx.api("POST", "/parcels", { token: owner.token, body: order({ codAmount: 500 }) });
      expect(codRes.body.error?.message, JSON.stringify(codRes.body)).toBe("SERVICE_NOT_IN_PACKAGE: Cash on delivery (COD)");
      // The import modal's first mile is checked before the file is read.
      const imported = await ctx.api("POST", "/imports/validate", { token: owner.token, body: { kind: "ecommerce", firstMile: "HUB_DROP", rows: [{ phone: "01812000000" }] } });
      expect(imported.body.error.code).toBe("SERVICE_NOT_IN_PACKAGE");
      // The package view hides what isn't included.
      const view = (await ctx.api("GET", "/packages/me", { token: owner.token })).body;
      expect(view.options).toMatchObject({ speeds: ["REGULAR"], cod: false, firstMiles: ["RIDER_PICKUP", "ON_DEMAND_PICKUP"] });
      // Banking & Financial: never COD, no weight.
      const bank = await merchant("BANKING_FINANCIAL");
      expect((await ctx.api("POST", "/merchants/me/quote", { token: bank.owner.token, body: { pickupDistrict: "Dhaka North", deliveryDistrict: "Dhaka South", codAmount: 100 } })).status).toBe(422);
    });
  });

  describe("imports", () => {
    it("templates follow the package; the preview prices every row with the modal's choices", async () => {
      const { token } = await admin();
      const { m, owner } = await merchant();
      const pkg = await createPackage(token, "ECOMMERCE", "Open box, no COD", await allServices("ECOMMERCE", ["payment.cod"]), { openBoxFee: 12 });
      await assign(token, m.id, pkg.id);
      const tpl = await ctx.app.inject({ method: "GET", url: "/api/v1/imports/templates/ecommerce", headers: { authorization: `Bearer ${owner.token}` } });
      const { readZip } = await import("../src/modules/imports/xlsx/zip");
      const sheet = readZip(tpl.rawPayload, { maxBytes: 50_000_000 }).get("xl/worksheets/sheet1.xml")!.toString();
      expect(sheet).toContain("<t>Open box</t>");
      expect(sheet).toContain("<t>Service</t>");
      expect(sheet).not.toContain("<t>COD amount (৳)</t>");
      expect(sheet).not.toContain("<t>Cash on delivery</t>");
      // A product whose messages are off: its row is booked with none, whatever the modal ticks.
      await ctx.prisma.parcelProduct.update({ where: { segment_name: { segment: "ECOMMERCE", name: "Academic Materials" } }, data: { sendMessages: false } });
      const res = await ctx.api("POST", "/imports/validate", {
        token: owner.token,
        body: {
          kind: "ecommerce",
          lastMile: "DOORSTEP",
          notifications: ["notify.delivered"],
          rows: [
            { order_ref: "PK-1", phone: "01812000000", "Customer name": "A", address: "Road 1", district: "Dhaka South", zone: "Motijheel", "Open box": "Yes", Product: "Books" },
            { order_ref: "PK-2", phone: "01812000001", "Customer name": "B", address: "Road 2", district: "Chattogram", zone: "Agrabad", Service: "Express" },
            { order_ref: "PK-3", phone: "01812000002", "Customer name": "C", address: "Road 3", district: "Dhaka South", zone: "Motijheel", Product: "Academic Materials" },
          ],
        },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const rows = (await ctx.api("GET", `/imports/${res.body.id}/rows`, { token: owner.token })).body.items;
      expect(rows[0]).toMatchObject({ status: "VALID", charge: P.sameDistrict + 12 });
      expect(rows[0].lines.map((l: { code: string }) => l.code)).toEqual(["route", "open_box"]);
      // Express to another district isn't possible: the row is an error and isn't created.
      expect(rows[1].status).toBe("ERROR");
      expect(rows[1].errors[0]).toMatchObject({ column: "service_level" });
      expect(rows[0]).toMatchObject({ messagesOff: false, messagesNote: null });
      expect(rows[2]).toMatchObject({ status: "VALID", messagesOff: true, messagesNote: "This product doesn't send messages" });
      expect(res.body.totals).toEqual({ rows: 2, charge: P.sameDistrict + 12 + rows[2].charge });
      expect(res.body.services).toMatchObject({ lastMile: "DOORSTEP", notifications: ["notify.delivered"] });
      await ctx.api("POST", `/imports/${res.body.id}/commit`, { token: owner.token });
      const parcel = await ctx.prisma.parcel.findFirstOrThrow({ where: { merchantOrderRef: "PK-1" } });
      expect(parcel).toMatchObject({ openBox: true, productName: "Books", productType: "BOOKS", notifications: ["notify.delivered"] });
      expect(await ctx.prisma.parcel.findFirstOrThrow({ where: { merchantOrderRef: "PK-3" } })).toMatchObject({ productName: "Academic Materials", notifications: [] });
    });
  });

  describe("notifications, proof, gating", () => {
    it("products have one Send SMS & email switch (default on); editing other fields keeps it", async () => {
      const { token } = await admin();
      await ctx.api("GET", "/packages", { token }); // set-up
      const created = await ctx.api("POST", "/parcel-products", { token, body: { segment: "ECOMMERCE", name: "Quiet goods", type: "REGULAR", sendMessages: false } });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body).toMatchObject({ name: "Quiet goods", sendMessages: false });
      const plain = await ctx.api("POST", "/parcel-products", { token, body: { segment: "ECOMMERCE", name: "Loud goods" } });
      expect(plain.body).toMatchObject({ sendMessages: true, type: "REGULAR" });
      // A PATCH of another field doesn't reset the switch (or the type) to its default.
      await ctx.api("PATCH", `/parcel-products/${created.body.id}`, { token, body: { type: "BOOKS" } });
      expect(await ctx.prisma.parcelProduct.findUniqueOrThrow({ where: { id: created.body.id } })).toMatchObject({ sendMessages: false, type: "BOOKS" });
      const on = await ctx.api("PATCH", `/parcel-products/${created.body.id}`, { token, body: { sendMessages: true } });
      expect(on.body).toMatchObject({ sendMessages: true, type: "BOOKS" });
      await ctx.api("PATCH", `/parcel-products/${created.body.id}`, { token, body: { active: false } });
      expect(await ctx.prisma.parcelProduct.findUniqueOrThrow({ where: { id: created.body.id } })).toMatchObject({ sendMessages: true, type: "BOOKS", active: false });
      // The old per-message field is no longer part of the API (ignored).
      const old = await ctx.api("POST", "/parcel-products", { token, body: { segment: "ECOMMERCE", name: "Old style", mutedNotifications: ["notify.booked"] } });
      expect(old.body).toMatchObject({ sendMessages: true, mutedNotifications: [] });
      expect(await ctx.prisma.auditLog.count({ where: { action: "parcel_product.update", entityId: created.body.id } })).toBe(3);
    });

    it("stores the parcel's messages at booking (default all, unticked left out, none for a silent product) and only sends those", async () => {
      const { owner } = await merchant();
      const view = (await ctx.api("GET", "/packages/me", { token: owner.token })).body as { notifications: { code: string }[]; products: { name: string; sendMessages: boolean }[] };
      const all = view.notifications.map(n => n.code);
      expect(all).toEqual(expect.arrayContaining(["notify.booked", "notify.cancelled", "notify.delivery_code", "notify.collection"]));
      await ctx.prisma.parcelProduct.update({ where: { segment_name: { segment: "ECOMMERCE", name: "Books" } }, data: { sendMessages: false } });
      const products = (await ctx.api("GET", "/packages/me", { token: owner.token })).body.products as { name: string; sendMessages: boolean }[];
      expect(products.find(p => p.name === "Books")?.sendMessages).toBe(false);
      const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops");
      const sent = (template: string, trackingId: string) => ctx.prisma.outboxMessage.count({ where: { template, body: { contains: trackingId } } });

      // Field omitted: every message in the package.
      const full = await ctx.api("POST", "/parcels", { token: owner.token, body: order() });
      expect(full.status, JSON.stringify(full.body)).toBe(201);
      expect((await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: full.body.trackingId } })).notifications).toEqual(all);
      expect(await sent("parcel.booked", full.body.trackingId)).toBeGreaterThan(0);

      // Unticked "Pickup request received" and "Pickup cancelled": neither goes, at booking or later.
      const picked = all.filter(c => c !== "notify.booked" && c !== "notify.cancelled");
      const unticked = await ctx.api("POST", "/parcels", { token: owner.token, body: order({ notifications: picked }) });
      expect(unticked.status, JSON.stringify(unticked.body)).toBe(201);
      expect((await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: unticked.body.trackingId } })).notifications).toEqual(picked);
      expect(await sent("parcel.booked", unticked.body.trackingId)).toBe(0);
      expect(unticked.body.proofMethods).toContain("OTP"); // the delivery code is still sent

      // A product with messages off: an empty list whatever was ticked; nothing sent; no OTP proof.
      const silent = await ctx.api("POST", "/parcels", { token: owner.token, body: order({ product: "Books", notifications: all }) });
      expect(silent.status, JSON.stringify(silent.body)).toBe(201);
      expect((await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: silent.body.trackingId } })).notifications).toEqual([]);
      expect(await sent("parcel.booked", silent.body.trackingId)).toBe(0);
      expect(silent.body.proofMethods).toEqual(["SIGNATURE", "PHOTO"]);

      // Later events follow the stored list.
      for (const p of [full, unticked, silent]) expect((await ctx.api("POST", `/parcels/${p.body.trackingId}/cancel`, { token: ops.token, body: { reason: "Test" } })).status).toBe(200);
      expect(await sent("parcel.cancelled", full.body.trackingId)).toBeGreaterThan(0);
      expect(await sent("parcel.cancelled", unticked.body.trackingId)).toBe(0);
      expect(await sent("parcel.cancelled", silent.body.trackingId)).toBe(0);

      // No delivery code ticked: OTP isn't offered as proof.
      const noCode = await ctx.api("POST", "/parcels", { token: owner.token, body: order({ notifications: ["notify.delivered"] }) });
      expect(noCode.body.proofMethods).toEqual(["SIGNATURE", "PHOTO"]);
    });

    it("refuses a proof method the parcel's package doesn't offer; charges re-attempts beyond the free ones", async () => {
      const { token } = await admin();
      const { m, owner } = await merchant();
      const pkg = await createPackage(token, "ECOMMERCE", "Photo only", await allServices("ECOMMERCE", ["proof.otp", "proof.signature"]), { freeReattempts: 0, reattemptFee: 25 });
      await assign(token, m.id, pkg.id);
      const gulshan = await hub(ctx, "HUB-PK1");
      const rider = await riderUser(ctx, "R-9101", gulshan.id);
      const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops");
      const booked = await ctx.api("POST", "/parcels", { token: owner.token, body: order({ codAmount: 0 }) });
      await ctx.prisma.parcel.update({ where: { trackingId: booked.body.trackingId }, data: { status: "AT_HUB", currentHubId: gulshan.id } });
      expect((await ctx.api("POST", `/parcels/${booked.body.trackingId}/assign-delivery`, { token: ops.token, body: { riderId: rider.rider.id } })).status).toBe(200);
      await ctx.api("POST", `/rider/parcels/${booked.body.trackingId}/start-delivery`, { token: rider.token });
      const otp = await ctx.api("POST", `/rider/parcels/${booked.body.trackingId}/delivery`, { token: rider.token, body: { outcome: "DELIVERED", receivedBy: "N", proof: { method: "OTP", otp: "1234" } } });
      expect(otp.body.error.code).toBe("PROOF_METHOD_NOT_ALLOWED");
      const failed = await ctx.api("POST", `/rider/parcels/${booked.body.trackingId}/delivery`, { token: rider.token, body: { outcome: "FAILED", reason: "Recipient unavailable", nextAction: "RETRY" } });
      expect(failed.status, JSON.stringify(failed.body)).toBe(200);
      const after = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: booked.body.trackingId } });
      expect(Number(after.reattemptCharge)).toBe(25);
      expect(Number(after.totalCharge)).toBe(Number(booked.body.charges.total) + 25);
    });

    it("API keys, webhooks and support tickets follow the package", async () => {
      const { token } = await admin();
      const { m, owner } = await merchant();
      const key = (await ctx.api("POST", "/merchants/me/api-keys", { token: owner.token, body: { name: "Shop", scopes: ["parcels:read"] } })).body.key;
      expect((await ctx.api("GET", "/parcels", { token: key })).status).toBe(200);
      const pkg = await createPackage(token, "ECOMMERCE", "Basic", await allServices("ECOMMERCE", ["integration.api", "integration.webhooks", "support.tickets"]));
      await assign(token, m.id, pkg.id);
      const refused = await ctx.api("GET", "/parcels", { token: key });
      expect(refused.status).toBe(403);
      expect(refused.body.error.message).toContain("SERVICE_NOT_IN_PACKAGE: API integration");
      expect((await ctx.api("POST", "/merchants/me/webhooks", { token: owner.token, body: { url: "https://example.com/h", events: ["shipment.delivered"] } })).body.error.code).toBe("SERVICE_NOT_IN_PACKAGE");
      expect((await ctx.api("POST", "/support/tickets", { token: owner.token, body: { category: "Delivery issue", subject: "Help", message: "Where is my parcel?" } })).body.error.code).toBe("SERVICE_NOT_IN_PACKAGE");
    });
  });

  describe("Hub Pickup", () => {
    it("ready at the collection hub with a code, handed over with COD into hub cash; uncollected ones go back", async () => {
      const { owner } = await merchant();
      const gulshan = await hub(ctx, "HUB-PK2");
      const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops");
      const booked = await ctx.api("POST", "/parcels", { token: owner.token, body: order({ lastMile: "HUB_COLLECT", collectHubId: gulshan.id, codAmount: 800 }) });
      expect(booked.status, JSON.stringify(booked.body)).toBe(201);
      expect(booked.body.collect).toMatchObject({ hub: { id: gulshan.id } });
      const id = booked.body.trackingId;
      await ctx.prisma.parcel.update({ where: { trackingId: id }, data: { status: "IN_TRANSIT" } });
      expect((await ctx.api("POST", `/parcels/${id}/assign-delivery`, { token: ops.token, body: { riderId: "00000000-0000-7000-8000-000000000000" } })).status).not.toBe(200);
      const arrived = await ctx.api("POST", `/parcels/${id}/status`, { token: ops.token, body: { status: "AT_HUB", hubId: gulshan.id } });
      expect(arrived.status, JSON.stringify(arrived.body)).toBe(200);
      expect(arrived.body.status).toBe("READY_FOR_COLLECTION");
      const sms = await ctx.prisma.outboxMessage.findFirstOrThrow({ where: { template: "parcel.ready_for_collection" } });
      expect(sms.body).toContain(gulshan.name);
      const stored = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: id } });
      const code = decrypt(stored.collectionCodeEncrypted!);
      expect(sms.body).toContain(code);
      expect((await ctx.api("POST", `/parcels/${id}/collect`, { token: ops.token, body: { code: "000000", receivedBy: "N", codCollected: 800 } })).body.error.code).toBe("INVALID_COLLECTION_CODE");
      expect((await ctx.api("POST", `/parcels/${id}/collect`, { token: ops.token, body: { code, receivedBy: "N", codCollected: 100 } })).body.error.code).toBe("COD_MISMATCH");
      const done = await ctx.api("POST", `/parcels/${id}/collect`, { token: ops.token, body: { code, receivedBy: "Nabila", codCollected: 800 } });
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      expect(done.body).toMatchObject({ status: "DELIVERED", proof: { method: "COLLECTION_CODE" } });
      expect(await ctx.prisma.codCollection.findFirstOrThrow({ where: { parcel: { trackingId: id } } })).toMatchObject({ state: "AT_HUB", riderId: null, hubId: gulshan.id });

      // Another one nobody collects: reminder, then Return scheduled after the hold period.
      const other = await ctx.api("POST", "/parcels", { token: owner.token, body: order({ lastMile: "HUB_COLLECT", collectHubId: gulshan.id, codAmount: 0 }) });
      await ctx.prisma.parcel.update({ where: { trackingId: other.body.trackingId }, data: { status: "IN_TRANSIT" } });
      await ctx.api("POST", `/parcels/${other.body.trackingId}/status`, { token: ops.token, body: { status: "AT_HUB", hubId: gulshan.id } });
      const sweeper = ctx.app.get(CollectionsService);
      const six = new Date(Date.now() + 6.5 * 86_400_000);
      expect(await sweeper.sweep(six)).toMatchObject({ reminded: 1, returned: 0 });
      expect(await sweeper.sweep(new Date(Date.now() + 8 * 86_400_000))).toMatchObject({ returned: 1 });
      expect((await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: other.body.trackingId } })).status).toBe("RETURN_SCHEDULED");

      // "Ready for collection" unticked at booking (or a product with messages off): no SMS when it arrives.
      const view = (await ctx.api("GET", "/packages/me", { token: owner.token })).body as { notifications: { code: string }[] };
      const quiet = await ctx.api("POST", "/parcels", {
        token: owner.token,
        body: order({ lastMile: "HUB_COLLECT", collectHubId: gulshan.id, codAmount: 0, notifications: view.notifications.map(n => n.code).filter(c => c !== "notify.collection") }),
      });
      expect(quiet.status, JSON.stringify(quiet.body)).toBe(201);
      await ctx.prisma.parcel.update({ where: { trackingId: quiet.body.trackingId }, data: { status: "IN_TRANSIT" } });
      const ready = await ctx.api("POST", `/parcels/${quiet.body.trackingId}/status`, { token: ops.token, body: { status: "AT_HUB", hubId: gulshan.id } });
      expect(ready.body.status).toBe("READY_FOR_COLLECTION");
      expect(await ctx.prisma.outboxMessage.count({ where: { template: "parcel.ready_for_collection", body: { contains: quiet.body.trackingId } } })).toBe(0);
    });
  });

  describe("tracking", () => {
    it("shows the rider's live location and phone while out for delivery, when the package has them", async () => {
      const { token } = await admin();
      const { m, owner } = await merchant();
      const pkg = await createPackage(token, "ECOMMERCE", "Live", await allServices("ECOMMERCE"));
      await assign(token, m.id, pkg.id);
      const gulshan = await hub(ctx, "HUB-PK3");
      const rider = await riderUser(ctx, "R-9102", gulshan.id);
      const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops");
      const booked = await ctx.api("POST", "/parcels", { token: owner.token, body: order({ codAmount: 0 }) });
      const id = booked.body.trackingId;
      await ctx.prisma.parcel.update({ where: { trackingId: id }, data: { status: "AT_HUB", currentHubId: gulshan.id } });
      await ctx.api("POST", `/parcels/${id}/assign-delivery`, { token: ops.token, body: { riderId: rider.rider.id } });
      expect((await ctx.api("GET", `/track/${id}`)).body.liveDelivery).toBeNull();
      await ctx.api("POST", `/rider/parcels/${id}/start-delivery`, { token: rider.token });
      await ctx.prisma.riderLocation.create({ data: { riderId: rider.rider.id, lat: 23.79, lng: 90.41, accuracy: 10, at: new Date() } });
      const track = (await ctx.api("GET", `/track/${id}`)).body;
      expect(track.liveDelivery).toMatchObject({ rider: { phone: rider.phone }, location: { lat: 23.79, lng: 90.41 } });
    });
  });
});
