import { resetDatabase, startApp, userWithRoles, type TestContext } from "./helpers";

/**
 * A merchant that isn't active (under review, information requested, not approved, suspended) may read only its
 * own account, its business verification and the review conversation, and upload / submit verification
 * documents. Everything else — profile changes, team, products, pickups, stats, quotes, the package — is refused
 * with MERCHANT_NOT_ACTIVE until Paira Express approves it.
 */
describe("inactive merchant accounts", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

  async function merchant(status: "PENDING_REVIEW" | "INFO_REQUESTED" | "REJECTED" | "SUSPENDED" | "ACTIVE") {
    const m = await ctx.prisma.merchant.create({
      data: { code: `MR-IN-${status}`, type: "ECOMMERCE", name: `Shop ${status}`, status, contactName: "Owner", contactPhone: "+8801711111111", pickupAddress: "House 5 Road 2", pickupArea: "Gulshan", pickupDistrict: "Dhaka North" },
    });
    const owner = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: m.id }], "Owner");
    return { m, owner };
  }

  it("under review: reads its account, verification and review; uploads documents; nothing else", async () => {
    const { owner } = await merchant("PENDING_REVIEW");
    const get = (path: string) => ctx.api("GET", path, { token: owner.token });
    expect((await get("/merchants/me")).body).toMatchObject({ status: "PENDING_REVIEW", name: "Shop PENDING_REVIEW" });
    expect((await get("/merchants/me/kyc")).status).toBe(200);
    expect((await get("/merchants/me/review")).status).toBe(200);
    const upload = await ctx.api("POST", "/merchants/me/kyc/documents", { token: owner.token, body: { type: "TRADE_LICENSE", filename: "license.png", file: PNG } });
    expect(upload.status, JSON.stringify(upload.body)).toBeLessThan(300);

    const refused = [
      await ctx.api("PATCH", "/merchants/me", { token: owner.token, body: { contactName: "Someone else" } }),
      await get("/merchants/me/members"),
      await get("/merchants/me/stats"),
      await get("/merchants/me/products"),
      await get("/merchants/me/plan"),
      await get("/packages/me"),
    ];
    for (const res of refused) {
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error.code).toBe("MERCHANT_NOT_ACTIVE");
    }
    expect(refused[0].body.error.message).toMatch(/isn't verified yet/);
    // The profile wasn't changed.
    expect((await get("/merchants/me")).body.contactName).toBe("Owner");
  });

  it("suspended merchants are refused too, with their own message; active merchants are not", async () => {
    const suspended = await merchant("SUSPENDED");
    const res = await ctx.api("GET", "/merchants/me/stats", { token: suspended.owner.token });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: "MERCHANT_NOT_ACTIVE", details: { status: "SUSPENDED" } });
    expect(res.body.error.message).toMatch(/suspended/);
    const active = await merchant("ACTIVE");
    expect((await ctx.api("GET", "/merchants/me/stats", { token: active.owner.token })).status).toBe(200);
    expect((await ctx.api("GET", "/packages/me", { token: active.owner.token })).status).toBe(200);
  });
});
