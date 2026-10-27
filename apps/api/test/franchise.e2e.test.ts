import { decrypt } from "../src/common/crypto";
import { hashPassword } from "../src/common/crypto";
import { PASSWORD, hub, parcelBody, resetDatabase, startApp, userWithRoles, type TestContext } from "./helpers";

/**
 * Franchise hubs (owner spec 2026-10-18): a franchise is a hub (type FRANCHISE) with one account, its own riders,
 * commission on the delivery charge for pickup / delivery / return (percent with a minimum), walk-ins at the counter,
 * rider cash at the franchise, deposits at a company hub (DEDUCT keeps the commission; BILL: Finance invoices and
 * pays), and suspension. Scope: a franchise sees only its hub; other hubs can't use its riders.
 */
describe("franchise hubs", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  const relogin = async (phone: string) => (await ctx.api("POST", "/auth/login", { body: { identifier: phone, password: PASSWORD } })).body.accessToken as string;
  const balance = async (systemKey: string, hubId: string) => {
    const account = await ctx.prisma.ledgerAccount.findFirst({ where: { systemKey } });
    if (!account) return 0;
    const lines = await ctx.prisma.journalLine.findMany({ where: { accountId: account.id, hubId } });
    return Math.round(lines.reduce((a, l) => a + Number(l.debit ?? 0) - Number(l.credit ?? 0), 0) * 100) / 100;
  };

  async function setup() {
    const admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Ayesha Admin");
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops Manager");
    const company = await hub(ctx, "HUB-C1");
    const hubOp = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: company.id }], "Company Hub Op");
    const applicant = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Mizanur Rahman");
    const merchant = await ctx.prisma.merchant.create({
      data: { code: "MR-FR1", type: "ECOMMERCE", name: "Shop One", status: "ACTIVE", kycStatus: "APPROVED", contactName: "Owner", contactPhone: "+8801711111111", pickupAddress: "House 5 Road 2", pickupArea: "Gulshan", pickupDistrict: "Dhaka North" },
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
    const franchise = created.body;
    const token = await relogin(applicant.phone);
    return { admin, ops, company, hubOp, applicant, merchant, shop, franchise, token };
  }

  async function franchiseRider(s: Awaited<ReturnType<typeof setup>>, name = "Rafi Rider", phone = "01913000001") {
    const r = await ctx.api("POST", "/franchise/riders", { token: s.token, body: { name, phone, vehicle: "MOTORBIKE" } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    await ctx.prisma.user.update({ where: { phone: `+880${phone.slice(1)}` }, data: { passwordHash: await hashPassword(PASSWORD) } });
    return { id: r.body.id as string, token: await relogin(`+880${phone.slice(1)}`) };
  }

  const book = async (s: Awaited<ReturnType<typeof setup>>, overrides: Record<string, unknown> = {}) => {
    const res = await ctx.api("POST", "/parcels", { token: s.shop.token, body: parcelBody({ serviceLevel: "Regular", contents: undefined, ...overrides }) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.trackingId as string;
  };
  const deliver = async (riderToken: string, trackingId: string, cod: number) => {
    const started = await ctx.api("POST", `/rider/parcels/${trackingId}/start-delivery`, { token: riderToken });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const p = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId } });
    const otp = decrypt(p.deliveryOtpEncrypted!);
    const res = await ctx.api("POST", `/rider/parcels/${trackingId}/delivery`, { token: riderToken, body: { outcome: "DELIVERED", receivedBy: "Nabila", proof: { method: "OTP", otp }, codCollected: cod } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  };

  it("runs a franchise end to end: pickup, delivery, rider cash, walk-in, deposit (DEDUCT), return, BILL invoice, rider pay", async () => {
    const s = await setup();
    const hubId = s.franchise.hub.id as string;
    expect(s.franchise.hub).toMatchObject({ type: "FRANCHISE", active: true });
    expect((await ctx.api("GET", "/auth/me", { token: s.token })).body.panel).toBe("/franchise");
    const me = await ctx.api("GET", "/franchise/me", { token: s.token });
    expect(me.body).toMatchObject({ code: "FR-1001", settlementMode: "DEDUCT" });
    expect(me.body.depositHubs.map((h: { id: string }) => h.id)).toEqual([s.company.id]);

    expect((await ctx.api("PUT", "/franchise/rider-rates", { token: s.token, body: { pickup: 20, delivery: 30, return: 15 } })).status).toBe(200);
    const rider = await franchiseRider(s);

    // A merchant pickup handed to the franchise hub; another hub can't use the franchise's rider.
    const t1 = await book(s);
    expect((await ctx.api("POST", `/parcels/${t1}/pickup-hub`, { token: s.ops.token, body: { hubId } })).status).toBe(200);
    expect((await ctx.api("GET", "/franchise/parcels?view=pickups", { token: s.token })).body.items.map((p: { trackingId: string }) => p.trackingId)).toContain(t1);
    const foreign = await ctx.api("POST", `/parcels/${t1}/assign-pickup`, { token: s.hubOp.token, body: { riderId: rider.id } });
    expect(foreign.status).toBe(403);
    expect((await ctx.api("POST", `/franchise/parcels/${t1}/assign`, { token: s.token, body: { riderId: rider.id, task: "PICKUP" } })).status).toBe(200);
    const picked = await ctx.api("POST", `/rider/parcels/${t1}/pickup`, { token: rider.token, body: { outcome: "COLLECTED_TO_HUB", hubId } });
    expect(picked.status, JSON.stringify(picked.body)).toBe(200);

    const p1 = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: t1 } });
    const charge = Number(p1.totalCharge) - Number(p1.codFee);
    const pickupCommission = Math.max(15, Math.round(charge * 10) / 100);
    const commissions = () => ctx.prisma.franchiseCommission.findMany({ orderBy: { earnedAt: "asc" } });
    expect((await commissions()).map(c => [c.type, Number(c.amount)])).toEqual([["PICKUP", pickupCommission]]);
    expect(await ctx.prisma.riderEarning.findMany({ where: { riderId: rider.id } }).then(e => e.map(x => [x.type, Number(x.amount)]))).toEqual([["PICKUP", 20]]);

    // Delivery by the franchise rider (COD 1,500).
    expect((await ctx.api("POST", `/franchise/parcels/${t1}/assign`, { token: s.token, body: { riderId: rider.id, task: "DELIVERY" } })).status).toBe(200);
    await deliver(rider.token, t1, 1500);
    const deliveryCommission = Math.max(20, Math.round(charge * 20) / 100);
    expect((await commissions()).map(c => c.type)).toEqual(["PICKUP", "DELIVERY"]);
    expect(Number((await commissions())[1].amount)).toBe(deliveryCommission);

    // Rider cash goes to the franchise only: a company hub can't receive the franchise rider's slip.
    const slip = await ctx.api("POST", "/rider/my-cash/slip", { token: rider.token });
    expect(slip.status, JSON.stringify(slip.body)).toBe(201);
    const wrong = await ctx.api("POST", `/cash/slips/${slip.body.id}/receive`, { token: s.ops.token, body: { received: 1500, hubId: s.company.id } });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.code).toBe("WRONG_CASH_HUB");
    let cash = (await ctx.api("GET", "/franchise/cash", { token: s.token })).body;
    expect(cash.riders).toHaveLength(1);
    expect(cash.handoverRequests).toHaveLength(1); // the rider's open slip
    const handed = await ctx.api("POST", "/franchise/cash/handovers", { token: s.token, body: { riderId: rider.id, collectionIds: cash.riders[0].collectionIds, amountReceived: 1500 } });
    expect(handed.status, JSON.stringify(handed.body)).toBe(201);
    expect(handed.body).toMatchObject({ codOnHand: 1500, withRiders: 0 });
    expect(handed.body.handoverRequests).toHaveLength(0); // the counter took the cash: the slip is closed

    // Walk-in at the counter: website customer default price, paid at the counter, pickup commission.
    const walkBody = { ...parcelBody({ serviceLevel: "Regular", codAmount: 0, contents: undefined }), pickup: undefined };
    const quote = await ctx.api("POST", "/franchise/walk-in/quote", { token: s.token, body: { deliveryDistrict: "Dhaka Central", deliveryZone: "Dhanmondi", weightKg: 2, codAmount: 0 } });
    expect(quote.status, JSON.stringify(quote.body)).toBe(200);
    const walk = await ctx.api("POST", "/franchise/walk-in", { token: s.token, body: walkBody });
    expect(walk.status, JSON.stringify(walk.body)).toBe(201);
    expect(walk.body.status).toBe("AT_HUB");
    expect(walk.body.paidAtCounter).toBe(quote.body.totalCharge);
    const counter = walk.body.paidAtCounter as number;
    expect((await commissions()).map(c => c.type)).toEqual(["PICKUP", "DELIVERY", "PICKUP"]);
    const walkCommission = Number((await commissions())[2].amount);

    // Deposit at a company hub (DEDUCT keeps the commission); the hub confirms the exact net amount.
    expect((await ctx.api("POST", "/franchise/deposits", { token: s.token, body: { hubId } })).body.error.code).toBe("NOT_COMPANY_HUB");
    const dep = await ctx.api("POST", "/franchise/deposits", { token: s.token, body: { hubId: s.company.id } });
    expect(dep.status, JSON.stringify(dep.body)).toBe(201);
    const kept = Math.round((pickupCommission + deliveryCommission + walkCommission) * 100) / 100;
    expect(dep.body).toMatchObject({ status: "PENDING", gross: 1500 + counter, commissionDeducted: kept, net: Math.round((1500 + counter - kept) * 100) / 100 });
    expect((await ctx.api("GET", "/franchise-deposits", { token: s.hubOp.token })).body.map((d: { id: string }) => d.id)).toEqual([dep.body.id]);
    expect((await ctx.api("POST", `/franchise-deposits/${dep.body.id}/receive`, { token: s.hubOp.token, body: { amountReceived: 1 } })).body.error.code).toBe("DEPOSIT_AMOUNT_MISMATCH");
    const got = await ctx.api("POST", `/franchise-deposits/${dep.body.id}/receive`, { token: s.hubOp.token, body: { amountReceived: dep.body.net } });
    expect(got.body.status).toBe("RECEIVED");
    expect(await balance("CASH_AT_HUBS", hubId)).toBe(0);
    expect(await balance("CASH_AT_HUBS", s.company.id)).toBe(dep.body.net);
    expect(await balance("FRANCHISE_PAYABLE", hubId)).toBe(0);
    cash = (await ctx.api("GET", "/franchise/cash", { token: s.token })).body;
    expect(cash).toMatchObject({ onHand: 0, unsettledCommission: 0 });

    // The invoice of what was kept (DEDUCT: already paid) and its PDF.
    const inv = await ctx.api("POST", "/franchise/invoices", { token: s.token });
    expect(inv.body).toMatchObject({ settlement: "DEDUCTED", status: "PAID", amount: kept });
    const pdf = await ctx.app.inject({ method: "GET", url: `/api/v1/franchise/invoices/${inv.body.id}/pdf`, headers: { authorization: `Bearer ${s.token}` } });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");

    // A return taken back by the franchise rider: return pay and return commission.
    const t2 = await book(s, { codAmount: 0 });
    await ctx.api("POST", `/parcels/${t2}/pickup-hub`, { token: s.ops.token, body: { hubId } });
    await ctx.api("POST", `/franchise/parcels/${t2}/assign`, { token: s.token, body: { riderId: rider.id, task: "PICKUP" } });
    await ctx.api("POST", `/rider/parcels/${t2}/pickup`, { token: rider.token, body: { outcome: "COLLECTED_TO_HUB", hubId } });
    expect((await ctx.api("POST", `/parcels/${t2}/return-request`, { token: s.shop.token, body: { reason: "Customer cancelled the order" } })).status).toBe(200);
    expect((await ctx.api("GET", "/franchise/parcels?view=returns", { token: s.token })).body.items.map((p: { trackingId: string }) => p.trackingId)).toContain(t2);
    const runs = await ctx.api("POST", "/franchise/return-runs", { token: s.token, body: { trackingIds: [t2], riderId: rider.id } });
    expect(runs.status, JSON.stringify(runs.body)).toBe(201);
    const done = await ctx.api("POST", `/franchise/return-runs/${runs.body[0].id}/complete`, { token: s.token, body: {} });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: t2 } })).status).toBe("RETURNED");
    expect((await commissions()).filter(c => c.type === "RETURN")).toHaveLength(1);

    // BILL mode: Finance invoices the open commission and pays it (maker-checker), clearing the payable.
    expect((await ctx.api("PUT", "/franchises/config", { token: s.admin.token, body: { settlementMode: "BILL", billingPeriodDays: 7 } })).status).toBe(200);
    const bill = await ctx.api("POST", "/franchise/invoices", { token: s.token });
    expect(bill.body).toMatchObject({ settlement: "PAYABLE", status: "ISSUED" });
    const finance = await userWithRoles(ctx, [{ role: "FINANCE" }], "Finance User");
    expect((await ctx.api("POST", `/franchise-invoices/${bill.body.id}/pay`, { token: finance.token, body: { method: "BANK", reference: "TRX-1" } })).body.error.code).toBe("INVOICE_NOT_APPROVED");
    expect((await ctx.api("POST", `/franchise-invoices/${bill.body.id}/approve`, { token: finance.token })).body.status).toBe("APPROVED");
    expect((await ctx.api("POST", `/franchise-invoices/${bill.body.id}/pay`, { token: finance.token, body: { method: "BANK", reference: "TRX-1" } })).body.status).toBe("PAID");
    expect(await balance("FRANCHISE_PAYABLE", hubId)).toBe(0);

    // The franchise pays its rider all unpaid earnings (no Paira Express payroll entry).
    const earnings = (await ctx.api("GET", `/franchise/riders/${rider.id}/earnings`, { token: s.token })).body;
    expect(earnings.unpaid).toBe(20 + 30 + 20 + 15);
    const paid = await ctx.api("POST", `/franchise/riders/${rider.id}/payments`, { token: s.token, body: { method: "BKASH", reference: "BK-1" } });
    expect(paid.body).toMatchObject({ amount: 85, method: "BKASH" });
    expect((await ctx.api("GET", `/franchise/riders/${rider.id}/earnings`, { token: s.token })).body.unpaid).toBe(0);
    expect(await ctx.prisma.journalEntry.count({ where: { eventType: "RIDER_PAYOUT_PAID" } })).toBe(0);
  });

  it("keeps a franchise to its hub, hides its riders from other hubs and suspends it", async () => {
    const s = await setup();
    const hubId = s.franchise.hub.id as string;
    const rider = await franchiseRider(s);

    // Without the role: no franchise panel.
    expect((await ctx.api("GET", "/franchise/me", { token: s.shop.token })).status).toBe(403);
    // Other hubs' parcels are invisible; the network-wide endpoints stay closed.
    const other = await book(s);
    expect((await ctx.api("GET", "/franchise/parcels?view=all", { token: s.token })).body.items.map((p: { trackingId: string }) => p.trackingId)).not.toContain(other);
    expect((await ctx.api("GET", `/parcels/${other}`, { token: s.token })).status).toBeGreaterThanOrEqual(403);
    expect((await ctx.api("GET", "/riders", { token: s.token })).status).toBe(403);
    expect((await ctx.api("POST", `/franchise/parcels/${other}/assign`, { token: s.token, body: { riderId: rider.id, task: "PICKUP" } })).status).toBe(404);

    // Company hub staff don't see the franchise's riders; operations managers do (tagged by hub type).
    const hubList = (await ctx.api("GET", "/riders", { token: s.hubOp.token })).body;
    expect(hubList.map((r: { id: string }) => r.id)).not.toContain(rider.id);
    const opsList = (await ctx.api("GET", "/riders", { token: s.ops.token })).body;
    expect(opsList.find((r: { id: string }) => r.id === rider.id)?.hub).toMatchObject({ id: hubId, type: "FRANCHISE" });

    // Suspended: the panel closes, its rider can't sign in, the hub takes no new work; reactivation reverses it.
    const sus = await ctx.api("POST", `/franchises/${s.franchise.id}/status`, { token: s.admin.token, body: { status: "SUSPENDED", reason: "Unpaid deposits" } });
    expect(sus.body).toMatchObject({ status: "SUSPENDED", hub: { active: false } });
    const token = await relogin(s.applicant.phone);
    const closed = await ctx.api("GET", "/franchise/me", { token });
    expect(closed.status).toBe(403);
    expect(closed.body.error.code).toBe("FRANCHISE_SUSPENDED");
    expect((await ctx.api("POST", "/auth/login", { body: { identifier: "+8801913000001", password: PASSWORD } })).status).toBe(401);
    await ctx.api("POST", `/franchises/${s.franchise.id}/status`, { token: s.admin.token, body: { status: "ACTIVE" } });
    expect((await ctx.api("POST", "/auth/login", { body: { identifier: "+8801913000001", password: PASSWORD } })).status).toBe(200);
    expect((await ctx.api("GET", "/franchise/me", { token: await relogin(s.applicant.phone) })).status).toBe(200);
  });

  it("turns an approved franchise application into the franchise account and closes the application page", async () => {
    const admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Ayesha Admin");
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops Manager");
    const applicant = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Nadia Rahman");
    const app = (await ctx.api("POST", "/applications", { token: applicant.token, body: { kind: "FRANCHISE", name: "Nadia Rahman", phone: applicant.phone, location: "Mirpur 10", territory: "City zone" } })).body.application;
    expect((await ctx.api("GET", "/auth/me", { token: applicant.token })).body.panel).toBe("/application");
    await ctx.api("POST", `/applications/${app.number}/status`, { token: ops.token, body: { status: "APPROVED", message: "Welcome" } });
    // Approved but not set up yet: still the application page.
    expect((await ctx.api("GET", "/auth/me", { token: applicant.token })).body.panel).toBe("/application");

    const created = await ctx.api("POST", "/franchises", {
      token: admin.token,
      body: {
        applicationId: app.applicationId,
        name: "Mirpur Point",
        contactName: "Nadia Rahman",
        hub: { name: "Mirpur 10 Franchise", district: "Dhaka North", zone: "Gulshan", address: "Mirpur 10 roundabout" },
        rates: { pickupPercent: 10, pickupMin: 15, deliveryPercent: 20, deliveryMin: 20, returnPercent: 10, returnMin: 10 },
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(await ctx.prisma.userRole.count({ where: { userId: applicant.user.id, role: "APPLICANT" } })).toBe(0);
    const token = await relogin(applicant.phone);
    expect((await ctx.api("GET", "/auth/me", { token })).body.panel).toBe("/franchise");
  });
});
