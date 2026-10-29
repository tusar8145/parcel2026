import { decrypt } from "../src/common/crypto";
import { hub, parcelBody, resetDatabase, riderUser, startApp, userWithRoles, type TestContext, sameHubDelivery } from "./helpers";

describe("courier operations console", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  let merchantSeq = 2000;
  const merchant = (type: "ECOMMERCE" | "BANKING_FINANCIAL" = "ECOMMERCE", name = "Shop BD") =>
    ctx.prisma.merchant.create({
      data: {
        code: `MR-${++merchantSeq}`,
        type,
        name,
        status: "ACTIVE",
        contactName: "Owner",
        contactPhone: "+8801911000000",
        pickupAddress: "House 5 Road 2",
        pickupArea: "Gulshan 1",
        pickupDistrict: "Dhaka North",
      },
    });

  const setup = async () => {
    const gulshan = await hub(ctx, "HUB-GUL");
    const dhanmondi = await hub(ctx, "HUB-DHN");
    const shop = await merchant("ECOMMERCE", "Northstar Test");
    const bank = await merchant("BANKING_FINANCIAL", "Meridian Test");
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops Manager");
    const hubOp = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: gulshan.id }], "Gulshan Operator");
    const otherHubOp = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: dhanmondi.id }], "Dhanmondi Operator");
    const finance = await userWithRoles(ctx, [{ role: "FINANCE" }], "Finance Desk");
    const support = await userWithRoles(ctx, [{ role: "SUPPORT_AGENT" }], "Support Desk");
    const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Rahim Uddin");
    const rider = await riderUser(ctx, "R-2048", gulshan.id);
    return { gulshan, dhanmondi, shop, bank, ops, hubOp, otherHubOp, finance, support, customer, rider };
  };
  type Setup = Awaited<ReturnType<typeof setup>>;

  const book = async (s: Setup, merchantId?: string, overrides: Record<string, unknown> = {}) => {
    const body = merchantId ? { merchantId, ...parcelBody(overrides), sender: undefined, pickup: undefined } : parcelBody(overrides);
    const res = await ctx.api("POST", "/ops/parcels", { token: s.ops.token, body });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { trackingId: string; version: number };
  };

  /** Pickup by the rider straight to the Gulshan hub. */
  const toHub = async (s: Setup, trackingId: string) => {
    await ctx.api("POST", `/parcels/${trackingId}/assign-pickup`, { token: s.ops.token, body: { riderId: s.rider.rider.id } });
    const res = await ctx.api("POST", `/rider/parcels/${trackingId}/pickup`, { token: s.rider.token, body: { outcome: "COLLECTED_TO_HUB", hubId: s.gulshan.id } });
    expect(res.body.status, JSON.stringify(res.body)).toBe("AT_HUB");
  };

  const deliverWithOtp = async (s: Setup, trackingId: string, codCollected = 0) => {
    const parcel = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId } });
    const res = await ctx.api("POST", `/rider/parcels/${trackingId}/delivery`, {
      token: s.rider.token,
      body: { outcome: "DELIVERED", receivedBy: "Nabila", proof: { method: "OTP", otp: decrypt(parcel.deliveryOtpEncrypted!) }, codCollected },
    });
    expect(res.body.status, JSON.stringify(res.body)).toBe("DELIVERED");
  };

  describe("bookings by operations", () => {
    it("books for a merchant using its profile as sender and pickup", async () => {
      const s = await setup();
      const res = await ctx.api("POST", "/ops/parcels", {
        token: s.hubOp.token,
        body: { merchantId: s.shop.id, recipient: { name: "Nabila Ahmed", phone: "01812000000" }, delivery: parcelBody().delivery, weightKg: 1, codAmount: 900 },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({
        channel: "OPERATIONS",
        status: "PENDING_CONFIRMATION",
        merchant: { id: s.shop.id, type: "ECOMMERCE" },
        sender: { name: "Northstar Test", phone: "+8801911000000" },
        pickup: { street: "House 5 Road 2", zone: "Gulshan", district: "Dhaka North" },
        codAmount: 900,
      });
      // Booked by staff: nothing saved to an address book, priced on the merchant's segment.
      expect(await ctx.prisma.address.count()).toBe(0);
      expect(res.body.charges.total).toBeGreaterThan(0);
    });

    it("validates bookings", async () => {
      const s = await setup();
      const bad = await ctx.api("POST", "/ops/parcels", { token: s.ops.token, body: { merchantId: s.shop.id, weightKg: 1 } });
      expect(bad.status).toBe(422);
      const badPhone = await ctx.api("POST", "/ops/parcels", { token: s.ops.token, body: { merchantId: s.bank.id, recipient: { name: "Legal Desk", phone: "12345" }, delivery: parcelBody().delivery, weightKg: 0.5 } });
      expect(badPhone.status).toBe(422);
      // Spreadsheet imports by operations go through the import engine (imports.e2e.test.ts); the old JSON bulk route is gone.
      expect((await ctx.api("POST", "/ops/parcels/bulk", { token: s.ops.token, body: { rows: [] } })).status).toBe(404);
    });

    it("is limited to staff who dispatch", async () => {
      const s = await setup();
      for (const token of [s.support.token, s.finance.token, s.customer.token]) {
        const res = await ctx.api("POST", "/ops/parcels", { token, body: { merchantId: s.shop.id, ...parcelBody() } });
        expect(res.status).toBe(403);
      }
    });
  });

  describe("hub console", () => {
    it("receives and transfers parcels, and keeps hub operators to their own hub", async () => {
      const s = await setup();
      const { trackingId } = await book(s, s.shop.id);
      await toHub(s, trackingId);

      // Another hub's operator can't touch it, nor receive it into a hub that isn't theirs.
      const foreign = await ctx.api("POST", `/parcels/${trackingId}/status`, { token: s.otherHubOp.token, body: { status: "IN_TRANSIT", hubId: s.dhanmondi.id } });
      expect(foreign.status).toBe(403);
      expect(foreign.body.error.message).toContain(s.gulshan.name);
      const wrongHub = await ctx.api("POST", `/parcels/${trackingId}/status`, { token: s.hubOp.token, body: { status: "AT_HUB", hubId: s.dhanmondi.id } });
      expect(wrongHub.status).toBe(403);

      // Gulshan transfers it to Dhanmondi, which receives it.
      const sent = await ctx.api("POST", `/parcels/${trackingId}/status`, { token: s.hubOp.token, body: { status: "IN_TRANSIT", hubId: s.dhanmondi.id } });
      expect(sent.status, JSON.stringify(sent.body)).toBe(200);
      expect(sent.body).toMatchObject({ status: "IN_TRANSIT", currentHub: { id: s.dhanmondi.id } });
      expect(sent.body.events.at(-1)).toMatchObject({ title: `In transit to ${s.dhanmondi.name}` });
      const received = await ctx.api("POST", `/parcels/${trackingId}/status`, { token: s.otherHubOp.token, body: { status: "AT_HUB", hubId: s.dhanmondi.id } });
      expect(received.body).toMatchObject({ status: "AT_HUB", currentHub: { id: s.dhanmondi.id } });
      // Now Gulshan's operator can't assign it any more.
      const assign = await ctx.api("POST", `/parcels/${trackingId}/assign-delivery`, { token: s.hubOp.token, body: { riderId: s.rider.rider.id } });
      expect(assign.status).toBe(403);

      const transfers = await ctx.api("GET", "/ops/transfers", { token: s.hubOp.token });
      expect(transfers.status).toBe(200);
      expect(transfers.body).toEqual([
        expect.objectContaining({ trackingId, fromHub: s.gulshan.name, toHub: s.dhanmondi.name, fromHubId: s.gulshan.id, toHubId: s.dhanmondi.id, status: "At hub" }),
      ]);

      // The overview counts arrivals and departures per hub today.
      const overview = await ctx.api("GET", "/ops/overview", { token: s.ops.token });
      const hubRow = (id: string) => overview.body.hubs.find((h: { id: string }) => h.id === id);
      expect(hubRow(s.gulshan.id)).toMatchObject({ atHub: 0, inboundToday: 1, outboundToday: 1 });
      expect(hubRow(s.dhanmondi.id)).toMatchObject({ atHub: 1, inboundToday: 1 });
    });

    it("corrects recipient details and records internal notes", async () => {
      const s = await setup();
      const { trackingId, version } = await book(s, s.shop.id);
      const edited = await ctx.api("PATCH", `/parcels/${trackingId}`, {
        token: s.ops.token,
        body: { recipient: { phone: "01812999999" }, delivery: { street: "Road 9 House 4" }, instructions: "Call before arriving", note: "Recipient called support", expectedVersion: version },
      });
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      expect(edited.body).toMatchObject({ recipient: { phone: "+8801812999999" }, delivery: { street: "Road 9 House 4" }, instructions: "Call before arriving", version: version + 1 });
      const stale = await ctx.api("PATCH", `/parcels/${trackingId}`, { token: s.ops.token, body: { instructions: "x", expectedVersion: version } });
      expect(stale.body.error.code).toBe("PARCEL_CHANGED");

      const note = await ctx.api("POST", `/parcels/${trackingId}/notes`, { token: s.ops.token, body: { note: "Recipient prefers evening delivery" } });
      expect(note.status).toBe(201);
      expect(note.body.events.filter((e: { internal: boolean }) => e.internal).map((e: { title: string }) => e.title)).toEqual(["Details updated", "Note"]);
      // Notes and corrections never reach public tracking.
      const pub = await ctx.api("GET", `/track/${trackingId}`);
      expect(pub.body.events.map((e: { title: string }) => e.title)).not.toContain("Note");
      expect(await ctx.prisma.auditLog.count({ where: { action: { in: ["parcel.update_details", "parcel.note"] } } })).toBe(2);

      const forbiddenEdit = await ctx.api("PATCH", `/parcels/${trackingId}`, { token: s.support.token, body: { instructions: "x" } });
      expect(forbiddenEdit.status).toBe(403);
    });
  });

  describe("overview, dispatch and analytics", () => {
    it("counts parcels by service line, status and rider workload", async () => {
      const s = await setup();
      const pending = await ctx.api("POST", "/parcels", { token: s.customer.token, body: parcelBody() });
      expect(pending.status).toBe(201);
      const docs = await book(s, s.bank.id, { type: "DOCUMENT", codAmount: 0 });
      const cod = await book(s, s.shop.id, { codAmount: 1200 });
      await toHub(s, docs.trackingId);
      await ctx.api("POST", `/parcels/${cod.trackingId}/assign-pickup`, { token: s.ops.token, body: { riderId: s.rider.rider.id } });
      await sameHubDelivery(ctx, cod.trackingId);
      await ctx.api("POST", `/rider/parcels/${cod.trackingId}/pickup`, { token: s.rider.token, body: { outcome: "COLLECTED_DELIVER_DIRECT" } });
      await deliverWithOtp(s, cod.trackingId, 1200);

      const res = await ctx.api("GET", "/ops/overview", { token: s.hubOp.token });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.shipments).toMatchObject({ active: 2, createdToday: 3, deliveredToday: 1, unassigned: 2, pendingConfirmation: 1, atHub: 1, exceptions: 0 });
      expect(res.body.serviceLines).toEqual({ customer: 1, ecommerce: 0, documents: 1 });
      expect(res.body.onTime).toMatchObject({ monthDelivered: 1, monthRate: 100 });
      expect(res.body.cash).toMatchObject({ withRiders: 1200, collections: 1 });
      expect(res.body.me).toMatchObject({ hubIds: [s.gulshan.id], hubs: [{ id: s.gulshan.id }], can: { dispatch: true, manageHubs: false, receiveCash: true, financeStaff: false } });
      expect(res.body.alerts.map((a: { kind: string }) => a.kind)).toEqual(["hub", "cod"]);

      const dispatch = await ctx.api("GET", "/ops/dispatch", { token: s.hubOp.token });
      expect(dispatch.body.unassigned).toMatchObject({ total: 2, readyAtHub: 1, pendingPickup: 1 });
      expect(dispatch.body.roster).toEqual([expect.objectContaining({ rider: expect.objectContaining({ code: "R-2048" }), completed: 1, remaining: 0, assignedToday: 1 })]);
      // A Dhanmondi operator sees no Gulshan riders and nothing waiting at their hub.
      const other = await ctx.api("GET", "/ops/dispatch", { token: s.otherHubOp.token });
      expect(other.body).toMatchObject({ roster: [], unassigned: { readyAtHub: 0 } });

      const analytics = await ctx.api("GET", "/ops/analytics", { token: s.finance.token });
      expect(analytics.status).toBe(200);
      const metric = (key: string) => analytics.body.rows.find((r: { key: string }) => r.key === key);
      expect(metric("onTimeRate")).toMatchObject({ today: 100, month: 100, target: 95 });
      expect(metric("firstAttemptRate")).toMatchObject({ today: 100 });
      expect(metric("returnRate")).toMatchObject({ today: 0 });
      expect(metric("pickupHours").today).toBeGreaterThanOrEqual(0);

      // Finance has no rider access: dispatch and rider reports are refused.
      expect((await ctx.api("GET", "/ops/dispatch", { token: s.finance.token })).status).toBe(403);
      expect((await ctx.api("GET", "/ops/overview", { token: s.customer.token })).status).toBe(403);
    });

    it("reports parcels per rider for run sheets, and merchant volume", async () => {
      const s = await setup();
      const a = await book(s, s.shop.id, { codAmount: 500 });
      await toHub(s, a.trackingId);
      const report = await ctx.api("GET", "/ops/rider-report", { token: s.ops.token });
      expect(report.status, JSON.stringify(report.body)).toBe(200);
      const r = report.body.riders.find((x: { code: string }) => x.code === "R-2048");
      expect(r).toMatchObject({ picked: 1, counts: { "At hub": 1 }, hub: { id: s.gulshan.id } });
      expect(r.records).toEqual([expect.objectContaining({ trackingId: a.trackingId, role: "pickup", merchant: "Northstar Test", status: "At hub", codAmount: 500 })]);
      const empty = await ctx.api("GET", "/ops/rider-report?from=2020-01-01&to=2020-01-02", { token: s.ops.token });
      expect(empty.body.riders[0].records).toEqual([]);
      const tooLong = await ctx.api("GET", "/ops/rider-report?from=2026-01-01&to=2026-12-31", { token: s.ops.token });
      expect(tooLong.status).toBe(422);

      const merchants = await ctx.api("GET", "/ops/merchants", { token: s.support.token });
      expect(merchants.body.find((m: { id: string }) => m.id === s.shop.id)).toMatchObject({ parcelsThisMonth: 1, codThisMonth: 500, activeParcels: 1, plan: "E-commerce default", package: { name: "E-commerce default", isDefault: true } });
    });
  });

  describe("rider app", () => {
    it("summarises the rider's day, cash and recent scans", async () => {
      const s = await setup();
      const a = await book(s, s.shop.id, { codAmount: 750 });
      const b = await book(s, s.bank.id, { type: "DOCUMENT", codAmount: 0 });
      for (const p of [a, b]) {
        await ctx.api("POST", `/parcels/${p.trackingId}/assign-pickup`, { token: s.ops.token, body: { riderId: s.rider.rider.id } });
        await sameHubDelivery(ctx, p.trackingId);
        await ctx.api("POST", `/rider/parcels/${p.trackingId}/pickup`, { token: s.rider.token, body: { outcome: "COLLECTED_DELIVER_DIRECT" } });
      }
      await deliverWithOtp(s, a.trackingId, 750);

      const res = await ctx.api("GET", "/rider/summary", { token: s.rider.token });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({
        rider: { code: "R-2048", hub: { id: s.gulshan.id } },
        today: { delivered: 1, deliveredByLine: { ecommerce: 1, document: 0, parcel: 0 }, pickupsCompleted: 2, openDeliveries: 1, openPickups: 0, codToCollect: 0 },
        month: { delivered: 1, successRate: 100, onTimeRate: 100 },
        onTimeStreak: 1,
        cash: { inHand: 750, collections: 1 },
      });
      expect(res.body.recent[0]).toMatchObject({ trackingId: a.trackingId, status: "DELIVERED" });
      expect((await ctx.api("GET", "/rider/summary", { token: s.ops.token })).status).toBe(403);
    });
  });
});
