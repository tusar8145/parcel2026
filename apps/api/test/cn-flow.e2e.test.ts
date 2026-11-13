import { hub, resetDatabase, riderUser, startApp, userWithRoles, type TestContext } from "./helpers";

// The apps' CN_ features on pre-printed CN labels: CN_Scan (photo + CN) and CN_Merchant (scan for a merchant), in any
// order; one CN, one parcel; an ordinary parcel afterwards (delivered without an address, location kept).
describe("CN_Scan and CN_Merchant (apps)", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  const setup = async () => {
    const gulshan = await hub(ctx, "HUB-CNG");
    const other = await hub(ctx, "HUB-CNO");
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops Manager");
    const gulOp = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: gulshan.id }], "Gulshan Operator");
    const admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Super Admin");
    const rider = await riderUser(ctx, "R-6101", gulshan.id);
    const shop = await ctx.prisma.merchant.create({
      data: { code: "MR-7101", type: "ECOMMERCE", name: "CN Shop", status: "ACTIVE", contactName: "Owner", contactPhone: "+8801911000101", pickupAddress: "House 5", pickupArea: "Gulshan 1", pickupDistrict: "Dhaka North" },
    });
    const shop2 = await ctx.prisma.merchant.create({
      data: { code: "MR-7102", type: "ECOMMERCE", name: "Other Shop", status: "ACTIVE", contactName: "Owner 2", contactPhone: "+8801911000102", pickupAddress: "House 9", pickupArea: "Banani", pickupDistrict: "Dhaka North" },
    });
    const batch = await ctx.api("POST", "/cn/batches", { token: gulOp.token, body: { count: 5, hubId: gulshan.id } });
    expect(batch.status, JSON.stringify(batch.body)).toBe(201);
    const cns = batch.body.items.map((i: { cn: string }) => i.cn) as string[];
    return { gulshan, other, ops, gulOp, admin, rider, shop, shop2, cns };
  };

  /** CN_Scan: multipart photo + fields. */
  const capture = async (token: string, fields: Record<string, string>) => {
    const boundary = `----dfCn${Math.random().toString(16).slice(2)}`;
    const payload = Buffer.concat([
      ...Object.entries(fields).map(([k, v]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="cn.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await ctx.app.inject({ method: "POST", url: "/api/v1/cn/parcels/capture", payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${token}` } });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };
  const parcelOf = (cn: string) => ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: cn } });

  it("CN_Scan first, then CN_Merchant: one parcel, received at the hub, no messages until the merchant is known", async () => {
    const s = await setup();
    const [cn1] = s.cns;

    const first = await capture(s.gulOp.token, { cn: cn1.toLowerCase(), hubId: s.gulshan.id });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ outcome: "CREATED", ok: true, parcel: { trackingId: cn1, merchant: null, incomplete: true, photos: 1 } });
    let p = await parcelOf(cn1);
    expect(p).toMatchObject({ cnFlow: true, status: "AT_HUB", currentHubId: s.gulshan.id, merchantId: null, notifyChannels: [] });
    expect((await ctx.prisma.cnStock.findUniqueOrThrow({ where: { cn: cn1 } })).status).toBe("USED");

    // The same label again: the same parcel, one more photo.
    const again = await capture(s.gulOp.token, { cn: cn1, hubId: s.gulshan.id });
    expect(again.body).toMatchObject({ outcome: "ADDED", parcel: { trackingId: cn1, photos: 2 } });
    expect(await ctx.prisma.parcel.count({ where: { trackingId: cn1 } })).toBe(1);
    // Nothing was sent for it (no merchant yet).
    expect(await ctx.prisma.outboxMessage.count({ where: { trackingId: cn1 } })).toBe(0);

    // CN_Merchant: it becomes the shop's parcel, priced by its plan, with its messages on.
    const merchant = await ctx.api("POST", "/cn/parcels/merchant", { token: s.gulOp.token, body: { cn: cn1, merchantId: s.shop.id, hubId: s.gulshan.id } });
    expect(merchant.status, JSON.stringify(merchant.body)).toBe(200);
    expect(merchant.body).toMatchObject({ outcome: "ASSIGNED", ok: true, parcel: { merchant: { id: s.shop.id } } });
    p = await parcelOf(cn1);
    expect(p).toMatchObject({ merchantId: s.shop.id, senderName: "CN Shop" });
    expect(p.packageVersionId).not.toBeNull();
    expect(p.notifyChannels.length).toBeGreaterThan(0);

    expect((await ctx.api("POST", "/cn/parcels/merchant", { token: s.gulOp.token, body: { cn: cn1, merchantId: s.shop.id, hubId: s.gulshan.id } })).body.outcome).toBe("ALREADY");
    const otherShop = await ctx.api("POST", "/cn/parcels/merchant", { token: s.gulOp.token, body: { cn: cn1, merchantId: s.shop2.id, hubId: s.gulshan.id } });
    expect(otherShop.body).toMatchObject({ outcome: "OTHER_MERCHANT", ok: false });
    expect((await parcelOf(cn1)).merchantId).toBe(s.shop.id);

    // Parcel details show its CN photos (AI is off in tests: kept, not read).
    const photos = await ctx.api("GET", `/cn/parcels/${cn1}/captures`, { token: s.ops.token });
    expect(photos.body.items).toHaveLength(2);
    expect(photos.body.items[0].status).toBe("SKIPPED");
  });

  it("CN_Merchant first (rider: awaiting drop-off at the rider's hub); refused labels; hub scope", async () => {
    const s = await setup();
    const [, cn2, cn3, cn4] = s.cns;

    const byRider = await ctx.api("POST", "/cn/parcels/merchant", { token: s.rider.token, body: { cn: cn2, merchantId: s.shop.id } });
    expect(byRider.status, JSON.stringify(byRider.body)).toBe(200);
    expect(byRider.body.outcome).toBe("CREATED");
    expect(await parcelOf(cn2)).toMatchObject({ status: "PENDING_CONFIRMATION", intake: "DROP_OFF", dropOffHubId: s.gulshan.id, merchantId: s.shop.id, cnFlow: true });
    // Then CN_Scan adds the photo to it.
    expect((await capture(s.rider.token, { cn: cn2 })).body.outcome).toBe("ADDED");

    await ctx.api("POST", "/cn/stock/void", { token: s.gulOp.token, body: { cns: [cn3], reason: "Torn label" } });
    expect((await capture(s.gulOp.token, { cn: cn3, hubId: s.gulshan.id })).body.error.code).toBe("CN_VOID");
    expect((await capture(s.gulOp.token, { cn: "PP-261114-ZZZZZ", hubId: s.gulshan.id })).body.error.code).toBe("CN_UNKNOWN");
    // Another hub's operator can't scan for this hub.
    expect((await capture(s.gulOp.token, { cn: cn4, hubId: s.other.id })).status).toBe(403);
  });

  it("delivers a CN parcel without an address and keeps where the rider delivered it", async () => {
    const s = await setup();
    const [cn1] = s.cns;
    await capture(s.gulOp.token, { cn: cn1, hubId: s.gulshan.id });
    await ctx.api("POST", "/cn/parcels/merchant", { token: s.gulOp.token, body: { cn: cn1, merchantId: s.shop.id, hubId: s.gulshan.id } });
    const assigned = await ctx.api("POST", `/parcels/${cn1}/assign-delivery`, { token: s.ops.token, body: { riderId: s.rider.rider.id } });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    expect((await ctx.api("POST", `/rider/parcels/${cn1}/start-delivery`, { token: s.rider.token })).status).toBe(200);
    const done = await ctx.api("POST", `/rider/parcels/${cn1}/delivery`, {
      token: s.rider.token,
      body: { outcome: "DELIVERED", receivedBy: "Karim", proof: { method: "SIGNATURE", image: PNG }, capture: { lat: 23.7925, lng: 90.4078, accuracy: 12 } },
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(await parcelOf(cn1)).toMatchObject({ status: "DELIVERED", deliveredLat: 23.7925, deliveredLng: 90.4078, deliveredAccuracy: 12 });
    const view = await ctx.api("GET", `/parcels/${cn1}`, { token: s.ops.token });
    expect(view.body).toMatchObject({ cnFlow: true, deliveredLocation: { lat: 23.7925, lng: 90.4078 } });
  });

  it("super admin: the CN_Scan AI switch, daily limit and cost", async () => {
    const s = await setup();
    const before = await ctx.api("GET", "/cn/settings", { token: s.admin.token });
    expect(before.body).toMatchObject({ aiEnabled: true, dailyLimit: null });
    const saved = await ctx.api("PUT", "/cn/settings", { token: s.admin.token, body: { aiEnabled: false, dailyLimit: 50 } });
    expect(saved.body).toMatchObject({ aiEnabled: false, dailyLimit: 50 });
    expect((await ctx.api("PUT", "/cn/settings", { token: s.gulOp.token, body: { aiEnabled: true, dailyLimit: null } })).status).toBe(403);
    await capture(s.gulOp.token, { cn: s.cns[0], hubId: s.gulshan.id });
    const usage = await ctx.api("GET", "/cn/usage?from=2020-01-01&to=2099-12-31", { token: s.admin.token });
    expect(usage.body).toMatchObject({ photos: 1, skipped: 1, reads: 0, costUsd: 0 });
  });
});
