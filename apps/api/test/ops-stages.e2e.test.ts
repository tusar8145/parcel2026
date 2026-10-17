import { hub, parcelBody, resetDatabase, riderUser, startApp, userWithRoles, type TestContext } from "./helpers";

// Courier Operations' paged lists and stage counts (read-only): GET /parcels?stage=&line=&forHubIds=
// and GET /ops/stage-counts (apps/api/src/modules/parcels/parcel-stages.ts).
describe("journey stages: paged list filters and stage counts", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  let seq = 4000;
  const merchant = (type: "ECOMMERCE" | "BANKING_FINANCIAL", name: string) =>
    ctx.prisma.merchant.create({
      data: { code: `MR-${++seq}`, type, name, status: "ACTIVE", contactName: "Owner", contactPhone: "+8801911000000", pickupAddress: "House 5 Road 2", pickupArea: "Gulshan 1", pickupDistrict: "Dhaka North" },
    });

  const setup = async () => {
    const gulshan = await hub(ctx, "HUB-GUL");
    const dhanmondi = await hub(ctx, "HUB-DHN");
    // Gulshan's hub serves the Gulshan zone: pickups from there belong to it before any hub holds them.
    await ctx.prisma.deliveryZone.create({ data: { code: "DHN-GUL", name: "Gulshan", district: "Dhaka North", hubId: gulshan.id } });
    const shop = await merchant("ECOMMERCE", "Stage Shop");
    const bank = await merchant("BANKING_FINANCIAL", "Stage Bank");
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops Manager");
    const hubOp = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: gulshan.id }], "Gulshan Operator");
    const owner = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: shop.id }], "Shop Owner");
    const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Rahim Uddin");
    const rider = await riderUser(ctx, "R-4048", gulshan.id);
    return { gulshan, dhanmondi, shop, bank, ops, hubOp, owner, customer, rider };
  };
  type Setup = Awaited<ReturnType<typeof setup>>;

  const book = async (s: Setup, merchantId: string, extra: Record<string, unknown> = {}) => {
    const res = await ctx.api("POST", "/ops/parcels", { token: s.ops.token, body: { merchantId, ...parcelBody(), sender: undefined, pickup: undefined, ...extra } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.trackingId as string;
  };
  const ids = async (token: string, query: string) => {
    const res = await ctx.api("GET", `/parcels?limit=200&${query}`, { token });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body.items as { trackingId: string }[]).map(p => p.trackingId).sort();
  };
  const counts = async (token: string, query = "") => {
    const res = await ctx.api("GET", `/ops/stage-counts${query}`, { token });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { hubIds: string[] | null; stages: Record<string, number>; detail: Record<string, number> };
  };

  it("filters the parcel list by stage, service line and hub, and counts each stage the same way", async () => {
    const s = await setup();
    const shopParcel = await book(s, s.shop.id);
    const bankParcel = await book(s, s.bank.id, { codAmount: 0 });
    const customerRes = await ctx.api("POST", "/parcels", { token: s.customer.token, body: parcelBody() });
    expect(customerRes.status, JSON.stringify(customerRes.body)).toBe(201);
    const customerParcel = customerRes.body.trackingId as string;
    const dropOff = await book(s, s.shop.id, { intake: "DROP_OFF", dropOffHubId: s.dhanmondi.id });

    // New orders: every order waiting for operations, rider pickups and drop-offs.
    expect(await ids(s.ops.token, "stage=new")).toEqual([shopParcel, bankParcel, customerParcel, dropOff].sort());
    // Service lines.
    expect(await ids(s.ops.token, "line=ECOMMERCE")).toEqual([shopParcel, dropOff].sort());
    expect(await ids(s.ops.token, "line=BANKING_FINANCIAL")).toEqual([bankParcel]);
    expect(await ids(s.ops.token, "line=CUSTOMER")).toEqual([customerParcel]);
    expect(await ids(s.ops.token, "stage=new&line=CUSTOMER")).toEqual([customerParcel]);
    // "My hub": pickups from the zones a hub serves, and drop-offs booked to it.
    expect(await ids(s.ops.token, `stage=new&forHubIds=${s.gulshan.id}`)).toEqual([shopParcel, bankParcel, customerParcel].sort());
    expect(await ids(s.ops.token, `stage=new&forHubIds=${s.dhanmondi.id}`)).toEqual([dropOff]);
    expect(await ids(s.ops.token, `stage=new&forHubIds=${s.gulshan.id},${s.dhanmondi.id}`)).toEqual([shopParcel, bankParcel, customerParcel, dropOff].sort());

    let c = await counts(s.ops.token);
    expect(c.hubIds).toBeNull();
    expect(c.stages).toMatchObject({ newOrders: 4, pickup: 0, hubDesk: 0, transfers: 0, delivery: 0, problems: 0, returns: 0 });
    expect((await counts(s.ops.token, `?forHubIds=${s.dhanmondi.id}`)).stages.newOrders).toBe(1);

    // Accepted with a rider: Pickup (being picked up), no longer New orders.
    await ctx.api("POST", `/parcels/${shopParcel}/assign-pickup`, { token: s.ops.token, body: { riderId: s.rider.rider.id } });
    expect(await ids(s.ops.token, "stage=new")).not.toContain(shopParcel);
    expect(await ids(s.ops.token, "stage=pickup")).toEqual([shopParcel]);
    expect(await ids(s.ops.token, "stage=pickup_waiting")).toEqual([]);
    // Picked up by a Gulshan rider: it belongs to Gulshan.
    expect(await ids(s.ops.token, `stage=pickup&forHubIds=${s.gulshan.id}`)).toEqual([shopParcel]);
    expect(await ids(s.ops.token, `stage=pickup&forHubIds=${s.dhanmondi.id}`)).toEqual([]);

    // At the Gulshan hub: Hub desk and "waiting for a delivery rider".
    const res = await ctx.api("POST", `/rider/parcels/${shopParcel}/pickup`, { token: s.rider.token, body: { outcome: "COLLECTED_TO_HUB", hubId: s.gulshan.id } });
    expect(res.body.status, JSON.stringify(res.body)).toBe("AT_HUB");
    expect(await ids(s.ops.token, "stage=hub")).toEqual([shopParcel]);
    expect(await ids(s.ops.token, "stage=delivery_waiting")).toEqual([shopParcel]);
    expect(await ids(s.ops.token, `stage=hub&forHubIds=${s.gulshan.id}`)).toEqual([shopParcel]);
    expect(await ids(s.ops.token, `stage=hub&forHubIds=${s.dhanmondi.id}`)).toEqual([]);

    // Problems: an exception, an order with details missing; late parcels; a return request.
    await ctx.api("POST", `/parcels/${customerParcel}/status`, { token: s.ops.token, body: { status: "EXCEPTION", note: "Sender unreachable" } });
    await ctx.prisma.parcel.update({ where: { trackingId: bankParcel }, data: { incomplete: true } });
    await ctx.prisma.parcel.update({ where: { trackingId: shopParcel }, data: { estimatedDeliveryAt: new Date(Date.now() - 3600_000), returnRequestedAt: new Date() } });
    expect(await ids(s.ops.token, "stage=exceptions")).toEqual([customerParcel]);
    expect(await ids(s.ops.token, "stage=needs_info")).toEqual([bankParcel]);
    expect(await ids(s.ops.token, "stage=problems")).toEqual([customerParcel, bankParcel].sort());
    expect(await ids(s.ops.token, "stage=sla_risk")).toEqual([shopParcel]);

    c = await counts(s.ops.token);
    expect(c.stages).toMatchObject({ newOrders: 2, pickup: 0, hubDesk: 1, problems: 2, returns: 1 });
    expect(c.detail).toMatchObject({ exceptions: 1, needsInfo: 1, slaRisk: 1, deliveryWaiting: 1, returnRequests: 1, returnsScheduled: 0 });
    const mine = await counts(s.hubOp.token, `?forHubIds=${s.gulshan.id}`);
    expect(mine.hubIds).toEqual([s.gulshan.id]);
    expect(mine.stages).toMatchObject({ hubDesk: 1, newOrders: 1 });
  });

  it("keeps each caller's own scope and validates the filters", async () => {
    const s = await setup();
    const own = await book(s, s.shop.id);
    await book(s, s.bank.id, { codAmount: 0 });
    // A merchant sees only its own parcels, whatever the filters.
    expect(await ids(s.owner.token, "stage=new")).toEqual([own]);
    expect(await ids(s.owner.token, "line=BANKING_FINANCIAL")).toEqual([]);
    // Counts are for operations staff.
    expect((await ctx.api("GET", "/ops/stage-counts", { token: s.owner.token })).status).toBe(403);
    expect((await ctx.api("GET", "/ops/stage-counts", { token: s.customer.token })).status).toBe(403);
    // Bad filters are refused (validation errors are 422).
    expect((await ctx.api("GET", "/parcels?stage=somewhere", { token: s.ops.token })).status).toBe(422);
    expect((await ctx.api("GET", "/parcels?line=POSTAL", { token: s.ops.token })).status).toBe(422);
    expect((await ctx.api("GET", "/parcels?forHubIds=not-a-hub", { token: s.ops.token })).status).toBe(422);
    expect((await ctx.api("GET", "/ops/stage-counts?forHubIds=not-a-hub", { token: s.ops.token })).status).toBe(422);
    // Paging still works with a stage.
    const first = await ctx.api("GET", "/parcels?stage=new&limit=1", { token: s.ops.token });
    expect(first.body.items).toHaveLength(1);
    const second = await ctx.api("GET", `/parcels?stage=new&limit=1&cursor=${first.body.nextCursor}`, { token: s.ops.token });
    expect(second.body.items).toHaveLength(1);
    expect(second.body.items[0].trackingId).not.toBe(first.body.items[0].trackingId);
    expect(second.body.nextCursor).toBeNull();
  });
});
