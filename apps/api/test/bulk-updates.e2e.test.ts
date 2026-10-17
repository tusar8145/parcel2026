import { vi } from "vitest";
import { RealtimeService, type RealtimeEvent } from "../src/common/realtime.service";
import { BulkUpdatesService } from "../src/modules/bulk-updates/bulk-updates.service";
import { ImportJobsService } from "../src/modules/imports/import-jobs.service";
import { readZip } from "../src/modules/imports/xlsx/zip";
import { readXlsx } from "../src/modules/imports/xlsx/xlsx-reader";
import { writeXlsx } from "../src/modules/imports/xlsx/xlsx-writer";
import { hub, parcelBody, resetDatabase, riderUser, startApp, userWithRoles, type TestContext } from "./helpers";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Bulk operations by Excel: download the filtered parcels, fill in actions, upload, preview, apply. */
describe("bulk updates", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  const setup = async () => {
    const gulshan = await hub(ctx, "HUB-GUL");
    const dhanmondi = await hub(ctx, "HUB-DHN");
    // Pickup requests in Gulshan belong to the Gulshan hub's work (hub operators' scope, suggestions).
    await ctx.prisma.deliveryZone.create({ data: { code: "DN-GUL", name: "Gulshan", district: "Dhaka North", hubId: gulshan.id } });
    const shop = await ctx.prisma.merchant.create({
      data: {
        code: "MR-4001",
        type: "ECOMMERCE",
        name: "Bulk Shop",
        status: "ACTIVE",
        contactName: "Owner",
        contactPhone: "+8801911000000",
        pickupAddress: "House 5 Road 2",
        pickupArea: "Gulshan",
        pickupDistrict: "Dhaka North",
      },
    });
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops Manager");
    const hubOp = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: gulshan.id }], "Gulshan Operator");
    const rider = await riderUser(ctx, "R-4048", gulshan.id);
    const other = await riderUser(ctx, "R-4050", dhanmondi.id);
    await ctx.prisma.rider.updateMany({ where: { id: { in: [rider.rider.id, other.rider.id] } }, data: { status: "ONLINE" } });
    return { gulshan, dhanmondi, shop, ops, hubOp, rider, other };
  };
  type Setup = Awaited<ReturnType<typeof setup>>;

  const book = async (s: Setup, extra: Record<string, unknown> = {}) => {
    const res = await ctx.api("POST", "/ops/parcels", { token: s.ops.token, body: { merchantId: s.shop.id, ...parcelBody(), sender: undefined, pickup: undefined, ...extra } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.trackingId as string;
  };
  const status = (token: string, id: string, body: Record<string, unknown>) => ctx.api("POST", `/parcels/${id}/status`, { token, body });
  /** A parcel received at a hub after pickup. */
  const atHub = async (s: Setup, hubId = s.gulshan.id) => {
    const id = await book(s);
    const rider = hubId === s.dhanmondi.id ? s.other : s.rider;
    expect((await ctx.api("POST", `/parcels/${id}/assign-pickup`, { token: s.ops.token, body: { riderId: rider.rider.id } })).status).toBe(200);
    expect((await status(s.ops.token, id, { status: "PICKED_UP" })).status).toBe(200);
    expect((await status(s.ops.token, id, { status: "AT_HUB", hubId })).status).toBe(200);
    return id;
  };
  /** An import row booked without recipient name, address or destination ("Needs info"). */
  const incomplete = async (s: Setup, ref: string) => {
    const checked = await ctx.api("POST", "/imports/validate", { token: s.ops.token, body: { kind: "ecommerce", merchantId: s.shop.id, rows: [{ order_ref: ref, phone: "01812000000" }] } });
    expect(checked.body.counts).toMatchObject({ incomplete: 1 });
    await ctx.api("POST", `/imports/${checked.body.id}/commit`, { token: s.ops.token });
    return (await ctx.prisma.parcel.findFirstOrThrow({ where: { merchantOrderRef: ref } })).trackingId;
  };

  async function download(token: string, url: string) {
    const res = await ctx.app.inject({ method: "GET", url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` } });
    return { status: res.statusCode, headers: res.headers, buffer: res.rawPayload, body: res.statusCode >= 400 ? JSON.parse(res.body) : undefined };
  }
  function multipart(file: { name: string; data: Buffer }) {
    const boundary = `----dfBulk${Math.random().toString(16).slice(2)}`;
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${XLSX}\r\n\r\n`),
      file.data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return { payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
  }
  async function upload(token: string, data: Buffer, name = "bulk.xlsx", kind?: string) {
    const body = multipart({ name, data });
    const res = await ctx.app.inject({ method: "POST", url: `/api/v1/bulk-updates/validate${kind ? `?kind=${kind}` : ""}`, payload: body.payload, headers: { ...body.headers, authorization: `Bearer ${token}` } });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  }

  /** The exported sheet as rows, with helpers to fill in actions and write it back. */
  async function exported(token: string, query = "") {
    const res = await download(token, `/bulk-updates/export${query}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const sheet = readXlsx(res.buffer, { maxRows: 20_000, prefer: ["Parcels"] });
    const header = sheet.rows[0];
    const rows = sheet.rows.slice(1).map(r => header.map((_, i) => r[i] ?? ""));
    const col = (name: string) => {
      const i = header.indexOf(name);
      if (i < 0) throw new Error(`no column ${name}`);
      return i;
    };
    const ids = rows.map(r => r[col("Tracking ID")]);
    const row = (id: string) => {
      const r = rows.find(x => x[col("Tracking ID")] === id);
      if (!r) throw new Error(`${id} not exported`);
      return r;
    };
    const set = (id: string, values: Record<string, string>) => {
      const r = row(id);
      for (const [k, v] of Object.entries(values)) r[col(k)] = v;
    };
    const file = (only?: string[]) => writeXlsx({ sheets: [{ name: "Parcels", rows: [header, ...rows.filter(r => !only || only.includes(r[col("Tracking ID")]))] }] });
    return { res, header, rows, ids, row, col, set, file };
  }
  const allRows = async (token: string, id: string, filter = "all") => (await ctx.api("GET", `/bulk-updates/${id}/rows?filter=${filter}&pageSize=200`, { token })).body;
  const parcel = (id: string) => ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: id } });

  describe("export", () => {
    it("downloads the filtered parcels with read-only data, dropdowns from live data, a hidden version, protection and suggestions", async () => {
      const s = await setup();
      const p1 = await book(s);
      const p2 = await book(s);
      const dropOff = await book(s, { intake: "DROP_OFF", dropOffHubId: s.gulshan.id });
      const hubbed = await atHub(s, s.dhanmondi.id);

      // "Pending operations confirmation" preset: pickup requests awaiting review only.
      const x = await exported(s.ops.token, "?preset=pending_review");
      expect(x.res.headers["content-type"]).toBe(XLSX);
      expect(x.res.headers["x-row-count"]).toBe("2");
      expect(x.res.headers["x-matched"]).toBe("2");
      expect(x.res.headers["x-row-limit"]).toBe("10000");
      expect(x.ids.sort()).toEqual([p1, p2].sort());
      expect(x.header.slice(0, 9)).toEqual(["Tracking ID", "Current status", "Suggested rider", "Action", "Rider", "New status", "Hub", "Reason / note", "Priority"]);
      const r1 = x.row(p1);
      expect(r1[x.col("Current status")]).toBe("Pending operations confirmation");
      expect(r1[x.col("SLA state")]).toBe("Awaiting review");
      expect(r1[x.col("Merchant")]).toBe("MR-4001 · Bulk Shop");
      expect(r1[x.col("Recipient phone")]).toBe("+8801812000000");
      expect(r1[x.col("COD (৳)")]).toBe("1500");
      expect(r1[x.col("version")]).toBe("0");
      // The routing suggestion for the Gulshan pickup: the Gulshan rider.
      expect(r1[x.col("Suggested rider")]).toBe(`R-4048 · Rider R-4048 · ${s.gulshan.name}`);
      expect(x.ids).not.toContain(dropOff);
      expect(x.ids).not.toContain(hubbed);

      const files = readZip(x.res.buffer, { maxBytes: 50_000_000 });
      const workbook = files.get("xl/workbook.xml")!.toString();
      expect(workbook).toMatch(/<sheet name="Parcels"[^>]*\/>/);
      expect(workbook).toMatch(/<sheet name="Instructions"[^>]*\/>/);
      expect(workbook).toMatch(/<sheet name="Lists"[^>]*state="hidden"/);
      expect(workbook).toContain('<definedName name="L_actions">');
      expect(workbook).toContain('<definedName name="RD_1">');
      const sheet = files.get("xl/worksheets/sheet1.xml")!.toString();
      // Protected without a password; filtering and sorting allowed; the version column hidden.
      expect(sheet).toMatch(/<sheetProtection sheet="1"[^>]*sort="0" autoFilter="0"/);
      expect(sheet).not.toMatch(/password/i);
      expect(sheet).toMatch(/<col min="38" max="38" width="8" customWidth="1" style="8" hidden="1"\/>/);
      // The hidden template column (the page the file is for) follows.
      expect(sheet).toMatch(/<col min="39" max="39" width="12" customWidth="1" style="8" hidden="1"\/>/);
      expect(sheet).toContain('<autoFilter ref="A1:AM3"/>');
      // Read-only cells are grey and locked (style 8); action cells unlocked (10).
      expect(sheet).toContain(`<c r="A2" s="8" t="inlineStr"><is><t>${x.rows[0][0]}</t></is></c>`);
      expect(sheet).toMatch(/<col min="4" max="4" width="28" customWidth="1" style="10"\/>/);
      const styles = files.get("xl/styles.xml")!.toString();
      expect(styles).toContain('<protection locked="0"/>');
      // Dropdowns from live data; dependent lists with IF/INDIRECT, never IFERROR.
      expect(sheet).toContain('sqref="D2:D3"><formula1>L_actions</formula1>');
      expect(sheet).toContain("IF($G2=&quot;&quot;,L_riders,INDIRECT(&quot;RD_&quot;&amp;MATCH($G2,L_hubs,0)))");
      expect(sheet).toContain("IF($AG2=&quot;&quot;,L_zones,INDIRECT(&quot;ZN_&quot;&amp;MATCH($AG2,L_districts,0)))");
      expect(sheet).toContain("<formula1>L_statuses</formula1>");
      expect(sheet).not.toContain("IFERROR");
      const lists = readXlsx(x.res.buffer, { maxRows: 10_000, prefer: ["Lists"] });
      const listCol = (title: string) => lists.rows.slice(1).map(r => r[lists.rows[0].indexOf(title)]).filter(Boolean);
      expect(listCol("Actions")).toEqual([
        "Accept & assign pickup rider",
        "Assign delivery rider",
        "Change status",
        "Receive at hub",
        "Cancel",
        "Change to drop-off",
        "Change to rider pickup",
        "Schedule return",
        "Complete details",
        "Add note",
      ]);
      expect(listCol("New status")).not.toContain("Delivered");
      expect(listCol("Riders")).toEqual([`R-4048 · Rider R-4048 · ${s.gulshan.name}`, `R-4050 · Rider R-4050 · ${s.dhanmondi.name}`]);
      expect(listCol(`Riders · ${s.gulshan.name}`)).toEqual([`R-4048 · Rider R-4048 · ${s.gulshan.name}`]);
      const help = readXlsx(x.res.buffer, { maxRows: 10_000, prefer: ["Instructions"] }).rows.map(r => r.join(" | ")).join("\n");
      expect(help).toContain("Accept & assign pickup rider | Rider (empty = the Suggested rider)");
      expect(help).toContain("Review → Unprotect Sheet (no password)");
      expect(help).toContain("at most 10,000 rows");

      // Hub operators: only their hubs' work, and only their riders and hubs in the lists.
      const mine = await exported(s.hubOp.token);
      expect(mine.ids.sort()).toEqual([p1, p2, dropOff].sort());
      const mineLists = readXlsx(mine.res.buffer, { maxRows: 10_000, prefer: ["Lists"] });
      expect(mineLists.rows.slice(1).map(r => r[mineLists.rows[0].indexOf("Riders")]).filter(Boolean)).toEqual([`R-4048 · Rider R-4048 · ${s.gulshan.name}`]);
      expect((await download(s.hubOp.token, `/bulk-updates/export?hubId=${s.dhanmondi.id}`)).status).toBe(403);
      const ops = await exported(s.ops.token, `?hubId=${s.dhanmondi.id}`);
      expect(ops.ids).toEqual([hubbed]);

      // The row limit (the operations import limit) cuts the file and says so.
      await ctx.prisma.setting.create({ data: { key: "import-config", value: { limits: { opsMaxRows: 1 } } } });
      const cut = await exported(s.ops.token, "?preset=pending_review");
      expect(cut.ids).toHaveLength(1);
      expect(cut.res.headers["x-matched"]).toBe("2");
      expect(readXlsx(cut.res.buffer, { maxRows: 100, prefer: ["Instructions"] }).rows.flat().join(" ")).toContain("This file holds the first 1 of 2 matching parcels");
      expect(await ctx.prisma.auditLog.count({ where: { action: "bulk_update.export" } })).toBe(4);

      // Merchants and riders can't use it.
      const owner = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: s.shop.id }], "Owner");
      expect((await download(owner.token, "/bulk-updates/export")).status).toBe(403);
    });
  });

  describe("apply", () => {
    it("applies every action through the parcel services with notifications, realtime and the batch number in the audit log", async () => {
      const s = await setup();
      const accept = await book(s);
      const acceptSuggested = await book(s);
      const cancel = await book(s);
      const toDropOff = await book(s);
      const confirm = await book(s);
      await ctx.api("POST", `/parcels/${confirm}/assign-pickup`, { token: s.ops.token, body: { riderId: s.rider.rider.id } });
      const dropOff = await book(s, { intake: "DROP_OFF", dropOffHubId: s.gulshan.id });
      const toPickup = await book(s, { intake: "DROP_OFF", dropOffHubId: s.gulshan.id });
      const deliver = await atHub(s);
      const ret = await atHub(s);
      const needs = await incomplete(s, "INC-1");
      const noted = await book(s);
      const realtime = ctx.app.get(RealtimeService);
      const events: RealtimeEvent[] = [];
      const spy = vi.spyOn(realtime, "publish").mockImplementation((...e: RealtimeEvent[]) => void events.push(...e));

      const x = await exported(s.ops.token);
      const rider = `R-4048 · Rider R-4048 · ${s.gulshan.name}`;
      x.set(accept, { Action: "Accept & assign pickup rider", Rider: rider, Priority: "High" });
      x.set(acceptSuggested, { Action: "Accept & assign pickup rider" });
      x.set(cancel, { Action: "Cancel", "Reason / note": "Merchant cancelled by phone" });
      x.set(toDropOff, { Action: "Change to drop-off", Hub: s.gulshan.name });
      x.set(confirm, { Action: "Change status", "New status": "Pickup confirmed" });
      x.set(dropOff, { Action: "Receive at hub" });
      x.set(toPickup, { Action: "Change to rider pickup" });
      x.set(deliver, { Action: "Assign delivery rider", Rider: "R-4048" });
      x.set(ret, { Action: "Schedule return", "Reason / note": "Recipient refused" });
      x.set(needs, { Action: "Complete details", "Set recipient name": "Nabila Ahmed", "Set address": "Road 7", "Set district": "Dhaka Central", "Set zone": "Dhanmondi" });
      x.set(noted, { Action: "Add note", "Reason / note": "Call before pickup" });

      const checked = await upload(s.ops.token, x.file());
      expect(checked.status, JSON.stringify(checked.body)).toBe(201);
      expect(checked.body.number).toMatch(/^BLK-\d{6}-001$/);
      expect(checked.body.counts).toMatchObject({ rows: 11, ignored: 0, errors: 0, alreadyDone: 0, toApply: 11 });
      // Nothing changed yet.
      expect((await parcel(accept)).status).toBe("PENDING_CONFIRMATION");
      const preview = await allRows(s.ops.token, checked.body.id);
      expect(preview.items.find((r: { trackingId: string }) => r.trackingId === acceptSuggested)).toMatchObject({ plan: { usedSuggestion: true, riderLabel: "R-4048 · Rider R-4048" } });

      const applied = await ctx.api("POST", `/bulk-updates/${checked.body.id}/apply`, { token: s.ops.token });
      expect(applied.status, JSON.stringify(applied.body)).toBe(200);
      expect(applied.body).toMatchObject({ status: "COMPLETED", background: false, result: { applied: 11, failed: 0, alreadyDone: 0 } });
      const byId = async (id: string) => parcel(id);
      expect(await byId(accept)).toMatchObject({ status: "PICKUP_ASSIGNED", pickupRiderId: s.rider.rider.id });
      expect(await byId(acceptSuggested)).toMatchObject({ status: "PICKUP_ASSIGNED", pickupRiderId: s.rider.rider.id });
      expect(await byId(cancel)).toMatchObject({ status: "PICKUP_CANCELLED", cancelReason: "Merchant cancelled by phone" });
      expect(await byId(toDropOff)).toMatchObject({ intake: "DROP_OFF", dropOffHubId: s.gulshan.id });
      expect(await byId(confirm)).toMatchObject({ status: "PICKUP_CONFIRMED" });
      expect(await byId(dropOff)).toMatchObject({ status: "AT_HUB", currentHubId: s.gulshan.id });
      expect(await byId(toPickup)).toMatchObject({ intake: "PICKUP", dropOffHubId: null });
      expect(await byId(deliver)).toMatchObject({ status: "ASSIGNED", deliveryRiderId: s.rider.rider.id });
      expect(await byId(ret)).toMatchObject({ status: "RETURN_SCHEDULED", returnReason: "Recipient refused" });
      expect(await byId(needs)).toMatchObject({ incomplete: false, recipientName: "Nabila Ahmed", deliveryDistrict: "Dhaka Central", deliveryZone: "Dhanmondi" });
      expect(await ctx.prisma.trackingEvent.count({ where: { parcel: { trackingId: noted }, title: "Note", description: "Call before pickup" } })).toBe(1);

      // The same side effects as single actions: the recipient's delivery code, webhooks/realtime, audit with the batch.
      expect(await ctx.prisma.outboxMessage.count({ where: { template: "parcel.delivery_code" } })).toBeGreaterThanOrEqual(1);
      expect(events.some(e => e.type === "parcel.updated" && e.id === accept)).toBe(true);
      const audits = await ctx.prisma.auditLog.findMany({ where: { action: "parcel.status_change" }, orderBy: { createdAt: "asc" } });
      const bulk = audits.filter(a => (a.data as { bulkUpdate?: { number: string } }).bulkUpdate?.number === checked.body.number);
      expect(bulk.length).toBeGreaterThanOrEqual(7);
      expect(bulk.find(a => (a.data as { trackingId: string }).trackingId === accept)?.data).toMatchObject({ from: "PENDING_CONFIRMATION", to: "PICKUP_ASSIGNED", bulkUpdate: { id: checked.body.id } });
      expect(await ctx.prisma.auditLog.findFirst({ where: { action: "parcel.complete_details" } })).toMatchObject({ data: { bulkUpdate: { number: checked.body.number } } });
      expect(await ctx.prisma.auditLog.count({ where: { action: { in: ["bulk_update.validate", "bulk_update.apply", "bulk_update.complete"] } } })).toBe(3);
      const result = await allRows(s.ops.token, checked.body.id, "applied");
      expect(result.total).toBe(11);
      expect(result.items.find((r: { trackingId: string }) => r.trackingId === accept).result).toBe('Now "Pickup assigned" · pickup by R-4048 · Rider R-4048');
      // High priority first.
      const order = (await ctx.prisma.auditLog.findMany({ where: { action: "parcel.status_change" }, orderBy: { createdAt: "asc" } })).filter(a => (a.data as { bulkUpdate?: unknown }).bulkUpdate);
      expect((order[0].data as { trackingId: string }).trackingId).toBe(accept);
      spy.mockRestore();
    });

    it("completes a \"Needs info\" order and assigns its delivery rider in one row", async () => {
      const s = await setup();
      const id = await incomplete(s, "INC-2");
      expect((await ctx.api("POST", `/parcels/${id}/assign-pickup`, { token: s.ops.token, body: { riderId: s.rider.rider.id } })).status).toBe(200);
      await status(s.ops.token, id, { status: "PICKED_UP" });
      await status(s.ops.token, id, { status: "AT_HUB", hubId: s.gulshan.id });
      const x = await exported(s.ops.token, "?preset=at_hub_unassigned");
      expect(x.row(id)[x.col("Missing fields")]).toBe("Recipient name, Address, District, Zone");
      // The suggestion can't be made before the details are known.
      expect(x.row(id)[x.col("Suggested rider")]).toBe("");
      x.set(id, { Action: "Assign delivery rider", Rider: "R-4048" });
      const refused = await upload(s.ops.token, x.file());
      const row = (await allRows(s.ops.token, refused.body.id)).items[0];
      expect(row.status).toBe("ERROR");
      expect(row.errors.map((e: { text: string }) => e.text)).toContain(`Row 2 · Set recipient name: ${id} needs the recipient name before a delivery rider: fill Set recipient name (or complete it first)`);
      x.set(id, { "Set recipient name": "Nabila", "Set address": "Road 7", "Set district": "Dhaka Central", "Set zone": "Dhanmondi" });
      const ok = await upload(s.ops.token, x.file());
      expect(ok.body.counts).toMatchObject({ errors: 0, toApply: 1 });
      const applied = await ctx.api("POST", `/bulk-updates/${ok.body.id}/apply`, { token: s.ops.token });
      expect(applied.body.result).toMatchObject({ applied: 1 });
      expect(await parcel(id)).toMatchObject({ status: "ASSIGNED", incomplete: false, deliveryRiderId: s.rider.rider.id });
    });
  });

  describe("validation", () => {
    it("checks lifecycle, scope, riders, details, versions, unknown and duplicate rows; empty actions are ignored", async () => {
      const s = await setup();
      const pending = await book(s);
      const pending2 = await book(s);
      const hubbed = await atHub(s);
      const dhn = await atHub(s, s.dhanmondi.id);
      const needs = await incomplete(s, "INC-3");
      await ctx.api("POST", `/parcels/${needs}/assign-pickup`, { token: s.ops.token, body: { riderId: s.rider.rider.id } });
      await status(s.ops.token, needs, { status: "PICKED_UP" });
      await status(s.ops.token, needs, { status: "AT_HUB", hubId: s.gulshan.id });
      const changed = await book(s);
      const skip = await book(s);
      await ctx.prisma.rider.update({ where: { id: s.rider.rider.id }, data: { status: "OFFLINE", dailyCapacity: 1 } });

      const x = await exported(s.ops.token);
      x.set(pending, { Action: "Accept & assign pickup rider", Rider: "R-4048" }); // warnings: off shift
      x.set(pending2, { Action: "Accept & assign pickup rider", Rider: "R-4048" }); // warnings: off shift, over capacity
      x.set(hubbed, { Action: "Cancel", "Reason / note": "x" }); // wrong transition
      x.set(dhn, { Action: "Change status", "New status": "Delivered" }); // never Delivered
      x.set(needs, { Action: "Assign delivery rider", Rider: "R-4048" }); // incomplete before delivery
      x.set(changed, { Action: "Accept & assign pickup rider", Rider: "R-4048" });
      await ctx.api("POST", `/parcels/${changed}/notes`, { token: s.ops.token, body: { note: "no version change" } });
      await ctx.api("POST", `/parcels/${changed}/assign-pickup`, { token: s.ops.token, body: { riderId: s.other.rider.id } }); // changed meanwhile
      const rows = [...x.rows.filter(r => r[0] !== skip)];
      const unknown = [...x.row(pending)];
      unknown[0] = "DF-000000-ZZZZ";
      const duplicate = [...x.row(pending)];
      duplicate[x.col("Action")] = "Add note";
      duplicate[x.col("Reason / note")] = "twice";
      const file = writeXlsx({ sheets: [{ name: "Parcels", rows: [x.header, ...rows, unknown, duplicate, x.row(skip)] }] });
      const checked = await upload(s.ops.token, file);
      expect(checked.status, JSON.stringify(checked.body)).toBe(201);
      // The skipped row (no action) is only counted.
      expect(checked.body.counts).toMatchObject({ rows: 8, ignored: 1, ready: 0, warnings: 2, errors: 6 });
      const all = await allRows(s.ops.token, checked.body.id);
      const of = (id: string) => all.items.find((r: { trackingId: string; rowNumber: number }) => r.trackingId === id);
      const texts = (r: { errors: { text: string }[]; warnings: { text: string }[] }) => [...r.errors, ...r.warnings].map(e => e.text);
      expect(of(pending).status).toBe("WARNING");
      expect(texts(of(pending)).join("\n")).toContain("R-4048 · Rider R-4048 is off shift");
      expect(texts(of(pending2)).join("\n")).toContain("R-4048 · Rider R-4048 would have 2 open stops (capacity 1)");
      expect(of(hubbed).errors[0]).toMatchObject({ column: "action", header: "Action", message: 'A parcel that is "At hub" can\'t be cancelled (only before pickup): use "Schedule return"' });
      expect(of(dhn).errors[0].message).toBe('"Delivered" can\'t be set here: Delivered is set only by the rider, with proof and COD');
      expect(of(needs).errors.map((e: { column: string }) => e.column)).toEqual(["set_recipient_name", "set_address", "set_district", "set_zone"]);
      expect(of(changed).errors[0]).toMatchObject({ column: "version" });
      expect(of(changed).errors[0].message).toContain(`${changed} changed since you downloaded it: now "Pickup assigned" (pickup R-4050 · Rider R-4050)`);
      const unknownRow = all.items.find((r: { rowNumber: number }) => r.rowNumber === rows.length + 2);
      expect(unknownRow.errors[0].text).toBe(`Row ${rows.length + 2} · Tracking ID: Unknown tracking ID "DF-000000-ZZZZ"`);
      const dupRow = all.items.find((r: { rowNumber: number }) => r.rowNumber === rows.length + 3);
      expect(dupRow.errors[0].message).toMatch(new RegExp(`${pending} already has an action in row \\d+: one row per parcel`));
      // Filters: will apply / warnings / errors.
      expect((await allRows(s.ops.token, checked.body.id, "apply")).total).toBe(2);
      expect((await allRows(s.ops.token, checked.body.id, "warning")).total).toBe(2);
      expect((await allRows(s.ops.token, checked.body.id, "error")).total).toBe(6);

      // Hub operators: other hubs' parcels, hubs and riders are out of scope.
      const y = await exported(s.ops.token);
      y.set(dhn, { Action: "Schedule return", "Reason / note": "Refused" });
      y.set(pending, { Action: "Accept & assign pickup rider", Rider: "R-4050" });
      y.set(pending2, { Action: "Change to drop-off", Hub: s.dhanmondi.name });
      const scoped = await upload(s.hubOp.token, y.file([dhn, pending, pending2]));
      const sr = await allRows(s.hubOp.token, scoped.body.id);
      const err = (id: string) => sr.items.find((r: { trackingId: string | null; cells: { tracking_id: string } }) => r.cells.tracking_id === id).errors[0].message;
      expect(err(dhn)).toBe(`${dhn} isn't part of your hubs' work`);
      expect(err(pending)).toBe(`R-4050 · Rider R-4050 works at ${s.dhanmondi.name}: you can only assign your own hubs' riders`);
      expect(err(pending2)).toBe("You can only switch parcels to drop-off at your own hub");

      // Nothing to apply; an unrelated file is refused.
      expect((await ctx.api("POST", `/bulk-updates/${scoped.body.id}/apply`, { token: s.hubOp.token })).body.error.code).toBe("NOTHING_TO_APPLY");
      const wrong = await upload(s.ops.token, writeXlsx({ sheets: [{ name: "Orders", rows: [["Order ID", "Customer phone"], ["A", "01812000000"]] }] }));
      expect(wrong.body.error.code).toBe("TEMPLATE_MISMATCH");
      // Only the uploader applies; operations managers can read it.
      expect((await ctx.api("POST", `/bulk-updates/${checked.body.id}/apply`, { token: s.hubOp.token })).status).toBe(404);
    });
  });

  describe("idempotency, failed rows and background jobs", () => {
    it("never applies a row twice, reports changes made meanwhile, and gives the rows not applied back in the same format", async () => {
      const s = await setup();
      const a = await book(s);
      const b = await book(s);
      const c = await book(s);
      const x = await exported(s.ops.token);
      x.set(a, { Action: "Accept & assign pickup rider", Rider: "R-4048" });
      x.set(b, { Action: "Add note", "Reason / note": "Fragile" });
      x.set(c, { Action: "Accept & assign pickup rider", Rider: "R-4048" });
      const file = x.file();
      const first = await upload(s.ops.token, file);
      // c is changed by someone else after the check: refused at apply, the others still apply.
      await ctx.api("POST", `/parcels/${c}/cancel`, { token: s.ops.token, body: { reason: "dup" } });
      const applied = await ctx.api("POST", `/bulk-updates/${first.body.id}/apply`, { token: s.ops.token });
      expect(applied.body.result).toMatchObject({ applied: 2, failed: 1, notApplied: 1 });
      const failed = (await allRows(s.ops.token, first.body.id, "failed")).items[0];
      expect(failed.errors[0]).toMatchObject({ column: "version" });
      expect(failed.errors[0].message).toContain(`${c} changed since you downloaded it`);

      // The same file again: nothing is applied twice.
      const again = await upload(s.ops.token, file);
      const againRows = await allRows(s.ops.token, again.body.id);
      const of = (id: string) => againRows.items.find((r: { trackingId: string }) => r.trackingId === id);
      expect(of(a)).toMatchObject({ status: "ALREADY_DONE", result: "Already done: pickup already assigned to R-4048 · Rider R-4048" });
      expect(of(c).status).toBe("ERROR");
      expect(of(b).status).toBe("READY");
      const reapplied = await ctx.api("POST", `/bulk-updates/${again.body.id}/apply`, { token: s.ops.token });
      expect(reapplied.body.result).toMatchObject({ applied: 0, alreadyDone: 2 });
      expect((await allRows(s.ops.token, again.body.id, "already_done")).items.find((r: { trackingId: string }) => r.trackingId === b).result).toBe(`Already done: applied by ${first.body.number} (row ${x.rows.findIndex(r => r[0] === b) + 2})`);
      expect(await ctx.prisma.trackingEvent.count({ where: { parcel: { trackingId: b }, description: "Fragile" } })).toBe(1);
      expect(await ctx.prisma.auditLog.count({ where: { action: "parcel.status_change", entityId: (await parcel(a)).id } })).toBe(1);

      // Rows not applied: the same sheet with an Error column, which can be fixed and uploaded again.
      const dl = await download(s.ops.token, `/bulk-updates/${first.body.id}/failed-rows`);
      expect(dl.status).toBe(200);
      expect(String(dl.headers["content-disposition"])).toContain(`${first.body.number}-not-applied.xlsx`);
      const back = readXlsx(dl.buffer, { maxRows: 100, prefer: ["Parcels"] });
      expect(back.rows[0].slice(0, 4)).toEqual(["Tracking ID", "Current status", "Suggested rider", "Action"]);
      expect(back.rows[0].at(-1)).toBe("Error");
      expect(back.rows[1][0]).toBe(c);
      expect(back.rows[1].at(-1)).toContain(`Row ${x.rows.findIndex(r => r[0] === c) + 2}: version: ${c} changed since you downloaded it`);
      expect(readZip(dl.buffer, { maxBytes: 50_000_000 }).get("xl/worksheets/sheet1.xml")!.toString()).toContain("<sheetProtection");
      const reupload = await upload(s.ops.token, dl.buffer, "fixed.xlsx");
      expect(reupload.status).toBe(201);
      expect(reupload.body.ignoredColumns).toEqual([]);
      expect((await allRows(s.ops.token, reupload.body.id)).items[0].errors.map((e: { column: string }) => e.column)).toContain("version");
      const csv = await download(s.ops.token, `/bulk-updates/${first.body.id}/failed-rows?format=csv`);
      expect(csv.buffer.toString("utf8")).toContain("Tracking ID,Current status");

      // History.
      const history = await ctx.api("GET", "/bulk-updates", { token: s.ops.token });
      expect(history.body.items.map((j: { number: string }) => j.number)).toContain(first.body.number);
      expect(history.body.items[0].downloads).toBeDefined();
    });

    it("applies large files in the background with progress events and resumes safely", async () => {
      const s = await setup();
      const rows = Array.from({ length: 120 }, (_, i) => ({ order_ref: `BG-${i}`, "Customer name": "Nabila", phone: "01812000000", address: "Road 7", district: "Dhaka Central", zone: "Dhanmondi" }));
      const imp = await ctx.api("POST", "/imports/validate", { token: s.ops.token, body: { kind: "ecommerce", merchantId: s.shop.id, rows } });
      await ctx.api("POST", `/imports/${imp.body.id}/commit`, { token: s.ops.token });
      await ctx.app.get(ImportJobsService).process(imp.body.id);
      expect(await ctx.prisma.parcel.count()).toBe(120);

      const x = await exported(s.ops.token, "?preset=pending_review");
      expect(x.ids).toHaveLength(120);
      for (const id of x.ids) x.set(id, { Action: "Add note", "Reason / note": "Checked by phone" });
      const checked = await upload(s.ops.token, x.file());
      expect(checked.body.counts).toMatchObject({ toApply: 120 });
      const realtime = ctx.app.get(RealtimeService);
      const events: RealtimeEvent[] = [];
      const spy = vi.spyOn(realtime, "publish").mockImplementation((...e: RealtimeEvent[]) => void events.push(...e));
      const queued = await ctx.api("POST", `/bulk-updates/${checked.body.id}/apply`, { token: s.ops.token });
      expect(queued.body).toMatchObject({ status: "QUEUED", background: true, progress: { processed: 0, total: 120 } });
      // One running bulk update per person.
      const small = await exported(s.ops.token, "?preset=pending_review");
      small.set(small.ids[0], { Action: "Add note", "Reason / note": "other" });
      const other = await upload(s.ops.token, small.file([small.ids[0]]));
      expect((await ctx.api("POST", `/bulk-updates/${other.body.id}/apply`, { token: s.ops.token })).body.error.code).toBe("BULK_UPDATE_IN_PROGRESS");

      // RUN_WORKERS is off in tests: run what the pg-boss worker runs.
      await ctx.app.get(BulkUpdatesService).process(checked.body.id);
      expect(events.filter(e => e.type === "bulk_update.progress").map(e => e.data?.processed)).toEqual([50, 100, 120]);
      expect(events.find(e => e.type === "bulk_update.completed")).toMatchObject({ userIds: [s.ops.user.id], data: { applied: 120, status: "COMPLETED" } });
      const done = await ctx.api("GET", `/bulk-updates/${checked.body.id}`, { token: s.ops.token });
      expect(done.body).toMatchObject({ status: "COMPLETED", progress: { processed: 120, percent: 100 }, result: { applied: 120 } });
      // A worker retry applies nothing again.
      await ctx.prisma.bulkUpdateJob.update({ where: { id: checked.body.id }, data: { status: "QUEUED" } });
      await ctx.app.get(BulkUpdatesService).process(checked.body.id);
      expect(await ctx.prisma.trackingEvent.count({ where: { description: "Checked by phone" } })).toBe(120);
      spy.mockRestore();
    }, 120_000);
  });

  describe("re-pricing preview", () => {
    const createPackage = async (token: string, name: string, prices: Record<string, number>, without: string[] = []) => {
      const services = ((await ctx.api("GET", "/service-catalog")).body as { services: { code: string; segments: string[] }[] }).services
        .filter(x => x.segments.includes("ECOMMERCE") && !without.includes(x.code))
        .map(x => x.code);
      const res = await ctx.api("POST", "/packages", { token, body: { segment: "ECOMMERCE", name, services, prices } });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.id as string;
    };
    const assignPackage = async (token: string, merchantId: string, packageId: string) =>
      expect((await ctx.api("PUT", `/merchants/${merchantId}/package`, { token, body: { packageId } })).status).toBe(200);

    it("shows each re-priced row's charge before → after and the total difference, priced like the single actions", async () => {
      const s = await setup();
      const admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Admin");
      await assignPackage(admin.token, s.shop.id, await createPackage(admin.token, "Drop discount", { hubDropDiscount: 20, extraKg: 15 }));
      // A second shop whose package has no drop at hub: switching to drop-off is refused in the preview.
      const strict = await ctx.prisma.merchant.create({
        data: { code: "MR-4002", type: "ECOMMERCE", name: "Strict Shop", status: "ACTIVE", contactName: "Owner", contactPhone: "+8801911000001", pickupAddress: "House 6 Road 2", pickupArea: "Gulshan", pickupDistrict: "Dhaka North" },
      });
      await assignPackage(admin.token, strict.id, await createPackage(admin.token, "No drop-off", {}, ["first.hub_drop"]));

      const toDropOff = await book(s);
      const refused = await book(s, { merchantId: strict.id });
      const reweighed = await incomplete(s, "INC-PRICE");
      const renamed = await incomplete(s, "INC-NAME");
      const before = Number((await parcel(toDropOff)).totalCharge);

      const x = await exported(s.ops.token);
      x.set(toDropOff, { Action: "Change to drop-off", Hub: s.gulshan.name });
      x.set(refused, { Action: "Change to drop-off", Hub: s.gulshan.name });
      x.set(reweighed, { Action: "Complete details", "Set recipient name": "Nabila Ahmed", "Set address": "Road 7", "Set district": "Dhaka South", "Set zone": "Motijheel", "Set weight (kg)": "3.2" });
      x.set(renamed, { Action: "Complete details", "Set recipient name": "Only A Name" });
      const checked = await upload(s.ops.token, x.file());
      expect(checked.status, JSON.stringify(checked.body)).toBe(201);
      expect(checked.body.counts).toMatchObject({ rows: 4, errors: 1, toApply: 3 });

      const rows = (await allRows(s.ops.token, checked.body.id)).items as { trackingId: string; status: string; plan: { price?: { before: number; after: number; difference: number } } | null; errors: { column: string; text: string }[] }[];
      const row = (id: string) => rows.find(r => r.trackingId === id)!;
      expect(row(toDropOff).plan?.price).toEqual({ before, after: before - 20, difference: -20 });
      expect(row(refused)).toMatchObject({ status: "ERROR", errors: [{ column: "action", text: expect.stringContaining("SERVICE_NOT_IN_PACKAGE: Merchant drop at hub") }] });
      const reweigh = row(reweighed).plan!.price!;
      expect(reweigh.before).toBe(Number((await parcel(reweighed)).totalCharge));
      expect(reweigh.difference).toBe(reweigh.after - reweigh.before);
      expect(reweigh.difference).toBeGreaterThanOrEqual(2 * 15); // 3.2 kg instead of the 0.5 kg default: at least two more started kg
      expect(row(renamed).plan?.price).toBeUndefined(); // the name doesn't change the price
      // The total for the rows that will apply, on the job.
      expect(checked.body.pricing).toEqual({ rows: 2, before: before + reweigh.before, after: before - 20 + reweigh.after, difference: reweigh.difference - 20 });
      expect((await ctx.api("GET", `/bulk-updates/${checked.body.id}`, { token: s.ops.token })).body.pricing).toEqual(checked.body.pricing);
      // Nothing changed yet.
      expect(Number((await parcel(toDropOff)).totalCharge)).toBe(before);

      // Applying charges exactly the previewed prices.
      const applied = await ctx.api("POST", `/bulk-updates/${checked.body.id}/apply`, { token: s.ops.token });
      expect(applied.body).toMatchObject({ status: "COMPLETED", result: { applied: 3, failed: 0 } });
      expect(Number((await parcel(toDropOff)).totalCharge)).toBe(before - 20);
      expect(Number((await parcel(reweighed)).totalCharge)).toBe(reweigh.after);
      expect(applied.body.pricing).toEqual(checked.body.pricing);
    });
  });

  describe("page templates (kinds)", () => {
    const listOf = (buffer: Buffer, title: string) => {
      const lists = readXlsx(buffer, { maxRows: 10_000, prefer: ["Lists"] });
      return lists.rows.slice(1).map(r => r[lists.rows[0].indexOf(title)]).filter(Boolean);
    };
    const helpOf = (buffer: Buffer) => readXlsx(buffer, { maxRows: 10_000, prefer: ["Instructions"] }).rows;

    it("each page downloads its own parcels with only its actions and columns, and its own title and instructions", async () => {
      const s = await setup();
      const pending = await book(s);
      const dropOff = await book(s, { intake: "DROP_OFF", dropOffHubId: s.gulshan.id });
      const assigned = await book(s);
      await ctx.api("POST", `/parcels/${assigned}/assign-pickup`, { token: s.ops.token, body: { riderId: s.rider.rider.id } });
      const hubbed = await atHub(s);
      const exception = await atHub(s);
      expect((await status(s.ops.token, exception, { status: "EXCEPTION", note: "Damaged box" })).status).toBe(200);

      // The pages the caller can use, with what each can do.
      const kinds = await ctx.api("GET", "/bulk-updates/kinds", { token: s.ops.token });
      expect(kinds.status).toBe(200);
      expect(kinds.body.map((k: { kind: string }) => k.kind)).toEqual(["new_orders", "pickup", "hub_desk", "delivery", "problems", "returns", "all"]);
      const newOrders = kinds.body[0];
      expect(newOrders).toMatchObject({ page: "New orders", title: "New orders bulk update" });
      expect(newOrders.actions[0]).toMatchObject({ label: "Accept & assign pickup rider", needs: "Rider (empty = the Suggested rider)" });

      const expected: Record<string, { title: string; actions: string[]; header: string[]; ids: string[] }> = {
        new_orders: {
          title: "New orders bulk update",
          actions: ["Accept & assign pickup rider", "Cancel", "Change to drop-off", "Change to rider pickup", "Complete details", "Add note"],
          header: [
            "Tracking ID", "Current status", "Suggested rider", "Action", "Rider", "Hub", "Reason / note", "Priority",
            "CN", "Merchant", "Pickup address", "Recipient name", "Recipient phone", "Recipient address", "District", "Zone", "Intake", "Drop-off hub", "COD (৳)", "Weight (kg)", "Service", "Created", "SLA due", "SLA state", "Missing fields",
            "Set recipient name", "Set recipient phone", "Set address", "Set district", "Set zone", "Set area", "Set weight (kg)", "Set service", "version", "template",
          ],
          ids: [pending, dropOff],
        },
        pickup: {
          title: "Pickup bulk update",
          actions: ["Assign / reassign pickup rider", "Mark picked up", "Cancel", "Add note"],
          header: ["Tracking ID", "Current status", "Action", "Rider", "Hub", "Reason / note", "Priority", "Pickup rider", "CN", "Merchant", "Pickup address", "Intake", "District", "Zone", "COD (৳)", "Weight (kg)", "Created", "SLA due", "SLA state", "version", "template"],
          ids: [assigned],
        },
        hub_desk: {
          title: "Hub desk bulk update",
          actions: ["Receive at hub", "Mark exception", "Add note"],
          header: ["Tracking ID", "Current status", "Action", "Hub", "Reason / note", "Priority", "Intake", "Drop-off hub", "Current hub", "Pickup rider", "CN", "Merchant", "Recipient name", "District", "Zone", "COD (৳)", "Weight (kg)", "Service", "Created", "SLA state", "version", "template"],
          ids: [dropOff, hubbed],
        },
        delivery: {
          title: "Delivery bulk update",
          actions: ["Assign delivery rider", "Complete details", "Add note"],
          header: [
            "Tracking ID", "Current status", "Suggested rider", "Action", "Rider", "Hub", "Reason / note", "Priority",
            "Current hub", "Delivery rider", "CN", "Merchant", "Recipient name", "Recipient phone", "Recipient address", "District", "Zone", "COD (৳)", "Weight (kg)", "Service", "SLA due", "SLA state", "Missing fields",
            "Set recipient name", "Set recipient phone", "Set address", "Set district", "Set zone", "Set area", "Set weight (kg)", "Set service", "version", "template",
          ],
          ids: [hubbed],
        },
        problems: {
          title: "Problems bulk update",
          actions: ["Resolve: change status", "Assign delivery rider", "Schedule return", "Complete details", "Add note"],
          header: [
            "Tracking ID", "Current status", "Suggested rider", "Action", "Rider", "New status", "Hub", "Reason / note", "Priority",
            "Current hub", "Pickup rider", "Delivery rider", "CN", "Merchant", "Recipient name", "Recipient phone", "Recipient address", "District", "Zone", "COD (৳)", "Weight (kg)", "Service", "Created", "SLA due", "SLA state", "Missing fields",
            "Set recipient name", "Set recipient phone", "Set address", "Set district", "Set zone", "Set area", "Set weight (kg)", "Set service", "version", "template",
          ],
          ids: [exception],
        },
        returns: {
          title: "Returns bulk update",
          actions: ["Schedule return", "Add note"],
          header: ["Tracking ID", "Current status", "Action", "Reason / note", "Priority", "Current hub", "Delivery rider", "CN", "Merchant", "Pickup address", "Recipient name", "District", "Zone", "COD (৳)", "Created", "SLA state", "version", "template"],
          ids: [exception],
        },
      };
      for (const [kind, want] of Object.entries(expected)) {
        const x = await exported(s.ops.token, `?kind=${kind}`);
        expect(x.header, kind).toEqual(want.header);
        expect(x.ids.sort(), kind).toEqual(want.ids.sort());
        expect(x.rows.every(r => r[x.col("template")] === kind), kind).toBe(true);
        expect(String(x.res.headers["content-disposition"])).toMatch(new RegExp(`delivery-fast-${kind.replace("_", "-")}-bulk-update-\\d{12}\\.xlsx`));
        expect(listOf(x.res.buffer, "Actions"), kind).toEqual(want.actions);
        // The kinds endpoint describes the same template.
        const def = kinds.body.find((k: { kind: string }) => k.kind === kind);
        expect(def.actions.map((a: { label: string }) => a.label)).toEqual(want.actions);
        expect(def.columns.map((c: { header: string }) => c.header)).toEqual(want.header.filter(h => h !== "version" && h !== "template"));
        const help = helpOf(x.res.buffer);
        expect(help[0][0], kind).toBe(`Delivery Fast · ${want.title}`);
        const text = help.map(r => r.join(" | ")).join("\n");
        expect(text).toContain(`This is the ${def.page} template`);
        // Only this page's actions are explained.
        const actionRows = help.filter(r => r[0] && r[1] && r[2] && !["Action", "Column"].includes(r[0]) && !want.header.includes(r[0]));
        expect(actionRows.map(r => r[0]), kind).toEqual(want.actions);
        const files = readZip(x.res.buffer, { maxBytes: 50_000_000 });
        const sheet = files.get("xl/worksheets/sheet1.xml")!.toString();
        expect(sheet).not.toContain("IFERROR");
        // Rider follows the Hub column; Set zone follows Set district (IF / INDIRECT).
        const letter = (h: string) => String.fromCharCode(65 + want.header.indexOf(h));
        if (want.header.includes("Rider")) expect(sheet, kind).toContain(`IF($${letter("Hub")}2=&quot;&quot;,L_riders,INDIRECT(&quot;RD_&quot;&amp;MATCH($${letter("Hub")}2,L_hubs,0)))`);
        if (want.header.includes("Set zone")) {
          const i = want.header.indexOf("Set district");
          const col = i < 26 ? String.fromCharCode(65 + i) : `A${String.fromCharCode(65 + i - 26)}`;
          expect(sheet, kind).toContain(`IF($${col}2=&quot;&quot;,L_zones,INDIRECT(&quot;ZN_&quot;&amp;MATCH($${col}2,L_districts,0)))`);
        }
      }
      // Problems: Resolve offers only the statuses that resolve a problem.
      const problems = await exported(s.ops.token, "?kind=problems");
      expect(listOf(problems.res.buffer, "New status")).toEqual(["At hub", "Out for delivery", "Retry scheduled", "Exception"]);
      // All parcels: every action, as before.
      const all = await exported(s.ops.token);
      expect(listOf(all.res.buffer, "Actions")).toHaveLength(10);
      expect(helpOf(all.res.buffer)[0][0]).toBe("Delivery Fast · All parcels bulk update");
      expect(all.rows.every(r => r[all.col("template")] === "all")).toBe(true);
      expect((await download(s.ops.token, "/bulk-updates/export?kind=nope")).status).toBe(422);
    });

    it("refuses another page's file, accepts any file on All parcels, keeps the kind in history and checks each page's actions", async () => {
      const s = await setup();
      const a = await book(s);
      const b = await book(s);
      const x = await exported(s.ops.token, "?kind=new_orders");
      x.set(a, { Action: "Accept & assign pickup rider", Rider: "R-4048" });
      const file = x.file([a]);

      // Uploaded on Delivery: refused with what to do.
      const wrong = await upload(s.ops.token, file, "new.xlsx", "delivery");
      expect(wrong.status).toBe(422);
      expect(wrong.body.error).toMatchObject({ code: "BULK_KIND_MISMATCH", details: { fileKind: "new_orders", pageKind: "delivery" } });
      expect(wrong.body.error.message).toBe("This is the New orders file. Upload it on the New orders page (or All parcels), or download the Delivery file here and fill that in.");
      // The All parcels file on a stage page: refused too.
      const generic = await exported(s.ops.token);
      generic.set(a, { Action: "Add note", "Reason / note": "x" });
      const refused = await upload(s.ops.token, generic.file([a]), "all.xlsx", "new_orders");
      expect(refused.body.error.code).toBe("BULK_KIND_MISMATCH");
      expect(refused.body.error.message).toContain("This is the All parcels file");
      // Mixed templates in one file: refused.
      const pickupFile = await exported(s.ops.token, "?kind=pickup");
      const mixed = writeXlsx({ sheets: [{ name: "Parcels", rows: [x.header, x.row(a), [...x.row(b)].map((v, i) => (x.header[i] === "template" ? "pickup" : v))] }] });
      expect((await upload(s.ops.token, mixed, "mixed.xlsx")).body.error.code).toBe("BULK_KIND_MIXED");
      expect(pickupFile.ids).toEqual([]);

      // On its own page (multipart field kind) and on All parcels: accepted, stored with its kind.
      const body = multipart({ name: "new.xlsx", data: file });
      const own = await ctx.app.inject({
        method: "POST",
        url: "/api/v1/bulk-updates/validate",
        payload: Buffer.concat([Buffer.from(`--${body.headers["content-type"].split("boundary=")[1]}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nnew_orders\r\n`), body.payload]),
        headers: { ...body.headers, authorization: `Bearer ${s.ops.token}` },
      });
      expect(own.statusCode, own.body).toBe(201);
      const ownJob = JSON.parse(own.body);
      expect(ownJob).toMatchObject({ kind: "new_orders", kindTitle: "New orders bulk update", page: "New orders", counts: { toApply: 1 } });
      expect(ownJob.columns.map((c: { key: string }) => c.key)).not.toContain("new_status");
      await ctx.api("DELETE", `/bulk-updates/${ownJob.id}`, { token: s.ops.token });
      const onAll = await upload(s.ops.token, file, "new.xlsx", "all");
      expect(onAll.status).toBe(201);
      expect(onAll.body).toMatchObject({ kind: "new_orders", counts: { toApply: 1 } });
      // Applying it as another page is refused; on All parcels it applies.
      expect((await ctx.api("POST", `/bulk-updates/${onAll.body.id}/apply?kind=delivery`, { token: s.ops.token })).body.error.code).toBe("BULK_KIND_MISMATCH");
      const applied = await ctx.api("POST", `/bulk-updates/${onAll.body.id}/apply?kind=all`, { token: s.ops.token });
      expect(applied.body).toMatchObject({ status: "COMPLETED", result: { applied: 1 } });
      expect(await ctx.prisma.auditLog.findFirst({ where: { action: "bulk_update.validate", entityId: onAll.body.id } })).toMatchObject({ data: { kind: "new_orders" } });

      // History: filtered by page, with the page's title.
      const generalJob = await upload(s.ops.token, generic.file([a]), "all.xlsx");
      const history = await ctx.api("GET", "/bulk-updates?kind=new_orders", { token: s.ops.token });
      expect(history.body.items.map((j: { number: string }) => j.number)).toEqual([onAll.body.number]);
      expect(history.body.items[0]).toMatchObject({ kind: "new_orders", kindTitle: "New orders bulk update" });
      expect((await ctx.api("GET", "/bulk-updates?kind=all", { token: s.ops.token })).body.items.map((j: { number: string }) => j.number)).toEqual([generalJob.body.number]);
      expect((await ctx.api("GET", "/bulk-updates", { token: s.ops.token })).body.items).toHaveLength(2);

      // An action of another page typed into a page's file: that row is refused (the file is fine on All parcels).
      const y = await exported(s.ops.token, "?kind=new_orders");
      y.set(b, { Action: "Assign delivery rider", Rider: "R-4048" });
      const typed = await upload(s.ops.token, y.file([b]), "typed.xlsx", "new_orders");
      const row = (await allRows(s.ops.token, typed.body.id)).items[0];
      expect(row.errors[0]).toMatchObject({ column: "action", message: '"Assign delivery rider" isn\'t an action of the New orders page: choose one from the list (or upload the file on All parcels)' });
      const typedOnAll = await upload(s.ops.token, y.file([b]), "typed.xlsx", "all");
      expect((await allRows(s.ops.token, typedOnAll.body.id)).items[0].errors[0].message).toContain("can't be assigned for delivery");

      // The failed rows come back in the page's own format.
      const dl = await download(s.ops.token, `/bulk-updates/${typed.body.id}/failed-rows`);
      const back = readXlsx(dl.buffer, { maxRows: 100, prefer: ["Parcels"] });
      expect(back.rows[0]).toEqual([...x.header, "Error"]);
      expect(back.rows[1][x.col("template")]).toBe("new_orders");
      expect(helpOf(dl.buffer)[0][0]).toBe("Delivery Fast · New orders bulk update");
    });

    it("applies each page's actions through the same services", async () => {
      const s = await setup();
      const pending = await book(s);
      const assigned = await book(s);
      await ctx.api("POST", `/parcels/${assigned}/assign-pickup`, { token: s.ops.token, body: { riderId: s.rider.rider.id } });
      const pickedUp = await book(s);
      await ctx.api("POST", `/parcels/${pickedUp}/assign-pickup`, { token: s.ops.token, body: { riderId: s.rider.rider.id } });
      await status(s.ops.token, pickedUp, { status: "PICKED_UP" });
      const hubbed = await atHub(s);
      const stuck = await atHub(s);
      await status(s.ops.token, stuck, { status: "EXCEPTION", note: "Label torn" });
      const refused = await atHub(s);
      await status(s.ops.token, refused, { status: "EXCEPTION", note: "Recipient refused" });
      const run = async (kind: string, fill: (x: Awaited<ReturnType<typeof exported>>) => string[]) => {
        const x = await exported(s.ops.token, `?kind=${kind}`);
        const ids = fill(x);
        const checked = await upload(s.ops.token, x.file(ids), `${kind}.xlsx`, kind);
        expect(checked.status, JSON.stringify(checked.body)).toBe(201);
        return checked.body;
      };
      const applyAll = async (job: { id: string }, kind: string) => (await ctx.api("POST", `/bulk-updates/${job.id}/apply?kind=${kind}`, { token: s.ops.token })).body;

      // New orders: accept & assign the pickup rider (the suggestion).
      const n = await run("new_orders", x => (x.set(pending, { Action: "Accept & assign pickup rider" }), [pending]));
      expect(n.counts).toMatchObject({ toApply: 1, errors: 0 });
      expect((await applyAll(n, "new_orders")).result).toMatchObject({ applied: 1 });
      expect(await parcel(pending)).toMatchObject({ status: "PICKUP_ASSIGNED", pickupRiderId: s.rider.rider.id });

      // Pickup: mark picked up (Change status → Picked up, by the lifecycle).
      const p = await run("pickup", x => (x.set(assigned, { Action: "Mark picked up" }), [assigned]));
      expect((await applyAll(p, "pickup")).result).toMatchObject({ applied: 1 });
      expect(await parcel(assigned)).toMatchObject({ status: "PICKED_UP" });

      // Hub desk: receive; "Mark exception" needs a reason.
      const h = await run("hub_desk", x => {
        x.set(pickedUp, { Action: "Receive at hub", Hub: s.gulshan.name });
        x.set(hubbed, { Action: "Mark exception" });
        return [pickedUp, hubbed];
      });
      const hubRows = await allRows(s.ops.token, h.id);
      expect(hubRows.items.find((r: { trackingId: string }) => r.trackingId === hubbed).errors[0]).toMatchObject({ column: "note", message: 'Give the reason for "Mark exception"' });
      expect((await applyAll(h, "hub_desk")).result).toMatchObject({ applied: 1, notApplied: 1 });
      expect(await parcel(pickedUp)).toMatchObject({ status: "AT_HUB", currentHubId: s.gulshan.id });

      // Delivery: assign the delivery rider.
      const d = await run("delivery", x => (x.set(hubbed, { Action: "Assign delivery rider", Rider: "R-4048" }), [hubbed]));
      expect((await applyAll(d, "delivery")).result).toMatchObject({ applied: 1 });
      expect(await parcel(hubbed)).toMatchObject({ status: "ASSIGNED", deliveryRiderId: s.rider.rider.id });

      // Problems: resolve back to the hub, schedule a return; a status Resolve doesn't offer is refused.
      const pr = await run("problems", x => {
        x.set(stuck, { Action: "Resolve: change status", "New status": "At hub" });
        x.set(refused, { Action: "Schedule return", "Reason / note": "Recipient refused twice" });
        return [stuck, refused];
      });
      expect(pr.counts).toMatchObject({ toApply: 2, errors: 0 });
      const prResult = await applyAll(pr, "problems");
      expect(prResult.result).toMatchObject({ applied: 2 });
      expect(await parcel(stuck)).toMatchObject({ status: "AT_HUB" });
      expect(await parcel(refused)).toMatchObject({ status: "RETURN_SCHEDULED", returnReason: "Recipient refused twice" });
      const rows = await allRows(s.ops.token, pr.id, "applied");
      expect(rows.items.map((r: { actionLabel: string }) => r.actionLabel).sort()).toEqual(["Resolve: change status", "Schedule return"]);
      const audits = await ctx.prisma.auditLog.findMany({ where: { action: "parcel.status_change" } });
      expect(audits.filter(a => (a.data as { bulkUpdate?: { number: string } }).bulkUpdate?.number === pr.number)).toHaveLength(2);

      await status(s.ops.token, stuck, { status: "EXCEPTION", note: "Again" });
      const bad = await run("problems", x => (x.set(stuck, { Action: "Resolve: change status", "New status": "Picked up" }), [stuck]));
      expect((await allRows(s.ops.token, bad.id)).items[0].errors[0].message).toBe('"Resolve: change status" moves a parcel to "At hub", "Out for delivery", "Retry scheduled", "Exception": choose one from the list');
    });
  });
});
