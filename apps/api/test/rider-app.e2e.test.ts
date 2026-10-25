import { hub, parcelBody, resetDatabase, riderUser, startApp, userWithRoles, type TestContext } from "./helpers";
import { RiderLocationService } from "../src/modules/rider/location.service";
import { planFromConfig } from "../src/modules/rider/earnings";
import { salaryFor } from "../src/modules/rider/pay.service";
import { LedgerService } from "../src/modules/finance/ledger.service";

// 1x1 PNG / JPEG-ish data URLs are enough: the API stores bytes, it doesn't decode images.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const PDF = "data:application/pdf;base64,JVBERi0xLjQKJcTl8uXrp/Og0MTGCjEgMCBvYmoKPDw+PgplbmRvYmoKdHJhaWxlcgo8PD4+CiUlRU9G";

describe("rider app: location, proof, pay, cash handover requests and KYC", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  const setup = async () => {
    const h = await hub(ctx);
    const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Rahim Uddin");
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops Manager");
    const rider = await riderUser(ctx, "R-2048", h.id);
    return { h, customer, ops, rider };
  };

  /** Books a parcel and walks it to OUT_FOR_DELIVERY with the rider (direct delivery). */
  const outForDelivery = async (s: Awaited<ReturnType<typeof setup>>, overrides: Record<string, unknown> = {}) => {
    const { trackingId } = (await ctx.api("POST", "/parcels", { token: s.customer.token, body: parcelBody(overrides) })).body;
    await ctx.api("POST", `/parcels/${trackingId}/assign-pickup`, { token: s.ops.token, body: { riderId: s.rider.rider.id } });
    const out = await ctx.api("POST", `/rider/parcels/${trackingId}/pickup`, { token: s.rider.token, body: { outcome: "COLLECTED_DELIVER_DIRECT" } });
    expect(out.body.status, JSON.stringify(out.body)).toBe("OUT_FOR_DELIVERY");
    return trackingId as string;
  };

  describe("live location", () => {
    it("records fixes on shift, publishes the latest position and keeps history", async () => {
      const s = await setup();
      const now = Date.now();
      const fix = (ago: number, lat = 23.7808) => ({ lat, lng: 90.4142, accuracy: 12, heading: 90, speed: 4.2, at: new Date(now - ago).toISOString() });

      const off = await ctx.api("POST", "/rider/location", { token: s.rider.token, body: fix(0) });
      expect(off.status).toBe(409);
      expect(off.body.error.code).toBe("RIDER_OFF_SHIFT");

      expect((await ctx.api("PATCH", "/rider/me/status", { token: s.rider.token, body: { status: "ONLINE" } })).status).toBe(200);
      const live = await ctx.api("POST", "/rider/location", { token: s.rider.token, body: fix(60_000) });
      expect(live.status, JSON.stringify(live.body)).toBe(202);
      expect(live.body).toEqual({ accepted: 1, ignored: 0, live: true });

      // Offline replay: one duplicate, one older fix and one newer fix.
      const batch = await ctx.api("POST", "/rider/location/batch", { token: s.rider.token, body: { points: [fix(60_000), fix(120_000, 23.7), fix(10_000, 23.79)] } });
      expect(batch.body).toEqual({ accepted: 2, ignored: 1, live: true });
      // A late replay of an older fix doesn't move the rider back.
      await ctx.api("POST", "/rider/location/batch", { token: s.rider.token, body: { points: [fix(30_000, 23.5)] } });

      const map = await ctx.api("GET", "/ops/rider-locations", { token: s.ops.token });
      expect(map.status).toBe(200);
      expect(map.body.items).toHaveLength(1);
      expect(map.body.items[0]).toMatchObject({ code: "R-2048", lat: 23.79, lng: 90.4142, status: "ONLINE", stale: false, hub: { id: s.h.id } });

      const history = await ctx.api("GET", `/ops/rider-locations/${s.rider.rider.id}/history`, { token: s.ops.token });
      expect(history.body.points.map((p: { lat: number }) => p.lat)).toEqual([23.7, 23.7808, 23.5, 23.79]);

      // Implausible device time (an hour in the future) is refused.
      const future = await ctx.api("POST", "/rider/location", { token: s.rider.token, body: fix(-3600_000) });
      expect(future.status).toBe(422);
      expect(future.body.error.code).toBe("INVALID_LOCATION_TIME");

      // Hub operators see their own hub's riders only; customers can't see the map.
      const otherHub = await hub(ctx, "HUB-T2");
      const operator = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: otherHub.id }]);
      expect((await ctx.api("GET", "/ops/rider-locations", { token: operator.token })).body.items).toHaveLength(0);
      expect((await ctx.api("GET", `/ops/rider-locations?hubId=${s.h.id}`, { token: operator.token })).status).toBe(403);
      expect((await ctx.api("GET", "/ops/rider-locations", { token: s.customer.token })).status).toBe(403);

      // Off shift: hidden from the map unless asked for.
      await ctx.api("PATCH", "/rider/me/status", { token: s.rider.token, body: { status: "OFFLINE" } });
      expect((await ctx.api("GET", "/ops/rider-locations", { token: s.ops.token })).body.items).toHaveLength(0);
      expect((await ctx.api("GET", "/ops/rider-locations?includeOffShift=true", { token: s.ops.token })).body.items).toHaveLength(1);
    });

    it("purges history past the retention window", async () => {
      const s = await setup();
      const old = new Date(Date.now() - 40 * 86_400_000);
      await ctx.prisma.riderLocationPoint.createMany({
        data: [
          { riderId: s.rider.rider.id, lat: 23.7, lng: 90.4, accuracy: 10, at: old },
          { riderId: s.rider.rider.id, lat: 23.7, lng: 90.4, accuracy: 10, at: new Date() },
        ],
      });
      expect(await ctx.app.get(RiderLocationService).purgeHistory()).toBe(1);
      expect(await ctx.prisma.riderLocationPoint.count()).toBe(1);
    });
  });

  describe("proof of delivery", () => {
    it("stores capture time and place, and shows the proof to whoever can see the parcel", async () => {
      const s = await setup();
      const trackingId = await outForDelivery(s, { codAmount: 0 });
      const capturedAt = new Date(Date.now() - 5 * 60_000).toISOString();
      const delivered = await ctx.api("POST", `/rider/parcels/${trackingId}/delivery`, {
        token: s.rider.token,
        body: { outcome: "DELIVERED", receivedBy: "Nabila Ahmed", proof: { method: "PHOTO", image: PNG }, capture: { capturedAt, lat: 23.7465, lng: 90.3762, accuracy: 18 } },
      });
      expect(delivered.body.status, JSON.stringify(delivered.body)).toBe("DELIVERED");

      const proof = await ctx.api("GET", `/parcels/${trackingId}/proof`, { token: s.customer.token });
      expect(proof.status).toBe(200);
      expect(proof.body).toMatchObject({
        trackingId,
        method: "PHOTO",
        receivedBy: "Nabila Ahmed",
        capturedAt,
        location: { lat: 23.7465, lng: 90.3762, accuracy: 18 },
        rider: { code: "R-2048" },
      });
      expect(proof.body.image.url).toBe(`/api/v1/files/${proof.body.image.fileId}`);
      const file = await ctx.api("GET", `/files/${proof.body.image.fileId}`, { token: s.customer.token, headers: { accept: "application/json" } });
      expect(file.body.dataUrl).toBe(PNG);

      // Same visibility as the parcel.
      const stranger = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Someone Else");
      expect((await ctx.api("GET", `/parcels/${trackingId}/proof`, { token: stranger.token })).status).toBe(404);
      expect((await ctx.api("GET", `/parcels/${trackingId}/proof`, { token: s.ops.token })).status).toBe(200);
      expect((await ctx.api("GET", `/parcels/${trackingId}/proof`, { token: s.rider.token })).status).toBe(200);
    });

    it("refuses an implausible capture time and replays an Idempotency-Key without delivering twice", async () => {
      const s = await setup();
      const trackingId = await outForDelivery(s, { codAmount: 0 });
      const body = (capturedAt: string) => ({ outcome: "DELIVERED", receivedBy: "Reception", proof: { method: "SIGNATURE", image: PNG }, capture: { capturedAt } });
      const bad = await ctx.api("POST", `/rider/parcels/${trackingId}/delivery`, { token: s.rider.token, body: body(new Date(Date.now() + 3600_000).toISOString()) });
      expect(bad.status).toBe(422);
      expect(bad.body.error.code).toBe("INVALID_CAPTURE_TIME");

      const headers = { "idempotency-key": "offline-delivery-0001" };
      const good = body(new Date().toISOString());
      const first = await ctx.api("POST", `/rider/parcels/${trackingId}/delivery`, { token: s.rider.token, body: good, headers });
      const replay = await ctx.api("POST", `/rider/parcels/${trackingId}/delivery`, { token: s.rider.token, body: good, headers });
      expect(first.body.status).toBe("DELIVERED");
      expect(replay.status).toBe(first.status);
      expect(replay.body.status).toBe("DELIVERED");
      expect(await ctx.prisma.deliveryProof.count()).toBe(1);
      expect(await ctx.prisma.riderEarning.count({ where: { type: "DELIVERY" } })).toBe(1);

      // Without the key, a second outcome for a delivered parcel is a conflict the rider sees.
      const again = await ctx.api("POST", `/rider/parcels/${trackingId}/delivery`, { token: s.rider.token, body: good });
      expect(again.status).toBeGreaterThanOrEqual(400);
      expect(again.body.error.code).toBeTruthy();

      // No proof for an undelivered parcel.
      const other = await outForDelivery(s);
      expect((await ctx.api("GET", `/parcels/${other}/proof`, { token: s.customer.token })).status).toBe(404);
    });
  });

  describe("pay", () => {
    it("derives a plan from the super admin's rider plans", () => {
      const config = {
        riderPlans: { ecommerce: { Growth: { mode: "perParcel", perParcel: 50 } }, document: { Starter: { mode: "both", perParcel: 20, monthlySalary: 9000 } } },
        riderPlanAssignments: { "R-2048": { ecommerce: "Growth", document: "Starter", parcel: "Growth" } },
      };
      const plan = planFromConfig(config, "R-2048");
      expect(plan).toMatchObject({ mode: "BOTH", rates: { ecommerce: 50, document: 20, parcel: 31.25 }, monthlySalary: 9000, source: "platform-config" });
      expect(planFromConfig({}, "R-1")).toMatchObject({ mode: "PER_PARCEL", rates: { ecommerce: 43.75, document: 37.5, parcel: 31.25 }, source: "default" });
      // A 30-day month: 10 days of a 30,000 salary.
      expect(salaryFor(30000, new Date("2026-09-01T00:00:00+06:00"), new Date("2026-09-11T00:00:00+06:00"))).toBe(10000);
    });

    it("records earnings per task and pays them through a maker-checker payout", async () => {
      const s = await setup();
      const plan = await ctx.api("POST", "/rider-pay/plans", {
        token: s.ops.token,
        body: { riderId: s.rider.rider.id, name: "Custom", mode: "PER_PARCEL", ecommerceRate: 40, documentRate: 30, parcelRate: 25, pickupRate: 10 },
      });
      expect(plan.status, JSON.stringify(plan.body)).toBe(201);
      expect(plan.body).toMatchObject({ name: "Custom", rates: { parcel: 25 }, pickupRate: 10, source: "manual" });
      expect((await ctx.api("POST", "/rider-pay/plans", { token: s.rider.token, body: { riderId: s.rider.rider.id, name: "x", mode: "PER_PARCEL" } })).status).toBe(403);

      const trackingId = await outForDelivery(s, { codAmount: 0 });
      await ctx.api("POST", `/rider/parcels/${trackingId}/delivery`, { token: s.rider.token, body: { outcome: "DELIVERED", receivedBy: "Reception", proof: { method: "SIGNATURE", image: PNG } } });

      const bonus = await ctx.api("POST", "/rider-pay/adjustments", { token: s.ops.token, body: { riderId: s.rider.rider.id, type: "INCENTIVE", amount: 100, description: "Peak-hour incentive" } });
      expect(bonus.status).toBe(201);
      await ctx.api("POST", "/rider-pay/adjustments", { token: s.ops.token, body: { riderId: s.rider.rider.id, type: "DEDUCTION", amount: 15, description: "Late handover" } });

      const mine = await ctx.api("GET", "/rider/earnings", { token: s.rider.token });
      expect(mine.status).toBe(200);
      expect(mine.body.plan).toMatchObject({ name: "Custom", mode: "PER_PARCEL" });
      expect(mine.body.totals).toMatchObject({ today: 120, unpaid: 120, paidToDate: 0 });
      expect(mine.body.today).toMatchObject({ delivery: { amount: 25, count: 1 }, pickup: { amount: 10, count: 1 }, incentive: { amount: 100 }, deduction: { amount: -15 } });
      expect(mine.body.items).toHaveLength(4);

      // Payout run for a period that includes today.
      const start = new Date(Date.now() - 86_400_000).toISOString();
      const end = new Date(Date.now() + 60_000).toISOString();
      const run = await ctx.api("POST", "/rider-payouts/runs", { token: s.ops.token, body: { periodStart: start, periodEnd: end } });
      expect(run.status, JSON.stringify(run.body)).toBe(201);
      expect(run.body.created).toHaveLength(1);
      const payout = run.body.created[0];
      expect(payout).toMatchObject({ amount: 120, status: "DRAFT", earnings: 4, number: expect.stringMatching(/^RPO-/) });
      // Running again for an overlapping period does nothing.
      expect((await ctx.api("POST", "/rider-payouts/runs", { token: s.ops.token, body: { periodStart: start, periodEnd: end } })).body.skipped[0].reason).toMatch(/^PERIOD_OVERLAP/);

      // Maker-checker: the preparer can't approve; finance can't pay before approval.
      const selfApprove = await ctx.api("POST", `/rider-payouts/${payout.id}/approve`, { token: s.ops.token });
      expect(selfApprove.body.error.code).toBe("MAKER_CHECKER");
      const finance = await userWithRoles(ctx, [{ role: "FINANCE" }], "Finance Officer");
      const early = await ctx.api("POST", `/rider-payouts/${payout.id}/pay`, { token: finance.token, body: { paymentMethod: "BKASH", paymentReference: "TXN-1" } });
      expect(early.body.error.code).toBe("PAYOUT_NOT_APPROVED");
      expect((await ctx.api("POST", `/rider-payouts/${payout.id}/approve`, { token: finance.token })).body.status).toBe("APPROVED");
      const hubStaff = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: s.h.id }], "Hub Staff");
      expect((await ctx.api("POST", `/rider-payouts/${payout.id}/pay`, { token: hubStaff.token, body: { paymentMethod: "BKASH", paymentReference: "TXN-1" } })).status).toBe(403);
      const ledger = vi.spyOn(ctx.app.get(LedgerService), "record");
      const paid = await ctx.api("POST", `/rider-payouts/${payout.id}/pay`, { token: finance.token, body: { paymentMethod: "BKASH", paymentReference: "TXN-77" } });
      expect(paid.body).toMatchObject({ status: "PAID", paymentMethod: "BKASH", paymentReference: "TXN-77" });

      expect(ledger).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: "RIDER_PAYOUT_PAID", reference: payout.number, riderId: s.rider.rider.id }));
      ledger.mockRestore();
      expect(await ctx.prisma.outboxMessage.count({ where: { template: "rider.payout_paid" } })).toBeGreaterThan(0);

      const after = await ctx.api("GET", "/rider/earnings", { token: s.rider.token });
      expect(after.body.totals).toMatchObject({ unpaid: 0, paidToDate: 120 });
      expect(after.body.payouts[0]).toMatchObject({ number: payout.number, status: "PAID" });
      const detail = await ctx.api("GET", `/rider/payouts/${payout.id}`, { token: s.rider.token });
      expect(detail.body.lines).toHaveLength(4);

      // Another rider can't read it.
      const other = await riderUser(ctx, "R-3001", s.h.id);
      expect((await ctx.api("GET", `/rider/payouts/${payout.id}`, { token: other.token })).status).toBe(404);
    });

    it("cancels an unpaid payout and releases its earnings", async () => {
      const s = await setup();
      await ctx.api("POST", "/rider-pay/adjustments", { token: s.ops.token, body: { riderId: s.rider.rider.id, type: "INCENTIVE", amount: 50, description: "Referral bonus" } });
      const run = await ctx.api("POST", "/rider-payouts/runs", {
        token: s.ops.token,
        body: { periodStart: new Date(Date.now() - 86_400_000).toISOString(), periodEnd: new Date(Date.now() + 60_000).toISOString() },
      });
      const id = run.body.created[0].id;
      expect((await ctx.api("POST", `/rider-payouts/${id}/cancel`, { token: s.ops.token, body: {} })).body.status).toBe("CANCELLED");
      expect(await ctx.prisma.riderEarning.count({ where: { payoutId: null } })).toBe(1);
    });
  });

  describe("partial delivery", () => {
    it("the rider ticks Partial delivery and enters the cash collected: only that cash is with the rider, and a return order goes back", async () => {
      const s = await setup();
      // A customer parcel has no merchant to return to: no partial delivery.
      const customerParcel = await outForDelivery(s, { codAmount: 900 });
      const refused = await ctx.api("POST", `/rider/parcels/${customerParcel}/delivery`, { token: s.rider.token, body: { outcome: "DELIVERED", receivedBy: "N", proof: { method: "SIGNATURE", image: PNG }, partial: true, codCollected: 100 } });
      expect(refused.body.error.code).toBe("PARTIAL_NOT_MERCHANT");
      // A merchant order, booked by operations and taken out for delivery.
      const shop = await ctx.prisma.merchant.create({
        data: { code: "MR-PD1", type: "ECOMMERCE", name: "Partial Shop", status: "ACTIVE", contactName: "Owner", contactPhone: "+8801911000009", pickupAddress: "House 5 Road 2", pickupArea: "Gulshan", pickupDistrict: "Dhaka North" },
      });
      const booked = await ctx.api("POST", "/ops/parcels", { token: s.ops.token, body: { merchantId: shop.id, ...parcelBody({ codAmount: 1500 }), sender: undefined, pickup: undefined } });
      expect(booked.status, JSON.stringify(booked.body)).toBe(201);
      const trackingId = booked.body.trackingId as string;
      await ctx.api("POST", `/parcels/${trackingId}/assign-pickup`, { token: s.ops.token, body: { riderId: s.rider.rider.id } });
      expect((await ctx.api("POST", `/rider/parcels/${trackingId}/pickup`, { token: s.rider.token, body: { outcome: "COLLECTED_DELIVER_DIRECT" } })).body.status).toBe("OUT_FOR_DELIVERY");
      const deliver = (body: Record<string, unknown>) => ctx.api("POST", `/rider/parcels/${trackingId}/delivery`, { token: s.rider.token, body: { outcome: "DELIVERED", receivedBy: "Nabila", proof: { method: "SIGNATURE", image: PNG }, ...body } });
      expect((await deliver({ codCollected: 400 })).body.error.code).toBe("COD_MISMATCH");
      expect((await deliver({ partial: true, codCollected: 1600 })).body.error.code).toBe("COD_COLLECTED_INVALID");
      const done = await deliver({ partial: true, codCollected: 400, note: "Returned 2 of 3 items" });
      expect(done.status, JSON.stringify(done.body)).toBeLessThan(300);
      const parcel = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId }, include: { codCollection: true, returnOrders: true } });
      expect(parcel).toMatchObject({ status: "DELIVERED", partialDelivery: true });
      expect(Number(parcel.codCollection!.amount)).toBe(400);
      expect(parcel.returnOrders).toHaveLength(1);
      expect(parcel.returnOrders[0]).toMatchObject({ status: "RETURN_SCHEDULED", returnOfId: parcel.id });
      // The rider hands over ৳400, not ৳1,500.
      const slip = await ctx.api("POST", "/rider/my-cash/slip", { token: s.rider.token });
      expect(slip.body).toMatchObject({ expected: 400, parcels: 1 });

      // The hub assigns the return order to the rider: the rider sees it (planned) and returns it by scanning.
      const back = parcel.returnOrders[0].trackingId;
      const assigned = await ctx.api("POST", "/hub-desk/return-assign", { token: s.ops.token, body: { code: back, riderId: s.rider.rider.id, hubId: s.h.id } });
      expect(assigned.body, JSON.stringify(assigned.body)).toMatchObject({ ok: true });
      const runs = (await ctx.api("GET", "/rider/return-runs", { token: s.rider.token })).body.items;
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ status: "PLANNED", parcels: [{ trackingId: back }] });
      // Another rider can't return it.
      const other = await riderUser(ctx, "R-2099", s.h.id);
      expect((await ctx.api("POST", `/rider/parcels/${back}/return`, { token: other.token, body: {} })).status).toBe(403);
      const returned = await ctx.api("POST", `/rider/parcels/${back}/return`, { token: s.rider.token, body: { runId: runs[0].id, receivedBy: "Shop manager" } });
      expect(returned.body, JSON.stringify(returned.body)).toMatchObject({ outcome: "RETURNED", runCompleted: true });
      expect(await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: back } })).toMatchObject({ status: "RETURNED" });
      expect(await ctx.prisma.returnRun.findUniqueOrThrow({ where: { id: runs[0].id } })).toMatchObject({ status: "COMPLETED" });
      expect((await ctx.api("GET", "/rider/return-runs", { token: s.rider.token })).body.items).toHaveLength(0);
    });
  });

  describe("My cash: the handover slip", () => {
    it("makes one slip of all the cash held, keeps it up to date, cancels it; the hub receives it", async () => {
      const s = await setup();
      expect((await ctx.api("POST", "/rider/my-cash/slip", { token: s.rider.token })).body.error.code).toBe("NO_CASH_TO_HAND_OVER");
      const deliver = async (cod: number) => {
        const id = await outForDelivery(s, { codAmount: cod });
        await ctx.api("POST", `/rider/parcels/${id}/delivery`, { token: s.rider.token, body: { outcome: "DELIVERED", receivedBy: "N", proof: { method: "SIGNATURE", image: PNG }, codCollected: cod } });
      };
      await deliver(1500);
      const first = (await ctx.api("POST", "/rider/my-cash/slip", { token: s.rider.token })).body;
      expect(first).toMatchObject({ status: "OPEN", expected: 1500, parcels: 1 });
      // More cash since: the slip is out of date until it's made again (same number).
      await deliver(700);
      expect((await ctx.api("GET", "/rider/my-cash", { token: s.rider.token })).body).toMatchObject({ total: 2200, slipOutdated: true });
      const updated = (await ctx.api("POST", "/rider/my-cash/slip", { token: s.rider.token })).body;
      expect(updated).toMatchObject({ number: first.number, expected: 2200, parcels: 2 });
      // Cancel, then a new slip gets a new number.
      expect((await ctx.api("POST", "/rider/my-cash/slip/cancel", { token: s.rider.token })).body.slip).toBeNull();
      const again = (await ctx.api("POST", "/rider/my-cash/slip", { token: s.rider.token })).body;
      expect(again.number).not.toBe(first.number);
      // The rider's hub lists it; another hub's list doesn't (it can still receive it if the rider comes there).
      const cashier = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: s.h.id }], "Cashier");
      const otherHub = await hub(ctx, "HUB-T9");
      const stranger = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: otherHub.id }]);
      expect((await ctx.api("GET", "/cash/slips?status=OPEN", { token: stranger.token })).body.items).toHaveLength(0);
      expect((await ctx.api("GET", "/cash/slips?status=OPEN", { token: cashier.token })).body.items).toHaveLength(1);
      // A rider can't receive cash.
      expect((await ctx.api("POST", `/cash/slips/${again.id}/receive`, { token: s.rider.token, body: { received: 2200 } })).status).toBe(403);
      expect((await ctx.api("POST", `/cash/slips/${again.id}/receive`, { token: cashier.token, body: { received: 2200 } })).body).toMatchObject({ status: "RECEIVED", short: 0 });
      expect((await ctx.api("GET", "/rider/my-cash", { token: s.rider.token })).body).toMatchObject({ total: 0, slip: null });
      // Only riders have My cash.
      expect((await ctx.api("GET", "/rider/my-cash", { token: cashier.token })).status).toBe(403);
    });
  });

  describe("onboarding and KYC", () => {
    it("collects documents, sends them for review and records the decision", async () => {
      const s = await setup();
      const status = () => ctx.api("GET", "/rider/kyc", { token: s.rider.token }).then(r => r.body);
      expect(await status()).toMatchObject({ status: "NOT_STARTED", required: ["NID_FRONT", "NID_BACK", "PHOTO", "DRIVING_LICENSE", "VEHICLE_PAPERS"] });

      const start = await ctx.api("POST", `/riders/${s.rider.rider.id}/onboarding`, { token: s.ops.token, body: { note: "Welcome aboard" } });
      expect(start.status, JSON.stringify(start.body)).toBe(200);
      expect(start.body.status).toBe("DOCUMENTS_PENDING");
      expect(await ctx.prisma.outboxMessage.count({ where: { template: "rider.kyc_status" } })).toBeGreaterThan(0);
      expect((await ctx.api("POST", `/riders/${s.rider.rider.id}/onboarding`, { token: s.rider.token, body: {} })).status).toBe(403);

      const early = await ctx.api("POST", "/rider/kyc/submit", { token: s.rider.token });
      expect(early.body.error.code).toBe("KYC_INCOMPLETE");

      const bad = await ctx.api("POST", "/rider/kyc/documents", { token: s.rider.token, body: { type: "PHOTO", file: "data:text/html;base64,PGgxPg==" } });
      expect(bad.status).toBe(422);

      for (const type of ["NID_FRONT", "NID_BACK", "PHOTO", "DRIVING_LICENSE"]) {
        const up = await ctx.api("POST", "/rider/kyc/documents", { token: s.rider.token, body: { type, file: PNG, documentNumber: type === "DRIVING_LICENSE" ? "DK-0123456" : undefined } });
        expect(up.status, JSON.stringify(up.body)).toBe(201);
      }
      await ctx.api("POST", "/rider/kyc/documents", { token: s.rider.token, body: { type: "VEHICLE_PAPERS", file: PDF } });
      const submitted = await ctx.api("POST", "/rider/kyc/submit", { token: s.rider.token });
      expect(submitted.body).toMatchObject({ status: "UNDER_REVIEW", missing: [] });
      expect(submitted.body.documents).toHaveLength(5);

      const queue = await ctx.api("GET", "/rider-kyc", { token: s.ops.token });
      expect(queue.body).toHaveLength(1);
      expect(queue.body[0]).toMatchObject({ code: "R-2048", status: "UNDER_REVIEW", documents: { total: 5, pending: 5 } });

      // Reviewers open the file; another rider can't.
      const photo = submitted.body.documents.find((d: { type: string }) => d.type === "PHOTO");
      const file = await ctx.api("GET", `/rider-kyc/documents/${photo.id}/file`, { token: s.ops.token, headers: { accept: "application/json" } });
      expect(file.body.dataUrl).toBe(PNG);
      expect((await ctx.api("GET", `/rider-kyc/documents/${photo.id}/file`, { token: s.rider.token })).status).toBe(200);
      const other = await riderUser(ctx, "R-3002", s.h.id);
      expect((await ctx.api("GET", `/rider-kyc/documents/${photo.id}/file`, { token: other.token })).status).toBe(404);

      // A rejected document blocks approval until the rider uploads it again.
      const reject = await ctx.api("POST", `/rider-kyc/documents/${photo.id}/review`, { token: s.ops.token, body: { decision: "REJECT", reason: "Face not visible" } });
      expect(reject.status).toBe(200);
      expect((await ctx.api("POST", `/rider-kyc/${s.rider.rider.id}/decision`, { token: s.ops.token, body: { decision: "APPROVE" } })).body.error.code).toBe("KYC_HAS_REJECTED_DOCUMENTS");
      const needsChanges = await ctx.api("POST", `/rider-kyc/${s.rider.rider.id}/decision`, { token: s.ops.token, body: { decision: "REJECT" } });
      expect(needsChanges.status).toBe(422); // a note is required
      await ctx.api("POST", `/rider-kyc/${s.rider.rider.id}/decision`, { token: s.ops.token, body: { decision: "REJECT", note: "Please retake your photo" } });
      const mine = await status();
      expect(mine).toMatchObject({ status: "REJECTED", note: "Please retake your photo", missing: ["PHOTO"] });
      expect(mine.documents.find((d: { type: string }) => d.type === "PHOTO")).toMatchObject({ status: "REJECTED", rejectionReason: "Face not visible" });

      await ctx.api("POST", "/rider/kyc/documents", { token: s.rider.token, body: { type: "PHOTO", file: PNG } });
      expect((await ctx.api("POST", "/rider/kyc/submit", { token: s.rider.token })).body.status).toBe("UNDER_REVIEW");
      const approved = await ctx.api("POST", `/rider-kyc/${s.rider.rider.id}/decision`, { token: s.ops.token, body: { decision: "APPROVE" } });
      expect(approved.body.status).toBe("APPROVED");
      expect(approved.body.documents.every((d: { status: string }) => d.status === "APPROVED")).toBe(true);
      expect((await status()).status).toBe("APPROVED");
    });
  });
});
