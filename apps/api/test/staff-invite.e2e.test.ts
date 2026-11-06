import { nextPhone, resetDatabase, startApp, userWithRoles, type TestContext } from "./helpers";

/** A staff account created by a super admin gets an "Account invitation" (SMS + email) with the role and the sign-in link. */
describe("staff invitations", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  it("invites new staff by SMS and email, naming the role; customers get none", async () => {
    const admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Ayesha Admin");
    const phone = nextPhone();
    const res = await ctx.api("POST", "/users", { token: admin.token, body: { name: "Karim Finance", phone, email: "karim@example.com", roles: [{ role: "FINANCE" }] } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const msgs = await ctx.prisma.outboxMessage.findMany({ where: { template: "account.invite", to: { in: [phone, "karim@example.com"] } } });
    expect(msgs.map(m => m.channel).sort()).toEqual(["EMAIL", "SMS"]);
    const sms = msgs.find(m => m.channel === "SMS")!;
    expect(sms.body).toContain("Ayesha Admin added you to Delivery Fast as Finance Administrator");
    expect(sms.body).toMatch(/\/login$/);

    const customerPhone = nextPhone();
    expect((await ctx.api("POST", "/users", { token: admin.token, body: { name: "Plain Customer", phone: customerPhone, roles: [{ role: "CUSTOMER" }] } })).status).toBe(201);
    expect(await ctx.prisma.outboxMessage.count({ where: { template: "account.invite", to: customerPhone } })).toBe(0);
  });
});
