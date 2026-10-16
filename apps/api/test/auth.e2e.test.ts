import { RedisService } from "../src/common/redis.service";
import { PASSWORD, resetDatabase, startApp, userWithRoles, type TestContext } from "./helpers";

describe("auth", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  const signup = async (phone = "01712345678") => {
    const otp = await ctx.api("POST", "/auth/otp", { body: { phone, purpose: "SIGNUP" } });
    expect(otp.status).toBe(200);
    return ctx.api("POST", "/auth/signup", {
      body: { name: "Rahim Uddin", phone, email: "rahim@example.com", password: PASSWORD, otp: otp.body.devCode },
    });
  };

  it("signs up with a verified phone, then reads /me", async () => {
    const res = await signup();
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ name: "Rahim Uddin", phone: "+8801712345678", roles: ["CUSTOMER"], panel: "/account" });
    expect(res.headers["set-cookie"]).toContain("df_rt=");
    expect(String(res.headers["set-cookie"])).toContain("HttpOnly");

    const me = await ctx.api("GET", "/auth/me", { token: res.body.accessToken });
    expect(me.status).toBe(200);
    expect(me.body.email).toBe("rahim@example.com");
  });

  it("rejects a wrong sign-up code and limits attempts", async () => {
    await ctx.api("POST", "/auth/otp", { body: { phone: "01712345678", purpose: "SIGNUP" } });
    const body = { name: "X Y", phone: "01712345678", password: PASSWORD, otp: "000000" };
    for (let i = 0; i < 5; i++) expect((await ctx.api("POST", "/auth/signup", { body })).body.error.code).toBe("INVALID_CODE");
    expect(await ctx.prisma.user.count()).toBe(0);
  });

  it("doesn't reveal whether a number is registered", async () => {
    await signup();
    await ctx.app.get(RedisService).flushdb(); // past the resend cooldown
    const existing = await ctx.api("POST", "/auth/otp", { body: { phone: "01712345678", purpose: "SIGNUP" } });
    const unknown = await ctx.api("POST", "/auth/otp", { body: { phone: "01912345678", purpose: "LOGIN" } });
    expect(existing.body.message).toBe(unknown.body.message);
    expect(existing.body.devCode).toBeUndefined();
    expect(unknown.body.devCode).toBeUndefined();
  });

  it("enforces the resend cooldown", async () => {
    await ctx.api("POST", "/auth/otp", { body: { phone: "01712345678", purpose: "SIGNUP" } });
    const again = await ctx.api("POST", "/auth/otp", { body: { phone: "01712345678", purpose: "SIGNUP" } });
    expect(again.status).toBe(429);
  });

  it("logs in with password by phone or email and locks after 5 failures", async () => {
    await signup();
    expect((await ctx.api("POST", "/auth/login", { body: { identifier: "01712-345678", password: PASSWORD } })).status).toBe(200);
    expect((await ctx.api("POST", "/auth/login", { body: { identifier: "RAHIM@example.com", password: PASSWORD } })).status).toBe(200);

    for (let i = 0; i < 5; i++) {
      const res = await ctx.api("POST", "/auth/login", { body: { identifier: "01712345678", password: "wrong-password-1" } });
      expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
    }
    const locked = await ctx.api("POST", "/auth/login", { body: { identifier: "01712345678", password: PASSWORD } });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe("ACCOUNT_LOCKED");
  });

  it("gives the same error for unknown users and wrong passwords", async () => {
    await signup();
    const unknown = await ctx.api("POST", "/auth/login", { body: { identifier: "01999999999", password: PASSWORD } });
    const wrong = await ctx.api("POST", "/auth/login", { body: { identifier: "01712345678", password: "nope-nope-1" } });
    expect(unknown.body.error).toMatchObject({ code: "INVALID_CREDENTIALS" });
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it("logs in with an SMS code", async () => {
    await signup();
    const otp = await ctx.api("POST", "/auth/otp", { body: { phone: "01712345678", purpose: "LOGIN" } });
    const res = await ctx.api("POST", "/auth/login/otp", { body: { phone: "01712345678", otp: otp.body.devCode } });
    expect(res.status).toBe(200);
    expect(res.body.user.roles).toEqual(["CUSTOMER"]);
  });

  it("rotates refresh tokens and revokes the family when an old one is reused", async () => {
    const first = (await signup()).body;
    const second = await ctx.api("POST", "/auth/refresh", { body: { refreshToken: first.refreshToken } });
    expect(second.status).toBe(200);
    expect(second.body.refreshToken).not.toBe(first.refreshToken);

    // Replaying the first token signals theft: everything in the family is revoked.
    expect((await ctx.api("POST", "/auth/refresh", { body: { refreshToken: first.refreshToken } })).status).toBe(401);
    expect((await ctx.api("POST", "/auth/refresh", { body: { refreshToken: second.body.refreshToken } })).status).toBe(401);
    const me = await ctx.api("GET", "/auth/me", { token: second.body.accessToken });
    expect(me.body.error.code).toBe("SESSION_REVOKED");
  });

  it("requires the client header when refreshing from a cookie", async () => {
    const first = await signup();
    const cookie = String(first.headers["set-cookie"]).split(";")[0];
    expect((await ctx.api("POST", "/auth/refresh", { headers: { cookie } })).status).toBe(400);
    const ok = await ctx.api("POST", "/auth/refresh", { headers: { cookie, "x-df-client": "web" } });
    expect(ok.status).toBe(200);
    expect(ok.body.refreshToken).toBeUndefined(); // browsers only get the httpOnly cookie
  });

  it("logs out and the access token stops working", async () => {
    const { body } = await signup();
    await ctx.api("POST", "/auth/logout", { body: { refreshToken: body.refreshToken } });
    expect((await ctx.api("GET", "/auth/me", { token: body.accessToken })).status).toBe(401);
  });

  it("resets the password with a code and signs out other sessions", async () => {
    const { body } = await signup();
    const otp = await ctx.api("POST", "/auth/otp", { body: { phone: "01712345678", purpose: "PASSWORD_RESET" } });
    const reset = await ctx.api("POST", "/auth/password/reset", { body: { phone: "01712345678", otp: otp.body.devCode, password: "BrandNewPass99" } });
    expect(reset.status).toBe(200);
    expect((await ctx.api("GET", "/auth/me", { token: body.accessToken })).status).toBe(401);
    expect((await ctx.api("POST", "/auth/login", { body: { identifier: "01712345678", password: "BrandNewPass99" } })).status).toBe(200);
  });

  it("validates input with field-level messages", async () => {
    const res = await ctx.api("POST", "/auth/signup", { body: { name: "A", phone: "12345", password: "short", otp: "1" } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("VALIDATION_FAILED");
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toEqual(expect.arrayContaining(["name", "phone", "password", "otp"]));
  });

  it("routes each role to its panel", async () => {
    const admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }]);
    const me = await ctx.api("GET", "/auth/me", { token: admin.token });
    expect(me.body.panel).toBe("/super-admin");
  });
});
