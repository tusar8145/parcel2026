import { decrypt } from "../src/common/crypto";
import { LedgerService } from "../src/modules/finance/ledger.service";
import { hub, parcelBody, resetDatabase, riderUser, startApp, userWithRoles, type TestContext } from "./helpers";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("finance: ledger, carry-forward, schedules, reconciliation, disputes, VAT", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  let seq = 2000;
  const merchant = (name = "Ledger Shop") =>
    ctx.prisma.merchant.create({
      data: {
        code: `MR-${++seq}`,
        type: "ECOMMERCE",
        name,
        status: "ACTIVE",
        contactName: "Owner",
        contactPhone: "+8801911000001",
        pickupAddress: "House 5 Road 2",
        pickupArea: "Gulshan 1",
        pickupDistrict: "Dhaka North",
      },
    });

  const setup = async () => {
    const h1 = await hub(ctx, "HUB-L1");
    const m = await merchant();
    const owner = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: m.id }], "Merchant Owner");
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops Manager");
    const fin1 = await userWithRoles(ctx, [{ role: "FINANCE" }], "Finance One");
    const fin2 = await userWithRoles(ctx, [{ role: "FINANCE" }], "Finance Two");
    const agent = await userWithRoles(ctx, [{ role: "SUPPORT_AGENT" }], "Support Agent");
    const rider = await riderUser(ctx, "R-4100", h1.id);
    return { h1, m, owner, ops, fin1, fin2, agent, rider };
  };
  type Setup = Awaited<ReturnType<typeof setup>>;

  const deliver = async (s: Setup, codAmount: number, extra: Record<string, unknown> = {}) => {
    const booked = await ctx.api("POST", "/parcels", { token: s.owner.token, body: parcelBody({ codAmount, ...extra }) });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    const { trackingId } = booked.body;
    await ctx.api("POST", `/parcels/${trackingId}/assign-pickup`, { token: s.ops.token, body: { riderId: s.rider.rider.id } });
    await ctx.api("POST", `/rider/parcels/${trackingId}/pickup`, { token: s.rider.token, body: { outcome: "COLLECTED_DELIVER_DIRECT" } });
    const parcel = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId } });
    const done = await ctx.api("POST", `/rider/parcels/${trackingId}/delivery`, {
      token: s.rider.token,
      body: { outcome: "DELIVERED", receivedBy: "Nabila", proof: { method: "OTP", otp: decrypt(parcel.deliveryOtpEncrypted!) }, ...(codAmount > 0 ? { codCollected: codAmount } : {}) },
    });
    expect(done.body.status, JSON.stringify(done.body)).toBe("DELIVERED");
    const collection = await ctx.prisma.codCollection.findUnique({ where: { parcelId: parcel.id } });
    return { trackingId, charge: Number(parcel.totalCharge), collectionId: collection?.id };
  };

  const cashAtHub = async (s: Setup, amounts: number[]) => {
    const parcels = [];
    for (const a of amounts) parcels.push(await deliver(s, a));
    const total = amounts.reduce((x, y) => x + y, 0);
    const res = await ctx.api("POST", "/cod/handovers", { token: s.fin1.token, body: { riderId: s.rider.rider.id, hubId: s.h1.id, collectionIds: parcels.map(p => p.collectionId), amountReceived: total.toFixed(2) } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return parcels;
  };

  const settleAndPay = async (s: Setup, body: object = { reference: "BKASH-TX-77" }) => {
    const draft = await ctx.api("POST", "/settlements", { token: s.fin1.token, body: { merchantId: s.m.id } });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect((await ctx.api("POST", `/settlements/${draft.body.id}/approve`, { token: s.fin2.token })).status).toBe(200);
    const paid = await ctx.api("POST", `/settlements/${draft.body.id}/pay`, { token: s.fin1.token, body });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    return paid.body;
  };

  const balance = (accounts: { code: string; balance: number }[], code: string) => accounts.find(a => a.code === code)!.balance;
  const hourAgo = () => new Date(Date.now() - 3600_000).toISOString();

  it("posts every money flow as balanced journal entries and reports them", async () => {
    const s = await setup();
    const parcels = await cashAtHub(s, [1500, 850.5]);
    const charges = parcels.reduce((x, p) => x + p.charge, 0);
    const settlement = await settleAndPay(s);
    expect(settlement).toMatchObject({ paidBy: { id: s.fin1.user.id }, createdBy: { id: s.fin1.user.id }, carriedForward: 0 });
    expect(settlement.vat.rate).toBe(15);

    const start = hourAgo();
    const plain = await deliver(s, 0);
    const inv = await ctx.api("POST", "/invoices", { token: s.fin1.token, body: { merchantId: s.m.id, periodStart: start, periodEnd: new Date().toISOString() } });
    expect(inv.status).toBe(201);
    const paidInv = await ctx.api("POST", `/invoices/${inv.body.id}/mark-paid`, { token: s.fin2.token, body: { reference: "BANK-991" } });
    expect(paidInv.body).toMatchObject({ status: "PAID", paymentReference: "BANK-991", paidBy: { id: s.fin2.user.id }, createdBy: { id: s.fin1.user.id } });

    const entries = await ctx.api("GET", "/finance/ledger/entries?limit=50", { token: s.fin1.token });
    expect(entries.status).toBe(200);
    const types = entries.body.items.map((e: { eventType: string }) => e.eventType).sort();
    expect(types).toEqual(["COD_COLLECTED", "COD_COLLECTED", "COD_HANDED_OVER", "INVOICE_ISSUED", "INVOICE_PAID", "MERCHANT_SETTLEMENT_PAID"]);
    for (const e of entries.body.items) {
      const d = e.lines.reduce((a: number, l: { debit: number }) => a + l.debit, 0);
      const c = e.lines.reduce((a: number, l: { credit: number }) => a + l.credit, 0);
      expect(Math.round(d * 100)).toBe(Math.round(c * 100));
    }

    const tb = await ctx.api("GET", "/finance/ledger/trial-balance?nonZeroOnly=true", { token: s.fin2.token });
    expect(tb.body.balanced).toBe(true);
    const accounts = (await ctx.api("GET", "/finance/ledger/accounts", { token: s.fin1.token })).body;
    expect(balance(accounts, "1010")).toBe(0); // cash with riders
    expect(balance(accounts, "1020")).toBe(2350.5); // cash at hubs
    expect(balance(accounts, "2010")).toBe(0); // merchant payables settled
    expect(balance(accounts, "1100")).toBe(0); // invoice paid
    expect(balance(accounts, "1030")).toBeCloseTo(-(2350.5 - charges) + plain.charge, 2); // bank: paid out, received
    expect(balance(accounts, "2030")).toBeCloseTo(settlement.vat.onCharges + inv.body.vatAmount, 1);
    const revenue = balance(accounts, "4010") + balance(accounts, "4020") + balance(accounts, "2030");
    expect(revenue).toBeCloseTo(charges + plain.charge, 2);

    // Statements and positions.
    const stmt = await ctx.api("GET", `/finance/ledger/statement?account=CASH_AT_HUBS&hubId=${s.h1.id}`, { token: s.fin1.token });
    expect(stmt.body).toMatchObject({ openingBalance: 0, closingBalance: 2350.5 });
    const cash = await ctx.api("GET", "/finance/ledger/cash-positions", { token: s.fin1.token });
    expect(cash.body.hubs).toEqual([{ hub: expect.objectContaining({ id: s.h1.id }), cash: 2350.5 }]);
    const ms = await ctx.api("GET", `/finance/merchants/${s.m.id}/statement`, { token: s.owner.token });
    expect(ms.status).toBe(200);
    expect(ms.body.position).toEqual({ codHeldForMerchant: 0, owedByMerchant: 0, net: 0 });
    expect(ms.body.lines.length).toBeGreaterThanOrEqual(4);

    // Hub cash banked; can't bank more than the hub holds.
    const over = await ctx.api("POST", "/finance/ledger/deposits", { token: s.fin1.token, body: { hubId: s.h1.id, amount: 9999, reference: "DEP-1" } });
    expect(over.body.error.code).toBe("DEPOSIT_EXCEEDS_CASH");
    expect((await ctx.api("POST", "/finance/ledger/deposits", { token: s.fin1.token, body: { hubId: s.h1.id, amount: 2350.5, to: "BANK", reference: "DEP-1" } })).status).toBe(201);
    expect((await ctx.api("POST", "/finance/ledger/deposits", { token: s.fin1.token, body: { hubId: s.h1.id, amount: 1, reference: "DEP-1" } })).status).toBe(422);

    // Manual journals must balance.
    const bad = await ctx.api("POST", "/finance/ledger/journal", { token: s.fin1.token, body: { reference: "OPEN-1", memo: "Opening", lines: [{ account: "1030", debit: 100 }, { account: "3010", credit: 90 }] } });
    expect(bad.body.error.code).toBe("LEDGER_UNBALANCED");
    expect((await ctx.api("POST", "/finance/ledger/journal", { token: s.fin1.token, body: { reference: "OPEN-1", memo: "Opening", lines: [{ account: "1030", debit: 100 }, { account: "3010", credit: 100 }] } })).status).toBe(201);
    expect((await ctx.api("POST", "/finance/ledger/journal", { token: s.fin1.token, body: { reference: "OPEN-1", memo: "Again", lines: [{ account: "1030", debit: 1 }, { account: "3010", credit: 1 }] } })).body.error.code).toBe("DUPLICATE_REFERENCE");

    // Posting the same business event twice records it once.
    const ledger = ctx.app.get(LedgerService);
    await ledger.record(ctx.prisma, { type: "REFUND_PAID", amount: 10, reference: "TEST-REF" });
    await ledger.record(ctx.prisma, { type: "REFUND_PAID", amount: 10, reference: "TEST-REF" });
    expect(await ctx.prisma.journalEntry.count({ where: { reference: "TEST-REF" } })).toBe(1);

    // Rider payouts (rider module contract): expense against the channel named in the memo.
    await ledger.record(ctx.prisma, { type: "RIDER_PAYOUT_PAID", amount: 600, reference: "RPO-TEST-1", riderId: s.rider.rider.id, hubId: s.h1.id, memo: "BKASH 8XK2" });
    const payout = await ctx.prisma.journalEntry.findFirstOrThrow({ where: { reference: "RPO-TEST-1" }, include: { lines: { include: { account: true } } } });
    expect(payout.lines.map(l => [l.account.code, Number(l.debit), Number(l.credit)]).sort()).toEqual([
      ["1040", 0, 600],
      ["5010", 600, 0],
    ]);

    // Access: merchants never see the company ledger.
    expect((await ctx.api("GET", "/finance/ledger/trial-balance", { token: s.owner.token })).status).toBe(403);
    // Operations managers work COD & settlement › Invoices & accounts; hub staff don't.
    expect((await ctx.api("GET", "/finance/ledger/accounts", { token: s.ops.token })).status).toBe(200);
    const hubStaff = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: (await hub(ctx, "HUB-L")).id }], "Hub Staff");
    expect((await ctx.api("GET", "/finance/ledger/accounts", { token: hubStaff.token })).status).toBe(403);
    const other = await merchant("Other");
    expect((await ctx.api("GET", `/finance/merchants/${other.id}/statement`, { token: s.owner.token })).status).toBe(404);
  });

  it("closes finished periods only, once, and moves late postings to the next open period", async () => {
    const s = await setup();
    const now = new Date(Date.now() + 6 * 3600_000);
    const current = now.toISOString().slice(0, 7);
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)).toISOString().slice(0, 7);
    expect((await ctx.api("POST", `/finance/ledger/periods/${current}/close`, { token: s.fin1.token, body: {} })).body.error.code).toBe("PERIOD_NOT_ENDED");
    const closed = await ctx.api("POST", `/finance/ledger/periods/${prev}/close`, { token: s.fin1.token, body: { note: "Month end" } });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect((await ctx.api("POST", `/finance/ledger/periods/${prev}/close`, { token: s.fin1.token, body: {} })).body.error.code).toBe("PERIOD_CLOSED");
    expect((await ctx.api("POST", `/finance/ledger/periods/${prev}/close`, { token: s.owner.token, body: {} })).status).toBe(403);

    // A posting dated in the closed month lands in the current one.
    await ctx.app.get(LedgerService).record(ctx.prisma, { type: "CLAIM_PAID", amount: 50, reference: "LATE-1", occurredAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)) });
    const entry = await ctx.prisma.journalEntry.findFirstOrThrow({ where: { reference: "LATE-1" } });
    expect(entry.period).toBe(current);
    expect((await ctx.api("GET", "/finance/ledger/periods", { token: s.fin2.token })).body.closed.map((p: { period: string }) => p.period)).toEqual([prev]);
  });

  it("never pays a negative net payable: carries the shortfall to the next settlement", async () => {
    const s = await setup();
    const [small] = await cashAtHub(s, [10]);
    expect(small.charge).toBeGreaterThan(10);
    const first = await settleAndPay(s, {});
    expect(first).toMatchObject({ status: "PAID", netPayable: 0, carriedForward: Number((small.charge - 10).toFixed(2)) });
    expect(first.reference).toBe(`NO-PAYOUT-${first.number}`);
    expect(await ctx.prisma.outboxMessage.count({ where: { template: "finance.settlement_paid" } })).toBe(0);

    const statement = await ctx.api("GET", `/finance/merchants/${s.m.id}/statement`, { token: s.owner.token });
    expect(statement.body.openAdjustments).toEqual([expect.objectContaining({ kind: "CARRY_FORWARD", amount: first.carriedForward, reference: first.number })]);
    expect(statement.body.position.owedByMerchant).toBe(first.carriedForward);
    expect((await ctx.api("GET", "/finance/summary", { token: s.fin1.token })).body.merchantReceivablesOpen).toBe(first.carriedForward);

    const [big] = await cashAtHub(s, [2000]);
    const draft = await ctx.api("POST", "/settlements", { token: s.fin1.token, body: { merchantId: s.m.id } });
    expect(draft.body).toMatchObject({ adjustmentsTotal: first.carriedForward, netPayable: Number((2000 - big.charge - first.carriedForward).toFixed(2)), carriedForward: 0 });
    expect(draft.body.adjustments).toEqual([expect.objectContaining({ kind: "CARRY_FORWARD" })]);

    // Discarding the draft releases the adjustment again.
    await ctx.api("DELETE", `/settlements/${draft.body.id}`, { token: s.fin1.token });
    expect(await ctx.prisma.merchantAdjustment.count({ where: { settlementId: null } })).toBe(1);
    const redo = await settleAndPay(s, { reference: "BANK-REDO-1" });
    expect(redo.netPayable).toBe(Number((2000 - big.charge - first.carriedForward).toFixed(2)));
    expect((await ctx.api("GET", `/finance/merchants/${s.m.id}/statement`, { token: s.owner.token })).body.position).toEqual({ codHeldForMerchant: 0, owedByMerchant: 0, net: 0 });
    expect((await ctx.api("GET", "/finance/ledger/trial-balance", { token: s.fin1.token })).body.balanced).toBe(true);
  });

  it("drafts settlements automatically on the merchant's schedule; approval stays manual", async () => {
    const s = await setup();
    expect((await ctx.api("PUT", `/finance/settlement-schedules/${s.m.id}`, { token: s.fin1.token, body: { cycle: "WEEKLY" } })).status).toBe(422);
    expect((await ctx.api("PUT", `/finance/settlement-schedules/${s.m.id}`, { token: s.owner.token, body: { cycle: "DAILY" } })).status).toBe(403);
    const set = await ctx.api("PUT", `/finance/settlement-schedules/${s.m.id}`, { token: s.fin1.token, body: { cycle: "DAILY", minimumAmount: 100 } });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body).toMatchObject({ cycle: "DAILY", minimumAmount: 100 });
    expect(new Date(set.body.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    expect((await ctx.api("GET", `/finance/settlement-schedules/${s.m.id}`, { token: s.owner.token })).body.cycle).toBe("DAILY");

    // Nothing due yet.
    expect((await ctx.api("POST", "/finance/settlement-schedules/run", { token: s.fin1.token, body: {} })).body).toEqual([]);
    const due = async () => ctx.prisma.settlementSchedule.update({ where: { merchantId: s.m.id }, data: { nextRunAt: new Date(Date.now() - 60_000) } });

    await due();
    let run = await ctx.api("POST", "/finance/settlement-schedules/run", { token: s.fin1.token, body: {} });
    expect(run.body).toEqual([expect.objectContaining({ merchantId: s.m.id, result: expect.stringMatching(/^Skipped/) })]);

    await cashAtHub(s, [1500]);
    await due();
    run = await ctx.api("POST", "/finance/settlement-schedules/run", { token: s.fin1.token, body: {} });
    expect(run.body[0].result).toMatch(/^Drafted ST-/);
    const auto = await ctx.api("GET", `/settlements/${run.body[0].settlementId}`, { token: s.fin1.token });
    expect(auto.body).toMatchObject({ status: "DRAFT", autoDrafted: true, createdBy: null });
    const sched = await ctx.prisma.settlementSchedule.findUniqueOrThrow({ where: { merchantId: s.m.id } });
    expect(sched.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    expect(sched.lastResult).toMatch(/^Drafted/);

    // While the automatic draft waits for approval, the next run skips the merchant.
    await due();
    run = await ctx.api("POST", "/finance/settlement-schedules/run", { token: s.fin1.token, body: {} });
    expect(run.body[0].result).toMatch(/waiting for approval/);
    // Any finance user may approve a system-drafted settlement.
    expect((await ctx.api("POST", `/settlements/${auto.body.id}/approve`, { token: s.fin1.token })).status).toBe(200);
    const list = await ctx.api("GET", "/finance/settlement-schedules", { token: s.fin2.token });
    expect(list.body).toEqual([expect.objectContaining({ merchant: expect.objectContaining({ id: s.m.id }), cycle: "DAILY" })]);
  });

  it("reconciles a bank statement: auto-match, duplicates, manual match, ignore and exceptions", async () => {
    const s = await setup();
    await cashAtHub(s, [1500]);
    const settlement = await settleAndPay(s, { reference: "BKASH-TX-77" });
    const start = hourAgo();
    await deliver(s, 0);
    const inv = (await ctx.api("POST", "/invoices", { token: s.fin1.token, body: { merchantId: s.m.id, periodStart: start, periodEnd: new Date().toISOString() } })).body;
    const today = new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10).split("-").reverse().join("/");
    const csv = [
      "Statement of account,,,,",
      "Txn Date,Particulars,Ref No,Withdrawal,Deposit",
      `${today},"Payout ${settlement.merchant.name}",BKASH-TX-77,"${settlement.netPayable.toLocaleString("en-US", { minimumFractionDigits: 2 })}",`,
      `${today},Customer payment ${inv.number},NPSB-5521,,${inv.total.toFixed(2)}`,
      `${today},Bank charge,,25.00,`,
      `${today},Mystery deposit,,,1000`,
      "Closing balance,,,,",
    ].join("\r\n");
    const upload = await ctx.api("POST", "/finance/reconciliation/statements", { token: s.fin1.token, body: { source: "BANK", accountLabel: "City Bank 1234", filename: "oct.csv", content: csv } });
    expect(upload.status, JSON.stringify(upload.body)).toBe(201);
    expect(upload.body).toMatchObject({ lineCount: 4, duplicates: 0, autoMatched: 2 });
    const byDesc = (d: string) => upload.body.lines.find((l: { description: string }) => l.description.startsWith(d));
    expect(byDesc("Payout")).toMatchObject({ status: "MATCHED", matchMethod: "AUTO", amount: -settlement.netPayable, match: { kind: "settlement", number: settlement.number } });
    expect(byDesc("Customer payment")).toMatchObject({ status: "MATCHED", match: { kind: "invoice", number: inv.number } });
    // The invoice was marked paid from the bank line.
    expect((await ctx.api("GET", `/invoices/${inv.id}`, { token: s.fin1.token })).body).toMatchObject({ status: "PAID", paymentReference: "NPSB-5521" });

    const again = await ctx.api("POST", "/finance/reconciliation/statements", { token: s.fin1.token, body: { source: "BANK", accountLabel: "City Bank 1234", filename: "oct-again.csv", content: csv } });
    expect(again.body).toMatchObject({ lineCount: 0, duplicates: 4 });

    const fee = byDesc("Bank charge");
    expect((await ctx.api("POST", `/finance/reconciliation/lines/${fee.id}/ignore`, { token: s.fin1.token, body: { note: "Monthly bank fee" } })).body.status).toBe("IGNORED");
    const mystery = byDesc("Mystery");
    const wrongDir = await ctx.api("POST", `/finance/reconciliation/lines/${mystery.id}/match`, { token: s.fin1.token, body: { settlementId: settlement.id } });
    expect(wrongDir.body.error.code).toBe("DIRECTION_MISMATCH");

    const ex = await ctx.api("GET", "/finance/reconciliation/exceptions", { token: s.fin2.token });
    expect(ex.body.unmatchedLines.map((l: { id: string }) => l.id)).toEqual([mystery.id]);

    // Unmatch and re-match by hand (the settlement is free again).
    const payoutLine = byDesc("Payout");
    expect((await ctx.api("POST", `/finance/reconciliation/lines/${payoutLine.id}/unmatch`, { token: s.fin1.token })).body.status).toBe("UNMATCHED");
    const manual = await ctx.api("POST", `/finance/reconciliation/lines/${payoutLine.id}/match`, { token: s.fin1.token, body: { settlementId: settlement.id } });
    expect(manual.body).toMatchObject({ status: "MATCHED", matchMethod: "MANUAL" });
    expect((await ctx.api("POST", `/finance/reconciliation/lines/${mystery.id}/match`, { token: s.fin1.token, body: { invoiceId: inv.id } })).body.error.code).toBe("AMOUNT_MISMATCH");

    expect((await ctx.api("GET", "/finance/reconciliation/statements", { token: s.fin1.token })).body[1]).toMatchObject({ matched: 2, unmatched: 1, ignored: 1 });
    expect((await ctx.api("GET", "/finance/reconciliation/statements", { token: s.owner.token })).status).toBe(403);
    expect(await ctx.prisma.auditLog.count({ where: { action: { startsWith: "reconciliation." } } })).toBeGreaterThanOrEqual(6);
  });

  it("handles claims, refunds and weight discrepancies end to end", async () => {
    const s = await setup();
    const damaged = await deliver(s, 0, { declaredValue: 2000 });
    const heavy = await deliver(s, 0);

    const claim = await ctx.api("POST", "/disputes", {
      token: s.owner.token,
      body: { trackingId: damaged.trackingId, kind: "Damaged", description: "Box arrived crushed, contents broken", claimedAmount: 500, evidence: [{ filename: "photo.png", dataUrl: PNG }] },
    });
    expect(claim.status, JSON.stringify(claim.body)).toBe(201);
    expect(claim.body).toMatchObject({ number: expect.stringMatching(/^DSP-\d{6}-\d{4}$/), status: "OPEN", kind: "DAMAGED", claimedAmount: 500, merchant: { id: s.m.id } });
    expect(claim.body.evidence).toHaveLength(1);
    const fileUrl = claim.body.evidence[0].url.replace("/api/v1", "");
    expect((await ctx.api("GET", fileUrl, { token: s.owner.token })).status).toBe(200);
    expect((await ctx.api("GET", fileUrl, { token: s.fin1.token })).status).toBe(200);
    const stranger = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Stranger");
    expect((await ctx.api("GET", fileUrl, { token: stranger.token })).status).toBe(404);
    expect((await ctx.api("GET", `/disputes/${claim.body.number}`, { token: stranger.token })).status).toBe(404);
    expect((await ctx.api("POST", "/disputes", { token: s.owner.token, body: { trackingId: damaged.trackingId, kind: "DAMAGED", description: "Same problem again here", claimedAmount: 10 } })).body.error.code).toBe("DISPUTE_EXISTS");
    expect((await ctx.api("POST", "/disputes", { token: stranger.token, body: { trackingId: damaged.trackingId, kind: "DAMAGED", description: "Not my parcel at all", claimedAmount: 10 } })).body.error.code).toBe("UNKNOWN_PARCEL");

    expect((await ctx.api("POST", `/disputes/${claim.body.number}/review`, { token: s.owner.token })).status).toBe(403);
    expect((await ctx.api("POST", `/disputes/${claim.body.number}/review`, { token: s.agent.token })).body).toMatchObject({ status: "UNDER_REVIEW", reviewer: { id: s.agent.user.id } });
    await ctx.api("POST", `/disputes/${claim.body.number}/notes`, { token: s.agent.token, body: { body: "Photos look genuine", internal: true } });
    expect((await ctx.api("GET", `/disputes/${claim.body.number}`, { token: s.owner.token })).body.notes).toHaveLength(0);
    expect((await ctx.api("POST", `/disputes/${claim.body.number}/approve`, { token: s.agent.token, body: { approvedAmount: 400, resolution: "Partial" } })).status).toBe(403);
    expect((await ctx.api("POST", `/disputes/${claim.body.number}/approve`, { token: s.fin1.token, body: { approvedAmount: 5000, resolution: "Too much" } })).body.error.code).toBe("ABOVE_LIABILITY");
    const approved = await ctx.api("POST", `/disputes/${claim.body.number}/approve`, { token: s.fin1.token, body: { approvedAmount: 400, resolution: "Approved at depreciated value" } });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({ status: "APPROVED", approvedAmount: 400, payout: "MERCHANT_BALANCE", resolvedBy: { id: s.fin1.user.id } });
    expect(await ctx.prisma.journalEntry.count({ where: { eventType: "CLAIM_PAID", reference: claim.body.number } })).toBe(1);
    expect(await ctx.prisma.outboxMessage.count({ where: { template: "finance.dispute_update" } })).toBeGreaterThanOrEqual(2);

    // Weight discrepancy raised by operations after re-weighing: re-priced with the booking's rate card.
    const weight = await ctx.api("POST", "/disputes", { token: s.ops.token, body: { trackingId: heavy.trackingId, kind: "WEIGHT_DISCREPANCY", description: "Hub scale shows 6 kg, booked as 2 kg", actualWeightKg: 6 } });
    expect(weight.status, JSON.stringify(weight.body)).toBe(201);
    expect(weight.body.weight).toMatchObject({ bookedKg: 2, actualKg: 6, originalCharge: heavy.charge });
    expect(weight.body.weight.repricedCharge).toBeGreaterThan(heavy.charge);
    const diff = weight.body.weight.difference;
    expect((await ctx.api("POST", `/disputes/${weight.body.number}/approve`, { token: s.fin2.token, body: { resolution: "Confirmed on the hub scale" } })).body.status).toBe("APPROVED");

    const ms = await ctx.api("GET", `/finance/merchants/${s.m.id}/statement`, { token: s.owner.token });
    expect(ms.body.openAdjustments.map((a: { kind: string; amount: number }) => [a.kind, a.amount])).toEqual([
      ["CLAIM", -400],
      ["WEIGHT_ADJUSTMENT", diff],
    ]);

    // Both are applied in the next settlement (the claim credit makes a settlement possible on its own).
    const draft = await ctx.api("POST", "/settlements", { token: s.fin1.token, body: { merchantId: s.m.id } });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect(draft.body).toMatchObject({ codTotal: 0, adjustmentsTotal: Number((diff - 400).toFixed(2)), netPayable: Number((400 - diff).toFixed(2)) });

    // Rejection notifies too.
    const over = await ctx.api("POST", "/disputes", { token: s.owner.token, body: { trackingId: heavy.trackingId, kind: "OVERCHARGE", description: "We were charged the express rate", claimedAmount: 50 } });
    const rejected = await ctx.api("POST", `/disputes/${over.body.number}/reject`, { token: s.fin1.token, body: { resolution: "Booked as express" } });
    expect(rejected.body).toMatchObject({ status: "REJECTED", resolution: "Booked as express" });
    expect((await ctx.api("POST", `/disputes/${over.body.number}/notes`, { token: s.owner.token, body: { body: "Please reconsider" } })).body.error.code).toBe("DISPUTE_CLOSED");
    expect((await ctx.api("GET", "/disputes?status=approved", { token: s.fin1.token })).body.items).toHaveLength(2);
    expect((await ctx.api("GET", "/finance/ledger/trial-balance", { token: s.fin1.token })).body.balanced).toBe(true);
  });

  /** Books a parcel, puts it at the hub and runs a return (RTO) run to completion. */
  const returned = async (s: Setup) => {
    const booked = await ctx.api("POST", "/parcels", { token: s.owner.token, body: parcelBody({ codAmount: 700 }) });
    await ctx.prisma.parcel.update({ where: { trackingId: booked.body.trackingId }, data: { status: "AT_HUB", currentHubId: s.h1.id, pickedUpAt: new Date() } });
    const run = await ctx.api("POST", "/returns/runs", { token: s.ops.token, body: { merchantId: s.m.id, trackingIds: [booked.body.trackingId], hubId: s.h1.id, reason: "Recipient refused" } });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    expect((await ctx.api("POST", `/returns/runs/${run.body.id}/dispatch`, { token: s.ops.token, body: { riderId: s.rider.rider.id } })).status).toBe(200);
    const done = await ctx.api("POST", `/returns/runs/${run.body.id}/complete`, { token: s.ops.token, body: {} });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const parcel = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: booked.body.trackingId } });
    expect(parcel.status).toBe("RETURNED");
    return { trackingId: parcel.trackingId, charge: Number(parcel.returnCharge) };
  };

  it("bills return (RTO) charges once: on the invoice with VAT, or else in the next settlement", async () => {
    const s = await setup();
    const start = hourAgo();
    const rto = await returned(s);
    expect(rto.charge).toBeGreaterThan(0);
    const plain = await deliver(s, 0);

    const inv = await ctx.api("POST", "/invoices", { token: s.fin1.token, body: { merchantId: s.m.id, periodStart: start, periodEnd: new Date().toISOString() } });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    const vat = Math.round(((rto.charge * 15) / 115) * 100) / 100;
    expect(inv.body.lines).toEqual([
      expect.objectContaining({ trackingId: plain.trackingId, amount: plain.charge }),
      { trackingId: rto.trackingId, description: "Return (RTO) charge", amount: rto.charge, taxableValue: Number((rto.charge - vat).toFixed(2)), vat, kind: "RETURN" },
    ]);
    expect(inv.body.total).toBeCloseTo(plain.charge + rto.charge, 2);

    // Billed once: the settlement doesn't deduct it again, and a second invoice finds nothing.
    await cashAtHub(s, [1000]);
    const draft = await ctx.api("POST", "/settlements", { token: s.fin1.token, body: { merchantId: s.m.id } });
    expect(draft.body.adjustmentsTotal).toBe(0);
    await ctx.api("DELETE", `/settlements/${draft.body.id}`, { token: s.fin1.token });

    // Paying the invoice clears the receivable for both lines.
    await ctx.api("POST", `/invoices/${inv.body.id}/mark-paid`, { token: s.fin1.token, body: { reference: "BANK-RTO-1" } });
    let accounts = (await ctx.api("GET", "/finance/ledger/accounts", { token: s.fin1.token })).body;
    expect(balance(accounts, "1100")).toBe(0);
    expect((await ctx.api("GET", "/finance/ledger/trial-balance", { token: s.fin1.token })).body.balanced).toBe(true);

    // A return charge not invoiced yet is deducted from the next settlement instead.
    const rto2 = await returned(s);
    const draft2 = await ctx.api("POST", "/settlements", { token: s.fin1.token, body: { merchantId: s.m.id } });
    expect(draft2.body.adjustments).toEqual([expect.objectContaining({ kind: "RETURN_CHARGE", amount: rto2.charge, reference: `${rto2.trackingId}:return` })]);
    expect(draft2.body.adjustmentsTotal).toBe(rto2.charge);
    await ctx.api("POST", `/settlements/${draft2.body.id}/approve`, { token: s.fin2.token });
    await ctx.api("POST", `/settlements/${draft2.body.id}/pay`, { token: s.fin1.token, body: { reference: "BANK-RTO-2" } });
    accounts = (await ctx.api("GET", "/finance/ledger/accounts", { token: s.fin1.token })).body;
    expect(balance(accounts, "1100")).toBe(0);
    expect(balance(accounts, "2010")).toBe(0);
    expect(await ctx.prisma.merchantAdjustment.count({ where: { kind: "RETURN_CHARGE", settlementId: null, invoiceId: null } })).toBe(0);
    expect(await ctx.prisma.merchantAdjustment.count({ where: { kind: "RETURN_CHARGE" } })).toBe(2);
  });

  it("returns a voided invoice's return charges to the open pool", async () => {
    const s = await setup();
    const start = hourAgo();
    const rto = await returned(s);
    const inv = await ctx.api("POST", "/invoices", { token: s.fin1.token, body: { merchantId: s.m.id, periodStart: start, periodEnd: new Date().toISOString() } });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    expect(inv.body.lines).toHaveLength(1);
    await ctx.api("POST", `/invoices/${inv.body.id}/void`, { token: s.fin1.token, body: { reason: "Re-bill in settlement" } });
    const accounts = (await ctx.api("GET", "/finance/ledger/accounts", { token: s.fin1.token })).body;
    expect(balance(accounts, "1100")).toBe(rto.charge); // still owed by the merchant
    await cashAtHub(s, [1000]);
    const draft = await ctx.api("POST", "/settlements", { token: s.fin1.token, body: { merchantId: s.m.id } });
    expect(draft.body.adjustmentsTotal).toBe(rto.charge);
  });

  it("issues VAT invoices with the configured rate and seller BIN", async () => {
    const s = await setup();
    expect((await ctx.api("GET", "/finance/config", { token: s.fin1.token })).body).toMatchObject({ vatRate: 15, invoiceTermDays: 15 });
    expect((await ctx.api("PUT", "/finance/config", { token: s.fin1.token, body: { seller: { bin: "12345" } } })).status).toBe(422);
    expect((await ctx.api("PUT", "/finance/config", { token: s.owner.token, body: { vatRate: 5 } })).status).toBe(403);
    const cfg = await ctx.api("PUT", "/finance/config", { token: s.fin1.token, body: { vatRate: 7.5, seller: { bin: "000123456-0101", address: "Gulshan, Dhaka" } } });
    expect(cfg.body).toMatchObject({ vatRate: 7.5, seller: { name: "Delivery Fast Ltd.", bin: "000123456-0101", address: "Gulshan, Dhaka" } });

    const start = hourAgo();
    const p = await deliver(s, 0);
    const inv = await ctx.api("POST", "/invoices", { token: s.fin1.token, body: { merchantId: s.m.id, periodStart: start, periodEnd: new Date().toISOString() } });
    const vat = Math.round(((p.charge * 7.5) / 107.5) * 100) / 100;
    expect(inv.body).toMatchObject({ vatRate: 7.5, vatAmount: vat, total: p.charge, taxableValue: Number((p.charge - vat).toFixed(2)), seller: { bin: "000123456-0101" }, buyer: { name: "Ledger Shop" } });
    expect(inv.body.lines[0]).toMatchObject({ amount: p.charge, vat, taxableValue: Number((p.charge - vat).toFixed(2)) });
    expect(await ctx.prisma.outboxMessage.count({ where: { template: "finance.invoice_issued" } })).toBe(1);

    // Voiding reverses it in the ledger.
    await ctx.api("POST", `/invoices/${inv.body.id}/void`, { token: s.fin1.token, body: { reason: "Wrong period" } });
    const accounts = (await ctx.api("GET", "/finance/ledger/accounts", { token: s.fin1.token })).body;
    expect(balance(accounts, "1100")).toBe(0);
    expect(balance(accounts, "2030")).toBe(0);
  });

  it("enforces ledger integrity in the database: append-only, balanced, one side per line", async () => {
    const ledger = ctx.app.get(LedgerService);
    await ledger.record(ctx.prisma, { type: "CLAIM_PAID", amount: 75, reference: "INTEGRITY-1" });
    const entry = await ctx.prisma.journalEntry.findFirstOrThrow({ where: { reference: "INTEGRITY-1" }, include: { lines: true } });
    expect(entry.lines).toHaveLength(2);

    // Posted rows can't be changed or removed, not even by raw SQL.
    await expect(ctx.prisma.$executeRaw`UPDATE journal_entries SET memo = 'edited' WHERE id = ${entry.id}::uuid`).rejects.toThrow(/immutable/);
    await expect(ctx.prisma.$executeRaw`UPDATE journal_lines SET debit = 1 WHERE id = ${entry.lines[0].id}::uuid`).rejects.toThrow(/immutable/);
    await expect(ctx.prisma.$executeRaw`DELETE FROM journal_lines WHERE id = ${entry.lines[0].id}::uuid`).rejects.toThrow(/immutable/);
    await expect(ctx.prisma.$executeRaw`DELETE FROM journal_entries WHERE id = ${entry.id}::uuid`).rejects.toThrow(/immutable/);
    expect(await ctx.prisma.journalLine.count({ where: { entryId: entry.id } })).toBe(2);

    // An entry whose lines don't balance is refused when the transaction commits.
    const accounts = await ledger.accountIds();
    const unbalanced = ctx.prisma.$transaction(async tx => {
      const e = await tx.journalEntry.create({ data: { number: "JE-TEST-UNBAL", eventType: "MANUAL", reference: "UNBAL-1", period: entry.period, occurredAt: new Date() } });
      await tx.journalLine.create({ data: { entryId: e.id, accountId: accounts.get("BANK")!, debit: 100, credit: 0 } });
      await tx.journalLine.create({ data: { entryId: e.id, accountId: accounts.get("OWNER_EQUITY")!, debit: 0, credit: 90 } });
    });
    await expect(unbalanced).rejects.toThrow(/not balanced/);
    expect(await ctx.prisma.journalEntry.count({ where: { reference: "UNBAL-1" } })).toBe(0);

    // A line is either a debit or a credit.
    const twoSided = ctx.prisma.$transaction(async tx => {
      const e = await tx.journalEntry.create({ data: { number: "JE-TEST-2SIDE", eventType: "MANUAL", reference: "TWOSIDE-1", period: entry.period, occurredAt: new Date() } });
      await tx.journalLine.create({ data: { entryId: e.id, accountId: accounts.get("BANK")!, debit: 10, credit: 10 } });
    });
    await expect(twoSided).rejects.toThrow(/journal_lines_one_side/);
  });
});
