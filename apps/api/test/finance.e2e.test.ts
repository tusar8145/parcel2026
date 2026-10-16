import { decrypt } from "../src/common/crypto";
import { hub, parcelBody, resetDatabase, riderUser, startApp, userWithRoles, type TestContext } from "./helpers";

describe("finance: COD custody, settlements and invoices", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  let merchantSeq = 1000;
  const merchant = (name = "Shop BD") =>
    ctx.prisma.merchant.create({
      data: {
        code: `MR-${++merchantSeq}`,
        type: "ECOMMERCE",
        name,
        status: "ACTIVE",
        contactName: "Owner",
        contactPhone: "+8801911000000",
        pickupAddress: "House 5 Road 2",
        pickupArea: "Gulshan 1",
        pickupDistrict: "Dhaka North",
      },
    });

  const setup = async () => {
    const h1 = await hub(ctx, "HUB-A");
    const h2 = await hub(ctx, "HUB-B");
    const m = await merchant();
    const owner = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: m.id }], "Merchant Owner");
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops Manager");
    const fin1 = await userWithRoles(ctx, [{ role: "FINANCE" }], "Finance One");
    const fin2 = await userWithRoles(ctx, [{ role: "FINANCE" }], "Finance Two");
    const hubOp = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: h1.id }], "Hub A Operator");
    const rider = await riderUser(ctx, "R-2048", h1.id);
    return { h1, h2, m, owner, ops, fin1, fin2, hubOp, rider };
  };
  type Setup = Awaited<ReturnType<typeof setup>>;

  /** Books as the merchant owner and drives the parcel to DELIVERED through the API. */
  const deliver = async (s: Pick<Setup, "owner" | "ops" | "rider">, codAmount: number, rider = s.rider) => {
    const booked = await ctx.api("POST", "/parcels", { token: s.owner.token, body: parcelBody({ codAmount }) });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    const { trackingId } = booked.body;
    await ctx.api("POST", `/parcels/${trackingId}/assign-pickup`, { token: s.ops.token, body: { riderId: rider.rider.id } });
    await ctx.api("POST", `/rider/parcels/${trackingId}/pickup`, { token: rider.token, body: { outcome: "COLLECTED_DELIVER_DIRECT" } });
    const parcel = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId } });
    const done = await ctx.api("POST", `/rider/parcels/${trackingId}/delivery`, {
      token: rider.token,
      body: { outcome: "DELIVERED", receivedBy: "Nabila", proof: { method: "OTP", otp: decrypt(parcel.deliveryOtpEncrypted!) }, ...(codAmount > 0 ? { codCollected: codAmount } : {}) },
    });
    expect(done.body.status, JSON.stringify(done.body)).toBe("DELIVERED");
    const collection = await ctx.prisma.codCollection.findUnique({ where: { parcelId: parcel.id } });
    return { trackingId, charge: Number(parcel.totalCharge), collectionId: collection?.id };
  };

  const handover = (token: string, body: object) => ctx.api("POST", "/cod/handovers", { token, body });

  /** Delivers COD parcels and hands the cash to hub A. */
  const cashAtHub = async (s: Setup, amounts: number[]) => {
    const parcels = [];
    for (const a of amounts) parcels.push(await deliver(s, a));
    const total = amounts.reduce((x, y) => x + y, 0);
    const res = await handover(s.hubOp.token, { riderId: s.rider.rider.id, hubId: s.h1.id, collectionIds: parcels.map(p => p.collectionId), amountReceived: total.toFixed(2) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return parcels;
  };

  describe("rider cash and handovers", () => {
    it("lists riders holding cash and receives an exact handover", async () => {
      const s = await setup();
      const a = await deliver(s, 1500);
      const b = await deliver(s, 850.5);

      const riders = await ctx.api("GET", "/cod/riders", { token: s.hubOp.token });
      expect(riders.status).toBe(200);
      expect(riders.body).toHaveLength(1);
      expect(riders.body[0]).toMatchObject({ riderId: s.rider.rider.id, code: "R-2048", cashInHand: 2350.5, collections: 2, hub: { id: s.h1.id } });
      expect(riders.body[0].oldestCollectedAt).toBeTruthy();

      const list = await ctx.api("GET", `/cod/riders/${s.rider.rider.id}/collections`, { token: s.hubOp.token });
      expect(list.body.cashInHand).toBe(2350.5);
      expect(list.body.collections.map((c: { trackingId: string }) => c.trackingId)).toEqual([a.trackingId, b.trackingId]);

      const body = { riderId: s.rider.rider.id, hubId: s.h1.id, collectionIds: [a.collectionId, b.collectionId] };
      const short = await handover(s.hubOp.token, { ...body, amountReceived: 2350.49 });
      expect(short.status).toBe(422);
      expect(short.body.error).toMatchObject({ code: "HANDOVER_AMOUNT_MISMATCH", details: { expected: 2350.5, received: 2350.49 } });

      const otherHub = await handover(s.hubOp.token, { ...body, hubId: s.h2.id, amountReceived: 2350.5 });
      expect(otherHub.status).toBe(403);

      const ok = await handover(s.hubOp.token, { ...body, amountReceived: "2350.50", note: "Counted twice" });
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
      expect(ok.body).toMatchObject({ amount: 2350.5, collectionCount: 2, hub: { id: s.h1.id }, receivedBy: { id: s.hubOp.user.id, name: "Hub A Operator" }, note: "Counted twice" });
      expect(ok.body.collections).toHaveLength(2);

      const rows = await ctx.prisma.codCollection.findMany();
      expect(rows.every(c => c.state === "AT_HUB" && c.handoverId === ok.body.id)).toBe(true);
      expect((await ctx.api("GET", "/cod/riders", { token: s.hubOp.token })).body).toEqual([]);
      expect((await ctx.api("GET", "/rider/cash", { token: s.rider.token })).body.inHand).toBe(0);
      expect(await ctx.prisma.auditLog.count({ where: { action: "cod.handover", entityId: ok.body.id } })).toBe(1);

      const again = await handover(s.hubOp.token, { ...body, amountReceived: 2350.5 });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe("COLLECTION_NOT_AVAILABLE");
    });

    it("rejects collections held by another rider and invalid input", async () => {
      const s = await setup();
      const other = await riderUser(ctx, "R-3000", s.h1.id);
      const mine = await deliver(s, 500);
      const theirs = await deliver(s, 700, other);

      const mixed = await handover(s.fin1.token, { riderId: s.rider.rider.id, hubId: s.h2.id, collectionIds: [mine.collectionId, theirs.collectionId], amountReceived: 1200 });
      expect(mixed.status).toBe(409);
      expect(mixed.body.error).toMatchObject({ code: "COLLECTION_NOT_AVAILABLE", details: { unavailable: [theirs.collectionId] } });

      const base = { riderId: s.rider.rider.id, hubId: s.h1.id };
      expect((await handover(s.fin1.token, { ...base, collectionIds: [], amountReceived: 0 })).status).toBe(422);
      expect((await handover(s.fin1.token, { ...base, collectionIds: [mine.collectionId, mine.collectionId], amountReceived: 1000 })).status).toBe(422);
      expect((await handover(s.fin1.token, { ...base, collectionIds: [mine.collectionId], amountReceived: 500.001 })).body.error.code).toBe("VALIDATION_FAILED");
      expect((await handover(s.owner.token, { ...base, collectionIds: [mine.collectionId], amountReceived: 500 })).status).toBe(403);
      expect((await handover(s.rider.token, { ...base, collectionIds: [mine.collectionId], amountReceived: 500 })).status).toBe(403);

      // An unscoped receiver (finance) can take cash at any hub.
      const ok = await handover(s.fin1.token, { ...base, hubId: s.h2.id, collectionIds: [mine.collectionId], amountReceived: 500 });
      expect(ok.status).toBe(201);
    });

    it("lets only one of several simultaneous handovers of the same cash succeed", async () => {
      const s = await setup();
      const a = await deliver(s, 1200);
      const b = await deliver(s, 300);
      const body = { riderId: s.rider.rider.id, hubId: s.h1.id, collectionIds: [a.collectionId, b.collectionId], amountReceived: 1500 };
      const results = await Promise.all([handover(s.hubOp.token, body), handover(s.fin1.token, body), handover(s.ops.token, body), handover(s.fin2.token, body)]);
      expect(results.filter(r => r.status === 201)).toHaveLength(1);
      expect(results.filter(r => r.status === 409).every(r => r.body.error.code === "COLLECTION_NOT_AVAILABLE")).toBe(true);
      expect(results.filter(r => r.status === 409)).toHaveLength(3);
      expect(await ctx.prisma.cashHandover.count()).toBe(1);
      const total = await ctx.prisma.cashHandover.aggregate({ _sum: { amount: true } });
      expect(Number(total._sum.amount)).toBe(1500);
    });

    it("lists handovers with filters, hub scoping and pagination", async () => {
      const s = await setup();
      const p1 = await deliver(s, 100);
      const p2 = await deliver(s, 200);
      const p3 = await deliver(s, 300);
      const base = { riderId: s.rider.rider.id };
      await handover(s.hubOp.token, { ...base, hubId: s.h1.id, collectionIds: [p1.collectionId], amountReceived: 100 });
      await handover(s.hubOp.token, { ...base, hubId: s.h1.id, collectionIds: [p2.collectionId], amountReceived: 200 });
      await handover(s.fin1.token, { ...base, hubId: s.h2.id, collectionIds: [p3.collectionId], amountReceived: 300 });

      const all = await ctx.api("GET", "/cod/handovers", { token: s.fin1.token });
      expect(all.status).toBe(200);
      expect(all.body.items.map((h: { amount: number }) => h.amount)).toEqual([300, 200, 100]);

      const page1 = await ctx.api("GET", "/cod/handovers?limit=2", { token: s.fin1.token });
      expect(page1.body.items).toHaveLength(2);
      const page2 = await ctx.api("GET", `/cod/handovers?limit=2&cursor=${page1.body.nextCursor}`, { token: s.fin1.token });
      expect(page2.body).toMatchObject({ items: [{ amount: 100 }], nextCursor: null });

      const scoped = await ctx.api("GET", "/cod/handovers", { token: s.hubOp.token });
      expect(scoped.body.items.map((h: { amount: number }) => h.amount)).toEqual([200, 100]);
      expect((await ctx.api("GET", `/cod/handovers?hubId=${s.h2.id}`, { token: s.hubOp.token })).status).toBe(403);
      expect((await ctx.api("GET", `/cod/handovers?hubId=${s.h2.id}`, { token: s.fin1.token })).body.items).toHaveLength(1);
      expect((await ctx.api("GET", `/cod/handovers?riderId=${s.rider.rider.id}&from=2000-01-01`, { token: s.fin1.token })).body.items).toHaveLength(3);
      expect((await ctx.api("GET", "/cod/handovers?to=2000-01-01", { token: s.fin1.token })).body.items).toHaveLength(0);

      expect((await ctx.api("GET", "/cod/handovers", { token: s.owner.token })).status).toBe(403);
      expect((await ctx.api("GET", "/cod/riders", { token: s.owner.token })).status).toBe(403);
      expect((await ctx.api("GET", `/cod/riders?hubId=${s.h2.id}`, { token: s.hubOp.token })).status).toBe(403);
    });
  });

  describe("settlements", () => {
    it("drafts, approves (maker-checker), pays and notifies", async () => {
      const s = await setup();
      const parcels = await cashAtHub(s, [1500, 850.5]);
      const charges = parcels.reduce((x, p) => x + p.charge, 0);
      // Cash still with a rider isn't settled.
      await deliver(s, 999);

      const draft = await ctx.api("POST", "/settlements", { token: s.fin1.token, body: { merchantId: s.m.id } });
      expect(draft.status, JSON.stringify(draft.body)).toBe(201);
      expect(draft.body.number).toMatch(/^ST-\d{4}-0001$/);
      expect(draft.body).toMatchObject({ status: "DRAFT", codTotal: 2350.5, chargesTotal: charges, netPayable: Number((2350.5 - charges).toFixed(2)), collectionCount: 2, createdBy: { id: s.fin1.user.id } });
      expect(draft.body.lines).toHaveLength(2);
      expect(draft.body.lines[0]).toMatchObject({ trackingId: parcels[0].trackingId, codAmount: 1500, charge: parcels[0].charge });
      expect(draft.body.lines[0].deliveredAt).toBeTruthy();

      const nothing = await ctx.api("POST", "/settlements", { token: s.fin2.token, body: { merchantId: s.m.id } });
      expect(nothing.status).toBe(422);
      expect(nothing.body.error.code).toBe("NOTHING_TO_SETTLE");

      const payEarly = await ctx.api("POST", `/settlements/${draft.body.id}/pay`, { token: s.fin2.token, body: { reference: "BKASH-TX-1" } });
      expect(payEarly.body.error.code).toBe("SETTLEMENT_NOT_APPROVED");

      const self = await ctx.api("POST", `/settlements/${draft.body.id}/approve`, { token: s.fin1.token });
      expect(self.status).toBe(403);
      expect(self.body.error.code).toBe("SAME_USER_APPROVAL");

      const approved = await ctx.api("POST", `/settlements/${draft.body.id}/approve`, { token: s.fin2.token });
      expect(approved.status).toBe(200);
      expect(approved.body).toMatchObject({ status: "APPROVED", approvedBy: { id: s.fin2.user.id } });
      expect((await ctx.api("DELETE", `/settlements/${draft.body.id}`, { token: s.fin1.token })).body.error.code).toBe("SETTLEMENT_NOT_DRAFT");

      const paid = await ctx.api("POST", `/settlements/${draft.body.id}/pay`, { token: s.fin1.token, body: { reference: "BKASH-TX-1" } });
      expect(paid.status).toBe(200);
      expect(paid.body).toMatchObject({ status: "PAID", reference: "BKASH-TX-1" });
      expect(paid.body.paidAt).toBeTruthy();
      expect(paid.body.lines.every((l: { state: string }) => l.state === "SETTLED")).toBe(true);
      const sms = await ctx.prisma.outboxMessage.findFirstOrThrow({ where: { template: "finance.settlement_paid" } });
      expect(sms.to).toBe("+8801911000000");
      expect(sms.body).toContain(draft.body.number);

      expect((await ctx.api("POST", `/settlements/${draft.body.id}/pay`, { token: s.fin1.token, body: { reference: "BKASH-TX-2" } })).status).toBe(409);
      const actions = (await ctx.prisma.auditLog.findMany({ where: { entityId: draft.body.id }, orderBy: { createdAt: "asc" } })).map(a => a.action);
      expect(actions).toEqual(["settlement.create", "settlement.approve", "settlement.pay"]);
    });

    it("scopes settlements to the merchant owner", async () => {
      const s = await setup();
      await cashAtHub(s, [400]);
      const draft = await ctx.api("POST", "/settlements", { token: s.fin1.token, body: { merchantId: s.m.id } });
      const otherMerchant = await merchant("Other Shop");
      const stranger = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: otherMerchant.id }], "Other Owner");

      expect((await ctx.api("GET", "/settlements", { token: s.owner.token })).body.items).toHaveLength(1);
      expect((await ctx.api("GET", `/settlements/${draft.body.id}`, { token: s.owner.token })).body.lines).toHaveLength(1);
      expect((await ctx.api("GET", "/settlements", { token: stranger.token })).body.items).toHaveLength(0);
      expect((await ctx.api("GET", `/settlements/${draft.body.id}`, { token: stranger.token })).status).toBe(404);
      expect((await ctx.api("GET", `/settlements?merchantId=${s.m.id}&status=DRAFT`, { token: s.fin2.token })).body.items).toHaveLength(1);
      expect((await ctx.api("POST", "/settlements", { token: s.owner.token, body: { merchantId: s.m.id } })).status).toBe(403);
      expect((await ctx.api("POST", `/settlements/${draft.body.id}/approve`, { token: s.ops.token })).status).toBe(403);
      expect((await ctx.api("GET", "/settlements", { token: s.hubOp.token })).status).toBe(403);
      expect((await ctx.api("POST", "/settlements", { token: s.fin1.token, body: { merchantId: "019a0000-0000-7000-8000-000000000000" } })).status).toBe(404);
    });

    it("never settles the same cash twice under concurrency", async () => {
      const s = await setup();
      await cashAtHub(s, [1000, 250.25]);
      const results = await Promise.all([1, 2, 3, 4].map(() => ctx.api("POST", "/settlements", { token: s.fin1.token, body: { merchantId: s.m.id } })));
      expect(results.filter(r => r.status === 201)).toHaveLength(1);
      expect(results.filter(r => r.status === 422).every(r => r.body.error.code === "NOTHING_TO_SETTLE")).toBe(true);
      expect(await ctx.prisma.merchantSettlement.count()).toBe(1);
      const settlement = await ctx.prisma.merchantSettlement.findFirstOrThrow();
      expect(await ctx.prisma.codCollection.count({ where: { settlementId: settlement.id } })).toBe(2);
      expect(settlement.codTotal.toFixed(2)).toBe("1250.25");

      // Two checkers approving at once: one wins.
      const approvals = await Promise.all([1, 2].map(() => ctx.api("POST", `/settlements/${settlement.id}/approve`, { token: s.fin2.token })));
      expect(approvals.map(r => r.status).sort()).toEqual([200, 409]);

      // Paying twice at once: one wins, collections settle once.
      const pays = await Promise.all([1, 2].map(i => ctx.api("POST", `/settlements/${settlement.id}/pay`, { token: s.fin1.token, body: { reference: `REF-00${i}` } })));
      expect(pays.map(r => r.status).sort()).toEqual([200, 409]);
      expect(await ctx.prisma.outboxMessage.count({ where: { template: "finance.settlement_paid" } })).toBe(1);
      expect(await ctx.prisma.codCollection.count({ where: { state: "SETTLED" } })).toBe(2);
    });

    it("deletes drafts and releases their collections", async () => {
      const s = await setup();
      await cashAtHub(s, [600]);
      const draft = await ctx.api("POST", "/settlements", { token: s.fin1.token, body: { merchantId: s.m.id } });
      expect((await ctx.api("DELETE", `/settlements/${draft.body.id}`, { token: s.owner.token })).status).toBe(403);
      const del = await ctx.api("DELETE", `/settlements/${draft.body.id}`, { token: s.fin1.token });
      expect(del.status).toBe(204);
      expect(await ctx.prisma.codCollection.count({ where: { settlementId: null, state: "AT_HUB" } })).toBe(1);
      expect((await ctx.api("GET", `/settlements/${draft.body.id}`, { token: s.fin1.token })).status).toBe(404);
      expect(await ctx.prisma.auditLog.count({ where: { action: "settlement.delete", entityId: draft.body.id } })).toBe(1);

      const redo = await ctx.api("POST", "/settlements", { token: s.fin1.token, body: { merchantId: s.m.id } });
      expect(redo.status).toBe(201);
      expect(redo.body.number).toMatch(/-0002$/);
    });
  });

  describe("invoices", () => {

    it("bills delivered non-COD parcels for a closed period", async () => {
      const s = await setup();
      const start = hourAgo();
      const a = await deliver(s, 0);
      const b = await deliver(s, 0);
      await deliver(s, 1200); // COD: its charge is netted in the settlement instead
      const end = new Date().toISOString();

      const inv = await ctx.api("POST", "/invoices", { token: s.fin1.token, body: { merchantId: s.m.id, periodStart: start, periodEnd: end } });
      expect(inv.status, JSON.stringify(inv.body)).toBe(201);
      expect(inv.body.number).toMatch(/^INV-\d{4}-0001$/);
      expect(inv.body).toMatchObject({ status: "ISSUED", subtotal: a.charge + b.charge, lineCount: 2, overdue: false });
      expect(inv.body.lines).toEqual([
        { trackingId: a.trackingId, description: expect.stringContaining("delivery to Dhanmondi"), amount: a.charge, taxableValue: expect.any(Number), vat: expect.any(Number) },
        { trackingId: b.trackingId, description: expect.any(String), amount: b.charge, taxableValue: expect.any(Number), vat: expect.any(Number) },
      ]);
      expect(new Date(inv.body.dueAt).getTime() - new Date(inv.body.issuedAt).getTime()).toBe(15 * 86_400_000);

      const overlap = await ctx.api("POST", "/invoices", { token: s.fin1.token, body: { merchantId: s.m.id, periodStart: hourAgo(), periodEnd: new Date().toISOString() } });
      expect(overlap.status).toBe(409);
      expect(overlap.body.error).toMatchObject({ code: "INVOICE_PERIOD_OVERLAP", details: { invoiceId: inv.body.id } });

      const empty = await ctx.api("POST", "/invoices", { token: s.fin1.token, body: { merchantId: s.m.id, periodStart: "2025-01-01", periodEnd: "2025-02-01" } });
      expect(empty.body.error.code).toBe("NOTHING_TO_INVOICE");
      const future = await ctx.api("POST", "/invoices", { token: s.fin1.token, body: { merchantId: s.m.id, periodStart: end, periodEnd: new Date(Date.now() + 86_400_000).toISOString() } });
      expect(future.body.error.code).toBe("PERIOD_NOT_ENDED");
      const backwards = await ctx.api("POST", "/invoices", { token: s.fin1.token, body: { merchantId: s.m.id, periodStart: end, periodEnd: start } });
      expect(backwards.body.error.code).toBe("VALIDATION_FAILED");

      const paid = await ctx.api("POST", `/invoices/${inv.body.id}/mark-paid`, { token: s.fin1.token, body: { reference: "BANK-778" } });
      expect(paid.status).toBe(200);
      expect(paid.body.status).toBe("PAID");
      expect(paid.body.paidAt).toBeTruthy();
      const voidPaid = await ctx.api("POST", `/invoices/${inv.body.id}/void`, { token: s.fin1.token, body: { reason: "Mistake" } });
      expect(voidPaid.status).toBe(409);
      expect(voidPaid.body.error.code).toBe("INVALID_INVOICE_TRANSITION");
      expect((await ctx.api("POST", `/invoices/${inv.body.id}/mark-paid`, { token: s.fin1.token, body: {} })).status).toBe(409);
      const actions = (await ctx.prisma.auditLog.findMany({ where: { entityId: inv.body.id }, orderBy: { createdAt: "asc" } })).map(x => x.action);
      expect(actions).toEqual(["invoice.create", "invoice.mark_paid"]);
    });

    it("voids, re-issues, scopes to merchants and serializes concurrent runs", async () => {
      const s = await setup();
      const start = hourAgo();
      await deliver(s, 0);
      const end = new Date().toISOString();
      const body = { merchantId: s.m.id, periodStart: start, periodEnd: end };

      const runs = await Promise.all([1, 2, 3].map(() => ctx.api("POST", "/invoices", { token: s.fin1.token, body })));
      expect(runs.filter(r => r.status === 201)).toHaveLength(1);
      expect(runs.filter(r => r.status === 409)).toHaveLength(2);
      const inv = runs.find(r => r.status === 201)!.body;

      const voided = await ctx.api("POST", `/invoices/${inv.id}/void`, { token: s.fin1.token, body: { reason: "Wrong period" } });
      expect(voided.body.status).toBe("VOID");
      const reissued = await ctx.api("POST", "/invoices", { token: s.fin1.token, body });
      expect(reissued.status).toBe(201);

      const otherMerchant = await merchant("Other Shop");
      const stranger = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: otherMerchant.id }], "Other Owner");
      expect((await ctx.api("GET", "/invoices", { token: s.owner.token })).body.items).toHaveLength(2);
      expect((await ctx.api("GET", "/invoices?status=ISSUED", { token: s.owner.token })).body.items).toHaveLength(1);
      expect((await ctx.api("GET", `/invoices/${reissued.body.id}`, { token: s.owner.token })).body.lines).toHaveLength(1);
      expect((await ctx.api("GET", "/invoices", { token: stranger.token })).body.items).toHaveLength(0);
      expect((await ctx.api("GET", `/invoices/${reissued.body.id}`, { token: stranger.token })).status).toBe(404);
      expect((await ctx.api("POST", "/invoices", { token: s.owner.token, body })).status).toBe(403);
      expect((await ctx.api("POST", `/invoices/${reissued.body.id}/void`, { token: s.owner.token, body: { reason: "nope" } })).status).toBe(403);
    });
  });

  it("summarizes the company money position for finance staff only", async () => {
    const s = await setup();
    await cashAtHub(s, [1000.1, 200.2]);
    await deliver(s, 333.33);
    const charges = (await ctx.prisma.codCollection.findMany({ where: { state: "AT_HUB" }, include: { parcel: true } })).reduce((x, c) => x + Number(c.parcel.totalCharge), 0);

    const draft = await ctx.api("POST", "/settlements", { token: s.fin1.token, body: { merchantId: s.m.id } });
    let summary = await ctx.api("GET", "/finance/summary", { token: s.fin2.token });
    expect(summary.status).toBe(200);
    expect(summary.body).toEqual({
      codWithRiders: 333.33,
      codAtHubs: 1200.3,
      settledThisMonth: 0,
      payablePendingApproval: Number((1200.3 - charges).toFixed(2)),
      payableAwaitingPayment: 0,
      invoicesOutstanding: 0,
      merchantReceivablesOpen: 0,
    });

    await ctx.api("POST", `/settlements/${draft.body.id}/approve`, { token: s.fin2.token });
    await ctx.api("POST", `/settlements/${draft.body.id}/pay`, { token: s.fin1.token, body: { reference: "REF-123" } });
    const start = hourAgo();
    const plain = await deliver(s, 0);
    await ctx.api("POST", "/invoices", { token: s.fin1.token, body: { merchantId: s.m.id, periodStart: start, periodEnd: new Date().toISOString() } });

    summary = await ctx.api("GET", "/finance/summary", { token: s.fin1.token });
    expect(summary.body).toMatchObject({ codAtHubs: 0, settledThisMonth: Number((1200.3 - charges).toFixed(2)), payablePendingApproval: 0, invoicesOutstanding: plain.charge });

    expect((await ctx.api("GET", "/finance/summary", { token: s.owner.token })).status).toBe(403);
    expect((await ctx.api("GET", "/finance/summary", { token: s.hubOp.token })).status).toBe(403);
  });

  function hourAgo() {
    return new Date(Date.now() - 3600_000).toISOString();
  }
});
