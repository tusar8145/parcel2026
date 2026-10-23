import { parcelBody, resetDatabase, startApp, userWithRoles, type TestContext } from "./helpers";

/**
 * Excel imports (operations and merchants): district / zone / area are picked from each row's address
 * when the file leaves them out, and a checked file's rows can be corrected in the preview (address,
 * district, zone, area) before submitting: each edit checks and prices the row again.
 */
describe("import places", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  const shop = () =>
    ctx.prisma.merchant.create({
      data: { code: "MR-PLACE", type: "ECOMMERCE", name: "Place Shop", status: "ACTIVE", kycStatus: "APPROVED", contactName: "Owner", contactPhone: "+8801711111111", pickupAddress: "House 5 Road 2", pickupArea: "Gulshan 1", pickupDistrict: "Dhaka North" },
    });
  const row = (n: number, extra: Record<string, string>) => ({ recipient_name: `Buyer ${n}`, recipient_phone: `0181200000${n}`, cod_amount: "500", ...extra });

  it("picks district / zone / area from the address, keeps valid places from the file, and lets the preview correct a row", async () => {
    const merchant = await shop();
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops");
    const checked = await ctx.api("POST", "/imports/validate", {
      token: ops.token,
      body: {
        kind: "ecommerce",
        merchantId: merchant.id,
        rows: [
          row(1, { address: "House 9, Road 7, Dhanmondi, Dhaka" }), // row 2: everything picked
          row(2, { address: "Flat 2, Road 4 Gulshan, Dhaka", district: "Dhaka North" }), // row 3: zone and area picked, district kept
          row(3, { address: "House 1, Banani", district: "Dhaka Central" }), // row 4: the address names another district's zone: the file's district wins
          row(4, { address: "House 5", district: "dhaka central", zone: "DHANMONDI" }), // row 5: given (any case): kept, nothing picked
        ],
      },
    });
    expect(checked.status, JSON.stringify(checked.body)).toBe(201);
    const items = checked.body.rows.items as { rowNumber: number; status: string; cells: Record<string, string>; autoFilled: string[]; missing: string[] }[];
    const at = (n: number) => items.find(r => r.rowNumber === n)!;
    expect(at(2)).toMatchObject({ status: "VALID", cells: { district: "Dhaka Central", zone: "Dhanmondi" }, autoFilled: ["district", "zone"] });
    expect(at(3)).toMatchObject({ status: "VALID", cells: { district: "Dhaka North", zone: "Gulshan", area: "Road 4 Gulshan" } });
    expect(at(3).autoFilled.sort()).toEqual(["area", "zone"]);
    expect(at(4)).toMatchObject({ status: "INCOMPLETE", cells: { district: "Dhaka Central" }, autoFilled: [] });
    expect(at(4).cells.zone).toBeUndefined();
    expect(at(5)).toMatchObject({ status: "VALID", cells: { district: "Dhaka Central", zone: "Dhanmondi" }, autoFilled: [] });
    expect(checked.body.counts).toMatchObject({ rows: 4, valid: 3, incomplete: 1, errors: 0 });
    const id = checked.body.id;

    // ── A new address in the preview: its places are picked again; the row is checked and priced again ──
    const edited = await ctx.api("PATCH", `/imports/${id}/rows/4`, { token: ops.token, body: { cells: { address: "House 1, Uttara, Dhaka" }, detect: true } });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.row).toMatchObject({ rowNumber: 4, status: "VALID", cells: { address: "House 1, Uttara, Dhaka", district: "Dhaka North", zone: "Uttara" }, autoFilled: ["district", "zone"] });
    expect(edited.body.row.charge).toBeGreaterThan(0);
    expect(edited.body.job.counts).toMatchObject({ valid: 4, incomplete: 0 });

    // ── A zone chosen from the dropdown: no longer marked as picked; an area cleared ──
    const chosen = await ctx.api("PATCH", `/imports/${id}/rows/3`, { token: ops.token, body: { cells: { zone: "Banani", area: null } } });
    expect(chosen.status, JSON.stringify(chosen.body)).toBe(200);
    expect(chosen.body.row.cells).toMatchObject({ district: "Dhaka North", zone: "Banani" });
    expect(chosen.body.row.cells.area).toBeUndefined();
    expect(chosen.body.row.autoFilled).toEqual([]);

    // ── A zone outside the district: the row shows the error until it is fixed ──
    const wrong = await ctx.api("PATCH", `/imports/${id}/rows/5`, { token: ops.token, body: { cells: { zone: "Gulshan" } } });
    expect(wrong.body.row.status).toBe("ERROR");
    expect(wrong.body.job.counts.errors).toBe(1);

    // Unknown columns and rows are refused.
    expect((await ctx.api("PATCH", `/imports/${id}/rows/5`, { token: ops.token, body: { cells: { merchant: "x" } } })).status).toBe(422);
    expect((await ctx.api("PATCH", `/imports/${id}/rows/99`, { token: ops.token, body: { cells: { zone: "Mirpur" } } })).status).toBe(404);

    // ── Submitted: the rows are booked as corrected, and can't be changed any more ──
    const fixed = await ctx.api("PATCH", `/imports/${id}/rows/5`, { token: ops.token, body: { cells: { zone: "Mirpur" } } });
    expect(fixed.body.row.status).toBe("VALID");
    const commit = await ctx.api("POST", `/imports/${id}/commit`, { token: ops.token });
    expect(commit.status, JSON.stringify(commit.body)).toBe(200);
    expect(commit.body.result.created).toBe(4);
    const uttara = await ctx.prisma.parcel.findFirstOrThrow({ where: { recipientName: "Buyer 3" } });
    expect(uttara).toMatchObject({ deliveryStreet: "House 1, Uttara, Dhaka", deliveryDistrict: "Dhaka North", deliveryZone: "Uttara" });
    expect((await ctx.api("PATCH", `/imports/${id}/rows/2`, { token: ops.token, body: { cells: { zone: "Mirpur" } } })).body.error.code).toBe("NOT_EDITABLE");
  });
});

describe("masked recipient phones", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  it("a phone printed masked (019***545) is kept as written, the order is created, and no SMS goes to it", async () => {
    const merchant = await ctx.prisma.merchant.create({
      data: { code: "MR-MASK", type: "ECOMMERCE", name: "Mask Shop", status: "ACTIVE", kycStatus: "APPROVED", contactName: "Owner", contactPhone: "+8801711111111", pickupAddress: "House 5 Road 2", pickupArea: "Gulshan 1", pickupDistrict: "Dhaka North" },
    });
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops");
    const checked = await ctx.api("POST", "/imports/validate", {
      token: ops.token,
      body: {
        kind: "ecommerce",
        merchantId: merchant.id,
        rows: [
          { recipient_name: "Sadia Akter", recipient_phone: "019***545", address: "House 125, Niketon, Block A, Gulshan, Dhaka", cod_amount: "500" },
          { recipient_name: "Too Short", recipient_phone: "01***5", address: "House 1, Gulshan, Dhaka" },
        ],
      },
    });
    expect(checked.status, JSON.stringify(checked.body)).toBe(201);
    const [masked, short] = checked.body.rows.items;
    expect(masked).toMatchObject({ status: "VALID", cells: { recipient_phone: "019***545" } });
    expect(short.status).toBe("ERROR");
    const commit = await ctx.api("POST", `/imports/${checked.body.id}/commit`, { token: ops.token });
    expect(commit.body.result.created).toBe(1);
    const parcel = await ctx.prisma.parcel.findFirstOrThrow({ where: { recipientName: "Sadia Akter" } });
    expect(parcel.recipientPhone).toBe("019***545");

    // Booked directly too (the recipient only: the sender needs a real number).
    const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Rahim Uddin");
    const booked = await ctx.api("POST", "/parcels", { token: customer.token, body: parcelBody({ recipient: { name: "Masked", phone: "+88019***545" } }) });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    expect(booked.body.recipient.phone).toBe("019***545");
    expect((await ctx.api("POST", "/parcels", { token: customer.token, body: parcelBody({ sender: { name: "S", phone: "019***545" } }) })).status).toBe(422);

    // Messages: none to a masked number (the sender's still go out).
    expect(await ctx.prisma.outboxMessage.count({ where: { to: { contains: "*" } } })).toBe(0);
  });
});
