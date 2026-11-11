import { parcelBody, resetDatabase, startApp, userWithRoles, type TestContext } from "./helpers";
import { fromClaude } from "../src/modules/parcel-scans/scan-claude";
import { packagePricesSchema, priceParcel, reattemptFeeFor } from "@delivery-fast/shared";

/**
 * A package's "Charges" switch (off: nothing charged or shown), the parcel details' product / delivery type /
 * priority / messages, the exports' columns, and Scan with phone naming an unnamed product (AI import on).
 */
describe("charges switch, parcel details, exports, scan product", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  let seq = 0;
  async function merchant() {
    const m = await ctx.prisma.merchant.create({
      data: {
        code: `MR-CH${++seq}`,
        type: "ECOMMERCE",
        name: `Charge Shop ${seq}`,
        status: "ACTIVE",
        kycStatus: "APPROVED",
        contactName: "Owner",
        contactPhone: "+8801711111111",
        pickupAddress: "House 5 Road 2",
        pickupArea: "Gulshan",
        pickupDistrict: "Dhaka North",
      },
    });
    const owner = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: m.id }], "Owner");
    return { m, owner };
  }
  const order = (overrides: Record<string, unknown> = {}) => ({ ...parcelBody({ serviceLevel: "Regular", contents: undefined, ...overrides }) });

  it("the formula: charges off is nothing to pay, no lines, no re-attempt fee", () => {
    const prices = packagePricesSchema.parse({ chargesOn: false, reattemptFee: 30, freeReattempts: 0 });
    const q = priceParcel(prices, { segment: "ECOMMERCE", services: [], tier: "SAME_DISTRICT", selection: { firstMile: "RIDER_PICKUP", lastMile: "DOORSTEP", speed: "EXPRESS", productType: "REGULAR", openBox: false, codAmount: 2000, weightKg: 3 } });
    expect(q).toMatchObject({ lines: [], deliveryCharge: 0, codFee: 0, totalCharge: 0 });
    expect(reattemptFeeFor(prices, 3)).toBe(0);
    // Old packages (no switch): charges on.
    expect(packagePricesSchema.parse({}).chargesOn).toBe(true);
  });

  it("a package with charges off: no quote price, parcels charged nothing and shown without charges; details, plan and export", async () => {
    const admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Admin");
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops");
    const { m, owner } = await merchant();
    const catalog = (await ctx.api("GET", "/service-catalog")).body as { services: { code: string; segments: string[] }[] };
    const services = catalog.services.filter(s => s.segments.includes("ECOMMERCE")).map(s => s.code);
    const created = await ctx.api("POST", "/packages", { token: admin.token, body: { segment: "ECOMMERCE", name: "Free Shop", services, prices: { chargesOn: false, sameDistrict: 60 } } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await ctx.api("PUT", `/merchants/${m.id}/package`, { token: admin.token, body: { packageId: created.body.id } })).status).toBe(200);

    const quote = await ctx.api("POST", "/packages/quote", { token: owner.token, body: { pickupDistrict: "Dhaka North", pickupZone: "Gulshan", deliveryDistrict: "Dhaka Central", deliveryZone: "Dhanmondi", weightKg: 1, codAmount: 1500 } });
    expect(quote.status, JSON.stringify(quote.body)).toBe(200);
    expect(quote.body).toMatchObject({ chargesOn: false, totalCharge: 0, deliveryCharge: 0, lines: [], returnCharge: 0 });

    const booked = await ctx.api("POST", "/parcels", { token: owner.token, body: order({ codAmount: 1500, product: "Honey" }) });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    const id = booked.body.trackingId as string;
    expect(await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: id } })).toMatchObject({ codFee: expect.anything() });
    expect(Number((await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: id } })).totalCharge)).toBe(0);

    // The merchant: no charges, its own product name only; the messages with their state.
    const mine = (await ctx.api("GET", `/parcels/${id}`, { token: owner.token })).body;
    expect(mine).toMatchObject({ chargesOff: true, product: "Honey", deliveryType: "Regular" });
    expect(mine.systemProduct).toBeUndefined();
    expect(mine.service.systemProduct).toBeUndefined();
    expect(mine.service.lines).toEqual([]);
    expect(mine.messagePlan.channels).toEqual({ sms: true, email: true, push: true });
    expect(mine.messagePlan.total).toBeGreaterThan(0);
    const booked1 = mine.messagePlan.items.find((i: { code: string }) => i.code === "notify.booked");
    expect(booked1).toBeTruthy();
    expect(mine.messagePlan.done).toBe(mine.messagePlan.items.filter((i: { done: boolean }) => i.done).length);
    // Operations see the system product.
    const staff = (await ctx.api("GET", `/parcels/${id}`, { token: ops.token })).body;
    expect(staff).toMatchObject({ chargesOff: true, systemProduct: "Honey" });

    // The plan page shows no prices.
    const plan = (await ctx.api("GET", "/merchants/me/plan", { token: owner.token })).body;
    expect(plan.chargesOn).toBe(false);
    expect(plan.services.flatMap((s: { items: { price?: string }[] }) => s.items).every((i: { price?: string }) => !i.price)).toBe(true);
  });

  it("exports have the delivery type, priority and product; the merchant's has no system product", async () => {
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops");
    const { owner } = await merchant();
    await ctx.api("GET", "/packages/effective?segment=ECOMMERCE", { token: ops.token });
    const booked = await ctx.api("POST", "/parcels", { token: owner.token, body: order({ product: "Honey", speed: "Express" }) });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    const header = async (url: string, token: string) => {
      const res = await ctx.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
      const XLSX = await import("../src/modules/imports/xlsx/xlsx-reader");
      const sheet = XLSX.readXlsx(res.rawPayload, { maxRows: 1000, prefer: ["Parcels", "Orders"] });
      return { head: sheet.rows[0].map(v => String(v ?? "")), row: sheet.rows[1].map(v => String(v ?? "")) };
    };
    const opsFile = await header("/api/v1/parcels/export?stage=new", ops.token);
    for (const h of ["Delivery type", "Priority", "Product", "System product"]) expect(opsFile.head).toContain(h);
    expect(opsFile.row[opsFile.head.indexOf("Delivery type")]).toBe("Express");
    expect(opsFile.row[opsFile.head.indexOf("Priority")]).toBeTruthy();
    const merchantFile = await header("/api/v1/merchants/me/parcels/export", owner.token);
    for (const h of ["Delivery type", "Priority", "Product"]) expect(merchantFile.head).toContain(h);
    expect(merchantFile.head).not.toContain("System product");
  });

  it("Scan with phone: with AI import on, an unnamed product is named from the photo", () => {
    const places = { districts: [], zonesByDistrict: {}, areasByZone: {} };
    const lists = { speeds: [], categories: [], priorities: [] };
    // AI import off: nothing guessed.
    expect(fromClaude({ product_type: "", product_seen: "Running shoes" } as never, "ecommerce", places, lists).product_type).toBeUndefined();
    // On: the item as the photo shows it, only when no product name is written.
    expect(fromClaude({ product_type: "", product_seen: "Running shoes" } as never, "ecommerce", places, { ...lists, guessProduct: true }).product_type).toBe("Running shoes");
    expect(fromClaude({ product_type: "Saree", product_seen: "Cloth" } as never, "ecommerce", places, { ...lists, guessProduct: true }).product_type).toBe("Saree");
    expect(fromClaude({ product_type: "", product_seen: "parcel" } as never, "ecommerce", places, { ...lists, guessProduct: true }).product_type).toBeUndefined();
  });
});
