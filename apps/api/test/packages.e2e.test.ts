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
      const res = await ctx.api("POST", "/imports/validate", {
        token: owner.token,
        body: {
          kind: "ecommerce",
          lastMile: "DOORSTEP",
          notifications: ["notify.delivered"],
          rows: [
            { order_ref: "PK-1", phone: "01812000000", "Customer name": "A", address: "Road 1", district: "Dhaka South", zone: "Motijheel", "Open box": "Yes", Product: "Books" },
            { order_ref: "PK-2", phone: "01812000001", "Customer name": "B", address: "Road 2", district: "Chattogram", zone: "Agrabad", Service: "Express" },
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
      expect(res.body.totals).toEqual({ rows: 1, charge: P.sameDistrict + 12 });
      expect(res.body.services).toMatchObject({ lastMile: "DOORSTEP", notifications: ["notify.delivered"] });
      await ctx.api("POST", `/imports/${res.body.id}/commit`, { token: owner.token });
      const parcel = await ctx.prisma.parcel.findFirstOrThrow({ where: { merchantOrderRef: "PK-1" } });
      expect(parcel).toMatchObject({ openBox: true, productName: "Books", productType: "BOOKS", notifications: ["notify.delivered"] });
    });
  });

  describe("notifications, proof, gating", () => {
    it("sends a parcel message only when the package includes it, it wasn't unticked and the product allows it", async () => {
      const { owner } = await merchant();
      const product = await ctx.prisma.parcelProduct.findFirst({ where: { segment: "ECOMMERCE", name: "Books" } });
      await ctx.api("GET", "/packages/me", { token: owner.token }); // set-up
      await ctx.prisma.parcelProduct.update({ where: { segment_name: { segment: "ECOMMERCE", name: "Books" } }, data: { mutedNotifications: ["notify.delivery_code"] } });
      void product;
      const unticked = await ctx.api("POST", "/parcels", { token: owner.token, body: order({ notifications: ["notify.delivered"] }) });
      expect(unticked.status, JSON.stringify(unticked.body)).toBe(201);
      const stored = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: unticked.body.trackingId } });
      expect(stored.notifications).toEqual(["notify.delivered"]);
      const muted = await ctx.api("POST", "/parcels", { token: owner.token, body: order({ product: "Books" }) });
      const mutedStored = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: muted.body.trackingId } });
      expect(mutedStored.notifications).not.toContain("notify.delivery_code");
      expect(mutedStored.notifications).toContain("notify.booked");
      // No delivery code for the muted parcel: OTP isn't one of its proof methods.
      expect(muted.body.proofMethods).toEqual(["SIGNATURE", "PHOTO"]);
      expect(unticked.body.proofMethods).toEqual(["SIGNATURE", "PHOTO"]);
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
