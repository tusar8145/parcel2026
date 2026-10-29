import { decrypt } from "../src/common/crypto";
import { hub, parcelBody, resetDatabase, riderUser, startApp, userWithRoles, type TestContext, sameHubDelivery } from "./helpers";

// 1x1 transparent PNG
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

describe("parcel lifecycle", () => {
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

  it("books with server-side pricing, a dated tracking ID and SMS", async () => {
    const { customer } = await setup();
    const res = await ctx.api("POST", "/parcels", { token: customer.token, body: parcelBody() });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.trackingId).toMatch(/^CP-\d{6}-[0-9A-HJKMNP-TV-Z]{5}$/); // CP = customer parcel; date + random Crockford base32
    expect(res.body).toMatchObject({ status: "PENDING_CONFIRMATION", statusLabel: "Pending operations confirmation", channel: "WEBSITE", canCancel: true });
    // Service packages v2 (customer default): Dhaka → Dhaka (same district) 70 + 2 kg (2 × 15) + Express ("Same day") 40 + COD fee 15.
    expect(res.body.charges).toMatchObject({ base: 70, weight: 30, service: 40, codFee: 15, discount: 0, reattempt: 0, total: 155 });
    expect(res.body.charges.lines.map((l: { code: string; amount: number }) => [l.code, l.amount])).toEqual([["route", 70], ["weight", 30], ["speed", 40], ["cod_fee", 15]]);
    expect(res.body.recipient.phone).toBe("+8801812000000");
    expect(await ctx.prisma.outboxMessage.count({ where: { template: "parcel.booked", channel: "SMS" } })).toBe(1);
    expect(await ctx.prisma.address.count({ where: { userId: customer.user.id } })).toBe(2);
  });

  it("ignores client-sent prices and returns an Idempotency-Key replay", async () => {
    const { customer } = await setup();
    const headers = { "idempotency-key": "booking-attempt-0001" };
    const body = { ...parcelBody(), totalCharge: 1 };
    const a = await ctx.api("POST", "/parcels", { token: customer.token, body, headers });
    const b = await ctx.api("POST", "/parcels", { token: customer.token, body, headers });
    expect(a.body.charges.total).toBe(155);
    expect(b.body.trackingId).toBe(a.body.trackingId);
    expect(await ctx.prisma.parcel.count()).toBe(1);
    const different = await ctx.api("POST", "/parcels", { token: customer.token, body: parcelBody({ weightKg: 5 }), headers });
    expect(different.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("runs pickup → hub → delivery with OTP proof and records COD", async () => {
    const { h, customer, ops, rider } = await setup();
    const { trackingId } = (await ctx.api("POST", "/parcels", { token: customer.token, body: parcelBody() })).body;

    // Operations accepts and assigns a pickup rider.
    const assigned = await ctx.api("POST", `/parcels/${trackingId}/assign-pickup`, { token: ops.token, body: { riderId: rider.rider.id } });
    expect(assigned.body).toMatchObject({ status: "PICKUP_ASSIGNED", canCancel: false });
    expect(assigned.body.pickupRider.label).toBe("R-2048 · Rider R-2048");

    // The customer can no longer cancel.
    const cancel = await ctx.api("POST", `/parcels/${trackingId}/cancel`, { token: customer.token, body: {} });
    expect(cancel.body.error.code).toBe("NOT_CANCELLABLE");

    // Rider's pickup queue, then handoff to the hub.
    expect((await ctx.api("GET", "/rider/tasks", { token: rider.token })).body.pickups).toHaveLength(1);
    const atHub = await ctx.api("POST", `/rider/parcels/${trackingId}/pickup`, { token: rider.token, body: { outcome: "COLLECTED_TO_HUB", hubId: h.id } });
    expect(atHub.body).toMatchObject({ status: "AT_HUB", currentHub: { id: h.id } });

    // Operations assigns delivery: no code yet. The rider starts the delivery: the recipient gets a code by SMS.
    await ctx.api("POST", `/parcels/${trackingId}/assign-delivery`, { token: ops.token, body: { riderId: rider.rider.id } });
    expect(await ctx.prisma.outboxMessage.count({ where: { template: "parcel.delivery_code" } })).toBe(0);
    await ctx.api("POST", `/rider/parcels/${trackingId}/start-delivery`, { token: rider.token });
    const sms = await ctx.prisma.outboxMessage.findFirstOrThrow({ where: { template: "parcel.delivery_code" } });
    expect(sms.to).toBe("+8801812000000");
    const parcel = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId } });
    const code = decrypt(parcel.deliveryOtpEncrypted!);
    expect(sms.body).toContain(code);

    // Wrong COD and wrong code are rejected.
    const deliver = (body: object) => ctx.api("POST", `/rider/parcels/${trackingId}/delivery`, { token: rider.token, body });
    expect((await deliver({ outcome: "DELIVERED", receivedBy: "Nabila", proof: { method: "OTP", otp: code }, codCollected: 1000 })).body.error.code).toBe("COD_MISMATCH");
    expect((await deliver({ outcome: "DELIVERED", receivedBy: "Nabila", proof: { method: "OTP", otp: "0000" }, codCollected: 1500 })).body.error.code).toBe("INVALID_DELIVERY_CODE");

    const done = await deliver({ outcome: "DELIVERED", receivedBy: "Nabila", proof: { method: "OTP", otp: code }, codCollected: 1500 });
    expect(done.body).toMatchObject({ status: "DELIVERED", proof: { method: "OTP", receivedBy: "Nabila" }, cod: { amount: 1500, state: "WITH_RIDER" } });

    const cash = await ctx.api("GET", "/rider/cash", { token: rider.token });
    expect(cash.body.inHand).toBe(1500);

    // Public tracking shows the journey without personal details.
    const track = await ctx.api("GET", `/track/${trackingId.toLowerCase()}`);
    expect(track.status).toBe(200);
    expect(track.body).toMatchObject({ statusLabel: "Delivered", stage: 4, recipient: "Nabila A.", proofMethod: "OTP" });
    expect(JSON.stringify(track.body)).not.toContain("01812000000");
    expect(JSON.stringify(track.body)).not.toContain("Road 7 Flat 3B");
    expect(track.body.events.map((e: { status: string }) => e.status)).toEqual([
      "PENDING_CONFIRMATION",
      "PICKUP_ASSIGNED",
      "AT_HUB",
      "ASSIGNED",
      "OUT_FOR_DELIVERY",
      "DELIVERED",
    ]);
  });

  it("supports direct delivery with a signature, and failed attempts", async () => {
    const { h, customer, ops, rider } = await setup();
    const book = () => ctx.api("POST", "/parcels", { token: customer.token, body: parcelBody({ codAmount: 0 }) }).then(r => r.body.trackingId as string);

    const direct = await book();
    await ctx.api("POST", `/parcels/${direct}/assign-pickup`, { token: ops.token, body: { riderId: rider.rider.id } });
    await sameHubDelivery(ctx, direct);
    const out = await ctx.api("POST", `/rider/parcels/${direct}/pickup`, { token: rider.token, body: { outcome: "COLLECTED_DELIVER_DIRECT" } });
    expect(out.body).toMatchObject({ status: "OUT_FOR_DELIVERY", deliveryRider: { id: rider.rider.id } });
    const signed = await ctx.api("POST", `/rider/parcels/${direct}/delivery`, {
      token: rider.token,
      body: { outcome: "DELIVERED", receivedBy: "Reception", proof: { method: "SIGNATURE", image: PNG } },
    });
    expect(signed.body).toMatchObject({ status: "DELIVERED", proof: { method: "SIGNATURE", hasFile: true } });

    const failing = await book();
    await ctx.api("POST", `/parcels/${failing}/assign-pickup`, { token: ops.token, body: { riderId: rider.rider.id } });
    await sameHubDelivery(ctx, failing);
    await ctx.api("POST", `/rider/parcels/${failing}/pickup`, { token: rider.token, body: { outcome: "COLLECTED_DELIVER_DIRECT" } });
    const retry = await ctx.api("POST", `/rider/parcels/${failing}/delivery`, {
      token: rider.token,
      body: { outcome: "FAILED", reason: "Recipient unavailable", nextAction: "RETRY" },
    });
    expect(retry.body).toMatchObject({ status: "RETRY_SCHEDULED", attemptCount: 1 });
    const back = await ctx.api("POST", `/rider/parcels/${failing}/delivery`, {
      token: rider.token,
      body: { outcome: "FAILED", reason: "Incorrect address", nextAction: "RETURN_TO_HUB", hubId: h.id },
    });
    expect(back.body).toMatchObject({ status: "AT_HUB", attemptCount: 2, deliveryRider: null });
    expect(await ctx.prisma.deliveryAttempt.count({ where: { outcome: "FAILED" } })).toBe(2);
  });

  it("enforces the lifecycle and optimistic locking", async () => {
    const { customer, ops } = await setup();
    const { trackingId, version } = (await ctx.api("POST", "/parcels", { token: customer.token, body: parcelBody() })).body;
    const jump = await ctx.api("POST", `/parcels/${trackingId}/status`, { token: ops.token, body: { status: "Out for delivery" } });
    expect(jump.body.error.code).toBe("RIDER_REQUIRED");
    const invalid = await ctx.api("POST", `/parcels/${trackingId}/status`, { token: ops.token, body: { status: "Delivered" } });
    expect(invalid.body.error.code).toBe("INVALID_STATUS_CHANGE");
    await ctx.api("POST", `/parcels/${trackingId}/status`, { token: ops.token, body: { status: "Exception", note: "Customer called" } });
    const stale = await ctx.api("POST", `/parcels/${trackingId}/status`, { token: ops.token, body: { status: "Return scheduled", expectedVersion: version } });
    expect(stale.body.error.code).toBe("PARCEL_CHANGED");
  });

  it("lets customers cancel while pending", async () => {
    const { customer } = await setup();
    const { trackingId } = (await ctx.api("POST", "/parcels", { token: customer.token, body: parcelBody() })).body;
    const res = await ctx.api("POST", `/parcels/${trackingId}/cancel`, { token: customer.token, body: { reason: "Booked by mistake" } });
    expect(res.body).toMatchObject({ status: "PICKUP_CANCELLED", cancelReason: "Booked by mistake" });
  });

  it("scopes data: customers see their own parcels, riders their tasks", async () => {
    const { customer, rider, ops } = await setup();
    const other = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Someone Else");
    const { trackingId } = (await ctx.api("POST", "/parcels", { token: customer.token, body: parcelBody() })).body;

    expect((await ctx.api("GET", `/parcels/${trackingId}`, { token: other.token })).status).toBe(404);
    expect((await ctx.api("GET", "/parcels", { token: other.token })).body.items).toHaveLength(0);
    expect((await ctx.api("GET", `/parcels/${trackingId}`, { token: rider.token })).status).toBe(404);
    expect((await ctx.api("POST", `/parcels/${trackingId}/assign-pickup`, { token: customer.token, body: { riderId: rider.rider.id } })).status).toBe(403);

    await ctx.api("POST", `/parcels/${trackingId}/assign-pickup`, { token: ops.token, body: { riderId: rider.rider.id } });
    expect((await ctx.api("GET", `/parcels/${trackingId}`, { token: rider.token })).status).toBe(200);
    expect((await ctx.api("GET", "/parcels?status=Pickup%20assigned", { token: ops.token })).body.items).toHaveLength(1);
  });

  it("writes an audit trail for every change", async () => {
    const { customer, ops, rider } = await setup();
    const { trackingId, id } = (await ctx.api("POST", "/parcels", { token: customer.token, body: parcelBody() })).body;
    await ctx.api("POST", `/parcels/${trackingId}/assign-pickup`, { token: ops.token, body: { riderId: rider.rider.id } });
    const actions = (await ctx.prisma.auditLog.findMany({ where: { entityId: id }, orderBy: { createdAt: "asc" } })).map(a => a.action);
    expect(actions).toEqual(["parcel.create", "parcel.status_change"]);
  });
});
