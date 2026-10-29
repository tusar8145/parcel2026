import { vi } from "vitest";
import { RealtimeService } from "../src/common/realtime.service";
import { parcelBody, resetDatabase, startApp, userWithRoles, type TestContext } from "./helpers";

/** In-app notifications: GET /me/notifications (the bell in every panel) and what writes them. */
describe("in-app notifications", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  const until = async <T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    let value = await read();
    while (!ok(value) && Date.now() < end) {
      await new Promise(r => setTimeout(r, 50));
      value = await read();
    }
    return value;
  };

  let seq = 0;
  async function workspace(type: "ECOMMERCE" | "BANKING_FINANCIAL" = "ECOMMERCE") {
    const m = await ctx.prisma.merchant.create({
      data: { code: `MR-N${++seq}`, type, name: `Shop ${seq}`, status: "ACTIVE", contactName: "Owner", contactPhone: "+8801711111111", pickupAddress: "House 12, Road 5, Banani", pickupArea: "Banani Block C", pickupDistrict: "Dhaka North" },
    });
    const owner = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: m.id }], "Shop Owner");
    const staff = await userWithRoles(ctx, [{ role: "MERCHANT_STAFF", merchantId: m.id }], "Shop Staff");
    return { m, owner, staff };
  }
  const book = async (token: string, type: "ECOMMERCE" | "DOCUMENT" = "ECOMMERCE") => {
    const res = await ctx.api("POST", "/parcels", {
      token,
      body: parcelBody({ sender: { name: "Shop", phone: "01711111111" }, pickup: { category: "Office", street: "House 12, Road 5, Banani", area: "Banani Block C", zone: "Banani", district: "Dhaka North" }, type, saveAddresses: false, ...(type === "DOCUMENT" ? { codAmount: 0 } : {}) }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { trackingId: string };
  };

  it("tells a merchant's team about a parcel outcome, live, with a deep link into their panel", async () => {
    const publish = vi.spyOn(ctx.app.get(RealtimeService), "publish");
    const { owner, staff } = await workspace("BANKING_FINANCIAL");
    const other = await workspace();
    const { trackingId } = await book(owner.token, "DOCUMENT");
    const cancel = await ctx.api("POST", `/parcels/${trackingId}/cancel`, { token: owner.token, body: { reason: "Customer changed their mind" } });
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);

    const list = await ctx.api("GET", "/me/notifications", { token: staff.token });
    expect(list.status).toBe(200);
    expect(list.body.unread).toBe(1);
    expect(list.body.items[0]).toMatchObject({ type: "parcel.cancelled", title: `${trackingId} was cancelled`, link: `/banking-merchant?parcel=${trackingId}`, readAt: null });
    expect((await ctx.api("GET", "/me/notifications/count", { token: owner.token })).body).toEqual({ unread: 1 });
    // Other workspaces see nothing.
    expect((await ctx.api("GET", "/me/notifications/count", { token: other.owner.token })).body).toEqual({ unread: 0 });

    // Announced (to the recipients only) once committed.
    await until(
      async () => publish.mock.calls.some(([e]) => e.type === "notification.created"),
      v => v,
    );
    const event = publish.mock.calls.map(([e]) => e).find(e => e.type === "notification.created")!;
    expect(new Set(event.userIds)).toEqual(new Set([owner.user.id, staff.user.id]));
    expect(event.staffPermission).toBe("notification:own-only");
    const realtime = ctx.app.get(RealtimeService);
    const superAdmin = { kind: "user", userId: "x", roles: [], permissions: new Set(["parcel:read:any", "merchant:read:any"]) } as never;
    expect(realtime.canSee(superAdmin, event)).toBe(false);
    publish.mockRestore();
  });

  it("marks one or all read, pages and filters unread, and keeps each person to their own", async () => {
    const { owner, staff } = await workspace();
    for (let i = 0; i < 3; i++) {
      const { trackingId } = await book(owner.token);
      await ctx.api("POST", `/parcels/${trackingId}/cancel`, { token: owner.token, body: {} });
    }
    const page1 = await ctx.api("GET", "/me/notifications?limit=2", { token: owner.token });
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.nextCursor).toBeTruthy();
    const page2 = await ctx.api("GET", `/me/notifications?limit=2&cursor=${page1.body.nextCursor}`, { token: owner.token });
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.nextCursor).toBeNull();

    const first = page1.body.items[0];
    // Someone else's notification: 404, nothing changes.
    expect((await ctx.api("POST", `/me/notifications/${first.id}/read`, { token: staff.token })).status).toBe(404);
    const read = await ctx.api("POST", `/me/notifications/${first.id}/read`, { token: owner.token });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ id: first.id, read: true, unread: 2 });
    expect((await ctx.api("GET", "/me/notifications?unread=true", { token: owner.token })).body.items.map((n: { id: string }) => n.id)).not.toContain(first.id);
    expect((await ctx.api("GET", "/me/notifications/count", { token: staff.token })).body.unread).toBe(3);

    const all = await ctx.api("POST", "/me/notifications/read-all", { token: owner.token });
    expect(all.body).toEqual({ updated: 2, unread: 0 });
    expect((await ctx.api("GET", "/me/notifications/count", { token: owner.token })).body.unread).toBe(0);
    expect((await ctx.api("GET", "/me/notifications/count", { token: staff.token })).body.unread).toBe(3);
    expect(await ctx.prisma.auditLog.count({ where: { action: { in: ["notification.read", "notification.read_all"] } } })).toBe(2);
    expect((await ctx.api("GET", "/me/notifications")).status).toBe(401);
  });

  it("follows the event's switch in Global notifications", async () => {
    const admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Admin");
    for (const channel of ["sms", "email", "push"]) {
      const off = await ctx.api("PUT", `/notifications/templates/parcel.cancelled/${channel}`, { token: admin.token, body: { enabled: false } });
      expect([200, 404]).toContain(off.status); // 404: the event has no template on that channel
    }
    const { owner } = await workspace();
    const { trackingId } = await book(owner.token);
    await ctx.api("POST", `/parcels/${trackingId}/cancel`, { token: owner.token, body: {} });
    expect((await ctx.api("GET", "/me/notifications/count", { token: owner.token })).body.unread).toBe(0);
  });

  it("support: the desk hears about a requester's ticket and reply, the requester about staff replies", async () => {
    const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Rahim Uddin");
    const agent = await userWithRoles(ctx, [{ role: "SUPPORT_AGENT" }], "Support Agent");
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops Manager");
    const hubOp = await userWithRoles(ctx, [{ role: "HUB_OPERATOR" }], "Hub Op");
    const ticket = (await ctx.api("POST", "/support/tickets", { token: customer.token, body: { category: "Delivery issue", subject: "Parcel is late", message: "Where is it?" } })).body;
    const desk = await ctx.api("GET", "/me/notifications", { token: agent.token });
    expect(desk.body.items[0]).toMatchObject({ type: "staff.ticket", title: `New ticket ${ticket.number}`, body: "Rahim Uddin: Parcel is late", link: `/courier-operation?page=support&ticket=${ticket.number}` });
    expect((await ctx.api("GET", "/me/notifications/count", { token: ops.token })).body.unread).toBe(1);
    expect((await ctx.api("GET", "/me/notifications/count", { token: hubOp.token })).body.unread).toBe(0);

    // Staff reply → the requester (in-app copy of support.ticket_reply, website link).
    expect((await ctx.api("POST", `/support/tickets/${ticket.number}/messages`, { token: agent.token, body: { body: "On its way." } })).status).toBeLessThan(300);
    const mine = await ctx.api("GET", "/me/notifications", { token: customer.token });
    expect(mine.body.items[0]).toMatchObject({ type: "support.ticket_reply", title: `New reply on ${ticket.number}`, link: `/support/${ticket.number}` });

    // Once assigned, the requester's reply goes to the assignee only.
    expect((await ctx.api("PATCH", `/support/tickets/${ticket.number}`, { token: ops.token, body: { assigneeId: agent.user.id } })).status).toBe(200);
    await ctx.api("POST", `/support/tickets/${ticket.number}/messages`, { token: customer.token, body: { body: "Thanks, still waiting." } });
    expect((await ctx.api("GET", "/me/notifications?unread=true", { token: agent.token })).body.items[0]).toMatchObject({ title: `New reply on ${ticket.number}` });
    expect((await ctx.api("GET", "/me/notifications/count", { token: ops.token })).body.unread).toBe(1);
  });

  it("operations: an SLA breach rings the operations managers' bell", async () => {
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops Manager");
    const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Rahim Uddin");
    const { trackingId } = (await ctx.api("POST", "/parcels", { token: customer.token, body: parcelBody() })).body;
    await ctx.prisma.parcel.update({ where: { trackingId }, data: { pickupDueAt: new Date(Date.now() - 60_000) } });
    const run = await ctx.api("POST", "/sla/monitor", { token: ops.token });
    expect(run.body.breached, JSON.stringify(run.body)).toBe(1);
    const list = await ctx.api("GET", "/me/notifications", { token: ops.token });
    expect(list.body.items[0]).toMatchObject({ type: "ops.sla_breach", title: "1 parcel breached SLA", link: "/courier-operation?page=problems&tab=sla-late-risk" });
    // The customer's own booking notice is theirs alone.
    expect((await ctx.api("GET", "/me/notifications", { token: customer.token })).body.items.map((n: { type: string }) => n.type)).not.toContain("ops.sla_breach");
  });

  it("staff alerts: merchant registrations reach super admins", async () => {
    const admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Admin");
    const applicant = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "New Shop Owner");
    const apply = await ctx.api("POST", "/merchants/applications", {
      token: applicant.token,
      body: { type: "ECOMMERCE", name: "Fresh Shop", contactName: "Owner", contactPhone: "01711111112", business: { district: "Dhaka North", zone: "Uttara", street: "Road 1, Sector 3" }, pickupTime: "MORNING" },
    });
    if (apply.status === 201) {
      const list = await ctx.api("GET", "/me/notifications", { token: admin.token });
      expect(list.body.items.find((n: { type: string }) => n.type === "staff.merchant_application")).toMatchObject({ title: "New merchant registration: Fresh Shop", link: "/super-admin?page=registrations" });
      // The applicant's own copy of "application received".
      expect((await ctx.api("GET", "/me/notifications", { token: applicant.token })).body.items[0]).toMatchObject({ type: "merchant.application_received" });
    } else expect(apply.status, JSON.stringify(apply.body)).toBe(201);
  });
});
