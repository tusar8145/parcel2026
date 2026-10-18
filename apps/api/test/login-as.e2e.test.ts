import { hub, parcelBody, riderUser, resetDatabase, startApp, userWithRoles, type TestContext } from "./helpers";

/**
 * "Log in as" from Courier Operations (Merchants / Riders): operations managers open a merchant
 * member's or rider's account read-only; super admins read-only or with full access. Built on
 * support access (impersonation sessions), so every rule there applies.
 */
describe("log in as (operations managers and super admins)", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterEach(() => vi.useRealTimers());
  afterAll(() => ctx.app.close());

  const auditOf = (action: string) => ctx.prisma.auditLog.findMany({ where: { action }, orderBy: { id: "asc" } });
  const reason = "Ticket TK-1042: merchant can't see yesterday's pickups";
  async function shop(name = "Shop BD") {
    const merchant = await ctx.prisma.merchant.create({
      data: {
        code: `MR-${Math.floor(Math.random() * 1e6)}`,
        type: "ECOMMERCE",
        name,
        status: "ACTIVE",
        contactName: "Owner",
        contactPhone: "+8801700000000",
        pickupAddress: "Road 1",
        pickupArea: "Banani",
        pickupDistrict: "Dhaka North",
      },
    });
    const staff = await userWithRoles(ctx, [{ role: "MERCHANT_STAFF", merchantId: merchant.id }], "Shop Staff");
    const owner = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: merchant.id }], "Shop Owner");
    return { merchant, owner, staff };
  }
  const opsManager = () => userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Olivia Ops");
  const start = (token: string, body: Record<string, unknown>) => ctx.api("POST", "/admin/impersonations", { token, body: { reason, ...body } });

  it("an ops manager opens a merchant owner (default) and a rider read-only; the account holder is told; audited under the manager", async () => {
    const ops = await opsManager();
    const { merchant, owner, staff } = await shop();

    // The member choice for the merchant: owner first, both can be opened.
    const targets = await ctx.api("GET", `/admin/impersonations/targets?merchantId=${merchant.id}`, { token: ops.token });
    expect(targets.status, JSON.stringify(targets.body)).toBe(200);
    expect(targets.body).toMatchObject({ fullAccess: false, items: [{ userId: owner.user.id, role: "MERCHANT_OWNER", roleLabel: "Owner", panel: "/ecommerce-merchant", allowed: true }, { userId: staff.user.id, allowed: true }] });

    // Read-only is the only option; the notice can't be turned off.
    const started = await start(ops.token, { merchantId: merchant.id, minutes: 15, notifyUser: false });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    expect(started.body).toMatchObject({ expiresIn: 900, impersonation: { readOnly: true, notifiedUser: true, target: { id: owner.user.id, name: "Shop Owner" }, admin: { id: ops.user.id } }, user: { name: "Shop Owner", panel: "/ecommerce-merchant" } });
    const imp = started.body.accessToken as string;
    const me = await ctx.api("GET", "/auth/me", { token: imp });
    expect(me.body).toMatchObject({ name: "Shop Owner", impersonation: { adminName: "Olivia Ops", readOnly: true } });
    expect((await ctx.api("GET", "/parcels", { token: imp })).status).toBe(200);

    // The owner is told (SMS + in-app).
    const sms = await ctx.prisma.outboxMessage.findMany({ where: { userId: owner.user.id, template: "account.support_access" } });
    expect(sms.length).toBeGreaterThanOrEqual(1);
    expect(sms[0].body).toContain("Olivia Ops");
    const inApp = await ctx.prisma.userNotification.findMany({ where: { userId: owner.user.id, type: "account.support_access" } });
    expect(inApp).toHaveLength(1);
    expect(inApp[0].title).toBe("Support is viewing your account");

    // A chosen member of the merchant (staff); someone outside the merchant is refused.
    const asStaff = await start(ops.token, { merchantId: merchant.id, userId: staff.user.id });
    expect(asStaff.status, JSON.stringify(asStaff.body)).toBe(201);
    expect(asStaff.body.impersonation.target.id).toBe(staff.user.id);
    const outsider = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Outsider");
    expect((await start(ops.token, { merchantId: merchant.id, userId: outsider.user.id })).body.error.code).toBe("NOT_A_MEMBER");

    // A rider.
    const h = await hub(ctx);
    const rider = await riderUser(ctx, "R-7001", h.id);
    const riderTargets = await ctx.api("GET", `/admin/impersonations/targets?riderId=${rider.rider.id}`, { token: ops.token });
    expect(riderTargets.body.items).toEqual([expect.objectContaining({ userId: rider.user.id, panel: "/rider", allowed: true })]);
    const asRider = await start(ops.token, { riderId: rider.rider.id, minutes: 5 });
    expect(asRider.status, JSON.stringify(asRider.body)).toBe(201);
    expect(asRider.body).toMatchObject({ expiresIn: 300, impersonation: { readOnly: true }, user: { panel: "/rider" } });
    expect((await ctx.api("GET", "/rider/earnings", { token: asRider.body.accessToken })).status).not.toBe(403);

    // Audit: the start (under the manager, marked as "Log in as") and every request with the impersonation id.
    const startedEntries = await auditOf("impersonation.start");
    expect(startedEntries[0]).toMatchObject({ actorId: ops.user.id, entityId: owner.user.id });
    expect(startedEntries[0].data).toMatchObject({ impersonationId: started.body.impersonation.id, reason, readOnly: true, notifyUser: true, via: "login_as" });
    const requests = (await auditOf("impersonation.request")).filter(a => (a.data as { impersonationId: string }).impersonationId === started.body.impersonation.id);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(requests[0]).toMatchObject({ actorId: ops.user.id, entityId: owner.user.id });

    // The manager can end their own session (and the end is recorded); the super admin history shows it with the manager's role.
    const ended = await ctx.api("POST", `/admin/impersonations/${started.body.impersonation.id}/end`, { token: ops.token });
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);
    expect(ended.body).toMatchObject({ active: false, endedReason: "ended_by_admin" });
    expect((await ctx.api("GET", "/auth/me", { token: imp })).body.error.code).toBe("SESSION_REVOKED");
    expect((await auditOf("impersonation.end"))[0]).toMatchObject({ actorId: ops.user.id, entityId: owner.user.id });
    const admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Alex Admin");
    const history = await ctx.api("GET", "/admin/impersonations", { token: admin.token });
    expect(history.body.items.find((s: { id: string }) => s.id === started.body.impersonation.id)).toMatchObject({
      admin: { name: "Olivia Ops", role: "Operations manager" },
      target: { name: "Shop Owner" },
      readOnly: true,
      active: false,
      endedReason: "ended_by_admin",
    });
    // The history itself stays super-admin only.
    expect((await ctx.api("GET", "/admin/impersonations", { token: ops.token })).status).toBe(403);
  });

  it("an ops manager can't get full access, nor open super admins, staff or customers", async () => {
    const ops = await opsManager();
    const { merchant, owner } = await shop();
    const full = await start(ops.token, { merchantId: merchant.id, readOnly: false });
    expect(full.status).toBe(403);
    expect(full.body.error.code).toBe("IMPERSONATE_FULL_ACCESS");
    expect(await ctx.prisma.impersonationSession.count()).toBe(0);

    const superAdmin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Root Admin");
    expect((await start(ops.token, { userId: superAdmin.user.id })).body.error.code).toBe("IMPERSONATE_SUPER_ADMIN");
    for (const role of ["OPS_MANAGER", "HUB_OPERATOR", "FINANCE", "SUPPORT_AGENT"] as const) {
      const staff = await userWithRoles(ctx, [{ role }], `Staff ${role}`);
      const refused = await start(ops.token, { userId: staff.user.id });
      expect(refused.status, role).toBe(403);
      expect(refused.body.error.code, role).toBe("IMPERSONATE_STAFF");
    }
    // A merchant owner who is also staff somewhere is still staff.
    const hubOp = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: merchant.id }, { role: "HUB_OPERATOR" }], "Owner And Hub");
    expect((await start(ops.token, { userId: hubOp.user.id })).body.error.code).toBe("IMPERSONATE_STAFF");
    const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Nabila");
    expect((await start(ops.token, { userId: customer.user.id })).body.error.code).toBe("IMPERSONATE_NOT_ALLOWED");

    // Super admins: no staff either (customers still allowed, as before); full access stays theirs.
    const admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Alex Admin");
    expect((await start(admin.token, { userId: ops.user.id })).body.error.code).toBe("IMPERSONATE_STAFF");
    expect((await start(admin.token, { userId: customer.user.id })).status).toBe(201);
    const adminFull = await start(admin.token, { merchantId: merchant.id, readOnly: false, notifyUser: false });
    expect(adminFull.status, JSON.stringify(adminFull.body)).toBe(201);
    expect(adminFull.body.impersonation).toMatchObject({ readOnly: false, notifiedUser: false, target: { id: owner.user.id } });

    // Other staff roles have neither permission.
    const hubOperator = await userWithRoles(ctx, [{ role: "HUB_OPERATOR" }], "Hub Op");
    expect((await start(hubOperator.token, { merchantId: merchant.id })).status).toBe(403);
    expect((await ctx.api("GET", `/admin/impersonations/targets?merchantId=${merchant.id}`, { token: hubOperator.token })).status).toBe(403);
    // The targets list says why an account can't be opened.
    await ctx.prisma.userRole.create({ data: { userId: superAdmin.user.id, role: "MERCHANT_STAFF", merchantId: merchant.id } });
    const targets = await ctx.api("GET", `/admin/impersonations/targets?merchantId=${merchant.id}`, { token: ops.token });
    expect(targets.body.items.find((t: { userId: string }) => t.userId === superAdmin.user.id)).toMatchObject({ allowed: false, refusal: expect.stringContaining("Super admin") });
  });

  it("read-only blocks every change server-side with a clear message, never reaches sign-in, rider GPS or another impersonation", async () => {
    const ops = await opsManager();
    const { merchant } = await shop();
    const started = await start(ops.token, { merchantId: merchant.id });
    const imp = started.body.accessToken as string;
    const book = await ctx.api("POST", "/parcels", { token: imp, body: parcelBody() });
    expect(book.status).toBe(403);
    expect(book.body.error).toMatchObject({ code: "IMPERSONATION_READ_ONLY", message: expect.stringContaining("read-only") });
    expect(await ctx.prisma.parcel.count()).toBe(0);
    for (const [method, url] of [
      ["POST", "/auth/password/change"],
      ["POST", "/auth/mfa/setup"],
      ["GET", "/auth/sessions"],
      ["POST", "/admin/impersonations"],
      ["GET", `/admin/impersonations/targets?merchantId=${merchant.id}`],
    ] as const)
      expect((await ctx.api(method, url, { token: imp, body: {} })).status, url).toBe(403);
    const blocked = (await auditOf("impersonation.request")).find(a => (a.data as { path: string }).path === "/api/v1/parcels");
    expect(blocked?.data).toMatchObject({ impersonationId: started.body.impersonation.id, method: "POST", blocked: true });

    // Even full access (super admin) never records the admin's device location as the rider's.
    const h = await hub(ctx);
    const rider = await riderUser(ctx, "R-7002", h.id);
    const admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Alex Admin");
    const asRider = await start(admin.token, { riderId: rider.rider.id, readOnly: false, notifyUser: false });
    expect(asRider.status, JSON.stringify(asRider.body)).toBe(201);
    const gps = await ctx.api("POST", "/rider/location", { token: asRider.body.accessToken, body: { lat: 23.78, lng: 90.41 } });
    expect(gps.status).toBe(403);
  });

  it("expires on its own: the token stops working after the chosen minutes", async () => {
    const ops = await opsManager();
    const { merchant } = await shop();
    const started = await start(ops.token, { merchantId: merchant.id, minutes: 5 });
    const imp = started.body.accessToken as string;
    expect((await ctx.api("GET", "/auth/me", { token: imp })).status).toBe(200);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 5 * 60_000 + 5_000);
    const expired = await ctx.api("GET", "/auth/me", { token: imp });
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe("TOKEN_EXPIRED");
    vi.useRealTimers();
    // Out of range durations are refused.
    expect((await start(ops.token, { merchantId: merchant.id, minutes: 61 })).status).toBe(422);
    expect((await start(ops.token, { merchantId: merchant.id, minutes: 4 })).status).toBe(422);
    expect((await start(ops.token, { merchantId: merchant.id, reason: "short" })).status).toBe(422);
  });
});
