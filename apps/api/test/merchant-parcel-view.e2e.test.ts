import { hub, parcelBody, resetDatabase, riderUser, startApp, userWithRoles, type TestContext } from "./helpers";

// The merchant parcel drawer (both merchant panels) reads GET /parcels/:id and GET /parcels?q= with the
// merchant's own token: merchant-safe fields only. Staff notes, internal tracking events and who wrote them,
// the attempt list with rider names, the rider's phone, the return requester / run id and audit data never
// reach a merchant; the stored per-parcel messages come by name (service.messages).
describe("merchant parcel view: merchant-safe fields only", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  const NOTE = "INTERNAL-ONLY staff note: recipient is a known fraud risk";
  const RETURN_NOTE = "Recipient refused twice";

  const setup = async () => {
    const gulshan = await hub(ctx, "HUB-GUL");
    const merchant = (code: string, name: string, phone: string) =>
      ctx.prisma.merchant.create({
        data: { code, type: "ECOMMERCE", name, status: "ACTIVE", kycStatus: "APPROVED", contactName: "Owner", contactPhone: phone, pickupAddress: "House 5 Road 2", pickupArea: "Gulshan", pickupDistrict: "Dhaka North" },
      });
    const shop = await merchant("MR-MPV1", "Drawer Shop", "+8801911000010");
    const other = await merchant("MR-MPV2", "Other Shop", "+8801911000011");
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Opsname Staffperson");
    const owner = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: shop.id }], "Shop Owner");
    const otherOwner = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: other.id }], "Other Owner");
    const rider = await riderUser(ctx, "R-8801", gulshan.id);
    return { gulshan, shop, other, ops, owner, otherOwner, rider };
  };
  type Setup = Awaited<ReturnType<typeof setup>>;

  const book = async (token: string, overrides: Record<string, unknown> = {}) => {
    await ctx.api("GET", "/packages/me", { token }); // package set-up
    const res = await ctx.api("POST", "/parcels", { token, body: { ...parcelBody({ serviceLevel: "Regular", contents: undefined }), ...overrides } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.trackingId as string;
  };

  /** Picked up to the hub, a staff note, out for delivery, one failed attempt back to the hub, then return scheduled by operations. */
  const history = async (s: Setup, id: string) => {
    await ctx.api("POST", `/parcels/${id}/assign-pickup`, { token: s.ops.token, body: { riderId: s.rider.rider.id } });
    const atHub = await ctx.api("POST", `/rider/parcels/${id}/pickup`, { token: s.rider.token, body: { outcome: "COLLECTED_TO_HUB", hubId: s.gulshan.id } });
    expect(atHub.body.status, JSON.stringify(atHub.body)).toBe("AT_HUB");
    const note = await ctx.api("POST", `/parcels/${id}/notes`, { token: s.ops.token, body: { note: NOTE } });
    expect(note.status, JSON.stringify(note.body)).toBeLessThan(300);
    await ctx.api("POST", `/parcels/${id}/assign-delivery`, { token: s.ops.token, body: { riderId: s.rider.rider.id } });
    const failed = await ctx.api("POST", `/rider/parcels/${id}/delivery`, { token: s.rider.token, body: { outcome: "FAILED", reason: "Recipient unavailable", nextAction: "RETURN_TO_HUB", hubId: s.gulshan.id } });
    expect(failed.status, JSON.stringify(failed.body)).toBe(200);
    const sched = await ctx.api("POST", `/parcels/${id}/status`, { token: s.ops.token, body: { status: "RETURN_SCHEDULED", note: RETURN_NOTE } });
    expect(sched.status, JSON.stringify(sched.body)).toBe(200);
  };

  it("gives the merchant its parcel without staff notes, staff names, attempt riders, the rider phone or return internals", async () => {
    const s = await setup();
    const id = await book(s.owner.token, { merchantOrderRef: "ORD-MPV-1", notifications: ["notify.booked", "notify.delivered"] });
    await history(s, id);

    // Staff see the note, who wrote it, the attempt riders and the return requester.
    const staff = (await ctx.api("GET", `/parcels/${id}`, { token: s.ops.token })).body;
    expect(JSON.stringify(staff)).toContain(NOTE);
    expect(staff.events.some((e: { internal: boolean }) => e.internal)).toBe(true);
    expect(staff.attempts[0].rider).toMatchObject({ code: "R-8801" });
    expect(staff.lastFailedAttempt.riderName).toBe("Rider R-8801");
    expect(staff.returnInfo.requestedBy).toBe("Opsname Staffperson");

    const view = (await ctx.api("GET", `/parcels/${id}`, { token: s.owner.token })).body;
    const json = JSON.stringify(view);
    expect(view).toMatchObject({
      trackingId: id,
      status: "RETURN_SCHEDULED",
      merchantOrderRef: "ORD-MPV-1",
      failedAttempts: 1,
      lastFailedAttempt: { reason: "Recipient unavailable" },
      returnInfo: { reason: RETURN_NOTE, onReturnRun: false },
      service: { messages: ["Pickup request received (sender)", "Delivered (sender)"] },
    });
    // Never: internal notes and events, who wrote events, attempt riders, rider phone, return internals, audit, booking batch.
    expect(json).not.toContain(NOTE);
    expect(json).not.toContain("Opsname");
    expect(view.events.every((e: { internal: boolean; actor?: string }) => !e.internal && e.actor === undefined)).toBe(true);
    expect(view.attempts).toBeUndefined();
    expect(view.lastFailedAttempt.riderName).toBeUndefined();
    expect(view.deliveryRider?.phone).toBeUndefined();
    expect(json).not.toContain(s.rider.phone);
    expect(view.returnInfo.requestedBy).toBeUndefined();
    expect(view.returnInfo.runId).toBeUndefined();
    expect(view.bookingBatch).toBeUndefined();
    for (const key of ["audit", "auditLog", "internalNote", "costs"]) expect(view[key]).toBeUndefined();

    // The list (the drawer's search) is the same merchant view.
    const listed = (await ctx.api("GET", `/parcels?limit=20&q=ORD-MPV-1`, { token: s.owner.token })).body.items;
    expect(listed.map((p: { trackingId: string }) => p.trackingId)).toEqual([id]);
    expect(JSON.stringify(listed)).not.toContain(NOTE);
    expect(listed[0].attempts).toBeUndefined();
  });

  it("finds only the merchant's own parcels by tracking ID, order ref, phone (any +880 form) and name", async () => {
    const s = await setup();
    const own = await book(s.owner.token, { merchantOrderRef: "ORD-MINE-7", recipient: { name: "Searchable Recipient", phone: "01812345670" } });
    const theirs = await book(s.otherOwner.token, { merchantOrderRef: "ORD-THEIRS-7", recipient: { name: "Searchable Recipient", phone: "01812345670" } });
    const found = async (q: string) => ((await ctx.api("GET", `/parcels?limit=20&q=${encodeURIComponent(q)}`, { token: s.owner.token })).body.items as { trackingId: string }[]).map(p => p.trackingId);

    for (const q of [own, own.toLowerCase(), "ORD-MINE-7", "01812345670", "1812345670", "+8801812345670", "Searchable Recipient"]) expect(await found(q), q).toEqual([own]);
    expect(await found(theirs)).toEqual([]);
    expect(await found("ORD-THEIRS-7")).toEqual([]);
    expect((await ctx.api("GET", `/parcels/${theirs}`, { token: s.owner.token })).status).toBe(404);
  });
});
