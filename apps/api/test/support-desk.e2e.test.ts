import { resetDatabase, startApp, userWithRoles, type TestContext } from "./helpers";

describe("support desk: SLA, escalation, notifications, CSAT, canned responses", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  const setup = async () => ({
    customer: await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Rahima Customer"),
    agent: await userWithRoles(ctx, [{ role: "SUPPORT_AGENT" }], "Agent One"),
    agent2: await userWithRoles(ctx, [{ role: "SUPPORT_AGENT" }], "Agent Two"),
    ops: await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops Manager"),
  });
  const open = async (token: string, priority = "Normal") => {
    const res = await ctx.api("POST", "/support/tickets", { token, body: { category: "Delivery issue", subject: "Parcel is late", priority, message: "Where is my parcel?" } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
  };
  const staffView = async (token: string, number: string) => (await ctx.api("GET", `/support/tickets/${number}`, { token })).body;
  const outbox = (template: string) => ctx.prisma.outboxMessage.count({ where: { template } });

  it("sets SLA targets by priority, pauses while waiting for the requester and records the first response", async () => {
    const { customer, agent } = await setup();
    const t = await open(customer.token, "High");
    expect(t.sla).toBeUndefined(); // requesters don't see SLA internals
    let v = await staffView(agent.token, t.number);
    const created = new Date(v.createdAt).getTime();
    expect(new Date(v.sla.firstResponseDueAt).getTime() - created).toBeCloseTo(60 * 60_000, -4);
    expect(new Date(v.sla.resolutionDueAt).getTime() - created).toBeCloseTo(8 * 3600_000, -4);
    expect(v.sla).toMatchObject({ state: "on_track", paused: false, escalationLevel: 0 });

    // Internal notes don't count as a first response; a reply does, notifies the requester and pauses the clock.
    await ctx.api("POST", `/support/tickets/${t.number}/messages`, { token: agent.token, body: { body: "Checking with the hub", internal: true } });
    expect((await staffView(agent.token, t.number)).sla.firstResponseAt).toBeNull();
    expect(await outbox("support.ticket_reply")).toBe(0);
    await ctx.api("POST", `/support/tickets/${t.number}/messages`, { token: agent.token, body: { body: "It is out for delivery today" } });
    v = await staffView(agent.token, t.number);
    expect(v.sla).toMatchObject({ paused: true, state: "paused" });
    expect(v.sla.firstResponseAt).toBeTruthy();
    const due = new Date(v.sla.resolutionDueAt).getTime();

    // Requester replies: the clock resumes and the target moves by the paused time.
    await ctx.prisma.supportTicket.update({ where: { number: t.number }, data: { slaPausedAt: new Date(Date.now() - 30 * 60_000) } });
    await ctx.api("POST", `/support/tickets/${t.number}/messages`, { token: customer.token, body: { body: "Thanks, still waiting" } });
    v = await staffView(agent.token, t.number);
    expect(v.sla.paused).toBe(false);
    expect(new Date(v.sla.resolutionDueAt).getTime() - due).toBeGreaterThanOrEqual(29 * 60_000);

    // Priority change re-targets.
    await ctx.api("PATCH", `/support/tickets/${t.number}`, { token: agent.token, body: { priority: "Urgent" } });
    v = await staffView(agent.token, t.number);
    expect(new Date(v.sla.resolutionDueAt).getTime() - created).toBeLessThan(5 * 3600_000);
  });

  it("detects breaches, escalates (priority, auto-assignment, alerts) once", async () => {
    const { customer, agent, agent2, ops } = await setup();
    const busy = await open(customer.token);
    await ctx.api("PATCH", `/support/tickets/${busy.number}`, { token: ops.token, body: { assigneeId: agent.user.id } });
    const t = await open(customer.token);
    await ctx.prisma.supportTicket.update({ where: { number: t.number }, data: { firstResponseDueAt: new Date(Date.now() - 60_000) } });

    const r1 = await ctx.api("POST", "/support/sla/check", { token: agent.token });
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ breaches: 1, tickets: [t.number] });
    const v = await staffView(agent.token, t.number);
    expect(v).toMatchObject({ priority: "HIGH", assignee: { id: agent2.user.id } }); // least busy agent
    expect(v.sla).toMatchObject({ firstResponseBreached: true, escalationLevel: 1, state: "breached" });
    expect(v.messages.some((m: { body: string; internal: boolean }) => m.internal && m.body.startsWith("SLA breached: first response"))).toBe(true);
    expect((await ctx.api("GET", `/support/tickets/${t.number}`, { token: customer.token })).body.messages.some((m: { body: string }) => m.body.startsWith("SLA breached"))).toBe(false);
    expect(await ctx.prisma.auditLog.count({ where: { action: "support.ticket.sla_breach" } })).toBe(1);

    // The same breach isn't escalated twice.
    expect((await ctx.api("POST", "/support/sla/check", { token: agent.token })).body.breaches).toBe(0);
    const overview = await ctx.api("GET", "/support/sla/overview", { token: ops.token });
    expect(overview.body).toMatchObject({ open: 2, breached: 1 });
    expect((await ctx.api("POST", "/support/sla/check", { token: customer.token })).status).toBe(403);
  });

  it("lets SLA targets be configured by operations managers only", async () => {
    const { agent, ops } = await setup();
    const cfg = (await ctx.api("GET", "/support/sla", { token: agent.token })).body;
    expect(cfg.targets.URGENT).toEqual({ firstResponseMinutes: 30, resolutionMinutes: 240 });
    const next = { ...cfg, targets: { ...cfg.targets, LOW: { firstResponseMinutes: 600, resolutionMinutes: 6000 } } };
    expect((await ctx.api("PUT", "/support/sla", { token: agent.token, body: next })).status).toBe(403);
    expect((await ctx.api("PUT", "/support/sla", { token: ops.token, body: { ...next, targets: { ...next.targets, LOW: { firstResponseMinutes: 600, resolutionMinutes: 60 } } } })).status).toBe(422);
    expect((await ctx.api("PUT", "/support/sla", { token: ops.token, body: next })).body.targets.LOW.resolutionMinutes).toBe(6000);
  });

  it("notifies on status changes and asks for one CSAT rating after resolution", async () => {
    const { customer, agent } = await setup();
    await ctx.prisma.user.update({ where: { id: customer.user.id }, data: { email: "rahima@example.com" } });
    const t = await open(customer.token);
    await ctx.api("POST", `/support/tickets/${t.number}/messages`, { token: agent.token, body: { body: "We're on it" } });
    expect(await outbox("support.ticket_reply")).toBe(1);

    expect((await ctx.api("POST", `/support/tickets/${t.number}/csat`, { token: customer.token, body: { rating: 5 } })).body.error.code).toBe("TICKET_NOT_RESOLVED");
    await ctx.api("PATCH", `/support/tickets/${t.number}`, { token: agent.token, body: { status: "Resolved" } });
    expect(await outbox("support.ticket_status")).toBe(1);
    expect(await outbox("support.csat_request")).toBe(1);
    expect((await ctx.api("GET", `/support/tickets/${t.number}`, { token: customer.token })).body.survey).toMatchObject({ requested: true, rating: null });

    expect((await ctx.api("POST", `/support/tickets/${t.number}/csat`, { token: customer.token, body: { rating: 6 } })).status).toBe(422);
    expect((await ctx.api("POST", `/support/tickets/${t.number}/csat`, { token: agent.token, body: { rating: 1 } })).status).toBe(404);
    const rated = await ctx.api("POST", `/support/tickets/${t.number}/csat`, { token: customer.token, body: { rating: 4, comment: "Quick and helpful" } });
    expect(rated.status, JSON.stringify(rated.body)).toBe(201);
    expect(rated.body.survey).toMatchObject({ rating: 4, comment: "Quick and helpful" });
    expect((await ctx.api("POST", `/support/tickets/${t.number}/csat`, { token: customer.token, body: { rating: 1 } })).body.error.code).toBe("ALREADY_RATED");

    // Reopen + resolve again doesn't ask twice.
    await ctx.api("PATCH", `/support/tickets/${t.number}`, { token: customer.token, body: { status: "Open" } });
    await ctx.api("PATCH", `/support/tickets/${t.number}`, { token: agent.token, body: { status: "Resolved" } });
    expect(await outbox("support.csat_request")).toBe(1);

    const report = await ctx.api("GET", "/support/csat/report", { token: agent.token });
    expect(report.body).toMatchObject({ requested: 1, responded: 1, responseRate: 100, averageRating: 4, satisfaction: 100, byAgent: [{ agent: { id: agent.user.id }, responses: 1, averageRating: 4 }] });
    expect(report.body.distribution.find((d: { rating: number }) => d.rating === 4).count).toBe(1);
    expect(report.body.recentComments[0]).toMatchObject({ ticketNumber: t.number, comment: "Quick and helpful" });
    expect((await ctx.api("GET", "/support/csat/report", { token: customer.token })).status).toBe(403);
  });

  it("manages canned responses", async () => {
    const { customer, agent } = await setup();
    const created = await ctx.api("POST", "/support/canned-responses", { token: agent.token, body: { title: "Refund timeline", body: "Refunds reach you within 3 working days.", category: "COD / payment", shortcut: "Refund-ETA" } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ shortcut: "refund-eta", active: true });
    expect((await ctx.api("POST", "/support/canned-responses", { token: agent.token, body: { title: "Dup", body: "x y", shortcut: "refund-eta" } })).body.error.code).toBe("SHORTCUT_TAKEN");
    expect((await ctx.api("POST", "/support/canned-responses", { token: customer.token, body: { title: "Nope", body: "x y" } })).status).toBe(403);

    const patched = await ctx.api("PATCH", `/support/canned-responses/${created.body.id}`, { token: agent.token, body: { title: "Refund ETA" } });
    expect(patched.body).toMatchObject({ title: "Refund ETA", active: true, shortcut: "refund-eta" });
    expect((await ctx.api("GET", "/support/canned-responses?q=working", { token: agent.token })).body).toHaveLength(1);
    await ctx.api("PATCH", `/support/canned-responses/${created.body.id}`, { token: agent.token, body: { active: false } });
    expect((await ctx.api("GET", "/support/canned-responses", { token: agent.token })).body).toHaveLength(0);
    expect((await ctx.api("GET", "/support/canned-responses?includeInactive=true", { token: agent.token })).body).toHaveLength(1);
    expect((await ctx.api("DELETE", `/support/canned-responses/${created.body.id}`, { token: agent.token })).status).toBe(204);
    expect(await ctx.prisma.auditLog.count({ where: { action: { startsWith: "support.canned." } } })).toBe(4);
  });
});
