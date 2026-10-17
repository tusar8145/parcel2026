import { DEFAULT_PACKAGE_PRICES as P } from "@delivery-fast/shared";
import { vi } from "vitest";
import { RealtimeService, type RealtimeEvent } from "../src/common/realtime.service";
import { ImportJobsService } from "../src/modules/imports/import-jobs.service";
import { readZip, writeZip } from "../src/modules/imports/xlsx/zip";
import { readXlsx } from "../src/modules/imports/xlsx/xlsx-reader";
import { writeXlsx } from "../src/modules/imports/xlsx/xlsx-writer";
import { readCsv } from "../src/modules/imports/csv";
import { hub, parcelBody, resetDatabase, riderUser, startApp, userWithRoles, type TestContext } from "./helpers";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const ECOM_HEADER = ["Order ID", "Customer name", "Customer phone", "Delivery address", "District", "Zone", "Area", "Address type", "Parcel type", "Product type", "Item description", "Service", "Weight (kg)", "Cash on delivery", "COD amount (৳)", "Product value (৳)", "Packaging", "Delivery instructions"];

/** One spreadsheet import engine for merchants (both panels, API keys) and operations. */
describe("imports", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  let seq = 0;
  async function merchant(type: "ECOMMERCE" | "BANKING_FINANCIAL" = "ECOMMERCE") {
    const m = await ctx.prisma.merchant.create({
      data: {
        code: `MR-I${++seq}`,
        type,
        name: `${type === "ECOMMERCE" ? "Shop" : "Bank"} ${seq}`,
        status: "ACTIVE",
        kycStatus: "APPROVED",
        contactName: "Owner",
        contactPhone: "+8801711111111",
        pickupAddress: "House 5 Road 2",
        pickupArea: "Gulshan 1",
        pickupDistrict: "Dhaka North",
      },
    });
    const owner = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: m.id }], "Owner");
    return { m, owner };
  }

  function multipart(fields: Record<string, string>, file: { name: string; data: Buffer; type?: string }) {
    const boundary = `----dfTest${Math.random().toString(16).slice(2)}`;
    const parts: Buffer[] = [];
    for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type ?? "application/octet-stream"}\r\n\r\n`), file.data, Buffer.from(`\r\n--${boundary}--\r\n`));
    return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
  }
  async function upload(token: string, fields: Record<string, string>, file: { name: string; data: Buffer }) {
    const body = multipart(fields, file);
    const res = await ctx.app.inject({ method: "POST", url: "/api/v1/imports/validate", payload: body.payload, headers: { ...body.headers, authorization: `Bearer ${token}` } });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  }
  async function download(token: string, url: string) {
    const res = await ctx.app.inject({ method: "GET", url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` } });
    return { status: res.statusCode, headers: res.headers, buffer: res.rawPayload };
  }
  const csv = (rows: string[][]) => Buffer.from(`﻿${rows.map(r => r.map(c => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\r\n")}`, "utf8");
  /** An e-commerce row by header name. */
  const ecom = (values: Partial<Record<(typeof ECOM_HEADER)[number], string>>) => ECOM_HEADER.map(h => values[h as (typeof ECOM_HEADER)[number]] ?? "");
  const full = (ref: string, extra: Partial<Record<(typeof ECOM_HEADER)[number], string>> = {}) =>
    ecom({
      "Order ID": ref,
      "Customer name": "Nabila Ahmed",
      "Customer phone": "01812000000",
      "Delivery address": "Road 7, Flat 3B",
      District: "Dhaka Central",
      Zone: "Dhanmondi",
      Service: "Same day",
      "Weight (kg)": "2",
      "COD amount (৳)": "1500",
      "Product type": "Fashion & Apparel",
      ...extra,
    });
  const allRows = async (token: string, id: string, filter = "all") => (await ctx.api("GET", `/imports/${id}/rows?filter=${filter}&pageSize=200`, { token })).body;

  describe("templates", () => {
    it("are real .xlsx files with required markers, dropdowns from live data, instructions and a hidden lists sheet", async () => {
      const { owner } = await merchant();
      await ctx.prisma.setting.create({ data: { key: "platform-config", value: { receiverRelations: ["Self", "Reception", "Authorized representative"], documentTypes: ["B2B Document", "Cheque book"] } } });
      const res = await download(owner.token, "/imports/templates/ecommerce");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe(XLSX);
      expect(String(res.headers["content-disposition"])).toContain(".xlsx");
      const files = readZip(res.buffer, { maxBytes: 50_000_000 });
      const workbook = files.get("xl/workbook.xml")!.toString();
      expect(workbook).toMatch(/<sheet name="Orders"[^>]*\/>/);
      expect(workbook).toMatch(/<sheet name="Instructions"[^>]*\/>/);
      expect(workbook).toMatch(/<sheet name="Lists"[^>]*state="hidden"/);
      expect(workbook).toContain('<definedName name="L_districts">Lists!$');
      expect(workbook).toMatch(/<definedName name="ZN_1">/);
      const sheet = files.get("xl/worksheets/sheet1.xml")!.toString();
      // Required columns: red header style (s="1") and "*"; optional: s="2". Merchant panels have no Merchant column.
      expect(sheet).toContain('<c r="C1" s="1" t="inlineStr"><is><t>Customer phone *</t></is></c>');
      expect(sheet).toContain('<c r="E1" s="2" t="inlineStr"><is><t>District</t></is></c>');
      expect(sheet).not.toContain("Merchant");
      expect(sheet).toContain('state="frozen"');
      // Dropdowns: districts, dependent zones, services, yes/no; numbers and phone checks; 5,000 rows.
      expect(sheet).toContain('sqref="E2:E5001"><formula1>L_districts</formula1>');
      // IF, not IFERROR: Excel shows no dropdown when the list source isn't a range.
      expect(sheet).toContain("IF($E2=&quot;&quot;,L_zones,INDIRECT(&quot;ZN_&quot;&amp;MATCH($E2,L_districts,0)))");
      expect(sheet).not.toContain("IFERROR");
      expect(sheet).toContain("<formula1>L_speeds</formula1>");
      expect(sheet).toContain("<formula1>L_yesNo</formula1>");
      expect(sheet).toMatch(/type="decimal"[^>]*sqref="O2:O5001"/);
      expect(sheet).toMatch(/type="textLength"[^>]*sqref="C2:C5001"/);
      const lists = readXlsx(res.buffer, { maxRows: 10_000, prefer: ["Lists"] });
      expect(lists.rows[0]).toContain("Districts");
      expect(lists.rows.map(r => r[lists.rows[0].indexOf("Districts")])).toContain("Dhaka Central");
      const help = readXlsx(res.buffer, { maxRows: 10_000, prefer: ["Instructions"] });
      const text = help.rows.map(r => r.join(" | ")).join("\n");
      expect(text).toContain("at most 5,000 rows");
      expect(text).toContain("Customer phone | Yes | Bangladeshi mobile number");
      // The Service column follows the merchant's package (service packages): the default e-commerce package.
      expect(text).toContain("Service | No | Regular, Express | Regular");

      // The document template has its own columns; operations templates add the Merchant column.
      const bank = await merchant("BANKING_FINANCIAL");
      const doc = readZip((await download(bank.owner.token, "/imports/templates/document")).buffer, { maxBytes: 50_000_000 });
      const docSheet = doc.get("xl/worksheets/sheet1.xml")!.toString();
      expect(doc.get("xl/workbook.xml")!.toString()).toContain('<sheet name="Consignments"');
      // Banking & Financial: document types are Service options now (service packages); no weight, no COD.
      expect(docSheet).toContain("<t>Service</t>");
      expect(docSheet).not.toContain("Weight (kg)");
      expect(docSheet).toContain("<t>Product</t>");
      expect(docSheet).toContain("Receiver relationship");
      expect(docSheet).not.toContain("COD");
      expect(readXlsx((await download(bank.owner.token, "/imports/templates/document")).buffer, { maxRows: 100, prefer: ["Lists"] }).rows.flat()).toContain("Authorized representative");
      const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops");
      const opsSheet = readZip((await download(ops.token, "/imports/templates/ecommerce")).buffer, { maxBytes: 50_000_000 }).get("xl/worksheets/sheet1.xml")!.toString();
      expect(opsSheet).toContain(">Merchant</t>");
      expect(opsSheet).toContain("sqref=\"A2:A10001\"><formula1>L_merchants</formula1>");
    });
  });

  describe("reading files", () => {
    it("reads .xlsx shared strings, inline strings, numbers, booleans and dates, and CSV with BOM, quotes and semicolons", () => {
      const service = ctx.app.get(ImportJobsService);
      const workbook = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Help" sheetId="1" r:id="rId2" state="hidden"/><sheet name="Data" sheetId="2" r:id="rId1"/></sheets></workbook>`;
      const rels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="worksheets/sheet7.xml"/><Relationship Id="rId2" Type="x" Target="/xl/worksheets/sheet8.xml"/></Relationships>`;
      const shared = `<sst><si><t>Customer name</t></si><si><r><rPr/><t>Ay</t></r><r><t xml:space="preserve">esha &amp; Co</t></r><rPh><t>x</t></rPh></si></sst>`;
      const styles = `<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="14"/></cellXfs></styleSheet>`;
      const sheet = `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Phone</t></is></c><c r="D1" t="inlineStr"><is><t>When</t></is></c></row><row r="3"><c r="A3" t="s"><v>1</v></c><c r="B3"><v>1712345678</v></c><c r="C3" t="b"><v>1</v></c><c r="D3" s="1"><v>46311</v></c><c r="E3"><v>0.30000000000000004</v></c><c r="F3" s="2"><v>46311.5</v></c></row></sheetData></worksheet>`;
      const buffer = writeZip([
        { name: "xl/workbook.xml", data: workbook },
        { name: "xl/_rels/workbook.xml.rels", data: rels },
        { name: "xl/sharedStrings.xml", data: shared },
        { name: "xl/styles.xml", data: styles },
        { name: "xl/worksheets/sheet7.xml", data: sheet },
        { name: "xl/worksheets/sheet8.xml", data: "<worksheet><sheetData/></worksheet>" },
      ]);
      const read = service.parseFile(buffer, "orders.xlsx", 100);
      expect(read.sheetName).toBe("Data");
      expect(read.rows[0]).toEqual(["Customer name", "Phone", "", "When"]);
      expect(read.rows[1]).toEqual([]);
      expect(read.rows[2]).toEqual(["Ayesha & Co", "1712345678", "TRUE", "2026-10-16", "0.3", "2026-10-16 12:00"]);

      const text = `﻿name;phone;address\r\n"Rahman; Sons";01712345678;"Line 1\nLine 2"\r\n"Say ""hi""";;x\n`;
      const parsed = service.parseFile(Buffer.from(text, "utf8"), "orders.csv", 100);
      expect(parsed.rows).toEqual([["name", "phone", "address"], ["Rahman; Sons", "01712345678", "Line 1\nLine 2"], ['Say "hi"', "", "x"]]);
      expect(readCsv(Buffer.from("a,b\r\n1,2", "utf8"), { maxRows: 5 }).rows).toEqual([["a", "b"], ["1", "2"]]);
      expect(() => service.parseFile(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2]), "old.xls", 10)).toThrow(/97–2003/);
      expect(() => readCsv(Buffer.from("a\n1\n2\n3", "utf8"), { maxRows: 2 })).toThrow(/more than 2 rows/);
    });
  });

  describe("validation", () => {
    it("checks every cell, creates valid rows even with minimal info and refuses rows with any invalid value", async () => {
      const { m, owner } = await merchant();
      const booked = await ctx.api("POST", "/parcels", { token: owner.token, body: { ...parcelBody({ merchantOrderRef: "ORD-BOOKED", type: "ECOMMERCE" }), saveAddresses: false } });
      expect(booked.status, JSON.stringify(booked.body)).toBe(201);
      const file = csv([
        ECOM_HEADER.map((h, i) => (i === 2 ? `${h} *` : h)), // a "*" in a header is ignored
        full("ORD-1"), // 2 valid
        ecom({ "Customer name": "Only Name", "Customer phone": "1712345678" }), // 3 incomplete: no address or destination
        full("ORD-3", { "Customer phone": "12345" }), // 4
        full("ORD-4", { District: "Atlantis" }), // 5
        full("ORD-5", { Zone: "Gulshan" }), // 6 zone of another district
        full("ORD-6", { "COD amount (৳)": "abc" }), // 7
        full("ORD-7", { "COD amount (৳)": "-5" }), // 8
        full("ORD-8", { "Weight (kg)": "80" }), // 9
        full("ORD-9", { Service: "Rocket" }), // 10
        full("ORD-DUP"), // 11
        full("ORD-DUP"), // 12
        full("ORD-12", { "Parcel type": "Document", "COD amount (৳)": "500" }), // 13 COD on a document
        full("ORD-BOOKED"), // 14 booked before
        full("ORD-14", { District: "", Zone: "mirpur", "Customer phone": "+8801912345678" }), // 15 zone alone finds its district
        full("ORD-15", { "Cash on delivery": "No" }), // 16 COD "No" with an amount
        full("ORD-16", { "Product type": "Spaceships" }), // 17 unknown option
        ["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""], // empty row: not a candidate
      ]);
      const res = await upload(owner.token, { kind: "ecommerce" }, { name: "orders.csv", data: file });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({ status: "VALIDATED", kind: "ecommerce", merchant: { id: m.id }, counts: { rows: 16, valid: 2, incomplete: 1, errors: 13 } });
      expect(res.body.number).toMatch(/^IMP-\d{6}-\d{3}$/);
      const rows = (await allRows(owner.token, res.body.id)).items as { rowNumber: number; status: string; errors: { column: string; text: string; message: string }[]; missing: string[]; charge: number }[];
      const at = (n: number) => rows.find(r => r.rowNumber === n)!;
      expect(at(2)).toMatchObject({ status: "VALID", errors: [], charge: 155 });
      expect(at(3)).toMatchObject({ status: "INCOMPLETE", missing: ["address", "district", "zone"], charge: 70 });
      expect(at(4).errors[0].text).toBe("Row 4 · Customer phone: enter the 10 digits after +880 (e.g. 1712345678)");
      expect(at(5).errors[0]).toMatchObject({ column: "district", message: 'unknown district "Atlantis" (use one from the list)' });
      expect(at(6).errors[0]).toMatchObject({ column: "zone", message: '"Gulshan" is not a zone of Dhaka Central' });
      expect(at(7).errors[0]).toMatchObject({ column: "cod_amount", message: '"abc" is not a number' });
      expect(at(8).errors[0]).toMatchObject({ column: "cod_amount", message: "can't be negative" });
      expect(at(9).errors[0]).toMatchObject({ column: "weight_kg", message: "must be at most 50 kg" });
      expect(at(10).errors[0]).toMatchObject({ column: "service_level" });
      expect(at(11).errors[0].message).toBe("ORD-DUP appears more than once in this file (rows 11, 12)");
      expect(at(12).status).toBe("ERROR");
      expect(at(13).errors[0]).toMatchObject({ column: "cod_amount", message: "documents can't be cash on delivery" });
      expect(at(14).errors[0].message).toBe(`ORD-BOOKED was already booked as ${booked.body.trackingId}`);
      expect(at(15)).toMatchObject({ status: "VALID" });
      expect(at(16).errors[0].message).toBe('Cash on delivery is "No" but an amount is given');
      expect(at(17).errors[0]).toMatchObject({ column: "product_type", message: '"Spaceships" is not an option (choose from the list)' });

      // Paginated preview with filters.
      const errorsPage = await ctx.api("GET", `/imports/${res.body.id}/rows?filter=error&page=2&pageSize=10`, { token: owner.token });
      expect(errorsPage.body).toMatchObject({ total: 13, pages: 2, page: 2 });
      expect(errorsPage.body.items).toHaveLength(3);
      expect((await ctx.api("GET", `/imports/${res.body.id}/rows?filter=incomplete`, { token: owner.token })).body.items.map((r: { rowNumber: number }) => r.rowNumber)).toEqual([3]);
      // Nothing booked by the dry run.
      expect(await ctx.prisma.parcel.count({ where: { merchantId: m.id } })).toBe(1);

      // Document template: COD isn't possible; a valid consignment passes.
      const bank = await merchant("BANKING_FINANCIAL");
      const doc = await upload(bank.owner.token, { kind: "document" }, {
        name: "docs.csv",
        data: csv([
          ["Reference no.", "Recipient name", "Recipient phone", "Delivery address", "District", "Zone", "Document type", "Receiver relationship", "COD amount"],
          ["LOAN-1", "Mahir", "01819123205", "Office 8", "Dhaka South", "Motijheel", "Cheque book", "Reception", ""],
          ["LOAN-2", "Mahir", "01819123205", "Office 8", "Dhaka South", "Motijheel", "Cheque book", "Reception", "500"],
          ["LOAN-3", "Mahir", "01819123205", "Office 8", "Dhaka South", "Motijheel", "", "Reception", ""],
          ["LOAN-4", "Mahir", "01819123205", "Office 8", "Dhaka South", "Motijheel", "Cheque book", "Best friend", ""],
        ]),
      });
      expect(doc.status, JSON.stringify(doc.body)).toBe(201);
      const docRows = (await allRows(bank.owner.token, doc.body.id)).items;
      // An empty "Document type" (now the Service column) books Regular (service packages).
      expect(docRows.map((r: { status: string }) => r.status)).toEqual(["VALID", "ERROR", "VALID", "ERROR"]);
      expect(docRows[1].errors[0].message).toBe("documents can't be cash on delivery");
      expect(docRows[2].errors).toEqual([]);
      // "Cheque book" (an old document type, not a handling option) is kept on the consignment and books Regular.
      expect(docRows[0].lines.map((l: { code: string }) => l.code)).toEqual(["route"]);
      expect(docRows[3].errors[0].column).toBe("receiver_relationship");
      // The wrong template for the merchant's type is refused.
      expect((await upload(bank.owner.token, { kind: "ecommerce" }, { name: "x.csv", data: csv([ECOM_HEADER, full("A")]) })).body.error.code).toBe("WRONG_TEMPLATE");
      // Someone else's import isn't visible.
      expect((await ctx.api("GET", `/imports/${res.body.id}`, { token: bank.owner.token })).status).toBe(404);
    });
  });

  describe("creating", () => {
    it("books valid and incomplete rows (incomplete ones priced with defaults), skips errors and keeps a history", async () => {
      const { m, owner } = await merchant();
      const res = await upload(owner.token, { kind: "ecommerce" }, {
        name: "october.csv",
        data: csv([ECOM_HEADER, full("ORD-1"), ecom({ "Customer name": "Only Name", "Customer phone": "01712345678" }), full("ORD-3", { "Customer phone": "123" })]),
      });
      const commit = await ctx.api("POST", `/imports/${res.body.id}/commit`, { token: owner.token });
      expect(commit.status, JSON.stringify(commit.body)).toBe(200);
      expect(commit.body).toMatchObject({ status: "COMPLETED", background: false, result: { created: 2, createdIncomplete: 1, notCreated: 1 }, batch: { number: res.body.number } });
      const parcels = await ctx.prisma.parcel.findMany({ where: { merchantId: m.id }, orderBy: { createdAt: "asc" } });
      expect(parcels).toHaveLength(2);
      const [complete, incomplete] = parcels;
      expect(complete).toMatchObject({ merchantOrderRef: "ORD-1", incomplete: false, deliveryZone: "Dhanmondi", channel: "MERCHANT_PORTAL", importJobId: res.body.id });
      // Service packages v2: Dhaka → Dhaka (same district) 70 + 2 kg (1.5 started kg over 0.5 → 2 × 15) + Express ("Same day") 40 + COD fee 15.
      expect(Number(complete.totalCharge)).toBe(155);
      expect(incomplete).toMatchObject({ incomplete: true, missingFields: ["address", "district", "zone"], deliveryDistrict: null, deliveryZone: null, deliveryStreet: null, recipientPhone: "+8801712345678" });
      // Missing destination: priced to the merchant's own city, 0.5 kg, Regular.
      expect(Number(incomplete.totalCharge)).toBe(P.sameDistrict);
      expect(Number(incomplete.weightKg)).toBe(0.5);
      expect(incomplete.serviceLevel).toBe("REGULAR");
      expect(incomplete.pricingSnapshot).toMatchObject({ destination: { district: "Dhaka North", zone: "Gulshan" } });

      // "Needs info" in the parcel list and views.
      const needs = await ctx.api("GET", "/parcels?incomplete=true", { token: owner.token });
      expect(needs.body.items.map((p: { trackingId: string }) => p.trackingId)).toEqual([incomplete.trackingId]);
      expect(needs.body.items[0]).toMatchObject({ incomplete: true, missingLabels: ["delivery address", "district", "zone"], delivery: { district: null, zone: null } });
      const track = await ctx.api("GET", `/track/${incomplete.trackingId}`);
      expect(track.status).toBe(200);

      // One summary to the uploader instead of a booking SMS per parcel.
      expect(await ctx.prisma.outboxMessage.count({ where: { template: "parcel.booked" } })).toBe(0);
      expect(await ctx.prisma.outboxMessage.count({ where: { template: "import.completed" } })).toBeGreaterThan(0);
      // A booking batch (labels, hub receive desk) and the history.
      const batch = await ctx.prisma.bookingBatch.findUniqueOrThrow({ where: { number: res.body.number } });
      expect(batch).toMatchObject({ merchantId: m.id, intake: "PICKUP", bookedCount: 2, rowCount: 3 });
      const history = await ctx.api("GET", "/imports", { token: owner.token });
      expect(history.body.items).toHaveLength(1);
      expect(history.body.items[0]).toMatchObject({ number: res.body.number, fileName: "october.csv", result: { created: 2, notCreated: 1 }, downloads: { failedRows: `/api/v1/imports/${res.body.id}/failed-rows` } });
      expect((await ctx.api("GET", `/imports/${res.body.id}/tracking-ids`, { token: owner.token })).body.trackingIds.sort()).toEqual([complete.trackingId, incomplete.trackingId].sort());
      expect(await ctx.prisma.auditLog.count({ where: { action: { in: ["import.validate", "import.submit", "import.complete"] } } })).toBe(3);
      // Submitting twice is refused.
      expect((await ctx.api("POST", `/imports/${res.body.id}/commit`, { token: owner.token })).body.error.code).toBe("IMPORT_SUBMITTED");
    });

    it("blocks the delivery rider while incomplete; completing re-prices, tracks and audits", async () => {
      const { owner } = await merchant();
      const gulshan = await hub(ctx, "HUB-IMP");
      const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops");
      const rider = await riderUser(ctx, "R-7001", gulshan.id);
      const res = await upload(owner.token, { kind: "ecommerce" }, {
        name: "x.csv",
        data: csv([ECOM_HEADER, ecom({ "Order ID": "INC-1", "Customer name": "A", "Customer phone": "01812000002" }), ecom({ "Order ID": "INC-2", "Customer phone": "01812000001", "Weight (kg)": "3" })]),
      });
      await ctx.api("POST", `/imports/${res.body.id}/commit`, { token: owner.token });
      const [p1, p2] = await ctx.prisma.parcel.findMany({ orderBy: { merchantOrderRef: "asc" } });
      // Pickup is allowed (the address is the merchant's); it reaches a hub.
      expect((await ctx.api("POST", `/parcels/${p1.trackingId}/assign-pickup`, { token: ops.token, body: { riderId: rider.rider.id } })).status).toBe(200);
      await ctx.prisma.parcel.update({ where: { id: p1.id }, data: { status: "AT_HUB", currentHubId: gulshan.id, version: { increment: 1 } } });
      const blocked = await ctx.api("POST", `/parcels/${p1.trackingId}/assign-delivery`, { token: ops.token, body: { riderId: rider.rider.id } });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toMatchObject({ code: "PARCEL_INCOMPLETE", details: { missingFields: ["address", "district", "zone"] } });
      expect(blocked.body.error.message).toContain("still needs the delivery address, district, zone");
      // Hub transfers need the destination too.
      expect((await ctx.api("POST", `/parcels/${p1.trackingId}/status`, { token: ops.token, body: { status: "IN_TRANSIT", hubId: gulshan.id } })).body.error.code).toBe("PARCEL_INCOMPLETE");

      // The merchant can complete only while it waits for pickup; operations until it goes out for delivery.
      const locked = await ctx.api("POST", `/parcels/${p1.trackingId}/complete`, { token: owner.token, body: { recipient: { phone: "01812000009" } } });
      expect(locked.body.error.code).toBe("PARCEL_LOCKED");
      const bad = await ctx.api("POST", `/parcels/${p1.trackingId}/complete`, { token: ops.token, body: { delivery: { district: "Dhaka Central", zone: "Gulshan" } } });
      expect(bad.status).toBe(422);
      const before = Number(p1.totalCharge);
      const done = await ctx.api("POST", `/parcels/${p1.trackingId}/complete`, {
        token: ops.token,
        body: { recipient: { phone: "1812000009" }, delivery: { street: "Road 7", district: "Chattogram", zone: "Agrabad" }, note: "Merchant called" },
      });
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      expect(done.body).toMatchObject({ incomplete: false, missingFields: [], recipient: { phone: "+8801812000009" }, delivery: { district: "Chattogram", zone: "Agrabad" } });
      // Re-priced from the merchant's city (same district) to a different district.
      expect(done.body.charges.total).toBe(before + (P.differentDistrict - P.sameDistrict));
      expect(done.body.events.map((e: { title: string }) => e.title)).toEqual(expect.arrayContaining(["Order details completed", "Details changed"]));
      expect(await ctx.prisma.auditLog.count({ where: { action: "parcel.complete_details" } })).toBe(1);
      expect((await ctx.api("POST", `/parcels/${p1.trackingId}/assign-delivery`, { token: ops.token, body: { riderId: rider.rider.id } })).status).toBe(200);
      expect((await ctx.api("POST", `/parcels/${p1.trackingId}/complete`, { token: ops.token, body: { weightKg: 2 } })).body.error.code).toBe("PARCEL_COMPLETE");

      // The merchant completes the other one while it is pending: partly, then fully.
      const partly = await ctx.api("POST", `/parcels/${p2.trackingId}/complete`, { token: owner.token, body: { recipient: { name: "Nabila" }, delivery: { zone: "Mirpur" } } });
      expect(partly.body).toMatchObject({ incomplete: true, missingFields: ["address"], delivery: { district: "Dhaka Central", zone: "Mirpur" } });
      const full2 = await ctx.api("POST", `/parcels/${p2.trackingId}/complete`, { token: owner.token, body: { delivery: { street: "House 1" } } });
      expect(full2.body).toMatchObject({ incomplete: false });
      expect(full2.body.events.filter((e: { title: string }) => e.title.startsWith("Order details")).length).toBe(2);
    });

    it("books a row without a recipient name, but needs the name before a delivery rider or out for delivery", async () => {
      const { owner } = await merchant();
      const gulshan = await hub(ctx, "HUB-NAME");
      const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops");
      const rider = await riderUser(ctx, "R-7002", gulshan.id);
      // The default import settings don't require the name: the row is created as "Needs info".
      const res = await upload(owner.token, { kind: "ecommerce" }, { name: "n.csv", data: csv([ECOM_HEADER, full("NONAME-1", { "Customer name": "" })]) });
      expect(res.body.counts).toMatchObject({ incomplete: 1, errors: 0 });
      const [row] = (await allRows(owner.token, res.body.id)).items;
      expect(row).toMatchObject({ status: "INCOMPLETE", missing: ["recipientName"] });
      await ctx.api("POST", `/imports/${res.body.id}/commit`, { token: owner.token });
      const p = await ctx.prisma.parcel.findFirstOrThrow({ where: { merchantOrderRef: "NONAME-1" } });
      expect(p).toMatchObject({ incomplete: true, missingFields: ["recipientName"], recipientName: null, deliveryZone: "Dhanmondi" });
      const listed = await ctx.api("GET", "/parcels?incomplete=true", { token: owner.token });
      expect(listed.body.items[0]).toMatchObject({ trackingId: p.trackingId, missingLabels: ["recipient name"] });

      // Hub transfers only need the destination; a delivery rider and out for delivery need the name.
      await ctx.prisma.parcel.update({ where: { id: p.id }, data: { status: "AT_HUB", currentHubId: gulshan.id, version: { increment: 1 } } });
      const blocked = await ctx.api("POST", `/parcels/${p.trackingId}/assign-delivery`, { token: ops.token, body: { riderId: rider.rider.id } });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toMatchObject({ code: "PARCEL_INCOMPLETE", details: { missingFields: ["recipientName"], to: "ASSIGNED" } });
      expect(blocked.body.error.message).toContain("still needs the recipient name");
      const suggestions = await ctx.api("GET", `/routing/suggestions?hubId=${gulshan.id}&kind=delivery`, { token: ops.token });
      expect(suggestions.status, JSON.stringify(suggestions.body)).toBe(200);
      expect(suggestions.body.unmatched).toEqual(expect.arrayContaining([expect.objectContaining({ trackingId: p.trackingId, reason: expect.stringContaining("recipient name") })]));
      // Even a parcel already with a rider (e.g. assigned before this rule) can't go out without it.
      await ctx.prisma.parcel.update({ where: { id: p.id }, data: { status: "ASSIGNED", deliveryRiderId: rider.rider.id, version: { increment: 1 } } });
      const out = await ctx.api("POST", `/parcels/${p.trackingId}/status`, { token: ops.token, body: { status: "OUT_FOR_DELIVERY" } });
      expect(out.status).toBe(409);
      expect(out.body.error).toMatchObject({ code: "PARCEL_INCOMPLETE", details: { missingFields: ["recipientName"], to: "OUT_FOR_DELIVERY" } });
      await ctx.prisma.parcel.update({ where: { id: p.id }, data: { status: "AT_HUB", deliveryRiderId: null, version: { increment: 1 } } });

      // Operations add the name: complete, and the rider can be assigned.
      const done = await ctx.api("POST", `/parcels/${p.trackingId}/complete`, { token: ops.token, body: { recipient: { name: "Rahim Uddin" } } });
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      expect(done.body).toMatchObject({ incomplete: false, missingFields: [], recipient: { name: "Rahim Uddin" } });
      expect((await ctx.api("POST", `/parcels/${p.trackingId}/assign-delivery`, { token: ops.token, body: { riderId: rider.rider.id } })).status).toBe(200);
    });
  });

  describe("super admin settings", () => {
    it("change required columns and defaults for templates and validation at once, audited", async () => {
      const { owner } = await merchant();
      const admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Admin");
      expect((await ctx.api("PUT", "/imports/config", { token: owner.token, body: {} })).status).toBe(403);
      const row = ecom({ "Order ID": "CFG-1", "Customer name": "A", "Customer phone": "01812000000", "Delivery address": "Road 1" });
      const before = await upload(owner.token, { kind: "ecommerce" }, { name: "a.csv", data: csv([ECOM_HEADER, row]) });
      expect(before.body.counts).toMatchObject({ incomplete: 1, errors: 0 });

      const bad = await ctx.api("PUT", "/imports/config", { token: admin.token, body: { templates: { ecommerce: { service_level: { default: "Rocket" } } } } });
      expect(bad.status).toBe(422);
      expect((await ctx.api("PUT", "/imports/config", { token: admin.token, body: { limits: { merchantMaxRows: 50_000 } } })).status).toBe(422);
      const saved = await ctx.api("PUT", "/imports/config", {
        token: admin.token,
        body: { templates: { ecommerce: { district: { required: true }, recipient_name: { required: false }, service_level: { default: "Express" } } } },
      });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect(saved.body.templates.ecommerce.find((c: { key: string }) => c.key === "district")).toMatchObject({ required: true });
      expect(await ctx.prisma.auditLog.count({ where: { action: "import_config.update" } })).toBe(1);

      const after = await upload(owner.token, { kind: "ecommerce" }, { name: "a.csv", data: csv([ECOM_HEADER, row, ecom({ "Order ID": "CFG-2", "Customer phone": "01812000000", District: "Dhaka North", Zone: "Banani" })]) });
      const rows = (await allRows(owner.token, after.body.id)).items;
      expect(rows[0].errors[0]).toMatchObject({ column: "district", message: "required", text: "Row 2 · District: required" });
      expect(rows[1].status).toBe("INCOMPLETE");
      await ctx.api("POST", `/imports/${after.body.id}/commit`, { token: owner.token });
      expect((await ctx.prisma.parcel.findFirstOrThrow({ where: { merchantOrderRef: "CFG-2" } })).speedOption).toBe("EXPRESS"); // Express = same day (serviceLevel SAME_DAY)
      const sheet = readZip((await download(owner.token, "/imports/templates/ecommerce")).buffer, { maxBytes: 50_000_000 }).get("xl/worksheets/sheet1.xml")!.toString();
      expect(sheet).toContain("<t>District *</t>");
      expect(sheet).toContain("<t>Customer name</t>");
      const instructions = readXlsx((await download(owner.token, "/imports/templates/ecommerce")).buffer, { maxRows: 100, prefer: ["Instructions"] }).rows.map(r => r.join(" | "));
      expect(instructions.find(l => l.startsWith("Service | No | Regular, Express | Express | Regular |"))).toBeTruthy();
    });
  });

  describe("failed rows", () => {
    it("download as .xlsx in the template format with an Error column (or CSV), ready to fix and upload again", async () => {
      const { owner } = await merchant();
      const res = await upload(owner.token, { kind: "ecommerce" }, { name: "x.csv", data: csv([ECOM_HEADER, full("OK-1"), full("BAD-1", { "Customer phone": "999", District: "Nowhere" })]) });
      await ctx.api("POST", `/imports/${res.body.id}/commit`, { token: owner.token });
      const file = await download(owner.token, `/imports/${res.body.id}/failed-rows`);
      expect(file.status).toBe(200);
      expect(file.headers["content-type"]).toBe(XLSX);
      const sheet = readXlsx(file.buffer, { maxRows: 100 });
      expect(sheet.sheetName).toBe("Orders");
      expect(sheet.rows[0].at(-1)).toBe("Error");
      expect(sheet.rows).toHaveLength(2);
      expect(sheet.rows[1][0]).toBe("BAD-1");
      expect(sheet.rows[1].at(-1)).toBe('Row 3: Customer phone: bangladeshi mobile numbers start with 1 (e.g. 17XXXXXXXX); District: unknown district "Nowhere" (use one from the list)');
      const zip = readZip(file.buffer, { maxBytes: 50_000_000 });
      expect(zip.get("xl/workbook.xml")!.toString()).toContain('<sheet name="Lists"');
      const asCsv = await download(owner.token, `/imports/${res.body.id}/failed-rows?format=csv`);
      expect(asCsv.headers["content-type"]).toContain("text/csv");
      expect(asCsv.buffer.toString("utf8")).toContain("BAD-1");
      // The downloaded file uploads again as is (the Error column is ignored); fixed rows pass.
      const again = await upload(owner.token, { kind: "ecommerce" }, { name: "fixed.xlsx", data: file.buffer });
      expect(again.status, JSON.stringify(again.body)).toBe(201);
      expect(again.body.counts).toMatchObject({ rows: 1, errors: 1 });
    });
  });

  describe("idempotency", () => {
    it("re-uploading the same file books nothing twice, with or without order IDs", async () => {
      const { m, owner } = await merchant();
      const file = csv([ECOM_HEADER, full("SAME-1"), full("", { "Customer name": "No Ref" })]);
      const first = await upload(owner.token, { kind: "ecommerce" }, { name: "a.csv", data: file });
      expect((await ctx.api("POST", `/imports/${first.body.id}/commit`, { token: owner.token })).body.result.created).toBe(2);
      const second = await upload(owner.token, { kind: "ecommerce" }, { name: "a.csv", data: file });
      expect(second.body.counts).toMatchObject({ valid: 0, errors: 2 });
      const rows = (await allRows(owner.token, second.body.id)).items;
      expect(rows[0].errors[0].message).toMatch(/^SAME-1 was already booked as /);
      expect(rows[1].errors[0].message).toMatch(/^this order was already imported as /);
      expect((await ctx.api("POST", `/imports/${second.body.id}/commit`, { token: owner.token })).body.error.code).toBe("NOTHING_TO_IMPORT");
      // Two identical rows without an order ID in one file are flagged rather than guessed.
      const twins = await upload(owner.token, { kind: "ecommerce" }, { name: "b.csv", data: csv([ECOM_HEADER, full("", { "Customer name": "Twin" }), full("", { "Customer name": "Twin" })]) });
      expect(twins.body.counts.errors).toBe(2);
      expect(await ctx.prisma.parcel.count({ where: { merchantId: m.id } })).toBe(2);
      // A row booked meanwhile (between preview and submit) fails at booking instead of booking twice.
      const third = await upload(owner.token, { kind: "ecommerce" }, { name: "c.csv", data: csv([ECOM_HEADER, full("RACE-1")]) });
      const fourth = await upload(owner.token, { kind: "ecommerce" }, { name: "c.csv", data: csv([ECOM_HEADER, full("RACE-1")]) });
      await ctx.api("POST", `/imports/${third.body.id}/commit`, { token: owner.token });
      const late = await ctx.api("POST", `/imports/${fourth.body.id}/commit`, { token: owner.token });
      expect(late.body).toMatchObject({ status: "COMPLETED", result: { created: 0, failed: 1 } });
      expect(await ctx.prisma.parcel.count({ where: { merchantOrderRef: "RACE-1" } })).toBe(1);
    });
  });

  describe("large files and limits", () => {
    it("books in the background in chunks with progress events, one import per merchant at a time", async () => {
      const { m, owner } = await merchant();
      const realtime = ctx.app.get(RealtimeService);
      const events: RealtimeEvent[] = [];
      const spy = vi.spyOn(realtime, "publish").mockImplementation((...e: RealtimeEvent[]) => void events.push(...e));
      const rows = Array.from({ length: 250 }, (_, i) => full(`BIG-${i}`, { "Customer phone": `0181${String(2000000 + i).padStart(7, "0")}` }));
      const big = await upload(owner.token, { kind: "ecommerce" }, { name: "big.csv", data: csv([ECOM_HEADER, ...rows]) });
      expect(big.body.counts).toMatchObject({ rows: 250, valid: 250 });
      const queued = await ctx.api("POST", `/imports/${big.body.id}/commit`, { token: owner.token });
      expect(queued.body).toMatchObject({ status: "QUEUED", background: true, progress: { processed: 0, total: 250 } });
      // One running import per merchant.
      const other = await upload(owner.token, { kind: "ecommerce" }, { name: "small.csv", data: csv([ECOM_HEADER, full("SMALL-1")]) });
      const refused = await ctx.api("POST", `/imports/${other.body.id}/commit`, { token: owner.token });
      expect(refused.status).toBe(429);
      expect(refused.body.error.code).toBe("IMPORT_IN_PROGRESS");

      // RUN_WORKERS is off in tests: run what the pg-boss worker runs.
      await ctx.app.get(ImportJobsService).process(big.body.id);
      const progress = events.filter(e => e.type === "import.progress" && e.id === big.body.id).map(e => e.data?.processed);
      expect(progress).toEqual([100, 200, 250]);
      expect(events.find(e => e.type === "import.completed")).toMatchObject({ merchantId: m.id, data: { created: 250, status: "COMPLETED" } });
      const done = await ctx.api("GET", `/imports/${big.body.id}`, { token: owner.token });
      expect(done.body).toMatchObject({ status: "COMPLETED", progress: { processed: 250, percent: 100 }, result: { created: 250 } });
      expect(await ctx.prisma.parcel.count({ where: { merchantId: m.id } })).toBe(250);
      // Running it again (e.g. a worker retry) books nothing more.
      await ctx.app.get(ImportJobsService).process(big.body.id);
      expect(await ctx.prisma.parcel.count({ where: { merchantId: m.id } })).toBe(250);
      expect((await ctx.api("POST", `/imports/${other.body.id}/commit`, { token: owner.token })).status).toBe(200);
      spy.mockRestore();
    }, 120_000);

    it("refuses files over the row and size limits set by super admin", async () => {
      const { owner } = await merchant();
      const admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Admin");
      expect((await ctx.api("GET", "/imports/limits", { token: owner.token })).body).toMatchObject({ maxRows: 5000, maxFileMb: 10, forOps: false });
      await ctx.api("PUT", "/imports/config", { token: admin.token, body: { limits: { merchantMaxRows: 3, maxFileMb: 0.1 } } });
      const tooMany = await upload(owner.token, { kind: "ecommerce" }, { name: "a.csv", data: csv([ECOM_HEADER, full("A"), full("B"), full("C"), full("D")]) });
      expect(tooMany.status).toBe(413);
      expect(tooMany.body.error).toMatchObject({ code: "TOO_MANY_ROWS", details: { maxRows: 3 } });
      const xlsx = writeXlsx({ sheets: [{ name: "Orders", rows: [ECOM_HEADER, full("A"), full("B"), full("C"), full("D")] }] });
      expect((await upload(owner.token, { kind: "ecommerce" }, { name: "a.xlsx", data: xlsx })).body.error.code).toBe("TOO_MANY_ROWS");
      const huge = await upload(owner.token, { kind: "ecommerce" }, { name: "big.csv", data: Buffer.alloc(150_000, "a") });
      expect(huge.status).toBe(413);
      expect(huge.body.error.code).toBe("FILE_TOO_LARGE");
      // Within the limits it works (and the template covers that many rows).
      expect((await upload(owner.token, { kind: "ecommerce" }, { name: "ok.xlsx", data: writeXlsx({ sheets: [{ name: "Orders", rows: [ECOM_HEADER, full("A")] }] }) })).status).toBe(201);
    });
  });

  describe("operations and API keys", () => {
    it("operations import with a merchant per row and drop-off at a hub: batch, labels and receive desk", async () => {
      const shop = await merchant();
      const bank = await merchant("BANKING_FINANCIAL");
      const gulshan = await hub(ctx, "HUB-OPS");
      const hubOp = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: gulshan.id }], "Gulshan Operator");
      const header = ["Merchant", ...ECOM_HEADER];
      const res = await upload(hubOp.token, { kind: "ecommerce", intake: "DROP_OFF" }, {
        name: "dropoff.csv",
        data: csv([
          header,
          [shop.m.code, ...full("OPS-1")],
          [`${shop.m.code} · ${shop.m.name}`, ...ecom({ "Order ID": "OPS-2", "Customer name": "No Address Yet", "Customer phone": "01812000003" })],
          [bank.m.code, ...full("OPS-3")],
          ["", ...full("OPS-4")],
        ]),
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({ source: "OPERATIONS", intake: "DROP_OFF", dropOffHub: { id: gulshan.id }, counts: { valid: 1, incomplete: 1, errors: 2 } });
      const rows = (await allRows(hubOp.token, res.body.id)).items;
      expect(rows[2].errors[0]).toMatchObject({ column: "merchant", message: `unknown or inactive e-commerce merchant "${bank.m.code}"` });
      expect(rows[3].errors[0].message).toBe("choose the merchant (in this column or for the whole file)");
      // Merchants don't see operations imports.
      expect((await ctx.api("GET", `/imports/${res.body.id}`, { token: shop.owner.token })).status).toBe(404);
      const commit = await ctx.api("POST", `/imports/${res.body.id}/commit`, { token: hubOp.token });
      expect(commit.body).toMatchObject({ status: "COMPLETED", result: { created: 2, createdIncomplete: 1 } });
      const parcels = await ctx.prisma.parcel.findMany({ where: { merchantId: shop.m.id }, orderBy: { merchantOrderRef: "asc" } });
      expect(parcels.map(p => [p.intake, p.dropOffHubId, p.channel])).toEqual([
        ["DROP_OFF", gulshan.id, "OPERATIONS"],
        ["DROP_OFF", gulshan.id, "OPERATIONS"],
      ]);
      // Labels, also for the incomplete one; the receive desk counts the batch.
      const labels = await ctx.api("POST", "/ops/labels", { token: hubOp.token, body: { trackingIds: parcels.map(p => p.trackingId) } });
      expect(labels.status, JSON.stringify(labels.body)).toBe(201);
      expect(labels.body.labels).toHaveLength(2);
      const received = await ctx.api("POST", "/ops/hub-receive", { token: hubOp.token, body: { code: parcels[1].trackingId, hubId: gulshan.id, source: "KEYBOARD", batchId: commit.body.batch.id } });
      expect(received.body).toMatchObject({ outcome: "RECEIVED", batch: { expected: 2, received: 1 } });
      const history = await ctx.api("GET", "/imports?mine=true", { token: hubOp.token });
      expect(history.body.items.map((i: { id: string }) => i.id)).toEqual([res.body.id]);

      // The file-level merchant choice fills an empty Merchant column.
      const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops");
      const perFile = await upload(ops.token, { kind: "document", merchantId: bank.m.id }, {
        name: "bank.csv",
        data: csv([["Merchant", "Reference no.", "Recipient name", "Recipient phone", "Document type"], ["", "B-1", "Mahir", "01819123205", "Cheque book"]]),
      });
      expect(perFile.body).toMatchObject({ merchant: { id: bank.m.id }, counts: { incomplete: 1 } });
      expect((await upload(ops.token, { kind: "ecommerce", intake: "DROP_OFF" }, { name: "x.csv", data: csv([header, [shop.m.code, ...full("Z")]]) })).body.error.code).toBe("HUB_REQUIRED");
      // Merchants choose drop at hub in the import modal when their package offers it (service packages): with a hub.
      expect((await upload(shop.owner.token, { kind: "ecommerce", intake: "DROP_OFF" }, { name: "x.csv", data: csv([ECOM_HEADER, full("Z")]) })).body.error.code).toBe("HUB_REQUIRED");
    });

    it("API keys with parcels:write import JSON rows; read-only keys can't", async () => {
      const { m, owner } = await merchant();
      const writeKey = (await ctx.api("POST", "/merchants/me/api-keys", { token: owner.token, body: { name: "Write", scopes: ["parcels:write"] } })).body.key;
      const readKey = (await ctx.api("POST", "/merchants/me/api-keys", { token: owner.token, body: { name: "Read", scopes: ["parcels:read"] } })).body.key;
      const body = { kind: "ecommerce", rows: [{ order_ref: "API-1", "Customer name": "Api Person", phone: "01812000000", district: "Dhaka Central", zone: "Mirpur", address: "House 9" }] };
      expect((await ctx.api("POST", "/imports/validate", { token: readKey, body })).status).toBe(403);
      const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }]);
      expect((await ctx.api("POST", "/imports/validate", { token: customer.token, body })).status).toBe(403);
      const res = await ctx.api("POST", "/imports/validate", { token: writeKey, body });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({ source: "MERCHANT_API", counts: { valid: 1 } });
      expect((await download(writeKey, "/imports/templates/ecommerce")).status).toBe(200);
      const commit = await ctx.api("POST", `/imports/${res.body.id}/commit`, { token: writeKey });
      expect(commit.body.result.created).toBe(1);
      expect((await ctx.prisma.parcel.findFirstOrThrow({ where: { merchantId: m.id } })).channel).toBe("MERCHANT_API");
      // The merchant sees API imports in its history.
      expect((await ctx.api("GET", `/imports?merchantId=${m.id}`, { token: owner.token })).body.items).toHaveLength(1);
    });
  });
});
