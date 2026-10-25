import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { decrypt, hmacSha256, sha256 } from "../src/common/crypto";
import { WebhooksService } from "../src/modules/notifications/webhooks.service";
import { resetDatabase, startApp, userWithRoles, type TestContext } from "./helpers";

const application = (overrides: Record<string, unknown> = {}) => ({
  type: "ECOMMERCE",
  name: "Nabila Fashion House",
  contactName: "Nabila Ahmed",
  contactPhone: "01812-000000",
  contactEmail: "Nabila@Example.com",
  business: { district: "Dhaka Central", zone: "Dhanmondi", area: "Dhanmondi Road 7", street: "House 12, Road 7" },
  pickupSameAsBusiness: true,
  pickupTime: "MORNING",
  ...overrides,
});

describe("merchants", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  let seq = 0;
  const merchant = (data: { status?: "PENDING_REVIEW" | "ACTIVE" | "SUSPENDED"; type?: "ECOMMERCE" | "BANKING_FINANCIAL"; name?: string } = {}) =>
    ctx.prisma.merchant.create({
      data: {
        code: `MR-T${++seq}`,
        type: data.type ?? "ECOMMERCE",
        name: data.name ?? `Shop ${seq}`,
        status: data.status ?? "ACTIVE",
        // API keys need approved KYC by default (merchant-admin tests cover the policy).
        kycStatus: "APPROVED",
        contactName: "Owner",
        contactPhone: "+8801711111111",
        pickupAddress: "Road 1",
        pickupArea: "Gulshan",
        pickupDistrict: "Dhaka North",
      },
    });

  /** An active merchant with a signed-in owner. */
  const ownedMerchant = async (status: "PENDING_REVIEW" | "ACTIVE" | "SUSPENDED" = "ACTIVE") => {
    const m = await merchant({ status });
    const owner = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: m.id }], "Shop Owner");
    return { m, owner };
  };

  const refresh = async (refreshToken: string) => {
    const res = await ctx.api("POST", "/auth/refresh", { body: { refreshToken } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.accessToken as string;
  };

  // ───────────── onboarding ─────────────

  describe("applications", () => {
    it("creates a pending merchant with an EC code (E-commerce) and makes the applicant its owner", async () => {
      const u = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Nabila Ahmed");
      const res = await ctx.api("POST", "/merchants/applications", { token: u.token, body: application() });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.merchant).toMatchObject({ code: "EC-1001", status: "PENDING_REVIEW", type: "ECOMMERCE", contactPhone: "+8801812000000", contactEmail: "nabila@example.com", plan: null });
      expect(res.body.message).toMatch(/refresh|sign in/i);
      const grant = await ctx.prisma.userRole.findFirstOrThrow({ where: { userId: u.user.id, role: "MERCHANT_OWNER" } });
      expect(grant.merchantId).toBe(res.body.merchant.id);
      expect(await ctx.prisma.auditLog.count({ where: { action: "merchant.apply", entityId: res.body.merchant.id } })).toBe(1);

      // The old token has no merchant role; after refresh it does.
      expect((await ctx.api("GET", "/merchants/me", { token: u.token })).status).toBe(403);
      const fresh = await refresh(u.refreshToken);
      const me = await ctx.api("GET", "/merchants/me", { token: fresh });
      expect(me.body).toMatchObject({ code: "EC-1001", status: "PENDING_REVIEW", myRole: "MERCHANT_OWNER" });
    });

    it("allows one open application per user, skips taken codes, and gives Banking & Financial merchants an FM code on the same running number", async () => {
      await ctx.prisma.merchant.create({ data: { name: "Nabila Fashion House", contactName: "Nabila Ahmed", contactPhone: "+8801812000000", pickupAddress: "House 12, Road 7", pickupArea: "Dhanmondi", pickupDistrict: "Dhaka Central", type: "ECOMMERCE", code: "EC-1001" } });
      const u = await userWithRoles(ctx, [{ role: "CUSTOMER" }]);
      const first = await ctx.api("POST", "/merchants/applications", { token: u.token, body: application() });
      expect(first.body.merchant.code).toBe("EC-1002");
      const second = await ctx.api("POST", "/merchants/applications", { token: u.token, body: application({ name: "Another shop" }) });
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe("APPLICATION_PENDING");

      // Once approved, the user may apply for another business.
      await ctx.prisma.merchant.update({ where: { id: first.body.merchant.id }, data: { status: "ACTIVE" } });
      const third = await ctx.api("POST", "/merchants/applications", { token: u.token, body: application({ type: "BANKING_FINANCIAL", name: "Docs Ltd" }) });
      expect(third.status).toBe(201);
      expect(third.body.merchant.code).toBe("FM-1003");
    });

    it("serialises concurrent applications from the same user", async () => {
      const u = await userWithRoles(ctx, [{ role: "CUSTOMER" }]);
      const results = await Promise.all([1, 2, 3].map(() => ctx.api("POST", "/merchants/applications", { token: u.token, body: application() })));
      expect(results.map(r => r.status).sort()).toEqual([201, 409, 409]);
      expect(await ctx.prisma.merchant.count()).toBe(1);
    });

    it("validates the application and requires sign-in", async () => {
      const u = await userWithRoles(ctx, [{ role: "CUSTOMER" }]);
      const bad = await ctx.api("POST", "/merchants/applications", { token: u.token, body: application({ type: "SHOP", contactPhone: "12345", contactEmail: "nope", business: { district: "Dhaka Central", zone: "Dhanmondi", street: "" } }) });
      expect(bad.status).toBe(422);
      const paths = bad.body.error.details.map((d: { path: string }) => d.path);
      expect(paths).toEqual(expect.arrayContaining(["type", "contactPhone", "contactEmail", "business.street"]));
      expect(bad.body.error.details.find((d: { path: string }) => d.path === "contactPhone").message).toMatch(/Bangladeshi mobile/);
      expect((await ctx.api("POST", "/merchants/applications", { body: application() })).status).toBe(401);
    });
  });

  // ───────────── administration ─────────────

  describe("admin", () => {
    it("lists with filters, plan, parcel count and cursor pagination", async () => {
      const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }]);
      const plan = await ctx.prisma.servicePlan.create({ data: { segment: "ECOMMERCE", name: "Growth", monthlyFee: 999, discountPct: 10 } });
      const a = await merchant({ name: "Alpha Store" });
      await ctx.prisma.merchant.update({ where: { id: a.id }, data: { planId: plan.id } });
      await merchant({ name: "Beta Docs", type: "BANKING_FINANCIAL", status: "PENDING_REVIEW" });
      await merchant({ name: "Gamma Store", status: "SUSPENDED" });

      const all = await ctx.api("GET", "/merchants?limit=2", { token: ops.token });
      expect(all.status).toBe(200);
      expect(all.body.items).toHaveLength(2);
      expect(all.body.nextCursor).toBeTruthy();
      const next = await ctx.api("GET", `/merchants?limit=2&cursor=${all.body.nextCursor}`, { token: ops.token });
      expect(next.body.items).toHaveLength(1);
      expect(next.body.nextCursor).toBeNull();
      const alpha = [...all.body.items, ...next.body.items].find((m: { name: string }) => m.name === "Alpha Store");
      expect(alpha).toMatchObject({ plan: { name: "Growth", discountPct: 10 }, parcelCount: 0 });

      expect((await ctx.api("GET", "/merchants?status=PENDING_REVIEW", { token: ops.token })).body.items.map((m: { name: string }) => m.name)).toEqual(["Beta Docs"]);
      expect((await ctx.api("GET", "/merchants?type=ECOMMERCE&q=store", { token: ops.token })).body.items).toHaveLength(2);
      expect((await ctx.api("GET", "/merchants?status=CLOSED", { token: ops.token })).status).toBe(422);
    });

    it("shows detail with owners, staff and counts", async () => {
      const support = await userWithRoles(ctx, [{ role: "SUPPORT_AGENT" }]);
      const { m, owner } = await ownedMerchant();
      await userWithRoles(ctx, [{ role: "MERCHANT_STAFF", merchantId: m.id }], "Staff Member");
      const res = await ctx.api("GET", `/merchants/${m.id}`, { token: support.token });
      expect(res.status).toBe(200);
      expect(res.body.owners).toEqual([expect.objectContaining({ userId: owner.user.id, name: "Shop Owner" })]);
      expect(res.body.staff).toEqual([expect.objectContaining({ name: "Staff Member", role: "MERCHANT_STAFF" })]);
      expect(res.body.counts).toEqual({ parcels: 0, activeApiKeys: 0, webhooks: 0, settlements: 0, invoices: 0, tickets: 0, notes: 0 });
      expect((await ctx.api("GET", "/merchants/00000000-0000-7000-8000-000000000000", { token: support.token })).status).toBe(404);
      expect((await ctx.api("GET", "/merchants/not-a-uuid", { token: support.token })).status).toBe(400);
    });

    it("blocks non-staff from admin routes", async () => {
      const { m, owner } = await ownedMerchant();
      const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }]);
      const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }]);
      expect((await ctx.api("GET", "/merchants", { token: customer.token })).status).toBe(403);
      expect((await ctx.api("GET", "/merchants", { token: owner.token })).status).toBe(403);
      expect((await ctx.api("GET", `/merchants/${m.id}`, { token: owner.token })).status).toBe(403);
      // Ops can read but not manage.
      expect((await ctx.api("PATCH", `/merchants/${m.id}`, { token: ops.token, body: { status: "SUSPENDED" } })).status).toBe(403);
      expect((await ctx.api("GET", "/merchants")).status).toBe(401);
    });

    it("approves with an SMS, assigns a matching plan and audits", async () => {
      const admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }]);
      const m = await merchant({ status: "PENDING_REVIEW" });
      const ecom = await ctx.prisma.servicePlan.create({ data: { segment: "ECOMMERCE", name: "Starter", monthlyFee: 0, discountPct: 5 } });
      const docs = await ctx.prisma.servicePlan.create({ data: { segment: "BANKING_FINANCIAL", name: "Corporate", monthlyFee: 5000 } });
      const retired = await ctx.prisma.servicePlan.create({ data: { segment: "ECOMMERCE", name: "Legacy", monthlyFee: 100, active: false } });

      const mismatch = await ctx.api("PATCH", `/merchants/${m.id}`, { token: admin.token, body: { planId: docs.id } });
      expect(mismatch.status).toBe(422);
      expect(mismatch.body.error.code).toBe("PLAN_SEGMENT_MISMATCH");
      expect((await ctx.api("PATCH", `/merchants/${m.id}`, { token: admin.token, body: { planId: retired.id } })).body.error.code).toBe("PLAN_INACTIVE");
      expect((await ctx.api("PATCH", `/merchants/${m.id}`, { token: admin.token, body: { planId: "00000000-0000-7000-8000-000000000000" } })).status).toBe(404);
      expect((await ctx.api("PATCH", `/merchants/${m.id}`, { token: admin.token, body: {} })).status).toBe(422);
      expect((await ctx.api("PATCH", `/merchants/${m.id}`, { token: admin.token, body: { status: "OPEN" } })).status).toBe(422);
      expect(await ctx.prisma.outboxMessage.count({ where: { template: "merchant.approved" } })).toBe(0);

      const res = await ctx.api("PATCH", `/merchants/${m.id}`, { token: admin.token, body: { status: "ACTIVE", planId: ecom.id, contactPhone: "01999-888777" } });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ status: "ACTIVE", plan: { id: ecom.id, name: "Starter", discountPct: 5 }, contactPhone: "+8801999888777" });
      const sms = await ctx.prisma.outboxMessage.findFirstOrThrow({ where: { template: "merchant.approved" } });
      expect(sms.to).toBe("+8801999888777");
      expect(sms.body).toContain(m.code);
      expect(await ctx.prisma.auditLog.findFirst({ where: { action: "merchant.approve", entityId: m.id } })).toBeTruthy();

      // Re-saving an active merchant doesn't text again; suspending is audited.
      await ctx.api("PATCH", `/merchants/${m.id}`, { token: admin.token, body: { status: "ACTIVE" } });
      await ctx.api("PATCH", `/merchants/${m.id}`, { token: admin.token, body: { status: "SUSPENDED", planId: null } });
      expect(await ctx.prisma.outboxMessage.count({ where: { template: "merchant.approved" } })).toBe(1);
      expect(await ctx.prisma.auditLog.count({ where: { action: "merchant.suspend", entityId: m.id } })).toBe(1);
      expect((await ctx.prisma.merchant.findUniqueOrThrow({ where: { id: m.id } })).planId).toBeNull();
    });
  });

  // ───────────── self-service ─────────────

  describe("self-service", () => {
    it("shows the merchant to owners and staff but only lets owners edit", async () => {
      const { m, owner } = await ownedMerchant();
      const staff = await userWithRoles(ctx, [{ role: "MERCHANT_STAFF", merchantId: m.id }]);
      const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }]);
      expect((await ctx.api("GET", "/merchants/me", { token: owner.token })).body).toMatchObject({ id: m.id, myRole: "MERCHANT_OWNER" });
      expect((await ctx.api("GET", "/merchants/me", { token: staff.token })).body).toMatchObject({ id: m.id, myRole: "MERCHANT_STAFF" });
      expect((await ctx.api("GET", "/merchants/me", { token: customer.token })).status).toBe(403);
      expect((await ctx.api("PATCH", "/merchants/me", { token: staff.token, body: { contactName: "Staff" } })).status).toBe(403);
      expect((await ctx.api("GET", "/merchants/me/members", { token: staff.token })).status).toBe(403);
      expect((await ctx.api("GET", "/merchants/me/webhooks", { token: staff.token })).status).toBe(403);
    });

    it("updates contact, pickup and payout details with validation", async () => {
      const { m, owner } = await ownedMerchant();
      const res = await ctx.api("PATCH", "/merchants/me", {
        token: owner.token,
        body: { contactName: "New Contact", contactEmail: null, pickupSameAsBusiness: false, pickup: { district: "Dhaka North", zone: "Banani", area: "Banani Block C", street: "House 3, Road 11" }, payoutAccount: { method: "BKASH", accountNumber: "+880 1712-345678", accountName: "Shop Owner" } },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ contactName: "New Contact", contactEmail: null, pickupArea: "Banani Block C", pickup: { zone: "Banani", area: "Banani Block C" }, payoutAccount: { method: "BKASH", accountNumber: "01712345678" } });
      // The existing contact number is told about payout changes.
      const sms = await ctx.prisma.outboxMessage.findFirstOrThrow({ where: { template: "merchant.payout_account_changed" } });
      expect(sms.to).toBe("+8801711111111");
      const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: "merchant.self_update", entityId: m.id } });
      expect(JSON.stringify(audit.data)).not.toContain("01712345678");

      const bank = await ctx.api("PATCH", "/merchants/me", { token: owner.token, body: { payoutAccount: { method: "BANK", accountNumber: "1234-5678-9012", accountName: "Shop Ltd", bankName: "City Bank", branch: "Gulshan" } } });
      expect(bank.body.payoutAccount).toEqual({ method: "BANK", accountNumber: "123456789012", accountName: "Shop Ltd", bankName: "City Bank", branch: "Gulshan" });

      const badWallet = await ctx.api("PATCH", "/merchants/me", { token: owner.token, body: { payoutAccount: { method: "NAGAD", accountNumber: "12345", accountName: "X Y" } } });
      expect(badWallet.status).toBe(422);
      expect(badWallet.body.error.details[0].path).toBe("payoutAccount.accountNumber");
      const noBank = await ctx.api("PATCH", "/merchants/me", { token: owner.token, body: { payoutAccount: { method: "BANK", accountNumber: "12345678", accountName: "X Y" } } });
      expect(noBank.body.error.details.map((d: { path: string }) => d.path)).toContain("payoutAccount.bankName");
      // An optional 9-digit routing number (spaces and dashes ignored).
      const routed = await ctx.api("PATCH", "/merchants/me", { token: owner.token, body: { payoutAccount: { method: "BANK", accountNumber: "123456789012", accountName: "Shop Ltd", bankName: "City Bank", routingNumber: "225 261-725" } } });
      expect(routed.body.payoutAccount).toMatchObject({ routingNumber: "225261725" });
      const badRouting = await ctx.api("PATCH", "/merchants/me", { token: owner.token, body: { payoutAccount: { method: "BANK", accountNumber: "123456789012", accountName: "Shop Ltd", bankName: "City Bank", routingNumber: "1234" } } });
      expect(badRouting.body.error.details.map((d: { path: string }) => d.path)).toContain("payoutAccount.routingNumber");
      expect((await ctx.api("PATCH", "/merchants/me", { token: owner.token, body: { payoutAccount: { method: "PAYPAL" } } })).status).toBe(422);
      expect((await ctx.api("PATCH", "/merchants/me", { token: owner.token, body: {} })).status).toBe(422);

      // Owners can't change admin-controlled fields.
      await ctx.api("PATCH", "/merchants/me", { token: owner.token, body: { contactName: "Again", status: "ACTIVE", planId: null, name: "Hacked" } });
      expect((await ctx.prisma.merchant.findUniqueOrThrow({ where: { id: m.id } })).name).toBe(m.name);

      const cleared = await ctx.api("PATCH", "/merchants/me", { token: owner.token, body: { payoutAccount: null } });
      expect(cleared.body.payoutAccount).toBeNull();
    });

    it("requires ?merchantId= for members of several merchants and checks membership", async () => {
      const a = await merchant({ name: "A" });
      const b = await merchant({ name: "B" });
      const other = await merchant({ name: "C" });
      const u = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: a.id }, { role: "MERCHANT_STAFF", merchantId: b.id }]);
      const ambiguous = await ctx.api("GET", "/merchants/me", { token: u.token });
      expect(ambiguous.status).toBe(422);
      expect(ambiguous.body.error.code).toBe("MERCHANT_REQUIRED");
      expect((await ctx.api("GET", `/merchants/me?merchantId=${b.id}`, { token: u.token })).body).toMatchObject({ name: "B", myRole: "MERCHANT_STAFF" });
      expect((await ctx.api("GET", `/merchants/me?merchantId=${other.id}`, { token: u.token })).status).toBe(403);
      expect((await ctx.api("GET", "/merchants/me?merchantId=xyz", { token: u.token })).status).toBe(422);
      // Owner of A, staff of B: owner-only routes on B are refused.
      expect((await ctx.api("PATCH", `/merchants/me?merchantId=${b.id}`, { token: u.token, body: { contactName: "Nope" } })).status).toBe(403);
      expect((await ctx.api("PATCH", `/merchants/me?merchantId=${a.id}`, { token: u.token, body: { contactName: "Yes" } })).status).toBe(200);
    });
  });

  // ───────────── members ─────────────

  describe("members", () => {
    it("adds existing users, invites new ones, and rejects duplicates", async () => {
      const { m, owner } = await ownedMerchant();
      const existing = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Karim");

      const added = await ctx.api("POST", "/merchants/me/members", { token: owner.token, body: { name: "Ignored", phone: existing.phone, role: "MERCHANT_STAFF" } });
      expect(added.status, JSON.stringify(added.body)).toBe(201);
      expect(added.body).toMatchObject({ invited: false, member: { userId: existing.user.id, name: "Karim", role: "MERCHANT_STAFF" } });

      const invited = await ctx.api("POST", "/merchants/me/members", { token: owner.token, body: { name: "Sumi Akter", phone: "01911-223344", role: "MERCHANT_OWNER" } });
      expect(invited.body).toMatchObject({ invited: true, member: { name: "Sumi Akter", phone: "+8801911223344", role: "MERCHANT_OWNER" } });
      const newUser = await ctx.prisma.user.findUniqueOrThrow({ where: { phone: "+8801911223344" } });
      expect(newUser.passwordHash).toBeNull();
      const invite = await ctx.prisma.outboxMessage.findFirstOrThrow({ where: { template: "account.invite" } });
      expect(invite.to).toBe("+8801911223344");
      expect(invite.body).toContain(m.name);
      expect(await ctx.prisma.outboxMessage.count({ where: { template: "merchant.member_added", to: existing.phone } })).toBe(1);

      const dup = await ctx.api("POST", "/merchants/me/members", { token: owner.token, body: { name: "Karim", phone: existing.phone, role: "MERCHANT_OWNER" } });
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe("ALREADY_A_MEMBER");
      expect((await ctx.api("POST", "/merchants/me/members", { token: owner.token, body: { name: "X", phone: "123", role: "SUPER_ADMIN" } })).status).toBe(422);

      const list = await ctx.api("GET", "/merchants/me/members", { token: owner.token });
      expect(list.body.items).toHaveLength(3);
      expect(await ctx.prisma.auditLog.count({ where: { action: "merchant.member_add", entityId: m.id } })).toBe(2);

      // The invited owner signs in by SMS code and sees the merchant.
      const otp = await ctx.api("POST", "/auth/otp", { body: { phone: "01911223344", purpose: "LOGIN" } });
      const login = await ctx.api("POST", "/auth/login/otp", { body: { phone: "01911223344", otp: otp.body.devCode } });
      expect(login.status, JSON.stringify(login.body)).toBe(200);
      expect((await ctx.api("GET", "/merchants/me", { token: login.body.accessToken })).body.myRole).toBe("MERCHANT_OWNER");
    });

    it("removes members, protects the last owner, and ends the removed user's sessions", async () => {
      const { m, owner } = await ownedMerchant();
      const staff = await userWithRoles(ctx, [{ role: "MERCHANT_STAFF", merchantId: m.id }], "Staff");
      const ownerGrant = await ctx.prisma.userRole.findFirstOrThrow({ where: { userId: owner.user.id, merchantId: m.id } });
      const staffGrant = await ctx.prisma.userRole.findFirstOrThrow({ where: { userId: staff.user.id, merchantId: m.id } });

      const last = await ctx.api("DELETE", `/merchants/me/members/${ownerGrant.id}`, { token: owner.token });
      expect(last.status).toBe(422);
      expect(last.body.error.code).toBe("LAST_OWNER");

      expect((await ctx.api("GET", "/merchants/me", { token: staff.token })).status).toBe(200);
      const removed = await ctx.api("DELETE", `/merchants/me/members/${staffGrant.id}`, { token: owner.token });
      expect(removed.status).toBe(204);
      expect(await ctx.prisma.userRole.findUnique({ where: { id: staffGrant.id } })).toBeNull();
      expect((await ctx.api("GET", "/merchants/me", { token: staff.token })).status).toBe(401);
      expect((await ctx.api("POST", "/auth/refresh", { body: { refreshToken: staff.refreshToken } })).status).toBe(401);
      expect(await ctx.prisma.auditLog.count({ where: { action: "merchant.member_remove" } })).toBe(1);

      expect((await ctx.api("DELETE", `/merchants/me/members/${staffGrant.id}`, { token: owner.token })).status).toBe(404);
      // A grant from another merchant can't be removed from here.
      const { owner: otherOwner } = await ownedMerchant();
      const otherGrant = await ctx.prisma.userRole.findFirstOrThrow({ where: { userId: otherOwner.user.id } });
      expect((await ctx.api("DELETE", `/merchants/me/members/${otherGrant.id}`, { token: owner.token })).status).toBe(404);
    });

    it("lets an owner leave when another owner remains", async () => {
      const { m, owner } = await ownedMerchant();
      const second = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: m.id }], "Second Owner");
      const grant = await ctx.prisma.userRole.findFirstOrThrow({ where: { userId: second.user.id, merchantId: m.id } });
      expect((await ctx.api("DELETE", `/merchants/me/members/${grant.id}`, { token: second.token })).status).toBe(204);
      expect((await ctx.api("GET", "/merchants/me", { token: owner.token })).status).toBe(200);
    });
  });

  // ───────────── API keys ─────────────

  describe("API keys", () => {
    it("creates a key shown once that works on API-key routes until revoked", async () => {
      const { m, owner } = await ownedMerchant();
      const created = await ctx.api("POST", "/merchants/me/api-keys", { token: owner.token, body: { name: "Shopify store" } });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const key = created.body.key as string;
      expect(key).toMatch(/^df_live_[A-Za-z0-9_-]{43}$/);
      expect(created.body.prefix).toBe(key.slice(0, 12));
      const row = await ctx.prisma.apiKey.findUniqueOrThrow({ where: { id: created.body.id } });
      expect(row.keyHash).toBe(sha256(key));
      expect(await ctx.prisma.auditLog.count({ where: { action: "api_key.create", entityId: row.id } })).toBe(1);
      expect(JSON.stringify(await ctx.prisma.auditLog.findMany())).not.toContain(key);

      const list = await ctx.api("GET", "/merchants/me/api-keys", { token: owner.token });
      expect(list.body.items).toEqual([expect.objectContaining({ id: row.id, name: "Shopify store", prefix: row.prefix, revokedAt: null })]);
      expect(JSON.stringify(list.body)).not.toContain(key);
      expect(list.body.items[0]).not.toHaveProperty("keyHash");

      const parcels = await ctx.api("GET", "/parcels", { token: key });
      expect(parcels.status, JSON.stringify(parcels.body)).toBe(200);
      const notAllowed = await ctx.api("GET", "/merchants/me", { token: key });
      expect(notAllowed.status).toBe(403);
      expect((await ctx.api("GET", "/merchants/me/api-keys", { token: key })).status).toBe(403);

      // Suspension stops the key without revoking it.
      await ctx.prisma.merchant.update({ where: { id: m.id }, data: { status: "SUSPENDED" } });
      expect((await ctx.api("GET", "/parcels", { token: key })).status).toBe(403);
      await ctx.prisma.merchant.update({ where: { id: m.id }, data: { status: "ACTIVE" } });

      const revoked = await ctx.api("DELETE", `/merchants/me/api-keys/${row.id}`, { token: owner.token });
      expect(revoked.status).toBe(200);
      expect(revoked.body.revokedAt).toBeTruthy();
      const after = await ctx.api("GET", "/parcels", { token: key });
      expect(after.status).toBe(401);
      expect(after.body.error.code).toBe("INVALID_API_KEY");
      expect(await ctx.prisma.auditLog.count({ where: { action: "api_key.revoke", entityId: row.id } })).toBe(1);
      // Revoking again is a no-op.
      expect((await ctx.api("DELETE", `/merchants/me/api-keys/${row.id}`, { token: owner.token })).status).toBe(200);
      expect(await ctx.prisma.auditLog.count({ where: { action: "api_key.revoke", entityId: row.id } })).toBe(1);
    });

    it("requires an active merchant and an owner", async () => {
      const { m, owner } = await ownedMerchant("PENDING_REVIEW");
      const pending = await ctx.api("POST", "/merchants/me/api-keys", { token: owner.token, body: { name: "Too early" } });
      expect(pending.status).toBe(403);
      expect(pending.body.error.code).toBe("MERCHANT_NOT_ACTIVE");
      expect((await ctx.api("GET", "/merchants/me/api-keys", { token: owner.token })).status).toBe(403);
      const staff = await userWithRoles(ctx, [{ role: "MERCHANT_STAFF", merchantId: m.id }]);
      expect((await ctx.api("POST", "/merchants/me/api-keys", { token: staff.token, body: { name: "Staff key" } })).status).toBe(403);
    });

    it("enforces the active-key limit, validates expiry and scopes keys to the merchant", async () => {
      const { m, owner } = await ownedMerchant();
      expect((await ctx.api("POST", "/merchants/me/api-keys", { token: owner.token, body: { name: "Old", expiresAt: "2020-01-01" } })).status).toBe(422);
      expect((await ctx.api("POST", "/merchants/me/api-keys", { token: owner.token, body: { name: "" } })).status).toBe(422);

      // Expired and revoked keys don't count.
      await ctx.prisma.apiKey.create({ data: { merchantId: m.id, name: "expired", prefix: "df_live_exp1", keyHash: "h-exp", expiresAt: new Date(Date.now() - 1000) } });
      await ctx.prisma.apiKey.create({ data: { merchantId: m.id, name: "revoked", prefix: "df_live_rev1", keyHash: "h-rev", revokedAt: new Date() } });
      const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
      const results = await Promise.all(Array.from({ length: 11 }, (_, i) => ctx.api("POST", "/merchants/me/api-keys", { token: owner.token, body: { name: `Key ${i}`, expiresAt } })));
      expect(results.filter(r => r.status === 201)).toHaveLength(10);
      const rejected = results.find(r => r.status !== 201)!;
      expect(rejected.status).toBe(422);
      expect(rejected.body.error.code).toBe("API_KEY_LIMIT");
      expect(results.find(r => r.status === 201)!.body.expiresAt).toBe(expiresAt);

      const page = await ctx.api("GET", "/merchants/me/api-keys?limit=5", { token: owner.token });
      expect(page.body.items).toHaveLength(5);
      expect(page.body.nextCursor).toBeTruthy();

      const { owner: otherOwner } = await ownedMerchant();
      const someKey = results.find(r => r.status === 201)!.body.id;
      expect((await ctx.api("DELETE", `/merchants/me/api-keys/${someKey}`, { token: otherOwner.token })).status).toBe(404);
    });
  });

  // ───────────── webhooks ─────────────

  describe("webhooks", () => {
    let server: Server | undefined;
    afterEach(() => new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve())).then(() => (server = undefined)));

    const receiver = async () => {
      const received: { headers: IncomingHttpHeaders; body: string }[] = [];
      server = createServer((req, res) => {
        let body = "";
        req.on("data", chunk => (body += chunk));
        req.on("end", () => {
          received.push({ headers: req.headers, body });
          res.writeHead(200).end("ok");
        });
      });
      await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", () => resolve()));
      return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks`, received };
    };

    it("registers an endpoint with a one-time secret and delivers signed test events", async () => {
      const { m, owner } = await ownedMerchant();
      const { url, received } = await receiver();
      const created = await ctx.api("POST", "/merchants/me/webhooks", { token: owner.token, body: { url, events: ["shipment.delivered", "pickup.requested", "shipment.delivered"] } });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body).toMatchObject({ url, events: ["shipment.delivered", "pickup.requested"], active: true });
      const secret = created.body.secret as string;
      expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{32}$/);
      const row = await ctx.prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: created.body.id } });
      expect(row.secretEncrypted).not.toContain(secret);
      expect(decrypt(row.secretEncrypted)).toBe(secret);

      const list = await ctx.api("GET", "/merchants/me/webhooks", { token: owner.token });
      expect(list.body.items).toHaveLength(1);
      expect(JSON.stringify(list.body)).not.toContain(secret);
      expect(list.body.items[0]).not.toHaveProperty("secretEncrypted");

      const test = await ctx.api("POST", `/merchants/me/webhooks/${row.id}/test`, { token: owner.token });
      expect(test.status, JSON.stringify(test.body)).toBe(202);
      expect(test.body).toMatchObject({ event: "webhook.test", state: "PENDING", attempts: 0 });

      await ctx.app.get(WebhooksService).deliver(test.body.id);
      expect(received).toHaveLength(1);
      const { headers, body } = received[0];
      expect(headers["x-deliveryfast-event"]).toBe("webhook.test");
      const [, t, v1] = String(headers["x-deliveryfast-signature"]).match(/^t=(\d+),v1=([0-9a-f]{64})$/)!;
      expect(v1).toBe(hmacSha256(secret, `${t}.${body}`));
      expect(Math.abs(Number(t) - Date.now() / 1000)).toBeLessThan(60);
      expect(JSON.parse(body)).toMatchObject({ id: test.body.id, event: "webhook.test", data: { merchantCode: m.code } });

      const deliveries = await ctx.api("GET", `/merchants/me/webhooks/${row.id}/deliveries`, { token: owner.token });
      expect(deliveries.body.items).toEqual([expect.objectContaining({ id: test.body.id, event: "webhook.test", state: "SUCCEEDED", attempts: 1, responseCode: 200, lastError: null })]);
      expect(deliveries.body.items[0].deliveredAt).toBeTruthy();
      expect(deliveries.body.items[0]).not.toHaveProperty("payload");
      expect((await ctx.api("GET", `/merchants/me/webhooks/${row.id}/deliveries?state=FAILED`, { token: owner.token })).body.items).toHaveLength(0);

      // Rotating changes the signing secret.
      const rotated = await ctx.api("POST", `/merchants/me/webhooks/${row.id}/rotate-secret`, { token: owner.token });
      expect(rotated.status).toBe(200);
      expect(rotated.body.secret).not.toBe(secret);
      const second = await ctx.api("POST", `/merchants/me/webhooks/${row.id}/test`, { token: owner.token });
      await ctx.app.get(WebhooksService).deliver(second.body.id);
      const sig = String(received[1].headers["x-deliveryfast-signature"]).match(/^t=(\d+),v1=(\w+)$/)!;
      expect(sig[2]).toBe(hmacSha256(rotated.body.secret, `${sig[1]}.${received[1].body}`));
      expect(await ctx.prisma.auditLog.count({ where: { entityId: row.id, action: { in: ["webhook.create", "webhook.test", "webhook.rotate_secret"] } } })).toBe(4);
    });

    it("updates, deactivates and deletes endpoints", async () => {
      const { owner } = await ownedMerchant();
      const created = await ctx.api("POST", "/merchants/me/webhooks", { token: owner.token, body: { url: "https://example.com/a", events: ["pickup.requested"] } });
      const id = created.body.id;
      const updated = await ctx.api("PATCH", `/merchants/me/webhooks/${id}`, { token: owner.token, body: { url: "https://example.com/b", events: ["shipment.cancelled"], active: false } });
      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({ url: "https://example.com/b", events: ["shipment.cancelled"], active: false });
      expect(updated.body).not.toHaveProperty("secret");
      const inactive = await ctx.api("POST", `/merchants/me/webhooks/${id}/test`, { token: owner.token });
      expect(inactive.status).toBe(422);
      expect(inactive.body.error.code).toBe("WEBHOOK_INACTIVE");
      expect((await ctx.api("PATCH", `/merchants/me/webhooks/${id}`, { token: owner.token, body: { events: [] } })).status).toBe(422);
      expect((await ctx.api("PATCH", `/merchants/me/webhooks/${id}`, { token: owner.token, body: {} })).status).toBe(422);

      expect((await ctx.api("DELETE", `/merchants/me/webhooks/${id}`, { token: owner.token })).status).toBe(204);
      expect(await ctx.prisma.webhookEndpoint.count()).toBe(0);
      expect((await ctx.api("PATCH", `/merchants/me/webhooks/${id}`, { token: owner.token, body: { active: true } })).status).toBe(404);
      expect(await ctx.prisma.auditLog.count({ where: { entityId: id, action: { in: ["webhook.update", "webhook.delete"] } } })).toBe(2);
    });

    it("validates url and events, limits endpoints and scopes them to the merchant", async () => {
      const { owner } = await ownedMerchant();
      const badUrl = await ctx.api("POST", "/merchants/me/webhooks", { token: owner.token, body: { url: "not a url", events: ["pickup.requested"] } });
      expect(badUrl.status).toBe(422);
      expect(badUrl.body.error.code).toBe("INVALID_WEBHOOK_URL");
      const badEvent = await ctx.api("POST", "/merchants/me/webhooks", { token: owner.token, body: { url: "https://example.com", events: ["parcel.exploded"] } });
      expect(badEvent.status).toBe(422);
      expect(badEvent.body.error.details[0].message).toContain("pickup.requested");
      expect((await ctx.api("POST", "/merchants/me/webhooks", { token: owner.token, body: { url: "https://example.com", events: [] } })).status).toBe(422);

      const results = await Promise.all(Array.from({ length: 6 }, (_, i) => ctx.api("POST", "/merchants/me/webhooks", { token: owner.token, body: { url: `https://example.com/${i}`, events: ["pickup.requested"] } })));
      expect(results.filter(r => r.status === 201)).toHaveLength(5);
      expect(results.find(r => r.status !== 201)!.body.error.code).toBe("WEBHOOK_LIMIT");

      const { owner: otherOwner } = await ownedMerchant();
      const id = results.find(r => r.status === 201)!.body.id;
      for (const [method, path] of [
        ["PATCH", `/merchants/me/webhooks/${id}`],
        ["DELETE", `/merchants/me/webhooks/${id}`],
        ["POST", `/merchants/me/webhooks/${id}/rotate-secret`],
        ["POST", `/merchants/me/webhooks/${id}/test`],
        ["GET", `/merchants/me/webhooks/${id}/deliveries`],
      ])
        expect((await ctx.api(method, path, { token: otherOwner.token, body: method === "PATCH" ? { active: false } : undefined })).status).toBe(404);
      expect((await ctx.api("GET", "/merchants/me/webhooks", { token: otherOwner.token })).body.items).toHaveLength(0);
    });
  });

  // ───────────── plans ─────────────

  describe("plans", () => {
    it("lets config managers create and edit plans, and anyone list active ones", async () => {
      const admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }]);
      const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }]);
      const body = { segment: "ECOMMERCE", name: "Growth", monthlyFee: 1499.5, discountPct: 12.5, features: ["Priority pickup", "Weekly payouts"] };
      const created = await ctx.api("POST", "/plans", { token: admin.token, body });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body).toMatchObject({ ...body, active: true });
      expect((await ctx.api("POST", "/plans", { token: admin.token, body: { ...body, name: "growth" } })).body.error.code).toBe("PLAN_NAME_TAKEN");
      await ctx.api("POST", "/plans", { token: admin.token, body: { segment: "BANKING_FINANCIAL", name: "Corporate", monthlyFee: 5000 } });
      const retired = await ctx.api("POST", "/plans", { token: admin.token, body: { segment: "ECOMMERCE", name: "Legacy", monthlyFee: 0, active: false } });

      const visible = await ctx.api("GET", "/plans?segment=ECOMMERCE", { token: customer.token });
      expect(visible.body.map((p: { name: string }) => p.name)).toEqual(["Growth"]);
      expect((await ctx.api("GET", "/plans", { token: customer.token })).body).toHaveLength(2);
      expect((await ctx.api("GET", "/plans?includeInactive=true", { token: customer.token })).status).toBe(403);
      expect((await ctx.api("GET", "/plans?includeInactive=true", { token: admin.token })).body).toHaveLength(3);
      expect((await ctx.api("GET", "/plans?segment=VIP", { token: customer.token })).status).toBe(422);
      expect((await ctx.api("GET", "/plans")).status).toBe(401);

      const patched = await ctx.api("PATCH", `/plans/${retired.body.id}`, { token: admin.token, body: { active: true, discountPct: 3 } });
      expect(patched.body).toMatchObject({ active: true, discountPct: 3 });
      expect(await ctx.prisma.auditLog.count({ where: { action: { in: ["plan.create", "plan.update"] } } })).toBe(4);
    });

    it("validates plans, guards segment changes and requires config:manage", async () => {
      const admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }]);
      const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }]);
      const bad = await ctx.api("POST", "/plans", { token: admin.token, body: { segment: "ECOMMERCE", name: "X", monthlyFee: -1, discountPct: 101, features: [""] } });
      expect(bad.status).toBe(422);
      expect(bad.body.error.details.map((d: { path: string }) => d.path)).toEqual(expect.arrayContaining(["name", "monthlyFee", "discountPct", "features.0"]));
      const ok = { segment: "ECOMMERCE", name: "Starter", monthlyFee: 0 };
      expect((await ctx.api("POST", "/plans", { token: ops.token, body: ok })).status).toBe(403);
      const plan = await ctx.api("POST", "/plans", { token: admin.token, body: ok });
      expect((await ctx.api("PATCH", `/plans/${plan.body.id}`, { token: ops.token, body: { active: false } })).status).toBe(403);

      const m = await merchant();
      await ctx.prisma.merchant.update({ where: { id: m.id }, data: { planId: plan.body.id } });
      const segment = await ctx.api("PATCH", `/plans/${plan.body.id}`, { token: admin.token, body: { segment: "BANKING_FINANCIAL" } });
      expect(segment.status).toBe(422);
      expect(segment.body.error.code).toBe("PLAN_IN_USE");
      expect((await ctx.api("PATCH", "/plans/00000000-0000-7000-8000-000000000000", { token: admin.token, body: { active: false } })).status).toBe(404);
    });
  });
});
