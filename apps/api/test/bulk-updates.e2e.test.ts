import { vi } from "vitest";
import { RealtimeService, type RealtimeEvent } from "../src/common/realtime.service";
import { BulkUpdatesService } from "../src/modules/bulk-updates/bulk-updates.service";
import { DATA_SHEETS } from "../src/modules/bulk-updates/bulk-workbook";
import { ImportJobsService } from "../src/modules/imports/import-jobs.service";
import { readZip } from "../src/modules/imports/xlsx/zip";
import { readXlsx } from "../src/modules/imports/xlsx/xlsx-reader";
import { writeXlsx } from "../src/modules/imports/xlsx/xlsx-writer";
import { hub, parcelBody, resetDatabase, riderUser, startApp, userWithRoles, type TestContext } from "./helpers";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Bulk operations by Excel, one file per action: choose an action, download its parcels, fill it in, upload, preview, apply. */
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
  const assignPickup = async (s: Setup, id: string, rider = s.rider) => expect((await ctx.api("POST", `/parcels/${id}/assign-pickup`, { token: s.ops.token, body: { riderId: rider.rider.id } })).status).toBe(200);
  /** A parcel received at a hub after pickup. */
  const atHub = async (s: Setup, hubId = s.gulshan.id) => {
    const id = await book(s);
    await assignPickup(s, id, hubId === s.dhanmondi.id ? s.other : s.rider);
    expect((await status(s.ops.token, id, { status: "PICKED_UP" })).status).toBe(200);
    expect((await status(s.ops.token, id, { status: "AT_HUB", hubId })).status).toBe(200);
    return id;
  };
  const exception = async (s: Setup, note = "Damaged box") => {
    const id = await atHub(s);
    expect((await status(s.ops.token, id, { status: "EXCEPTION", note })).status).toBe(200);
    return id;
  };
  /** An import row booked without recipient name, address or destination ("Needs info"). */
  const incomplete = async (s: Setup, ref: string) => {
    const checked = await ctx.api("POST", "/imports/validate", { token: s.ops.token, body: { kind: "ecommerce", merchantId: s.shop.id, rows: [{ order_ref: ref, phone: "01812000000" }] } });
    expect(checked.body.counts, JSON.stringify(checked.body)).toMatchObject({ incomplete: 1 });
    await ctx.api("POST", `/imports/${checked.body.id}/commit`, { token: s.ops.token });
    return (await ctx.prisma.parcel.findFirstOrThrow({ where: { merchantOrderRef: ref } })).trackingId;
  };

  async function download(token: string, url: string) {
    const res = await ctx.app.inject({ method: "GET", url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` } });
    return { status: res.statusCode, headers: res.headers, buffer: res.rawPayload, body: res.statusCode >= 400 ? JSON.parse(res.body) : undefined };
  }
  function multipart(file: { name: string; data: Buffer }, fields: Record<string, string> = {}) {
    const boundary = `----dfBulk${Math.random().toString(16).slice(2)}`;
    const payload = Buffer.concat([
      ...Object.entries(fields).map(([k, v]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${XLSX}\r\n\r\n`),
      file.data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return { payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
  }
  /** Uploads a file on a page (kind) with the chosen action (query parameters). */
  async function upload(token: string, data: Buffer, opts: { kind?: string; action?: string; name?: string; fields?: Record<string, string> } = {}) {
    const body = multipart({ name: opts.name ?? "bulk.xlsx", data }, opts.fields);
    const query = new URLSearchParams(Object.entries({ kind: opts.kind, action: opts.action }).filter((e): e is [string, string] => !!e[1])).toString();
    const res = await ctx.app.inject({ method: "POST", url: `/api/v1/bulk-updates/validate${query ? `?${query}` : ""}`, payload: body.payload, headers: { ...body.headers, authorization: `Bearer ${token}` } });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  }

  /** One action's exported sheet as rows, with helpers to fill it in and write it back. */
  async function exported(token: string, kind: string, action: string, query = "") {
    const res = await download(token, `/bulk-updates/export?kind=${kind}&action=${action}${query}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const sheet = readXlsx(res.buffer, { maxRows: 20_000, prefer: DATA_SHEETS });
    const header = sheet.rows[0];
    const rows = sheet.rows.slice(1).map(r => header.map((_, i) => r[i] ?? ""));
    /** By header, with or without the required "*". */
    const col = (name: string) => {
      const i = header.findIndex(h => h === name || h === `${name} *`);
      if (i < 0) throw new Error(`no column ${name} in ${header.join(", ")}`);
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
    const file = (only?: string[], extra: string[][] = []) =>
      writeXlsx({ sheets: [{ name: sheet.sheetName || "Parcels", rows: [header, ...rows.filter(r => !only || only.includes(r[col("Tracking ID")])), ...extra] }] });
    return { res, header, rows, ids, row, col, set, file };
  }
  type Exported = Awaited<ReturnType<typeof exported>>;
  const allRows = async (token: string, id: string, filter = "all") => (await ctx.api("GET", `/bulk-updates/${id}/rows?filter=${filter}&pageSize=200`, { token })).body;
  const parcel = (id: string) => ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: id } });
  const listOf = (buffer: Buffer, title: string) => {
    const lists = readXlsx(buffer, { maxRows: 10_000, prefer: ["Lists"] });
    const i = lists.rows[0]?.indexOf(title) ?? -1;
    return i < 0 ? null : lists.rows.slice(1).map(r => r[i]).filter(Boolean);
  };
  const helpOf = (buffer: Buffer) => readXlsx(buffer, { maxRows: 10_000, prefer: ["Instructions"] }).rows;
  const sheetXml = (buffer: Buffer) => readZip(buffer, { maxBytes: 50_000_000 }).get("xl/worksheets/sheet1.xml")!.toString();
  const workbookXml = (buffer: Buffer) => readZip(buffer, { maxBytes: 50_000_000 }).get("xl/workbook.xml")!.toString();
  /** Exports one action, fills rows in, keeps only those rows and uploads it on the page with the action. */
  const run = async (token: string, kind: string, action: string, fill: (x: Exported) => string[], query = "") => {
    const x = await exported(token, kind, action, query);
    const ids = fill(x);
    const checked = await upload(token, x.file(ids), { kind, action, name: `${action}.xlsx` });
    expect(checked.status, JSON.stringify(checked.body)).toBe(201);
    return { x, job: checked.body };
  };
  const apply = async (token: string, job: { id: string }, kind = "all") => {
    const res = await ctx.api("POST", `/bulk-updates/${job.id}/apply?kind=${kind}`, { token });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  };

  describe("action templates", () => {
    it("each page lists its actions with counts; each action's file holds only its eligible parcels, its own columns (no Action column), title and instructions", async () => {
      const s = await setup();
      const p1 = await book(s);
      const p2 = await book(s);
      const dropOff = await book(s, { intake: "DROP_OFF", dropOffHubId: s.gulshan.id });
      const assigned = await book(s);
      await assignPickup(s, assigned);
      const pickedUp = await book(s);
      await assignPickup(s, pickedUp);
      await status(s.ops.token, pickedUp, { status: "PICKED_UP" });
      const hubbed = await atHub(s);
      const stuck = await exception(s);
      const needs = await incomplete(s, "INC-X");

      // The pages and their actions.
      const kinds = await ctx.api("GET", "/bulk-updates/kinds", { token: s.ops.token });
      expect(kinds.body.map((k: { kind: string }) => k.kind)).toEqual(["new_orders", "pickup", "hub_desk", "delivery", "problems", "returns", "transfers", "all"]);
      expect(kinds.body[0].actions.map((a: { action: string }) => a.action)).toEqual(["accept_pickup", "cancel", "to_drop_off", "to_pickup", "complete_details", "add_note"]);
      expect(kinds.body[6].actions.map((a: { action: string }) => a.action)).toEqual(["transfer"]);
      expect(kinds.body[7].actions).toHaveLength(15);

      const expected: Record<string, Record<string, string[]>> = {
        new_orders: { accept_pickup: [p1, p2, needs], cancel: [p1, p2, dropOff, needs], to_drop_off: [p1, p2, needs], to_pickup: [dropOff], complete_details: [needs], add_note: [p1, p2, dropOff, needs] },
        pickup: { reassign_pickup: [assigned], mark_picked_up: [assigned], cancel: [assigned], add_note: [assigned, pickedUp] },
        hub_desk: { receive_at_hub: [dropOff, pickedUp], mark_exception: [dropOff, pickedUp, hubbed], add_note: [dropOff, pickedUp, hubbed] },
        delivery: { assign_delivery: [hubbed], complete_details: [], add_note: [hubbed] },
        problems: { resolve_status: [stuck], assign_delivery: [stuck], schedule_return: [stuck], complete_details: [needs], add_note: [stuck, needs] },
        returns: { schedule_return: [stuck], add_note: [stuck] },
        // At a hub, not bagged, and the recipient's zone isn't served by that hub (Dhanmondi has no zone hub here).
        transfers: { transfer: [hubbed] },
        all: {
          accept_pickup: [p1, p2, needs],
          reassign_pickup: [assigned],
          mark_picked_up: [assigned],
          receive_at_hub: [dropOff, assigned, pickedUp, stuck],
          mark_exception: [p1, p2, dropOff, assigned, pickedUp, hubbed, needs],
          assign_delivery: [hubbed, stuck],
          resolve_status: [stuck],
          change_status: [p1, p2, dropOff, assigned, pickedUp, hubbed, stuck, needs],
          cancel: [p1, p2, dropOff, assigned, needs, stuck],
          to_drop_off: [p1, p2, assigned, needs],
          to_pickup: [dropOff],
          schedule_return: [hubbed, stuck],
          complete_details: [needs],
          add_note: [p1, p2, dropOff, assigned, pickedUp, hubbed, stuck, needs],
          transfer: [hubbed],
        },
      };
      const pages: Record<string, string> = { new_orders: "New orders", pickup: "Pickup", hub_desk: "Hub desk", delivery: "Delivery", problems: "Problems", returns: "Returns", transfers: "Transfers", all: "All parcels" };
      for (const [kind, actions] of Object.entries(expected)) {
        const list = await ctx.api("GET", `/bulk-updates/actions?kind=${kind}`, { token: s.ops.token });
        expect(list.status, JSON.stringify(list.body)).toBe(200);
        expect(list.body.map((a: { action: string }) => a.action), kind).toEqual(Object.keys(actions));
        for (const [action, ids] of Object.entries(actions)) {
          const def = list.body.find((a: { action: string }) => a.action === action);
          const x = await exported(s.ops.token, kind, action);
          const label = `${kind}:${action}`;
          expect(x.ids.sort(), label).toEqual([...ids].sort());
          expect(def.count, label).toBe(ids.length);
          // No Action column; the file carries its page and action in the hidden template column.
          expect(x.header, label).not.toContain("Action");
          expect(x.header.slice(0, 2), label).toEqual(["Tracking ID", "Current status"]);
          expect(x.header.slice(-2), label).toEqual(["version", "template"]);
          expect(x.rows.every(r => r[x.col("template")] === label), label).toBe(true);
          expect(def.columns.map((c: { header: string }) => c.header), label).toEqual(x.header.slice(0, -2));
          // The title names the action and the page; the sheet tab is the action.
          const help = helpOf(x.res.buffer);
          expect(help[0][0], label).toBe(`Delivery Fast · ${def.label} · ${pages[kind]}`);
          expect(def.title).toBe(`${def.label} · ${pages[kind]}`);
          expect(help[1][0], label).toBe(def.howTo);
          expect(def.howTo.startsWith(`${def.label}: `)).toBe(true);
          expect(listOf(x.res.buffer, "Actions"), label).toBeNull();
          expect(sheetXml(x.res.buffer)).not.toContain("IFERROR");
          expect(String(x.res.headers["content-disposition"])).toMatch(new RegExp(`delivery-fast-${kind === "all" ? "all-parcels" : kind.replace("_", "-")}-${action.replace(/_/g, "-")}-\\d{12}\\.xlsx`));
        }
      }

      // Accept & assign: Suggested rider prefilled, Rider follows Hub, Priority and Note; nothing else editable.
      const accept = await exported(s.ops.token, "new_orders", "accept_pickup");
      expect(accept.header).toEqual([
        "Tracking ID", "Current status", "Suggested rider", "Rider", "Hub", "Priority", "Note",
        "Merchant", "Pickup address", "Recipient name", "District", "Zone", "COD (৳)", "Weight (kg)", "Created", "SLA due", "SLA state", "version", "template",
      ]);
      expect(accept.row(p1)[accept.col("Suggested rider")]).toBe(`R-4048 · Rider R-4048 · ${s.gulshan.name}`);
      expect(accept.row(p1)[accept.col("Rider")]).toBe("");
      const acceptXml = sheetXml(accept.res.buffer);
      expect(acceptXml).toContain("IF($E2=&quot;&quot;,L_riders,INDIRECT(&quot;RD_&quot;&amp;MATCH($E2,L_hubs,0)))");
      expect(acceptXml).toMatch(/<col min="18" max="18" width="8" customWidth="1" style="8" hidden="1"\/>/);
      expect(acceptXml).toMatch(/<col min="19" max="19" width="26" customWidth="1" style="8" hidden="1"\/>/);
      expect(acceptXml).toMatch(/<col min="4" max="4" width="34" customWidth="1" style="10"\/>/);
      expect(acceptXml).toMatch(/<sheetProtection sheet="1"[^>]*sort="0" autoFilter="0"/);
      expect(acceptXml).not.toMatch(/password/i);
      expect(workbookXml(accept.res.buffer)).toMatch(/<sheet name="Accept &amp; assign pickup"[^>]*\/>/);
      expect(workbookXml(accept.res.buffer)).toMatch(/<sheet name="Lists"[^>]*state="hidden"/);
      expect(listOf(accept.res.buffer, "Riders")).toEqual([`R-4048 · Rider R-4048 · ${s.gulshan.name}`, `R-4050 · Rider R-4050 · ${s.dhanmondi.name}`]);
      expect(listOf(accept.res.buffer, `Riders · ${s.gulshan.name}`)).toEqual([`R-4048 · Rider R-4048 · ${s.gulshan.name}`]);
      expect(listOf(accept.res.buffer, "Districts")).toBeNull(); // no Set … columns here
      const acceptHelp = helpOf(accept.res.buffer).map(r => r.join(" | ")).join("\n");
      expect(acceptHelp).toContain(
        "Accept & assign pickup rider: fill Rider for each row you want to accept with another rider; leave Rider empty to accept the suggested rider; delete rows you don't want to change.",
      );
      expect(acceptHelp).toContain("Every row in the file is applied: delete the rows you don't want to change.");
      expect(acceptHelp).toContain("Review → Unprotect Sheet (no password)");
      expect(acceptHelp).toContain("at most 10,000 rows");

      // Cancel: Reason (required) only.
      const cancel = await exported(s.ops.token, "new_orders", "cancel");
      expect(cancel.header).toEqual(["Tracking ID", "Current status", "Reason *", "Intake", "Pickup rider", "Merchant", "Pickup address", "Recipient name", "District", "Zone", "COD (৳)", "Created", "SLA state", "version", "template"]);
      expect(helpOf(cancel.res.buffer).map(r => r.join(" | ")).join("\n")).toContain("Rows whose input columns are all empty are skipped.");
      // Complete details: the Set … fields with district → zone → area.
      const complete = await exported(s.ops.token, "new_orders", "complete_details");
      expect(complete.header).toEqual([
        "Tracking ID", "Current status", "Missing fields", "Set recipient name", "Set recipient phone", "Set address", "Set district", "Set zone", "Set area", "Set weight (kg)", "Set service", "Note",
        "Merchant", "Recipient name", "Recipient phone", "Recipient address", "District", "Zone", "Weight (kg)", "Service", "COD (৳)", "version", "template",
      ]);
      expect(sheetXml(complete.res.buffer)).toContain("IF($G2=&quot;&quot;,L_zones,INDIRECT(&quot;ZN_&quot;&amp;MATCH($G2,L_districts,0)))");
      expect(sheetXml(complete.res.buffer)).toContain("IF($H2=&quot;&quot;,L_areas,INDIRECT(&quot;AR_&quot;&amp;MATCH($H2,L_zones,0)))");
      // Resolve: New status limited to the allowed targets.
      const resolve = await exported(s.ops.token, "problems", "resolve_status");
      expect(resolve.header.slice(0, 5)).toEqual(["Tracking ID", "Current status", "New status *", "Hub", "Note"]);
      expect(listOf(resolve.res.buffer, "New status")).toEqual(["At hub", "Out for delivery", "Retry scheduled", "Exception"]);
      expect(listOf((await exported(s.ops.token, "all", "change_status")).res.buffer, "New status")).not.toContain("Delivered");
      // Receive: the receiving Hub.
      const receive = await exported(s.ops.token, "hub_desk", "receive_at_hub");
      expect(receive.header.slice(0, 4)).toEqual(["Tracking ID", "Current status", "Receiving hub", "Note"]);
      expect(receive.header).toContain("Drop-off hub");
      // Assign / reassign pickup rider: the new rider is required; no suggestion.
      const reassign = await exported(s.ops.token, "pickup", "reassign_pickup");
      expect(reassign.header.slice(0, 7)).toEqual(["Tracking ID", "Current status", "Pickup rider", "New rider *", "Hub", "Priority", "Note"]);

      // Wrong requests: no action, an action of another page, an unknown page.
      expect((await download(s.ops.token, "/bulk-updates/export?kind=new_orders")).status).toBe(422);
      const offPage = await download(s.ops.token, "/bulk-updates/export?kind=new_orders&action=assign_delivery");
      expect(offPage.body.error).toMatchObject({ code: "BULK_ACTION_NOT_ON_PAGE" });
      expect(offPage.body.error.message).toBe('"Assign delivery rider" isn\'t an action of the New orders page. Choose one of "Accept & assign pickup rider", "Cancel", "Change to drop-off", "Change to rider pickup", "Complete details", "Add note" (or use All parcels).');
      expect((await download(s.ops.token, "/bulk-updates/export?kind=nope&action=cancel")).status).toBe(422);
    });

    it("narrows by the dialog's filters and the hub operator's scope, cuts at the row limit and is audited", async () => {
      const s = await setup();
      const p1 = await book(s);
      const p2 = await book(s);
      const dropOff = await book(s, { intake: "DROP_OFF", dropOffHubId: s.gulshan.id });
      const hubbed = await atHub(s, s.dhanmondi.id);

      const x = await exported(s.ops.token, "all", "add_note", "&preset=pending_review");
      expect(x.res.headers["content-type"]).toBe(XLSX);
      expect(x.res.headers["x-row-count"]).toBe("2");
      expect(x.res.headers["x-matched"]).toBe("2");
      expect(x.res.headers["x-row-limit"]).toBe("10000");
      expect(x.ids.sort()).toEqual([p1, p2].sort());
      const r1 = x.row(p1);
      expect(r1[x.col("Current status")]).toBe("Pending operations confirmation");
      expect(r1[x.col("SLA state")]).toBe("Awaiting review");
      expect(r1[x.col("Merchant")]).toBe("MR-4001 · Bulk Shop");
      expect(r1[x.col("COD (৳)")]).toBe("1500");
      expect(r1[x.col("version")]).toBe("0");

      // Hub operators: only their hubs' work, and only their riders and hubs in the lists.
      const mine = await exported(s.hubOp.token, "all", "add_note");
      expect(mine.ids.sort()).toEqual([p1, p2, dropOff].sort());
      const mineAccept = await exported(s.hubOp.token, "new_orders", "accept_pickup");
      expect(listOf(mineAccept.res.buffer, "Riders")).toEqual([`R-4048 · Rider R-4048 · ${s.gulshan.name}`]);
      expect((await download(s.hubOp.token, `/bulk-updates/export?kind=all&action=add_note&hubId=${s.dhanmondi.id}`)).status).toBe(403);
      const counts = await ctx.api("GET", "/bulk-updates/actions?kind=new_orders", { token: s.hubOp.token });
      expect(counts.body.find((a: { action: string }) => a.action === "add_note").count).toBe(3);
      expect((await exported(s.ops.token, "all", "add_note", `&hubId=${s.dhanmondi.id}`)).ids).toEqual([hubbed]);

      // The row limit (the operations import limit) cuts the file and says so.
      await ctx.prisma.setting.create({ data: { key: "import-config", value: { limits: { opsMaxRows: 1 } } } });
      const cut = await exported(s.ops.token, "new_orders", "accept_pickup");
      expect(cut.ids).toHaveLength(1);
      expect(cut.res.headers["x-matched"]).toBe("2");
      expect(helpOf(cut.res.buffer).flat().join(" ")).toContain("This file holds the first 1 of 2 matching parcels");
      expect(await ctx.prisma.auditLog.findFirst({ where: { action: "bulk_update.export" }, orderBy: { createdAt: "desc" } })).toMatchObject({ data: { kind: "new_orders", action: "accept_pickup" } });

      // Merchants and riders can't use it.
      const owner = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: s.shop.id }], "Owner");
      expect((await download(owner.token, "/bulk-updates/export?action=add_note")).status).toBe(403);
      expect((await ctx.api("GET", "/bulk-updates/actions", { token: owner.token })).status).toBe(403);
    });
  });

  describe("apply", () => {
    it("applies each action's file through the parcel services with notifications, realtime and the batch number in the audit log", async () => {
      const s = await setup();
      const accept = await book(s);
      const acceptSuggested = await book(s);
      const cancel = await book(s);
      const notCancelled = await book(s);
      const toDropOff = await book(s);
      const dropOff = await book(s, { intake: "DROP_OFF", dropOffHubId: s.gulshan.id });
      const toPickup = await book(s, { intake: "DROP_OFF", dropOffHubId: s.gulshan.id });
      const needs = await incomplete(s, "INC-1");
      const realtime = ctx.app.get(RealtimeService);
      const events: RealtimeEvent[] = [];
      const spy = vi.spyOn(realtime, "publish").mockImplementation((...e: RealtimeEvent[]) => void events.push(...e));
      const rider = `R-4048 · Rider R-4048 · ${s.gulshan.name}`;

      // ── New orders › Accept & assign pickup rider: a chosen rider (High), and the suggestion (Rider empty) ──
      const a = await run(s.ops.token, "new_orders", "accept_pickup", x => (x.set(accept, { Rider: rider, Priority: "High" }), [accept, acceptSuggested]));
      expect(a.job).toMatchObject({ kind: "new_orders", action: "accept_pickup", actionLabel: "Accept & assign pickup rider", title: "Accept & assign pickup rider · New orders", counts: { rows: 2, errors: 0, toApply: 2 } });
      expect(a.job.columns.map((c: { key: string }) => c.key)).not.toContain("action");
      expect((await parcel(accept)).status).toBe("PENDING_CONFIRMATION"); // nothing changed yet
      expect((await allRows(s.ops.token, a.job.id)).items.find((r: { trackingId: string }) => r.trackingId === acceptSuggested)).toMatchObject({ plan: { usedSuggestion: true, riderLabel: "R-4048 · Rider R-4048" }, actionLabel: "Accept & assign pickup rider" });
      const aDone = await apply(s.ops.token, a.job, "new_orders");
      expect(aDone).toMatchObject({ status: "COMPLETED", background: false, result: { applied: 2, failed: 0 } });
      expect(await parcel(accept)).toMatchObject({ status: "PICKUP_ASSIGNED", pickupRiderId: s.rider.rider.id });
      expect(await parcel(acceptSuggested)).toMatchObject({ status: "PICKUP_ASSIGNED", pickupRiderId: s.rider.rider.id });
      // High priority first; the batch number on the services' audit records.
      const order = (await ctx.prisma.auditLog.findMany({ where: { action: "parcel.status_change" }, orderBy: { createdAt: "asc" } })).filter(l => (l.data as { bulkUpdate?: { number: string } }).bulkUpdate?.number === a.job.number);
      expect(order.map(l => (l.data as { trackingId: string }).trackingId)).toEqual([accept, acceptSuggested]);
      expect(order[0].data).toMatchObject({ from: "PENDING_CONFIRMATION", to: "PICKUP_ASSIGNED", bulkUpdate: { id: a.job.id } });
      expect(events.some(e => e.type === "parcel.updated" && e.id === accept)).toBe(true);
      expect((await allRows(s.ops.token, a.job.id, "applied")).items.find((r: { trackingId: string }) => r.trackingId === accept).result).toBe('Now "Pickup assigned" · pickup by R-4048 · Rider R-4048');

      // ── New orders › Cancel: the reason is required; a row without one is skipped ──
      const c = await run(s.ops.token, "new_orders", "cancel", x => (x.set(cancel, { Reason: "Merchant cancelled by phone" }), [cancel, notCancelled]));
      expect(c.job.counts).toMatchObject({ rows: 1, ignored: 1, toApply: 1 });
      await apply(s.ops.token, c.job, "new_orders");
      expect(await parcel(cancel)).toMatchObject({ status: "PICKUP_CANCELLED", cancelReason: "Merchant cancelled by phone" });
      expect((await parcel(notCancelled)).status).toBe("PENDING_CONFIRMATION");

      // ── New orders › Change to drop-off / Change to rider pickup ──
      const td = await run(s.ops.token, "new_orders", "to_drop_off", x => (x.set(toDropOff, { "New drop-off hub": s.gulshan.name }), [toDropOff]));
      await apply(s.ops.token, td.job, "new_orders");
      expect(await parcel(toDropOff)).toMatchObject({ intake: "DROP_OFF", dropOffHubId: s.gulshan.id });
      const tp = await run(s.ops.token, "new_orders", "to_pickup", () => [toPickup]);
      await apply(s.ops.token, tp.job, "new_orders");
      expect(await parcel(toPickup)).toMatchObject({ intake: "PICKUP", dropOffHubId: null });

      // ── New orders › Complete details ──
      const cd = await run(s.ops.token, "new_orders", "complete_details", x => (x.set(needs, { "Set recipient name": "Nabila Ahmed", "Set address": "Road 7", "Set district": "Dhaka Central", "Set zone": "Dhanmondi" }), [needs]));
      expect(cd.job.counts).toMatchObject({ errors: 0, toApply: 1 });
      await apply(s.ops.token, cd.job, "new_orders");
      expect(await parcel(needs)).toMatchObject({ incomplete: false, recipientName: "Nabila Ahmed", deliveryDistrict: "Dhaka Central", deliveryZone: "Dhanmondi" });
      expect(await ctx.prisma.auditLog.findFirst({ where: { action: "parcel.complete_details" } })).toMatchObject({ data: { bulkUpdate: { number: cd.job.number } } });

      // ── Pickup › Assign / reassign pickup rider, then Mark picked up ──
      const ra = await run(s.ops.token, "pickup", "reassign_pickup", x => (x.set(acceptSuggested, { "New rider": "R-4050" }), [acceptSuggested]));
      await apply(s.ops.token, ra.job, "pickup");
      expect((await parcel(acceptSuggested)).pickupRiderId).toBe(s.other.rider.id);
      const pu = await run(s.ops.token, "pickup", "mark_picked_up", () => [accept, acceptSuggested]);
      expect(pu.job.counts).toMatchObject({ toApply: 2 });
      await apply(s.ops.token, pu.job, "pickup");
      expect((await parcel(accept)).status).toBe("PICKED_UP");

      // ── Hub desk › Receive at hub: a drop-off at its own hub (Hub empty) and a picked-up parcel ──
      const rc = await run(s.ops.token, "hub_desk", "receive_at_hub", x => (x.set(accept, { "Receiving hub": s.gulshan.name }), [dropOff, accept]));
      expect(rc.job.counts).toMatchObject({ errors: 0, toApply: 2 });
      await apply(s.ops.token, rc.job, "hub_desk");
      expect(await parcel(dropOff)).toMatchObject({ status: "AT_HUB", currentHubId: s.gulshan.id });
      expect(await parcel(accept)).toMatchObject({ status: "AT_HUB", currentHubId: s.gulshan.id });

      // ── Delivery › Assign delivery rider: no delivery code yet (it's sent when the rider starts the delivery) ──
      const ad = await run(s.ops.token, "delivery", "assign_delivery", x => (x.set(dropOff, { Rider: "R-4048" }), [dropOff]));
      await apply(s.ops.token, ad.job, "delivery");
      expect(await parcel(dropOff)).toMatchObject({ status: "ASSIGNED", deliveryRiderId: s.rider.rider.id });
      expect(await ctx.prisma.outboxMessage.count({ where: { template: "parcel.delivery_code", trackingId: dropOff } })).toBe(0);
      expect((await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: dropOff } })).deliveryOtpEncrypted).toBeNull();

      // ── Hub desk › Mark exception (reason) → Problems › Resolve, Schedule return ──
      const ex = await run(s.ops.token, "hub_desk", "mark_exception", x => (x.set(accept, { Reason: "Label torn" }), [accept]));
      await apply(s.ops.token, ex.job, "hub_desk");
      expect((await parcel(accept)).status).toBe("EXCEPTION");
      const rs = await run(s.ops.token, "problems", "resolve_status", x => (x.set(accept, { "New status": "At hub" }), [accept]));
      await apply(s.ops.token, rs.job, "problems");
      expect((await parcel(accept)).status).toBe("AT_HUB");
      // Returns lists only parcels back after a delivery attempt; All parcels can return it.
      expect((await exported(s.ops.token, "returns", "schedule_return")).ids).not.toContain(accept);
      const ret = await run(s.ops.token, "all", "schedule_return", x => (x.set(accept, { Reason: "Recipient refused" }), [accept]));
      await apply(s.ops.token, ret.job);
      expect(await parcel(accept)).toMatchObject({ status: "RETURN_SCHEDULED", returnReason: "Recipient refused" });

      // ── All parcels › Change status and Add note ──
      const confirm = await book(s);
      await assignPickup(s, confirm);
      const cs = await run(s.ops.token, "all", "change_status", x => (x.set(confirm, { "New status": "Pickup confirmed" }), [confirm]));
      await apply(s.ops.token, cs.job);
      expect((await parcel(confirm)).status).toBe("PICKUP_CONFIRMED");
      const an = await run(s.ops.token, "all", "add_note", x => (x.set(confirm, { Note: "Call before pickup" }), [confirm]));
      await apply(s.ops.token, an.job);
      expect(await ctx.prisma.trackingEvent.count({ where: { parcel: { trackingId: confirm }, title: "Note", description: "Call before pickup" } })).toBe(1);
      spy.mockRestore();
    });

    it("completes a \"Needs info\" order and assigns its delivery rider in one row", async () => {
      const s = await setup();
      const id = await incomplete(s, "INC-2");
      await assignPickup(s, id);
      await status(s.ops.token, id, { status: "PICKED_UP" });
      await status(s.ops.token, id, { status: "AT_HUB", hubId: s.gulshan.id });
      const x = await exported(s.ops.token, "delivery", "assign_delivery");
      expect(x.row(id)[x.col("Missing fields")]).toBe("Recipient name, Address, District, Zone");
      expect(x.row(id)[x.col("Suggested rider")]).toBe(""); // no suggestion before the details are known
      x.set(id, { Rider: "R-4048" });
      const refused = await upload(s.ops.token, x.file([id]), { kind: "delivery", action: "assign_delivery" });
      const row = (await allRows(s.ops.token, refused.body.id)).items[0];
      expect(row.status).toBe("ERROR");
      expect(row.errors.map((e: { text: string }) => e.text)).toContain(`Row 2 · Set recipient name: ${id} needs the recipient name before a delivery rider: fill Set recipient name (or complete it first)`);
      x.set(id, { "Set recipient name": "Nabila", "Set address": "Road 7", "Set district": "Dhaka Central", "Set zone": "Dhanmondi" });
      const ok = await upload(s.ops.token, x.file([id]), { kind: "delivery", action: "assign_delivery" });
      expect(ok.body.counts).toMatchObject({ errors: 0, toApply: 1 });
      expect((await apply(s.ops.token, ok.body, "delivery")).result).toMatchObject({ applied: 1 });
      expect(await parcel(id)).toMatchObject({ status: "ASSIGNED", incomplete: false, deliveryRiderId: s.rider.rider.id });
    });
  });

  describe("validation", () => {
    it("checks lifecycle, scope, riders, versions, unknown and duplicate rows; rows no longer eligible or changed since download are errors", async () => {
      const s = await setup();
      const pending = await book(s);
      const pending2 = await book(s);
      const changed = await book(s);
      const hubbed = await atHub(s);
      await ctx.prisma.rider.update({ where: { id: s.rider.rider.id }, data: { status: "OFFLINE", dailyCapacity: 1 } });

      const x = await exported(s.ops.token, "new_orders", "accept_pickup");
      x.set(pending, { Rider: "R-4048" }); // warning: off shift
      x.set(pending2, { Rider: "R-4048" }); // warnings: off shift, over capacity
      x.set(changed, { Rider: "R-4048" });
      await ctx.api("POST", `/parcels/${changed}/notes`, { token: s.ops.token, body: { note: "no version change" } });
      await assignPickup(s, changed, s.other); // changed since the download
      // Rows typed in: a parcel that can't take the action, an unknown tracking ID, a duplicate.
      const typed = (id: string) => x.row(pending).map((v, i) => (i === x.col("Tracking ID") ? id : i === x.col("version") ? "" : v));
      const file = x.file(undefined, [typed(hubbed), typed("DF-000000-ZZZZ"), x.row(pending)]);
      const checked = await upload(s.ops.token, file, { kind: "new_orders", action: "accept_pickup" });
      expect(checked.status, JSON.stringify(checked.body)).toBe(201);
      expect(checked.body.counts).toMatchObject({ rows: 6, ignored: 0, ready: 0, warnings: 2, errors: 4 });
      const all = await allRows(s.ops.token, checked.body.id);
      const of = (id: string) => all.items.find((r: { trackingId: string }) => r.trackingId === id);
      const texts = (r: { errors: { text: string }[]; warnings: { text: string }[] }) => [...r.errors, ...r.warnings].map(e => e.text);
      expect(of(pending).status).toBe("WARNING");
      expect(texts(of(pending)).join("\n")).toContain("R-4048 · Rider R-4048 is off shift");
      expect(texts(of(pending2)).join("\n")).toContain("R-4048 · Rider R-4048 would have 2 open stops (capacity 1)");
      expect(of(changed).errors[0]).toMatchObject({ column: "version" });
      expect(of(changed).errors[0].message).toContain(`${changed} changed since you downloaded it: now "Pickup assigned" (pickup R-4050 · Rider R-4050)`);
      expect(of(hubbed).errors[0]).toMatchObject({ column: "status", header: "Current status", message: 'A parcel that is "At hub" can\'t get a pickup rider' });
      const n = x.rows.length;
      expect(all.items.find((r: { rowNumber: number }) => r.rowNumber === n + 3).errors[0].text).toBe(`Row ${n + 3} · Tracking ID: Unknown tracking ID "DF-000000-ZZZZ"`);
      expect(all.items.find((r: { rowNumber: number }) => r.rowNumber === n + 4).errors[0].message).toMatch(new RegExp(`${pending} is already in row \\d+: one row per parcel`));
      expect((await allRows(s.ops.token, checked.body.id, "apply")).total).toBe(2);
      expect((await allRows(s.ops.token, checked.body.id, "error")).total).toBe(4);

      // Change status never sets Delivered; Resolve only its statuses.
      const cs = await exported(s.ops.token, "all", "change_status");
      cs.set(hubbed, { "New status": "Delivered" });
      const delivered = await upload(s.ops.token, cs.file([hubbed]), { kind: "all", action: "change_status" });
      expect((await allRows(s.ops.token, delivered.body.id)).items[0].errors[0].message).toBe('"Delivered" can\'t be set here: Delivered is set only by the rider, with proof and COD');

      // Hub operators: other hubs' parcels, hubs and riders are out of scope.
      const dhn = await atHub(s, s.dhanmondi.id);
      const y = await exported(s.ops.token, "all", "schedule_return");
      y.set(dhn, { Reason: "Refused" });
      const scoped = await upload(s.hubOp.token, y.file([dhn]), { kind: "all", action: "schedule_return" });
      expect((await allRows(s.hubOp.token, scoped.body.id)).items[0].errors[0].message).toBe(`${dhn} isn't part of your hubs' work`);
      const z = await exported(s.ops.token, "new_orders", "accept_pickup");
      z.set(pending, { Rider: "R-4050" });
      const scopedRider = await upload(s.hubOp.token, z.file([pending]), { kind: "new_orders", action: "accept_pickup" });
      expect((await allRows(s.hubOp.token, scopedRider.body.id)).items[0].errors[0].message).toBe(`R-4050 · Rider R-4050 works at ${s.dhanmondi.name}: you can only assign your own hubs' riders`);
      const w = await exported(s.ops.token, "new_orders", "to_drop_off");
      w.set(pending2, { "New drop-off hub": s.dhanmondi.name });
      const scopedHub = await upload(s.hubOp.token, w.file([pending2]), { kind: "new_orders", action: "to_drop_off" });
      expect((await allRows(s.hubOp.token, scopedHub.body.id)).items[0].errors[0].message).toBe("You can only switch parcels to drop-off at your own hub");
      expect((await ctx.api("POST", `/bulk-updates/${scopedHub.body.id}/apply`, { token: s.hubOp.token })).body.error.code).toBe("NOTHING_TO_APPLY");
      // Only the uploader applies.
      expect((await ctx.api("POST", `/bulk-updates/${checked.body.id}/apply`, { token: s.hubOp.token })).status).toBe(404);

      // A template that needs input: blank rows are skipped; a file with none filled in is refused.
      const blank = await exported(s.ops.token, "new_orders", "cancel");
      const none = await upload(s.ops.token, blank.file(), { kind: "new_orders", action: "cancel" });
      expect(none.body.error).toMatchObject({ code: "NO_ACTIONS", message: `None of the ${blank.rows.length} rows has Reason filled in. Fill it in for the parcels to change ("Cancel").` });
      // An unrelated file is refused.
      const wrong = await upload(s.ops.token, writeXlsx({ sheets: [{ name: "Orders", rows: [["Order ID", "Customer phone"], ["A", "01812000000"]] }] }), { kind: "all", action: "cancel" });
      expect(wrong.body.error.code).toBe("TEMPLATE_MISMATCH");
    });

    it("refuses another action's file and another page's file (except on All parcels), mixed and outdated files; keeps the action in history", async () => {
      const s = await setup();
      const a = await book(s);
      const b = await book(s);
      const x = await exported(s.ops.token, "new_orders", "accept_pickup");
      x.set(a, { Rider: "R-4048" });
      const file = x.file([a]);

      // Uploaded with another action: refused with what to do.
      const wrongAction = await upload(s.ops.token, file, { kind: "new_orders", action: "cancel" });
      expect(wrongAction.status).toBe(422);
      expect(wrongAction.body.error).toMatchObject({ code: "BULK_ACTION_MISMATCH", details: { fileAction: "accept_pickup", pageAction: "cancel" } });
      expect(wrongAction.body.error.message).toBe('This is the "Accept & assign pickup rider" file. Choose "Accept & assign pickup rider" to upload it, or download the "Cancel" file and fill that in.');
      // On another page: the action isn't offered there; without an action the page is refused.
      expect((await upload(s.ops.token, file, { kind: "delivery", action: "accept_pickup" })).body.error.code).toBe("BULK_ACTION_NOT_ON_PAGE");
      const wrongPage = await upload(s.ops.token, file, { kind: "delivery" });
      expect(wrongPage.body.error).toMatchObject({ code: "BULK_KIND_MISMATCH", details: { fileKind: "new_orders", pageKind: "delivery" } });
      expect(wrongPage.body.error.message).toBe('This is the "Accept & assign pickup rider" file of New orders. Upload it on the New orders page (or All parcels), or download a Delivery file here and fill that in.');
      // An All parcels file on a page: refused.
      const generic = await exported(s.ops.token, "all", "accept_pickup");
      generic.set(a, { Rider: "R-4048" });
      const refused = await upload(s.ops.token, generic.file([a]), { kind: "new_orders", action: "accept_pickup" });
      expect(refused.body.error).toMatchObject({ code: "BULK_KIND_MISMATCH", message: 'This is the "Accept & assign pickup rider" file of All parcels. Upload it on the All parcels page, or download a New orders file here and fill that in.' });
      // Rows of two files in one: refused.
      const cancelFile = await exported(s.ops.token, "new_orders", "cancel");
      const mixed = writeXlsx({ sheets: [{ name: "Accept & assign pickup", rows: [x.header, x.row(a), x.row(b).map((v, i) => (x.header[i] === "template" ? "new_orders:cancel" : v))] }] });
      expect((await upload(s.ops.token, mixed, { kind: "new_orders" })).body.error.code).toBe("BULK_KIND_MIXED");
      expect(cancelFile.ids.sort()).toEqual([a, b].sort());
      // Files from before action templates (an Action column, or a page-only template): refused politely.
      const legacy = writeXlsx({ sheets: [{ name: "Parcels", rows: [["Tracking ID", "Current status", "Action", "Rider", "version", "template"], [a, "Pending operations confirmation", "Accept & assign pickup rider", "R-4048", "0", "new_orders"]] }] });
      const old = await upload(s.ops.token, legacy, { kind: "new_orders", action: "accept_pickup" });
      expect(old.body.error.code).toBe("BULK_TEMPLATE_OUTDATED");
      expect(old.body.error.message).toBe("This file was downloaded before bulk updates became one file per action. Choose the action in the bulk update dialog, download a fresh file for it and fill that in.");
      const noTemplate = writeXlsx({ sheets: [{ name: "Parcels", rows: [["Tracking ID", "Action", "Reason / note"], [a, "Cancel", "x"]] }] });
      expect((await upload(s.ops.token, noTemplate, { kind: "all", action: "cancel" })).body.error.code).toBe("BULK_TEMPLATE_OUTDATED");
      // A hand-made file without the template column takes the chosen action.
      const handMade = await upload(s.ops.token, writeXlsx({ sheets: [{ name: "Sheet1", rows: [["Tracking ID", "Reason"], [b, "Duplicate order"]] }] }), { kind: "new_orders", action: "cancel" });
      expect(handMade.status, JSON.stringify(handMade.body)).toBe(201);
      expect(handMade.body).toMatchObject({ kind: "new_orders", action: "cancel", counts: { toApply: 1 } });
      await ctx.api("DELETE", `/bulk-updates/${handMade.body.id}`, { token: s.ops.token });

      // On its own page (multipart fields) and on All parcels: accepted, stored with its page and action.
      const own = await upload(s.ops.token, file, { fields: { kind: "new_orders", action: "accept_pickup" } });
      expect(own.status, JSON.stringify(own.body)).toBe(201);
      expect(own.body).toMatchObject({ kind: "new_orders", action: "accept_pickup", title: "Accept & assign pickup rider · New orders", page: "New orders", counts: { toApply: 1 } });
      await ctx.api("DELETE", `/bulk-updates/${own.body.id}`, { token: s.ops.token });
      const onAll = await upload(s.ops.token, file, { kind: "all", action: "accept_pickup" });
      expect(onAll.status).toBe(201);
      expect(onAll.body).toMatchObject({ kind: "new_orders", action: "accept_pickup" });
      // Applying it as another page or action is refused; on All parcels it applies.
      expect((await ctx.api("POST", `/bulk-updates/${onAll.body.id}/apply?kind=delivery`, { token: s.ops.token })).body.error.code).toBe("BULK_KIND_MISMATCH");
      expect((await ctx.api("POST", `/bulk-updates/${onAll.body.id}/apply?kind=new_orders&action=cancel`, { token: s.ops.token })).body.error.code).toBe("BULK_ACTION_MISMATCH");
      expect((await apply(s.ops.token, onAll.body)).result).toMatchObject({ applied: 1 });
      expect(await ctx.prisma.auditLog.findFirst({ where: { action: "bulk_update.validate", entityId: onAll.body.id } })).toMatchObject({ data: { kind: "new_orders", action: "accept_pickup" } });

      // History: filtered by page and by action, with the action in the title.
      const note = await exported(s.ops.token, "new_orders", "add_note");
      note.set(b, { Note: "Call first" });
      const noteJob = await upload(s.ops.token, note.file([b]), { kind: "new_orders", action: "add_note" });
      const byAction = await ctx.api("GET", "/bulk-updates?action=accept_pickup", { token: s.ops.token });
      expect(byAction.body.items.map((j: { number: string }) => j.number)).toEqual([onAll.body.number]);
      expect(byAction.body.items[0]).toMatchObject({ action: "accept_pickup", actionLabel: "Accept & assign pickup rider", title: "Accept & assign pickup rider · New orders", kindTitle: "New orders bulk update" });
      expect((await ctx.api("GET", "/bulk-updates?action=add_note", { token: s.ops.token })).body.items.map((j: { number: string }) => j.number)).toEqual([noteJob.body.number]);
      expect((await ctx.api("GET", "/bulk-updates?kind=new_orders", { token: s.ops.token })).body.items).toHaveLength(2);
      expect((await ctx.api("GET", "/bulk-updates?kind=delivery", { token: s.ops.token })).body.items).toHaveLength(0);
      expect((await ctx.api("GET", "/bulk-updates?action=nope", { token: s.ops.token })).status).toBe(422);
    });
  });

  describe("idempotency, failed rows and background jobs", () => {
    it("never applies a row twice, reports changes made meanwhile, and gives the rows not applied back in the action's format", async () => {
      const s = await setup();
      const a = await book(s);
      const b = await book(s);
      const c = await book(s);
      const x = await exported(s.ops.token, "new_orders", "accept_pickup");
      x.set(a, { Rider: "R-4048" });
      x.set(c, { Rider: "R-4048" });
      const file = x.file([a, c]);
      const first = await upload(s.ops.token, file, { kind: "new_orders", action: "accept_pickup" });
      // c is changed by someone else after the check: refused at apply, the other still applies.
      await ctx.api("POST", `/parcels/${c}/cancel`, { token: s.ops.token, body: { reason: "dup" } });
      const applied = await apply(s.ops.token, first.body, "new_orders");
      expect(applied.result).toMatchObject({ applied: 1, failed: 1, notApplied: 1 });
      const failed = (await allRows(s.ops.token, first.body.id, "failed")).items[0];
      expect(failed.errors[0]).toMatchObject({ column: "version" });
      expect(failed.errors[0].message).toContain(`${c} changed since you downloaded it`);

      // The same file again: nothing is applied twice.
      const again = await upload(s.ops.token, file, { kind: "new_orders", action: "accept_pickup" });
      const againRows = await allRows(s.ops.token, again.body.id);
      const of = (id: string) => againRows.items.find((r: { trackingId: string }) => r.trackingId === id);
      expect(of(a)).toMatchObject({ status: "ALREADY_DONE", result: "Already done: pickup already assigned to R-4048 · Rider R-4048" });
      expect(of(c).status).toBe("ERROR");
      expect(await ctx.prisma.auditLog.count({ where: { action: "parcel.status_change", entityId: (await parcel(a)).id } })).toBe(1);
      // A note applied by an earlier upload of the same file is "already done".
      const note = await exported(s.ops.token, "new_orders", "add_note");
      note.set(b, { Note: "Fragile" });
      const noteFile = note.file([b]);
      await apply(s.ops.token, (await upload(s.ops.token, noteFile, { kind: "new_orders", action: "add_note" })).body);
      const noteAgain = await upload(s.ops.token, noteFile, { kind: "new_orders", action: "add_note" });
      expect((await apply(s.ops.token, noteAgain.body)).result).toMatchObject({ applied: 0, alreadyDone: 1 });
      expect(await ctx.prisma.trackingEvent.count({ where: { parcel: { trackingId: b }, description: "Fragile" } })).toBe(1);

      // Rows not applied: the same action's sheet with an Error column, which can be fixed and uploaded again.
      const dl = await download(s.ops.token, `/bulk-updates/${first.body.id}/failed-rows`);
      expect(dl.status).toBe(200);
      expect(String(dl.headers["content-disposition"])).toContain(`${first.body.number}-not-applied.xlsx`);
      const back = readXlsx(dl.buffer, { maxRows: 100, prefer: DATA_SHEETS });
      expect(back.rows[0]).toEqual([...x.header, "Error"]);
      expect(back.rows[1][0]).toBe(c);
      expect(back.rows[1][x.col("template")]).toBe("new_orders:accept_pickup");
      expect(back.rows[1].at(-1)).toContain(`Row ${x.rows.filter(r => [a, c].includes(r[0])).findIndex(r => r[0] === c) + 2}: version: ${c} changed since you downloaded it`);
      expect(workbookXml(dl.buffer)).toContain('<sheet name="Accept &amp; assign pickup"');
      expect(helpOf(dl.buffer)[0][0]).toBe("Delivery Fast · Accept & assign pickup rider · New orders");
      expect(sheetXml(dl.buffer)).toContain("<sheetProtection");
      const reupload = await upload(s.ops.token, dl.buffer, { kind: "new_orders", action: "accept_pickup", name: "fixed.xlsx" });
      expect(reupload.status).toBe(201);
      expect(reupload.body.ignoredColumns).toEqual([]);
      expect((await allRows(s.ops.token, reupload.body.id)).items[0].errors.map((e: { column: string }) => e.column)).toContain("version");
      const csv = await download(s.ops.token, `/bulk-updates/${first.body.id}/failed-rows?format=csv`);
      expect(csv.buffer.toString("utf8")).toContain("Tracking ID,Current status,Suggested rider,Rider");
      expect(csv.buffer.toString("utf8")).toContain("new_orders:accept_pickup");

      // History.
      const history = await ctx.api("GET", "/bulk-updates", { token: s.ops.token });
      expect(history.body.items.map((j: { number: string }) => j.number)).toContain(first.body.number);
      expect(history.body.items.find((j: { number: string }) => j.number === first.body.number).downloads.failedRows).toBe(`/api/v1/bulk-updates/${first.body.id}/failed-rows`);
    });

    it("applies large files in the background with progress events and resumes safely", async () => {
      const s = await setup();
      const rows = Array.from({ length: 120 }, (_, i) => ({ order_ref: `BG-${i}`, "Customer name": "Nabila", phone: "01812000000", address: "Road 7", district: "Dhaka Central", zone: "Dhanmondi" }));
      const imp = await ctx.api("POST", "/imports/validate", { token: s.ops.token, body: { kind: "ecommerce", merchantId: s.shop.id, rows } });
      await ctx.api("POST", `/imports/${imp.body.id}/commit`, { token: s.ops.token });
      await ctx.app.get(ImportJobsService).process(imp.body.id);
      expect(await ctx.prisma.parcel.count()).toBe(120);

      const x = await exported(s.ops.token, "new_orders", "add_note", "&preset=pending_review");
      expect(x.ids).toHaveLength(120);
      for (const id of x.ids) x.set(id, { Note: "Checked by phone" });
      const checked = await upload(s.ops.token, x.file(), { kind: "new_orders", action: "add_note" });
      expect(checked.body.counts).toMatchObject({ toApply: 120 });
      const realtime = ctx.app.get(RealtimeService);
      const events: RealtimeEvent[] = [];
      const spy = vi.spyOn(realtime, "publish").mockImplementation((...e: RealtimeEvent[]) => void events.push(...e));
      const queued = await apply(s.ops.token, checked.body, "new_orders");
      expect(queued).toMatchObject({ status: "QUEUED", background: true, progress: { processed: 0, total: 120 } });
      // One running bulk update per person.
      const small = await exported(s.ops.token, "new_orders", "add_note");
      small.set(small.ids[0], { Note: "other" });
      const other = await upload(s.ops.token, small.file([small.ids[0]]), { kind: "new_orders", action: "add_note" });
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

      // Change to drop-off: re-priced with the package's drop-off discount; refused where the package has no drop-off.
      const d = await run(s.ops.token, "new_orders", "to_drop_off", x => (x.set(toDropOff, { "New drop-off hub": s.gulshan.name }), x.set(refused, { "New drop-off hub": s.gulshan.name }), [toDropOff, refused]));
      expect(d.job.counts).toMatchObject({ rows: 2, errors: 1, toApply: 1 });
      const dRows = (await allRows(s.ops.token, d.job.id)).items as { trackingId: string; status: string; plan: { price?: { before: number; after: number; difference: number } } | null; errors: { column: string; text: string }[] }[];
      expect(dRows.find(r => r.trackingId === toDropOff)!.plan?.price).toEqual({ before, after: before - 20, difference: -20 });
      expect(dRows.find(r => r.trackingId === refused)).toMatchObject({ status: "ERROR", errors: [{ column: "status", text: expect.stringContaining("SERVICE_NOT_IN_PACKAGE: Merchant drop at hub") }] });
      expect(d.job.pricing).toEqual({ rows: 1, before, after: before - 20, difference: -20 });
      expect(Number((await parcel(toDropOff)).totalCharge)).toBe(before); // nothing changed yet
      expect((await apply(s.ops.token, d.job, "new_orders")).pricing).toEqual(d.job.pricing);
      expect(Number((await parcel(toDropOff)).totalCharge)).toBe(before - 20);

      // Complete details: a heavier weight re-prices; only a name doesn't.
      const c = await run(s.ops.token, "new_orders", "complete_details", x => {
        x.set(reweighed, { "Set recipient name": "Nabila Ahmed", "Set address": "Road 7", "Set district": "Dhaka South", "Set zone": "Motijheel", "Set weight (kg)": "3.2" });
        x.set(renamed, { "Set recipient name": "Only A Name" });
        return [reweighed, renamed];
      });
      expect(c.job.counts).toMatchObject({ rows: 2, errors: 0, toApply: 2 });
      const cRows = (await allRows(s.ops.token, c.job.id)).items as { trackingId: string; plan: { price?: { before: number; after: number; difference: number } } | null }[];
      const reweigh = cRows.find(r => r.trackingId === reweighed)!.plan!.price!;
      expect(reweigh.before).toBe(Number((await parcel(reweighed)).totalCharge));
      expect(reweigh.difference).toBe(reweigh.after - reweigh.before);
      expect(reweigh.difference).toBeGreaterThanOrEqual(2 * 15); // 3.2 kg instead of the 0.5 kg default: at least two more started kg
      expect(cRows.find(r => r.trackingId === renamed)!.plan?.price).toBeUndefined();
      expect(c.job.pricing).toEqual({ rows: 1, before: reweigh.before, after: reweigh.after, difference: reweigh.difference });
      expect((await apply(s.ops.token, c.job, "new_orders")).result).toMatchObject({ applied: 2, failed: 0 });
      expect(Number((await parcel(reweighed)).totalCharge)).toBe(reweigh.after);
    });
  });
});
