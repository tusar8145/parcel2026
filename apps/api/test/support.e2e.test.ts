import { hub, parcelBody, resetDatabase, riderUser, startApp, userWithRoles, type TestContext } from "./helpers";

// 1x1 transparent PNG
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const PDF = `data:application/pdf;base64,${Buffer.from("%PDF-1.4\n%test\n").toString("base64")}`;
const pngOfSize = (bytes: number) => {
  const buf = Buffer.alloc(bytes);
  Buffer.from("89504e470d0a1a0a", "hex").copy(buf);
  return `data:image/png;base64,${buf.toString("base64")}`;
};

describe("support tickets", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  const setup = async () => {
    const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Rahim Uddin");
    const other = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Someone Else");
    const agent = await userWithRoles(ctx, [{ role: "SUPPORT_AGENT" }], "Support Agent");
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops Manager");
    return { customer, other, agent, ops };
  };

  const ticketBody = (overrides: Record<string, unknown> = {}) => ({
    category: "Delivery issue",
    subject: "Parcel is late",
    message: "My parcel has not arrived yet.",
    ...overrides,
  });

  const open = async (token: string, overrides: Record<string, unknown> = {}) => {
    const res = await ctx.api("POST", "/support/tickets", { token, body: ticketBody(overrides) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
  };

  it("opens a ticket with a dated number, a linked parcel and attachments", async () => {
    const { customer } = await setup();
    const { trackingId } = (await ctx.api("POST", "/parcels", { token: customer.token, body: parcelBody() })).body;
    const ticket = await open(customer.token, {
      relatedRef: trackingId.toLowerCase(),
      priority: "High",
      attachments: [PNG, { filename: "receipt.pdf", dataUrl: PDF }],
    });
    expect(ticket.number).toMatch(/^DF-SUP-\d{6}-0001$/);
    expect(ticket).toMatchObject({
      status: "OPEN",
      statusLabel: "Open",
      priority: "HIGH",
      category: "Delivery issue",
      relatedRef: trackingId,
      merchant: null,
      requester: { id: customer.user.id, name: "Rahim Uddin" },
      messageCount: 1,
    });
    expect(ticket.requester.phone).toBeUndefined();
    const [first] = ticket.messages;
    expect(first).toMatchObject({ author: { id: customer.user.id, label: "Rahim Uddin", kind: "requester" }, body: "My parcel has not arrived yet.", internal: false });
    expect(first.attachments).toHaveLength(2);
    expect(first.attachments[0]).toMatchObject({ filename: `${ticket.number}-1.png`, mimeType: "image/png" });
    expect(first.attachments[1]).toMatchObject({ filename: "receipt.pdf", mimeType: "application/pdf", url: `/api/v1/files/${first.attachments[1].id}` });

    const second = await open(customer.token, { priority: "normal" });
    expect(second.number).toMatch(/-0002$/);
    expect(second.priority).toBe("NORMAL");
    expect((await ctx.prisma.auditLog.findMany({ where: { action: "support.ticket.create" } })).length).toBe(2);
  });

  it("sets merchantId for merchant users", async () => {
    const merchant = await ctx.prisma.merchant.create({
      data: { code: "MR-1001", type: "ECOMMERCE", name: "Shop BD", status: "ACTIVE", contactName: "Owner", contactPhone: "+8801711111111", pickupAddress: "Road 1", pickupArea: "Gulshan", pickupDistrict: "Dhaka North" },
    });
    const owner = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: merchant.id }], "Shop Owner");
    const ticket = await open(owner.token, { category: "COD / payment", subject: "Payout question" });
    expect(ticket.merchant).toMatchObject({ id: merchant.id, name: "Shop BD" });
  });

  it("validates input", async () => {
    const { customer, other } = await setup();
    const bad = await ctx.api("POST", "/support/tickets", { token: customer.token, body: ticketBody({ category: "Billing", subject: "x", priority: "URGENT", message: "" }) });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("VALIDATION_FAILED");
    expect(bad.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(["category", "message", "priority", "subject"]);

    const tooMany = await ctx.api("POST", "/support/tickets", { token: customer.token, body: ticketBody({ attachments: [PNG, PNG, PNG, PNG] }) });
    expect(tooMany.body.error.details[0]).toMatchObject({ path: "attachments", message: "Attach up to 3 files" });
    const tooBig = await ctx.api("POST", "/support/tickets", { token: customer.token, body: ticketBody({ attachments: [pngOfSize(350 * 1024 + 1)] }) });
    expect(tooBig.status).toBe(422);
    expect(JSON.stringify(tooBig.body.error.details)).toContain("350 KB");
    expect((await ctx.api("POST", "/support/tickets", { token: customer.token, body: ticketBody({ attachments: [pngOfSize(350 * 1024)] }) })).status).toBe(201);
    const gif = await ctx.api("POST", "/support/tickets", { token: customer.token, body: ticketBody({ attachments: ["data:image/gif;base64,R0lGODlh"] }) });
    expect(JSON.stringify(gif.body.error.details)).toContain("PNG, JPEG, WebP or PDF");
    const fake = await ctx.api("POST", "/support/tickets", { token: customer.token, body: ticketBody({ attachments: [`data:image/png;base64,${Buffer.from("MZ not a png").toString("base64")}`] }) });
    expect(fake.status).toBe(415);
    expect(fake.body.error.code).toBe("UNSUPPORTED_FILE");

    // Someone else's parcel can't be linked, and the failed ticket leaves nothing behind.
    const { trackingId } = (await ctx.api("POST", "/parcels", { token: customer.token, body: parcelBody() })).body;
    const before = await ctx.prisma.supportTicket.count();
    const foreign = await ctx.api("POST", "/support/tickets", { token: other.token, body: ticketBody({ relatedRef: trackingId }) });
    expect(foreign.status).toBe(422);
    expect(foreign.body.error.code).toBe("UNKNOWN_PARCEL");
    expect(await ctx.prisma.supportTicket.count()).toBe(before);
  });

  it("requires support:create and a signed-in user", async () => {
    const finance = await userWithRoles(ctx, [{ role: "FINANCE" }], "Finance");
    expect((await ctx.api("POST", "/support/tickets", { token: finance.token, body: ticketBody() })).status).toBe(403);
    expect((await ctx.api("GET", "/support/tickets")).status).toBe(401);
  });

  it("scopes lists and details: requesters see their own tickets, staff see all", async () => {
    const { customer, other, agent } = await setup();
    const mine = await open(customer.token, { subject: "Rider was rude", category: "Rider or safety" });
    await open(customer.token, { subject: "Pickup missed", category: "Pickup or collection" });
    const theirs = await open(other.token, { subject: "Account locked", category: "Account / API" });

    const ownList = await ctx.api("GET", "/support/tickets", { token: customer.token });
    expect(ownList.body.items.map((t: { subject: string }) => t.subject)).toEqual(["Pickup missed", "Rider was rude"]);
    expect(ownList.body.items[0]).toMatchObject({ messageCount: 1, lastMessage: { authorLabel: "Rahim Uddin", preview: "My parcel has not arrived yet." } });

    expect((await ctx.api("GET", `/support/tickets/${theirs.number}`, { token: customer.token })).status).toBe(404);
    expect((await ctx.api("POST", `/support/tickets/${theirs.number}/messages`, { token: customer.token, body: { body: "hi" } })).status).toBe(404);
    expect((await ctx.api("PATCH", `/support/tickets/${theirs.number}`, { token: customer.token, body: { status: "CLOSED" } })).status).toBe(404);
    expect((await ctx.api("GET", `/support/tickets/${mine.number.toLowerCase()}`, { token: customer.token })).status).toBe(200);
    expect((await ctx.api("GET", "/support/tickets?assigneeId=me", { token: customer.token })).status).toBe(403);

    const all = await ctx.api("GET", "/support/tickets", { token: agent.token });
    expect(all.body.items).toHaveLength(3);
    expect(all.body.items[0].requester.phone).toBe(other.phone);
    expect((await ctx.api("GET", "/support/tickets?category=Rider%20or%20safety", { token: agent.token })).body.items.map((t: { number: string }) => t.number)).toEqual([mine.number]);
    expect((await ctx.api("GET", "/support/tickets?q=locked", { token: agent.token })).body.items).toHaveLength(1);
    expect((await ctx.api("GET", `/support/tickets?q=${mine.number.slice(-4)}`, { token: agent.token })).body.items[0].number).toBe(mine.number);
    expect((await ctx.api("GET", "/support/tickets?status=Open", { token: agent.token })).body.items).toHaveLength(3);
    expect((await ctx.api("GET", "/support/tickets?status=Resolved", { token: agent.token })).body.items).toHaveLength(0);
    expect((await ctx.api("GET", "/support/tickets?status=Nope", { token: agent.token })).status).toBe(422);

    // Cursor pagination.
    const p1 = await ctx.api("GET", "/support/tickets?limit=2", { token: agent.token });
    expect(p1.body.items).toHaveLength(2);
    const p2 = await ctx.api("GET", `/support/tickets?limit=2&cursor=${p1.body.nextCursor}`, { token: agent.token });
    expect(p2.body.items).toHaveLength(1);
    expect(p2.body.nextCursor).toBeNull();
    expect([...p1.body.items, ...p2.body.items].map((t: { number: string }) => t.number).sort()).toEqual(
      all.body.items.map((t: { number: string }) => t.number).sort(),
    );
  });

  it("runs the conversation: replies move the status, internal notes stay hidden", async () => {
    const { customer, agent } = await setup();
    const t = await open(customer.token);
    const url = `/support/tickets/${t.number}`;

    const staffReply = await ctx.api("POST", `${url}/messages`, { token: agent.token, body: { body: "Checking with the rider.", attachments: [PNG] } });
    expect(staffReply.status, JSON.stringify(staffReply.body)).toBe(201);
    expect(staffReply.body.status).toBe("WAITING_FOR_REQUESTER");
    expect(staffReply.body.messages[1]).toMatchObject({ author: { kind: "staff", label: "Support Agent" }, attachments: [{ mimeType: "image/png" }] });
    expect(new Date(staffReply.body.updatedAt).getTime()).toBeGreaterThan(new Date(t.updatedAt).getTime());

    const note = await ctx.api("POST", `${url}/messages`, { token: agent.token, body: { body: "Rider R-2048 has a history here.", internal: true, attachments: [PNG] } });
    expect(note.body.status).toBe("WAITING_FOR_REQUESTER");
    expect(note.body.messages).toHaveLength(3);
    const noteFileId = note.body.messages[2].attachments[0].id;

    expect((await ctx.api("POST", `${url}/messages`, { token: customer.token, body: { body: "secret", internal: true } })).status).toBe(403);

    const custReply = await ctx.api("POST", `${url}/messages`, { token: customer.token, body: { body: "Thanks, still waiting." } });
    expect(custReply.body.status).toBe("OPEN");
    expect(custReply.body.messages.map((m: { body: string }) => m.body)).toEqual(["My parcel has not arrived yet.", "Checking with the rider.", "Thanks, still waiting."]);
    expect(JSON.stringify(custReply.body)).not.toContain("history here");

    const custList = await ctx.api("GET", "/support/tickets", { token: customer.token });
    expect(custList.body.items[0]).toMatchObject({ messageCount: 3, lastMessage: { preview: "Thanks, still waiting." } });
    const staffDetail = await ctx.api("GET", url, { token: agent.token });
    expect(staffDetail.body.messageCount).toBe(4);
    expect(staffDetail.body.messages[2]).toMatchObject({ internal: true, body: "Rider R-2048 has a history here." });

    // Internal attachments are hidden from the requester; public ones are not.
    expect((await ctx.api("GET", `/files/${noteFileId}`, { token: customer.token })).status).toBe(404);
    const publicFile = await ctx.api("GET", `/files/${staffReply.body.messages[1].attachments[0].id}`, { token: customer.token });
    expect(publicFile.status).toBe(200);

    // A requester reply reopens a resolved ticket; closed tickets reject replies.
    await ctx.api("PATCH", url, { token: agent.token, body: { status: "Resolved" } });
    const reopened = await ctx.api("POST", `${url}/messages`, { token: customer.token, body: { body: "It happened again." } });
    expect(reopened.body).toMatchObject({ status: "OPEN", resolvedAt: null });
    await ctx.api("PATCH", url, { token: agent.token, body: { status: "CLOSED" } });
    const closed = await ctx.api("POST", `${url}/messages`, { token: customer.token, body: { body: "Hello?" } });
    expect(closed.status).toBe(409);
    expect(closed.body.error.code).toBe("TICKET_CLOSED");
    expect((await ctx.api("POST", `${url}/messages`, { token: agent.token, body: { body: "Note", internal: true } })).body.error.code).toBe("TICKET_CLOSED");

    expect(await ctx.prisma.auditLog.count({ where: { action: "support.ticket.reply" } })).toBe(4);
  });

  it("lets staff update status, priority and assignee with system messages", async () => {
    const { customer, agent, ops } = await setup();
    const rider = await riderUser(ctx, "R-3001", (await hub(ctx)).id);
    const t = await open(customer.token);
    const url = `/support/tickets/${t.number}`;

    const invalid = await ctx.api("PATCH", url, { token: agent.token, body: { assigneeId: rider.user.id } });
    expect(invalid.status).toBe(422);
    expect(invalid.body.error.code).toBe("INVALID_ASSIGNEE");
    expect((await ctx.api("PATCH", url, { token: agent.token, body: { assigneeId: "0190d7a4-0000-7000-8000-000000000000" } })).body.error.code).toBe("INVALID_ASSIGNEE");
    expect((await ctx.api("PATCH", url, { token: agent.token, body: {} })).status).toBe(422);

    const updated = await ctx.api("PATCH", url, { token: agent.token, body: { status: "In progress", priority: "urgent", assigneeId: ops.user.id } });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body).toMatchObject({ status: "IN_PROGRESS", statusLabel: "In progress", priority: "URGENT", assignee: { id: ops.user.id, name: "Ops Manager" } });
    expect(updated.body.messages.slice(1)).toMatchObject([
      { author: { id: null, label: "System", kind: "system" }, body: "Assigned to Ops Manager", internal: true },
      { author: { id: null, label: "System", kind: "system" }, body: "Status changed to In progress", internal: false },
    ]);
    expect((await ctx.api("GET", "/support/tickets?assigneeId=" + ops.user.id, { token: agent.token })).body.items).toHaveLength(1);
    expect((await ctx.api("GET", "/support/tickets?assigneeId=unassigned", { token: agent.token })).body.items).toHaveLength(0);
    expect((await ctx.api("GET", "/support/tickets?assigneeId=me", { token: ops.token })).body.items).toHaveLength(1);

    const resolved = await ctx.api("PATCH", url, { token: agent.token, body: { status: "RESOLVED" } });
    expect(resolved.body.resolvedAt).not.toBeNull();
    expect(resolved.body.messages.at(-1).body).toBe("Status changed to Resolved");

    // Same status again is a no-op.
    await ctx.api("PATCH", url, { token: agent.token, body: { status: "RESOLVED" } });
    expect(await ctx.prisma.ticketMessage.count({ where: { body: "Status changed to Resolved" } })).toBe(1);

    const unassigned = await ctx.api("PATCH", url, { token: agent.token, body: { assigneeId: null } });
    expect(unassigned.body.assignee).toBeNull();
    const audit = await ctx.prisma.auditLog.findMany({ where: { action: "support.ticket.update" }, orderBy: { createdAt: "asc" } });
    expect(audit).toHaveLength(3);
    expect(audit[0].data).toMatchObject({ from: { status: "OPEN", priority: "NORMAL", assigneeId: null }, to: { status: "IN_PROGRESS", priority: "URGENT", assigneeId: ops.user.id } });
  });

  it("limits requesters to closing or reopening their own ticket", async () => {
    const { customer, agent } = await setup();
    const t = await open(customer.token);
    const url = `/support/tickets/${t.number}`;

    expect((await ctx.api("PATCH", url, { token: customer.token, body: { priority: "HIGH" } })).status).toBe(403);
    expect((await ctx.api("PATCH", url, { token: customer.token, body: { status: "IN_PROGRESS" } })).status).toBe(403);
    expect((await ctx.api("PATCH", url, { token: customer.token, body: { status: "RESOLVED" } })).status).toBe(403);
    expect((await ctx.api("PATCH", url, { token: customer.token, body: { status: "CLOSED", priority: "LOW" } })).status).toBe(403);

    await ctx.api("PATCH", url, { token: agent.token, body: { status: "RESOLVED" } });
    const reopened = await ctx.api("PATCH", url, { token: customer.token, body: { status: "Open" } });
    expect(reopened.body).toMatchObject({ status: "OPEN", resolvedAt: null });

    const closed = await ctx.api("PATCH", url, { token: customer.token, body: { status: "CLOSED" } });
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe("CLOSED");
    expect(closed.body.messages.at(-1)).toMatchObject({ author: { label: "System" }, body: "Status changed to Closed" });
    // A closed ticket can't be reopened by the requester, only by staff.
    expect((await ctx.api("PATCH", url, { token: customer.token, body: { status: "OPEN" } })).status).toBe(403);
    expect((await ctx.api("PATCH", url, { token: agent.token, body: { status: "OPEN" } })).body.status).toBe("OPEN");
  });

  it("serves files with safe headers to the right people only", async () => {
    const { customer, other, agent } = await setup();
    const t = await open(customer.token, { attachments: [{ filename: "proof.png", dataUrl: PNG }] });
    const fileId = t.messages[0].attachments[0].id;

    const res = await ctx.app.inject({ method: "GET", url: `/api/v1/files/${fileId}`, headers: { authorization: `Bearer ${customer.token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["content-disposition"]).toBe('inline; filename="proof.png"');
    expect(res.headers["cache-control"]).toBe("private, max-age=300");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.rawPayload.equals(Buffer.from(PNG.split(",")[1], "base64"))).toBe(true);

    expect((await ctx.api("GET", `/files/${fileId}`, { token: agent.token })).status).toBe(200);
    expect((await ctx.api("GET", `/files/${fileId}`, { token: other.token })).status).toBe(404);
    expect((await ctx.api("GET", `/files/${fileId}`)).status).toBe(401);
    expect((await ctx.api("GET", "/files/0190d7a4-0000-7000-8000-000000000000", { token: customer.token })).status).toBe(404);
  });

  it("serves a file as JSON with a data URL when asked for application/json", async () => {
    const { customer, other } = await setup();
    const t = await open(customer.token, { attachments: [{ filename: "proof.png", dataUrl: PNG }] });
    const file = t.messages[0].attachments[0];

    const res = await ctx.api("GET", `/files/${file.id}`, { token: customer.token, headers: { accept: "application/json" } });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.headers.vary).toBe("accept");
    expect(res.body).toEqual({ id: file.id, filename: "proof.png", mimeType: "image/png", sizeBytes: file.sizeBytes, dataUrl: PNG });
    // Browsers' generic Accept headers still get the bytes.
    const raw = await ctx.api("GET", `/files/${file.id}`, { token: customer.token, headers: { accept: "image/avif,image/webp,*/*;q=0.8" } });
    expect(raw.headers["content-type"]).toBe("image/png");
    // Same access rules.
    expect((await ctx.api("GET", `/files/${file.id}`, { token: other.token, headers: { accept: "application/json" } })).status).toBe(404);
  });

  it("lists assignees for staff only", async () => {
    const { customer, agent, ops } = await setup();
    const res = await ctx.api("GET", "/support/assignees", { token: agent.token });
    expect(res.status).toBe(200);
    expect(res.body.map((u: { id: string }) => u.id).sort()).toEqual([agent.user.id, ops.user.id].sort());
    expect(res.body.find((u: { id: string }) => u.id === ops.user.id)).toEqual({ id: ops.user.id, name: "Ops Manager", roles: ["OPS_MANAGER"] });
    await ctx.prisma.user.update({ where: { id: ops.user.id }, data: { status: "SUSPENDED" } });
    expect((await ctx.api("GET", "/support/assignees", { token: agent.token })).body).toHaveLength(1);
    expect((await ctx.api("GET", "/support/assignees", { token: customer.token })).status).toBe(403);
  });

  it("keeps partner-application categories for /applications", async () => {
    const { customer, agent } = await setup();
    const res = await ctx.api("POST", "/support/tickets", { token: customer.token, body: ticketBody({ category: "Rider application" }) });
    expect(res.status).toBe(422);
    // Staff can still filter the inbox by them.
    expect((await ctx.api("GET", "/support/tickets?category=Rider%20application", { token: agent.token })).status).toBe(200);
  });

  it("serves delivery-proof files to whoever can see the parcel", async () => {
    const { customer, other, agent } = await setup();
    const h = await hub(ctx);
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Dispatcher");
    const rider = await riderUser(ctx, "R-2048", h.id);
    const { trackingId } = (await ctx.api("POST", "/parcels", { token: customer.token, body: parcelBody({ codAmount: 0 }) })).body;
    await ctx.api("POST", `/parcels/${trackingId}/assign-pickup`, { token: ops.token, body: { riderId: rider.rider.id } });
    await ctx.api("POST", `/rider/parcels/${trackingId}/pickup`, { token: rider.token, body: { outcome: "COLLECTED_DELIVER_DIRECT" } });
    const signed = await ctx.api("POST", `/rider/parcels/${trackingId}/delivery`, {
      token: rider.token,
      body: { outcome: "DELIVERED", receivedBy: "Reception", proof: { method: "SIGNATURE", image: PNG } },
    });
    expect(signed.body.status).toBe("DELIVERED");
    const proof = await ctx.prisma.deliveryProof.findFirstOrThrow({ where: { parcel: { trackingId } } });

    const download = await ctx.api("GET", `/files/${proof.fileId}`, { token: customer.token });
    expect(download.status).toBe(200);
    expect(download.headers["content-type"]).toBe("image/png");
    expect((await ctx.api("GET", `/files/${proof.fileId}`, { token: agent.token })).status).toBe(200);
    expect((await ctx.api("GET", `/files/${proof.fileId}`, { token: rider.token })).status).toBe(200);
    expect((await ctx.api("GET", `/files/${proof.fileId}`, { token: other.token })).status).toBe(404);
  });
});
