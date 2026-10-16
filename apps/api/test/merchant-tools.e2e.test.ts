import { PickupsService } from "../src/modules/pickups/pickups.service";
import { hub, parcelBody, resetDatabase, riderUser, startApp, userWithRoles, type TestContext } from "./helpers";

/** Merchant tools: products, reports, returns (RTO) and pickup scheduling. */
describe("merchant tools", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  let seq = 0;
  async function workspace(type: "ECOMMERCE" | "CORPORATE_DOCUMENT" = "ECOMMERCE") {
    const m = await ctx.prisma.merchant.create({
      data: {
        code: `MR-W${++seq}`,
        type,
        name: `Tools ${seq}`,
        status: "ACTIVE",
        kycStatus: "APPROVED",
        contactName: "Owner",
        contactPhone: "+8801711111111",
        pickupAddress: "House 12, Road 5, Banani",
        pickupArea: "Banani",
        pickupDistrict: "Dhaka North",
      },
    });
    const owner = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: m.id }], "Shop Owner");
    const staff = await userWithRoles(ctx, [{ role: "MERCHANT_STAFF", merchantId: m.id }], "Shop Staff");
    return { m, owner, staff };
  }
  const order = (overrides: Record<string, unknown> = {}) =>
    parcelBody({
      sender: { name: "Shop", phone: "01711111111" },
      pickup: { category: "Office", street: "House 12, Road 5, Banani", area: "Banani", zone: "Banani", district: "Dhaka North" },
      type: "ECOMMERCE",
      saveAddresses: false,
      ...overrides,
    });

  describe("products", () => {
    it("creates, searches, updates and deletes catalogue items per merchant", async () => {
      const { owner, staff } = await workspace();
      const other = await workspace();
      const created = await ctx.api("POST", "/merchants/me/products", { token: staff.token, body: { sku: "TS-001", name: "Cotton T-shirt", category: "Clothing", weightKg: 0.4, packaging: "Poly mailer", price: 650 } });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body).toMatchObject({ sku: "TS-001", weightKg: 0.4, price: 650, active: true });
      expect((await ctx.api("POST", "/merchants/me/products", { token: owner.token, body: { sku: "TS-001", name: "Again" } })).body.error.code).toBe("DUPLICATE_SKU");
      // Same SKU in another merchant is fine.
      expect((await ctx.api("POST", "/merchants/me/products", { token: other.owner.token, body: { sku: "TS-001", name: "Theirs" } })).status).toBe(201);
      await ctx.api("POST", "/merchants/me/products", { token: owner.token, body: { sku: "MUG-1", name: "Ceramic mug", category: "Home" } });

      const search = await ctx.api("GET", "/merchants/me/products?q=shirt", { token: owner.token });
      expect(search.body.items.map((p: { sku: string }) => p.sku)).toEqual(["TS-001"]);
      const updated = await ctx.api("PATCH", `/merchants/me/products/${created.body.id}`, { token: owner.token, body: { price: 700, active: false, category: null } });
      expect(updated.body).toMatchObject({ price: 700, active: false, category: null });
      expect((await ctx.api("GET", "/merchants/me/products?active=true", { token: owner.token })).body.items).toHaveLength(1);
      expect((await ctx.api("DELETE", `/merchants/me/products/${created.body.id}`, { token: other.owner.token })).status).toBe(404);
      expect((await ctx.api("DELETE", `/merchants/me/products/${created.body.id}`, { token: owner.token })).status).toBe(204);
      expect(await ctx.prisma.auditLog.count({ where: { action: { startsWith: "product." } } })).toBe(5);
    });
  });

  describe("bulk booking", () => {
    it("the old JSON bulk endpoints are gone: spreadsheet and JSON imports use /imports (imports.e2e.test.ts)", async () => {
      const { owner } = await workspace();
      expect((await ctx.api("POST", "/parcels/bulk", { token: owner.token, body: { rows: [order()] } })).status).toBe(404);
      expect((await ctx.api("GET", "/parcels/bulk", { token: owner.token })).status).toBe(404);
    });
  });

  describe("receiver relation and branch code", () => {
    it("stores them as fields and returns them on the parcel", async () => {
      const { owner } = await workspace("CORPORATE_DOCUMENT");
      const res = await ctx.api("POST", "/parcels", { token: owner.token, body: order({ type: "DOCUMENT", receiverRelation: "Reception", originBranchCode: "DHK-01", instructions: "Call first" }) });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({ receiverRelation: "Reception", originBranchCode: "DHK-01", instructions: "Call first" });
    });
  });

  describe("returns (RTO)", () => {
    it("merchant requests, operations run the return, merchant confirms receipt", async () => {
      const { m, owner } = await workspace();
      const h = await hub(ctx);
      const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops");
      const rider = await riderUser(ctx, "RD-RT1", h.id);
      await ctx.prisma.webhookEndpoint.create({ data: { merchantId: m.id, url: "https://example.com/hook", secretEncrypted: "x", events: ["shipment.return_requested", "shipment.return_scheduled", "shipment.returned", "shipment.return_received"] } });
      const booked = await ctx.api("POST", "/parcels", { token: owner.token, body: order({ merchantOrderRef: "RTO-1" }) });
      const trackingId = booked.body.trackingId;

      // Not picked up yet: cancel instead.
      expect((await ctx.api("POST", `/parcels/${trackingId}/return-request`, { token: owner.token, body: { reason: "Customer cancelled" } })).body.error.code).toBe("NOT_PICKED_UP");
      await ctx.prisma.parcel.update({ where: { trackingId }, data: { status: "RETRY_SCHEDULED", currentHubId: h.id, pickedUpAt: new Date(), attemptCount: 2 } });

      const requested = await ctx.api("POST", `/parcels/${trackingId}/return-request`, { token: owner.token, body: { reason: "Recipient refused" } });
      expect(requested.status, JSON.stringify(requested.body)).toBe(200);
      expect(requested.body).toMatchObject({ stage: "requested", reason: "Recipient refused", requestedBy: "Shop Owner" });
      expect((await ctx.api("POST", `/parcels/${trackingId}/return-request`, { token: owner.token, body: { reason: "Again" } })).status).toBe(409);
      const queue = await ctx.api("GET", "/returns?stage=requested", { token: ops.token });
      expect(queue.body.items.map((r: { trackingId: string }) => r.trackingId)).toEqual([trackingId]);
      const { owner: stranger } = await workspace();
      expect((await ctx.api("GET", "/returns", { token: stranger.token })).body.items).toHaveLength(0);
      expect((await ctx.api("POST", `/parcels/${trackingId}/return-request`, { token: stranger.token, body: { reason: "Not mine" } })).status).toBe(404);

      expect((await ctx.api("POST", "/returns/runs", { token: owner.token, body: { merchantId: m.id, trackingIds: [trackingId] } })).status).toBe(403);
      const run = await ctx.api("POST", "/returns/runs", { token: ops.token, body: { merchantId: m.id, trackingIds: [trackingId], hubId: h.id } });
      expect(run.status, JSON.stringify(run.body)).toBe(201);
      expect(run.body).toMatchObject({ status: "PLANNED", parcelCount: 1 });
      const scheduled = run.body.parcels[0];
      expect(scheduled.status).toBe("RETURN_SCHEDULED");
      // Return charge = delivery charge × returnPercent (default 50%), rounded up.
      expect(scheduled.returnCharge).toBe(Math.ceil(booked.body.charges.total * 0.5));

      expect((await ctx.api("POST", `/returns/runs/${run.body.id}/dispatch`, { token: ops.token, body: {} })).body.error.code).toBe("RIDER_REQUIRED");
      const out = await ctx.api("POST", `/returns/runs/${run.body.id}/dispatch`, { token: ops.token, body: { riderId: rider.rider.id } });
      expect(out.body.status).toBe("OUT_FOR_RETURN");
      const done = await ctx.api("POST", `/returns/runs/${run.body.id}/complete`, { token: ops.token, body: {} });
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      expect(done.body.status).toBe("COMPLETED");
      expect(done.body.parcels[0]).toMatchObject({ status: "RETURNED", stage: "returned" });

      const received = await ctx.api("POST", `/parcels/${trackingId}/return-received`, { token: owner.token });
      expect(received.body).toMatchObject({ stage: "received" });
      expect(received.body.receivedAt).toBeTruthy();

      const events = (await ctx.prisma.webhookDelivery.findMany({ select: { event: true } })).map(d => d.event);
      expect(events).toEqual(expect.arrayContaining(["shipment.return_requested", "shipment.return_scheduled", "shipment.returned", "shipment.return_received"]));
      const sms = (await ctx.prisma.outboxMessage.findMany({ select: { template: true } })).map(o => o.template);
      expect(sms).toEqual(expect.arrayContaining(["parcel.return_scheduled", "parcel.returned"]));

      const report = await ctx.api("GET", "/merchants/me/reports/returns?format=json", { token: owner.token });
      expect(report.body.rows).toHaveLength(1);
      expect(report.body.summary.returned).toBe(1);
    });

    it("cancelling a planned run puts parcels back at the hub", async () => {
      const { m, owner } = await workspace();
      const h = await hub(ctx);
      const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops");
      const booked = await ctx.api("POST", "/parcels", { token: owner.token, body: order() });
      await ctx.prisma.parcel.update({ where: { trackingId: booked.body.trackingId }, data: { status: "AT_HUB", currentHubId: h.id } });
      const noReason = await ctx.api("POST", "/returns/runs", { token: ops.token, body: { merchantId: m.id, trackingIds: [booked.body.trackingId] } });
      expect(noReason.body.error.code).toBe("PARCELS_NOT_RETURNABLE");
      const run = await ctx.api("POST", "/returns/runs", { token: ops.token, body: { merchantId: m.id, trackingIds: [booked.body.trackingId], reason: "Wrong or incomplete address" } });
      const cancelled = await ctx.api("POST", `/returns/runs/${run.body.id}/cancel`, { token: ops.token });
      expect(cancelled.body.status).toBe("CANCELLED");
      const parcel = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: booked.body.trackingId } });
      expect(parcel).toMatchObject({ status: "AT_HUB", returnRunId: null, returnReason: "Wrong or incomplete address" });
    });
  });

  describe("pickup scheduling", () => {
    it("generates daily pickups from recurring schedules for operations", async () => {
      const { m, owner } = await workspace();
      const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops");
      const h = await hub(ctx);
      const rider = await riderUser(ctx, "RD-PU1", h.id);
      const bad = await ctx.api("POST", "/merchants/me/pickup-schedules", { token: owner.token, body: { name: "x", days: [], windowStart: "10:00", windowEnd: "10:10" } });
      expect(bad.status).toBe(422);
      const schedule = await ctx.api("POST", "/merchants/me/pickup-schedules", {
        token: owner.token,
        body: { name: "Daily warehouse", days: [0, 1, 2, 3, 4, 5, 6], windowStart: "23:00", windowEnd: "23:59", street: "House 12, Road 5", zone: "Banani", district: "Dhaka North", contactName: "Store", contactPhone: "01711111111", expectedParcels: 25 },
      });
      expect(schedule.status, JSON.stringify(schedule.body)).toBe(201);
      // Tomorrow's (and today's, before 23:00 Dhaka) pickup was created at once.
      const tomorrow = new Date(Date.now() + 6 * 3600_000 + 86_400_000).toISOString().slice(0, 10);
      const mine = await ctx.api("GET", `/merchants/me/pickup-requests?date=${tomorrow}`, { token: owner.token });
      expect(mine.body.items).toHaveLength(1);
      expect(mine.body.items[0]).toMatchObject({ status: "REQUESTED", expectedParcels: 25, schedule: { name: "Daily warehouse" } });
      // Generation is idempotent.
      expect(await ctx.app.get(PickupsService).generate(tomorrow)).toBe(0);

      const one = await ctx.api("POST", "/merchants/me/pickup-requests", { token: owner.token, body: { date: tomorrow, windowStart: "14:00", windowEnd: "16:00", expectedParcels: 3 } });
      expect(one.status, JSON.stringify(one.body)).toBe(201);
      expect(one.body).toMatchObject({ street: m.pickupAddress, district: "Dhaka North", schedule: null });

      const opsList = await ctx.api("GET", `/pickup-requests?date=${tomorrow}`, { token: ops.token });
      expect(opsList.body.items).toHaveLength(2);
      const assigned = await ctx.api("POST", `/pickup-requests/${one.body.id}/assign`, { token: ops.token, body: { riderId: rider.rider.id } });
      expect(assigned.body.status).toBe("ASSIGNED");
      expect((await ctx.api("POST", `/merchants/me/pickup-requests/${one.body.id}/cancel`, { token: owner.token })).body.error.code).toBe("PICKUP_ASSIGNED");
      expect((await ctx.api("POST", `/pickup-requests/${one.body.id}/complete`, { token: ops.token })).body.status).toBe("COMPLETED");
      expect((await ctx.api("POST", `/merchants/me/pickup-requests/${mine.body.items[0].id}/cancel`, { token: owner.token })).body.status).toBe("CANCELLED");

      expect((await ctx.api("DELETE", `/merchants/me/pickup-schedules/${schedule.body.id}`, { token: owner.token })).status).toBe(204);
      expect((await ctx.api("GET", "/merchants/me/pickup-schedules", { token: owner.token })).body.items).toHaveLength(0);
    });
  });

  describe("reports", () => {
    it("exports orders as CSV and keeps financial reports for owners", async () => {
      const { owner, staff } = await workspace();
      await ctx.api("POST", "/parcels", { token: owner.token, body: order({ merchantOrderRef: "=HYPERLINK(1)" }) });
      const csv = await ctx.app.inject({ method: "GET", url: "/api/v1/merchants/me/reports/orders", headers: { authorization: `Bearer ${owner.token}` } });
      expect(csv.statusCode).toBe(200);
      expect(csv.headers["content-type"]).toContain("text/csv");
      expect(csv.body).toContain("Tracking ID");
      expect(csv.body).toContain("'=HYPERLINK(1)");
      const json = await ctx.api("GET", "/merchants/me/reports/delivery-performance?format=json", { token: staff.token });
      expect(json.body.rows[0][0]).toBe("Dhaka Central");
      expect((await ctx.api("GET", "/merchants/me/reports/cod-reconciliation?format=json", { token: staff.token })).status).toBe(403);
      expect((await ctx.api("GET", "/merchants/me/reports/cod-reconciliation?format=json", { token: owner.token })).status).toBe(200);
      expect((await ctx.api("GET", "/merchants/me/reports/invoices?format=json", { token: owner.token })).status).toBe(200);
      expect((await ctx.api("GET", "/merchants/me/reports/nope", { token: owner.token })).status).toBe(404);
    });
  });
});
