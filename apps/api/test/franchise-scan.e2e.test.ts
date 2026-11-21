import { encrypt, hashPassword } from "../src/common/crypto";
import { PASSWORD, hub, parcelBody, resetDatabase, riderUser, startApp, userWithRoles, type TestContext } from "./helpers";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/**
 * The franchise app's Scan (the Operations app's Scan without CN labels), at the franchise's own hub with its own
 * riders: Rider operation, Receive at hub, Delivery rider assign, Hub transfer, Hub return, Return rider assign and Hub
 * collection; the franchise's commission and its rider's pay as when the rider does the steps.
 */
describe("franchise app Scan", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  const relogin = async (phone: string) => (await ctx.api("POST", "/auth/login", { body: { identifier: phone, password: PASSWORD } })).body.accessToken as string;

  async function setup() {
    const admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Ayesha Admin");
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops Manager");
    const company = await hub(ctx, "HUB-CEN");
    await ctx.prisma.setting.upsert({ where: { key: "accounts.config" }, create: { key: "accounts.config", value: { centralHubId: company.id } }, update: { value: { centralHubId: company.id } } });
    const applicant = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Mizanur Rahman");
    const merchant = await ctx.prisma.merchant.create({
      data: { code: "MR-FS1", type: "ECOMMERCE", name: "Shop One", status: "ACTIVE", kycStatus: "APPROVED", contactName: "Owner", contactPhone: "+8801711111111", pickupAddress: "House 5 Road 2", pickupArea: "Gulshan", pickupDistrict: "Dhaka North" },
    });
    const shop = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: merchant.id }], "Shop Owner");
    const created = await ctx.api("POST", "/franchises", {
      token: admin.token,
      body: {
        name: "Mirpur Express Point",
        contactName: "Mizanur Rahman",
        phone: applicant.phone,
        hub: { name: "Mirpur 10 Franchise", district: "Dhaka North", zone: "Gulshan", address: "Mirpur 10 roundabout" },
        rates: { pickupPercent: 10, pickupMin: 15, deliveryPercent: 20, deliveryMin: 20, returnPercent: 10, returnMin: 10 },
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const hubId = created.body.hub.id as string;
    const token = await relogin(applicant.phone);
    const r = await ctx.api("POST", "/franchise/riders", { token, body: { name: "Rafi Rider", phone: "01913000001", vehicle: "MOTORBIKE" } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    await ctx.prisma.user.update({ where: { phone: "+8801913000001" }, data: { passwordHash: await hashPassword(PASSWORD) } });
    const companyRider = await riderUser(ctx, "R-4001", company.id);
    // The franchise pays its riders at its own rates (rider pay recorded only above 0).
    expect((await ctx.api("PUT", "/franchise/rider-rates", { token, body: { pickup: 20, delivery: 30, return: 15 } })).status).toBe(200);
    return { ops, company, merchant, shop, token, hubId, riderId: r.body.id as string, companyRider };
  }
  type Setup = Awaited<ReturnType<typeof setup>>;
  const f = (s: Setup, method: "GET" | "POST", path: string, body?: Record<string, unknown>) => ctx.api(method, `/franchise${path}`, { token: s.token, ...(body ? { body } : {}) });
  const status = async (id: string) => (await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: id } })).status;
  /** Booked by the shop, its pickup handed to the franchise hub and given to the franchise's rider. */
  const atFranchisePickup = async (s: Setup) => {
    const res = await ctx.api("POST", "/parcels", { token: s.shop.token, body: parcelBody({ serviceLevel: "Regular", contents: undefined }) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const id = res.body.trackingId as string;
    expect((await ctx.api("POST", `/parcels/${id}/pickup-hub`, { token: s.ops.token, body: { hubId: s.hubId } })).status).toBe(200);
    expect((await f(s, "POST", `/parcels/${id}/assign`, { riderId: s.riderId, task: "PICKUP" })).status).toBe(200);
    return id;
  };
  const op = (s: Setup, path: string, body?: Record<string, unknown>) => f(s, body ? "POST" : "GET", `/rider-op/${s.riderId}${path}`, body);

  it("Rider operation, receive, delivery rider assign: the franchise's commission and its rider's pay", async () => {
    const s = await setup();
    const a = await atFranchisePickup(s);
    const tasks = await op(s, "/tasks");
    expect(tasks.status, JSON.stringify(tasks.body)).toBe(200);
    expect(tasks.body.pickups.map((p: { trackingId: string }) => p.trackingId)).toEqual([a]);
    expect((await op(s, `/parcels/${a}/pickup`, { outcome: "COLLECTED" })).status).toBe(200);
    expect(await status(a)).toBe("PICKED_UP");
    expect((await ctx.prisma.riderEarning.findMany({ where: { riderId: s.riderId } })).map(e => e.type)).toEqual(["PICKUP"]);
    expect((await ctx.prisma.franchiseCommission.findMany()).map(c => c.type)).toEqual(["PICKUP"]);

    // Receive at hub, Delivery rider assign, then the rider's delivery entered by the franchise.
    expect((await f(s, "POST", "/receive", { code: a })).body.ok).toBe(true);
    expect((await f(s, "POST", "/assign-scan", { code: a, riderId: s.riderId })).body.ok).toBe(true);
    expect((await op(s, `/parcels/${a}/start-delivery`, {})).status).toBe(200);
    const done = await op(s, `/parcels/${a}/delivery`, { outcome: "DELIVERED", receivedBy: "Nabila", proof: { method: "SIGNATURE", image: PNG }, codCollected: 1500 });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(await status(a)).toBe("DELIVERED");
    expect((await ctx.prisma.franchiseCommission.findMany({ orderBy: { earnedAt: "asc" } })).map(c => c.type)).toEqual(["PICKUP", "DELIVERY"]);
    expect((await ctx.prisma.riderEarning.findMany({ where: { riderId: s.riderId }, orderBy: { earnedAt: "asc" } })).map(e => [e.type, Number(e.amount)])).toEqual([
      ["PICKUP", 20],
      ["DELIVERY", 30],
    ]);

    // Not its rider: a company rider's steps are refused.
    expect((await f(s, "GET", `/rider-op/${s.companyRider.rider.id}/tasks`)).status).toBe(403);
  });

  it("Hub transfer, Hub return, Return rider assign and Returned to merchant at the franchise hub", async () => {
    const s = await setup();
    const t = await atFranchisePickup(s);
    const back = await atFranchisePickup(s);
    const ret = await atFranchisePickup(s);
    for (const id of [t, back, ret]) {
      expect((await op(s, `/parcels/${id}/pickup`, { outcome: "COLLECTED" })).status).toBe(200);
      expect((await f(s, "POST", "/receive", { code: id })).body.ok).toBe(true);
    }

    // Hub transfer to the company hub.
    const sent = await f(s, "POST", "/transfer-scan", { code: t, toHubId: s.company.id });
    expect(sent.body, JSON.stringify(sent.body)).toMatchObject({ ok: true, outcome: "IN_TRANSIT" });

    // Could not deliver → return to sender, received back, then Hub return to the central hub.
    expect((await f(s, "POST", "/assign-scan", { code: back, riderId: s.riderId })).body.ok).toBe(true);
    expect((await op(s, `/parcels/${back}/start-delivery`, {})).status).toBe(200);
    expect((await op(s, `/parcels/${back}/delivery`, { outcome: "FAILED", reason: "Recipient refused", nextAction: "RETURN" })).status).toBe(200);
    expect((await f(s, "POST", "/receive", { code: back })).body.ok).toBe(true);
    expect((await f(s, "GET", "/returns-summary")).body).toMatchObject({ isCentral: false, waiting: { count: 1, next: "TRANSFER" } });
    const home = await f(s, "POST", "/return-transfer", { code: back });
    expect(home.body, JSON.stringify(home.body)).toMatchObject({ ok: true, outcome: "SENT_TO_CENTRAL" });
    expect(await status(back)).toBe("IN_TRANSIT");

    // Return rider assign (a reason for a parcel nobody asked to return), then returned to the merchant by Rider operation.
    const assigned = await f(s, "POST", "/return-assign", { code: ret, riderId: s.riderId, reason: "Merchant cancelled the order" });
    expect(assigned.body, JSON.stringify(assigned.body)).toMatchObject({ ok: true, outcome: "ASSIGNED" });
    expect((await f(s, "POST", "/return-assign", { code: ret, riderId: s.companyRider.rider.id })).status).toBe(404);
    const runs = (await op(s, "/return-runs")).body.items;
    expect(runs).toHaveLength(1);
    const returned = await op(s, `/parcels/${ret}/return`, { runId: runs[0].id, receivedBy: "Shop desk" });
    expect(returned.body, JSON.stringify(returned.body)).toMatchObject({ outcome: "RETURNED", runCompleted: true });
    expect((await ctx.prisma.franchiseCommission.findMany({ where: { type: "RETURN" } })).length).toBe(1);
  });

  it("Hub collection at the franchise hub: the code, who collects, the COD into its counter cash", async () => {
    const s = await setup();
    const id = await atFranchisePickup(s);
    await ctx.prisma.parcel.update({ where: { trackingId: id }, data: { status: "READY_FOR_COLLECTION", lastMile: "HUB_COLLECT", collectHubId: s.hubId, currentHubId: s.hubId, collectionCodeEncrypted: encrypt("482913") } });
    const detail = await f(s, "GET", `/parcels/${id}`);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(Number(detail.body.codAmount)).toBe(1500);
    expect((await f(s, "POST", `/parcels/${id}/collect`, { code: "000000", receivedBy: "Nabila", codCollected: 1500 })).status).toBe(422);
    const collected = await f(s, "POST", `/parcels/${id}/collect`, { code: "482913", receivedBy: "Nabila", codCollected: 1500 });
    expect(collected.status, JSON.stringify(collected.body)).toBe(200);
    expect(await status(id)).toBe("DELIVERED");
    expect((await f(s, "GET", "/cash")).body.position ?? (await f(s, "GET", "/cash")).body).toBeTruthy();
    expect(await ctx.prisma.codCollection.findFirstOrThrow({ where: { parcel: { trackingId: id } } })).toMatchObject({ riderId: null, hubId: s.hubId });
  });
});
