import { generateKeyPairSync } from "node:crypto";
import { vi } from "vitest";
import { hub, parcelBody, resetDatabase, riderUser, startApp, userWithRoles, type TestContext } from "./helpers";

/**
 * Push notifications: phones register their Firebase token, in-app notifications go out as pushes (riders'
 * new work; merchants only with "Firebase push notifications" in their service plan), and super admin sets up
 * Firebase and sends messages to all / chosen users with a history. Google's servers are stubbed.
 */
describe("push notifications", () => {
  let ctx: TestContext;
  let seq = 0;
  const pushes: { token: string; notification: { title: string; body?: string }; data: Record<string, string> }[] = [];
  const realFetch = globalThis.fetch;

  const serviceAccount = () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    return JSON.stringify({ type: "service_account", project_id: "df-test", client_email: "push@df-test.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });
  };

  beforeAll(async () => {
    ctx = await startApp();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "test-access", expires_in: 3600 }), { status: 200 });
      if (url.startsWith("https://fcm.googleapis.com/")) {
        const message = JSON.parse(String(init?.body)).message;
        if (message.token.startsWith("gone-"))
          return new Response(JSON.stringify({ error: { status: "NOT_FOUND", message: "Requested entity was not found.", details: [{ errorCode: "UNREGISTERED" }] } }), { status: 404 });
        pushes.push(message);
        return new Response(JSON.stringify({ name: "projects/df-test/messages/1" }), { status: 200 });
      }
      return realFetch(input, init);
    });
  });
  beforeEach(async () => {
    await resetDatabase(ctx);
    pushes.length = 0;
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await ctx.app.close();
  });

  /** Pushes are sent after the notification rows are committed (announce: 150 ms, then 1 s…). */
  const settle = (ms = 1500) => new Promise(r => setTimeout(r, ms));
  const token = (name: string) => `${name}-${"x".repeat(40)}`;

  async function setUp() {
    const admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Admin");
    const saved = await ctx.api("PUT", "/notifications/push", { token: admin.token, body: { enabled: true, serviceAccount: serviceAccount() } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ configured: true, enabled: true, active: true, source: "settings", projectId: "df-test" });
    return admin;
  }

  async function merchant() {
    const h = await hub(ctx, `HUB-PS${++seq}`);
    const m = await ctx.prisma.merchant.create({
      data: { code: `MR-PS${seq}`, type: "ECOMMERCE", name: `Push Shop ${seq}`, status: "ACTIVE", kycStatus: "APPROVED", contactName: "Owner", contactPhone: "+8801711111111", pickupAddress: "House 5 Road 2", pickupArea: "Gulshan", pickupDistrict: "Dhaka North", pickupHubId: h.id },
    });
    const owner = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: m.id }], "Shop Owner");
    return { m, owner, h };
  }

  it("super admin sets up Firebase: a file that isn't a service account is refused; the key is never returned", async () => {
    const admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Admin");
    const bad = await ctx.api("PUT", "/notifications/push", { token: admin.token, body: { enabled: true, serviceAccount: '{"type":"user"}' } });
    expect(bad.status).toBe(422);
    expect((await ctx.api("PUT", "/notifications/push", { token: admin.token, body: { enabled: true } })).body.error.code).toBe("GATEWAY_NOT_CONFIGURED");
    await setUp();
    const status = await ctx.api("GET", "/notifications/push", { token: admin.token });
    expect(JSON.stringify(status.body)).not.toContain("PRIVATE KEY");
    const row = await ctx.prisma.pushGateway.findUniqueOrThrow({ where: { id: "fcm" } });
    expect(row.privateKeyEncrypted).not.toContain("PRIVATE KEY");
    // Only super admin.
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops");
    expect((await ctx.api("GET", "/notifications/push", { token: ops.token })).status).toBe(403);
  });

  it("a rider's phone gets a push for a new pickup; a token Firebase no longer knows is removed", async () => {
    await setUp();
    const { owner, h } = await merchant();
    const rider = await riderUser(ctx, "R-PS01", h.id);
    expect((await ctx.api("POST", "/me/push-devices", { token: rider.token, body: { token: token("rider"), app: "rider" } })).status).toBe(200);
    expect((await ctx.api("POST", "/me/push-devices", { token: rider.token, body: { token: token("gone"), app: "rider" } })).status).toBe(200);
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops");
    const booked = await ctx.api("POST", "/parcels", { token: owner.token, body: parcelBody({ codAmount: 0 }) });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    const assigned = await ctx.api("POST", `/parcels/${booked.body.trackingId}/assign-pickup`, { token: ops.token, body: { riderId: rider.rider.id } });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    await settle();
    const push = pushes.find(p => p.token === token("rider"));
    expect(push?.notification.title).toBe(`New pickup: ${booked.body.trackingId}`);
    expect(push?.data).toMatchObject({ type: "rider.pickup_assigned", link: "/rider?page=Pickup%20queue" });
    expect(await ctx.prisma.pushDevice.count({ where: { token: token("gone") } })).toBe(0);
    // Signing out on the phone stops the pushes.
    expect((await ctx.api("POST", "/me/push-devices/remove", { token: rider.token, body: { token: token("rider") } })).body).toEqual({ removed: 1 });
  });

  it("an operations phone gets a push for new work (a merchant's new order)", async () => {
    await setUp();
    const { owner } = await merchant();
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops");
    expect((await ctx.api("POST", "/me/push-devices", { token: ops.token, body: { token: token("ops"), app: "operations" } })).status).toBe(200);
    const booked = await ctx.api("POST", "/parcels", { token: owner.token, body: parcelBody({ codAmount: 0 }) });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    await settle();
    const push = pushes.find(p => p.token === token("ops"));
    expect(push?.notification.title).toContain("New order");
    expect(push?.data.type).toBe("staff.merchant_order");
  });

  it("merchants get pushes only when their service plan has Firebase push notifications", async () => {
    const admin = await setUp();
    const { m, owner } = await merchant();
    await ctx.api("POST", "/me/push-devices", { token: owner.token, body: { token: token("shop"), app: "merchant" } });
    const catalog = (await ctx.api("GET", "/service-catalog")).body as { services: { code: string; segments: string[] }[] };
    expect(catalog.services.some(s => s.code === "integration.push")).toBe(true);
    const services = (without: string[]) => catalog.services.filter(s => s.segments.includes("ECOMMERCE") && !without.includes(s.code)).map(s => s.code);
    const create = async (name: string, list: string[]) => (await ctx.api("POST", "/packages", { token: admin.token, body: { segment: "ECOMMERCE", name, services: list, prices: {} } })).body.id as string;
    const assign = async (packageId: string) => expect((await ctx.api("PUT", `/merchants/${m.id}/package`, { token: admin.token, body: { packageId } })).status).toBe(200);
    const cancelOne = async () => {
      const booked = await ctx.api("POST", "/parcels", { token: owner.token, body: parcelBody({ codAmount: 0 }) });
      expect(booked.status, JSON.stringify(booked.body)).toBe(201);
      expect((await ctx.api("POST", `/parcels/${booked.body.trackingId}/cancel`, { token: owner.token, body: {} })).status).toBe(200);
      await settle();
    };

    await assign(await create("No push", services(["integration.push"])));
    await cancelOne();
    expect(await ctx.prisma.userNotification.count({ where: { userId: owner.user.id, type: "parcel.cancelled" } })).toBe(1);
    expect(pushes.filter(p => p.token === token("shop"))).toHaveLength(0);

    await assign(await create("With push", services([])));
    await cancelOne();
    expect(pushes.filter(p => p.token === token("shop"))).toHaveLength(1);
  });

  it("super admin messages all riders or chosen people: in their notifications, pushed, and kept as history", async () => {
    const admin = await setUp();
    const { owner, h } = await merchant();
    const r1 = await riderUser(ctx, "R-PS11", h.id);
    const r2 = await riderUser(ctx, "R-PS12", h.id);
    await ctx.api("POST", "/me/push-devices", { token: r1.token, body: { token: token("r1"), app: "rider" } });

    const found = await ctx.api("GET", "/notifications/push/recipients?q=R-PS11", { token: admin.token });
    expect(found.body.items).toEqual([expect.objectContaining({ id: r1.user.id, kind: "RIDER", detail: "Rider R-PS11", devices: 1 })]);

    const toRiders = await ctx.api("POST", "/notifications/push/broadcasts", { token: admin.token, body: { title: "Eid schedule", body: "Hubs close at 2 pm on Eid day.", audience: "RIDERS" } });
    expect(toRiders.status, JSON.stringify(toRiders.body)).toBe(200);
    expect(toRiders.body).toMatchObject({ audience: "RIDERS", recipients: 2 });
    await settle(600);
    expect(pushes.filter(p => p.notification.title === "Eid schedule").map(p => p.token)).toEqual([token("r1")]);
    expect(await ctx.prisma.userNotification.count({ where: { type: "broadcast", userId: { in: [r1.user.id, r2.user.id] } } })).toBe(2);
    expect(await ctx.prisma.userNotification.count({ where: { type: "broadcast", userId: owner.user.id } })).toBe(0);

    const chosen = await ctx.api("POST", "/notifications/push/broadcasts", { token: admin.token, body: { title: "Your account", body: "Please update your bank details.", audience: "USERS", userIds: [owner.user.id] } });
    expect(chosen.body).toMatchObject({ audience: "USERS", recipients: 1, chosen: 1 });
    expect((await ctx.api("POST", "/notifications/push/broadcasts", { token: admin.token, body: { title: "Empty", body: "x", audience: "USERS", userIds: [] } })).status).toBe(422);
    await settle(600);

    const history = await ctx.api("GET", "/notifications/push/broadcasts", { token: admin.token });
    expect(history.body.items.map((h: { title: string }) => h.title)).toEqual(["Your account", "Eid schedule"]);
    expect(history.body.items[1]).toMatchObject({ recipients: 2, devices: 1, delivered: 1, failed: 0, sending: false, createdBy: "Admin" });
    // A test push to someone without the app is refused with a clear reason.
    expect((await ctx.api("POST", "/notifications/push/test", { token: admin.token, body: { userId: r2.user.id } })).body.error.code).toBe("NO_DEVICES");
    expect((await ctx.api("POST", "/notifications/push/test", { token: admin.token, body: { userId: r1.user.id } })).body).toMatchObject({ devices: 1, delivered: 1 });
  });
});
