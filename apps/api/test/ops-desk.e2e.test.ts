import { hub, parcelBody, resetDatabase, riderUser, startApp, userWithRoles, type TestContext } from "./helpers";
import { maskBody, maskRecipient } from "../src/modules/parcels/parcel-messages.service";
import { pdfHas, readPdf } from "./pdf-text";

/** Courier Operations desk tools: the parcel message log and the end-of-day hub reconciliation. */
describe("ops desk: parcel messages and hub reconciliation", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  const setup = async () => {
    const gulshan = await hub(ctx, "HUB-GUL");
    const dhanmondi = await hub(ctx, "HUB-DHN");
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops Manager");
    const gulOp = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: gulshan.id }], "Gulshan Operator");
    const dhnOp = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: dhanmondi.id }], "Dhanmondi Operator");
    const finance = await userWithRoles(ctx, [{ role: "FINANCE" }], "Finance");
    const rider = await riderUser(ctx, "R-5001", gulshan.id);
    const rider2 = await riderUser(ctx, "R-5002", gulshan.id);
    const shop = await ctx.prisma.merchant.create({
      data: { code: "MR-8001", type: "ECOMMERCE", name: "Desk Shop", status: "ACTIVE", contactName: "Owner", contactPhone: "+8801911000000", pickupAddress: "House 5", pickupArea: "Gulshan 1", pickupDistrict: "Dhaka North" },
    });
    const owner = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: shop.id }], "Shop Owner");
    return { gulshan, dhanmondi, ops, gulOp, dhnOp, finance, rider, rider2, shop, owner };
  };
  type Setup = Awaited<ReturnType<typeof setup>>;
  const book = async (s: Setup, overrides: Record<string, unknown> = {}) => {
    const res = await ctx.api("POST", "/ops/parcels", { token: s.ops.token, body: { merchantId: s.shop.id, ...parcelBody(overrides), sender: undefined, pickup: undefined } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { trackingId: string; id: string };
  };
  const status = (s: Setup, id: string, body: Record<string, unknown>) => ctx.api("POST", `/parcels/${id}/status`, { token: s.ops.token, body });

  describe("parcel message log", () => {
    it("masks recipients and security codes", () => {
      expect(maskRecipient("SMS", "+8801712345678")).toBe("+880 17•• •••678");
      expect(maskRecipient("EMAIL", "rahim@example.com")).toBe("ra•••@example.com");
      expect(maskBody("parcel.delivery_code", "Your parcel PP-261016-AB12C is on its way. Please keep Tk 1,500 ready. Give code 4821 to the rider.")).toBe(
        "Your parcel PP-261016-AB12C is on its way. Please keep Tk 1,500 ready. Give code •••• to the rider.",
      );
      expect(maskBody("parcel.ready_for_collection", "Collection code 482913.")).toBe("Collection code ••••.");
      // Events without a code keep their numbers.
      expect(maskBody("parcel.delivered", "Parcel PP-261016-AB12C delivered at 1430.")).toBe("Parcel PP-261016-AB12C delivered at 1430.");
      expect(maskBody("auth.email_verify", "Confirm: https://x.example/verify?token=abc 482913")).toBe("Confirm: https://x.example/verify?… ••••");
    });

    it("lists the parcel's messages for staff, newest first, linked by tracking ID (and older ones by text)", async () => {
      const s = await setup();
      const p = await book(s);
      const linked = await ctx.prisma.outboxMessage.findMany({ where: { trackingId: p.trackingId } });
      expect(linked.length, "booking messages carry the tracking ID").toBeGreaterThan(0);
      // A delivery-code SMS (code masked) and a message from before the tracking ID column (matched by text).
      await ctx.prisma.outboxMessage.create({
        data: { channel: "SMS", to: "+8801812000000", template: "parcel.delivery_code", body: `Your parcel ${p.trackingId} is on its way. Give code 5937 to the rider.`, trackingId: p.trackingId, state: "SENT", sentAt: new Date(), provider: "log" },
      });
      await ctx.prisma.outboxMessage.create({ data: { channel: "SMS", to: "+8801812000000", template: "parcel.picked_up", body: `Parcel ${p.trackingId} was picked up.`, state: "FAILED", lastError: "Gateway timeout" } });
      await ctx.prisma.outboxMessage.create({ data: { channel: "SMS", to: "+8801812000001", template: "parcel.picked_up", body: "Parcel PP-000000-OTHER was picked up." } });

      const res = await ctx.api("GET", `/parcels/${p.trackingId.toLowerCase()}/messages`, { token: s.ops.token });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.trackingId).toBe(p.trackingId);
      expect(res.body.items.length).toBe(linked.length + 2);
      const code = res.body.items.find((m: any) => m.event === "parcel.delivery_code");
      expect(code).toMatchObject({ channel: "SMS", eventLabel: "Delivery code", to: "+880 18•• •••000", state: "SENT", provider: "log" });
      expect(code.text).toContain("Give code •••• to the rider");
      expect(JSON.stringify(res.body)).not.toContain("5937");
      expect(JSON.stringify(res.body)).not.toContain("+8801812000000");
      const legacy = res.body.items.find((m: any) => m.event === "parcel.picked_up");
      expect(legacy).toMatchObject({ state: "FAILED", lastError: "Gateway timeout" });
      expect(res.body.items.some((m: any) => m.text.includes("PP-000000-OTHER"))).toBe(false);
      const times = res.body.items.map((m: any) => Date.parse(m.queuedAt));
      expect([...times].sort((a, b) => b - a)).toEqual(times);
    });

    it("is staff-only, and hub operators see only their hubs' parcels", async () => {
      const s = await setup();
      const p = await book(s);
      await ctx.api("POST", `/parcels/${p.trackingId}/assign-pickup`, { token: s.ops.token, body: { riderId: s.rider.rider.id } });
      expect((await status(s, p.trackingId, { status: "AT_HUB", hubId: s.gulshan.id })).status).toBe(200);
      expect((await ctx.api("GET", `/parcels/${p.trackingId}/messages`, { token: s.gulOp.token })).status).toBe(200);
      expect((await ctx.api("GET", `/parcels/${p.trackingId}/messages`, { token: s.dhnOp.token })).status).toBe(404);
      expect((await ctx.api("GET", `/parcels/${p.trackingId}/messages`, { token: s.owner.token })).status).toBe(403);
      expect((await ctx.api("GET", `/parcels/${p.trackingId}/messages`, { token: s.rider.token })).status).toBe(403);
      expect((await ctx.api("GET", `/parcels/PP-000000-NONE/messages`, { token: s.ops.token })).status).toBe(404);
    });
  });

  describe("end-of-day hub reconciliation", () => {
    it("counts arrivals, dispatches, holdings and cash for a hub and a day", async () => {
      const s = await setup();
      // Two parcels arrive at Gulshan today; one goes out for delivery with a Gulshan rider and is delivered with COD.
      const a = await book(s, { codAmount: 1500 });
      const b = await book(s, { codAmount: 800 });
      for (const p of [a, b]) {
        await ctx.api("POST", `/parcels/${p.trackingId}/assign-pickup`, { token: s.ops.token, body: { riderId: s.rider.rider.id } });
        expect((await status(s, p.trackingId, { status: "AT_HUB", hubId: s.gulshan.id })).status).toBe(200);
      }
      // A parcel picked up by a Gulshan rider (still expected), and a drop-off booked to Gulshan.
      const c = await book(s);
      await ctx.prisma.parcel.update({ where: { trackingId: c.trackingId }, data: { status: "PICKED_UP", pickupRiderId: s.rider2.rider.id } });
      const d = await book(s);
      await ctx.prisma.parcel.update({ where: { trackingId: d.trackingId }, data: { intake: "DROP_OFF", dropOffHubId: s.gulshan.id } });
      // b leaves with a rider: out for delivery (tracking event) and its COD is collected.
      const bRow = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: b.trackingId } });
      await ctx.prisma.parcel.update({ where: { id: bRow.id }, data: { status: "OUT_FOR_DELIVERY", deliveryRiderId: s.rider.rider.id, currentHubId: null } });
      await ctx.prisma.trackingEvent.create({ data: { parcelId: bRow.id, status: "OUT_FOR_DELIVERY", title: "Out for delivery" } });
      const cod1 = await ctx.prisma.codCollection.create({ data: { parcelId: bRow.id, riderId: s.rider.rider.id, amount: "800.00" } });
      const aRow = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: a.trackingId } });
      // Another COD collected by rider2 yesterday (Dhaka) and still with them (outstanding, not "today").
      const yesterday = new Date(Date.now() + 6 * 3600_000 - 86_400_000).toISOString().slice(0, 10);
      const cRow = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: c.trackingId } });
      await ctx.prisma.codCollection.create({ data: { parcelId: cRow.id, riderId: s.rider2.rider.id, amount: "300.00", collectedAt: new Date(`${yesterday}T12:00:00+06:00`) } });
      // Rider 1 hands 800 over at Gulshan today; a counter collection at the hub for parcel a.
      const handover = await ctx.prisma.cashHandover.create({ data: { riderId: s.rider.rider.id, hubId: s.gulshan.id, amount: "800.00", receivedById: s.gulOp.user.id } });
      await ctx.prisma.codCollection.update({ where: { id: cod1.id }, data: { state: "AT_HUB", handoverId: handover.id } });
      await ctx.prisma.codCollection.create({ data: { parcelId: aRow.id, riderId: null, hubId: s.gulshan.id, amount: "1500.00", state: "AT_HUB" } });

      const res = await ctx.api("GET", `/ops/hub-reconciliation?hubId=${s.gulshan.id}`, { token: s.gulOp.token });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.hub).toMatchObject({ id: s.gulshan.id, code: "HUB-GUL" });
      expect(res.body.isToday).toBe(true);
      expect(res.body.parcels).toMatchObject({
        received: 2,
        stillExpected: 2,
        expected: 4,
        expectedParts: { inboundBags: 0, dropOffs: 1, pickedUpByRiders: 1 },
        outForDelivery: 1,
        transferred: 0,
        dispatched: 1,
        heldNow: 1,
        readyForCollection: 0,
      });
      expect(res.body.cash).toMatchObject({
        collected: "2300.00",
        collections: 2,
        collectedAtCounter: "1500.00",
        handedOver: "800.00",
        handovers: 1,
        outstandingFromDay: "0.00",
        outstanding: "300.00",
        outstandingCollections: 1,
      });
      const r2 = res.body.cash.perRider.find((r: any) => r.rider.code === "R-5002");
      expect(r2).toMatchObject({ collected: "0.00", handedOver: "0.00", withRider: "300.00" });
      expect(res.body.cash.perRider[0].rider.code).toBe("R-5002"); // most cash still out first

      // Another day: nothing arrived or moved; holdings are "now".
      const before = await ctx.api("GET", `/ops/hub-reconciliation?hubId=${s.gulshan.id}&date=${yesterday}`, { token: s.ops.token });
      expect(before.body).toMatchObject({ date: yesterday, isToday: false, parcels: { received: 0, outForDelivery: 0 }, cash: { collected: "300.00", handedOver: "0.00", outstandingFromDay: "300.00" } });

      // Scope: another hub's operator is refused; finance (no hub:read) too; bad input is 422.
      expect((await ctx.api("GET", `/ops/hub-reconciliation?hubId=${s.gulshan.id}`, { token: s.dhnOp.token })).status).toBe(403);
      expect((await ctx.api("GET", `/ops/hub-reconciliation?hubId=${s.gulshan.id}`, { token: s.finance.token })).status).toBe(403);
      expect((await ctx.api("GET", `/ops/hub-reconciliation?hubId=${s.gulshan.id}&date=17-10-2026`, { token: s.ops.token })).status).toBe(422);
      expect((await ctx.api("GET", `/ops/hub-reconciliation?hubId=00000000-0000-4000-8000-000000000000`, { token: s.ops.token })).status).toBe(404);

      // The printable PDF (documents module): same figures, audited.
      const pdf = await ctx.app.inject({ method: "GET", url: `/api/v1/documents/hub-reconciliation?hubId=${s.gulshan.id}`, headers: { authorization: `Bearer ${s.gulOp.token}` } });
      expect(pdf.statusCode, pdf.body.slice(0, 300)).toBe(200);
      expect(pdf.headers["content-type"]).toBe("application/pdf");
      const info = await readPdf(pdf.rawPayload);
      expect(pdfHas(info, "End-of-day hub reconciliation")).toBe(true);
      expect(pdfHas(info, "Test Hub HUB-GUL")).toBe(true);
      expect(pdfHas(info, "Cash handovers received")).toBe(true);
      expect(await ctx.prisma.auditLog.count({ where: { action: "document.generate", entityId: s.gulshan.id } })).toBe(1);
      expect((await ctx.app.inject({ method: "GET", url: `/api/v1/documents/hub-reconciliation?hubId=${s.gulshan.id}`, headers: { authorization: `Bearer ${s.dhnOp.token}` } })).statusCode).toBe(403);
    });
  });
});
