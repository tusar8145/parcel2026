import { decrypt } from "../src/common/crypto";
import { hub, parcelBody, resetDatabase, riderUser, startApp, userWithRoles, type TestContext, sameHubDelivery } from "./helpers";

// 1x1 PNG: a receipt photo.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/**
 * Accounts (modules/money): statements written by delivered / returned parcels, rider cash slips → hubs → central
 * hub, settlements (E-commerce, Customer), bills and part payments (Financial), and who may do what.
 */
describe("accounts: cash slips, transfers, settlements, bills and payments", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  let seq = 2000;
  const merchant = (type: "ECOMMERCE" | "BANKING_FINANCIAL" = "ECOMMERCE", name = type === "ECOMMERCE" ? "Shop BD" : "Meridian Bank") =>
    ctx.prisma.merchant.create({
      data: {
        code: `MR-${++seq}`,
        type,
        name,
        status: "ACTIVE",
        contactName: "Owner",
        contactPhone: "+8801911000000",
        pickupAddress: "House 5 Road 2",
        pickupArea: "Gulshan 1",
        pickupDistrict: "Dhaka North",
        payoutAccount: { method: "BKASH", accountName: "Shop BD", accountNumber: "01911000000" },
      },
    });

  const setup = async () => {
    const central = await hub(ctx, "HUB-CEN");
    const branch = await hub(ctx, "HUB-BR1");
    const shop = await merchant();
    const bank = await merchant("BANKING_FINANCIAL");
    const owner = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: shop.id }], "Shop Owner");
    const bankOwner = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: bank.id }], "Bank Owner");
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops Manager");
    const finance = await userWithRoles(ctx, [{ role: "FINANCE" }], "Finance");
    const admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Admin");
    const branchOp = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: branch.id }], "Branch Cashier");
    const centralOp = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: central.id }], "Central Cashier");
    const rider = await riderUser(ctx, "R-3001", branch.id);
    const centralRider = await riderUser(ctx, "R-3002", central.id);
    expect((await ctx.api("PUT", "/accounts/config", { token: admin.token, body: { centralHubId: central.id } })).status).toBe(200);
    return { central, branch, shop, bank, owner, bankOwner, ops, finance, admin, branchOp, centralOp, rider, centralRider };
  };
  type Setup = Awaited<ReturnType<typeof setup>>;

  /** Books as `token` and drives the parcel to DELIVERED with `rider` (the account lines are written then). */
  const deliver = async (s: Setup, token: string, overrides: Record<string, unknown>, rider = s.rider) => {
    const booked = await ctx.api("POST", "/parcels", { token, body: parcelBody(overrides) });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    const { trackingId } = booked.body;
    await ctx.api("POST", `/parcels/${trackingId}/assign-pickup`, { token: s.ops.token, body: { riderId: rider.rider.id } });
    await sameHubDelivery(ctx, trackingId);
    await ctx.api("POST", `/rider/parcels/${trackingId}/pickup`, { token: rider.token, body: { outcome: "COLLECTED_DELIVER_DIRECT" } });
    const parcel = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId } });
    const cod = Number(parcel.codAmount);
    const done = await ctx.api("POST", `/rider/parcels/${trackingId}/delivery`, {
      token: rider.token,
      body: { outcome: "DELIVERED", receivedBy: "Nabila", proof: { method: "OTP", otp: decrypt(parcel.deliveryOtpEncrypted!) }, ...(cod > 0 ? { codCollected: cod } : {}) },
    });
    expect(done.body.status, JSON.stringify(done.body)).toBe("DELIVERED");
    return { trackingId, id: parcel.id, cod, charge: Number(parcel.totalCharge) };
  };
  const accountOf = async (merchantId: string) => (await ctx.prisma.account.findUniqueOrThrow({ where: { merchantId } })).id;

  it("e-commerce: rider slip → branch hub (short = rider due) → transfer → central hub → settle → paid with receipt", async () => {
    const s = await setup();
    const a = await deliver(s, s.owner.token, { codAmount: 1500 });
    const b = await deliver(s, s.owner.token, { codAmount: 800 });
    const accountId = await accountOf(s.shop.id);

    // Delivered: COD + and the charge − on the merchant's statement, nothing ready yet (the cash is with the rider).
    let acc = (await ctx.api("GET", `/accounts/${accountId}`, { token: s.finance.token })).body;
    expect(acc.cod).toMatchObject({ collected: 2300, withRider: 2300, ready: 0, settled: 0 });
    expect(acc.cod.charges).toBe(a.charge + b.charge);

    // The rider makes one slip of everything held.
    const cash = (await ctx.api("GET", "/rider/my-cash", { token: s.rider.token })).body;
    expect(cash).toMatchObject({ cod: 2300, due: 0, total: 2300, slip: null });
    const slip = (await ctx.api("POST", "/rider/my-cash/slip", { token: s.rider.token })).body;
    expect(slip).toMatchObject({ number: expect.stringMatching(/^HS-\d{6}-0001$/), expected: 2300, parcels: 2, status: "OPEN" });
    // The cashier finds it by number (scanned); only hub staff can.
    expect((await ctx.api("GET", `/cash/slips/${slip.number}`, { token: s.branchOp.token })).body.parcels).toHaveLength(2);
    expect((await ctx.api("GET", `/cash/slips/${slip.number}`, { token: s.owner.token })).status).toBe(403);
    // More than the slip is refused; less leaves a due on the rider.
    expect((await ctx.api("POST", `/cash/slips/${slip.id}/receive`, { token: s.branchOp.token, body: { received: 2400 } })).body.error.code).toBe("MORE_THAN_EXPECTED");
    const received = await ctx.api("POST", `/cash/slips/${slip.id}/receive`, { token: s.branchOp.token, body: { received: 2200 } });
    expect(received.body, JSON.stringify(received.body)).toMatchObject({ status: "RECEIVED", received: 2200, short: 100 });
    expect((await ctx.api("POST", `/cash/slips/${slip.id}/receive`, { token: s.branchOp.token, body: { received: 2200 } })).body.error.code).toBe("SLIP_NOT_OPEN");
    expect((await ctx.api("GET", "/rider/my-cash", { token: s.rider.token })).body).toMatchObject({ cod: 0, due: 100, total: 100 });

    // At the branch: on hand, not ready. A branch cashier can't settle.
    acc = (await ctx.api("GET", `/accounts/${accountId}`, { token: s.finance.token })).body;
    expect(acc.cod).toMatchObject({ withRider: 0, atHubs: 2300, ready: 0 });
    expect((await ctx.api("POST", `/accounts/${accountId}/payouts`, { token: s.branchOp.token, body: {} })).status).toBe(403);
    expect((await ctx.api("POST", `/accounts/${accountId}/payouts`, { token: s.finance.token, body: {} })).body.error.code).toBe("NOTHING_TO_SETTLE");
    const onHand = (await ctx.api("GET", "/cash/on-hand", { token: s.branchOp.token })).body.items;
    expect(onHand).toHaveLength(1);
    expect(onHand[0]).toMatchObject({ toSend: 2300, slips: [expect.objectContaining({ number: slip.number })] });

    // The branch sends whole slips to the central hub; the central hub receives it.
    const sent = await ctx.api("POST", "/cash/transfers", { token: s.branchOp.token, body: { fromHubId: s.branch.id, method: "BANK", reference: "DEP-1", proof: PNG } });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect(sent.body).toMatchObject({ number: expect.stringMatching(/^HT-/), amount: 2300, status: "IN_TRANSIT", slips: [expect.objectContaining({ number: slip.number })] });
    expect((await ctx.api("POST", `/cash/transfers/${sent.body.id}/receive`, { token: s.branchOp.token, body: { received: 2300 } })).status).toBe(403);
    const got = await ctx.api("POST", `/cash/transfers/${sent.body.id}/receive`, { token: s.centralOp.token, body: { received: 2300 } });
    expect(got.body, JSON.stringify(got.body)).toMatchObject({ status: "RECEIVED", short: 0 });

    // Ready: COD less charges. Settle one parcel, then the rest.
    acc = (await ctx.api("GET", `/accounts/${accountId}`, { token: s.finance.token })).body;
    expect(acc.cod.ready).toBe(2300 - a.charge - b.charge);
    const ready = (await ctx.api("GET", `/accounts/${accountId}/parcels?status=ready`, { token: s.finance.token })).body.items;
    expect(ready.map((r: { trackingId: string }) => r.trackingId).sort()).toEqual([a.trackingId, b.trackingId].sort());
    const one = await ctx.api("POST", `/accounts/${accountId}/payouts`, { token: s.centralOp.token, body: { parcelIds: [a.id] } });
    expect(one.status, JSON.stringify(one.body)).toBe(201);
    expect(one.body).toMatchObject({ number: expect.stringMatching(/^ST-\d{4}-0001$/), status: "UNPAID", amount: 1500 - a.charge, codTotal: 1500, payTo: { method: "BKASH" } });
    // A parcel in a settlement can't go on another one.
    expect((await ctx.api("POST", `/accounts/${accountId}/payouts`, { token: s.finance.token, body: { parcelIds: [a.id] } })).body.error.code).toBe("PARCELS_NOT_READY");
    const paid = await ctx.api("POST", `/payouts/${one.body.id}/pay`, { token: s.finance.token, body: { method: "BKASH", reference: "TX9K", proof: PNG } });
    expect(paid.body).toMatchObject({ status: "PAID", reference: "TX9K", receipt: { fileId: expect.any(String) } });
    expect((await ctx.prisma.codCollection.findUniqueOrThrow({ where: { parcelId: a.id } })).state).toBe("SETTLED");

    // The merchant sees the settlement, its receipt and PDF; another merchant doesn't.
    expect((await ctx.api("GET", `/payouts?accountId=${accountId}`, { token: s.owner.token })).body.items).toHaveLength(1);
    const receipt = await ctx.app.inject({ method: "GET", url: `/api/v1/files/${paid.body.receipt.fileId}`, headers: { authorization: `Bearer ${s.owner.token}` } });
    expect(receipt.statusCode).toBe(200);
    const pdf = await ctx.app.inject({ method: "GET", url: `/api/v1/documents/payout/${one.body.id}`, headers: { authorization: `Bearer ${s.owner.token}` } });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect((await ctx.api("GET", `/accounts/${accountId}`, { token: s.bankOwner.token })).status).toBe(404);

    // The statement: every line with its running balance; what's still owed = b's net.
    const st = (await ctx.api("GET", `/accounts/${accountId}/statement`, { token: s.owner.token })).body;
    expect(st.lines.map((l: { type: string }) => l.type)).toEqual(["COD", "DELIVERY_CHARGE", "COD", "DELIVERY_CHARGE", "PAYOUT"]);
    expect(st.closing).toBe(800 - b.charge);

    // The rider's next slip carries the earlier shortage; paying it in full clears it.
    const c = await deliver(s, s.owner.token, { codAmount: 500 });
    const slip2 = (await ctx.api("POST", "/rider/my-cash/slip", { token: s.rider.token })).body;
    expect(slip2).toMatchObject({ cod: 500, due: 100, expected: 600 });
    await ctx.api("POST", `/cash/slips/${slip2.id}/receive`, { token: s.branchOp.token, body: { received: 600 } });
    expect((await ctx.api("GET", "/rider/my-cash", { token: s.rider.token })).body).toMatchObject({ total: 0, due: 0 });
    expect(c.cod).toBe(500);
  });

  it("a rider without a phone: the hub makes the slip, then receives it", async () => {
    const s = await setup();
    await deliver(s, s.owner.token, { codAmount: 650 });
    const holders = (await ctx.api("GET", "/cash/riders", { token: s.branchOp.token })).body.items;
    expect(holders).toEqual([expect.objectContaining({ id: s.rider.rider.id, code: "R-3001", cod: 650, total: 650, parcels: 1 })]);
    // Another hub's staff don't see the rider nor make the slip.
    expect((await ctx.api("GET", "/cash/riders", { token: s.centralOp.token })).body.items).toHaveLength(0);
    expect((await ctx.api("POST", `/cash/riders/${s.rider.rider.id}/slip`, { token: s.centralOp.token })).status).toBe(403);
    const slip = await ctx.api("POST", `/cash/riders/${s.rider.rider.id}/slip`, { token: s.branchOp.token });
    expect(slip.status, JSON.stringify(slip.body)).toBe(201);
    expect(slip.body).toMatchObject({ status: "OPEN", expected: 650, parcels: 1 });
    expect((await ctx.api("POST", `/cash/slips/${slip.body.id}/receive`, { token: s.branchOp.token, body: { received: 650 } })).body).toMatchObject({ status: "RECEIVED" });
    expect((await ctx.api("GET", "/cash/riders", { token: s.branchOp.token })).body.items).toHaveLength(0);
    // The rider's own app shows nothing left to hand over.
    expect((await ctx.api("GET", "/rider/my-cash", { token: s.rider.token })).body).toMatchObject({ total: 0, slip: null });
  });

  it("the central hub's own riders: their slips land at the central hub, ready to settle", async () => {
    const s = await setup();
    await deliver(s, s.owner.token, { codAmount: 1000 }, s.centralRider);
    const slip = (await ctx.api("POST", "/rider/my-cash/slip", { token: s.centralRider.token })).body;
    await ctx.api("POST", `/cash/slips/${slip.id}/receive`, { token: s.centralOp.token, body: { received: 1000 } });
    const acc = (await ctx.api("GET", `/accounts/${await accountOf(s.shop.id)}`, { token: s.ops.token })).body;
    expect(acc.cod).toMatchObject({ atHubs: 0, atCentral: 1000 });
    expect(acc.cod.ready).toBeGreaterThan(0);
    // A transfer from the central hub makes no sense.
    expect((await ctx.api("POST", "/cash/transfers", { token: s.ops.token, body: { fromHubId: s.central.id, method: "BANK" } })).body.error.code).toBe("ALREADY_CENTRAL");
  });

  it("financial: bill chosen parcels, part payments pay the oldest bill, credit, 'I've paid' waits for confirmation, void", async () => {
    const s = await setup();
    const doc = { type: "DOCUMENT", codAmount: 0, weightKg: 0.5 };
    const p1 = await deliver(s, s.bankOwner.token, doc);
    const p2 = await deliver(s, s.bankOwner.token, doc);
    const p3 = await deliver(s, s.bankOwner.token, doc);
    const accountId = await accountOf(s.bank.id);
    const today = new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);

    let acc = (await ctx.api("GET", `/accounts/${accountId}`, { token: s.finance.token })).body;
    expect(acc.kind).toBe("FINANCIAL");
    expect(acc.financial).toMatchObject({ notBilled: p1.charge + p2.charge + p3.charge, billed: 0, due: p1.charge + p2.charge + p3.charge });

    // Two bills; the third parcel stays not billed. A billed parcel can't be billed again.
    const bill1 = await ctx.api("POST", `/accounts/${accountId}/bills`, { token: s.finance.token, body: { from: today, to: today, parcelIds: [p1.id] } });
    expect(bill1.status, JSON.stringify(bill1.body)).toBe(201);
    expect(bill1.body).toMatchObject({ number: expect.stringMatching(/^INV-\d{4}-0001$/), status: "ISSUED", total: p1.charge, due: p1.charge, parcels: 1 });
    const bill2 = (await ctx.api("POST", `/accounts/${accountId}/bills`, { token: s.ops.token, body: { from: today, to: today, parcelIds: [p2.id] } })).body;
    expect((await ctx.api("POST", `/accounts/${accountId}/bills`, { token: s.finance.token, body: { from: today, to: today, parcelIds: [p1.id] } })).body.error.code).toBe("PARCELS_NOT_BILLABLE");
    expect((await ctx.api("GET", `/accounts/${accountId}/parcels?status=not_billed`, { token: s.bankOwner.token })).body.items.map((r: { trackingId: string }) => r.trackingId)).toEqual([p3.trackingId]);

    // A part payment pays the oldest bill first, the rest goes to the next.
    const part = p1.charge + 10;
    const pay1 = await ctx.api("POST", `/accounts/${accountId}/payments`, { token: s.finance.token, body: { amount: part, method: "BANK", reference: "CHQ-1", paidOn: today } });
    expect(pay1.status, JSON.stringify(pay1.body)).toBe(201);
    expect(pay1.body).toMatchObject({ status: "CONFIRMED", bills: [{ number: bill1.body.number, amount: p1.charge }, { number: bill2.number, amount: 10 }], credit: 0 });
    expect((await ctx.api("GET", `/bills/${bill1.body.id}`, { token: s.bankOwner.token })).body).toMatchObject({ status: "PAID", due: 0 });
    expect((await ctx.api("GET", `/bills/${bill2.id}`, { token: s.bankOwner.token })).body).toMatchObject({ status: "PARTLY_PAID", paid: 10, due: p2.charge - 10 });

    // The merchant says they paid more than due: pending until confirmed, then the extra is advance credit.
    const extra = p2.charge - 10 + 50;
    const claim = await ctx.api("POST", `/accounts/${accountId}/payments`, { token: s.bankOwner.token, body: { amount: extra, method: "BKASH", reference: "BK-77", paidOn: today, proof: PNG } });
    expect(claim.body).toMatchObject({ status: "PENDING", bills: [] });
    expect((await ctx.api("POST", `/payments/${claim.body.id}/confirm`, { token: s.bankOwner.token })).status).toBe(403);
    const confirmed = await ctx.api("POST", `/payments/${claim.body.id}/confirm`, { token: s.finance.token });
    expect(confirmed.body).toMatchObject({ status: "CONFIRMED", credit: 50, bills: [{ number: bill2.number, amount: p2.charge - 10 }] });
    acc = (await ctx.api("GET", `/accounts/${accountId}`, { token: s.bankOwner.token })).body;
    expect(acc.financial).toMatchObject({ notBilled: p3.charge, billedDue: 0, credit: 50, due: Math.max(0, p3.charge - 50) });

    // The next bill uses the credit at once.
    const bill3 = (await ctx.api("POST", `/accounts/${accountId}/bills`, { token: s.finance.token, body: { from: today, to: today, parcelIds: [p3.id] } })).body;
    expect(bill3).toMatchObject({ paid: Math.min(50, p3.charge) });

    // Voiding a bill frees its parcel and puts its payments back as credit.
    const voided = await ctx.api("POST", `/bills/${bill1.body.id}/void`, { token: s.finance.token, body: { reason: "Wrong merchant" } });
    expect(voided.body).toMatchObject({ status: "VOID", due: 0 });
    expect((await ctx.api("GET", `/accounts/${accountId}/parcels?status=not_billed`, { token: s.finance.token })).body.items.map((r: { trackingId: string }) => r.trackingId)).toEqual([p1.trackingId]);

    // Rejected claims change nothing; the bill PDF opens for the merchant only.
    const wrong = (await ctx.api("POST", `/accounts/${accountId}/payments`, { token: s.bankOwner.token, body: { amount: 99, method: "BANK", paidOn: today } })).body;
    expect((await ctx.api("POST", `/payments/${wrong.id}/reject`, { token: s.finance.token, body: { reason: "Not in our bank" } })).body).toMatchObject({ status: "REJECTED", rejectReason: "Not in our bank" });
    const pdf = await ctx.app.inject({ method: "GET", url: `/api/v1/documents/bill/${bill2.id}`, headers: { authorization: `Bearer ${s.bankOwner.token}` } });
    expect(pdf.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: `/api/v1/documents/bill/${bill2.id}`, headers: { authorization: `Bearer ${s.owner.token}` } })).statusCode).toBe(404);
    // E-commerce merchants aren't billed.
    expect((await ctx.api("POST", `/accounts/${await accountOf(s.shop.id).catch(() => accountId)}/bills`, { token: s.finance.token, body: { from: today, to: today, parcelIds: [p3.id] } })).status).toBeGreaterThanOrEqual(400);
  });

  it("customers: COD parcels open an account by the sender's phone, settled like a merchant", async () => {
    const s = await setup();
    const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Rahim Uddin");
    const sent = await deliver(s, customer.token, { codAmount: 1200, sender: { name: "Rahim Uddin", phone: customer.phone.replace("+880", "0") } }, s.centralRider);
    // No COD: nothing on the account (the sender paid the charge when booking).
    await deliver(s, customer.token, { codAmount: 0, sender: { name: "Rahim Uddin", phone: customer.phone.replace("+880", "0") } }, s.centralRider);
    const mine = (await ctx.api("GET", "/my-accounts", { token: customer.token })).body;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ kind: "CUSTOMER", phone: customer.phone, payTo: { method: "BKASH" } });
    expect(mine[0].cod.collected).toBe(1200);
    const slip = (await ctx.api("POST", "/rider/my-cash/slip", { token: s.centralRider.token })).body;
    await ctx.api("POST", `/cash/slips/${slip.id}/receive`, { token: s.centralOp.token, body: { received: slip.expected } });
    // The customer chooses Nagad; the settlement goes there.
    await ctx.api("PUT", `/accounts/${mine[0].id}/pay-to`, { token: customer.token, body: { method: "NAGAD", accountName: "Rahim", accountNumber: "01711000000" } });
    const st = await ctx.api("POST", `/accounts/${mine[0].id}/payouts`, { token: s.finance.token, body: {} });
    expect(st.status, JSON.stringify(st.body)).toBe(201);
    expect(st.body).toMatchObject({ amount: 1200 - sent.charge, payTo: { method: "NAGAD" } });
    const list = (await ctx.api("GET", "/accounts?kind=CUSTOMER", { token: s.ops.token })).body;
    expect(list.items).toHaveLength(1);
  });

  it("adjustments, the overview and who may see what", async () => {
    const s = await setup();
    await deliver(s, s.owner.token, { codAmount: 1000 });
    const accountId = await accountOf(s.shop.id);
    const adj = await ctx.api("POST", `/accounts/${accountId}/adjustments`, { token: s.finance.token, body: { amount: -50, reason: "Damaged packaging claim" } });
    expect(adj.status, JSON.stringify(adj.body)).toBe(201);
    expect((await ctx.api("POST", `/accounts/${accountId}/adjustments`, { token: s.owner.token, body: { amount: 50, reason: "Nope" } })).status).toBe(403);
    expect((await ctx.api("GET", `/accounts/${accountId}/statement`, { token: s.owner.token })).body.lines.at(-1)).toMatchObject({ type: "ADJUSTMENT", amount: -50, description: "Damaged packaging claim" });

    const overview = (await ctx.api("GET", "/accounts/overview", { token: s.ops.token })).body;
    expect(overview).toMatchObject({ centralHub: { id: s.central.id }, cash: { WITH_RIDER: { amount: 1000, count: 1 } } });
    // Branch staff: cash pages, not merchants' accounts. Merchants: only their own.
    expect((await ctx.api("GET", "/accounts?kind=ECOMMERCE", { token: s.branchOp.token })).status).toBe(403);
    expect((await ctx.api("GET", "/accounts?kind=ECOMMERCE", { token: s.centralOp.token })).status).toBe(200);
    expect((await ctx.api("GET", "/accounts?kind=ECOMMERCE", { token: s.owner.token })).status).toBe(403);
    expect((await ctx.api("GET", "/my-accounts", { token: s.owner.token })).body.map((a: { id: string }) => a.id)).toEqual([accountId]);
    // Only super admins choose the central hub.
    expect((await ctx.api("PUT", "/accounts/config", { token: s.finance.token, body: { centralHubId: s.branch.id } })).status).toBe(403);
    // VAT is off by default; the super admin switches it on (Super admin › Invoice settings). Finance reads it.
    expect((await ctx.api("GET", "/finance/config", { token: s.finance.token })).body).toMatchObject({ vatEnabled: false, showDeliveryCharge: true });
    expect((await ctx.api("PUT", "/finance/config", { token: s.admin.token, body: { showDeliveryCharge: false } })).body).toMatchObject({ showDeliveryCharge: false, vatEnabled: false });
    expect((await ctx.api("PUT", "/finance/config", { token: s.admin.token, body: { vatEnabled: true } })).body).toMatchObject({ vatEnabled: true, vatRate: 15 });
    for (const who of [s.finance, s.ops]) expect((await ctx.api("PUT", "/finance/config", { token: who.token, body: { vatEnabled: false } })).status).toBe(403);
  });

  it("switching over: existing delivered parcels get their lines once; old hub cash is placed", async () => {
    const s = await setup();
    const p = await deliver(s, s.owner.token, { codAmount: 700 });
    // As if delivered before Accounts: no lines, cash received the old way at the central hub.
    await ctx.prisma.accountEntry.deleteMany({});
    await ctx.prisma.codCollection.update({ where: { parcelId: p.id }, data: { state: "AT_HUB", hubId: s.central.id, cashHubId: null } });
    const first = await ctx.api("POST", "/accounts/cutover", { token: s.admin.token });
    expect(first.body).toMatchObject({ parcels: 1, cashPlaced: 1 });
    expect((await ctx.api("POST", "/accounts/cutover", { token: s.admin.token })).body).toMatchObject({ parcels: 0, cashPlaced: 0 });
    expect((await ctx.prisma.codCollection.findUniqueOrThrow({ where: { parcelId: p.id } })).state).toBe("AT_CENTRAL");
    expect((await ctx.api("POST", "/accounts/cutover", { token: s.finance.token })).status).toBe(403);
  });

  it("rider report: pickups, deliveries, failures, COD collected and handed in for a day; the parcels behind it", async () => {
    const s = await setup();
    await deliver(s, s.owner.token, { codAmount: 1000 });
    await deliver(s, s.owner.token, { codAmount: 400 });
    const slip = (await ctx.api("POST", "/rider/my-cash/slip", { token: s.rider.token })).body;
    await ctx.api("POST", `/cash/slips/${slip.id}/receive`, { token: s.branchOp.token, body: { received: 1300 } });
    await ctx.prisma.riderLocation.create({ data: { riderId: s.rider.rider.id, lat: 23.79, lng: 90.41, accuracy: 10, at: new Date() } });
    const day = new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);

    const report = await ctx.api("GET", `/reports/riders?from=${day}&to=${day}`, { token: s.branchOp.token });
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    // The branch's staff see only their own hub's rider.
    expect(report.body.items.map((i: { rider: { code: string } }) => i.rider.code)).toEqual(["R-3001"]);
    expect(report.body.items[0]).toMatchObject({
      pickups: { assigned: 2, pickedUp: 2 },
      deliveries: { delivered: 2, failed: 0 },
      cash: { collected: 1400, handedIn: 1300, holdingNow: 100 },
      location: { lat: 23.79, lng: 90.41 },
    });
    expect(report.body.totals).toMatchObject({ delivered: 2, collected: 1400, handedIn: 1300 });

    const parcels = (await ctx.api("GET", `/reports/riders/parcels?from=${day}&to=${day}&riderId=${s.rider.rider.id}`, { token: s.ops.token })).body.items;
    expect(parcels.filter((p: { leg: string }) => p.leg === "Delivery").map((p: { outcome: string; cod: number }) => [p.outcome, p.cod]).sort()).toEqual([["Delivered", 1000], ["Delivered", 400]].sort());
    expect(parcels.filter((p: { leg: string }) => p.leg === "Pickup")).toHaveLength(2);
    // Another day: nothing; too long a range is refused; merchants can't see it.
    expect((await ctx.api("GET", `/reports/riders?from=2025-01-01&to=2025-01-01`, { token: s.ops.token })).body.totals.delivered).toBe(0);
    expect((await ctx.api("GET", `/reports/riders?from=2025-01-01&to=2025-03-01`, { token: s.ops.token })).status).toBe(422);
    expect((await ctx.api("GET", `/reports/riders?from=${day}&to=${day}`, { token: s.owner.token })).status).toBe(403);
  });

  it("Accounts tab badges: riders holding cash, then hub cash to send, then a transfer on the way; per person's tabs", async () => {
    const s = await setup();
    await deliver(s, s.owner.token, { codAmount: 1000 });
    const counts = async (token: string) => {
      const res = await ctx.api("GET", "/accounts/tab-counts", { token });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return res.body;
    };
    let ops = await counts(s.ops.token);
    expect(ops["Rider cash"]).toMatchObject({ count: 1, amount: 1000 });
    expect(ops["Rider cash"].hint).toContain("1 rider hold");
    expect(ops["E-commerce"]).toBeDefined();
    // Hub staff: only their tabs.
    const branch = await counts(s.branchOp.token);
    expect(Object.keys(branch)).not.toContain("E-commerce");
    expect(branch["Rider cash"]).toMatchObject({ count: 1, amount: 1000 });

    const slip = (await ctx.api("POST", "/rider/my-cash/slip", { token: s.rider.token })).body;
    await ctx.api("POST", `/cash/slips/${slip.id}/receive`, { token: s.branchOp.token, body: { received: 1000 } });
    ops = await counts(s.ops.token);
    expect(ops["Rider cash"]).toMatchObject({ count: 0, amount: 0 });
    expect(ops["Hub transfers"]).toMatchObject({ count: 1, amount: 1000 });
    expect(ops["Hub transfers"].hint).toContain("1 hub to send");

    await ctx.api("POST", "/cash/transfers", { token: s.branchOp.token, body: { fromHubId: s.branch.id, method: "BKASH" } });
    ops = await counts(s.ops.token);
    expect(ops["Hub transfers"]).toMatchObject({ count: 1, amount: 1000 });
    expect(ops["Hub transfers"].hint).toContain("1 transfer on the way");
    // Merchants see no tabs.
    expect(await counts(s.owner.token)).toEqual({});
  });

  it("PDFs: the rider's slip with its barcode, the hub transfer, the statement", async () => {
    const s = await setup();
    await deliver(s, s.owner.token, { codAmount: 900 });
    const slip = (await ctx.api("POST", "/rider/my-cash/slip", { token: s.rider.token })).body;
    const get = (url: string, token: string) => ctx.app.inject({ method: "GET", url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` } });
    expect((await get(`/documents/cash-slip/${slip.number}`, s.rider.token)).statusCode).toBe(200);
    expect((await get(`/documents/cash-slip/${slip.number}`, s.branchOp.token)).statusCode).toBe(200);
    expect((await get(`/documents/cash-slip/${slip.number}`, s.centralRider.token)).statusCode).toBe(404);
    await ctx.api("POST", `/cash/slips/${slip.id}/receive`, { token: s.branchOp.token, body: { received: 900 } });
    const t = (await ctx.api("POST", "/cash/transfers", { token: s.branchOp.token, body: { fromHubId: s.branch.id, method: "BKASH" } })).body;
    expect((await get(`/documents/hub-transfer/${t.number}`, s.centralOp.token)).statusCode).toBe(200);
    const st = await get(`/documents/account-statement/${await accountOf(s.shop.id)}`, s.owner.token);
    expect(st.statusCode).toBe(200);
    expect(st.headers["content-type"]).toBe("application/pdf");
  });
});
