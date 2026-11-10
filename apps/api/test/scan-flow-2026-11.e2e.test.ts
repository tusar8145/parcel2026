import { decrypt, hashPassword } from "../src/common/crypto";
import { PASSWORD, hub, parcelBody, resetDatabase, riderUser, startApp, userWithRoles, type TestContext } from "./helpers";

// 1x1 PNG: a proof photo.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/**
 * Flexible scan flow and franchises (owner spec 2026-11-11): receive & assign rider in one scan (in transit to the hub
 * included; another rider's scan moves it), the rider's "try again / return to sender" choice that the hub follows or
 * changes when it scans the parcel back, the super admin's fail delivery reasons, any hub tagged as a franchise hub
 * (its riders only on its parcels), a franchise's own deliveries and failed deliveries with proof, its cash, and the
 * Parcel queue's merchant filters. Also: SMS / email messages to groups and the gateway on / off switches.
 */
describe("scan flow, franchise hubs and messaging (2026-11)", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  const setup = async () => {
    const gulshan = await hub(ctx, "HUB-GUL");
    const dhanmondi = await hub(ctx, "HUB-DHN");
    const shop = await ctx.prisma.merchant.create({
      data: { code: "MR-7001", type: "ECOMMERCE", name: "Flow Shop", status: "ACTIVE", contactName: "Owner", contactPhone: "+8801911000072", pickupAddress: "House 5 Road 2", pickupArea: "Gulshan", pickupDistrict: "Dhaka North" },
    });
    const bank = await ctx.prisma.merchant.create({
      data: { code: "MR-7002", type: "BANKING_FINANCIAL", name: "Flow Bank", status: "ACTIVE", contactName: "Owner", contactPhone: "+8801911000073", pickupAddress: "House 6 Road 2", pickupArea: "Gulshan", pickupDistrict: "Dhaka North" },
    });
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops Manager");
    const desk = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: gulshan.id }], "Desk Operator");
    const r1 = await riderUser(ctx, "R-7001", gulshan.id);
    const r2 = await riderUser(ctx, "R-7002", gulshan.id);
    await ctx.prisma.rider.updateMany({ data: { status: "ONLINE" } });
    return { gulshan, dhanmondi, shop, bank, ops, desk, r1, r2 };
  };
  type Setup = Awaited<ReturnType<typeof setup>>;
  const book = async (s: Setup, merchantId = s.shop.id) => {
    const res = await ctx.api("POST", "/ops/parcels", { token: s.ops.token, body: { merchantId, ...parcelBody(merchantId === s.bank.id ? { codAmount: 0 } : {}), sender: undefined, pickup: undefined } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.trackingId as string;
  };
  /** Picked up and received at a hub. */
  const atHub = async (s: Setup, hubId = s.gulshan.id, merchantId = s.shop.id) => {
    const id = await book(s, merchantId);
    await ctx.api("POST", `/parcels/${id}/assign-pickup`, { token: s.ops.token, body: { riderId: s.r1.rider.id } });
    await ctx.api("POST", `/parcels/${id}/status`, { token: s.ops.token, body: { status: "PICKED_UP" } });
    expect((await ctx.api("POST", `/parcels/${id}/status`, { token: s.ops.token, body: { status: "AT_HUB", hubId } })).status).toBe(200);
    return id;
  };
  const post = async (token: string, path: string, body: Record<string, unknown>) => {
    const res = await ctx.api("POST", path, { token, body });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    return res.body;
  };
  const parcel = (trackingId: string) => ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId } });

  it("receives & assigns a rider in one scan (in transit to the hub too); another rider's scan moves it", async () => {
    const s = await setup();
    const id = await atHub(s);
    expect(await post(s.desk.token, "/ops/hub-assign", { code: id, hubId: s.gulshan.id, riderId: s.r1.rider.id })).toMatchObject({ ok: true, outcome: "ASSIGNED" });
    expect(await parcel(id)).toMatchObject({ status: "ASSIGNED", deliveryRiderId: s.r1.rider.id });
    expect(await post(s.desk.token, "/ops/hub-assign", { code: id, hubId: s.gulshan.id, riderId: s.r1.rider.id })).toMatchObject({ ok: true, outcome: "ALREADY_ASSIGNED" });
    // Another rider scans it: it moves to them.
    expect(await post(s.desk.token, "/ops/hub-assign", { code: id, hubId: s.gulshan.id, riderId: s.r2.rider.id })).toMatchObject({ ok: true, outcome: "REASSIGNED", message: expect.stringContaining("moved from") });
    expect(await parcel(id)).toMatchObject({ status: "ASSIGNED", deliveryRiderId: s.r2.rider.id });

    // In transit to this hub: received and assigned in the same scan.
    const t2 = await atHub(s, s.dhanmondi.id);
    expect((await ctx.api("POST", `/parcels/${t2}/status`, { token: s.ops.token, body: { status: "IN_TRANSIT", hubId: s.gulshan.id } })).status).toBe(200);
    const r = await post(s.desk.token, "/ops/hub-assign", { code: t2, hubId: s.gulshan.id, riderId: s.r1.rider.id });
    expect(r).toMatchObject({ ok: true, outcome: "ASSIGNED", received: true, message: expect.stringContaining("received and") });
    expect(await parcel(t2)).toMatchObject({ status: "ASSIGNED", currentHubId: s.gulshan.id, deliveryRiderId: s.r1.rider.id });

    // Out for delivery: not moved by a scan.
    await post(s.desk.token, "/hub-desk/dispatch", { code: t2 });
    expect(await post(s.desk.token, "/ops/hub-assign", { code: t2, hubId: s.gulshan.id, riderId: s.r2.rider.id })).toMatchObject({ ok: false, outcome: "OUT_FOR_DELIVERY" });
  });

  it("the rider chooses try again or return to sender; the hub follows the choice or changes it when it scans the parcel back", async () => {
    const s = await setup();
    // The super admin's own fail delivery reasons (order kept, Other last).
    await ctx.prisma.setting.upsert({ where: { key: "platform-config" }, create: { key: "platform-config", value: { failReasons: ["Shop closed", "Other", "Recipient abroad"] } }, update: { value: { failReasons: ["Shop closed", "Other", "Recipient abroad"] } } });
    expect((await ctx.api("GET", "/delivery/fail-reasons", { token: s.r1.token })).body.reasons).toEqual(["Shop closed", "Recipient abroad", "Other"]);

    const id = await atHub(s);
    await post(s.desk.token, "/ops/hub-assign", { code: id, hubId: s.gulshan.id, riderId: s.r1.rider.id });
    await post(s.r1.token, `/rider/parcels/${id}/start-delivery`, {});
    // The rider can't deliver: return to the sender (a reason of the super admin's list). It stays with the rider.
    await post(s.r1.token, `/rider/parcels/${id}/delivery`, { outcome: "FAILED", reason: "Shop closed", nextAction: "RETURN" });
    expect(await parcel(id)).toMatchObject({ status: "RETRY_SCHEDULED", deliveryRiderId: s.r1.rider.id });
    // The hub scans it in (no rider scan): it follows the rider's choice.
    const back = await post(s.desk.token, "/ops/hub-receive", { code: id, hubId: s.gulshan.id });
    expect(back).toMatchObject({ ok: true, outcome: "RECEIVED", message: expect.stringContaining("to return to the sender") });
    let p = await parcel(id);
    expect(p).toMatchObject({ status: "AT_HUB", deliveryRiderId: null, returnReason: "Shop closed" });
    expect(p.returnRequestedAt).not.toBeNull();

    // Another one: the rider says try again, the hub decides to return it.
    const t2 = await atHub(s);
    await post(s.desk.token, "/ops/hub-assign", { code: t2, hubId: s.gulshan.id, riderId: s.r2.rider.id });
    await post(s.r2.token, `/rider/parcels/${t2}/start-delivery`, {});
    await post(s.r2.token, `/rider/parcels/${t2}/delivery`, { outcome: "FAILED", reason: "Recipient abroad", nextAction: "RETRY" });
    await post(s.desk.token, "/ops/hub-receive", { code: t2, hubId: s.gulshan.id, decision: "RETURN" });
    expect((await parcel(t2)).returnRequestedAt).not.toBeNull();

    // A third: the rider says return, the hub delivers it again.
    const t3 = await atHub(s);
    await post(s.desk.token, "/ops/hub-assign", { code: t3, hubId: s.gulshan.id, riderId: s.r1.rider.id });
    await post(s.r1.token, `/rider/parcels/${t3}/start-delivery`, {});
    await post(s.r1.token, `/rider/parcels/${t3}/delivery`, { outcome: "FAILED", reason: "Shop closed", nextAction: "RETURN" });
    expect(await post(s.desk.token, "/hub-desk/receive-back", { code: t3, hubId: s.gulshan.id, decision: "REATTEMPT" })).toMatchObject({ ok: true, decision: "REATTEMPT" });
    p = await parcel(t3);
    expect(p).toMatchObject({ status: "AT_HUB", returnRequestedAt: null });
    // Desk failed delivery accepts the super admin's reasons too.
    await post(s.desk.token, "/ops/hub-assign", { code: t3, hubId: s.gulshan.id, riderId: s.r1.rider.id });
    await post(s.desk.token, "/hub-desk/dispatch", { code: t3 });
    expect(await post(s.desk.token, "/hub-desk/failed", { code: t3, reason: "Recipient abroad", nextAction: "RETRY" })).toMatchObject({ ok: true, outcome: "RETRY_SCHEDULED" });
  });

  it("Parcel queue: filters by merchant type and merchant", async () => {
    const s = await setup();
    await atHub(s, s.gulshan.id, s.shop.id);
    await atHub(s, s.gulshan.id, s.bank.id);
    const total = (query: string) =>
      ctx.api("GET", `/work-queue?${query}`, { token: s.ops.token }).then(r => {
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        return (r.body.tasks as { key: string; count: number }[]).reduce((a, t) => a + t.count, 0);
      });
    const all = await total("");
    expect(all).toBeGreaterThanOrEqual(2);
    const ecom = await total("merchantType=ECOMMERCE");
    const banking = await total("merchantType=BANKING_FINANCIAL");
    expect(ecom).toBeGreaterThanOrEqual(1);
    expect(banking).toBeGreaterThanOrEqual(1);
    expect(ecom + banking).toBe(all);
    expect(await total(`merchantId=${s.bank.id}`)).toBe(banking);
    expect(await total("merchantType=CUSTOMER")).toBe(0);
  });

  it("tags an existing hub as a franchise hub: its riders only on its parcels; it delivers or fails itself with proof; the cash is its own", async () => {
    const s = await setup();
    const admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Admin");
    // The Dhanmondi hub (a company hub) becomes a franchise hub, with a new owner account; R-7003 works there.
    const local = await riderUser(ctx, "R-7003", s.dhanmondi.id);
    const created = await ctx.api("POST", "/franchises", {
      token: admin.token,
      body: { name: "Dhanmondi Point", contactName: "Karim Owner", phone: "01913700001", hubId: s.dhanmondi.id, rates: { pickupPercent: 0, pickupMin: 0, deliveryPercent: 10, deliveryMin: 10, returnPercent: 0, returnMin: 0 } },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.hub).toMatchObject({ id: s.dhanmondi.id, type: "FRANCHISE" });
    expect((await ctx.prisma.hub.findUniqueOrThrow({ where: { id: s.dhanmondi.id } })).type).toBe("FRANCHISE");
    // Not twice.
    expect((await ctx.api("POST", "/franchises", { token: admin.token, body: { name: "Again", contactName: "X", phone: "01913700002", hubId: s.dhanmondi.id } })).body.error.code).toBe("ALREADY_FRANCHISE_HUB");
    // A new hub or an existing one, not both / neither.
    expect((await ctx.api("POST", "/franchises", { token: admin.token, body: { name: "None", contactName: "X", phone: "01913700003" } })).status).toBe(422);

    await ctx.prisma.user.update({ where: { phone: "+8801913700001" }, data: { passwordHash: await hashPassword(PASSWORD) } });
    const token = (await ctx.api("POST", "/auth/login", { body: { identifier: "+8801913700001", password: PASSWORD } })).body.accessToken as string;
    expect((await ctx.api("GET", "/auth/me", { token })).body.panel).toBe("/franchise");

    // Its rider can't take another hub's parcel, even from an operations manager.
    const gulshanParcel = await atHub(s, s.gulshan.id);
    const refused = await ctx.api("POST", `/parcels/${gulshanParcel}/assign-delivery`, { token: s.ops.token, body: { riderId: local.rider.id } });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);

    // A parcel at the franchise hub: receive & assign its own rider by scan; then the franchise delivers it itself.
    const id = await atHub(s, s.gulshan.id);
    expect((await ctx.api("POST", `/parcels/${id}/status`, { token: s.ops.token, body: { status: "IN_TRANSIT", hubId: s.dhanmondi.id } })).status).toBe(200);
    expect(await post(token, "/franchise/assign-scan", { code: id, riderId: local.rider.id })).toMatchObject({ ok: true, outcome: "ASSIGNED" });
    // Not another hub's rider.
    expect((await ctx.api("POST", "/franchise/assign-scan", { token, body: { code: id, riderId: s.r1.rider.id } })).status).toBe(404);
    const cod = Number((await parcel(id)).codAmount);
    // Proof is required; COD must match.
    expect((await ctx.api("POST", `/franchise/parcels/${id}/deliver`, { token, body: { receivedBy: "Nabila", codCollected: cod } })).status).toBe(422);
    expect((await ctx.api("POST", `/franchise/parcels/${id}/deliver`, { token, body: { receivedBy: "Nabila", codCollected: 1, proof: { method: "PHOTO", image: PNG } } })).body.error.code).toBe("COD_MISMATCH");
    const done = await post(token, `/franchise/parcels/${id}/deliver`, { receivedBy: "Nabila", codCollected: cod, proof: { method: "SIGNATURE", image: PNG } });
    expect(done).toMatchObject({ trackingId: id, status: "DELIVERED" });
    expect(await ctx.prisma.deliveryProof.findFirstOrThrow({ where: { parcel: { trackingId: id } } })).toMatchObject({ method: "SIGNATURE", receivedBy: "Nabila" });
    expect(await ctx.prisma.franchiseCommission.count({ where: { type: "DELIVERY" } })).toBe(1);
    // The COD is the franchise's cash to deposit.
    const cash = (await ctx.api("GET", "/franchise/cash", { token })).body;
    expect(cash.codOnHand).toBe(cod);
    expect(cash.depositNow.gross).toBe(cod);

    // A failed delivery recorded by the franchise itself: back to the sender.
    const t2 = await atHub(s, s.gulshan.id);
    expect((await ctx.api("POST", `/parcels/${t2}/status`, { token: s.ops.token, body: { status: "IN_TRANSIT", hubId: s.dhanmondi.id } })).status).toBe(200);
    await post(token, "/franchise/receive", { code: t2 });
    expect(await post(token, `/franchise/parcels/${t2}/fail`, { reason: "Recipient refused", decision: "RETURN" })).toMatchObject({ trackingId: t2 });
    const p2 = await parcel(t2);
    expect(p2).toMatchObject({ status: "AT_HUB", currentHubId: s.dhanmondi.id, returnReason: "Recipient refused", attemptCount: 1 });
    expect(p2.returnRequestedAt).not.toBeNull();
    // Not a parcel of another hub.
    const other = await atHub(s, s.gulshan.id);
    expect((await ctx.api("POST", `/franchise/parcels/${other}/fail`, { token, body: { reason: "Recipient refused" } })).status).toBe(404);
  });

  it("SMS / email messages to a group: count first, one message per person, history; a gateway switched off sends nothing", async () => {
    const s = await setup();
    const admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Admin");
    await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: s.shop.id }], "Shop Owner");
    await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: s.bank.id }], "Bank Owner");
    const preview = await post(admin.token, "/notifications/messages/sms/preview", { audience: "RIDERS" });
    expect(preview).toMatchObject({ matched: 2, recipients: 2, gatewayOn: true });
    expect((await post(admin.token, "/notifications/messages/sms/preview", { audience: "BANKING" })).recipients).toBe(1);
    const sent = await post(admin.token, "/notifications/messages/sms", { audience: "RIDERS", body: "Eid schedule: hubs open 10am." });
    expect(sent).toMatchObject({ recipients: 2, queued: 2 });
    const rows = await ctx.prisma.outboxMessage.findMany({ where: { template: `broadcast:${sent.id}` } });
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.channel === "SMS")).toBe(true);
    const history = (await ctx.api("GET", "/notifications/messages/sms", { token: admin.token })).body.items;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ audience: "RIDERS", recipients: 2, createdBy: "Admin" });
    // Email needs a subject; people without an email are left out.
    expect((await ctx.api("POST", "/notifications/messages/email", { token: admin.token, body: { audience: "ALL", body: "Hello" } })).status).toBe(422);
    // Staff can't send.
    expect((await ctx.api("POST", "/notifications/messages/sms", { token: s.ops.token, body: { audience: "ALL", body: "x" } })).status).toBe(403);

    // The SMS gateway switched off: no messaging, and no SMS notifications are written (codes included).
    expect((await ctx.api("PUT", "/notifications/gateways/sms", { token: admin.token, body: { enabled: false } })).status).toBe(200);
    const off = await ctx.api("POST", "/notifications/messages/sms", { token: admin.token, body: { audience: "RIDERS", body: "Again" } });
    expect(off.body.error.code).toBe("GATEWAY_OFF");
    expect((await post(admin.token, "/notifications/messages/sms/preview", { audience: "RIDERS" })).gatewayOn).toBe(false);
    const before = await ctx.prisma.outboxMessage.count({ where: { channel: "SMS" } });
    await ctx.api("POST", "/auth/otp", { body: { phone: "01712345678", purpose: "SIGNUP" } });
    expect(await ctx.prisma.outboxMessage.count({ where: { channel: "SMS" } })).toBe(before);
  });

  it("the rider's delivery code still works after a hub scan-assign", async () => {
    const s = await setup();
    const id = await atHub(s);
    await post(s.desk.token, "/ops/hub-assign", { code: id, hubId: s.gulshan.id, riderId: s.r1.rider.id });
    await post(s.r1.token, `/rider/parcels/${id}/start-delivery`, {});
    const p = await parcel(id);
    const otp = decrypt(p.deliveryOtpEncrypted!);
    const res = await ctx.api("POST", `/rider/parcels/${id}/delivery`, { token: s.r1.token, body: { outcome: "DELIVERED", receivedBy: "Nabila", proof: { method: "OTP", otp }, codCollected: Number(p.codAmount) } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});
