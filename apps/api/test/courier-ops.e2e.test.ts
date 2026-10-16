import { hub, parcelBody, resetDatabase, riderUser, startApp, userWithRoles, type TestContext } from "./helpers";

/** Network configuration, CN stock, SLA engine, scans, shifts, reports and routing. */
describe("courier operations: configuration and engines", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  const setup = async () => {
    const gulshan = await hub(ctx, "HUB-GUL");
    const dhanmondi = await hub(ctx, "HUB-DHN");
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops Manager");
    const gulOp = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: gulshan.id }], "Gulshan Operator");
    const dhnOp = await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: dhanmondi.id }], "Dhanmondi Operator");
    const support = await userWithRoles(ctx, [{ role: "SUPPORT_AGENT" }], "Support");
    const rider = await riderUser(ctx, "R-4001", gulshan.id);
    const rider2 = await riderUser(ctx, "R-4002", dhanmondi.id);
    const shop = await ctx.prisma.merchant.create({
      data: { code: "MR-7001", type: "ECOMMERCE", name: "Label Shop", status: "ACTIVE", contactName: "Owner", contactPhone: "+8801911000000", pickupAddress: "House 5", pickupArea: "Gulshan 1", pickupDistrict: "Dhaka North" },
    });
    return { gulshan, dhanmondi, ops, gulOp, dhnOp, support, rider, rider2, shop };
  };
  type Setup = Awaited<ReturnType<typeof setup>>;
  const book = async (s: Setup, overrides: Record<string, unknown> = {}, token = s.ops.token) => {
    const res = await ctx.api("POST", "/ops/parcels", { token, body: parcelBody(overrides) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { trackingId: string };
  };
  const atHub = async (s: Setup, hubId: string, overrides: Record<string, unknown> = {}) => {
    const { trackingId } = await book(s, overrides);
    await ctx.api("POST", `/parcels/${trackingId}/assign-pickup`, { token: s.ops.token, body: { riderId: s.rider.rider.id } });
    const res = await ctx.api("POST", `/parcels/${trackingId}/status`, { token: s.ops.token, body: { status: "AT_HUB", hubId } });
    expect(res.body.status, JSON.stringify(res.body)).toBe("AT_HUB");
    return trackingId;
  };

  describe("network configuration", () => {
    it("manages zones, routes and hub capacity against the catalog", async () => {
      const s = await setup();
      const route = await ctx.api("POST", "/routes", { token: s.ops.token, body: { code: "dhn-r1", name: "Dhanmondi morning", hubId: s.dhanmondi.id, defaultRiderId: s.rider2.rider.id } });
      expect(route.status, JSON.stringify(route.body)).toBe(201);
      expect(route.body).toMatchObject({ code: "DHN-R1", defaultRider: { id: s.rider2.rider.id } });

      const zone = await ctx.api("POST", "/zones", {
        token: s.ops.token,
        body: { code: "dhc-dhn", name: "Dhanmondi", district: "Dhaka Central", areas: ["Dhanmondi Road 7"], hubId: s.dhanmondi.id, routeId: route.body.id, lat: 23.746, lng: 90.376 },
      });
      expect(zone.status, JSON.stringify(zone.body)).toBe(201);
      expect(zone.body).toMatchObject({ code: "DHC-DHN", hub: { id: s.dhanmondi.id }, route: { code: "DHN-R1" } });

      const notInCatalog = await ctx.api("POST", "/zones", { token: s.ops.token, body: { code: "X1", name: "Atlantis", district: "Dhaka Central" } });
      expect(notInCatalog.body.error.code).toBe("UNKNOWN_ZONE");
      expect((await ctx.api("POST", "/zones", { token: s.ops.token, body: { code: "X2", name: "Dhanmondi", district: "Dhaka Central", areas: ["Nowhere"] } })).body.error.code).toBe("UNKNOWN_AREA");
      expect((await ctx.api("POST", "/zones", { token: s.ops.token, body: { code: "X3", name: "Dhanmondi", district: "Dhaka Central" } })).body.error.code).toBe("ZONE_EXISTS");
      expect((await ctx.api("POST", "/zones", { token: s.gulOp.token, body: { code: "X4", name: "Gulshan", district: "Dhaka North" } })).status).toBe(403);
      expect((await ctx.api("POST", "/zones", { token: s.ops.token, body: { code: "X5", name: "Gulshan", district: "Dhaka North", lat: 23.7 } })).status).toBe(422);

      const list = await ctx.api("GET", `/zones?hubId=${s.dhanmondi.id}`, { token: s.gulOp.token });
      expect(list.body.items).toHaveLength(1);
      const patched = await ctx.api("PATCH", `/zones/${zone.body.id}`, { token: s.ops.token, body: { active: false } });
      expect(patched.body.active).toBe(false);
      expect((await ctx.api("GET", "/routes", { token: s.ops.token })).body.items[0]).toMatchObject({ code: "DHN-R1", zones: 1 });

      // Hub capacity: set on the hub, load from parcels held there.
      expect((await ctx.api("PATCH", `/hubs/${s.gulshan.id}`, { token: s.ops.token, body: { capacity: 2, lat: 23.79, lng: 90.41 } })).body).toMatchObject({ capacity: 2, lat: 23.79 });
      await atHub(s, s.gulshan.id);
      await atHub(s, s.gulshan.id);
      const capacity = await ctx.api("GET", "/hubs/capacity", { token: s.gulOp.token });
      expect(capacity.body).toEqual([expect.objectContaining({ hub: expect.objectContaining({ id: s.gulshan.id }), capacity: 2, load: 2, utilisation: 100, state: "Over capacity" })]);

      expect((await ctx.api("DELETE", `/routes/${route.body.id}`, { token: s.ops.token })).body.deleted).toBe(true);
      expect((await ctx.prisma.deliveryZone.findUniqueOrThrow({ where: { id: zone.body.id } })).routeId).toBeNull();
    });

    it("creates riders with a daily capacity (Add rider)", async () => {
      const s = await setup();
      const res = await ctx.api("POST", "/riders", { token: s.ops.token, body: { name: "New Rider", phone: "01733445566", hubId: s.gulshan.id, vehicle: "BICYCLE", zone: "Gulshan", dailyCapacity: 25 } });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({ phone: "+8801733445566", dailyCapacity: 25, hub: { id: s.gulshan.id } });
      expect((await ctx.api("POST", "/riders", { token: s.gulOp.token, body: { name: "X", phone: "01733445567" } })).status).toBe(403);
    });
  });

  describe("CN stock", () => {
    it("allocates, prints, books with and voids consignment numbers", async () => {
      const s = await setup();
      expect((await ctx.api("POST", "/cn/batches", { token: s.gulOp.token, body: { count: 3 } })).body.error.code).toBe("HUB_REQUIRED");
      expect((await ctx.api("POST", "/cn/batches", { token: s.gulOp.token, body: { count: 3, hubId: s.dhanmondi.id } })).status).toBe(403);
      const batch = await ctx.api("POST", "/cn/batches", { token: s.gulOp.token, body: { count: 3, hubId: s.gulshan.id, note: "Counter labels" } });
      expect(batch.status, JSON.stringify(batch.body)).toBe(201);
      expect(batch.body.stock).toMatchObject({ total: 3, available: 3, used: 0, void: 0 });
      const [cn1, cn2, cn3] = batch.body.items.map((i: { cn: string }) => i.cn);
      expect(cn1).toMatch(/^PP-\d{6}-[0-9A-Z]{5}$/);

      const printed = await ctx.api("POST", `/cn/batches/${batch.body.id}/print`, { token: s.gulOp.token, body: {} });
      expect(printed.body.labels).toHaveLength(3);
      expect((await ctx.api("POST", `/cn/batches/${batch.body.id}/print`, { token: s.gulOp.token, body: { cns: [cn1] } })).body.labels[0].reprint).toBe(true);

      // Booking with a pre-printed CN uses it as the tracking ID, once.
      const booked = await book(s, { cn: cn1.toLowerCase() });
      expect(booked.trackingId).toBe(cn1);
      const again = await ctx.api("POST", "/ops/parcels", { token: s.ops.token, body: parcelBody({ cn: cn1 }) });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe("CN_USED");
      expect((await ctx.api("POST", "/ops/parcels", { token: s.ops.token, body: parcelBody({ cn: "PP-261015-AAAAA" }) })).body.error.code).toBe("CN_UNKNOWN");

      // A merchant's batch is only usable by that merchant.
      const merchantBatch = await ctx.api("POST", "/cn/batches", { token: s.ops.token, body: { count: 1, merchantId: s.shop.id } });
      const mcn = merchantBatch.body.items[0].cn;
      expect((await ctx.api("POST", "/ops/parcels", { token: s.ops.token, body: parcelBody({ cn: mcn }) })).body.error.code).toBe("CN_NOT_YOURS");
      const forShop = await ctx.api("POST", "/ops/parcels", { token: s.ops.token, body: { merchantId: s.shop.id, ...parcelBody({ cn: mcn }), sender: undefined, pickup: undefined } });
      expect(forShop.status, JSON.stringify(forShop.body)).toBe(201);
      expect(forShop.body.trackingId).toBe(mcn);

      const voided = await ctx.api("POST", "/cn/stock/void", { token: s.gulOp.token, body: { cns: [cn2, cn1, "PP-261015-QQQQQ"], reason: "Label torn" } });
      expect(voided.body.voided).toBe(1);
      expect(voided.body.skipped.map((x: { reason: string }) => x.reason).sort()).toEqual(["Already used", "Not in CN stock"]);
      expect((await ctx.api("POST", "/ops/parcels", { token: s.ops.token, body: parcelBody({ cn: cn2 }) })).body.error.code).toBe("CN_VOID");

      const lookup = await ctx.api("GET", `/cn/stock/${cn1}`, { token: s.gulOp.token });
      expect(lookup.body).toMatchObject({ status: "USED", parcel: { trackingId: cn1 } });
      expect((await ctx.api("GET", `/cn/stock?status=AVAILABLE`, { token: s.gulOp.token })).body.items.map((i: { cn: string }) => i.cn)).toEqual([cn3]);
      expect((await ctx.api("GET", "/cn/summary", { token: s.gulOp.token })).body).toMatchObject({ batches: 1, total: 3, available: 1, used: 1, void: 1 });
      expect((await ctx.api("GET", "/cn/batches", { token: s.dhnOp.token })).body.items).toHaveLength(0);
      expect((await ctx.api("GET", `/cn/batches/${batch.body.id}`, { token: s.dhnOp.token })).status).toBe(403);
    });
  });

  describe("SLA engine", () => {
    it("sets due dates from policies, flags breaches, escalates and reports", async () => {
      const s = await setup();
      const policy = await ctx.api("POST", "/sla/policies", {
        token: s.ops.token,
        body: { name: "Gulshan to Dhanmondi same day", serviceLevel: "Same day", originDistrict: "Dhaka North", originZone: "Gulshan", destDistrict: "Dhaka Central", destZone: "Dhanmondi", pickupMinutes: 60, deliveryMinutes: 300, atRiskMinutes: 30 },
      });
      expect(policy.status, JSON.stringify(policy.body)).toBe(201);
      expect((await ctx.api("POST", "/sla/policies", { token: s.ops.token, body: { name: "Bad", serviceLevel: "Regular", originZone: "Gulshan", pickupMinutes: 60, deliveryMinutes: 60 } })).status).toBe(422);
      expect((await ctx.api("POST", "/sla/policies", { token: s.gulOp.token, body: { name: "X", serviceLevel: "Regular", pickupMinutes: 60, deliveryMinutes: 60 } })).status).toBe(403);

      const before = Date.now();
      const { trackingId } = await book(s);
      const parcel = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId } });
      expect(parcel.pickupDueAt!.getTime() - before).toBeGreaterThan(55 * 60_000);
      expect(parcel.pickupDueAt!.getTime() - before).toBeLessThan(65 * 60_000);
      expect(parcel.deliveryDueAt!.getTime() - before).toBeLessThan(305 * 60_000);
      // No matching policy: built-in defaults (regular, other district: 3 days).
      const regular = await book(s, { serviceLevel: "Regular" });
      const r = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: regular.trackingId } });
      expect(Math.round((r.deliveryDueAt!.getTime() - r.createdAt.getTime()) / 3600_000)).toBe(72);

      // The pickup is overdue: the monitor flags it, raises an alert and escalates once (by email by default).
      await ctx.prisma.user.update({ where: { id: s.ops.user.id }, data: { email: "ops-manager@example.com" } });
      await ctx.prisma.parcel.update({ where: { trackingId }, data: { pickupDueAt: new Date(Date.now() - 60_000) } });
      const atHubId = await atHub(s, s.gulshan.id);
      await ctx.prisma.parcel.update({ where: { trackingId: atHubId }, data: { deliveryDueAt: new Date(Date.now() + 10 * 60_000) } });
      const run = await ctx.api("POST", "/sla/monitor", { token: s.ops.token });
      expect(run.status, JSON.stringify(run.body)).toBe(200);
      expect(run.body).toMatchObject({ newAlerts: 2, breached: 1, atRisk: 1 });
      expect((await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId } })).slaState).toBe("BREACHED");
      expect((await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: atHubId } })).slaState).toBe("AT_RISK");
      expect(await ctx.prisma.outboxMessage.count({ where: { template: "ops.sla_breach", to: "ops-manager@example.com" } })).toBe(1);
      expect((await ctx.api("POST", "/sla/monitor", { token: s.ops.token })).body.newAlerts).toBe(0);

      const alerts = await ctx.api("GET", "/sla/alerts?open=true", { token: s.ops.token });
      expect(alerts.body.items).toHaveLength(2);
      const breach = alerts.body.items.find((a: { level: string }) => a.level === "BREACHED");
      expect(breach).toMatchObject({ leg: "PICKUP", parcel: { trackingId } });
      expect((await ctx.api("GET", "/sla/alerts?open=true", { token: s.gulOp.token })).body.items).toHaveLength(1); // the at-hub one
      const ack = await ctx.api("POST", `/sla/alerts/${breach.id}/acknowledge`, { token: s.ops.token, body: { note: "Rider on the way" } });
      expect(ack.body).toMatchObject({ acknowledgedBy: "Ops Manager", note: "Rider on the way" });
      expect((await ctx.api("POST", `/sla/alerts/${breach.id}/acknowledge`, { token: s.ops.token, body: {} })).body.error.code).toBe("ALREADY_ACKNOWLEDGED");
      expect((await ctx.api("GET", "/sla/summary", { token: s.ops.token })).body).toMatchObject({ breached: 1, atRisk: 1, openAlerts: { breached: 0, atRisk: 1 } });

      // The leg completes: the alert resolves.
      await ctx.api("POST", `/parcels/${trackingId}/assign-pickup`, { token: s.ops.token, body: { riderId: s.rider.rider.id } });
      await ctx.api("POST", `/parcels/${trackingId}/status`, { token: s.ops.token, body: { status: "AT_HUB", hubId: s.gulshan.id } });
      expect((await ctx.api("POST", "/sla/monitor", { token: s.ops.token })).body.resolved).toBe(1);

      const report = await ctx.api("GET", "/sla/report", { token: s.ops.token });
      expect(report.status, JSON.stringify(report.body)).toBe(200);
      expect(report.body.pickups).toMatchObject({ total: 0 });
      expect(report.body.alerts).toMatchObject({ pickupBreached: 1, deliveryAtRisk: 1 });
    });
  });

  describe("scans", () => {
    it("records scans and computes compliance per hub", async () => {
      const s = await setup();
      const p1 = await atHub(s, s.gulshan.id);
      const p2 = await atHub(s, s.gulshan.id);
      const ok = await ctx.api("POST", "/scans", { token: s.gulOp.token, body: { code: p1.toLowerCase(), kind: "HUB_RECEIVE", hubId: s.gulshan.id, source: "CAMERA" } });
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
      expect(ok.body).toMatchObject({ trackingId: p1, ok: true });
      expect((await ctx.api("POST", "/scans", { token: s.gulOp.token, body: { code: p2, kind: "HUB_RECEIVE", hubId: s.dhanmondi.id } })).status).toBe(403);
      expect((await ctx.api("POST", "/scans", { token: s.gulOp.token, body: { code: p2, kind: "RIDER_PICKUP" } })).status).toBe(403);
      expect((await ctx.api("POST", "/scans", { token: s.rider.token, body: { code: p2, kind: "RIDER_PICKUP", source: "CAMERA" } })).status).toBe(201);
      expect((await ctx.api("POST", "/scans", { token: s.gulOp.token, body: { code: "x", kind: "HUB_RECEIVE" } })).status).toBe(422);

      const compliance = await ctx.api("GET", "/scans/compliance", { token: s.ops.token });
      expect(compliance.status, JSON.stringify(compliance.body)).toBe(200);
      const gul = compliance.body.hubs.find((h: { hub: { id: string } }) => h.hub.id === s.gulshan.id);
      expect(gul).toMatchObject({ expected: 2, scanned: 1, missed: 1, camera: 1, compliance: 50 });
      expect(compliance.body.totals).toMatchObject({ scans: 2, camera: 2 });
      const list = await ctx.api("GET", `/scans?hubId=${s.gulshan.id}`, { token: s.gulOp.token });
      expect(list.body.items).toEqual([expect.objectContaining({ trackingId: p1, by: "Gulshan Operator", hub: expect.objectContaining({ id: s.gulshan.id }) })]);
    });
  });

  describe("rider shifts", () => {
    it("schedules shifts, checks riders in and out and reports attendance", async () => {
      const s = await setup();
      const today = new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
      const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
      const schedule = await ctx.api("POST", "/shifts/schedules", {
        token: s.ops.token,
        body: { riderId: s.rider.rider.id, weekdays: [weekday], startTime: "00:00", endTime: "23:59", validFrom: today },
      });
      expect(schedule.status, JSON.stringify(schedule.body)).toBe(201);
      const overlap = await ctx.api("POST", "/shifts/schedules", { token: s.ops.token, body: { riderId: s.rider.rider.id, weekdays: [weekday], startTime: "08:00", endTime: "12:00", validFrom: today } });
      expect(overlap.body.error.code).toBe("SHIFT_OVERLAP");
      expect((await ctx.api("POST", "/shifts/schedules", { token: s.gulOp.token, body: { riderId: s.rider.rider.id, weekdays: [1], startTime: "08:00", endTime: "12:00", validFrom: today } })).status).toBe(403);
      expect((await ctx.api("POST", "/shifts/schedules", { token: s.ops.token, body: { riderId: s.rider.rider.id, weekdays: [], startTime: "8", endTime: "12:00", validFrom: today } })).status).toBe(422);

      const mine = await ctx.api("GET", "/rider/shift", { token: s.rider.token });
      expect(mine.body).toMatchObject({ checkedIn: false, schedule: { startTime: "00:00", endTime: "23:59" } });
      const checkIn = await ctx.api("POST", "/rider/shift/check-in", { token: s.rider.token, body: { lat: 23.79, lng: 90.41 } });
      expect(checkIn.status, JSON.stringify(checkIn.body)).toBe(200);
      expect(checkIn.body).toMatchObject({ workDate: today, shift: "00:00–23:59", checkIn: { lat: 23.79 } });
      expect((await ctx.prisma.rider.findUniqueOrThrow({ where: { id: s.rider.rider.id } })).status).toBe("ONLINE");
      expect((await ctx.api("POST", "/rider/shift/check-in", { token: s.rider.token, body: {} })).body.error.code).toBe("ALREADY_CHECKED_IN");
      expect((await ctx.api("POST", "/rider/shift/check-in", { token: s.ops.token, body: {} })).status).toBe(403);

      const roster = await ctx.api("GET", "/shifts/today", { token: s.gulOp.token });
      expect(roster.body).toEqual([expect.objectContaining({ rider: expect.objectContaining({ id: s.rider.rider.id }), state: "On shift" })]);
      const out = await ctx.api("POST", "/rider/shift/check-out", { token: s.rider.token, body: {} });
      expect(out.body.checkOutAt).toBeTruthy();
      expect((await ctx.api("POST", "/rider/shift/check-out", { token: s.rider.token, body: {} })).body.error.code).toBe("NOT_CHECKED_IN");

      const attendance = await ctx.api("GET", `/shifts/attendance?riderId=${s.rider.rider.id}`, { token: s.ops.token });
      expect(attendance.body.items).toHaveLength(1);
      const id = attendance.body.items[0].id;
      const corrected = await ctx.api("PATCH", `/shifts/attendance/${id}`, { token: s.ops.token, body: { checkInAt: new Date(Date.now() - 3600_000).toISOString(), note: "Forgot to check in" } });
      expect(corrected.status, JSON.stringify(corrected.body)).toBe(200);
      expect(corrected.body).toMatchObject({ source: "OPERATIONS", minutes: expect.any(Number) });
      expect((await ctx.api("PATCH", `/shifts/attendance/${id}`, { token: s.ops.token, body: { checkOutAt: new Date(Date.now() - 7200_000).toISOString(), note: "Wrong" } })).status).toBe(422);

      const report = await ctx.api("GET", "/shifts/report", { token: s.ops.token });
      const row = report.body.riders.find((x: { rider: { id: string } }) => x.rider.id === s.rider.rider.id);
      expect(row).toMatchObject({ scheduled: 1, present: 1, absent: 0, hoursWorked: expect.any(Number) });
      expect(row.hoursWorked).toBeGreaterThanOrEqual(0.9);
    });
  });

  describe("reports", () => {
    it("runs reports as CSV and schedules emailed reports", async () => {
      const s = await setup();
      await atHub(s, s.gulshan.id);
      const today = new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
      const run = await ctx.api("POST", "/reports/run", { token: s.ops.token, body: { kind: "DELIVERIES", from: today, to: today } });
      expect(run.status, JSON.stringify(run.body)).toBe(200);
      expect(run.body.table.rows).toEqual([[today, 1, 0, 0, 0, null, 0, 0, 0, 0]]);
      const csv = await ctx.app.inject({ method: "GET", url: `/api/v1/reports/runs/${run.body.run.id}/download`, headers: { authorization: `Bearer ${s.ops.token}` } });
      expect(csv.headers["content-type"]).toContain("text/csv");
      expect(csv.body.startsWith("﻿Date,Booked")).toBe(true);
      for (const kind of ["SLA", "COD", "RIDERS"]) expect((await ctx.api("POST", "/reports/run", { token: s.ops.token, body: { kind, from: today, to: today } })).status).toBe(200);
      // Hub operators get their own hub's report only.
      const hubRun = await ctx.api("POST", "/reports/run", { token: s.gulOp.token, body: { kind: "RIDERS", from: today, to: today } });
      expect(hubRun.body.run.hubId).toBe(s.gulshan.id);
      expect((await ctx.api("GET", `/reports/runs/${run.body.run.id}`, { token: s.gulOp.token })).status).toBe(403);
      expect((await ctx.api("POST", "/reports/run", { token: s.ops.token, body: { kind: "DELIVERIES", from: today, to: "2020-01-01" } })).status).toBe(422);

      const schedule = await ctx.api("POST", "/reports/schedules", { token: s.ops.token, body: { name: "Daily deliveries", kind: "DELIVERIES", frequency: "DAILY", hour: 8, recipients: ["Ops@Example.com"] } });
      expect(schedule.status, JSON.stringify(schedule.body)).toBe(201);
      expect(schedule.body.recipients).toEqual(["ops@example.com"]);
      expect(new Date(schedule.body.nextRunAt).getTime()).toBeGreaterThan(Date.now());
      expect((await ctx.api("POST", "/reports/schedules", { token: s.ops.token, body: { name: "Weekly", kind: "SLA", frequency: "WEEKLY", recipients: ["a@example.com"] } })).status).toBe(422);
      const sent = await ctx.api("POST", `/reports/schedules/${schedule.body.id}/run`, { token: s.ops.token });
      expect(sent.body).toMatchObject({ status: "OK", scheduleId: schedule.body.id });
      expect(await ctx.prisma.outboxMessage.count({ where: { to: "ops@example.com" } })).toBe(1);
      expect((await ctx.api("GET", `/reports/runs?scheduleId=${schedule.body.id}`, { token: s.ops.token })).body.items).toHaveLength(1);
    });
  });

  describe("routing and dispatch", () => {
    it("suggests riders by zone and load, accepts in bulk and plans routes", async () => {
      const s = await setup();
      await ctx.api("PATCH", `/riders/${s.rider.rider.id}`, { token: s.ops.token, body: { zone: "Dhanmondi", dailyCapacity: 1 } });
      const extra = await riderUser(ctx, "R-4003", s.gulshan.id);
      const p1 = await atHub(s, s.gulshan.id);
      const p2 = await atHub(s, s.gulshan.id);

      const suggestions = await ctx.api("GET", `/routing/suggestions?hubId=${s.gulshan.id}&kind=delivery`, { token: s.gulOp.token });
      expect(suggestions.status, JSON.stringify(suggestions.body)).toBe(200);
      const byParcel = Object.fromEntries(suggestions.body.suggestions.map((x: { trackingId: string; rider: { id: string } }) => [x.trackingId, x.rider.id]));
      // R-4001 covers Dhanmondi but takes one stop a day; the other goes to R-4003.
      expect(Object.values(byParcel).sort()).toEqual([s.rider.rider.id, extra.rider.id].sort());
      expect((await ctx.api("GET", `/routing/suggestions?hubId=${s.dhanmondi.id}`, { token: s.gulOp.token })).status).toBe(403);

      const accepted = await ctx.api("POST", "/routing/suggestions/accept", {
        token: s.gulOp.token,
        body: { items: [...Object.entries(byParcel).map(([trackingId, riderId]) => ({ trackingId, riderId })), { trackingId: "PP-261015-ZZZZZ", riderId: extra.rider.id }] },
      });
      expect(accepted.body.assigned).toHaveLength(2);
      expect(accepted.body.failed).toEqual([expect.objectContaining({ trackingId: "PP-261015-ZZZZZ" })]);
      for (const id of [p1, p2]) expect((await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: id } })).status).toBe("ASSIGNED");

      // Route plan: pins from the parcel, start at the hub; no OSRM in tests → nearest neighbour.
      await ctx.prisma.hub.update({ where: { id: s.gulshan.id }, data: { lat: 23.7925, lng: 90.4078 } });
      const p3 = await atHub(s, s.gulshan.id, { delivery: { category: "Home", street: "Road 2", zone: "Banani", district: "Dhaka North", lat: 23.794, lng: 90.404 } });
      const p4 = await atHub(s, s.gulshan.id, { delivery: { category: "Home", street: "Road 11", zone: "Uttara", district: "Dhaka North", lat: 23.875, lng: 90.39 } });
      await ctx.prisma.rider.update({ where: { id: extra.rider.id }, data: { dailyCapacity: 10 } });
      for (const id of [p4, p3]) await ctx.api("POST", `/parcels/${id}/assign-delivery`, { token: s.ops.token, body: { riderId: extra.rider.id } });
      const plan = await ctx.api("POST", "/routing/optimize", { token: s.gulOp.token, body: { riderId: extra.rider.id } });
      expect(plan.status, JSON.stringify(plan.body)).toBe(200);
      expect(plan.body.plan).toMatchObject({ engine: "NEAREST_NEIGHBOUR", startSource: "hub" });
      expect(plan.body.plan.stops.map((x: { trackingId: string }) => x.trackingId)).toEqual([p3, p4]);
      expect(plan.body.unlocated).toHaveLength(1); // the Dhanmondi parcel has no pin and no zone centre
      expect((await ctx.api("GET", `/routing/plans?riderId=${extra.rider.id}`, { token: s.ops.token })).body).toHaveLength(1);
      expect((await ctx.api("POST", "/routing/optimize", { token: s.dhnOp.token, body: { riderId: extra.rider.id } })).status).toBe(403);

      const map = await ctx.api("GET", "/routing/map", { token: s.ops.token });
      expect(map.body.parcels.map((x: { trackingId: string }) => x.trackingId).sort()).toEqual([p3, p4].sort());
      expect(map.body.hubs.find((h: { id: string }) => h.id === s.gulshan.id)).toMatchObject({ lat: 23.7925 });
      expect((await ctx.api("GET", "/routing/map", { token: s.rider.token })).status).toBe(403);
    });
  });
});
