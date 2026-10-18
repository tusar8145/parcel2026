import { hub, resetDatabase, startApp, userWithRoles, type TestContext } from "./helpers";

describe("partner applications: review workflow", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  const rider = { kind: "RIDER", name: "Karim Hossain", phone: "01712-345678", area: "Dhaka North", vehicle: "Motorcycle" };
  const franchise = { kind: "FRANCHISE", name: "Nadia Rahman", phone: "01812345678", location: "Sylhet", territory: "District" };

  const setup = async () => ({
    applicant: await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Karim Hossain"),
    agent: await userWithRoles(ctx, [{ role: "SUPPORT_AGENT" }], "Support Agent"),
    ops: await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops Manager"),
  });
  const status = (token: string, number: string, body: object) => ctx.api("POST", `/applications/${number}/status`, { token, body });

  it("requests information, resumes review on the applicant's reply, and approves a rider into onboarding", async () => {
    const { applicant, agent, ops } = await setup();
    const h = await hub(ctx, "HUB-APP");
    const app = (await ctx.api("POST", "/applications", { token: applicant.token, body: rider })).body.application;
    expect(await ctx.prisma.outboxMessage.count({ where: { template: "rider.application_status" } })).toBeGreaterThan(0);

    // Asking for information needs a message; it goes to the applicant's ticket and pauses the SLA.
    expect((await status(agent.token, app.number, { status: "INFO_REQUESTED" })).status).toBe(422);
    const info = await status(agent.token, app.number, { status: "INFO_REQUESTED", message: "Please share a photo of your driving licence" });
    expect(info.status, JSON.stringify(info.body)).toBe(200);
    expect(info.body).toMatchObject({ status: "INFO_REQUESTED", ticketStatus: "WAITING_FOR_REQUESTER", reviewer: { id: agent.user.id } });
    const ticket = await ctx.api("GET", `/support/tickets/${app.number}`, { token: applicant.token });
    expect(ticket.body.messages.map((m: { body: string }) => m.body)).toContain("Please share a photo of your driving licence");

    // The applicant answers on the ticket: back to review.
    await ctx.api("POST", `/support/tickets/${app.number}/messages`, { token: applicant.token, body: { body: "Attached, thanks" } });
    expect((await ctx.api("GET", `/applications/${app.number}`, { token: agent.token })).body.status).toBe("UNDER_REVIEW");

    // Only rider managers approve riders.
    expect((await status(agent.token, app.number, { status: "APPROVED" })).status).toBe(403);
    const approved = await status(ops.token, app.number, { status: "Approved", hubId: h.id, zone: "Gulshan", note: "Verified by phone" });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({ status: "APPROVED", ticketStatus: "RESOLVED", decidedBy: { id: ops.user.id } });
    const created = await ctx.prisma.rider.findUniqueOrThrow({ where: { userId: applicant.user.id } });
    expect(approved.body.riderId).toBe(created.id);
    expect(created).toMatchObject({ hubId: h.id, vehicle: "MOTORBIKE", zone: "Gulshan" });
    expect(await ctx.prisma.userRole.count({ where: { userId: applicant.user.id, role: "RIDER" } })).toBe(1);
    const onboarding = await ctx.prisma.riderOnboarding.findUniqueOrThrow({ where: { riderId: created.id } });
    expect(onboarding).toMatchObject({ status: "DOCUMENTS_PENDING", applicationId: approved.body.applicationId });

    // Decided applications don't move again.
    const again = await status(ops.token, app.number, { status: "REJECTED", message: "Changed my mind" });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("INVALID_APPLICATION_TRANSITION");
    const actions = (await ctx.prisma.auditLog.findMany({ where: { action: "application.status" }, orderBy: { createdAt: "asc" } })).map(a => (a.data as { to: string }).to);
    expect(actions).toEqual(["INFO_REQUESTED", "APPROVED"]);
  });

  it("lets applicants see and withdraw their own applications; franchises are approved by operations", async () => {
    const { applicant, agent, ops } = await setup();
    const r = (await ctx.api("POST", "/applications", { token: applicant.token, body: rider })).body.application;
    const f = (await ctx.api("POST", "/applications", { token: applicant.token, body: franchise })).body.application;
    const mine = await ctx.api("GET", "/applications/mine", { token: applicant.token });
    expect(mine.body.map((a: { number: string }) => a.number).sort()).toEqual([r.number, f.number].sort());

    const stranger = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Stranger");
    expect((await ctx.api("POST", `/applications/${r.number}/withdraw`, { token: stranger.token })).status).toBe(404);
    const withdrawn = await ctx.api("POST", `/applications/${r.number}/withdraw`, { token: applicant.token });
    expect(withdrawn.body).toMatchObject({ status: "WITHDRAWN", ticketStatus: "CLOSED" });
    expect((await ctx.api("POST", "/applications", { token: applicant.token, body: rider })).status).toBe(201);

    expect((await status(agent.token, f.number, { status: "APPROVED" })).status).toBe(403);
    const ok = await status(ops.token, f.number, { status: "APPROVED", message: "Our partnerships team will call you" });
    expect(ok.body).toMatchObject({ status: "APPROVED", riderId: null });
    expect(await ctx.prisma.outboxMessage.count({ where: { template: "partner.application_status" } })).toBeGreaterThan(0);
    expect((await status(applicant.token, f.number, { status: "REJECTED", message: "x" })).status).toBe(403);
  });

  it("keeps applicants on the application page (APPLICANT role) until approval, then opens their panel", async () => {
    const { applicant, agent, ops } = await setup();
    const h = await hub(ctx, "HUB-APL");
    const panel = async () => (await ctx.api("GET", "/auth/me", { token: applicant.token })).body.panel;
    const applicantRoles = () => ctx.prisma.userRole.count({ where: { userId: applicant.user.id, role: "APPLICANT" } });
    expect(await panel()).toBe("/account");

    // Applying makes /application the account's home (rider and franchise share the one grant).
    const r = (await ctx.api("POST", "/applications", { token: applicant.token, body: rider })).body.application;
    const f = (await ctx.api("POST", "/applications", { token: applicant.token, body: franchise })).body.application;
    expect(await applicantRoles()).toBe(1);
    expect(await panel()).toBe("/application");

    // Nothing to leave while an application is open.
    const early = await ctx.api("POST", "/applications/leave", { token: applicant.token });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("APPLICATION_PENDING");

    // Withdrawing one keeps the page while the other is still reviewed.
    await ctx.api("POST", `/applications/${f.number}/withdraw`, { token: applicant.token });
    expect(await applicantRoles()).toBe(1);

    // Rider approval: the rider app becomes the home and the grant is gone.
    const approved = await status(ops.token, r.number, { status: "APPROVED", hubId: h.id });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(await applicantRoles()).toBe(0);
    expect(await panel()).toBe("/rider");

    // A rejected applicant keeps the page (to read the decision) and may close it.
    const other = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Nadia Rahman");
    const o = (await ctx.api("POST", "/applications", { token: other.token, body: franchise })).body.application;
    await status(agent.token, o.number, { status: "REJECTED", message: "No territory free in Sylhet yet" });
    expect(await ctx.prisma.userRole.count({ where: { userId: other.user.id, role: "APPLICANT" } })).toBe(1);
    const left = await ctx.api("POST", "/applications/leave", { token: other.token });
    expect(left.body).toEqual({ released: true });
    expect((await ctx.api("GET", "/auth/me", { token: other.token })).body.panel).toBe("/account");
  });
});
