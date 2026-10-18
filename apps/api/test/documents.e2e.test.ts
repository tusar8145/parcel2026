import { hub, parcelBody, resetDatabase, riderUser, startApp, userWithRoles, type TestContext } from "./helpers";
import { writeFileSync } from "node:fs";
import { pdfHas, readPdf } from "./pdf-text";

/** PDF documents for the print buttons: content, permissions / scope, limits and audit. */
describe("documents (PDF)", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  /** Raw request: the PDF bytes, not a string. */
  const pdf = async (method: "GET" | "POST", url: string, token: string, body?: unknown) => {
    const res = await ctx.app.inject({ method, url: `/api/v1${url}`, payload: body as object | undefined, headers: { authorization: `Bearer ${token}` } });
    const json = res.headers["content-type"]?.toString().includes("json") ? JSON.parse(res.body) : null;
    return { status: res.statusCode, headers: res.headers, bytes: res.rawPayload, json };
  };
  const ok = (r: Awaited<ReturnType<typeof pdf>>) => {
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.headers["content-type"]).toBe("application/pdf");
    expect(r.bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(r.bytes.subarray(-8).toString("latin1")).toContain("%%EOF");
    // PDF_DUMP=<dir>: keep the generated files to look at them.
    if (process.env.PDF_DUMP) writeFileSync(`${process.env.PDF_DUMP}/${String(r.headers["content-disposition"]).match(/filename="([^"]+)"/)?.[1] ?? "doc.pdf"}`, r.bytes);
    return readPdf(r.bytes);
  };

  const setup = async () => {
    const gulshan = await hub(ctx, "HUB-GUL");
    const dhanmondi = await hub(ctx, "HUB-DHN");
    const merchant = (code: string, name: string, type: "ECOMMERCE" | "BANKING_FINANCIAL" = "ECOMMERCE") =>
      ctx.prisma.merchant.create({
        data: { code, type, name, status: "ACTIVE", contactName: "Owner", contactPhone: "+8801911000000", pickupAddress: "House 5 Road 2", pickupArea: "Gulshan 1", pickupDistrict: "Dhaka North" },
      });
    const shop = await merchant("MR-4001", "Northstar Test");
    const other = await merchant("MR-4002", "Other Shop");
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops Manager");
    const hubOp = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: gulshan.id }], "Gulshan Operator");
    const otherHubOp = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: dhanmondi.id }], "Dhanmondi Operator");
    const owner = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: shop.id }], "Shop Owner");
    const otherOwner = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: other.id }], "Other Owner");
    const finance = await userWithRoles(ctx, [{ role: "FINANCE" }], "Finance");
    const rider = await riderUser(ctx, "R-4048", gulshan.id);
    return { gulshan, dhanmondi, shop, other, ops, hubOp, otherHubOp, owner, otherOwner, finance, rider };
  };
  type Setup = Awaited<ReturnType<typeof setup>>;

  /** Drop-offs at Gulshan: in the Gulshan operator's scope, not Dhanmondi's. */
  const book = async (s: Setup, n: number, overrides: Record<string, unknown> = {}) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const res = await ctx.api("POST", "/ops/parcels", {
        token: s.ops.token,
        body: { merchantId: s.shop.id, ...parcelBody({ serviceLevel: "Regular", ...overrides }), sender: undefined, pickup: undefined, intake: "DROP_OFF", dropOffHubId: s.gulshan.id },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      ids.push(res.body.trackingId);
    }
    return ids;
  };

  describe("labels", () => {
    it("prints A4 (4 per page) and thermal labels with every tracking ID, Bangla included, and audits it", async () => {
      const s = await setup();
      const ids = await book(s, 5);
      const [bangla] = await book(s, 1, { recipient: { name: "মোহাম্মদ রহিম", phone: "01812000000" } });
      const all = [...ids, bangla];

      const a4 = await pdf("GET", `/documents/labels?ids=${all.join(",")}&format=a4`, s.ops.token);
      const info = ok(a4);
      expect(info.pages).toBe(2);
      expect(a4.headers["x-document-count"]).toBe("6");
      expect(a4.headers["x-document-pages"]).toBe("2");
      expect(String(a4.headers["content-disposition"])).toMatch(/^inline; filename="delivery-fast-labels-a4-\d{8}-\d{4}\.pdf"$/);
      for (const id of all) expect(pdfHas(info, id), id).toBe(true);
      expect(pdfHas(info, "COLLECT COD")).toBe(true);
      expect(pdfHas(info, "Northstar Test")).toBe(true);
      // Bangla is embedded with a Bengali font: the text maps back to the original characters.
      expect(info.all).toMatch(/[ঀ-৿]/);
      // Shaping reorders glyphs (the i-kar is drawn before its consonant), so check the letters, not the order.
      for (const ch of "মহাদরি") expect(info.all, ch).toContain(ch);

      const thermal = ok(await pdf("POST", "/documents/labels", s.ops.token, { ids: all, format: "thermal" }));
      expect(thermal.pages).toBe(6);
      expect(thermal.text[5]).toContain(bangla);

      const audit = await ctx.prisma.auditLog.findMany({ where: { action: "document.generate" }, orderBy: { createdAt: "asc" } });
      expect(audit).toHaveLength(2);
      expect(audit[0].data).toMatchObject({ kind: "labels", format: "a4", count: 6 });
    });

    it("prints a whole booking batch and flags incomplete orders as DETAILS PENDING", async () => {
      const s = await setup();
      const checked = await ctx.api("POST", "/imports/validate", {
        token: s.ops.token,
        body: { kind: "ecommerce", fileName: "labels.xlsx", merchantId: s.shop.id, intake: "DROP_OFF", dropOffHubId: s.gulshan.id, rows: [{ order_ref: "L-1", phone: "01812000000", district: "Dhaka Central", zone: "Dhanmondi" }, { order_ref: "L-2", "Customer name": "Nabila", phone: "01812000001", address: "Road 7", district: "Dhaka Central", zone: "Dhanmondi" }] },
      });
      expect(checked.status, JSON.stringify(checked.body)).toBe(201);
      expect((await ctx.api("POST", `/imports/${checked.body.id}/commit`, { token: s.ops.token })).status).toBe(200);
      const batch = await ctx.prisma.bookingBatch.findUniqueOrThrow({ where: { number: checked.body.number } });
      const info = ok(await pdf("GET", `/documents/labels?batchId=${batch.id}`, s.ops.token));
      expect(info.pages).toBe(1);
      expect(pdfHas(info, "DETAILS PENDING")).toBe(true);
      expect(pdfHas(info, checked.body.number)).toBe(true);
    });

    it("keeps hub operators to their hubs and merchants to their own parcels", async () => {
      const s = await setup();
      const ids = await book(s, 2);
      ok(await pdf("GET", `/documents/labels?ids=${ids.join(",")}`, s.hubOp.token));
      const elsewhere = await pdf("GET", `/documents/labels?ids=${ids.join(",")}`, s.otherHubOp.token);
      expect(elsewhere.status).toBe(404);
      expect(elsewhere.json.error.code).toBe("NOT_FOUND");
      ok(await pdf("GET", `/documents/labels?ids=${ids.join(",")}`, s.owner.token));
      expect((await pdf("GET", `/documents/labels?ids=${ids.join(",")}`, s.otherOwner.token)).status).toBe(404);
      // A rider can't print parcel documents.
      expect((await pdf("GET", `/documents/labels?ids=${ids[0]}`, s.rider.token)).status).toBe(403);
      // Unknown IDs are reported, the rest printed.
      const partial = await pdf("GET", `/documents/labels?ids=${ids[0]},DF-000000-NOPE1`, s.ops.token);
      expect(ok(partial).pages).toBe(1);
      expect(partial.headers["x-missing-count"]).toBe("1");
      expect(partial.headers["x-missing"]).toBe("DF-000000-NOPE1");
    });

    it("refuses more than 2,000 labels with a clear message", async () => {
      const s = await setup();
      const ids = Array.from({ length: 2001 }, (_, i) => `DF-261017-${String(i).padStart(5, "0")}`);
      const res = await pdf("POST", "/documents/labels", s.ops.token, { ids });
      expect(res.status).toBe(422);
      expect(res.json.error).toMatchObject({ code: "TOO_MANY_PARCELS", details: { max: 2000, selected: 2001 } });
      expect(res.json.error.message).toContain("At most 2,000 labels");
    });
  });

  describe("shipment invoices and lists", () => {
    it("prints delivery invoices per layout with VAT, filters by service line and lists shipments", async () => {
      const s = await setup();
      const ids = await book(s, 5);
      const one = ok(await pdf("GET", `/documents/invoices?ids=${ids.join(",")}&layout=a4`, s.ops.token));
      expect(one.pages).toBe(5);
      expect(pdfHas(one, "E-commerce parcel invoice")).toBe(true);
      expect(pdfHas(one, "VAT 15% (included)")).toBe(true);
      expect(pdfHas(one, "Page 1 of 5")).toBe(true);
      for (const id of ids) expect(pdfHas(one, id)).toBe(true);
      // 4 / 8 per A4 are cut after printing: no page header or footer, only the invoice cells (each with the company name).
      const four = ok(await pdf("GET", `/documents/invoices?ids=${ids.join(",")}&layout=a4-4&line=ecommerce`, s.ops.token));
      const eight = ok(await pdf("GET", `/documents/invoices?ids=${ids.join(",")}&layout=a4-8`, s.ops.token));
      expect(four.pages).toBe(2);
      expect(eight.pages).toBe(1);
      for (const grid of [four, eight]) {
        expect(pdfHas(grid, "Page 1 of")).toBe(false);
        expect(/Page \d+ of \d+/.test(grid.all)).toBe(false);
        expect(pdfHas(grid, "generated")).toBe(false);
        expect(pdfHas(grid, "Delivery invoices")).toBe(false);
        expect(pdfHas(grid, "E-commerce invoices")).toBe(false);
        expect(pdfHas(grid, "Delivery Fast")).toBe(true);
        for (const id of ids) expect(pdfHas(grid, id)).toBe(true);
      }
      expect(ok(await pdf("GET", `/documents/invoices?ids=${ids.join(",")}&layout=pos`, s.owner.token)).pages).toBe(5);
      const none = await pdf("GET", `/documents/invoices?ids=${ids.join(",")}&line=document`, s.ops.token);
      expect(none.status).toBe(422);
      expect(none.json.error.code).toBe("NOTHING_TO_PRINT");

      const list = ok(await pdf("POST", "/documents/parcel-list", s.ops.token, { ids, title: "Courier shipment register" }));
      expect(pdfHas(list, "Courier shipment register")).toBe(true);
      expect(pdfHas(list, "5 shipment(s)")).toBe(true);
      for (const id of ids) expect(pdfHas(list, id)).toBe(true);
    });
  });

  describe("operations documents", () => {
    it("prints today's run sheet from the rider's assignments, in hub scope only", async () => {
      const s = await setup();
      const ids = await book(s, 3);
      await ctx.prisma.parcel.updateMany({ where: { trackingId: { in: ids.slice(0, 2) } }, data: { status: "ASSIGNED", deliveryRiderId: s.rider.rider.id, currentHubId: s.gulshan.id } });
      const res = await pdf("GET", `/documents/run-sheet/${s.rider.rider.code}`, s.hubOp.token);
      const info = ok(res);
      expect(info.pages).toBe(1);
      expect(res.headers["x-document-count"]).toBe("2");
      expect(pdfHas(info, "Rider run sheet")).toBe(true);
      expect(pdfHas(info, ids[0]) && pdfHas(info, ids[1])).toBe(true);
      expect(pdfHas(info, ids[2])).toBe(false);
      expect(pdfHas(info, "COD to collect")).toBe(true);
      expect((await pdf("GET", `/documents/run-sheet/${s.rider.rider.id}`, s.otherHubOp.token)).status).toBe(403);
      const empty = await pdf("GET", `/documents/run-sheet/${s.rider.rider.code}?date=2020-01-01`, s.ops.token);
      expect(empty.status).toBe(422);
      expect(empty.json.error.code).toBe("NOTHING_TO_PRINT");
    });

    it("prints a linehaul manifest and bag tag for hubs on the route", async () => {
      const s = await setup();
      const ids = await book(s, 2);
      const parcels = await ctx.prisma.parcel.findMany({ where: { trackingId: { in: ids } } });
      const trip = await ctx.prisma.linehaulTrip.create({ data: { number: "MF-261017-0001", originHubId: s.gulshan.id, destHubId: s.dhanmondi.id, vehicleRegNo: "DHAKA-METRO-TA-11-2233", driverName: "Karim", driverPhone: "+8801711111111" } });
      const bag = await ctx.prisma.linehaulBag.create({ data: { number: "BG-261017-0001", label: "NORTH-1", originHubId: s.gulshan.id, destHubId: s.dhanmondi.id, tripId: trip.id, status: "SEALED", sealNo: "S-9911", items: { create: parcels.map(p => ({ parcelId: p.id })) } } });
      const info = ok(await pdf("GET", `/documents/manifest/${trip.number}`, s.hubOp.token));
      expect(pdfHas(info, "Linehaul manifest")).toBe(true);
      expect(pdfHas(info, "MF-261017-0001") && pdfHas(info, "BG-261017-0001") && pdfHas(info, "S-9911")).toBe(true);
      for (const id of ids) expect(pdfHas(info, id)).toBe(true);
      expect(pdfHas(info, "Received by (HUB-DHN)")).toBe(true);
      // Each bag's barcode is on the manifest too (scan to receive a whole bag).
      expect(pdfHas(info, "Bag barcodes")).toBe(true);
      expect(pdfHas(info, "BG-261017-0001 · 2 parcel(s)")).toBe(true);
      const other = await hub(ctx, "HUB-MIR");
      const outsider = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: other.id }], "Mirpur Operator");
      expect((await pdf("GET", `/documents/manifest/${trip.id}`, outsider.token)).status).toBe(403);
      const tag = ok(await pdf("GET", `/documents/bag-label/${bag.number}`, s.ops.token));
      expect(tag.pages).toBe(1);
      expect(pdfHas(tag, "HUB-DHN")).toBe(true);
      expect(pdfHas(tag, "BG-261017-0001 · NORTH-1")).toBe(true);
    });

    it("prints CN label sheets (24 per A4) and counts the print", async () => {
      const s = await setup();
      const batch = await ctx.api("POST", "/cn/batches", { token: s.hubOp.token, body: { count: 30, hubId: s.gulshan.id } });
      expect(batch.status, JSON.stringify(batch.body)).toBe(201);
      const info = ok(await pdf("GET", `/documents/cn-sheet/${batch.body.id}`, s.hubOp.token));
      expect(info.pages).toBe(2);
      const first = await ctx.prisma.cnStock.findFirstOrThrow({ where: { batchId: batch.body.id }, orderBy: { cn: "asc" } });
      expect(pdfHas(info, first.cn)).toBe(true);
      expect(first.printCount).toBe(1);
      expect((await pdf("GET", `/documents/cn-sheet/${batch.body.id}`, s.otherHubOp.token)).status).toBe(403);
    });

    it("prints a return run sheet", async () => {
      const s = await setup();
      const ids = await book(s, 2);
      const run = await ctx.prisma.returnRun.create({ data: { number: "RR-261017-0001", merchantId: s.shop.id, hubId: s.gulshan.id, riderId: s.rider.rider.id } });
      await ctx.prisma.parcel.updateMany({ where: { trackingId: { in: ids } }, data: { returnRunId: run.id, status: "RETURN_SCHEDULED", returnReason: "Recipient refused" } });
      const info = ok(await pdf("GET", `/documents/return-run/${run.id}`, s.hubOp.token));
      expect(pdfHas(info, "Return run sheet") && pdfHas(info, "RR-261017-0001") && pdfHas(info, "Recipient refused")).toBe(true);
      for (const id of ids) expect(pdfHas(info, id)).toBe(true);
      expect((await pdf("GET", `/documents/return-run/${run.id}`, s.otherHubOp.token)).status).toBe(404);
    });

    it("prints a report run and the SLA report", async () => {
      const s = await setup();
      const today = new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
      const run = await ctx.api("POST", "/reports/run", { token: s.ops.token, body: { kind: "DELIVERIES", from: today, to: today } });
      expect(run.status, JSON.stringify(run.body)).toBe(200);
      const info = ok(await pdf("GET", `/documents/report/${run.body.run.id}`, s.ops.token));
      expect(pdfHas(info, "Delivery summary")).toBe(true);
      const sla = ok(await pdf("GET", `/documents/sla-report?from=${today}&to=${today}`, s.ops.token));
      expect(pdfHas(sla, "SLA report") && pdfHas(sla, "By service level")).toBe(true);
      expect((await pdf("GET", `/documents/sla-report?from=${today}&to=${today}`, s.owner.token)).status).toBe(403);
    });
  });

  describe("finance documents", () => {
    it("prints the tax invoice with VAT, BIN and payment status; merchants only their own", async () => {
      const s = await setup();
      await ctx.prisma.setting.create({ data: { key: "finance.config", value: { vatRate: 15, seller: { name: "Delivery Fast Ltd.", bin: "000123456-0101", address: "Gulshan 1, Dhaka" } } } });
      const invoice = await ctx.prisma.invoice.create({
        data: {
          number: "INV-2610-0001",
          merchantId: s.shop.id,
          periodStart: new Date("2026-09-30T18:00:00Z"),
          periodEnd: new Date("2026-10-31T18:00:00Z"),
          subtotal: 230,
          total: 230,
          vatRate: 15,
          vatAmount: 30,
          dueAt: new Date("2026-11-15T18:00:00Z"),
          lines: [{ trackingId: "DF-261001-AAAAA", description: "Delivery · Regular", amount: 115, taxableValue: 100, vat: 15 }, { trackingId: "DF-261002-BBBBB", description: "Delivery · Regular", amount: 115, taxableValue: 100, vat: 15 }],
        },
      });
      const info = ok(await pdf("GET", `/documents/finance-invoice/${invoice.id}`, s.finance.token));
      for (const t of ["INV-2610-0001", "Mushak-6.3", "000123456-0101", "VAT @ 15%", "Balance due", "UNPAID", "DF-261001-AAAAA", "Authorised signatory"]) expect(pdfHas(info, t), t).toBe(true);
      ok(await pdf("GET", `/documents/finance-invoice/${invoice.id}`, s.owner.token));
      expect((await pdf("GET", `/documents/finance-invoice/${invoice.id}`, s.otherOwner.token)).status).toBe(404);
      expect((await pdf("GET", `/documents/finance-invoice/${invoice.id}`, s.hubOp.token)).status).toBe(403);
    });

    it("prints settlement statements and the merchant's unbilled statement", async () => {
      const s = await setup();
      const st = await ctx.prisma.merchantSettlement.create({ data: { number: "ST-2610-0001", merchantId: s.shop.id, codTotal: 1500, chargesTotal: 130, netPayable: 1370 } });
      const info = ok(await pdf("GET", `/documents/settlement/${st.id}`, s.finance.token));
      expect(pdfHas(info, "COD settlement statement") && pdfHas(info, "ST-2610-0001") && pdfHas(info, "Net payable")).toBe(true);
      expect((await pdf("GET", `/documents/settlement/${st.id}`, s.otherOwner.token)).status).toBe(404);

      const [id] = await book(s, 1, { codAmount: 0 });
      await ctx.prisma.parcel.update({ where: { trackingId: id }, data: { status: "DELIVERED", deliveredAt: new Date() } });
      const statement = ok(await pdf("GET", "/documents/statement", s.owner.token));
      expect(pdfHas(statement, id) && pdfHas(statement, "Delivery charges statement")).toBe(true);
      expect((await pdf("GET", "/documents/statement", s.finance.token)).status).toBe(403);
    });
  });
});
