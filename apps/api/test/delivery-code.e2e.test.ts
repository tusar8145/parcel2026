import { decrypt } from "../src/common/crypto";
import { hub, parcelBody, resetDatabase, riderUser, startApp, userWithRoles, type TestContext } from "./helpers";

// 1x1 transparent PNG
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/**
 * Owner change (2026-10-18): the recipient's delivery code (OTP) is sent when the rider starts the delivery
 * (OUT_FOR_DELIVERY), never when operations assign the delivery rider.
 */
describe("delivery code is sent at Start delivery, not at assignment", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  /** A customer parcel at the hub (recipient +8801812000000, COD 1,500). */
  const atHub = async () => {
    const h = await hub(ctx);
    const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Rahim Uddin");
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops Manager");
    const rider = await riderUser(ctx, "R-5101", h.id);
    const other = await riderUser(ctx, "R-5102", h.id);
    const { trackingId } = (await ctx.api("POST", "/parcels", { token: customer.token, body: parcelBody() })).body;
    await ctx.api("POST", `/parcels/${trackingId}/assign-pickup`, { token: ops.token, body: { riderId: rider.rider.id } });
    const res = await ctx.api("POST", `/rider/parcels/${trackingId}/pickup`, { token: rider.token, body: { outcome: "COLLECTED_TO_HUB", hubId: h.id } });
    expect(res.body.status, JSON.stringify(res.body)).toBe("AT_HUB");
    return { h, ops, rider, other, trackingId };
  };
  const codeSms = (trackingId: string) => ctx.prisma.outboxMessage.findMany({ where: { template: "parcel.delivery_code", trackingId }, orderBy: { createdAt: "asc" } });
  const storedCode = async (trackingId: string) => {
    const p = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId } });
    return p.deliveryOtpEncrypted ? decrypt(p.deliveryOtpEncrypted) : null;
  };
  const assign = (s: { ops: { token: string } }, trackingId: string, riderId: string) =>
    ctx.api("POST", `/parcels/${trackingId}/assign-delivery`, { token: s.ops.token, body: { riderId } });
  const deliverOtp = (token: string, trackingId: string, otp: string) =>
    ctx.api("POST", `/rider/parcels/${trackingId}/delivery`, { token, body: { outcome: "DELIVERED", receivedBy: "Nabila", proof: { method: "OTP", otp }, codCollected: 1500 } });

  it("assigning (and re-assigning) sends no code; Start delivery sends exactly one, which verifies", async () => {
    const s = await atHub();
    const { trackingId } = s;

    const assigned = await assign(s, trackingId, s.rider.rider.id);
    expect(assigned.body.status, JSON.stringify(assigned.body)).toBe("ASSIGNED");
    expect(await codeSms(trackingId)).toHaveLength(0);
    expect(await storedCode(trackingId)).toBeNull();
    const task = (await ctx.api("GET", "/rider/tasks", { token: s.rider.token })).body.deliveries[0];
    expect(task).toMatchObject({ trackingId, status: "ASSIGNED", deliveryCodeSent: false });

    // Re-assigned before the start: still no code.
    expect((await assign(s, trackingId, s.other.rider.id)).body.status).toBe("ASSIGNED");
    expect(await codeSms(trackingId)).toHaveLength(0);
    expect(await storedCode(trackingId)).toBeNull();

    // The new rider starts the delivery: one SMS with the stored code.
    const started = await ctx.api("POST", `/rider/parcels/${trackingId}/start-delivery`, { token: s.other.token });
    expect(started.body, JSON.stringify(started.body)).toMatchObject({ status: "OUT_FOR_DELIVERY", deliveryCodeSent: true });
    const sms = await codeSms(trackingId);
    expect(sms).toHaveLength(1);
    expect(sms[0].to).toBe("+8801812000000");
    const code = (await storedCode(trackingId))!;
    expect(sms[0].body).toContain(code);
    const done = await deliverOtp(s.other.token, trackingId, code);
    expect(done.body.status, JSON.stringify(done.body)).toBe("DELIVERED");
  });

  it("refuses OTP delivery and a resend before the start; signature proof needs no code", async () => {
    const s = await atHub();
    const { trackingId } = s;
    await assign(s, trackingId, s.rider.rider.id);

    const otp = await deliverOtp(s.rider.token, trackingId, "1234");
    expect(otp.status).toBe(409);
    expect(otp.body.error).toMatchObject({ code: "DELIVERY_NOT_STARTED", message: "Start the delivery first; the code is sent to the recipient then" });
    const resend = await ctx.api("POST", `/rider/parcels/${trackingId}/resend-code`, { token: s.rider.token });
    expect(resend.status).toBe(409);
    expect(resend.body.error.code).toBe("DELIVERY_NOT_STARTED");
    expect(await codeSms(trackingId)).toHaveLength(0);

    const signed = await ctx.api("POST", `/rider/parcels/${trackingId}/delivery`, {
      token: s.rider.token,
      body: { outcome: "DELIVERED", receivedBy: "Reception", proof: { method: "SIGNATURE", image: PNG }, codCollected: 1500 },
    });
    expect(signed.body.status, JSON.stringify(signed.body)).toBe("DELIVERED");
    expect(await codeSms(trackingId)).toHaveLength(0);
  });

  it("a resend after the start replaces the code: the old one stops working", async () => {
    const s = await atHub();
    const { trackingId } = s;
    await assign(s, trackingId, s.rider.rider.id);
    await ctx.api("POST", `/rider/parcels/${trackingId}/start-delivery`, { token: s.rider.token });
    const first = (await storedCode(trackingId))!;

    const resend = await ctx.api("POST", `/rider/parcels/${trackingId}/resend-code`, { token: s.rider.token });
    expect(resend.status, JSON.stringify(resend.body)).toBe(200);
    const sms = await codeSms(trackingId);
    expect(sms).toHaveLength(2);
    const second = (await storedCode(trackingId))!;
    expect(sms[1].body).toContain(second);

    // The codes are random 4-digit numbers: only if they differ is the old one checked as invalid.
    if (first !== second) expect((await deliverOtp(s.rider.token, trackingId, first)).body.error.code).toBe("INVALID_DELIVERY_CODE");
    expect((await deliverOtp(s.rider.token, trackingId, second)).body.status).toBe("DELIVERED");
  });

  it("a new start after a failed attempt sends a fresh code; an Idempotency-Key replay sends nothing again", async () => {
    const s = await atHub();
    const { trackingId } = s;
    await assign(s, trackingId, s.rider.rider.id);
    const headers = { "idempotency-key": "start-delivery-replay-0001" };
    await ctx.api("POST", `/rider/parcels/${trackingId}/start-delivery`, { token: s.rider.token, headers });
    const replay = await ctx.api("POST", `/rider/parcels/${trackingId}/start-delivery`, { token: s.rider.token, headers });
    expect(replay.body.status).toBe("OUT_FOR_DELIVERY");
    expect(await codeSms(trackingId)).toHaveLength(1);

    const failed = await ctx.api("POST", `/rider/parcels/${trackingId}/delivery`, { token: s.rider.token, body: { outcome: "FAILED", reason: "Recipient unavailable", nextAction: "RETRY" } });
    expect(failed.body.status, JSON.stringify(failed.body)).toBe("RETRY_SCHEDULED");
    // The code from the first start still exists, so a resend is allowed in RETRY_SCHEDULED.
    expect((await ctx.api("POST", `/rider/parcels/${trackingId}/resend-code`, { token: s.rider.token })).status).toBe(200);
    expect(await codeSms(trackingId)).toHaveLength(2);

    const restarted = await ctx.api("POST", `/rider/parcels/${trackingId}/start-delivery`, { token: s.rider.token });
    expect(restarted.body.status, JSON.stringify(restarted.body)).toBe("OUT_FOR_DELIVERY");
    const sms = await codeSms(trackingId);
    expect(sms).toHaveLength(3);
    const latest = (await storedCode(trackingId))!;
    expect(sms[2].body).toContain(latest);
    expect((await deliverOtp(s.rider.token, trackingId, latest)).body.status).toBe("DELIVERED");
  });

  it("operations setting Out for delivery sends the code; back at the hub and re-assigned, it's cleared", async () => {
    const s = await atHub();
    const { trackingId } = s;
    await assign(s, trackingId, s.rider.rider.id);
    const out = await ctx.api("POST", `/parcels/${trackingId}/status`, { token: s.ops.token, body: { status: "OUT_FOR_DELIVERY" } });
    expect(out.body.status, JSON.stringify(out.body)).toBe("OUT_FOR_DELIVERY");
    const sms = await codeSms(trackingId);
    expect(sms).toHaveLength(1);
    expect(sms[0].body).toContain((await storedCode(trackingId))!);

    const back = await ctx.api("POST", `/parcels/${trackingId}/status`, { token: s.ops.token, body: { status: "AT_HUB", hubId: s.h.id } });
    expect(back.body.status, JSON.stringify(back.body)).toBe("AT_HUB");
    expect(await storedCode(trackingId)).toBeNull();
    await assign(s, trackingId, s.other.rider.id);
    expect(await storedCode(trackingId)).toBeNull();
    expect(await codeSms(trackingId)).toHaveLength(1);
  });
});
