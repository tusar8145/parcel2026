import { ImportAiService } from "../src/modules/imports/import-ai.service";
import { resetDatabase, startApp, userWithRoles, type TestContext } from "./helpers";

/**
 * AI import (owner spec 2026-11-11): with the AI on, product names and addresses the lists don't match go to the AI
 * (a stub here: no API key, no cost); new products, categories (channels from the super admin's prompt) and zones
 * are created at once; decisions are remembered; off or over the monthly USD limit nothing goes to the AI.
 */
describe("AI import", () => {
  let ctx: TestContext;
  let ai: ImportAiService;
  let calls: string[];
  beforeAll(async () => {
    ctx = await startApp();
    ai = ctx.app.get(ImportAiService);
  });
  beforeEach(async () => {
    await resetDatabase(ctx);
    calls = [];
    ai.callOverride = async (_system, user) => {
      calls.push(user);
      const n = (re: RegExp) => Number(re.exec(user)?.[1] ?? 0);
      const products = [];
      const p1 = n(/P(\d+): Tshirt men XL/);
      if (p1) products.push({ i: p1, existing: "T-Shirt", newProduct: "", sms: false, email: false, push: false });
      const p2 = n(/P(\d+): Drone propeller set/);
      if (p2) products.push({ i: p2, existing: "", newProduct: "Drone Parts", sms: false, email: true, push: true });
      const places = [];
      const a1 = n(/A(\d+): [^\n]*Kazipara/);
      if (a1) places.push({ i: a1, district: "Dhaka Central", zone: "Mirpur", newZone: false, nearZone: "" });
      const a2 = n(/A(\d+): [^\n]*Notunbazar Para/);
      if (a2) places.push({ i: a2, district: "Dhaka North", zone: "Notunbazar", newZone: true, nearZone: "Gulshan" });
      return { answer: { products, places }, model: "claude-haiku-5-5", tokens: { input: 1000, cacheRead: 5000, cacheWrite: 0, output: 400 } };
    };
  });
  afterAll(async () => {
    ai.callOverride = undefined;
    await ctx.app.close();
  });

  const shop = () =>
    ctx.prisma.merchant.create({
      data: { code: "MR-AI1", type: "ECOMMERCE", name: "AI Shop", status: "ACTIVE", kycStatus: "APPROVED", contactName: "Owner", contactPhone: "+8801711111171", pickupAddress: "House 5 Road 2", pickupArea: "Gulshan 1", pickupDistrict: "Dhaka North" },
    });
  const row = (n: number, extra: Record<string, string>) => ({ recipient_name: `Buyer ${n}`, recipient_phone: `0181200000${n}`, cod_amount: "500", ...extra });
  const validate = async (token: string, merchantId: string, rows: Record<string, string>[]) => {
    const res = await ctx.api("POST", "/imports/validate", { token, body: { kind: "ecommerce", merchantId, rows } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; rows: { items: { rowNumber: number; status: string; cells: Record<string, string> }[] } };
  };

  it("matches products itself first, creates new products (channels from the rule) and zones; remembers them; settings, limit and log", async () => {
    const admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Admin");
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops");
    const merchant = await shop();
    await ctx.api("GET", "/packages", { token: admin.token }); // set-up (catalog seeded)
    await ctx.prisma.parcelProduct.updateMany({ where: { segment: "ECOMMERCE", name: { contains: "T-Shirt" } }, data: { name: "T-Shirt" } }).catch(() => undefined);
    if (!(await ctx.prisma.parcelProduct.findFirst({ where: { segment: "ECOMMERCE", name: "T-Shirt" } }))) await ctx.prisma.parcelProduct.create({ data: { segment: "ECOMMERCE", name: "T-Shirt" } });
    const rows = [
      row(1, { address: "House 9, Kazipara, Dhaka", district: "Dhaka Central", product_type: "Tshirt men XL" }),
      row(2, { address: "House 2, Notunbazar Para, Dhaka", district: "Dhaka North", product_type: "Drone propeller set" }),
    ];

    // Off (the default): nothing goes to the AI.
    await validate(ops.token, merchant.id, rows);
    expect(calls).toHaveLength(0);

    // Staff can't change the settings; the super admin turns it on with a channel rule and a limit.
    expect((await ctx.api("PUT", "/imports/ai", { token: ops.token, body: { enabled: true } })).status).toBe(403);
    const saved = await ctx.api("PUT", "/imports/ai", { token: admin.token, body: { enabled: true, monthlyLimitUsd: 2, channelPrompt: "Gadgets: no SMS, email and push on." } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.settings).toMatchObject({ enabled: true, monthlyLimitUsd: 2 });

    const first = await validate(ops.token, merchant.id, rows);
    expect(calls).toHaveLength(1);
    const at = (n: number) => first.rows.items.find(r => r.rowNumber === n)!;
    expect(at(2).cells).toMatchObject({ product_type: "T-Shirt", district: "Dhaka Central", zone: "Mirpur" });
    expect(at(3).cells).toMatchObject({ product_type: "Drone Parts", district: "Dhaka North", zone: "Notunbazar" });
    expect(at(2).status).toBe("VALID");
    expect(at(3).status).toBe("VALID");
    // "Tshirt men XL" is the T-Shirt by the system's own matching: only the drone part went to the AI.
    expect(calls[0]).not.toContain("Tshirt");
    expect(calls[0]).toContain("Drone propeller set");
    // The file's own names are kept for the parcels (prints show them).
    const items = first.rows.items as unknown as { rowNumber: number; productLabel: string | null; aiFilled: string[]; cells: Record<string, string> }[];
    const item = (n: number) => items.find(r => r.rowNumber === n)!;
    expect([item(2).productLabel, item(3).productLabel]).toEqual(["Tshirt men XL", "Drone propeller set"]);
    // What the AI decided is tagged (the system's own match isn't); the markers aren't cells.
    expect(item(3).aiFilled).toEqual(expect.arrayContaining(["product_type", "district", "zone"]));
    expect(item(2).aiFilled).not.toContain("product_type");
    expect(Object.keys(item(3).cells).filter(k => k.startsWith("__"))).toEqual([]);
    // Created at once, tagged; its channels from the rule.
    expect(await ctx.prisma.parcelProduct.findFirstOrThrow({ where: { name: "Drone Parts" } })).toMatchObject({ aiCreated: true, segment: "ECOMMERCE", notifySms: false, notifyEmail: true, notifyPush: true });
    const catalog = (await ctx.api("GET", "/catalog")).body as { zonesByDistrict: Record<string, string[]> };
    expect(catalog.zonesByDistrict["Dhaka North"]).toContain("Notunbazar");

    // The same file again: remembered, no AI.
    const again = await validate(ops.token, merchant.id, rows.map(r => ({ ...r, address: r.address.replace("Kazipara", "Mirpur") })));
    expect(calls).toHaveLength(1);
    expect(again.rows.items.find(r => r.rowNumber === 2)!.cells.product_type).toBe("T-Shirt");

    // The log and this month's spend.
    const overview = (await ctx.api("GET", "/imports/ai", { token: admin.token })).body;
    expect(overview.thisMonth).toMatchObject({ imports: 1, calls: 1, productsCreated: 1, categoriesCreated: 0, zonesCreated: 1 });
    expect(overview.thisMonth.costUsd).toBeGreaterThan(0);
    expect(overview.created).toMatchObject({ products: 1, zones: expect.any(Number) });
    const log = (await ctx.api("GET", "/imports/ai/usage", { token: admin.token })).body;
    expect(log.items[0]).toMatchObject({ productsMatched: 0, productsCreated: 1, zonesCreated: 1, importNumber: expect.stringMatching(/^IMP-/), user: "Ops" });

    // A partial save keeps the other settings.
    expect((await ai.settings()).channelPrompt).toBe("Gadgets: no SMS, email and push on.");
    // Over the monthly limit: no AI, the file is still checked.
    await ctx.api("PUT", "/imports/ai", { token: admin.token, body: { monthlyLimitUsd: 0 } });
    const limited = await validate(ops.token, merchant.id, [row(5, { address: "House 3, Shahjadpur Lane", district: "Dhaka North", product_type: "Mystery item" })]);
    expect(calls).toHaveLength(1);
    expect(limited.rows.items[0].cells.product_type).toBe("Mystery item");

    // The template has no Category column while the AI is on, and never Delivery type / Priority (chosen in the window).
    await ctx.api("PUT", "/imports/ai", { token: admin.token, body: { monthlyLimitUsd: 5 } });
    const tpl = await ctx.app.inject({ method: "GET", url: `/api/v1/imports/templates/ecommerce?merchantId=${merchant.id}`, headers: { authorization: `Bearer ${ops.token}` } });
    expect(tpl.statusCode).toBe(200);
    const config = (await ctx.api("GET", "/imports/config", { token: ops.token })).body as { ai: boolean; templates: Record<string, { key: string; inTemplate: boolean }[]> };
    expect(config.ai).toBe(true);
    const inTemplate = (key: string) => config.templates.ecommerce.find(c => c.key === key)?.inTemplate;
    expect([inTemplate("service_level"), inTemplate("priority"), inTemplate("product_type")]).toEqual([false, false, true]);
    expect(config.templates.ecommerce.some(c => c.key === "category")).toBe(false);

    // No duplicates: the same thing under another name is the existing product (no AI, nothing created).
    const before = await ctx.prisma.parcelProduct.count();
    const dup = await validate(ops.token, merchant.id, [row(6, { address: "House 3, Kalabagan", district: "Dhaka Central", zone: "Dhanmondi", product_type: "T Shirts" })]);
    expect(dup.rows.items[0].cells.product_type).toBe("T-Shirt");
    expect(await ctx.prisma.parcelProduct.count()).toBe(before);
  });

  it("the window's second screen: delivery type, priority and messages for the whole file; the file's product name is kept", async () => {
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops");
    const merchant = await shop();
    await ctx.api("GET", "/packages/effective?segment=ECOMMERCE", { token: ops.token });
    const checked = await validate(ops.token, merchant.id, [row(1, { address: "House 9, Dhanmondi", district: "Dhaka Central", zone: "Dhanmondi", product_type: "Blue cotton shirt x2" })]);
    const before = checked.rows.items[0] as unknown as { charge: number; cells: Record<string, string> };
    expect(before.cells.service_level).toBeUndefined();
    const view = (await ctx.api("GET", `/packages/effective?merchantId=${merchant.id}`, { token: ops.token })).body as { priorities: { id: string; name: string }[] };
    const fragile = view.priorities.find(p => p.name === "Fragile")!;
    const res = await ctx.api("PATCH", `/imports/${checked.id}/options`, { token: ops.token, body: { speed: "EXPRESS", priority: fragile.id, notifications: ["notify.delivered"] } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.services).toMatchObject({ speed: "EXPRESS", priority: fragile.id, notifications: ["notify.delivered"] });
    const after = res.body.rows.items[0] as { charge: number; cells: Record<string, string> };
    expect(after.cells).toMatchObject({ service_level: "Express", priority: "Fragile" });
    expect(after.charge).toBeGreaterThan(before.charge);
    // A delivery type that isn't offered is refused.
    expect((await ctx.api("PATCH", `/imports/${checked.id}/options`, { token: ops.token, body: { speed: "Rocket" } })).status).toBe(422);
    expect((await ctx.api("POST", `/imports/${checked.id}/commit`, { token: ops.token })).body).toMatchObject({ status: "COMPLETED" });
    const parcel = await ctx.prisma.parcel.findFirstOrThrow({ where: { merchantId: merchant.id } });
    expect(parcel).toMatchObject({ speedOption: "EXPRESS", priorityName: "Fragile", notifications: ["notify.delivered"], productName: "Shirt", productLabel: "Blue cotton shirt x2" });
    // Screens and prints show the file's name.
    const detail = (await ctx.api("GET", `/parcels/${parcel.trackingId}`, { token: ops.token })).body;
    expect(detail).toMatchObject({ product: "Blue cotton shirt x2", systemProduct: "Shirt" });
    // Not after it was submitted.
    expect((await ctx.api("PATCH", `/imports/${checked.id}/options`, { token: ops.token, body: { speed: "REGULAR" } })).status).toBe(409);
  });

  it("a preview row's own product, delivery type and priority; applying the file's choice to every row replaces them", async () => {
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops");
    const merchant = await shop();
    await ctx.api("GET", "/packages/effective?segment=ECOMMERCE", { token: ops.token });
    const checked = await validate(ops.token, merchant.id, [
      row(1, { address: "House 9, Dhanmondi", district: "Dhaka Central", zone: "Dhanmondi", product_type: "Blue cotton shirt x2" }),
      row(2, { address: "House 4, Dhanmondi", district: "Dhaka Central", zone: "Dhanmondi", product_type: "Honey" }),
    ]);
    // The lists a row can take.
    const job = (await ctx.api("GET", `/imports/${checked.id}`, { token: ops.token })).body as { choices: { products: string[]; deliveryTypes: string[]; priorities: string[] } };
    expect(job.choices.products).toEqual(expect.arrayContaining(["Shirt", "Books"]));
    expect(job.choices.deliveryTypes).toEqual(expect.arrayContaining(["Regular", "Express"]));
    expect(job.choices.priorities).toContain("Fragile");
    const edit = await ctx.api("PATCH", `/imports/${checked.id}/rows/2`, { token: ops.token, body: { cells: { product_type: "Books", service_level: "Express", priority: "Fragile" } } });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    expect(edit.body.row).toMatchObject({ status: "VALID", productLabel: "Blue cotton shirt x2", cells: { product_type: "Books", service_level: "Express", priority: "Fragile" } });
    // The file's messages change: the row keeps its own delivery type and priority.
    const kept = await ctx.api("PATCH", `/imports/${checked.id}/options`, { token: ops.token, body: { notifications: ["notify.delivered"] } });
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    const cellsOf = (b: { rows: { items: { rowNumber: number; cells: Record<string, string> }[] } }, n: number) => b.rows.items.find(r => r.rowNumber === n)!.cells;
    expect(cellsOf(kept.body, 2)).toMatchObject({ service_level: "Express", priority: "Fragile" });
    expect(cellsOf(kept.body, 3).service_level).not.toBe("Express");
    // Applying a delivery type to every row replaces the row's own (its priority stays).
    const applied = await ctx.api("PATCH", `/imports/${checked.id}/options`, { token: ops.token, body: { speed: "REGULAR" } });
    expect(cellsOf(applied.body, 2)).toMatchObject({ service_level: "Regular", priority: "Fragile" });
    expect((await ctx.api("POST", `/imports/${checked.id}/commit`, { token: ops.token })).body).toMatchObject({ status: "COMPLETED" });
    const parcel = await ctx.prisma.parcel.findFirstOrThrow({ where: { merchantId: merchant.id, productLabel: "Blue cotton shirt x2" } });
    expect(parcel).toMatchObject({ speedOption: "REGULAR", priorityName: "Fragile", productName: "Books" });
  });

  it("a merchant's own import uses it too", async () => {
    const admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Admin");
    const merchant = await shop();
    const owner = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: merchant.id }], "Owner");
    await ctx.api("PUT", "/imports/ai", { token: admin.token, body: { enabled: true } });
    const res = await ctx.api("POST", "/imports/validate", { token: owner.token, body: { kind: "ecommerce", rows: [row(1, { address: "House 9, Kazipara", district: "Dhaka Central", product_type: "Drone propeller set" })] } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(calls).toHaveLength(1);
    expect(res.body.rows.items[0].cells).toMatchObject({ product_type: "Drone Parts", zone: "Mirpur" });
  });
});
