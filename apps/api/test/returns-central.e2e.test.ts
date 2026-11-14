import { hub, parcelBody, resetDatabase, riderUser, startApp, userWithRoles, type TestContext } from "./helpers";

// Returns through the central hub (Scan desk / Operations app): Return issue at any hub (with a rider: straight on
// that rider's return run; without: on the returns list, optionally sent on to the central hub in the same scan),
// Return transfer to the central hub, received there with Receive at hub, then Return rider assign; the hub's summary.
describe("returns through the central hub", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  let seq = 8100;
  const setup = async () => {
    const branch = await hub(ctx, "HUB-BRN");
    const central = await hub(ctx, "HUB-CEN");
    await ctx.prisma.setting.upsert({ where: { key: "accounts.config" }, create: { key: "accounts.config", value: { centralHubId: central.id } }, update: { value: { centralHubId: central.id } } });
    const shop = await ctx.prisma.merchant.create({
      data: { code: `MR-${++seq}`, type: "ECOMMERCE", name: "Return Shop", status: "ACTIVE", contactName: "Owner", contactPhone: "+8801911000000", pickupAddress: "House 5 Road 2", pickupArea: "Gulshan 1", pickupDistrict: "Dhaka North" },
    });
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops Manager");
    const rider = await riderUser(ctx, "R-8101", branch.id);
    const centralRider = await riderUser(ctx, "R-8102", central.id);
    return { branch, central, shop, ops, rider, centralRider };
  };
  type Setup = Awaited<ReturnType<typeof setup>>;

  /** Booked and picked up to the branch hub (AT_HUB there). */
  const atBranch = async (s: Setup) => {
    const res = await ctx.api("POST", "/ops/parcels", { token: s.ops.token, body: { merchantId: s.shop.id, ...parcelBody(), sender: undefined, pickup: undefined } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const id = res.body.trackingId as string;
    await ctx.api("POST", `/parcels/${id}/assign-pickup`, { token: s.ops.token, body: { riderId: s.rider.rider.id } });
    const atHub = await ctx.api("POST", `/rider/parcels/${id}/pickup`, { token: s.rider.token, body: { outcome: "COLLECTED_TO_HUB", hubId: s.branch.id } });
    expect(atHub.body.status, JSON.stringify(atHub.body)).toBe("AT_HUB");
    return id;
  };
  const post = async (s: Setup, path: string, body: Record<string, unknown>) => {
    const res = await ctx.api("POST", path, { token: s.ops.token, body });
    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    return res.body;
  };
  const summary = async (s: Setup, hubId: string) => {
    const res = await ctx.api("GET", `/hub-desk/returns-summary?hubId=${hubId}`, { token: s.ops.token });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  };
  const parcel = async (s: Setup, id: string) => (await ctx.api("GET", `/parcels/${id}`, { token: s.ops.token })).body;

  it("issues at a branch, transfers to the central hub, receives there and puts it on a rider's run", async () => {
    const s = await setup();
    const id = await atBranch(s);

    expect(await summary(s, s.branch.id)).toMatchObject({ isCentral: false, centralHub: { id: s.central.id }, waiting: { count: 0, next: "TRANSFER" } });
    // Not going back yet: transfer asks for the return first.
    expect(await post(s, "/hub-desk/return-transfer", { code: id, hubId: s.branch.id })).toMatchObject({ ok: false, outcome: "NO_RETURN" });

    expect(await post(s, "/hub-desk/return-issue", { code: id, hubId: s.branch.id, reason: "Recipient refused" })).toMatchObject({ ok: true, outcome: "ISSUED" });
    expect(await post(s, "/hub-desk/return-issue", { code: id, hubId: s.branch.id, reason: "Recipient refused" })).toMatchObject({ ok: true, outcome: "ALREADY_ISSUED" });
    const branchView = await summary(s, s.branch.id);
    expect(branchView.waiting).toMatchObject({ count: 1, next: "TRANSFER" });
    expect(branchView.waiting.items[0]).toMatchObject({ trackingId: id, reason: "Recipient refused", merchant: "Return Shop" });

    expect(await post(s, "/hub-desk/return-transfer", { code: id, hubId: s.branch.id })).toMatchObject({ ok: true, outcome: "SENT_TO_CENTRAL" });
    expect(await parcel(s, id)).toMatchObject({ status: "IN_TRANSIT" });
    expect(await post(s, "/hub-desk/return-transfer", { code: id, hubId: s.branch.id })).toMatchObject({ ok: true, outcome: "ALREADY_IN_TRANSIT" });
    expect((await summary(s, s.branch.id)).waiting.count).toBe(0);
    expect(await summary(s, s.central.id)).toMatchObject({ isCentral: true, coming: { count: 1 }, waiting: { count: 0, next: "ASSIGN_RIDER" } });

    // The central hub receives it as any arrival; the return stays.
    expect(await post(s, "/ops/hub-receive", { code: id, hubId: s.central.id })).toMatchObject({ ok: true, outcome: "RECEIVED" });
    expect(await summary(s, s.central.id)).toMatchObject({ coming: { count: 0 }, waiting: { count: 1, next: "ASSIGN_RIDER" } });
    expect(await post(s, "/hub-desk/return-transfer", { code: id, hubId: s.central.id })).toMatchObject({ ok: false, outcome: "AT_CENTRAL" });

    expect(await post(s, "/hub-desk/return-assign", { code: id, hubId: s.central.id, riderId: s.centralRider.rider.id })).toMatchObject({ ok: true, outcome: "ASSIGNED" });
    expect(await parcel(s, id)).toMatchObject({ status: "RETURN_SCHEDULED" });
    expect(await summary(s, s.central.id)).toMatchObject({ waiting: { count: 0 }, plannedRuns: 1 });
  });

  it("issues and sends on in one scan, or straight to a rider; refuses another hub's parcel", async () => {
    const s = await setup();
    const sendOn = await atBranch(s);
    const direct = await atBranch(s);
    const other = await atBranch(s);

    expect(await post(s, "/hub-desk/return-issue", { code: sendOn, hubId: s.branch.id, reason: "Recipient refused", toCentral: true })).toMatchObject({ ok: true, outcome: "ISSUED_SENT" });
    expect(await parcel(s, sendOn)).toMatchObject({ status: "IN_TRANSIT" });

    // With a rider: the rider takes it straight to the merchant (their return run at this hub).
    expect(await post(s, "/hub-desk/return-issue", { code: direct, hubId: s.branch.id, reason: "Recipient refused", riderId: s.rider.rider.id })).toMatchObject({ ok: true, outcome: "ASSIGNED" });
    expect(await parcel(s, direct)).toMatchObject({ status: "RETURN_SCHEDULED" });
    const runs = (await ctx.api("GET", "/rider/return-runs", { token: s.rider.token })).body;
    expect(JSON.stringify(runs)).toContain(direct);

    // Transfer with a reason issues the return first.
    expect(await post(s, "/hub-desk/return-transfer", { code: other, hubId: s.branch.id, reason: "Damaged in transit" })).toMatchObject({ ok: true, outcome: "SENT_TO_CENTRAL" });

    // A central hub operator can't issue a return for a parcel held at the branch.
    const fresh = await atBranch(s);
    const centralOperator = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: s.central.id }], "Central Operator");
    const refused = await ctx.api("POST", "/hub-desk/return-issue", { token: centralOperator.token, body: { code: fresh, reason: "Recipient refused" } });
    expect(refused.body, JSON.stringify(refused.body)).toMatchObject({ ok: false, outcome: "OTHER_HUB" });
  });
});
