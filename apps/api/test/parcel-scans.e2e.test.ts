import fs from "node:fs";
import path from "node:path";
import { PricingService } from "../src/modules/pricing/pricing.service";
import { ParcelScansService } from "../src/modules/parcel-scans/parcel-scans.service";
import { readXlsx } from "../src/modules/imports/xlsx/xlsx-reader";
import { resetDatabase, startApp, userWithRoles, type TestContext } from "./helpers";

const LABEL = fs.readFileSync(path.join(__dirname, "fixtures", "scan-label.png"));

/**
 * "Scan with phone" (Courier Operations › New orders): a session's one-time link takes photos from a
 * phone while the modal is open; each photo is read (OCR) into order fields, edited, exported and
 * re-imported as the import template, and booked by the import engine with its photo.
 */
describe("parcel scans", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  const shop = () =>
    ctx.prisma.merchant.create({
      data: { code: "MR-SCAN", type: "ECOMMERCE", name: "Shop Bari", status: "ACTIVE", kycStatus: "APPROVED", contactName: "Owner", contactPhone: "+8801711111111", pickupAddress: "House 5 Road 2", pickupArea: "Gulshan 1", pickupDistrict: "Dhaka North" },
    });

  function multipart(field: string, file: { name: string; data: Buffer; type: string }) {
    const boundary = `----dfScan${Math.random().toString(16).slice(2)}`;
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`),
      file.data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return { payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
  }
  async function send(method: "POST", url: string, field: string, file: { name: string; data: Buffer; type: string }, token?: string, extra: Record<string, string> = {}) {
    const body = multipart(field, file);
    if (Object.keys(extra).length) {
      // Form fields before the file (the imports endpoint reads them).
      const boundary = body.headers["content-type"].split("boundary=")[1];
      body.payload = Buffer.concat([...Object.entries(extra).map(([k, v]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)), body.payload]);
    }
    const res = await ctx.app.inject({ method, url: `/api/v1${url}`, payload: body.payload, headers: { ...body.headers, ...(token ? { authorization: `Bearer ${token}` } : {}) } });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
  }
  const download = (url: string, token: string) => ctx.app.inject({ method: "GET", url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` } });

  it("phone link → photo read into fields → edited → Excel out and back → booked with its photo; the link dies with the modal", async () => {
    const merchant = await shop();
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops");
    const other = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Other ops");

    // ── The modal opens a session: link + QR code ──
    expect((await ctx.api("POST", "/parcel-scans/sessions", { token: ops.token, body: { kind: "ecommerce" } })).body.error.code).toBe("MERCHANT_REQUIRED");
    const opened = await ctx.api("POST", "/parcel-scans/sessions", { token: ops.token, body: { kind: "ecommerce", merchantId: merchant.id } });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    expect(opened.body).toMatchObject({ kind: "ecommerce", kindLabel: "E-commerce", merchant: { name: "Shop Bari" }, open: true, scans: [] });
    expect(opened.body.qrSvg).toMatch(/^<svg/);
    const token = String(opened.body.url).split("/scan/")[1];
    expect(token).toMatch(/^[\w-]{30,}$/);
    const sessionId = opened.body.id;
    // Only the person who opened it sees the session.
    expect((await ctx.api("GET", `/parcel-scans/sessions/${sessionId}`, { token: other.token })).status).toBe(404);

    // ── The phone: the page, then a photo ──
    const page = await ctx.api("GET", `/parcel-scans/public/${token}`);
    expect(page.body).toMatchObject({ kindLabel: "E-commerce", merchantName: "Shop Bari", photos: 0 });
    expect((await send("POST", `/parcel-scans/public/${token}/photos`, "photo", { name: "notes.txt", data: Buffer.from("not an image"), type: "text/plain" })).status).toBe(415);
    const sent = await send("POST", `/parcel-scans/public/${token}/photos`, "photo", { name: "label.png", data: LABEL, type: "image/png" });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect(sent.body).toEqual({ number: 1, status: "READING" });

    // ── Read in the background (workers are off in tests: run the job) ──
    let session = (await ctx.api("GET", `/parcel-scans/sessions/${sessionId}`, { token: ops.token })).body;
    const scanId = session.scans[0].id;
    await ctx.app.get(ParcelScansService).read(scanId);
    session = (await ctx.api("GET", `/parcel-scans/sessions/${sessionId}`, { token: ops.token })).body;
    expect(session.scans[0]).toMatchObject({ number: 1, status: "READ", hasPhoto: true });
    expect(session.scans[0].cells).toMatchObject({ recipient_name: "Rahim Uddin", recipient_phone: "01712345678", cod_amount: "1250", weight_kg: "1.5", order_ref: "INV-2045" });
    const photo = await download(`/parcel-scans/scans/${scanId}/photo`, ops.token);
    expect(photo.statusCode).toBe(200);
    expect(photo.headers["content-type"]).toBe("image/png");

    // ── Edited in the modal: a place from the catalog ──
    const catalog = await ctx.app.get(PricingService).catalog();
    const district = catalog.districts[0];
    const zone = catalog.zonesByDistrict[district][0];
    expect((await ctx.api("PATCH", `/parcel-scans/sessions/${sessionId}/scans/${scanId}`, { token: ops.token, body: { cells: { merchant: "x" } } })).status).toBe(422);
    const edited = await ctx.api("PATCH", `/parcel-scans/sessions/${sessionId}/scans/${scanId}`, { token: ops.token, body: { cells: { district, zone, recipient_name: "Rahim Uddin Khan" } } });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.cells).toMatchObject({ district, zone, recipient_name: "Rahim Uddin Khan", recipient_phone: "01712345678" });

    // ── Excel out: the template with a Scan ID column ──
    const out = await download(`/parcel-scans/sessions/${sessionId}/workbook`, ops.token);
    expect(out.statusCode, out.body).toBe(200);
    const sheet = readXlsx(out.rawPayload, { maxRows: 100, prefer: ["Orders"] });
    const header = sheet.rows[0].map(h => String(h).replace(/ \*$/, ""));
    expect(header.at(-1)).toBe("Scan ID");
    expect(sheet.rows[1].at(-1)).toBe(scanId);
    expect(sheet.rows[1][header.indexOf("Customer phone")]).toBe("01712345678");

    // ── Excel back in: the row changed by Scan ID, a row added in Excel becomes a new row ──
    const csv = [
      ["Customer name", "Customer phone", "Delivery address", "District", "Zone", "COD amount (৳)", "Scan ID"],
      ["Rahim U. Khan", "01712345678", "House 12, Road 5", district, zone, "1300", scanId],
      ["Karim Mia", "01812345678", "Village Road 2", district, zone, "500", ""],
    ]
      .map(r => r.map(v => `"${v.replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const back = await send("POST", `/parcel-scans/sessions/${sessionId}/workbook`, "file", { name: "edited.csv", data: Buffer.from(csv), type: "text/csv" }, ops.token);
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body).toMatchObject({ updated: 1, added: 1, skipped: 0 });
    expect(back.body.session.scans.map((s: { number: number; hasPhoto: boolean; cells: Record<string, string> }) => [s.number, s.hasPhoto, s.cells.recipient_name, s.cells.cod_amount])).toEqual([
      [1, true, "Rahim U. Khan", "1300"],
      [2, false, "Karim Mia", "500"],
    ]);

    // ── Submit: the workbook goes through the import engine; the booked parcel keeps its photo ──
    const workbook = (await download(`/parcel-scans/sessions/${sessionId}/workbook`, ops.token)).rawPayload;
    const validated = await send("POST", "/imports/validate", "file", { name: "scanned.xlsx", data: workbook, type: "application/octet-stream" }, ops.token, { kind: "ecommerce", merchantId: merchant.id });
    expect(validated.status, JSON.stringify(validated.body)).toBe(201);
    expect(validated.body.summary ?? validated.body).toBeTruthy();
    const commit = await ctx.api("POST", `/imports/${validated.body.id}/commit`, { token: ops.token });
    expect(commit.status, JSON.stringify(commit.body)).toBe(200);
    expect(commit.body.result.created).toBe(2);
    const linked = await ctx.prisma.parcelScan.findUniqueOrThrow({ where: { id: scanId }, include: { parcel: { select: { recipientName: true } } } });
    expect(linked.parcel?.recipientName).toBe("Rahim U. Khan");
    session = (await ctx.api("GET", `/parcel-scans/sessions/${sessionId}`, { token: ops.token })).body;
    expect(session.scans[0].trackingId).toMatch(/^[A-Z]{2}-/);
    // A booked row can't be changed or removed (its photo stays with the parcel).
    expect((await ctx.api("DELETE", `/parcel-scans/sessions/${sessionId}/scans/${scanId}`, { token: ops.token })).status).toBe(409);

    // ── Closing the modal ends the link ──
    expect((await ctx.api("POST", `/parcel-scans/sessions/${sessionId}/keepalive`, { token: ops.token })).status).toBe(200);
    expect((await ctx.api("DELETE", `/parcel-scans/sessions/${sessionId}`, { token: ops.token })).status).toBe(204);
    expect((await ctx.api("GET", `/parcel-scans/public/${token}`)).body.error.code).toBe("SCAN_LINK_EXPIRED");
    expect((await send("POST", `/parcel-scans/public/${token}/photos`, "photo", { name: "label.png", data: LABEL, type: "image/png" })).status).toBe(410);
    expect((await ctx.api("POST", `/parcel-scans/sessions/${sessionId}/keepalive`, { token: ops.token })).status).toBe(410);
    expect((await ctx.api("GET", "/parcel-scans/public/not-a-real-token-at-all-1234")).status).toBe(410);
    // Audited.
    const actions = (await ctx.prisma.auditLog.findMany({ where: { action: { startsWith: "parcel_scan." } }, select: { action: true } })).map(a => a.action);
    expect(actions).toEqual(expect.arrayContaining(["parcel_scan.session_open", "parcel_scan.photo", "parcel_scan.update", "parcel_scan.workbook_import", "parcel_scan.session_close"]));
  });

  it("an unused link expires on its own, and photos of rows never booked are deleted after 7 days", async () => {
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops");
    const opened = await ctx.api("POST", "/parcel-scans/sessions", { token: ops.token, body: { kind: "customer" } });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const token = String(opened.body.url).split("/scan/")[1];
    expect((await send("POST", `/parcel-scans/public/${token}/photos`, "photo", { name: "label.png", data: LABEL, type: "image/png" })).status).toBe(201);

    // The modal stopped extending it (tab closed without saying so).
    await ctx.prisma.parcelScanSession.update({ where: { id: opened.body.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await ctx.api("GET", `/parcel-scans/public/${token}`)).status).toBe(410);

    const scan = await ctx.prisma.parcelScan.findFirstOrThrow({ where: { sessionId: opened.body.id } });
    const service = ctx.app.get(ParcelScansService);
    expect(await service.cleanup()).toEqual({ scans: 0, sessions: 0 });
    await ctx.prisma.parcelScan.update({ where: { id: scan.id }, data: { createdAt: new Date(Date.now() - 8 * 86_400_000) } });
    await ctx.prisma.parcelScanSession.update({ where: { id: opened.body.id }, data: { createdAt: new Date(Date.now() - 8 * 86_400_000) } });
    expect(await service.cleanup()).toEqual({ scans: 1, sessions: 1 });
    expect(await ctx.prisma.storedFile.count({ where: { id: scan.fileId! } })).toBe(0);
  });
});
