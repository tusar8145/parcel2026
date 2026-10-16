import { hub, nextPhone, PASSWORD, resetDatabase, startApp, userWithRoles, type TestContext } from "./helpers";

const address = (overrides: Record<string, unknown> = {}) => ({
  role: "PICKUP",
  category: "Home",
  contactName: "Rahim Uddin",
  phone: "01711000000",
  street: "House 5 Road 2",
  zone: "Gulshan",
  district: "Dhaka North",
  ...overrides,
});

describe("accounts", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  const merchant = () =>
    ctx.prisma.merchant.create({
      data: {
        code: `MR-${Math.floor(Math.random() * 1e6)}`,
        type: "ECOMMERCE",
        name: "Shop BD",
        status: "ACTIVE",
        contactName: "Owner",
        contactPhone: "+8801700000000",
        pickupAddress: "Road 1",
        pickupArea: "Banani",
        pickupDistrict: "Dhaka North",
      },
    });
  const admin = () => userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Super Admin");

  describe("profile", () => {
    it("updates name and email and returns the /auth/me shape", async () => {
      const u = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Old Name");
      const res = await ctx.api("PATCH", "/me", { token: u.token, body: { name: "  New Name ", email: "New@Example.com" } });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const me = await ctx.api("GET", "/auth/me", { token: u.token });
      expect(res.body).toEqual(me.body);
      expect(res.body).toMatchObject({ name: "New Name", email: "new@example.com", roles: ["CUSTOMER"] });
      expect(await ctx.prisma.auditLog.count({ where: { action: "profile.update", entityId: u.user.id } })).toBe(1);

      const cleared = await ctx.api("PATCH", "/me", { token: u.token, body: { email: null } });
      expect(cleared.body.email).toBeNull();
    });

    it("rejects an email used by another account and invalid input", async () => {
      const a = await userWithRoles(ctx, [{ role: "CUSTOMER" }]);
      const b = await userWithRoles(ctx, [{ role: "CUSTOMER" }]);
      await ctx.prisma.user.update({ where: { id: b.user.id }, data: { email: "taken@example.com" } });
      const res = await ctx.api("PATCH", "/me", { token: a.token, body: { email: "TAKEN@example.com" } });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("EMAIL_IN_USE");
      // Re-saving your own email is fine.
      expect((await ctx.api("PATCH", "/me", { token: b.token, body: { email: "taken@example.com" } })).status).toBe(200);

      const bad = await ctx.api("PATCH", "/me", { token: a.token, body: { name: "x", email: "not-an-email" } });
      expect(bad.status).toBe(422);
      expect(bad.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(["email", "name"]);
    });

    it("requires sign-in", async () => {
      expect((await ctx.api("PATCH", "/me", { body: { name: "Someone" } })).status).toBe(401);
      expect((await ctx.api("GET", "/me/addresses")).status).toBe(401);
    });
  });

  describe("address book", () => {
    it("creates, lists, filters, updates and deletes own addresses", async () => {
      const u = await userWithRoles(ctx, [{ role: "CUSTOMER" }]);
      const created = await ctx.api("POST", "/me/addresses", { token: u.token, body: address({ area: "" }) });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body).toMatchObject({ role: "PICKUP", category: "HOME", phone: "+8801711000000", area: null, isDefault: false });
      await ctx.api("POST", "/me/addresses", { token: u.token, body: address({ role: "RECEIVER", category: "office" }) });

      expect((await ctx.api("GET", "/me/addresses", { token: u.token })).body).toHaveLength(2);
      const receivers = await ctx.api("GET", "/me/addresses?role=RECEIVER", { token: u.token });
      expect(receivers.body).toHaveLength(1);
      expect(receivers.body[0].category).toBe("OFFICE");

      const updated = await ctx.api("PATCH", `/me/addresses/${created.body.id}`, { token: u.token, body: { street: "House 9", area: "Block C" } });
      expect(updated.body).toMatchObject({ street: "House 9", area: "Block C", category: "HOME", contactName: "Rahim Uddin" });
      const clearedArea = await ctx.api("PATCH", `/me/addresses/${created.body.id}`, { token: u.token, body: { area: null } });
      expect(clearedArea.body.area).toBeNull();

      expect((await ctx.api("DELETE", `/me/addresses/${created.body.id}`, { token: u.token })).status).toBe(204);
      expect((await ctx.api("GET", "/me/addresses", { token: u.token })).body).toHaveLength(1);
      const actions = (await ctx.prisma.auditLog.findMany({ where: { entityType: "address" }, orderBy: { id: "asc" } })).map(l => l.action);
      expect(actions).toEqual(["address.create", "address.create", "address.update", "address.update", "address.delete"]);
    });

    it("keeps at most one default per role", async () => {
      const u = await userWithRoles(ctx, [{ role: "CUSTOMER" }]);
      const a = (await ctx.api("POST", "/me/addresses", { token: u.token, body: address({ isDefault: true }) })).body;
      const r = (await ctx.api("POST", "/me/addresses", { token: u.token, body: address({ role: "RECEIVER", isDefault: true }) })).body;
      const b = (await ctx.api("POST", "/me/addresses", { token: u.token, body: address({ street: "Other", isDefault: true }) })).body;
      const defaults = async () => (await ctx.prisma.address.findMany({ where: { userId: u.user.id, isDefault: true } })).map(x => x.id).sort();
      expect(await defaults()).toEqual([r.id, b.id].sort());

      await ctx.api("PATCH", `/me/addresses/${a.id}`, { token: u.token, body: { isDefault: true } });
      expect(await defaults()).toEqual([a.id, r.id].sort());

      // Moving a default address to the other role takes over that role's default.
      await ctx.api("PATCH", `/me/addresses/${a.id}`, { token: u.token, body: { role: "RECEIVER" } });
      expect(await defaults()).toEqual([a.id]);
      const list = await ctx.api("GET", "/me/addresses?role=RECEIVER", { token: u.token });
      expect(list.body[0].id).toBe(a.id); // defaults first
    });

    it("hides other users' addresses", async () => {
      const owner = await userWithRoles(ctx, [{ role: "CUSTOMER" }]);
      const other = await userWithRoles(ctx, [{ role: "CUSTOMER" }]);
      const a = (await ctx.api("POST", "/me/addresses", { token: owner.token, body: address() })).body;
      expect((await ctx.api("GET", "/me/addresses", { token: other.token })).body).toEqual([]);
      const patch = await ctx.api("PATCH", `/me/addresses/${a.id}`, { token: other.token, body: { street: "Hijack" } });
      expect(patch.status).toBe(404);
      expect((await ctx.api("DELETE", `/me/addresses/${a.id}`, { token: other.token })).status).toBe(404);
      expect((await ctx.api("DELETE", "/me/addresses/not-a-uuid", { token: owner.token })).status).toBe(400);
    });

    it("validates input and enforces the 50-address limit", async () => {
      const u = await userWithRoles(ctx, [{ role: "CUSTOMER" }]);
      const bad = await ctx.api("POST", "/me/addresses", { token: u.token, body: address({ phone: "12345", role: "SENDER", zone: "" }) });
      expect(bad.status).toBe(422);
      expect(bad.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(["phone", "role", "zone"]);
      const empty = await ctx.api("POST", "/me/addresses", { token: u.token, body: address() });
      expect((await ctx.api("PATCH", `/me/addresses/${empty.body.id}`, { token: u.token, body: {} })).status).toBe(422);

      await ctx.prisma.address.createMany({
        data: Array.from({ length: 49 }, (_, i) => ({ userId: u.user.id, role: "RECEIVER" as const, contactName: "X", phone: "+8801711000000", street: `S${i}`, zone: "Z", district: "D" })),
      });
      const over = await ctx.api("POST", "/me/addresses", { token: u.token, body: address() });
      expect(over.status).toBe(422);
      expect(over.body.error.code).toBe("ADDRESS_LIMIT");
    });
  });

  describe("user administration", () => {
    it("lists users with filters and cursor pagination", async () => {
      const a = await admin();
      const h = await hub(ctx);
      await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: h.id }], "Karim Hub");
      const sus = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Suspended Sumon");
      await ctx.prisma.user.update({ where: { id: sus.user.id }, data: { status: "SUSPENDED" } });

      const all = await ctx.api("GET", "/users?limit=2", { token: a.token });
      expect(all.status).toBe(200);
      expect(all.body.items).toHaveLength(2);
      expect(all.body.items[0].name).toBe("Suspended Sumon"); // newest first
      const next = await ctx.api("GET", `/users?limit=2&cursor=${all.body.nextCursor}`, { token: a.token });
      expect(next.body.items.map((u: { name: string }) => u.name)).toEqual(["Super Admin"]);
      expect(next.body.nextCursor).toBeNull();

      const hubOps = await ctx.api("GET", "/users?role=HUB_OPERATOR", { token: a.token });
      expect(hubOps.body.items).toHaveLength(1);
      expect(hubOps.body.items[0]).toMatchObject({ name: "Karim Hub", status: "ACTIVE", roles: [{ role: "HUB_OPERATOR", hub: { id: h.id, name: h.name }, merchant: null }] });
      expect(hubOps.body.items[0]).not.toHaveProperty("passwordHash");
      expect(hubOps.body.items[0].lastLoginAt).toBeTruthy();

      expect((await ctx.api("GET", "/users?q=karim", { token: a.token })).body.items).toHaveLength(1);
      expect((await ctx.api("GET", `/users?q=${encodeURIComponent(sus.phone.slice(-6))}`, { token: a.token })).body.items[0].id).toBe(sus.user.id);
      expect((await ctx.api("GET", "/users?status=SUSPENDED", { token: a.token })).body.items).toHaveLength(1);
      expect((await ctx.api("GET", "/users?status=GONE", { token: a.token })).status).toBe(422);
    });

    it("shows a user's detail with sessions and rider profile", async () => {
      const a = await admin();
      const support = await userWithRoles(ctx, [{ role: "SUPPORT_AGENT" }], "Support");
      const r = await userWithRoles(ctx, [{ role: "RIDER" }], "Rider One");
      await ctx.prisma.rider.create({ data: { userId: r.user.id, code: "R-2048" } });
      const res = await ctx.api("GET", `/users/${r.user.id}`, { token: support.token }); // user:read is enough
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: r.user.id, activeSessions: 1, rider: { code: "R-2048" } });
      expect((await ctx.api("GET", `/users/${a.user.id}`, { token: a.token })).body.rider).toBeNull();
      expect((await ctx.api("GET", "/users/0190a1b2-0000-7000-8000-000000000000", { token: a.token })).status).toBe(404);
    });

    it("enforces permissions", async () => {
      const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }]);
      const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }]);
      expect((await ctx.api("GET", "/users", { token: customer.token })).status).toBe(403);
      expect((await ctx.api("GET", "/users", { token: ops.token })).status).toBe(200);
      // user:read but not user:manage
      const body = { name: "New Staff", phone: nextPhone(), roles: [{ role: "FINANCE" }] };
      expect((await ctx.api("POST", "/users", { token: ops.token, body })).status).toBe(403);
      expect((await ctx.api("PATCH", `/users/${customer.user.id}`, { token: ops.token, body: { status: "SUSPENDED" } })).status).toBe(403);
      expect((await ctx.api("POST", `/users/${customer.user.id}/roles`, { token: ops.token, body: { role: "FINANCE" } })).status).toBe(403);
      expect((await ctx.api("GET", "/audit-logs", { token: customer.token })).status).toBe(403);
      expect((await ctx.api("GET", "/users")).status).toBe(401);
    });

    it("creates staff and partner users who can sign in", async () => {
      const a = await admin();
      const h = await hub(ctx);
      const m = await merchant();
      const phone = nextPhone();
      const res = await ctx.api("POST", "/users", {
        token: a.token,
        body: {
          name: "Nadia Staff",
          phone,
          email: "Nadia@Example.com",
          password: "StrongPass123",
          roles: [{ role: "HUB_OPERATOR", hubId: h.id }, { role: "MERCHANT_STAFF", merchantId: m.id }, { role: "FINANCE" }],
        },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({ name: "Nadia Staff", phone, email: "nadia@example.com", status: "ACTIVE", activeSessions: 0 });
      expect(res.body.roles.map((r: { role: string }) => r.role).sort()).toEqual(["FINANCE", "HUB_OPERATOR", "MERCHANT_STAFF"]);
      expect(res.body.roles.find((r: { role: string }) => r.role === "MERCHANT_STAFF").merchant).toEqual({ id: m.id, name: "Shop BD" });

      const login = await ctx.api("POST", "/auth/login", { body: { identifier: phone, password: "StrongPass123" } });
      expect(login.status).toBe(200);
      const log = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: "user.create" } });
      expect(log).toMatchObject({ actorId: a.user.id, entityId: res.body.id });
      expect(JSON.stringify(log.data)).not.toContain("StrongPass123");

      const dup = await ctx.api("POST", "/users", { token: a.token, body: { name: "Dup", phone, roles: [{ role: "FINANCE" }] } });
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe("PHONE_IN_USE");
      const dupEmail = await ctx.api("POST", "/users", { token: a.token, body: { name: "Dup", phone: nextPhone(), email: "nadia@example.com", roles: [{ role: "FINANCE" }] } });
      expect(dupEmail.body.error.code).toBe("EMAIL_IN_USE");
    });

    it("validates role scopes on create", async () => {
      const a = await admin();
      const h = await hub(ctx);
      const create = (roles: unknown[], extra: Record<string, unknown> = {}) =>
        ctx.api("POST", "/users", { token: a.token, body: { name: "Someone", phone: nextPhone(), roles, ...extra } });
      const code = async (roles: unknown[]) => (await create(roles)).body.error?.code;

      expect(await code([{ role: "RIDER" }])).toBe("USE_RIDERS_ENDPOINT");
      expect(await code([{ role: "MERCHANT_OWNER" }])).toBe("SCOPE_REQUIRED");
      expect(await code([{ role: "HUB_OPERATOR" }])).toBe("SCOPE_REQUIRED");
      expect(await code([{ role: "FINANCE", hubId: h.id }])).toBe("SCOPE_NOT_ALLOWED");
      expect(await code([{ role: "HUB_OPERATOR", hubId: h.id, merchantId: h.id }])).toBe("SCOPE_NOT_ALLOWED");
      expect(await code([{ role: "MERCHANT_OWNER", merchantId: "0190a1b2-0000-7000-8000-000000000000" }])).toBe("MERCHANT_NOT_FOUND");
      expect(await code([{ role: "HUB_OPERATOR", hubId: "0190a1b2-0000-7000-8000-000000000000" }])).toBe("HUB_NOT_FOUND");
      expect(await code([])).toBe("VALIDATION_FAILED");
      expect(await code([{ role: "FINANCE" }, { role: "FINANCE" }])).toBe("VALIDATION_FAILED");
      expect(await code([{ role: "WIZARD" }])).toBe("VALIDATION_FAILED");
      const weak = await create([{ role: "FINANCE" }], { password: "short", phone: "999" });
      expect(weak.status).toBe(422);
      expect([...new Set(weak.body.error.details.map((d: { path: string }) => d.path))].sort()).toEqual(["password", "phone"]);
      expect(await ctx.prisma.user.count()).toBe(1);

      // A super admin may grant super admin.
      expect((await create([{ role: "SUPER_ADMIN" }])).status).toBe(201);
    });

    it("updates users; suspension signs them out immediately", async () => {
      const a = await admin();
      const target = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Target");
      expect((await ctx.api("GET", "/auth/me", { token: target.token })).status).toBe(200);

      const renamed = await ctx.api("PATCH", `/users/${target.user.id}`, { token: a.token, body: { name: "Renamed", email: "t@example.com" } });
      expect(renamed.body).toMatchObject({ name: "Renamed", email: "t@example.com", activeSessions: 1 });

      const suspended = await ctx.api("PATCH", `/users/${target.user.id}`, { token: a.token, body: { status: "SUSPENDED" } });
      expect(suspended.body).toMatchObject({ status: "SUSPENDED", activeSessions: 0 });
      expect((await ctx.api("GET", "/auth/me", { token: target.token })).status).toBe(401);
      expect((await ctx.api("POST", "/auth/refresh", { body: { refreshToken: target.refreshToken } })).status).toBe(401);
      expect((await ctx.api("POST", "/auth/login", { body: { identifier: target.phone, password: PASSWORD } })).status).toBe(401);
      expect(await ctx.prisma.auditLog.count({ where: { action: "user.status_change", entityId: target.user.id } })).toBe(1);

      const reactivated = await ctx.api("PATCH", `/users/${target.user.id}`, { token: a.token, body: { status: "ACTIVE" } });
      expect(reactivated.body.status).toBe("ACTIVE");
      expect((await ctx.api("POST", "/auth/login", { body: { identifier: target.phone, password: PASSWORD } })).status).toBe(200);
    });

    it("rejects self-suspension, duplicate emails and empty updates", async () => {
      const a = await admin();
      const self = await ctx.api("PATCH", `/users/${a.user.id}`, { token: a.token, body: { status: "DEACTIVATED" } });
      expect(self.status).toBe(422);
      expect(self.body.error.code).toBe("CANNOT_SUSPEND_SELF");
      expect((await ctx.api("PATCH", `/users/${a.user.id}`, { token: a.token, body: { name: "Still Me" } })).status).toBe(200);

      const other = await userWithRoles(ctx, [{ role: "CUSTOMER" }]);
      await ctx.prisma.user.update({ where: { id: a.user.id }, data: { email: "admin@example.com" } });
      const dup = await ctx.api("PATCH", `/users/${other.user.id}`, { token: a.token, body: { email: "admin@example.com" } });
      expect(dup.body.error.code).toBe("EMAIL_IN_USE");
      expect((await ctx.api("PATCH", `/users/${other.user.id}`, { token: a.token, body: {} })).status).toBe(422);
      expect((await ctx.api("PATCH", "/users/0190a1b2-0000-7000-8000-000000000000", { token: a.token, body: { name: "Ghost" } })).status).toBe(404);
    });

    it("adds and removes roles; removal signs the user out", async () => {
      const a = await admin();
      const h = await hub(ctx);
      const u = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Promoted");

      const added = await ctx.api("POST", `/users/${u.user.id}/roles`, { token: a.token, body: { role: "HUB_OPERATOR", hubId: h.id } });
      expect(added.status, JSON.stringify(added.body)).toBe(201);
      const grant = added.body.roles.find((r: { role: string }) => r.role === "HUB_OPERATOR");
      expect(grant.hub.id).toBe(h.id);

      const dup = await ctx.api("POST", `/users/${u.user.id}/roles`, { token: a.token, body: { role: "HUB_OPERATOR", hubId: h.id } });
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe("ROLE_EXISTS");
      expect((await ctx.api("POST", `/users/${u.user.id}/roles`, { token: a.token, body: { role: "CUSTOMER" } })).body.error.code).toBe("ROLE_EXISTS");
      expect((await ctx.api("POST", `/users/${u.user.id}/roles`, { token: a.token, body: { role: "RIDER" } })).body.error.code).toBe("USE_RIDERS_ENDPOINT");
      expect((await ctx.api("POST", `/users/${u.user.id}/roles`, { token: a.token, body: { role: "HUB_OPERATOR" } })).body.error.code).toBe("SCOPE_REQUIRED");
      expect((await ctx.api("POST", "/users/0190a1b2-0000-7000-8000-000000000000/roles", { token: a.token, body: { role: "FINANCE" } })).status).toBe(404);

      // A new grant applies at once: the old access token must refresh, the new one carries the role.
      expect((await ctx.api("GET", "/auth/me", { token: u.token })).body.error.code).toBe("TOKEN_EXPIRED");
      const refreshed = await ctx.api("POST", "/auth/refresh", { body: { refreshToken: u.refreshToken } });
      expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
      expect(refreshed.body.user.roles).toContain("HUB_OPERATOR");
      const token = refreshed.body.accessToken as string;
      expect((await ctx.api("GET", "/auth/me", { token })).status).toBe(200);
      const removed = await ctx.api("DELETE", `/users/${u.user.id}/roles/${grant.id}`, { token: a.token });
      expect(removed.status).toBe(200);
      expect(removed.body.roles.map((r: { role: string }) => r.role)).toEqual(["CUSTOMER"]);
      expect((await ctx.api("GET", "/auth/me", { token })).status).toBe(401);

      // A role id belonging to someone else isn't found under this user.
      const adminRole = await ctx.prisma.userRole.findFirstOrThrow({ where: { userId: a.user.id } });
      expect((await ctx.api("DELETE", `/users/${u.user.id}/roles/${adminRole.id}`, { token: a.token })).status).toBe(404);

      const actions = (await ctx.prisma.auditLog.findMany({ where: { entityId: u.user.id }, orderBy: { id: "asc" } })).map(l => l.action);
      expect(actions).toEqual(expect.arrayContaining(["user.role_add", "user.role_remove"]));
    });

    it("protects super admin roles", async () => {
      const a = await admin();
      const ownRole = await ctx.prisma.userRole.findFirstOrThrow({ where: { userId: a.user.id, role: "SUPER_ADMIN" } });
      const own = await ctx.api("DELETE", `/users/${a.user.id}/roles/${ownRole.id}`, { token: a.token });
      expect(own.status).toBe(422);
      expect(own.body.error.code).toBe("CANNOT_REMOVE_OWN_SUPER_ADMIN");

      const b = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Second Admin");
      const bRole = await ctx.prisma.userRole.findFirstOrThrow({ where: { userId: b.user.id, role: "SUPER_ADMIN" } });
      // With the acting admin's account no longer active, b would be the last active super admin.
      await ctx.prisma.user.update({ where: { id: a.user.id }, data: { status: "SUSPENDED" } });
      const last = await ctx.api("DELETE", `/users/${b.user.id}/roles/${bRole.id}`, { token: a.token });
      expect(last.status).toBe(422);
      expect(last.body.error.code).toBe("LAST_SUPER_ADMIN");
      const lastSuspend = await ctx.api("PATCH", `/users/${b.user.id}`, { token: a.token, body: { status: "SUSPENDED" } });
      expect(lastSuspend.body.error.code).toBe("LAST_SUPER_ADMIN");

      await ctx.prisma.user.update({ where: { id: a.user.id }, data: { status: "ACTIVE" } });
      const ok = await ctx.api("DELETE", `/users/${b.user.id}/roles/${bRole.id}`, { token: a.token });
      expect(ok.status).toBe(200);
      expect(ok.body.roles).toEqual([]);
    });
  });

  describe("audit log", () => {
    it("filters by actor, entity, action prefix and time, newest first", async () => {
      const a = await admin();
      const finance = await userWithRoles(ctx, [{ role: "FINANCE" }], "Finance");
      const u = await userWithRoles(ctx, [{ role: "CUSTOMER" }]);
      await ctx.api("PATCH", `/users/${u.user.id}`, { token: a.token, body: { name: "First" } });
      await ctx.api("PATCH", `/users/${u.user.id}`, { token: a.token, body: { name: "Second" } });
      await ctx.api("POST", "/me/addresses", { token: u.token, body: address() });

      const res = await ctx.api("GET", `/audit-logs?actorId=${a.user.id}&action=user.`, { token: finance.token }); // FINANCE has audit:read
      expect(res.status).toBe(200);
      expect(res.body.items.map((l: { data: { name: string } }) => l.data.name)).toEqual(["Second", "First"]);
      expect(res.body.items[0]).toMatchObject({ actorType: "USER", actorLabel: "Super Admin", entityType: "user", entityId: u.user.id });

      const byEntity = await ctx.api("GET", `/audit-logs?entityType=user&entityId=${u.user.id}&limit=1`, { token: a.token });
      expect(byEntity.body.items).toHaveLength(1);
      expect(byEntity.body.nextCursor).toBeTruthy();
      const page2 = await ctx.api("GET", `/audit-logs?entityType=user&entityId=${u.user.id}&limit=1&cursor=${byEntity.body.nextCursor}`, { token: a.token });
      expect(page2.body.items[0].id).not.toBe(byEntity.body.items[0].id);

      expect((await ctx.api("GET", "/audit-logs?action=address.", { token: a.token })).body.items).toHaveLength(1);
      expect((await ctx.api("GET", "/audit-logs?action=auth.login", { token: a.token })).body.items).toHaveLength(3);
      const future = new Date(Date.now() + 3_600_000).toISOString();
      expect((await ctx.api("GET", `/audit-logs?from=${future}`, { token: a.token })).body.items).toHaveLength(0);
      expect((await ctx.api("GET", `/audit-logs?to=${future}&action=user.`, { token: a.token })).body.items).toHaveLength(2);
      const bad = await ctx.api("GET", `/audit-logs?from=${future}&to=2020-01-01`, { token: a.token });
      expect(bad.status).toBe(422);
      expect((await ctx.api("GET", "/audit-logs?from=yesterday", { token: a.token })).status).toBe(422);
    });
  });
});
