import { DATA_SHEETS } from "../src/modules/bulk-updates/bulk-workbook";
import { readXlsx } from "../src/modules/imports/xlsx/xlsx-reader";
import { writeXlsx } from "../src/modules/imports/xlsx/xlsx-writer";
import { hub, parcelBody, resetDatabase, riderUser, startApp, userWithRoles, type TestContext } from "./helpers";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Hub-to-hub transfers: the "Add to transfer bag" Excel file (Transfers page) and receiving bags / parcels by scan at the destination hub. */
describe("hub transfers", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  const setup = async () => {
    const gulshan = await hub(ctx, "HUB-GUL");
    const dhanmondi = await hub(ctx, "HUB-DHN");
    const uttara = await hub(ctx, "HUB-UTT");
    // Serving hubs: Gulshan zone → Gulshan hub, Dhanmondi zone (parcelBody's destination) → Dhanmondi hub.
    await ctx.prisma.deliveryZone.create({ data: { code: "DN-GUL", name: "Gulshan", district: "Dhaka North", hubId: gulshan.id } });
    await ctx.prisma.deliveryZone.create({ data: { code: "DC-DHN", name: "Dhanmondi", district: "Dhaka Central", hubId: dhanmondi.id } });
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops Manager");
    const gulOp = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: gulshan.id }], "Gulshan Operator");
    const dhnOp = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: dhanmondi.id }], "Dhanmondi Operator");
    const rider = await riderUser(ctx, "R-5001", gulshan.id);
    return { gulshan, dhanmondi, uttara, ops, gulOp, dhnOp, rider };
  };
  type Setup = Awaited<ReturnType<typeof setup>>;

  /** Books a parcel and receives it at a hub (normal workflow). */
  const atHub = async (s: Setup, hubId: string, extra: Record<string, unknown> = {}) => {
    const booked = await ctx.api("POST", "/ops/parcels", { token: s.ops.token, body: parcelBody(extra) });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    const id = booked.body.trackingId as string;
    await ctx.api("POST", `/parcels/${id}/assign-pickup`, { token: s.ops.token, body: { riderId: s.rider.rider.id } });
    const res = await ctx.api("POST", `/parcels/${id}/status`, { token: s.ops.token, body: { status: "AT_HUB", hubId } });
    expect(res.body.status, JSON.stringify(res.body)).toBe("AT_HUB");
    return id;
  };
  const parcel = (id: string) => ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: id } });

  async function download(token: string, url: string) {
    const res = await ctx.app.inject({ method: "GET", url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` } });
    return { status: res.statusCode, headers: res.headers, buffer: res.rawPayload, body: res.statusCode >= 400 ? JSON.parse(res.body) : undefined };
  }
  async function upload(token: string, data: Buffer, query = "kind=transfers&action=transfer") {
    const boundary = `----dfTransfer${Math.random().toString(16).slice(2)}`;
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="transfer.xlsx"\r\nContent-Type: ${XLSX}\r\n\r\n`),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await ctx.app.inject({ method: "POST", url: `/api/v1/bulk-updates/validate?${query}`, payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${token}` } });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  }
  async function exported(token: string) {
    const res = await download(token, "/bulk-updates/export?kind=transfers&action=transfer");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const sheet = readXlsx(res.buffer, { maxRows: 20_000, prefer: DATA_SHEETS });
    const header = sheet.rows[0];
    const rows = sheet.rows.slice(1).map(r => header.map((_, i) => r[i] ?? ""));
    const col = (name: string) => header.findIndex(h => h === name || h === `${name} *`);
    const row = (id: string) => rows.find(r => r[col("Tracking ID")] === id)!;
    const set = (id: string, values: Record<string, string>) => Object.entries(values).forEach(([k, v]) => (row(id)[col(k)] = v));
    const file = (extra: string[][] = []) => writeXlsx({ sheets: [{ name: sheet.sheetName || "Parcels", rows: [header, ...rows, ...extra] }] });
    return { res, sheet, header, rows, col, row, set, file, ids: rows.map(r => r[col("Tracking ID")]) };
  }
  const rowsOf = async (token: string, id: string) => (await ctx.api("GET", `/bulk-updates/${id}/rows?pageSize=200`, { token })).body.items as { trackingId: string; status: string; errors: { column: string; message: string }[]; result: string | null }[];

  it("downloads the parcels to send, checks the file and bags them by destination and label, then seals and plans a trip", async () => {
    const s = await setup();
    const [p1, p2, p3] = [await atHub(s, s.gulshan.id), await atHub(s, s.gulshan.id), await atHub(s, s.gulshan.id)];
    // Delivered from its own hub: not a transfer.
    const local = await atHub(s, s.gulshan.id, { delivery: { category: "Home", street: "Road 1", zone: "Gulshan", district: "Dhaka North" } });
    const atDhanmondi = await atHub(s, s.dhanmondi.id);

    // The Transfers page offers the one action; the file lists my hub's parcels for other hubs.
    const actions = await ctx.api("GET", "/bulk-updates/actions?kind=transfers", { token: s.gulOp.token });
    expect(actions.body.map((a: { action: string; count: number }) => [a.action, a.count])).toEqual([["transfer", 3]]);
    const x = await exported(s.gulOp.token);
    expect(x.sheet.sheetName).toBe("Transfer to hub");
    expect(x.ids.sort()).toEqual([p1, p2, p3].sort());
    expect(x.ids).not.toContain(local);
    expect(x.ids).not.toContain(atDhanmondi);
    expect(x.header.slice(0, 6)).toEqual(["Tracking ID", "Current status", "Suggested destination", "Destination hub", "Bag", "Note"]);
    expect(x.row(p1)[x.col("Suggested destination")]).toBe(s.dhanmondi.name);
    expect(x.row(p1)[x.col("Destination hub")]).toBe(s.dhanmondi.name);
    expect(x.row(p1)[x.col("District")]).toBe("Dhaka Central");
    const lists = readXlsx(x.res.buffer, { maxRows: 1000, prefer: ["Lists"] });
    const destIdx = lists.rows[0].indexOf("Destination hubs");
    expect(lists.rows.slice(1).map(r => r[destIdx]).filter(Boolean)).toEqual(expect.arrayContaining([s.gulshan.name, s.dhanmondi.name, s.uttara.name]));
    // The managers see it network wide.
    expect((await exported(s.ops.token)).ids.sort()).toEqual([p1, p2, p3].sort());

    // Two parcels grouped under a label, one in the upload's default bag.
    x.set(p1, { Bag: "north-1" });
    x.set(p2, { Bag: "NORTH-1", Note: "Fragile" });
    const checked = await upload(s.gulOp.token, x.file());
    expect(checked.status, JSON.stringify(checked.body)).toBe(201);
    expect(checked.body).toMatchObject({ kind: "transfers", action: "transfer", title: "Add to transfer bag · Transfers" });
    expect(checked.body.counts).toMatchObject({ rows: 3, ready: 3, errors: 0 });

    // A trip from another hub can't be chosen.
    const foreign = await ctx.api("POST", "/linehaul/trips", { token: s.ops.token, body: { originHubId: s.uttara.id, destHubId: s.dhanmondi.id, vehicleRegNo: "DHAKA METRO-TA 11-9999", driverName: "Other", driverPhone: "01711222334" } });
    const refused = await ctx.api("POST", `/bulk-updates/${checked.body.id}/apply?kind=transfers`, { token: s.gulOp.token, body: { transfer: { tripId: foreign.body.id } } });
    expect(refused.status).toBe(403);

    const applied = await ctx.api("POST", `/bulk-updates/${checked.body.id}/apply?kind=transfers&action=transfer`, {
      token: s.gulOp.token,
      body: { transfer: { seal: true, newTrip: { vehicleRegNo: "dhaka metro-ta 11-2345", driverName: "Karim Mia", driverPhone: "01711222333" } } },
    });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body.status).toBe("COMPLETED");
    expect(applied.body.result).toMatchObject({ applied: 3, failed: 0 });
    const result = applied.body.transfer.result;
    expect(result.problems).toEqual([]);
    expect(result.bags).toHaveLength(2);
    const north = result.bags.find((b: { label: string }) => b.label === "NORTH-1");
    const other = result.bags.find((b: { label: string }) => b.label === checked.body.number);
    expect(north).toMatchObject({ parcels: 2, status: "SEALED", destHub: s.dhanmondi.name, sealNo: north.number });
    expect(other).toMatchObject({ parcels: 1, status: "SEALED" });
    expect(result.trips).toEqual([expect.objectContaining({ created: true, bags: 2, destHub: s.dhanmondi.name })]);
    expect(north.trip).toBe(result.trips[0].number);
    const rows = await rowsOf(s.gulOp.token, checked.body.id);
    expect(rows.find(r => r.trackingId === p1)!.result).toContain(`In bag ${north.number} (NORTH-1)`);

    // Lifecycle unchanged: the parcels wait at the hub until the truck departs.
    for (const id of [p1, p2, p3]) expect(await parcel(id)).toMatchObject({ status: "AT_HUB", currentHubId: s.gulshan.id });
    const audit = await ctx.prisma.auditLog.findMany({ where: { action: "linehaul.bag_add" } });
    expect(audit).toHaveLength(3);
    expect(audit.every(a => (a.data as { bulkUpdate?: { number: string } }).bulkUpdate?.number === checked.body.number)).toBe(true);
    const depart = await ctx.api("POST", `/linehaul/trips/${result.trips[0].number}/depart`, { token: s.gulOp.token });
    expect(depart.status, JSON.stringify(depart.body)).toBe(200);
    for (const id of [p1, p2, p3]) expect(await parcel(id)).toMatchObject({ status: "IN_TRANSIT", currentHubId: s.dhanmondi.id });

    // Uploading the same file again changes nothing (they are bagged already).
    const again = await upload(s.gulOp.token, x.file());
    expect(again.body.counts).toMatchObject({ alreadyDone: 3, ready: 0 });
    // Nothing left to send.
    expect((await exported(s.gulOp.token)).ids).toEqual([]);
  });

  it("refuses parcels not at my hub, a wrong destination and a wrong bag, and offers the rows back", async () => {
    const s = await setup();
    const [p1, p2, p3, p4] = [await atHub(s, s.gulshan.id), await atHub(s, s.gulshan.id), await atHub(s, s.gulshan.id), await atHub(s, s.gulshan.id)];
    const atDhanmondi = await atHub(s, s.dhanmondi.id, { delivery: { category: "Home", street: "Road 1", zone: "Gulshan", district: "Dhaka North" } });
    const toUttara = (await ctx.api("POST", "/linehaul/bags", { token: s.gulOp.token, body: { originHubId: s.gulshan.id, destHubId: s.uttara.id } })).body;
    const toDhanmondi = (await ctx.api("POST", "/linehaul/bags", { token: s.gulOp.token, body: { originHubId: s.gulshan.id, destHubId: s.dhanmondi.id } })).body;

    const x = await exported(s.gulOp.token);
    x.set(p1, { "Destination hub": s.gulshan.name }); // its own hub
    x.set(p2, { Bag: toUttara.number }); // bag for another destination
    x.set(p3, { Bag: "BG-999999-9999" }); // no such bag
    x.set(p4, { Bag: `${toDhanmondi.number} → ${s.dhanmondi.name}` }); // an open bag from the list
    const extra = [...x.header.map(() => "")];
    extra[x.col("Tracking ID")] = atDhanmondi; // another hub's parcel
    const checked = await upload(s.gulOp.token, x.file([extra]));
    expect(checked.status, JSON.stringify(checked.body)).toBe(201);
    expect(checked.body.counts).toMatchObject({ rows: 5, ready: 1, errors: 4 });
    const rows = await rowsOf(s.gulOp.token, checked.body.id);
    const errorOf = (id: string) => rows.find(r => r.trackingId === id)!.errors[0];
    expect(errorOf(p1)).toMatchObject({ column: "dest_hub" });
    expect(errorOf(p1).message).toContain("already at");
    expect(errorOf(p2)).toMatchObject({ column: "bag" });
    expect(errorOf(p2).message).toContain(`goes to ${s.uttara.name}`);
    expect(errorOf(p3)).toMatchObject({ column: "bag", message: expect.stringContaining("No bag BG-999999-9999") });
    expect(errorOf(atDhanmondi)).toMatchObject({ column: "tracking_id" });

    const failed = await download(s.gulOp.token, `/bulk-updates/${checked.body.id}/failed-rows`);
    expect(failed.status).toBe(200);
    expect(readXlsx(failed.buffer, { maxRows: 100, prefer: DATA_SHEETS }).rows).toHaveLength(5);

    // The one good row goes into the named bag; the trip option is optional.
    const applied = await ctx.api("POST", `/bulk-updates/${checked.body.id}/apply?kind=transfers`, { token: s.gulOp.token });
    expect(applied.body.result).toMatchObject({ applied: 1, notApplied: 4 });
    expect(applied.body.transfer.result.bags).toEqual([expect.objectContaining({ number: toDhanmondi.number, status: "OPEN", parcels: 1 })]);
    expect((await ctx.prisma.linehaulBagItem.count({ where: { bagId: toDhanmondi.id } }))).toBe(1);

    // The parcel changed since the download (version) → refused on upload.
    const y = await exported(s.gulOp.token);
    await ctx.api("POST", `/parcels/${p1}/status`, { token: s.ops.token, body: { status: "EXCEPTION", note: "Damaged" } });
    const stale = await upload(s.gulOp.token, y.file());
    expect((await rowsOf(s.gulOp.token, stale.body.id)).find(r => r.trackingId === p1)!.status).toBe("ERROR");
  });

  describe("receiving at the destination hub", () => {
    const departed = async (s: Setup, groups: string[][]) => {
      const trip = (await ctx.api("POST", "/linehaul/trips", { token: s.gulOp.token, body: { originHubId: s.gulshan.id, destHubId: s.dhanmondi.id, vehicleRegNo: "DHAKA METRO-TA 11-2345", driverName: "Karim Mia", driverPhone: "01711222333" } })).body;
      const bags: { id: string; number: string }[] = [];
      for (const ids of groups) {
        const bag = (await ctx.api("POST", "/linehaul/bags", { token: s.gulOp.token, body: { originHubId: s.gulshan.id, destHubId: s.dhanmondi.id } })).body;
        for (const id of ids) expect((await ctx.api("POST", `/linehaul/bags/${bag.number}/items`, { token: s.gulOp.token, body: { code: id, source: "KEYBOARD" } })).status).toBe(200);
        await ctx.api("POST", `/linehaul/bags/${bag.number}/seal`, { token: s.gulOp.token, body: { sealNo: `S-${bag.number}` } });
        await ctx.api("POST", `/linehaul/trips/${trip.id}/bags`, { token: s.gulOp.token, body: { bag: bag.number } });
        bags.push(bag);
      }
      expect((await ctx.api("POST", `/linehaul/trips/${trip.id}/depart`, { token: s.gulOp.token })).status).toBe(200);
      return { trip, bags };
    };
    const scan = (s: Setup, code: string, extra: Record<string, unknown> = {}, token = s.dhnOp.token) =>
      ctx.api("POST", "/linehaul/receive-scan", { token, body: { hubId: s.dhanmondi.id, code, source: "CAMERA", ...extra } });

    it("receives a whole bag by its label and parcels one by one, flagging missing and extra", async () => {
      const s = await setup();
      const [p1, p2, p3, p4] = [await atHub(s, s.gulshan.id), await atHub(s, s.gulshan.id), await atHub(s, s.gulshan.id), await atHub(s, s.gulshan.id)];
      const stray = await atHub(s, s.gulshan.id);
      const { trip, bags } = await departed(s, [[p1, p2, p3], [p4]]);
      const [bagA, bagB] = bags;

      // Inbound transfers: the trip on its way with expected counts.
      const inbound = await ctx.api("GET", "/linehaul/inbound", { token: s.dhnOp.token });
      expect(inbound.status).toBe(200);
      expect(inbound.body.items).toEqual([expect.objectContaining({ number: trip.number, status: "DEPARTED", totals: expect.objectContaining({ bags: 2, expected: 4, received: 0, pending: 4 }) })]);
      expect(inbound.body.totals).toMatchObject({ trips: 1, onTheRoad: 1, expected: 4 });
      expect((await ctx.api("GET", "/linehaul/inbound", { token: s.gulOp.token })).body.items).toEqual([]);
      expect((await ctx.api("GET", `/linehaul/inbound?hubId=${s.dhanmondi.id}`, { token: s.gulOp.token })).status).toBe(403);
      // Only the destination hub's people.
      expect((await scan(s, bagB.number, {}, s.gulOp.token)).status).toBe(403);

      // The manifest selects the trip.
      const tripScan = await scan(s, trip.number.toLowerCase());
      expect(tripScan.body).toMatchObject({ outcome: "TRIP", ok: true, trip: { number: trip.number } });

      // Bag label: the whole bag.
      const whole = await scan(s, bagB.number, { tripId: trip.id });
      expect(whole.status, JSON.stringify(whole.body)).toBe(200);
      expect(whole.body).toMatchObject({ outcome: "BAG_RECEIVED", ok: true, bag: { number: bagB.number, status: "RECEIVED" } });
      expect(await parcel(p4)).toMatchObject({ status: "AT_HUB", currentHubId: s.dhanmondi.id });
      expect((await scan(s, bagB.number)).body.outcome).toBe("ALREADY_RECEIVED");

      // Items one by one, expected vs received.
      const one = await scan(s, p1, { tripId: trip.id, bagId: bagA.number });
      expect(one.body).toMatchObject({ outcome: "RECEIVED", ok: true, parcel: { trackingId: p1, status: "AT_HUB" } });
      expect(one.body.bag).toMatchObject({ number: bagA.number, status: "IN_TRANSIT", totals: expect.objectContaining({ received: 1, loaded: 2 }) });
      expect(one.body.trip.totals).toMatchObject({ expected: 4, received: 2, pending: 2 });
      expect(await parcel(p1)).toMatchObject({ status: "AT_HUB", currentHubId: s.dhanmondi.id });
      expect((await scan(s, p1)).body.outcome).toBe("ALREADY_RECEIVED");

      // Extra: a parcel not on any manifest coming here, recorded once against the bag being opened.
      const extra = await scan(s, stray, { tripId: trip.id, bagId: bagA.id });
      expect(extra.body).toMatchObject({ outcome: "EXTRA", ok: false });
      expect((await scan(s, stray, { tripId: trip.id, bagId: bagA.id })).body.outcome).toBe("EXTRA");
      const extras = await ctx.prisma.linehaulDiscrepancy.findMany({ where: { kind: "EXTRA" } });
      expect(extras).toEqual([expect.objectContaining({ trackingId: stray, bagId: bagA.id, tripId: trip.id, hubId: s.dhanmondi.id })]);
      expect(await parcel(stray)).toMatchObject({ status: "AT_HUB", currentHubId: s.gulshan.id });
      expect((await scan(s, "PP-000000-ZZZZZ")).body).toMatchObject({ outcome: "NOT_FOUND", ok: false });

      // Finish the bag: the parcel never scanned is missing; the trip has arrived.
      await scan(s, p2, { bagId: bagA.id });
      const finish = await ctx.api("POST", `/linehaul/bags/${bagA.number}/receive`, { token: s.dhnOp.token, body: { hubId: s.dhanmondi.id, trackingIds: [], source: "KEYBOARD" } });
      expect(finish.status, JSON.stringify(finish.body)).toBe(200);
      expect(finish.body).toMatchObject({ received: 0, missing: 1, bag: { status: "RECEIVED", totals: expect.objectContaining({ received: 2, missing: 1 }) } });
      expect(await parcel(p3)).toMatchObject({ status: "IN_TRANSIT" });
      expect(await ctx.prisma.linehaulDiscrepancy.findMany({ where: { kind: "MISSING" } })).toEqual([expect.objectContaining({ trackingId: p3, bagId: bagA.id })]);
      const after = (await ctx.api("GET", "/linehaul/inbound", { token: s.dhnOp.token })).body.items[0];
      expect(after).toMatchObject({ status: "ARRIVED", totals: expect.objectContaining({ bagsReceived: 2, received: 3, missing: 1, pending: 0 }) });
      expect(await ctx.prisma.auditLog.count({ where: { action: "linehaul.item_receive" } })).toBe(2);
      expect(await ctx.prisma.scanEvent.count({ where: { kind: "BAG_RECEIVE", ok: true } })).toBe(3);
    });

    it("the last parcel scanned completes the bag, and the Hub desk receive takes bags and bagged parcels", async () => {
      const s = await setup();
      const [p1, p2, p3] = [await atHub(s, s.gulshan.id), await atHub(s, s.gulshan.id), await atHub(s, s.gulshan.id)];
      const { trip, bags } = await departed(s, [[p1], [p2, p3]]);
      // Wrong hub: a bag addressed elsewhere.
      const uttOp = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: s.uttara.id }], "Uttara Operator");
      const wrong = await ctx.api("POST", "/linehaul/receive-scan", { token: uttOp.token, body: { hubId: s.uttara.id, code: bags[0].number, source: "KEYBOARD" } });
      expect(wrong.body).toMatchObject({ outcome: "WRONG_HUB", ok: false });

      const last = await scan(s, p1);
      expect(last.body).toMatchObject({ outcome: "RECEIVED", bag: { status: "RECEIVED" } });
      expect(last.body.message).toContain("is complete");

      // Hub desk → Receive: a bag label receives the bag; a bagged parcel is received out of its bag.
      const desk = (code: string) => ctx.api("POST", "/ops/hub-receive", { token: s.dhnOp.token, body: { hubId: s.dhanmondi.id, code, source: "KEYBOARD" } });
      const one = await desk(p2);
      expect(one.body).toMatchObject({ outcome: "RECEIVED", ok: true, parcel: { trackingId: p2, status: "AT_HUB" } });
      expect(one.body.transfer.bag).toMatchObject({ number: bags[1].number, totals: expect.objectContaining({ received: 1, loaded: 1 }) });
      const bag = await desk(bags[1].number);
      expect(bag.body).toMatchObject({ outcome: "BAG_RECEIVED", ok: true });
      expect(await parcel(p3)).toMatchObject({ status: "AT_HUB", currentHubId: s.dhanmondi.id });
      expect(await ctx.prisma.linehaulTrip.findUniqueOrThrow({ where: { id: trip.id } })).toMatchObject({ status: "ARRIVED" });
      expect(await ctx.prisma.linehaulBagItem.count({ where: { state: "RECEIVED" } })).toBe(3);
    });
  });
});
