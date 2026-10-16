import { resetDatabase, startApp, userWithRoles, type TestContext } from "./helpers";

describe("partner applications (rider and franchise)", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  const rider = (overrides: Record<string, unknown> = {}) => ({
    kind: "RIDER",
    name: "Karim Hossain",
    phone: "01712-345678",
    email: "Karim@Example.com",
    area: "Dhaka North",
    vehicle: "Motorcycle",
    ...overrides,
  });
  const franchise = (overrides: Record<string, unknown> = {}) => ({
    kind: "FRANCHISE",
    name: "Nadia Rahman",
    phone: "01812345678",
    email: "",
    location: "Sylhet, Zindabazar",
    experience: "Courier and retail",
    territory: "Multi-district region",
    ...overrides,
  });

  const setup = async () => ({
    applicant: await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Karim Hossain"),
    agent: await userWithRoles(ctx, [{ role: "SUPPORT_AGENT" }], "Support Agent"),
    ops: await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops Manager"),
  });

  it("records a rider application as a support ticket with the submitted details", async () => {
    const { applicant, agent } = await setup();
    const res = await ctx.api("POST", "/applications", { token: applicant.token, body: rider() });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { application, message } = res.body;
    expect(message).toContain(application.number);
    expect(application).toMatchObject({
      number: expect.stringMatching(/^DF-SUP-\d{6}-\d{4}$/),
      kind: "RIDER",
      status: "SUBMITTED",
      statusLabel: "Submitted",
      ticketStatus: "OPEN",
      applicant: { id: applicant.user.id, name: "Karim Hossain" },
      details: { name: "Karim Hossain", phone: "+8801712345678", email: "karim@example.com", area: "Dhaka North", vehicle: "MOTORCYCLE" },
      assignee: null,
    });

    // The applicant sees it among their support tickets, with a readable first message.
    const ticket = await ctx.api("GET", `/support/tickets/${application.number}`, { token: applicant.token });
    expect(ticket.body).toMatchObject({ category: "Rider application", subject: "Rider application · Karim Hossain" });
    expect(ticket.body.messages[0].body).toBe(
      "Rider application from Karim Hossain\nPhone: +8801712345678\nEmail: karim@example.com\nPreferred work area: Dhaka North\nVehicle: Motorcycle",
    );
    // …and staff see it in the inbox.
    const inbox = await ctx.api("GET", "/support/tickets?category=Rider%20application", { token: agent.token });
    expect(inbox.body.items.map((t: { number: string }) => t.number)).toEqual([application.number]);

    const audit = await ctx.prisma.auditLog.findFirst({ where: { action: "application.submit" } });
    expect(audit).toMatchObject({ actorId: applicant.user.id, entityType: "support_ticket", entityId: application.id });
  });

  it("records a franchise application; empty optional fields are dropped", async () => {
    const { applicant } = await setup();
    const res = await ctx.api("POST", "/applications", { token: applicant.token, body: franchise() });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.application).toMatchObject({ kind: "FRANCHISE", details: { location: "Sylhet, Zindabazar", territory: "MULTI_DISTRICT_REGION", experience: "Courier and retail" } });
    expect(res.body.application.details.email).toBeUndefined();
  });

  it("allows one open application per kind", async () => {
    const { applicant, agent } = await setup();
    const first = (await ctx.api("POST", "/applications", { token: applicant.token, body: rider() })).body.application;
    const again = await ctx.api("POST", "/applications", { token: applicant.token, body: rider() });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: "APPLICATION_PENDING", message: `Your application ${first.number} is still being reviewed` });
    // A different kind is fine.
    expect((await ctx.api("POST", "/applications", { token: applicant.token, body: franchise() })).status).toBe(201);
    // Once it's decided, they can apply again.
    const rejected = await ctx.api("POST", `/applications/${first.number}/status`, { token: agent.token, body: { status: "Rejected", message: "No openings in your area right now" } });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect((await ctx.api("POST", "/applications", { token: applicant.token, body: rider() })).status).toBe(201);
  });

  it("serialises concurrent submissions", async () => {
    const { applicant } = await setup();
    const results = await Promise.all([1, 2, 3].map(() => ctx.api("POST", "/applications", { token: applicant.token, body: rider() })));
    expect(results.map(r => r.status).sort()).toEqual([201, 409, 409]);
  });

  it("refuses rider applications from riders", async () => {
    const existing = await userWithRoles(ctx, [{ role: "RIDER" }], "Existing Rider");
    const res = await ctx.api("POST", "/applications", { token: existing.token, body: rider() });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ALREADY_A_RIDER");
  });

  it("validates input and requires sign-in", async () => {
    const { applicant } = await setup();
    expect((await ctx.api("POST", "/applications", { body: rider() })).status).toBe(401);
    const bad = await ctx.api("POST", "/applications", { token: applicant.token, body: rider({ phone: "12345", vehicle: "Car" }) });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(["phone", "vehicle"]);
    expect((await ctx.api("POST", "/applications", { token: applicant.token, body: { ...rider(), kind: "MERCHANT" } })).status).toBe(422);
    expect((await ctx.api("POST", "/applications", { token: applicant.token, body: franchise({ territory: undefined }) })).status).toBe(422);
  });

  it("lists applications with their details for staff only", async () => {
    const { applicant, agent, ops } = await setup();
    const other = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Nadia Rahman");
    const r = (await ctx.api("POST", "/applications", { token: applicant.token, body: rider() })).body.application;
    const f = (await ctx.api("POST", "/applications", { token: other.token, body: franchise() })).body.application;
    // An ordinary ticket is not an application.
    await ctx.api("POST", "/support/tickets", { token: applicant.token, body: { category: "Other", subject: "Hello there", message: "Hi" } });

    const all = await ctx.api("GET", "/applications", { token: agent.token });
    expect(all.status).toBe(200);
    expect(all.body.items.map((a: { number: string }) => a.number)).toEqual([f.number, r.number]);
    expect(all.body.items[0]).toMatchObject({ kind: "FRANCHISE", applicant: { name: "Nadia Rahman", phone: other.user.phone }, details: { territory: "MULTI_DISTRICT_REGION" } });

    const riders = await ctx.api("GET", "/applications?kind=RIDER", { token: ops.token });
    expect(riders.body.items.map((a: { number: string }) => a.number)).toEqual([r.number]);

    await ctx.api("POST", `/applications/${r.number}/status`, { token: agent.token, body: { status: "Under review" } });
    const inReview = await ctx.api("GET", "/applications?status=under-review", { token: agent.token });
    expect(inReview.body.items).toHaveLength(1);
    expect(inReview.body.items[0]).toMatchObject({ number: r.number, status: "UNDER_REVIEW", ticketStatus: "IN_PROGRESS", assignee: { id: agent.user.id, name: "Support Agent" } });

    const detail = await ctx.api("GET", `/applications/${f.number.toLowerCase()}`, { token: agent.token });
    expect(detail.body).toMatchObject({ number: f.number, kind: "FRANCHISE" });

    const page = await ctx.api("GET", "/applications?limit=1", { token: agent.token });
    expect(page.body.items).toHaveLength(1);
    expect(page.body.nextCursor).toBeTruthy();

    expect((await ctx.api("GET", "/applications", { token: applicant.token })).status).toBe(403);
    expect((await ctx.api("GET", `/applications/${r.number}`, { token: applicant.token })).status).toBe(403);
    const plain = (await ctx.api("GET", "/support/tickets?category=Other", { token: agent.token })).body.items[0];
    expect((await ctx.api("GET", `/applications/${plain.number}`, { token: agent.token })).status).toBe(404);
  });
});
