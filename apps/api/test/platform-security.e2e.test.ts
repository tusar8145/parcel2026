import { authenticator } from "otplib";
import { hashPassword } from "../src/common/crypto";
import { nextPhone, parcelBody, PASSWORD, resetDatabase, startApp, userWithRoles, type TestContext } from "./helpers";

/** Platform administration and security: MFA, roles, maker-checker, support access, document pricing, analytics. */
describe("platform security (super admin)", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  const admin = (name = "Super Admin") => userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], name);
  const auditOf = (action: string) => ctx.prisma.auditLog.findMany({ where: { action }, orderBy: { id: "asc" } });
  /** A current code that the replay protection accepts (tests sign in several times within one 30 s step). */
  async function freshCode(userId: string, secret: string) {
    await ctx.prisma.userMfa.update({ where: { userId }, data: { lastUsedStep: null } });
    return authenticator.generate(secret);
  }
  async function rawUser(roles: { role: "SUPER_ADMIN" | "CUSTOMER" | "FINANCE" | "SUPPORT_AGENT" }[], name = "Plain User") {
    const phone = nextPhone();
    const user = await ctx.prisma.user.create({ data: { name, phone, passwordHash: await hashPassword(PASSWORD), phoneVerifiedAt: new Date(), roles: { create: roles } } });
    return { user, phone };
  }
  const login = (identifier: string) => ctx.api("POST", "/auth/login", { body: { identifier, password: PASSWORD } });

  // ───────────── MFA ─────────────

  describe("two-step verification", () => {
    it("is mandatory for super admins: enrolment at first sign-in, then a code at every sign-in", async () => {
      const { user, phone } = await rawUser([{ role: "SUPER_ADMIN" }], "New Admin");
      const first = await login(phone);
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ mfaSetupRequired: true, mfaToken: expect.any(String) });
      expect(first.body).not.toHaveProperty("accessToken");
      expect(first.headers["set-cookie"]).toBeUndefined();

      const setup = await ctx.api("POST", "/auth/mfa/setup", { body: { mfaToken: first.body.mfaToken } });
      expect(setup.status).toBe(200);
      expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\/Paira%20Express:/);
      expect(setup.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
      const secret = setup.body.secret as string;

      const wrong = await ctx.api("POST", "/auth/mfa/enable", { body: { mfaToken: first.body.mfaToken, code: "000000" } });
      expect(wrong.status).toBe(400);
      expect(wrong.body.error.code).toBe("INVALID_MFA_CODE");

      const enabled = await ctx.api("POST", "/auth/mfa/enable", { body: { mfaToken: first.body.mfaToken, code: authenticator.generate(secret) } });
      expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
      expect(enabled.body.recoveryCodes).toHaveLength(10);
      expect(enabled.body.accessToken).toEqual(expect.any(String));
      expect(enabled.body.user.mfa).toEqual({ enabled: true, required: true });
      const stored = await ctx.prisma.userMfa.findUniqueOrThrow({ where: { userId: user.id } });
      expect(stored.secretEncrypted).not.toContain(secret); // encrypted at rest
      const codes = await ctx.prisma.mfaRecoveryCode.findMany({ where: { userId: user.id } });
      expect(codes.every(c => !enabled.body.recoveryCodes.includes(c.codeHash))).toBe(true); // hashed

      // The challenge token was used up.
      expect((await ctx.api("POST", "/auth/mfa/enable", { body: { mfaToken: first.body.mfaToken, code: "123456" } })).body.error.code).toBe("MFA_TOKEN_INVALID");

      // Next sign-in: a challenge, not a session.
      const second = await login(phone);
      expect(second.body).toMatchObject({ mfaRequired: true, methods: ["totp", "recovery"] });
      // The code already used can't be replayed in the same time step.
      const replay = await ctx.api("POST", "/auth/login/mfa", { body: { mfaToken: second.body.mfaToken, code: authenticator.generate(secret) } });
      expect(replay.status).toBe(400);
      const ok = await ctx.api("POST", "/auth/login/mfa", { body: { mfaToken: second.body.mfaToken, code: await freshCode(user.id, secret) } });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.user.roles).toContain("SUPER_ADMIN");
      expect((await ctx.api("GET", "/auth/mfa", { token: ok.body.accessToken })).body).toMatchObject({ enabled: true, required: true, recoveryCodesRemaining: 10 });

      // A role that requires MFA can't turn it off.
      const off = await ctx.api("POST", "/auth/mfa/disable", { token: ok.body.accessToken, body: { code: await freshCode(user.id, secret) } });
      expect(off.status).toBe(422);
      expect(off.body.error.code).toBe("MFA_REQUIRED_FOR_ROLE");

      // Recovery codes work once.
      const recovery = enabled.body.recoveryCodes[0] as string;
      const third = await login(phone);
      expect((await ctx.api("POST", "/auth/login/mfa", { body: { mfaToken: third.body.mfaToken, code: recovery.toLowerCase() } })).status).toBe(200);
      const fourth = await login(phone);
      expect((await ctx.api("POST", "/auth/login/mfa", { body: { mfaToken: fourth.body.mfaToken, code: recovery } })).status).toBe(400);
      expect((await auditOf("auth.mfa_recovery_code_used")).length).toBe(1);
      expect((await auditOf("auth.mfa_enabled")).length).toBe(1);
    });

    it("throws away a challenge after 5 wrong codes and locks MFA after 10 in a row", async () => {
      const { user, phone, mfaSecret } = await admin();
      for (let round = 0; round < 2; round++) {
        const challenge = await login(phone);
        for (let i = 0; i < 5; i++) {
          const res = await ctx.api("POST", "/auth/login/mfa", { body: { mfaToken: challenge.body.mfaToken, code: "000000" } });
          if (round === 1 && i === 4) {
            expect(res.status).toBe(429);
            expect(res.body.error.code).toBe("MFA_LOCKED");
          } else if (i === 4) expect(res.body.error.code).toBe("MFA_TOKEN_INVALID");
          else expect(res.body.error.code).toBe("INVALID_MFA_CODE");
        }
      }
      // Locked: even the right code is refused for now.
      const locked = await login(phone);
      const res = await ctx.api("POST", "/auth/login/mfa", { body: { mfaToken: locked.body.mfaToken, code: await freshCode(user.id, mfaSecret!) } });
      expect(res.body.error.code).toBe("MFA_LOCKED");
      expect((await auditOf("auth.mfa_locked")).length).toBe(1);
    });

    it("is optional for other users, who can turn it on and off from their profile", async () => {
      const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Customer");
      expect((await ctx.api("GET", "/auth/me", { token: customer.token })).body.mfa).toEqual({ enabled: false, required: false });
      const setup = await ctx.api("POST", "/auth/mfa/setup", { token: customer.token, body: {} });
      const enable = await ctx.api("POST", "/auth/mfa/enable", { token: customer.token, body: { code: authenticator.generate(setup.body.secret) } });
      expect(enable.status, JSON.stringify(enable.body)).toBe(200);
      expect(enable.body.recoveryCodes).toHaveLength(10);
      // The session that enabled it continues (it proved the code).
      expect((await ctx.api("GET", "/auth/me", { token: customer.token })).body.mfa.enabled).toBe(true);
      // Sign-in now asks for a code (SMS-code sign-in too goes through the same step).
      expect((await login(customer.phone)).body.mfaRequired).toBe(true);

      const off = await ctx.api("POST", "/auth/mfa/disable", { token: customer.token, body: { code: await freshCode(customer.user.id, setup.body.secret) } });
      expect(off.status, JSON.stringify(off.body)).toBe(200);
      expect((await login(customer.phone)).body.accessToken).toEqual(expect.any(String));
    });

    it("keeps non-super-admin sign-in unchanged and ends super admin sessions that never passed MFA", async () => {
      const finance = await rawUser([{ role: "FINANCE" }]);
      const res = await login(finance.phone);
      expect(res.body.accessToken).toEqual(expect.any(String));

      // A super admin signed in before MFA was enforced: their session can't be refreshed.
      const legacy = await rawUser([{ role: "SUPER_ADMIN" }]);
      const session = await ctx.app.get((await import("../src/modules/auth/session.service")).SessionService).create(legacy.user.id, { ip: "127.0.0.1", requestId: "t" });
      const refresh = await ctx.api("POST", "/auth/refresh", { body: { refreshToken: session.refreshToken } });
      expect(refresh.status).toBe(401);
      expect(refresh.body.error.code).toBe("MFA_REQUIRED");
      // …and enrolment is possible at the next sign-in.
      expect((await login(legacy.phone)).body.mfaSetupRequired).toBe(true);
    });

    it("lets a super admin reset another user's MFA (audited, sessions ended), never their own", async () => {
      const a = await admin("Admin A");
      const b = await admin("Admin B");
      expect((await ctx.api("POST", `/users/${a.user.id}/mfa/reset`, { token: a.token })).body.error.code).toBe("CANNOT_RESET_OWN_MFA");
      const reset = await ctx.api("POST", `/users/${b.user.id}/mfa/reset`, { token: a.token });
      expect(reset.status, JSON.stringify(reset.body)).toBe(200);
      expect(reset.body.mfa).toEqual({ enabled: false, required: true });
      expect((await ctx.api("GET", "/auth/me", { token: b.token })).body.error.code).toBe("SESSION_REVOKED");
      expect((await login(b.phone)).body.mfaSetupRequired).toBe(true);
      expect((await auditOf("auth.mfa_reset"))[0]).toMatchObject({ actorId: a.user.id, entityId: b.user.id });
      const finance = await userWithRoles(ctx, [{ role: "FINANCE" }]);
      expect((await ctx.api("POST", `/users/${b.user.id}/mfa/reset`, { token: finance.token })).status).toBe(403);
    });
  });

  // ───────────── roles and permissions ─────────────

  describe("role and permission editor", () => {
    it("shows the matrix and changes a built-in role at once (sole super admin), effective on the next request", async () => {
      const { token } = await admin();
      const finance = await userWithRoles(ctx, [{ role: "FINANCE" }], "Finance");
      const matrix = await ctx.api("GET", "/admin/roles", { token });
      expect(matrix.status).toBe(200);
      expect(matrix.body.permissions.find((p: { key: string }) => p.key === "role:manage")).toMatchObject({ superAdminOnly: true, group: "Security" });
      const financeRole = matrix.body.builtInRoles.find((r: { role: string }) => r.role === "FINANCE");
      expect(financeRole).toMatchObject({ users: 1, granted: [], revoked: [] });
      expect(matrix.body.builtInRoles.find((r: { role: string }) => r.role === "SUPER_ADMIN").locked).toContain("role:manage");

      expect((await ctx.api("GET", "/users", { token: finance.token })).status).toBe(403);
      const permissions = [...financeRole.permissions.filter((p: string) => p !== "audit:read"), "user:read"];
      const changed = await ctx.api("PUT", "/admin/roles/FINANCE/permissions", { token, body: { permissions } });
      expect(changed.status, JSON.stringify(changed.body)).toBe(200);
      expect(changed.body).toEqual({ role: "FINANCE", granted: ["user:read"], revoked: ["audit:read"] });
      // Same token, new permissions.
      expect((await ctx.api("GET", "/users", { token: finance.token })).status).toBe(200);
      expect((await ctx.api("GET", "/audit-logs", { token: finance.token })).status).toBe(403);
      expect((await auditOf("role.permissions_update")).length).toBe(1);
      // Second super admin approval is off by default: the change applied at once.
      expect((await auditOf("change.applied"))[0].data).toMatchObject({ kind: "role.permissions", approval: "approval_off" });
    });

    it("protects super admins from lockout and keeps security permissions for super admins", async () => {
      const { token } = await admin();
      const lockout = await ctx.api("PUT", "/admin/roles/SUPER_ADMIN/permissions", { token, body: { permissions: ["user:read"] } });
      expect(lockout.status).toBe(422);
      expect(lockout.body.error.code).toBe("LOCKOUT_PROTECTION");
      const reserved = await ctx.api("PUT", "/admin/roles/OPS_MANAGER/permissions", { token, body: { permissions: ["parcel:read:any", "user:impersonate"] } });
      expect(reserved.body.error.code).toBe("SUPER_ADMIN_ONLY");
      expect((await ctx.api("PUT", "/admin/roles/NOPE/permissions", { token, body: { permissions: [] } })).status).toBe(404);
      expect((await ctx.api("PUT", "/admin/roles/FINANCE/permissions", { token, body: { permissions: ["not:real"] } })).status).toBe(422);
      const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }]);
      expect((await ctx.api("PUT", "/admin/roles/FINANCE/permissions", { token: ops.token, body: { permissions: [] } })).status).toBe(403);
    });

    it("creates custom roles that can be granted to users and deleted", async () => {
      const { token } = await admin();
      const created = await ctx.api("POST", "/admin/custom-roles", {
        token,
        body: { name: "Billing Viewer", description: "Reads finance only", baseRole: "FINANCE", permissions: ["finance:read", "audit:read"] },
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const roleId = created.body.id;
      expect((await ctx.api("POST", "/admin/custom-roles", { token, body: { name: "billing viewer", baseRole: "FINANCE", permissions: [] } })).body.error.code).toBe("ROLE_NAME_TAKEN");
      expect((await ctx.api("POST", "/admin/custom-roles", { token, body: { name: "Bad", baseRole: "FINANCE", permissions: ["change:approve"] } })).body.error.code).toBe("SUPER_ADMIN_ONLY");

      const person = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Viewer");
      expect((await ctx.api("POST", `/users/${person.user.id}/roles`, { token, body: { role: "OPS_MANAGER", customRoleId: roleId } })).body.error.code).toBe("CUSTOM_ROLE_BASE_MISMATCH");
      const granted = await ctx.api("POST", `/users/${person.user.id}/roles`, { token, body: { role: "FINANCE", customRoleId: roleId } });
      expect(granted.status, JSON.stringify(granted.body)).toBe(201);
      expect(granted.body.roles.find((r: { customRole: unknown }) => r.customRole)).toMatchObject({ role: "FINANCE", customRole: { name: "Billing Viewer" } });

      // The old token must refresh; the new one carries the custom role.
      expect((await ctx.api("GET", "/audit-logs", { token: person.token })).body.error.code).toBe("TOKEN_EXPIRED");
      const relogin = await login(person.phone);
      expect(relogin.body.user.customRoles).toEqual([{ id: roleId, name: "Billing Viewer", baseRole: "FINANCE" }]);
      expect((await ctx.api("GET", "/audit-logs", { token: relogin.body.accessToken })).status).toBe(200);
      expect((await ctx.api("GET", "/users", { token: relogin.body.accessToken })).status).toBe(403); // not in the custom set

      expect((await ctx.api("PATCH", `/admin/custom-roles/${roleId}`, { token, body: { permissions: ["finance:read"] } })).status).toBe(200);
      expect((await ctx.api("GET", "/audit-logs", { token: relogin.body.accessToken })).status).toBe(403);

      expect((await ctx.api("DELETE", `/admin/custom-roles/${roleId}`, { token })).status).toBe(200);
      expect(await ctx.prisma.userRole.count({ where: { customRoleId: roleId } })).toBe(0);
      expect((await ctx.api("GET", "/audit-logs", { token: relogin.body.accessToken })).body.error.code).toBe("TOKEN_EXPIRED");
    });
  });

  // ───────────── maker-checker ─────────────

  describe("maker-checker approvals", () => {
    it("is off by default; turning it on applies at once, turning it off needs the second super admin", async () => {
      const a = await admin("Admin A");
      const b = await admin("Admin B");
      expect((await ctx.api("GET", "/admin/changes/settings", { token: a.token })).body).toMatchObject({ enabled: false, superAdmins: 2, approvalRequired: false });
      const catalog = (await ctx.api("GET", "/service-catalog")).body;
      const services = catalog.services.filter((x: { segments: string[] }) => x.segments.includes("CUSTOMER")).map((x: { code: string }) => x.code);
      // Off: a change by one of two super admins applies at once.
      const direct = await ctx.api("POST", "/packages", { token: a.token, body: { segment: "CUSTOMER", name: "Direct", services, prices: {} } });
      expect(direct.status, JSON.stringify(direct.body)).toBe(201);

      const on = await ctx.api("PUT", "/admin/changes/settings", { token: a.token, body: { enabled: true } });
      expect(on.body).toMatchObject({ status: "APPLIED", setting: { enabled: true, approvalRequired: true } });
      const off = await ctx.api("PUT", "/admin/changes/settings", { token: a.token, body: { enabled: false } });
      expect(off.body).toMatchObject({ status: "PENDING", changeRequest: { kind: "approvals.second_admin" }, setting: { enabled: true } });
      expect((await ctx.api("POST", `/admin/changes/${off.body.changeRequest.id}/approve`, { token: b.token, body: {} })).status).toBe(200);
      expect((await ctx.api("GET", "/admin/changes/settings", { token: a.token })).body.enabled).toBe(false);

      // A change still waiting from when approval was on: with it off, the requester can apply it.
      await ctx.api("PUT", "/admin/changes/settings", { token: a.token, body: { enabled: true } });
      const waiting = await ctx.api("POST", "/packages", { token: a.token, body: { segment: "CUSTOMER", name: "Waiting", services, prices: {} } });
      expect(waiting.status).toBe(202);
      expect((await ctx.api("POST", `/admin/changes/${waiting.body.changeRequest.id}/approve`, { token: a.token, body: {} })).body.error.code).toBe("SELF_APPROVAL");
      const turnOff = await ctx.api("PUT", "/admin/changes/settings", { token: a.token, body: { enabled: false } });
      await ctx.api("POST", `/admin/changes/${turnOff.body.changeRequest.id}/approve`, { token: b.token, body: {} });
      const queue = await ctx.api("GET", "/admin/changes?status=PENDING", { token: a.token });
      expect(queue.body.items.find((c: { id: string }) => c.id === waiting.body.changeRequest.id)).toMatchObject({ canApprove: true, canCancel: true });
      expect((await ctx.api("POST", `/admin/changes/${waiting.body.changeRequest.id}/approve`, { token: a.token, body: {} })).status).toBe(200);
      expect(await ctx.prisma.servicePackage.count({ where: { name: "Waiting" } })).toBe(1);
    });

    it("queues package and role changes for a second super admin", async () => {
      const a = await admin("Admin A");
      const b = await admin("Admin B");
      expect((await ctx.api("PUT", "/admin/changes/settings", { token: a.token, body: { enabled: true } })).body.status).toBe("APPLIED");
      const catalog = (await ctx.api("GET", "/service-catalog")).body;
      const services = catalog.services.filter((x: { segments: string[] }) => x.segments.includes("CUSTOMER")).map((x: { code: string }) => x.code);
      const body = { segment: "CUSTOMER", name: "Customer v9", services, prices: { sameDistrict: 95 } };
      const pending = await ctx.api("POST", "/packages", { token: a.token, body });
      expect(pending.status, JSON.stringify(pending.body)).toBe(202);
      expect(pending.body).toMatchObject({ status: "PENDING", changeRequest: { kind: "package.create", requestedBy: { name: "Admin A" }, status: "PENDING" } });
      expect(await ctx.prisma.servicePackage.count({ where: { name: "Customer v9" } })).toBe(0);
      const id = pending.body.changeRequest.id;

      const summary = await ctx.api("GET", "/admin/changes/summary", { token: b.token });
      expect(summary.body).toEqual({ pending: 1, approvalRequired: true });
      const queueA = await ctx.api("GET", "/admin/changes?status=PENDING", { token: a.token });
      expect(queueA.body.items[0]).toMatchObject({ id, canApprove: false, canCancel: true });
      const queueB = await ctx.api("GET", "/admin/changes?status=PENDING", { token: b.token });
      expect(queueB.body.items[0]).toMatchObject({ id, canApprove: true, canCancel: false });

      expect((await ctx.api("POST", `/admin/changes/${id}/approve`, { token: a.token, body: {} })).body.error.code).toBe("SELF_APPROVAL");
      const approved = await ctx.api("POST", `/admin/changes/${id}/approve`, { token: b.token, body: { note: "Checked" } });
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      expect(approved.body).toMatchObject({ status: "APPROVED", reviewedBy: { name: "Admin B" }, reviewNote: "Checked" });
      const pkg = await ctx.prisma.servicePackage.findFirstOrThrow({ where: { name: "Customer v9" } });
      expect(pkg).toMatchObject({ segment: "CUSTOMER", createdById: a.user.id });
      expect((await ctx.api("POST", `/admin/changes/${id}/approve`, { token: b.token, body: {} })).body.error.code).toBe("CHANGE_NOT_PENDING");

      // Rejected and cancelled changes are never applied.
      const role = await ctx.api("PUT", "/admin/roles/SUPPORT_AGENT/permissions", { token: a.token, body: { permissions: ["parcel:read:any"] } });
      expect(role.status).toBe(202);
      expect((await ctx.api("POST", `/admin/changes/${role.body.changeRequest.id}/reject`, { token: b.token, body: {} })).status).toBe(422); // reason required
      expect((await ctx.api("POST", `/admin/changes/${role.body.changeRequest.id}/reject`, { token: b.token, body: { note: "Too broad" } })).body.status).toBe("REJECTED");
      expect(await ctx.prisma.rolePermissionOverride.count()).toBe(0);

      const tariff = await ctx.api("POST", "/admin/custom-roles", { token: b.token, body: { name: "Temp", baseRole: "SUPPORT_AGENT", permissions: [] } });
      expect((await ctx.api("POST", `/admin/changes/${tariff.body.changeRequest.id}/cancel`, { token: a.token })).status).toBe(403);
      expect((await ctx.api("POST", `/admin/changes/${tariff.body.changeRequest.id}/cancel`, { token: b.token })).body.status).toBe("CANCELLED");
      expect(await ctx.prisma.customRole.count()).toBe(0);
      expect((await auditOf("change.approve")).length).toBe(1);
      expect((await auditOf("change.reject")).length).toBe(1);
      expect((await auditOf("change.cancel")).length).toBe(1);
    });

    it("closes a change that can no longer be applied as FAILED", async () => {
      const a = await admin("Admin A");
      const b = await admin("Admin B");
      expect((await ctx.api("PUT", "/admin/changes/settings", { token: a.token, body: { enabled: true } })).body.status).toBe("APPLIED");
      const first = await ctx.api("POST", "/admin/custom-roles", { token: a.token, body: { name: "Dispatch Lead", baseRole: "OPS_MANAGER", permissions: [] } });
      const second = await ctx.api("POST", "/admin/custom-roles", { token: a.token, body: { name: "Dispatch Lead", baseRole: "OPS_MANAGER", permissions: [] } });
      expect((await ctx.api("POST", `/admin/changes/${first.body.changeRequest.id}/approve`, { token: b.token, body: {} })).status).toBe(200);
      const failed = await ctx.api("POST", `/admin/changes/${second.body.changeRequest.id}/approve`, { token: b.token, body: {} });
      expect(failed.body.error.code).toBe("ROLE_NAME_TAKEN");
      expect((await ctx.prisma.changeRequest.findUniqueOrThrow({ where: { id: second.body.changeRequest.id } })).status).toBe("FAILED");
    });
  });

  // ───────────── support access ─────────────

  describe("support access (impersonation)", () => {
    it("views as another user read-only, audited, never reaching sign-in or MFA, and can be ended", async () => {
      const { token, user: adminUser } = await admin("Alex Admin");
      const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Nabila");
      expect((await ctx.api("POST", "/admin/impersonations", { token, body: { userId: customer.user.id, reason: "short" } })).status).toBe(422);
      const started = await ctx.api("POST", "/admin/impersonations", { token, body: { userId: customer.user.id, reason: "Customer asked for help with a booking", minutes: 10 } });
      expect(started.status, JSON.stringify(started.body)).toBe(201);
      expect(started.body).toMatchObject({ expiresIn: 600, impersonation: { readOnly: true, target: { name: "Nabila" }, active: true }, user: { name: "Nabila" } });
      const imp = started.body.accessToken as string;

      const me = await ctx.api("GET", "/auth/me", { token: imp });
      expect(me.body).toMatchObject({ name: "Nabila", impersonation: { adminName: "Alex Admin", readOnly: true } });
      expect((await ctx.api("GET", "/parcels", { token: imp })).status).toBe(200);
      const write = await ctx.api("POST", "/me/addresses", {
        token: imp,
        body: { role: "PICKUP", contactName: "X", phone: "01711000000", street: "Road 1", zone: "Gulshan", district: "Dhaka North" },
      });
      expect(write.status).toBe(403);
      expect(write.body.error.code).toBe("IMPERSONATION_READ_ONLY");
      for (const [method, url] of [
        ["POST", "/auth/password/change"],
        ["POST", "/auth/mfa/setup"],
        ["GET", "/auth/sessions"],
        ["POST", "/auth/logout-all"],
        ["POST", "/admin/impersonations"],
      ] as const)
        expect((await ctx.api(method, url, { token: imp, body: {} })).status, url).toBe(403);
      const audited = await auditOf("impersonation.request");
      expect(audited.length).toBeGreaterThanOrEqual(8);
      expect(audited[0]).toMatchObject({ actorId: adminUser.id, entityId: customer.user.id });
      expect((await auditOf("impersonation.start"))[0].data).toMatchObject({ reason: "Customer asked for help with a booking", readOnly: true });

      // Ending it (here from the impersonation tab) revokes the token.
      const ended = await ctx.api("POST", `/admin/impersonations/${started.body.impersonation.id}/end`, { token: imp });
      expect(ended.status, JSON.stringify(ended.body)).toBe(200);
      expect(ended.body).toMatchObject({ active: false, endedReason: "ended_from_session" });
      expect((await ctx.api("GET", "/auth/me", { token: imp })).body.error.code).toBe("SESSION_REVOKED");
      const list = await ctx.api("GET", "/admin/impersonations", { token });
      expect(list.body.items).toHaveLength(1);
    });

    it("refuses super admin targets and non-super-admins", async () => {
      const a = await admin("Admin A");
      const b = await admin("Admin B");
      expect((await ctx.api("POST", "/admin/impersonations", { token: a.token, body: { userId: b.user.id, reason: "Looking at their account" } })).body.error.code).toBe(
        "IMPERSONATE_SUPER_ADMIN",
      );
      const support = await userWithRoles(ctx, [{ role: "SUPPORT_AGENT" }]);
      const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }]);
      expect((await ctx.api("POST", "/admin/impersonations", { token: support.token, body: { userId: customer.user.id, reason: "Looking at their account" } })).status).toBe(403);
    });

    it("allows changes with full access, still audited", async () => {
      const { token } = await admin();
      const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Rahim");
      const started = await ctx.api("POST", "/admin/impersonations", {
        token,
        body: { userId: customer.user.id, reason: "Fix a wrong saved address", readOnly: false, notifyUser: false },
      });
      const write = await ctx.api("POST", "/me/addresses", {
        token: started.body.accessToken,
        body: { role: "PICKUP", contactName: "Rahim", phone: "01711000000", street: "Road 1", zone: "Gulshan", district: "Dhaka North" },
      });
      expect(write.status, JSON.stringify(write.body)).toBe(201);
      const entry = (await auditOf("impersonation.request")).find(a => (a.data as { method: string }).method === "POST");
      expect(entry?.data).toMatchObject({ path: "/api/v1/me/addresses", blocked: false });
    });
  });

  // ───────────── Banking & Financial pricing ─────────────

  describe("Banking & Financial pricing; retired rate cards and tariffs", () => {
    it("prices Banking services by route tier with no weight or COD; rate cards and merchant tariffs are retired", async () => {
      const { token } = await admin();
      const merchant = await ctx.prisma.merchant.create({
        data: { code: "MR-DOC1", type: "BANKING_FINANCIAL", name: "Docs Ltd", status: "ACTIVE", contactName: "Owner", contactPhone: "+8801711111111", pickupAddress: "Road 5", pickupArea: "Gulshan", pickupDistrict: "Dhaka North" },
      });
      const owner = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: merchant.id }], "Docs Owner");
      const quote = (body: object) => ctx.api("POST", "/merchants/me/quote", { token: owner.token, body: { pickupDistrict: "Dhaka North", deliveryDistrict: "Gazipur", deliveryZone: "Tongi", weightKg: 5, ...body } });
      // Dhaka → Gazipur is Dhaka ↔ Sub-urban; Banking has no weight charge.
      expect((await quote({})).body).toMatchObject({ tier: "DHAKA_SUBURBAN", totalCharge: 100, weightCharge: 0 });
      // The old document type still selects the service.
      expect((await quote({ documentType: "Corporate Urgent Document" })).body.selection).toMatchObject({ speed: "URGENT", weightKg: 0.5 });
      // No COD for Banking & Financial.
      const cod = await quote({ codAmount: 500 });
      expect(cod.status).toBe(422);
      // The old pricing endpoints are retired.
      expect((await ctx.api("POST", "/rate-cards", { token, body: { segment: "BANKING_FINANCIAL", name: "Docs v1", config: {} } })).body.error.code).toBe("PRICING_RETIRED");
      expect((await ctx.api("PUT", `/merchants/${merchant.id}/tariff`, { token, body: { config: { sameZone: 10 } } })).body.error.code).toBe("PRICING_RETIRED");
      expect(await ctx.prisma.merchantRateOverride.count()).toBe(0);
    });
  });

  // ───────────── analytics ─────────────

  describe("first-party analytics", () => {
    const browser = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36", host: "pairaexpress.example" };

    it("counts page views, visits and tracking lookups without personal data, ignoring bots", async () => {
      const view = (body: object, headers = browser) => ctx.api("POST", "/analytics/pageview", { body, headers });
      expect((await view({ path: "/", referrer: "https://www.google.com/" })).body).toEqual({ counted: true });
      expect((await view({ path: "/#/track/DF12345678?phone=01711000000", referrer: "https://pairaexpress.example/" })).status).toBe(202);
      expect((await view({ path: "/" })).body.counted).toBe(true);
      expect((await view({ path: "/" }, { ...browser, "user-agent": "Googlebot/2.1 (+http://www.google.com/bot.html)" })).body.counted).toBe(false);
      expect((await view({ path: "javascript:alert(1)" })).body.counted).toBe(false);

      const rows = await ctx.prisma.analyticsDaily.findMany();
      expect(rows.some(r => r.dimension.includes("DF12345678") || r.dimension.includes("0171"))).toBe(false);
      expect(rows.some(r => r.dimension === "path:/#/track/:id")).toBe(true);

      expect((await ctx.api("GET", "/track/DF-NOPE")).status).toBe(404); // not counted
      const { token } = await admin();
      const traffic = await ctx.api("GET", "/analytics/traffic?days=7", { token });
      expect(traffic.status).toBe(200);
      expect(traffic.body.today).toMatchObject({ pageviews: 3, visits: 2 });
      expect(traffic.body.daily).toHaveLength(7);
      expect(traffic.body.hourly).toHaveLength(24);
      expect(traffic.body.hourly.at(-1)).toMatchObject({ pageviews: 3, visits: 2 });
      expect(traffic.body.sources).toEqual(expect.arrayContaining([{ key: "search", count: 1 }, { key: "direct", count: 1 }]));
      expect(traffic.body.topPages[0]).toEqual({ key: "/", count: 2 });

      const finance = await userWithRoles(ctx, [{ role: "FINANCE" }]);
      expect((await ctx.api("GET", "/analytics/traffic", { token: finance.token })).status).toBe(403);
    });

    it("counts successful public tracking lookups", async () => {
      const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }]);
      const booked = await ctx.api("POST", "/parcels", { token: customer.token, body: parcelBody() });
      expect((await ctx.api("GET", `/track/${booked.body.trackingId}`)).status).toBe(200);
      await new Promise(r => setTimeout(r, 200)); // counted after the response
      const row = await ctx.prisma.analyticsDaily.findFirst({ where: { metric: "tracking_lookup", dimension: "" } });
      expect(row?.count).toBe(1);
    });

    it("records which parcels were tracked on the website (no visitor data): period counts, the paged list, live now", async () => {
      const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }]);
      const a = (await ctx.api("POST", "/parcels", { token: customer.token, body: parcelBody() })).body.trackingId as string;
      const b = (await ctx.api("POST", "/parcels", { token: customer.token, body: parcelBody() })).body.trackingId as string;
      const track = (id: string, headers = browser) => ctx.api("GET", `/track/${id}`, { headers });
      expect((await track(a)).status).toBe(200);
      expect((await track(a)).status).toBe(200); // the same visitor again within 10 minutes: one lookup
      expect((await track(a, { ...browser, "user-agent": `${browser["user-agent"]} Edg/130` })).status).toBe(200); // another visitor
      expect((await track(b)).status).toBe(200);
      await new Promise(r => setTimeout(r, 300)); // recorded after the response
      const rows = await ctx.prisma.trackingLookup.findMany();
      expect(rows).toHaveLength(3);
      expect(Object.keys(rows[0]).sort()).toEqual(["createdAt", "id", "parcelId", "via"]);

      const { token } = await admin();
      const summary = (await ctx.api("GET", "/analytics/tracking/summary", { token })).body;
      expect(summary.periods.today).toMatchObject({ lookups: 3, parcels: 2 });
      expect(summary.periods.thisMonth).toMatchObject({ lookups: 3, parcels: 2 });
      expect(summary.periods.lastMonth).toMatchObject({ lookups: 0, parcels: 0 });
      expect(summary.periods.allTime).toMatchObject({ lookups: 3, parcels: 2 });

      const day = new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
      const list = (await ctx.api("GET", `/analytics/tracking/parcels?from=${day}&to=${day}&limit=1`, { token })).body;
      expect(list).toMatchObject({ total: 2, lookups: 3, pages: 2, page: 1 });
      expect(list.items).toHaveLength(1);
      const second = (await ctx.api("GET", `/analytics/tracking/parcels?from=${day}&to=${day}&limit=1&page=2`, { token })).body.items;
      expect([list.items[0].trackingId, second[0].trackingId].sort()).toEqual([a, b].sort());
      const found = (await ctx.api("GET", `/analytics/tracking/parcels?from=${day}&to=${day}&q=${a}`, { token })).body.items;
      expect(found).toEqual([expect.objectContaining({ trackingId: a, lookups: 2, status: expect.any(String) })]);

      // Live: two open tabs ping, page views count per minute.
      for (const sid of ["tab-aaaaaaaa", "tab-bbbbbbbb"]) expect((await ctx.api("POST", "/analytics/ping", { body: { sid, path: "/track/PP-1" }, headers: browser })).status).toBe(202);
      expect((await ctx.api("POST", "/analytics/ping", { body: { sid: "tab-cccccccc", path: "/" }, headers: { ...browser, "user-agent": "Googlebot/2.1" } })).body.ok).toBe(false);
      await ctx.api("POST", "/analytics/pageview", { body: { path: "/" }, headers: browser });
      await new Promise(r => setTimeout(r, 200));
      const live = (await ctx.api("GET", "/analytics/live", { token })).body;
      expect(live.online).toBe(2);
      expect(live.pages).toEqual([{ path: "/track/:id", visitors: 2 }]);
      expect(live.perMinute).toHaveLength(30);
      expect(live.perMinute.at(-1).pageviews).toBe(1);
      expect(live.lookupsLastHour).toBe(3);
      expect(live.recentLookups[0]).toMatchObject({ trackingId: expect.any(String), via: "search" });

      const finance = await userWithRoles(ctx, [{ role: "FINANCE" }]);
      expect((await ctx.api("GET", "/analytics/live", { token: finance.token })).status).toBe(403);
      expect((await ctx.api("GET", "/analytics/tracking/summary", { token: finance.token })).status).toBe(403);
    });
  });

  // ───────────── overview ─────────────

  it("reports real MFA coverage in the overview", async () => {
    const { token } = await admin();
    await userWithRoles(ctx, [{ role: "FINANCE" }]);
    const res = await ctx.api("GET", "/admin/overview", { token });
    expect(res.body.security).toMatchObject({ superAdmins: 1, superAdminsWithMfa: 1, staff: 2, staffWithMfa: 1, staffMfaPercent: 50, pendingChanges: 0 });
  });
});
