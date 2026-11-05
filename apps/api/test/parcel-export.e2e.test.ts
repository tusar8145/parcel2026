import { readXlsx } from "../src/modules/imports/xlsx/xlsx-reader";
import { hub, parcelBody, resetDatabase, riderUser, startApp, userWithRoles, type TestContext } from "./helpers";

/** Courier Operations › All parcels: numbered pages, the date field, Excel export and the status date. */
describe("all parcels", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  const merchant = (code: string, type: "ECOMMERCE" | "BANKING_FINANCIAL", name: string) =>
    ctx.prisma.merchant.create({ data: { code, type, name, status: "ACTIVE", contactName: "Owner", contactPhone: "+8801911000000", pickupAddress: "House 5 Road 2", pickupArea: "Gulshan", pickupDistrict: "Dhaka North" } });

  const setup = async () => {
    const h = await hub(ctx, "HUB-EXP");
    const shop = await merchant("MR-5001", "ECOMMERCE", "Export Shop");
    const bank = await merchant("MR-5002", "BANKING_FINANCIAL", "Export Bank");
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops Manager");
    const rider = await riderUser(ctx, "R-5048", h.id);
    return { h, shop, bank, ops, rider };
  };
  type Setup = Awaited<ReturnType<typeof setup>>;

  const book = async (s: Setup, merchantId: string, extra: Record<string, unknown> = {}) => {
    const res = await ctx.api("POST", "/ops/parcels", { token: s.ops.token, body: { merchantId, ...parcelBody(), sender: undefined, pickup: undefined, ...extra } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.trackingId as string;
  };

  /** The export as header → value rows. */
  const exported = async (token: string, query: string) => {
    const res = await ctx.app.inject({ method: "GET", url: `/api/v1/parcels/export?${query}`, headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    const [header, ...rows] = readXlsx(res.rawPayload, { maxRows: 1000, prefer: ["Parcels"] }).rows;
    return { header, rows: rows.map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""]))), headers: res.headers };
  };

  it("pages by number with the total, and keeps cursor paging for everyone else", async () => {
    const s = await setup();
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await book(s, s.shop.id));
    const first = await ctx.api("GET", "/parcels?page=1&limit=2", { token: s.ops.token });
    expect(first.body).toMatchObject({ total: 5, page: 1, pages: 3 });
    expect(first.body.items.map((p: { trackingId: string }) => p.trackingId)).toEqual([ids[4], ids[3]]);
    const last = await ctx.api("GET", "/parcels?page=3&limit=2", { token: s.ops.token });
    expect(last.body.items.map((p: { trackingId: string }) => p.trackingId)).toEqual([ids[0]]);

    const cursor = await ctx.api("GET", "/parcels?limit=2", { token: s.ops.token });
    expect(cursor.body.total).toBeUndefined();
    expect(cursor.body.nextCursor).toBeTruthy();
    expect((await ctx.api("GET", `/parcels?limit=2&cursor=${cursor.body.nextCursor}`, { token: s.ops.token })).body.items.map((p: { trackingId: string }) => p.trackingId)).toEqual([ids[2], ids[1]]);
  });

  it("filters by booking date or by the latest status change, which notes and edits don't move", async () => {
    const s = await setup();
    const id = await book(s, s.shop.id);
    const other = await book(s, s.shop.id);
    const booked = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: id } });
    expect(booked.statusChangedAt.getTime()).toBeGreaterThanOrEqual(booked.createdAt.getTime() - 1000);

    const old = new Date("2026-01-15T06:00:00Z");
    await ctx.prisma.parcel.update({ where: { trackingId: id }, data: { createdAt: old, statusChangedAt: old } });
    await ctx.prisma.parcel.update({ where: { trackingId: other }, data: { createdAt: old } });
    expect((await ctx.api("POST", `/parcels/${id}/assign-pickup`, { token: s.ops.token, body: { riderId: s.rider.rider.id } })).status).toBe(200);
    const moved = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: id } });
    expect(moved.statusChangedAt.getTime()).toBeGreaterThan(old.getTime());

    expect((await ctx.api("POST", `/parcels/${id}/notes`, { token: s.ops.token, body: { note: "Called the merchant" } })).status).toBe(201);
    expect((await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: id } })).statusChangedAt).toEqual(moved.statusChangedAt);

    const range = "from=2026-01-01T00:00:00Z&to=2026-01-31T23:59:59Z";
    const ids = async (extra: string) => (await ctx.api("GET", `/parcels?${range}${extra}`, { token: s.ops.token })).body.items.map((p: { trackingId: string }) => p.trackingId).sort();
    expect(await ids("")).toEqual([id, other].sort());
    expect(await ids("&dateField=created")).toEqual([id, other].sort());
    expect(await ids("&dateField=status")).toEqual([]);
    const now = new Date();
    const today = `from=${new Date(now.getTime() - 3600_000).toISOString()}&to=${new Date(now.getTime() + 3600_000).toISOString()}`;
    expect((await ctx.api("GET", `/parcels?${today}&dateField=status`, { token: s.ops.token })).body.items.map((p: { trackingId: string }) => p.trackingId).sort()).toEqual([id, other].sort());
    // The Excel file follows the same date field.
    expect((await exported(s.ops.token, `${range}&dateField=status`)).rows).toHaveLength(0);
    expect((await exported(s.ops.token, `${range}&dateField=created`)).rows).toHaveLength(2);
  });

  it("exports every filtered parcel with the core columns, and only staff may export", async () => {
    const s = await setup();
    const a = await book(s, s.shop.id, { merchantOrderRef: "ORD-77" });
    const b = await book(s, s.bank.id, { codAmount: 0 });
    for (let i = 0; i < 3; i++) await book(s, s.shop.id);

    const file = await exported(s.ops.token, "");
    expect(file.rows).toHaveLength(5);
    expect(file.headers["x-row-count"]).toBe("5");
    expect(file.headers["x-matched"]).toBe("5");
    expect(file.header).toEqual(expect.arrayContaining(["Date (first status)", "Tracking ID", "Reference no", "Status", "Status update date", "Recipient phone"]));
    expect(file.header).not.toContain("COD (BDT)");
    expect(file.header).not.toContain("Delivery date");
    expect(file.header).not.toContain("Return date");
    const row = file.rows.find(r => r["Tracking ID"] === a)!;
    expect(row).toMatchObject({ "Reference no": "ORD-77", "Recipient phone": "+8801812000000", Merchant: "Export Shop", "Parcel type": "E-commerce" });
    expect(row["Date (first status)"]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

    const ticked = await exported(s.ops.token, `trackingIds=${a},${b}`);
    expect(ticked.rows.map(r => r["Tracking ID"]).sort()).toEqual([a, b].sort());

    const log = await ctx.prisma.auditLog.findFirst({ where: { action: "parcel.export" }, orderBy: { createdAt: "desc" } });
    expect(log).toMatchObject({ data: { rows: 2, ticked: 2 } });

    const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Customer");
    expect((await ctx.api("GET", "/parcels/export", { token: customer.token })).status).toBe(403);
  });

  it("adds COD for E-commerce only, delivery columns for Delivered and return columns for Returned", async () => {
    const s = await setup();
    const delivered = await book(s, s.shop.id);
    const returned = await book(s, s.shop.id);
    const scheduled = await book(s, s.shop.id);
    const bankParcel = await book(s, s.bank.id, { codAmount: 0 });
    const at = new Date("2026-10-20T08:30:00Z"); // 14:30 in Dhaka
    const p = await ctx.prisma.parcel.update({ where: { trackingId: delivered }, data: { status: "DELIVERED", deliveredAt: at, statusChangedAt: at, receiverRelation: "Family member", attemptCount: 2, partialDelivery: true, codCollectedAmount: 900 } });
    await ctx.prisma.deliveryProof.create({ data: { parcelId: p.id, method: "OTP", receivedBy: "Salma Ahmed" } });
    await ctx.prisma.parcel.update({ where: { trackingId: returned }, data: { status: "RETURNED", statusChangedAt: at, returnRequestedAt: new Date("2026-10-18T08:30:00Z"), returnReason: "Refused", returnCharge: 60 } });
    await ctx.prisma.parcel.update({ where: { trackingId: scheduled }, data: { status: "RETURN_SCHEDULED", returnReason: "Wrong address" } });
    await ctx.prisma.parcel.update({ where: { trackingId: bankParcel }, data: { status: "DELIVERED", deliveredAt: at } });

    // An E-commerce merchant chosen in the filter, Delivered.
    const ecom = await exported(s.ops.token, `status=Delivered&merchantId=${s.shop.id}`);
    expect(ecom.rows).toHaveLength(1);
    expect(ecom.rows[0]).toMatchObject({
      "Tracking ID": delivered,
      "Delivery date": "2026-10-20 14:30",
      "Received by": "Salma Ahmed",
      Relation: "Family member",
      "Delivery attempts": "2",
      "Partial delivery": "Yes",
      "COD (BDT)": "1500",
      "COD collected (BDT)": "900",
    });
    expect(ecom.headers["content-disposition"]).toContain("parcels-delivered-export-shop-");

    // The E-commerce tab, no merchant chosen.
    expect((await exported(s.ops.token, "line=ECOMMERCE")).header).toContain("COD (BDT)");
    // Banking merchant: delivery columns, no COD.
    const bank = await exported(s.ops.token, `status=DELIVERED&merchantId=${s.bank.id}`);
    expect(bank.header).toContain("Delivery date");
    expect(bank.header).not.toContain("COD (BDT)");
    expect(bank.header).not.toContain("COD collected (BDT)");

    const back = await exported(s.ops.token, "status=Returned");
    expect(back.header).not.toContain("Delivery date");
    expect(back.rows[0]).toMatchObject({ "Tracking ID": returned, "Return date": "2026-10-20 14:30", "Return requested": "2026-10-18 14:30", "Return reason": "Refused", "Return charge (BDT)": "60" });
    // On its way back: the reason, but no return date yet.
    const going = await exported(s.ops.token, "status=Return scheduled");
    expect(going.rows[0]).toMatchObject({ "Tracking ID": scheduled, "Return date": "", "Return reason": "Wrong address" });
  });
});
