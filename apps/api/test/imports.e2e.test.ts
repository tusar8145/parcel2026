import { DEFAULT_PACKAGE_PRICES as P } from "@delivery-fast/shared";
import { vi } from "vitest";
import { RealtimeService, type RealtimeEvent } from "../src/common/realtime.service";
import { ImportJobsService } from "../src/modules/imports/import-jobs.service";
import { ImportConfigService } from "../src/modules/imports/import-config.service";
import { readZip, writeZip } from "../src/modules/imports/xlsx/zip";
import { readXlsx } from "../src/modules/imports/xlsx/xlsx-reader";
import { writeXlsx } from "../src/modules/imports/xlsx/xlsx-writer";
import { readCsv } from "../src/modules/imports/csv";
import { hub, parcelBody, resetDatabase, riderUser, startApp, userWithRoles, type TestContext } from "./helpers";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const ECOM_HEADER = ["Order ID", "Customer name", "Customer phone", "Delivery address", "District", "Zone", "Area", "Product", "Service", "Weight (kg)", "COD amount (৳)", "Product value (৳)", "Delivery instructions"];
const CUSTOMER_HEADER = ["Sender name", "Sender phone", "Pickup address", "Pickup district", "Pickup zone", "Recipient name", "Recipient phone", "Delivery address", "Delivery district", "Delivery zone", "Product", "Service", "Weight (kg)", "COD amount (৳)", "Reference no."];
/** Columns of the old templates that are gone (the merchant is chosen in the upload modal). */
const REMOVED = ["Merchant", "Parcel type", "Packaging", "Receiver relationship", "Origin branch code", "Document description", "Document type", "Item description", "Address type", "Cash on delivery"];

/** One spreadsheet import engine for merchants (both panels, API keys) and operations; three bulk-create templates. */
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
  const admin = () => userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Admin");
  const serviceCatalog = async () => (await ctx.api("GET", "/service-catalog")).body as { services: { code: string; segments: string[] }[] };
  const allServices = async (segment: string, without: string[] = []) => (await serviceCatalog()).services.filter(s => s.segments.includes(segment) && !without.includes(s.code)).map(s => s.code);
  async function packageFor(token: string, merchantId: string, segment: string, name: string, without: string[]) {
    const created = await ctx.api("POST", "/packages", { token, body: { segment, name, services: await allServices(segment, without), prices: {} } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const assigned = await ctx.api("PUT", `/merchants/${merchantId}/package`, { token, body: { packageId: created.body.id } });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
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
    return { status: res.statusCode, headers: res.headers, buffer: res.rawPayload, json: () => JSON.parse(res.body) };
  }
  /** A template's data sheet, instructions, lists and raw sheet XML. */
  async function template(token: string, url: string) {
    const res = await download(token, url);
    expect(res.status, res.buffer.toString()).toBe(200);
    const zip = readZip(res.buffer, { maxBytes: 50_000_000 });
    const lists = readXlsx(res.buffer, { maxRows: 20_000, prefer: ["Lists"] }).rows;
    const listOf = (title: string) => {
      const i = lists[0].indexOf(title);
      return i < 0 ? [] : lists.slice(1).map(r => r[i]).filter(Boolean);
    };
    return {
      res,
      header: readXlsx(res.buffer, { maxRows: 10 }).rows[0],
      workbook: zip.get("xl/workbook.xml")!.toString(),
      sheet: zip.get("xl/worksheets/sheet1.xml")!.toString(),
      help: readXlsx(res.buffer, { maxRows: 200, prefer: ["Instructions"] }).rows.map(r => r.join(" | ")),
      listOf,
    };
  }
  const letterOf = (header: string[], name: string) => String.fromCharCode(65 + header.findIndex(h => h.replace(/ \*$/, "") === name));
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
      Service: "Express",
      "Weight (kg)": "2",
      "COD amount (৳)": "1500",
      Product: "Fashion & Apparel",
      ...extra,
    });
  const customerRow = (values: Partial<Record<(typeof CUSTOMER_HEADER)[number], string>>) =>
    CUSTOMER_HEADER.map(h => ({
      "Sender name": "Karim Hossain",
      "Sender phone": "01711000001",
      "Pickup address": "House 5, Road 2",
      "Pickup district": "Dhaka North",
      "Pickup zone": "Gulshan",
      "Recipient name": "Nabila Ahmed",
      "Recipient phone": "01812000000",
      "Delivery address": "Road 7",
      "Delivery district": "Dhaka North",
      "Delivery zone": "Banani",
      Product: "Books",
      Service: "Regular",
      "Weight (kg)": "1",
      "COD amount (৳)": "500",
      "Reference no.": "",
      ...values,
    })[h as (typeof CUSTOMER_HEADER)[number]] ?? "");
  const allRows = async (token: string, id: string, filter = "all") => (await ctx.api("GET", `/imports/${id}/rows?filter=${filter}&pageSize=200`, { token })).body;

  describe("templates", () => {
    it("E-commerce: real .xlsx with exactly its columns (no district / zone / area: found from the full address), live dropdowns (products with type, the package's services) and its own instructions", async () => {
      const { owner } = await merchant();
      const t = await template(owner.token, "/imports/templates/ecommerce");
      expect(t.res.headers["content-type"]).toBe(XLSX);
      expect(String(t.res.headers["content-disposition"])).toContain("delivery-fast-ecommerce-orders-template.xlsx");
      expect(t.workbook).toMatch(/<sheet name="Orders"[^>]*\/>/);
      expect(t.workbook).toMatch(/<sheet name="Instructions"[^>]*\/>/);
      expect(t.workbook).toMatch(/<sheet name="Lists"[^>]*state="hidden"/);
      // No place lists: district / zone / area are found from the full address (imports/import-places.ts).
      expect(t.workbook).not.toContain('<definedName name="L_districts">');
      expect(t.workbook).not.toMatch(/<definedName name="ZN_1">/);
      // Exactly the E-commerce columns (the default package has COD and open box); the phone is required.
      expect(t.header).toEqual(["Customer name", "Customer phone *", "Delivery address", "Product", "COD amount (৳)", "Product value (৳)", "Weight (kg)", "Service", "Open box", "Order ID", "Delivery instructions"]);
      for (const gone of REMOVED) expect(t.header.join("|")).not.toContain(gone);
      expect(t.sheet).toContain('<c r="B1" s="1" t="inlineStr"><is><t>Customer phone *</t></is></c>');
      expect(t.sheet).toContain('state="frozen"');
      // Dropdowns: products, services, yes/no.
      expect(t.sheet).not.toContain("L_districts");
      expect(t.sheet).toContain("<formula1>L_products</formula1>");
      expect(t.sheet).toContain("<formula1>L_speeds</formula1>");
      expect(t.sheet).toContain("<formula1>L_yesNo</formula1>");
      expect(t.sheet).toMatch(new RegExp(`type="decimal"[^>]*sqref="${letterOf(t.header, "COD amount (৳)")}2:`));
      expect(t.sheet).toMatch(/type="textLength"[^>]*sqref="B2:B5001"/);
      // Live lists: active products only, with their type, Regular → Document → Books in the seeded order.
      const products = t.listOf("Products");
      expect(products[0]).toBe("Fashion & Apparel (Regular)");
      expect(products.indexOf("Papers (Document)")).toBeGreaterThan(products.indexOf("Industrial & Business Supplies (Regular)"));
      expect(products.indexOf("Books (Books)")).toBeGreaterThan(products.indexOf("Warranty Documents (Document)"));
      expect(products.some(p => /Credit Cards/.test(p))).toBe(false);
      expect(t.listOf("Service")).toEqual(["Regular", "Express"]);
      // Instructions for this category: phone required, upload-screen choices, pricing by district, Express same day.
      const text = t.help.join("\n");
      expect(text).toContain("at most 5,000 rows");
      expect(text).toContain("The customer phone is required");
      expect(text).toContain("First mile (rider pickup or drop at a hub), the drop-off hub, last mile and the messages to send are chosen on the upload screen");
      expect(text).toContain("Pricing is by district");
      expect(text).toContain("Express is same-day delivery, only inside the same district.");
      expect(text).not.toContain("pickup zone)\n");
      expect(text).toContain("Customer phone | Yes | Bangladeshi mobile number");
      // The address column asks for the full address; district / zone / area are found from it.
      expect(text).toContain("Write the FULL address in the address column: house, road, area, thana and district");
      expect(t.help.find(l => l.startsWith("Delivery address | No |"))).toContain("The full address: house, road, area, thana and district");
      expect(t.help.find(l => l.startsWith("District |"))).toBeUndefined();
      expect(t.help.find(l => l.startsWith("Service | No | Regular, Express (the services in Shop "))).toBeTruthy();
      // Examples come from live data (the first active product).
      expect(t.help.find(l => l.startsWith("Product | No |"))).toContain("| Fashion & Apparel (Regular) |");

      // An inactive product is not offered.
      await ctx.prisma.parcelProduct.update({ where: { segment_name: { segment: "ECOMMERCE", name: "Fashion & Apparel" } }, data: { active: false } });
      expect((await template(owner.token, "/imports/templates/ecommerce")).listOf("Products")[0]).toBe("Electronics & Gadgets (Regular)");
    });

    it("Banking & Financial: no COD, weight or open box; Banking products; texts without weight or e-commerce Express", async () => {
      const bank = await merchant("BANKING_FINANCIAL");
      for (const url of ["/imports/templates/document", "/imports/templates/banking"]) {
        const t = await template(bank.owner.token, url);
        expect(String(t.res.headers["content-disposition"])).toContain("delivery-fast-banking-financial-template.xlsx");
        expect(t.workbook).toContain('<sheet name="Consignments"');
        expect(t.header).toEqual(["Recipient name", "Recipient phone *", "Delivery address", "Product", "Service", "Reference no.", "Delivery instructions"]);
        for (const gone of REMOVED) expect(t.header.join("|")).not.toContain(gone);
        expect(t.sheet).not.toContain("Weight");
        expect(t.sheet).not.toContain("COD");
        expect(t.listOf("Products")[0]).toBe("Credit Cards (Regular)");
        expect(t.listOf("Products")).not.toContain("Fashion & Apparel (Regular)");
        expect(t.listOf("Service")).toEqual(["Regular", "Express", "On-demand", "B2B Document", "Trade Service Document", "Corporate Urgent Document"]);
        const text = t.help.join("\n");
        expect(text).not.toMatch(/weight and service defaults|Weight \(kg\)|Express is same-day/);
        expect(text).toContain("no weight, no cash on delivery and no product-type charge");
        expect(text).toContain("The recipient phone is required");
        expect(t.help.find(l => l.startsWith("Product | No |"))).toContain("| Credit Cards (Regular) |");
      }
      // A merchant only gets its own category's template.
      const wrong = await download(bank.owner.token, "/imports/templates/ecommerce");
      expect(wrong.status).toBe(422);
      expect(wrong.json().error).toMatchObject({ code: "WRONG_TEMPLATE", message: `${bank.m.name} is a Banking & Financial merchant: use the Banking & Financial template` });
      expect((await download(bank.owner.token, "/imports/templates/customer")).status).toBe(403);
    });

    it("operations: the template and the checks follow the merchant chosen in the modal (a package without Express offers no Express)", async () => {
      const { token } = await admin();
      const bank = await merchant("BANKING_FINANCIAL");
      const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops");
      await packageFor(token, bank.m.id, "BANKING_FINANCIAL", "No express", ["speed.express"]);
      const chosen = await template(ops.token, `/imports/templates/document?merchantId=${bank.m.id}`);
      expect(chosen.listOf("Service")).toEqual(["Regular", "On-demand", "B2B Document", "Trade Service Document", "Corporate Urgent Document"]);
      expect(chosen.help.join("\n")).toContain(`For ${bank.m.name} (${bank.m.code})`);
      expect(chosen.header).not.toContain("Merchant");
      expect(chosen.sheet).toContain("sqref=\"F2:F10001\""); // operations: 10,000 rows
      // Without a merchant: the category's default package (all six services).
      expect((await template(ops.token, "/imports/templates/document")).listOf("Service")).toContain("Express");
      // An e-commerce merchant for the Banking & Financial template is refused.
      const shop = await merchant();
      expect((await download(ops.token, `/imports/templates/document?merchantId=${shop.m.id}`)).json().error.code).toBe("WRONG_TEMPLATE");
      // The upload is checked against the same package.
      const res = await upload(ops.token, { kind: "document", merchantId: bank.m.id }, {
        name: "bank.csv",
        data: csv([["Reference no.", "Recipient phone", "District", "Zone", "Service"], ["B-1", "01819123205", "Dhaka South", "Motijheel", "Express"], ["B-2", "01819123206", "Dhaka South", "Motijheel", "B2B Document"]]),
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const rows = (await allRows(ops.token, res.body.id)).items;
      expect(rows[0].errors[0]).toMatchObject({ column: "service_level", message: `Express is not in ${bank.m.name}'s service package (choose Regular, On-demand, B2B Document, Trade Service Document, Corporate Urgent Document)` });
      expect(rows[1].status).toBe("INCOMPLETE");
    });

    it("Customer parcel: sender and pickup columns, the Customer package's services, no open box", async () => {
      const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops");
      const t = await template(ops.token, "/imports/templates/customer");
      expect(String(t.res.headers["content-disposition"])).toContain("delivery-fast-customer-parcels-template.xlsx");
      expect(t.workbook).toContain('<sheet name="Parcels"');
      expect(t.header).toEqual([
        "Sender name *",
        "Sender phone *",
        "Pickup address *",
        "Recipient name",
        "Recipient phone *",
        "Delivery address",
        "Product",
        "COD amount (৳)",
        "Product value (৳)",
        "Weight (kg)",
        "Service",
        "Reference no.",
        "Delivery instructions",
      ]);
      // Pickup and delivery places are found from the two full addresses: no place columns or lists.
      expect(t.sheet).not.toContain("L_zones");
      expect(t.help.join("\n")).toContain("(the sender's too, from the pickup address)");
      expect(t.listOf("Service")).toEqual(["Regular", "Express"]);
      expect(t.listOf("Products")[0]).toBe("Fashion & Apparel (Regular)");
      expect(t.help.join("\n")).toContain("Customer parcels booked by operations (walk-in or website customers): no merchant.");
      // A merchant can't use it.
      const { owner } = await merchant();
      expect((await download(owner.token, "/imports/templates/customer")).status).toBe(403);
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
        full("ORD-4", { District: "Atlantis", Zone: "" }), // 5 (no zone or address to pick the district from)
        full("ORD-5", { Zone: "Gulshan" }), // 6 zone of another district
        full("ORD-6", { "COD amount (৳)": "abc" }), // 7
        full("ORD-7", { "COD amount (৳)": "-5" }), // 8
        full("ORD-8", { "Weight (kg)": "80" }), // 9
        full("ORD-9", { Service: "Rocket" }), // 10
        full("ORD-DUP"), // 11 the first one stays valid
        full("ORD-DUP"), // 12 the later duplicate is the error
        full("ORD-12", { Service: "Same day" }), // 13 no longer read as Express
        full("ORD-BOOKED"), // 14 booked before
        full("ORD-14", { District: "", Zone: "mirpur", "Customer phone": "+8801912345678" }), // 15 zone alone finds its district
        full("ORD-15", { Product: "Fashion & Apparel (Regular)", Service: "Regular" }), // 16 the dropdown label
        full("ORD-16", { "Weight (kg)": "heavy" }), // 17 not a number
        full("ORD-17", { "Customer phone": "" }), // 18 the phone is required
        ECOM_HEADER.map(() => ""), // empty row: not a candidate
      ]);
      const res = await upload(owner.token, { kind: "ecommerce" }, { name: "orders.csv", data: file });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({ status: "VALIDATED", kind: "ecommerce", kindLabel: "E-commerce", merchant: { id: m.id }, counts: { rows: 17, valid: 4, incomplete: 1, errors: 12 } });
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
      expect(at(10).errors[0]).toMatchObject({ column: "service_level", message: '"Rocket" is not an option (Regular, Express)' });
      expect(at(11)).toMatchObject({ status: "VALID", errors: [] });
      expect(at(12).errors).toEqual([expect.objectContaining({ column: "order_ref", message: "ORD-DUP duplicates row 11 (each reference is booked once)" })]);
      expect(at(13).errors[0]).toMatchObject({
        column: "service_level",
        message: '"Same day" is not a service option: choose one from the list (Regular, Express); Express is the same-day service, inside the same district',
      });
      expect(at(14).errors[0].message).toBe(`ORD-BOOKED was already booked as ${booked.body.trackingId}`);
      expect(at(15)).toMatchObject({ status: "VALID" });
      expect(at(16)).toMatchObject({ status: "VALID" });
      expect(at(17).errors[0]).toMatchObject({ column: "weight_kg", message: '"heavy" is not a number' });
      expect(at(18).errors[0]).toMatchObject({ column: "recipient_phone", message: "required", text: "Row 18 · Customer phone: required" });

      // Paginated preview with filters.
      const errorsPage = await ctx.api("GET", `/imports/${res.body.id}/rows?filter=error&page=2&pageSize=10`, { token: owner.token });
      expect(errorsPage.body).toMatchObject({ total: 12, pages: 2, page: 2 });
      expect(errorsPage.body.items).toHaveLength(2);
      expect((await ctx.api("GET", `/imports/${res.body.id}/rows?filter=incomplete`, { token: owner.token })).body.items.map((r: { rowNumber: number }) => r.rowNumber)).toEqual([3]);
      // Nothing booked by the dry run.
      expect(await ctx.prisma.parcel.count({ where: { merchantId: m.id } })).toBe(1);

      // Banking & Financial: never COD; Banking products; the package's services; old columns are ignored.
      const bank = await merchant("BANKING_FINANCIAL");
      const doc = await upload(bank.owner.token, { kind: "document" }, {
        name: "docs.csv",
        data: csv([
          ["Reference no.", "Recipient name", "Recipient phone", "Delivery address", "District", "Zone", "Product", "Service", "Receiver relationship", "COD amount"],
          ["LOAN-1", "Mahir", "01819123205", "Office 8", "Dhaka South", "Motijheel", "Credit Cards (Regular)", "B2B Document", "Reception", ""],
          ["LOAN-2", "Mahir", "01819123205", "Office 8", "Dhaka South", "Motijheel", "Credit Cards", "", "", "500"],
          ["LOAN-3", "Mahir", "01819123205", "Office 8", "Dhaka South", "Motijheel", "", "", "", ""],
          ["LOAN-4", "Mahir", "01819123205", "Office 8", "Dhaka South", "Motijheel", "", "Cheque book", "", ""],
          ["LOAN-5", "Mahir", "01819123205", "Office 8", "Dhaka South", "Motijheel", "", "Same day", "", ""],
          ["LOAN-6", "Mahir", "01819123205", "Office 8", "Dhaka South", "Motijheel", "Fashion & Apparel", "", "", ""],
        ]),
      });
      expect(doc.status, JSON.stringify(doc.body)).toBe(201);
      expect(doc.body.ignoredColumns).toEqual(["Receiver relationship"]);
      const docRows = (await allRows(bank.owner.token, doc.body.id)).items;
      expect(docRows.map((r: { status: string }) => r.status)).toEqual(["VALID", "ERROR", "VALID", "ERROR", "ERROR", "ERROR"]);
      expect(docRows[1].errors[0]).toMatchObject({ column: "cod_amount", message: "Banking & Financial parcels can't be cash on delivery", header: "COD amount" });
      expect(docRows[0].lines.map((l: { code: string }) => l.code)).toEqual(["route"]); // B2B Document costs nothing extra by default
      expect(docRows[3].errors[0].message).toBe('"Cheque book" is not an option (Regular, Express, On-demand, B2B Document, Trade Service Document, Corporate Urgent Document)');
      expect(docRows[4].errors[0].message).toBe('"Same day" is not a service option: choose one from the list (Regular, Express, On-demand, B2B Document, Trade Service Document, Corporate Urgent Document)');
      expect(docRows[5].errors[0]).toMatchObject({ column: "product_type", message: '"Fashion & Apparel" is not an option (choose a product of the Banking & Financial list)' });
      // The wrong template for the merchant's category is refused.
      const wrong = await upload(bank.owner.token, { kind: "ecommerce" }, { name: "x.csv", data: csv([ECOM_HEADER, full("A")]) });
      expect(wrong.body.error).toMatchObject({ code: "WRONG_TEMPLATE", message: `${bank.m.name} is a Banking & Financial merchant: use the Banking & Financial template` });
      // Someone else's import isn't visible.
      expect((await ctx.api("GET", `/imports/${res.body.id}`, { token: bank.owner.token })).status).toBe(404);
    });
  });

  describe("creating", () => {
    it("E-commerce takes any product name: a listed product prices by its type, any other is booked as written and priced as Regular", async () => {
      const { m, owner } = await merchant();
      const res = await upload(owner.token, { kind: "ecommerce" }, {
        name: "products.csv",
        data: csv([ECOM_HEADER, full("FREE-1", { Product: "Blue cotton shirt x2" }), full("FREE-2", { Product: "Papers" }), full("FREE-3", { Product: "" })]),
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.counts).toMatchObject({ valid: 3, errors: 0 });
      const commit = await ctx.api("POST", `/imports/${res.body.id}/commit`, { token: owner.token });
      expect(commit.body).toMatchObject({ status: "COMPLETED", result: { created: 3 } });
      const parcels = await ctx.prisma.parcel.findMany({ where: { merchantId: m.id }, orderBy: { merchantOrderRef: "asc" } });
      expect(parcels.map(p => [p.merchantOrderRef, p.productName, p.productType, p.productId === null])).toEqual([
        ["FREE-1", "Blue cotton shirt x2", "REGULAR", true],
        ["FREE-2", "Papers", "DOCUMENT", false],
        ["FREE-3", null, "REGULAR", true],
      ]);
      // The same row with a listed Regular product costs the same as the free name.
      expect(Number(parcels[0].totalCharge)).toBe(Number(parcels[2].totalCharge));

      // Banking & Financial keeps its list.
      const { owner: bank } = await merchant("BANKING_FINANCIAL");
      const doc = await upload(bank.token, { kind: "document" }, { name: "docs.csv", data: csv([["Recipient name", "Recipient phone", "Delivery address", "District", "Zone", "Product"], ["Mahir", "01712345678", "House 1, Road 2, Dhanmondi", "Dhaka Central", "Dhanmondi", "Spaceships"]]) });
      expect(doc.body.counts).toMatchObject({ errors: 1 });
    });

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
      expect(complete).toMatchObject({ merchantOrderRef: "ORD-1", incomplete: false, deliveryZone: "Dhanmondi", channel: "MERCHANT_PORTAL", importJobId: res.body.id, productName: "Fashion & Apparel", packaging: null, receiverRelation: null, originBranchCode: null });
      // Service packages v2: Dhaka → Dhaka (same district) 70 + 2 kg (1.5 started kg over 0.5 → 2 × 15) + Express 40 + COD fee 15.
      expect(Number(complete.totalCharge)).toBe(155);
      expect(incomplete).toMatchObject({ incomplete: true, missingFields: ["address", "district", "zone"], deliveryDistrict: null, deliveryZone: null, deliveryStreet: null, recipientPhone: "+8801712345678" });
      // Missing destination: priced inside the merchant's own district, 0.5 kg, Regular.
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

  describe("customer parcels (operations)", () => {
    it("imports walk-in / website customer parcels end to end: sender and pickup per row, the Customer package, no merchant", async () => {
      const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops");
      const file = csv([
        CUSTOMER_HEADER,
        customerRow({ "Reference no.": "WALK-1" }), // 2 valid
        customerRow({ "Reference no.": "WALK-2", "Sender phone": "01711000002", "Recipient name": "", "Delivery address": "", "Delivery district": "", "Delivery zone": "" }), // 3 needs info
        customerRow({ "Reference no.": "WALK-3", "Sender phone": "" }), // 4 sender phone required
        customerRow({ "Reference no.": "WALK-4", "Pickup zone": "Dhanmondi" }), // 5 not a zone of the pickup district
        customerRow({ "Reference no.": "WALK-5", Service: "Same day" }), // 6
        customerRow({ "Reference no.": "WALK-6", Service: "B2B Document" }), // 7 a Banking & Financial service
      ]);
      const res = await upload(ops.token, { kind: "customer" }, { name: "walkins.csv", data: file });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({ kind: "customer", kindLabel: "Customer parcel", source: "OPERATIONS", merchant: null, counts: { rows: 6, valid: 1, incomplete: 1, errors: 4 } });
      const rows = (await allRows(ops.token, res.body.id)).items;
      expect(rows[0]).toMatchObject({ status: "VALID", charge: P.sameDistrict + P.extraKg + Math.max(P.codMin, (500 * P.codPercent) / 100) });
      expect(rows[1]).toMatchObject({ status: "INCOMPLETE", missing: ["recipientName", "address", "district", "zone"], charge: P.sameDistrict + P.extraKg + Math.max(P.codMin, (500 * P.codPercent) / 100) });
      expect(rows[2].errors[0]).toMatchObject({ column: "sender_phone", text: "Row 4 · Sender phone: required" });
      expect(rows[3].errors[0]).toMatchObject({ column: "pickup_zone", message: '"Dhanmondi" is not a zone of Dhaka North' });
      expect(rows[4].errors[0].message).toMatch(/^"Same day" is not a service option: choose one from the list \(Regular, Express\)/);
      expect(rows[5].errors[0].message).toBe('"B2B Document" is not an option (Regular, Express)');

      const commit = await ctx.api("POST", `/imports/${res.body.id}/commit`, { token: ops.token });
      expect(commit.body).toMatchObject({ status: "COMPLETED", result: { created: 2, createdIncomplete: 1 } });
      const parcels = await ctx.prisma.parcel.findMany({ where: { importJobId: res.body.id }, orderBy: { merchantOrderRef: "asc" } });
      expect(parcels.map(p => [p.merchantOrderRef, p.merchantId, p.channel, p.senderName, p.senderPhone, p.pickupDistrict, p.pickupZone, p.incomplete])).toEqual([
        ["WALK-1", null, "OPERATIONS", "Karim Hossain", "+8801711000001", "Dhaka North", "Gulshan", false],
        ["WALK-2", null, "OPERATIONS", "Karim Hossain", "+8801711000002", "Dhaka North", "Gulshan", true],
      ]);
      expect(parcels[0]).toMatchObject({ productName: "Books", productType: "BOOKS", type: "PARCEL", deliveryZone: "Banani" });
      expect((await ctx.prisma.importJob.findUniqueOrThrow({ where: { id: res.body.id } })).kind).toBe("CUSTOMER");
      const history = await ctx.api("GET", "/imports?kind=customer", { token: ops.token });
      expect(history.body.items.map((i: { id: string }) => i.id)).toEqual([res.body.id]);

      // The same file again books nothing twice.
      const again = await upload(ops.token, { kind: "customer" }, { name: "walkins.csv", data: file });
      const againRows = (await allRows(ops.token, again.body.id)).items;
      expect(againRows[0].errors[0].message).toBe(`WALK-1 was already booked as ${parcels[0].trackingId}`);
      // Merchants can't import customer parcels; operations can't give them a merchant.
      const { m, owner } = await merchant();
      expect((await upload(owner.token, { kind: "customer" }, { name: "c.csv", data: file })).status).toBe(403);
      const withMerchant = await upload(ops.token, { kind: "customer", merchantId: m.id }, { name: "c.csv", data: file });
      expect(withMerchant.status).toBe(422);
      expect(withMerchant.body.error.message).toContain("Customer parcels have no merchant");
    });
  });

  describe("super admin settings", () => {
    it("change required columns and defaults for the three templates and validation at once, audited", async () => {
      const { owner } = await merchant();
      const { token } = await admin();
      expect((await ctx.api("PUT", "/imports/config", { token: owner.token, body: {} })).status).toBe(403);
      const config = (await ctx.api("GET", "/imports/config", { token: owner.token })).body;
      expect(Object.keys(config.templates)).toEqual(["ecommerce", "document", "customer"]);
      expect(config.titles).toEqual({ ecommerce: "E-commerce", document: "Banking & Financial", customer: "Customer parcel" });
      for (const kind of ["ecommerce", "document", "customer"]) for (const c of config.templates[kind]) expect(REMOVED).not.toContain(c.header);
      expect(config.templates.customer.find((c: { key: string }) => c.key === "sender_phone")).toMatchObject({ required: true, configurable: false });
      expect(config.templates.ecommerce.find((c: { key: string }) => c.key === "open_box")).toMatchObject({ packageOnly: "openBox" });

      const row = ecom({ "Order ID": "CFG-1", "Customer name": "A", "Customer phone": "01812000000", "Delivery address": "Road 1" });
      const before = await upload(owner.token, { kind: "ecommerce" }, { name: "a.csv", data: csv([ECOM_HEADER, row]) });
      expect(before.body.counts).toMatchObject({ incomplete: 1, errors: 0 });

      const bad = await ctx.api("PUT", "/imports/config", { token, body: { templates: { ecommerce: { service_level: { default: "Rocket" } } } } });
      expect(bad.status).toBe(422);
      expect(bad.body.error.message).toContain("E-commerce template, Service default");
      expect((await ctx.api("PUT", "/imports/config", { token, body: { templates: { ecommerce: { packaging: { default: "Poly mailer" } } } } })).body.error.message).toBe('E-commerce template: unknown column "packaging"');
      expect((await ctx.api("PUT", "/imports/config", { token, body: { templates: { ecommerce: { recipient_phone: { required: false } } } } })).body.error.message).toBe('E-commerce template: "Customer phone" is always required');
      expect((await ctx.api("PUT", "/imports/config", { token, body: { limits: { merchantMaxRows: 50_000 } } })).status).toBe(422);
      const saved = await ctx.api("PUT", "/imports/config", {
        token,
        body: { templates: { ecommerce: { district: { required: true }, recipient_name: { required: false }, service_level: { default: "Express" } }, customer: { recipient_name: { required: true } } } },
      });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect(saved.body.templates.ecommerce.find((c: { key: string }) => c.key === "district")).toMatchObject({ required: true });
      expect(saved.body.templates.customer.find((c: { key: string }) => c.key === "recipient_name")).toMatchObject({ required: true });
      expect(await ctx.prisma.auditLog.count({ where: { action: "import_config.update" } })).toBe(1);

      const after = await upload(owner.token, { kind: "ecommerce" }, { name: "a.csv", data: csv([ECOM_HEADER, row, ecom({ "Order ID": "CFG-2", "Customer phone": "01812000000", District: "Dhaka North", Zone: "Banani" })]) });
      const rows = (await allRows(owner.token, after.body.id)).items;
      expect(rows[0].errors[0]).toMatchObject({ column: "district", message: "required", text: "Row 2 · District: required" });
      expect(rows[1].status).toBe("INCOMPLETE");
      await ctx.api("POST", `/imports/${after.body.id}/commit`, { token: owner.token });
      expect((await ctx.prisma.parcel.findFirstOrThrow({ where: { merchantOrderRef: "CFG-2" } })).speedOption).toBe("EXPRESS"); // Express = same day (serviceLevel SAME_DAY)
      const t = await template(owner.token, "/imports/templates/ecommerce");
      // District isn't a template column (found from the address); the required setting still applies to files that have it or not.
      expect(t.header).not.toContain("District *");
      expect(t.header).toContain("Customer name");
      expect(t.help.find(l => l.startsWith("Service | No | Regular, Express (the services in Shop ") && l.includes("'s service package) | Express | Regular |"))).toBeTruthy();
      const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops");
      expect((await template(ops.token, "/imports/templates/customer")).header).toContain("Recipient name *");
    });

    it("drops the stored settings of removed columns once, audited", async () => {
      await ctx.prisma.setting.upsert({
        where: { key: "import-config" },
        create: {
          key: "import-config",
          value: {
            templates: {
              ecommerce: { merchant: { required: true }, parcel_type: { default: "Fragile parcel" }, packaging: { default: "Poly mailer" }, district: { required: true }, weight_kg: { default: "1" } },
              document: { receiver_relationship: { default: "Self" }, branch_code: { required: true }, document_type: { required: true }, address_type: { default: "Office" }, recipient_phone: { required: false } },
            },
            limits: { merchantMaxRows: 3000 },
          },
        },
        update: {},
      });
      const service = ctx.app.get(ImportConfigService);
      const removed = await service.migrateStored();
      expect(removed.sort()).toEqual(
        ["ecommerce.merchant", "ecommerce.parcel_type", "ecommerce.packaging", "document.receiver_relationship", "document.branch_code", "document.document_type", "document.address_type", "document.recipient_phone.required"].sort(),
      );
      const stored = (await ctx.prisma.setting.findUniqueOrThrow({ where: { key: "import-config" } })).value as { templates: Record<string, Record<string, unknown>>; limits: unknown };
      expect(stored.templates).toEqual({ ecommerce: { district: { required: true }, weight_kg: { default: "1" } }, document: {} });
      expect(stored.limits).toEqual({ merchantMaxRows: 3000 });
      expect(await ctx.prisma.auditLog.count({ where: { action: "import_config.migrate" } })).toBe(1);
      expect(await service.migrateStored()).toEqual([]);
      expect(await ctx.prisma.auditLog.count({ where: { action: "import_config.migrate" } })).toBe(1);
      // The kept settings still apply (district required: a row whose address names no district is refused).
      const { owner } = await merchant();
      const res = await upload(owner.token, { kind: "ecommerce" }, { name: "a.csv", data: csv([ECOM_HEADER, ecom({ "Order ID": "KEPT-1", "Customer phone": "01812000000", "Delivery address": "Road 1" })]) });
      expect((await allRows(owner.token, res.body.id)).items[0].errors[0]).toMatchObject({ column: "district", message: "required" });
    });
  });

  describe("failed rows", () => {
    it("download as .xlsx in the template format with an Error column (or CSV), ready to fix and upload again", async () => {
      const { owner } = await merchant();
      const res = await upload(owner.token, { kind: "ecommerce" }, { name: "x.csv", data: csv([ECOM_HEADER, full("OK-1"), full("BAD-1", { "Customer phone": "999", District: "Nowhere", Zone: "" })]) });
      await ctx.api("POST", `/imports/${res.body.id}/commit`, { token: owner.token });
      const file = await download(owner.token, `/imports/${res.body.id}/failed-rows`);
      expect(file.status).toBe(200);
      expect(file.headers["content-type"]).toBe(XLSX);
      const sheet = readXlsx(file.buffer, { maxRows: 100 });
      expect(sheet.sheetName).toBe("Orders");
      expect(sheet.rows[0].at(-1)).toBe("Error");
      expect(sheet.rows).toHaveLength(2);
      expect(sheet.rows[1][sheet.rows[0].indexOf("Order ID")]).toBe("BAD-1");
      expect(sheet.rows[1].at(-1)).toBe('Row 3: Customer phone: bangladeshi mobile numbers start with 1 (e.g. 17XXXXXXXX); District: unknown district "Nowhere" (use one from the list)');
      const zip = readZip(file.buffer, { maxBytes: 50_000_000 });
      expect(zip.get("xl/workbook.xml")!.toString()).toContain('<sheet name="Lists"');
      // A file carrying rows keeps district / zone / area, with the zone dropdown following the district (IF, never IFERROR).
      const header = sheet.rows[0] as string[];
      const d = String.fromCharCode(65 + header.indexOf("District"));
      const data = zip.get("xl/worksheets/sheet1.xml")!.toString();
      expect(data).toContain(`IF($${d}2=&quot;&quot;,L_zones,INDIRECT(&quot;ZN_&quot;&amp;MATCH($${d}2,L_districts,0)))`);
      expect(data).not.toContain("IFERROR");
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
      // Two identical rows without an order ID in one file: the later one is flagged, naming the first.
      const twins = await upload(owner.token, { kind: "ecommerce" }, { name: "b.csv", data: csv([ECOM_HEADER, full("", { "Customer name": "Twin" }), full("", { "Customer name": "Twin" })]) });
      expect(twins.body.counts).toMatchObject({ valid: 1, errors: 1 });
      expect((await allRows(owner.token, twins.body.id, "error")).items[0].errors[0].message).toBe("the same order as row 2 (identical details); add an order ID to book both");
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
      const { token } = await admin();
      expect((await ctx.api("GET", "/imports/limits", { token: owner.token })).body).toMatchObject({ maxRows: 5000, maxFileMb: 10, forOps: false });
      await ctx.api("PUT", "/imports/config", { token, body: { limits: { merchantMaxRows: 3, maxFileMb: 0.1 } } });
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

  describe("any merchant's file (Courier Operations)", () => {
    async function analyze(token: string, fields: Record<string, string>, file: { name: string; data: Buffer }) {
      const body = multipart(fields, file);
      const res = await ctx.app.inject({ method: "POST", url: "/api/v1/imports/analyze", payload: body.payload, headers: { ...body.headers, authorization: `Bearer ${token}` } });
      return { status: res.statusCode, body: JSON.parse(res.body) };
    }
    const messy = () =>
      csv([
        ["Rahim Fashion House · order sheet"],
        [],
        ["SL", "Invoice No", "Customer", "Mobile No.", "Shipping Address", "Collectable Amount", "Delivery charge"],
        ["1", "INV-1", "Ayesha Rahman", "01712345678", "House 22, Road 7, Gulshan 1, Dhaka North", "1,450", "60"],
        ["2", "INV-2", "Kamal Hossain", "1812345678", "Flat 3B, Road 2, Gulshan, Dhaka North", "890", "60"],
        ["", "", "", "", "Total", "2,340", "120"],
      ]);

    it("finds the header row and the columns, books with a corrected matching, and matches the merchant's next file the same way", async () => {
      const { m: shop, owner } = await merchant();
      const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops");
      const file = { name: "rahim.csv", data: messy() };

      const guess = await analyze(ops.token, { kind: "ecommerce", merchantId: shop.id }, file);
      expect(guess.status, JSON.stringify(guess.body)).toBe(200);
      expect(guess.body).toMatchObject({ headerRow: 3, orders: 2, extraLines: 1, remembered: false });
      expect(guess.body.columns.map((c: { header: string; key: string | null }) => [c.header, c.key])).toEqual([
        ["SL", null],
        ["Invoice No", "order_ref"],
        ["Customer", "recipient_name"],
        ["Mobile No.", "recipient_phone"],
        ["Shipping Address", "address"],
        ["Collectable Amount", "cod_amount"],
        ["Delivery charge", null],
      ]);
      // Merchants keep the template upload.
      expect((await analyze(owner.token, { kind: "ecommerce", merchantId: shop.id }, file)).status).toBe(403);

      // Matched automatically: two orders, the totals line skipped.
      const auto = await upload(ops.token, { kind: "ecommerce", merchantId: shop.id }, file);
      expect(auto.status, JSON.stringify(auto.body)).toBe(201);
      expect(auto.body).toMatchObject({ counts: { valid: 2 }, skippedLines: { count: 1, rows: [6] }, ignoredColumns: ["SL", "Delivery charge"] });
      const first = await ctx.prisma.importRow.findFirstOrThrow({ where: { jobId: auto.body.id, rowNumber: 4 } });
      expect(first.cells).toMatchObject({ order_ref: "INV-1", recipient_name: "Ayesha Rahman", recipient_phone: "01712345678", cod_amount: "1,450", district: "Dhaka North" });

      // The user's matching: the amount is the product value, not cash to collect.
      const mapping = JSON.stringify({ headerRow: 3, columns: [null, "order_ref", "recipient_name", "recipient_phone", "address", "declared_value", null] });
      const fixed = await upload(ops.token, { kind: "ecommerce", merchantId: shop.id, mapping }, file);
      expect(fixed.status, JSON.stringify(fixed.body)).toBe(201);
      const row = await ctx.prisma.importRow.findFirstOrThrow({ where: { jobId: fixed.body.id, rowNumber: 4 } });
      expect(row.cells).toMatchObject({ declared_value: "1,450" });
      expect((row.cells as Record<string, string>).cod_amount).toBeUndefined();

      // The next file with these headers is matched as last time.
      const again = await analyze(ops.token, { kind: "ecommerce", merchantId: shop.id }, file);
      expect(again.body.remembered).toBe(true);
      expect(again.body.columns.find((c: { header: string }) => c.header === "Collectable Amount")).toMatchObject({ key: "declared_value", by: "saved" });

      // A matching without the phone column, or with a field twice, is refused.
      const noPhone = await upload(ops.token, { kind: "ecommerce", merchantId: shop.id, mapping: JSON.stringify({ headerRow: 3, columns: [null, "order_ref", "recipient_name", null, "address"] }) }, file);
      expect(noPhone.body.error).toMatchObject({ code: "COLUMN_MAPPING_INCOMPLETE", message: "Choose the file's Customer phone column: no column is matched to it." });
      const twice = await upload(ops.token, { kind: "ecommerce", merchantId: shop.id, mapping: JSON.stringify({ headerRow: 3, columns: [null, "order_ref", "recipient_phone", "recipient_phone"] }) }, file);
      expect(twice.body.error.code).toBe("COLUMN_MAPPING_INVALID");
    });
  });

  describe("operations and API keys", () => {
    it("operations choose the merchant in the modal (no per-row merchant) and drop-off at a hub: batch, labels and receive desk", async () => {
      const shop = await merchant();
      const bank = await merchant("BANKING_FINANCIAL");
      const gulshan = await hub(ctx, "HUB-OPS");
      const hubOp = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: gulshan.id }], "Gulshan Operator");
      // An old file with a Merchant column: the column is ignored, the merchant comes from the modal.
      const header = ["Merchant", ...ECOM_HEADER];
      const data = csv([header, [bank.m.code, ...full("OPS-1")], [shop.m.code, ...ecom({ "Order ID": "OPS-2", "Customer name": "No Address Yet", "Customer phone": "01812000003" })], ["", ...full("OPS-3", { Service: "Same day" })]]);
      const noMerchant = await upload(hubOp.token, { kind: "ecommerce", intake: "DROP_OFF" }, { name: "dropoff.csv", data });
      expect(noMerchant.status).toBe(422);
      expect(noMerchant.body.error).toMatchObject({ code: "MERCHANT_REQUIRED", message: "Choose the E-commerce merchant for this file" });
      const wrong = await upload(hubOp.token, { kind: "ecommerce", merchantId: bank.m.id }, { name: "dropoff.csv", data });
      expect(wrong.body.error).toMatchObject({ code: "WRONG_TEMPLATE", message: `${bank.m.name} is a Banking & Financial merchant: use the Banking & Financial template` });
      const res = await upload(hubOp.token, { kind: "ecommerce", merchantId: shop.m.id, intake: "DROP_OFF" }, { name: "dropoff.csv", data });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({ source: "OPERATIONS", merchant: { id: shop.m.id }, intake: "DROP_OFF", dropOffHub: { id: gulshan.id }, counts: { valid: 1, incomplete: 1, errors: 1 }, ignoredColumns: ["Merchant"] });
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

      // Banking & Financial for the merchant chosen in the modal.
      const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops");
      const perFile = await upload(ops.token, { kind: "banking", merchantId: bank.m.id }, {
        name: "bank.csv",
        data: csv([["Reference no.", "Recipient name", "Recipient phone", "Service"], ["B-1", "Mahir", "01819123205", "B2B Document"]]),
      });
      expect(perFile.body).toMatchObject({ kind: "document", merchant: { id: bank.m.id }, counts: { incomplete: 1 } });
      expect((await upload(ops.token, { kind: "ecommerce", merchantId: shop.m.id, intake: "DROP_OFF" }, { name: "x.csv", data: csv([ECOM_HEADER, full("Z")]) })).body.error.code).toBe("HUB_REQUIRED");
      // Merchants choose drop at hub in the import modal when their package offers it (service packages): with a hub.
      expect((await upload(shop.owner.token, { kind: "ecommerce", intake: "DROP_OFF" }, { name: "x.csv", data: csv([ECOM_HEADER, full("Z")]) })).body.error.code).toBe("HUB_REQUIRED");
      // The modal's choices are checked against the chosen merchant's package (operations too).
      const { token } = await admin();
      await packageFor(token, shop.m.id, "ECOMMERCE", "No drop at hub", ["first.hub_drop"]);
      const refused = await upload(ops.token, { kind: "ecommerce", merchantId: shop.m.id, intake: "DROP_OFF", dropOffHubId: gulshan.id }, { name: "x.csv", data: csv([ECOM_HEADER, full("Z")]) });
      expect(refused.body.error).toMatchObject({ code: "SERVICE_NOT_IN_PACKAGE", message: "SERVICE_NOT_IN_PACKAGE: Merchant drop at hub" });
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
