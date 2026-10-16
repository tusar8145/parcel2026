import { resetDatabase, startApp, userWithRoles, type TestContext } from "./helpers";

const PNG = `data:image/png;base64,${Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64")}`;

/** Merchant administration: KYC, rejection, information requests, invitations, notes and API key scopes. */
describe("merchant administration", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  let seq = 0;
  const merchant = (status: "PENDING_REVIEW" | "ACTIVE" = "ACTIVE", kycStatus: "NOT_SUBMITTED" | "APPROVED" = "NOT_SUBMITTED") =>
    ctx.prisma.merchant.create({
      data: {
        code: `MR-A${++seq}`,
        type: "ECOMMERCE",
        name: `Admin Shop ${seq}`,
        status,
        kycStatus,
        contactName: "Owner",
        contactPhone: "+8801711111111",
        pickupAddress: "Road 1",
        pickupArea: "Gulshan",
        pickupDistrict: "Dhaka North",
      },
    });
  const owned = async (status: "PENDING_REVIEW" | "ACTIVE" = "ACTIVE", kycStatus: "NOT_SUBMITTED" | "APPROVED" = "NOT_SUBMITTED") => {
    const m = await merchant(status, kycStatus);
    const owner = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: m.id }], "Shop Owner");
    return { m, owner };
  };
  const admin = () => userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Admin");
  const outboxEvents = async () => (await ctx.prisma.outboxMessage.findMany({ select: { template: true } })).map(o => o.template);

  describe("KYC", () => {
    it("uploads documents, submits, and a super admin approves; API keys need approved KYC", async () => {
      const { m, owner } = await owned();
      const sa = await admin();

      const blocked = await ctx.api("POST", "/merchants/me/api-keys", { token: owner.token, body: { name: "Store" } });
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.code).toBe("KYC_REQUIRED");

      const empty = await ctx.api("GET", "/merchants/me/kyc", { token: owner.token });
      expect(empty.body).toMatchObject({ status: "NOT_SUBMITTED", canSubmit: false });
      expect(empty.body.missing).toEqual(["TRADE_LICENSE", "NID_FRONT", "NID_BACK", "PAYOUT_PROOF"]);

      const early = await ctx.api("POST", "/merchants/me/kyc/submit", { token: owner.token });
      expect(early.status).toBe(422);
      expect(early.body.error.code).toBe("KYC_INCOMPLETE");

      const bad = await ctx.api("POST", "/merchants/me/kyc/documents", { token: owner.token, body: { type: "TRADE_LICENSE", filename: "x.exe", file: "data:application/x-msdownload;base64,AAAA" } });
      expect(bad.status).toBe(422);

      for (const type of ["TRADE_LICENSE", "NID_FRONT", "NID_BACK", "PAYOUT_PROOF", "TRADE_LICENSE"]) {
        const up = await ctx.api("POST", "/merchants/me/kyc/documents", { token: owner.token, body: { type, filename: `${type}.png`, file: PNG } });
        expect(up.status, JSON.stringify(up.body)).toBe(201);
      }
      // The second trade license replaced the first (history kept).
      expect(await ctx.prisma.merchantKycDocument.count({ where: { merchantId: m.id } })).toBe(5);
      const ready = await ctx.api("GET", "/merchants/me/kyc", { token: owner.token });
      expect(ready.body.documents).toHaveLength(4);
      expect(ready.body.canSubmit).toBe(true);

      const submitted = await ctx.api("POST", "/merchants/me/kyc/submit", { token: owner.token });
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
      expect(submitted.body.status).toBe("PENDING");
      expect((await ctx.api("POST", "/merchants/me/kyc/submit", { token: owner.token })).body.error.code).toBe("KYC_PENDING");

      // Staff see the queue and the files.
      const queue = await ctx.api("GET", "/merchants?kycStatus=PENDING", { token: sa.token });
      expect(queue.body.items.map((x: { id: string }) => x.id)).toEqual([m.id]);
      const review = await ctx.api("GET", `/merchants/${m.id}/kyc`, { token: sa.token });
      const doc = review.body.documents[0];
      const file = await ctx.api("GET", `/merchants/${m.id}/kyc/documents/${doc.id}`, { token: sa.token });
      expect(file.body.dataUrl).toBe(PNG);
      // Other merchants can't read them.
      const { owner: stranger } = await owned();
      expect((await ctx.api("GET", `/merchants/me/kyc/documents/${doc.id}`, { token: stranger.token })).status).toBe(404);
      expect((await ctx.api("POST", `/merchants/${m.id}/kyc/review`, { token: owner.token, body: { decision: "APPROVE" } })).status).toBe(403);

      const rejected = await ctx.api("POST", `/merchants/${m.id}/kyc/review`, { token: sa.token, body: { decision: "REJECT", reason: "NID photo is blurry" } });
      expect(rejected.body).toMatchObject({ status: "REJECTED", rejectionReason: "NID photo is blurry" });
      expect((await ctx.api("POST", "/merchants/me/kyc/submit", { token: owner.token })).status).toBe(200);
      const approved = await ctx.api("POST", `/merchants/${m.id}/kyc/review`, { token: sa.token, body: { decision: "APPROVE" } });
      expect(approved.body.status).toBe("APPROVED");
      expect((await outboxEvents()).filter(t => t === "merchant.kyc_status").length).toBeGreaterThanOrEqual(3);
      expect(await ctx.prisma.auditLog.count({ where: { action: { in: ["merchant.kyc_approve", "merchant.kyc_reject", "merchant.kyc_submit"] } } })).toBe(4);

      // Verified documents are locked; API keys now work.
      expect((await ctx.api("POST", "/merchants/me/kyc/documents", { token: owner.token, body: { type: "TIN_BIN", filename: "t.png", file: PNG } })).status).toBe(409);
      expect((await ctx.api("POST", "/merchants/me/api-keys", { token: owner.token, body: { name: "Store" } })).status).toBe(201);
    });

    it("lets a super admin change the policy (API keys free, activation gated)", async () => {
      const sa = await admin();
      const policy = await ctx.api("PUT", "/merchants/kyc-policy", {
        token: sa.token,
        body: { requireForApiKeys: false, requireForCodPayouts: true, requireForActivation: true, requiredDocuments: ["TRADE_LICENSE"] },
      });
      expect(policy.status, JSON.stringify(policy.body)).toBe(200);
      const { owner } = await owned();
      expect((await ctx.api("POST", "/merchants/me/api-keys", { token: owner.token, body: { name: "Store" } })).status).toBe(201);
      const pending = await merchant("PENDING_REVIEW");
      const activate = await ctx.api("PATCH", `/merchants/${pending.id}`, { token: sa.token, body: { status: "ACTIVE" } });
      expect(activate.status).toBe(403);
      expect(activate.body.error.code).toBe("KYC_REQUIRED");
      const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }]);
      expect((await ctx.api("PUT", "/merchants/kyc-policy", { token: ops.token, body: policy.body })).status).toBe(403);
    });
  });

  describe("application review", () => {
    it("rejects with a reason, asks for information and takes the applicant's answer", async () => {
      const sa = await admin();
      const { m, owner } = await owned("PENDING_REVIEW");

      const ask = await ctx.api("POST", `/merchants/${m.id}/request-info`, { token: sa.token, body: { message: "Please upload a clearer trade licence" } });
      expect(ask.status, JSON.stringify(ask.body)).toBe(200);
      expect(ask.body.status).toBe("INFO_REQUESTED");
      const mine = await ctx.api("GET", "/merchants/me/review", { token: owner.token });
      expect(mine.body).toMatchObject({ status: "INFO_REQUESTED", canRespond: true });
      expect(mine.body.messages[0]).toMatchObject({ kind: "INFO_REQUEST", author: "Delivery Fast", body: "Please upload a clearer trade licence" });

      const answer = await ctx.api("POST", "/merchants/me/review/respond", { token: owner.token, body: { message: "Uploaded a new scan" } });
      expect(answer.body.status).toBe("PENDING_REVIEW");
      expect((await ctx.api("POST", "/merchants/me/review/respond", { token: owner.token, body: { message: "again" } })).status).toBe(409);

      // Internal notes are visible to staff only.
      await ctx.api("POST", `/merchants/${m.id}/notes`, { token: sa.token, body: { body: "Called the owner, documents look fine" } });
      const notes = await ctx.api("GET", `/merchants/${m.id}/notes`, { token: sa.token });
      expect(notes.body.items.map((n: { kind: string }) => n.kind).sort()).toEqual(["APPLICANT_RESPONSE", "INFO_REQUEST", "NOTE"]);
      expect(notes.body.items.find((n: { kind: string }) => n.kind === "NOTE")).toMatchObject({ author: "Admin", internal: true });
      const applicantView = await ctx.api("GET", "/merchants/me/review", { token: owner.token });
      expect(JSON.stringify(applicantView.body)).not.toContain("Called the owner");

      const rejected = await ctx.api("POST", `/merchants/${m.id}/reject`, { token: sa.token, body: { reason: "Trade licence could not be verified" } });
      expect(rejected.body).toMatchObject({ status: "REJECTED", rejectionReason: "Trade licence could not be verified" });
      expect((await ctx.api("POST", `/merchants/${m.id}/reject`, { token: sa.token, body: { reason: "Again and again" } })).status).toBe(409);
      expect(await outboxEvents()).toEqual(expect.arrayContaining(["merchant.info_requested", "merchant.rejected"]));
      // PATCH can't set REJECTED (it needs a reason).
      expect((await ctx.api("PATCH", `/merchants/${m.id}`, { token: sa.token, body: { status: "REJECTED" } })).status).toBe(422);

      // A rejected applicant may apply again.
      const again = await ctx.api("POST", "/merchants/applications", {
        token: owner.token,
        body: { type: "ECOMMERCE", name: "Second try", contactName: "Owner", contactPhone: "01711111111", pickupAddress: "House 1, Road 2", pickupArea: "Gulshan", pickupDistrict: "Dhaka North" },
      });
      expect(again.status, JSON.stringify(again.body)).toBe(201);
    });

    it("invites a merchant with a one-time link that prefills and is used up by the application", async () => {
      const sa = await admin();
      const invited = await ctx.api("POST", "/merchants/invites", { token: sa.token, body: { name: "Karim Store", businessName: "Karim Gadgets", phone: "01912345678", type: "ECOMMERCE" } });
      expect(invited.status, JSON.stringify(invited.body)).toBe(201);
      expect(invited.body.status).toBe("PENDING");
      const token = new URL(invited.body.link.replace("#/", "")).searchParams.get("invite")!;
      expect((await outboxEvents()).filter(t => t === "account.invite")).toHaveLength(1);
      expect((await ctx.api("POST", "/merchants/invites", { token: sa.token, body: { name: "Dup", phone: "+8801912345678" } })).body.error.code).toBe("INVITE_PENDING");

      const lookup = await ctx.api("POST", "/merchants/invites/lookup", { body: { token } });
      expect(lookup.body).toMatchObject({ name: "Karim Store", businessName: "Karim Gadgets", type: "ECOMMERCE" });
      expect((await ctx.api("POST", "/merchants/invites/lookup", { body: { token: "nope-nope-nope" } })).status).toBe(404);

      const applicant = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Karim");
      const app = await ctx.api("POST", "/merchants/applications", {
        token: applicant.token,
        body: { type: "ECOMMERCE", name: "Karim Gadgets", contactName: "Karim", contactPhone: "01912345678", pickupAddress: "House 3, Road 4", pickupArea: "Uttara", pickupDistrict: "Dhaka North", inviteToken: token },
      });
      expect(app.status, JSON.stringify(app.body)).toBe(201);
      const list = await ctx.api("GET", "/merchants/invites?status=ACCEPTED", { token: sa.token });
      expect(list.body.items[0]).toMatchObject({ status: "ACCEPTED", merchantId: app.body.merchant.id });
      expect((await ctx.api("POST", "/merchants/invites/lookup", { body: { token } })).body.error.code).toBe("INVITE_USED");
    });
  });

  describe("API key scopes", () => {
    it("limits a scoped key to its scopes; keys without scopes keep the original access", async () => {
      const { owner } = await owned("ACTIVE", "APPROVED");
      const readOnly = await ctx.api("POST", "/merchants/me/api-keys", { token: owner.token, body: { name: "Reporting", scopes: ["parcels:read"] } });
      expect(readOnly.status, JSON.stringify(readOnly.body)).toBe(201);
      expect(readOnly.body.scopes).toEqual(["parcels:read"]);
      const key = readOnly.body.key;
      expect((await ctx.api("GET", "/parcels", { token: key })).status).toBe(200);
      const book = await ctx.api("POST", "/parcels", { token: key, body: {} });
      expect(book.status).toBe(403);
      expect((await ctx.api("GET", "/merchants/me/webhooks", { token: key })).status).toBe(403);

      const hooks = await ctx.api("POST", "/merchants/me/api-keys", { token: owner.token, body: { name: "Hooks", scopes: ["webhooks:manage"] } });
      expect((await ctx.api("GET", "/merchants/me/webhooks", { token: hooks.body.key })).status).toBe(200);
      expect((await ctx.api("GET", "/parcels", { token: hooks.body.key })).status).toBe(403);
      // Other self-service routes stay closed to keys.
      expect((await ctx.api("GET", "/merchants/me/members", { token: hooks.body.key })).status).toBe(403);

      const legacy = await ctx.api("POST", "/merchants/me/api-keys", { token: owner.token, body: { name: "Full" } });
      expect(legacy.body.scopes).toEqual([]);
      expect((await ctx.api("GET", "/parcels", { token: legacy.body.key })).status).toBe(200);
      expect((await ctx.api("GET", "/merchants/me/webhooks", { token: legacy.body.key })).status).toBe(403);
      expect((await ctx.api("POST", "/merchants/me/api-keys", { token: owner.token, body: { name: "Bad", scopes: ["admin:all"] } })).status).toBe(422);
    });
  });
});
