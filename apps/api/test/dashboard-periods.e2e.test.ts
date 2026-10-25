import { hub, parcelBody, resetDatabase, startApp, userWithRoles, type TestContext } from "./helpers";
import { presetRange, resolvePeriod } from "../src/common/period";

// Dashboard period filters: every overview / stats / summary endpoint takes ?from=&to= (Dhaka days,
// inclusive; both or neither; from ≤ to; at most 366 days). Read-only (apps/api/src/common/period.ts).
describe("dashboard periods (from / to on overview, stats and summary endpoints)", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  // Dhaka is UTC+6: Oct 10 23:59:59 in Dhaka is 17:59:59Z, Oct 11 00:00 is 18:00Z.
  const LAST_OF_OCT_10 = new Date("2026-10-10T17:59:59.000Z");
  const FIRST_OF_OCT_11 = new Date("2026-10-10T18:00:00.000Z");
  const MID_OCT_11 = new Date("2026-10-11T06:00:00.000Z");
  const OCT_10 = "from=2026-10-10&to=2026-10-10";
  const OCT_11 = "from=2026-10-11&to=2026-10-11";

  const setup = async () => {
    const h = await hub(ctx, "HUB-PER");
    const shop = await ctx.prisma.merchant.create({
      data: { code: "MR-7001", type: "ECOMMERCE", name: "Period Shop", status: "ACTIVE", contactName: "Owner", contactPhone: "+8801911000000", pickupAddress: "House 5 Road 2", pickupArea: "Gulshan 1", pickupDistrict: "Dhaka North" },
    });
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops Manager");
    const owner = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: shop.id }], "Shop Owner");
    const finance = await userWithRoles(ctx, [{ role: "FINANCE" }], "Finance Staff");
    const admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Super Admin");
    const book = async () => {
      const res = await ctx.api("POST", "/ops/parcels", { token: ops.token, body: { merchantId: shop.id, ...parcelBody(), sender: undefined, pickup: undefined } });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: res.body.trackingId } });
    };
    // Two parcels on either side of midnight (Dhaka): one booked on Oct 10, one on Oct 11, delivered with COD on Oct 11.
    const late = await book();
    const early = await book();
    await ctx.prisma.parcel.update({ where: { id: late.id }, data: { createdAt: LAST_OF_OCT_10 } });
    await ctx.prisma.parcel.update({
      where: { id: early.id },
      data: { createdAt: FIRST_OF_OCT_11, pickedUpAt: FIRST_OF_OCT_11, status: "DELIVERED", deliveredAt: MID_OCT_11, estimatedDeliveryAt: new Date("2026-10-11T12:00:00.000Z") },
    });
    await ctx.prisma.codCollection.create({ data: { parcelId: early.id, amount: 1500, state: "AT_HUB", collectedAt: MID_OCT_11, hubId: h.id } });
    return { h, shop, ops, owner, finance, admin, late, early };
  };

  const get = async (token: string, url: string, status = 200) => {
    const res = await ctx.api("GET", url, { token });
    expect(res.status, `${url} → ${JSON.stringify(res.body)}`).toBe(status);
    return res.body;
  };

  it("resolves presets and periods in Dhaka time", () => {
    // Sunday Oct 18 2026, 01:00 in Dhaka (Oct 17 19:00Z): the Dhaka day, not the UTC one.
    const now = new Date("2026-10-17T19:00:00.000Z");
    expect(presetRange("today", now)).toEqual({ from: "2026-10-18", to: "2026-10-18" });
    expect(presetRange("yesterday", now)).toEqual({ from: "2026-10-17", to: "2026-10-17" });
    expect(presetRange("this_week", now)).toEqual({ from: "2026-10-17", to: "2026-10-18" }); // weeks start on Saturday
    expect(presetRange("last_7_days", now)).toEqual({ from: "2026-10-12", to: "2026-10-18" });
    expect(presetRange("this_month", now)).toEqual({ from: "2026-10-01", to: "2026-10-18" });
    expect(presetRange("last_month", now)).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    const p = resolvePeriod({ from: "2026-10-11", to: "2026-10-17" }, "today");
    expect(p.start.toISOString()).toBe("2026-10-10T18:00:00.000Z");
    expect(p.end.toISOString()).toBe("2026-10-17T18:00:00.000Z");
    expect(p).toMatchObject({ days: 7, bucket: "day", chosen: true, previous: { from: "2026-10-04", to: "2026-10-10" } });
    expect(resolvePeriod({ from: "2026-01-01", to: "2026-10-01" }, "today").bucket).toBe("month");
    expect(resolvePeriod(undefined, "today", now)).toMatchObject({ from: "2026-10-18", to: "2026-10-18", bucket: "hour", chosen: false });
  });

  it("rejects incomplete, reversed, too long and malformed periods on every endpoint", async () => {
    const s = await setup();
    const endpoints: [string, string][] = [
      [s.ops.token, "/ops/overview"],
      [s.ops.token, "/ops/stage-counts"],
      [s.ops.token, "/ops/analytics"],
      [s.owner.token, "/merchants/me/stats"],
      [s.admin.token, "/analytics/traffic"],
      [s.admin.token, "/admin/overview"],
    ];
    for (const [token, url] of endpoints) {
      const join = url.includes("?") ? "&" : "?";
      for (const bad of ["from=2026-10-10", "to=2026-10-10", "from=2026-10-12&to=2026-10-11", "from=2025-01-01&to=2026-01-02", "from=2026-13-01&to=2026-13-02", "from=yesterday&to=today"]) {
        const body = await get(token, `${url}${join}${bad}`, 422);
        expect(body.error.code, `${url}?${bad}`).toBeTruthy();
      }
      // 366 days is the longest period.
      await get(token, `${url}${join}from=2025-10-01&to=2026-10-01`);
    }
  });

  it("Courier Operations: overview and stage-count metrics follow the period (Dhaka day boundaries)", async () => {
    const s = await setup();
    const oct10 = await get(s.ops.token, `/ops/overview?${OCT_10}`);
    expect(oct10.period).toMatchObject({ from: "2026-10-10", to: "2026-10-10", days: 1, bucket: "hour" });
    expect(oct10.metrics).toMatchObject({ booked: 1, pickedUp: 0, delivered: 0, codCollected: 0, successRate: null });
    const oct11 = await get(s.ops.token, `/ops/overview?${OCT_11}`);
    expect(oct11.metrics).toMatchObject({ booked: 1, pickedUp: 1, delivered: 1, returned: 0, codCollected: 1500, codCollections: 1, successRate: 100, slaMetRate: 100 });
    // The previous period (Oct 10) comes with it for trends.
    expect(oct11.metrics.previous).toMatchObject({ booked: 1, delivered: 0 });
    const both = await get(s.ops.token, "/ops/overview?from=2026-10-10&to=2026-10-11");
    expect(both.metrics).toMatchObject({ booked: 2, delivered: 1 });
    // Live "now" counts don't depend on the period.
    expect(both.shipments.active).toBe(oct10.shipments.active);
    // Without a period: today (nothing booked today in this data).
    expect((await get(s.ops.token, "/ops/overview")).metrics.booked).toBe(0);

    // Stage counts: metrics only when asked for, for the same hub scope as the counts.
    const plain = await get(s.ops.token, "/ops/stage-counts");
    expect(plain.metrics).toBeUndefined();
    const withPeriod = await get(s.ops.token, `/ops/stage-counts?${OCT_11}`);
    expect(withPeriod.metrics).toMatchObject({ booked: 1, delivered: 1, codCollected: 1500 });
    expect(withPeriod.stages).toEqual(plain.stages);
    const otherHub = await hub(ctx, "HUB-OTH");
    const scoped = await get(s.ops.token, `/ops/stage-counts?forHubIds=${otherHub.id}&${OCT_11}`);
    expect(scoped.metrics).toMatchObject({ booked: 0, delivered: 0, codCollected: 0 });

    // Analytics & SLA: a "period" value per row.
    const analytics = await get(s.ops.token, `/ops/analytics?${OCT_11}`);
    expect(analytics.period).toMatchObject({ from: "2026-10-11", to: "2026-10-11" });
    expect(analytics.rows.find((r: { key: string }) => r.key === "onTimeRate").period).toBe(100);
    expect(analytics.samples.period.delivered).toBe(1);
    expect((await get(s.ops.token, `/ops/analytics?${OCT_10}`)).rows.find((r: { key: string }) => r.key === "onTimeRate").period).toBeNull();
  });

  it("merchant dashboard: range figures, money for owners and the chart by hour / day", async () => {
    const s = await setup();
    const oct11 = await get(s.owner.token, `/merchants/me/stats?${OCT_11}`);
    expect(oct11.range).toMatchObject({ from: "2026-10-11", to: "2026-10-11", bucket: "hour", created: 1, delivered: 1, pickedUp: 1, deliverySuccessRate: 100 });
    expect(oct11.range.previous).toMatchObject({ created: 1, delivered: 0 });
    expect(oct11.range.money).toMatchObject({ codCollected: 1500, collections: 1 });
    expect(oct11.range.money.payable).toBe(Math.round((1500 - oct11.range.money.chargesOnCollected) * 100) / 100);
    // Hourly chart: booked at 00:00 Dhaka (hour 0); the previous day's last hour holds the other parcel.
    expect(oct11.range.series.labels).toHaveLength(24);
    expect(oct11.range.series.current[0]).toBe(1);
    expect(oct11.range.series.previous[23]).toBe(1);
    const week = await get(s.owner.token, "/merchants/me/stats?from=2026-10-05&to=2026-10-11");
    expect(week.range).toMatchObject({ bucket: "day", created: 2 });
    expect(week.range.series.keys).toEqual(["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"]);
    expect(week.range.series.current.slice(-2)).toEqual([1, 1]);
    // Without a period: this month, and the older fields stay.
    const plain = await get(s.owner.token, "/merchants/me/stats");
    expect(plain.range.days).toBeGreaterThanOrEqual(1);
    expect(plain.thisMonth).toBeDefined();
    expect(plain.series.period).toBe("7d");
    // Staff (not owners) get no money figures.
    const staff = await userWithRoles(ctx, [{ role: "MERCHANT_STAFF", merchantId: s.shop.id }], "Shop Staff");
    expect((await get(staff.token, `/merchants/me/stats?${OCT_11}`)).range.money).toBeNull();
  });

  it("super admin: overview period figures and chart, traffic for a period", async () => {
    const s = await setup();
    const oct11 = await get(s.admin.token, `/admin/overview?${OCT_11}`);
    expect(oct11.period).toMatchObject({ from: "2026-10-11", bucket: "hour", bookings: 1, delivered: 1, activeMerchants: 1 });
    expect(oct11.period.gmv).toBeCloseTo(oct11.period.cod + oct11.period.charges, 2);
    expect(oct11.period.previous).toMatchObject({ bookings: 1, delivered: 0 });
    expect(oct11.period.merchants).toEqual([{ merchantId: s.shop.id, parcels: 1 }]);
    expect(oct11.period.series.current[0]).toBe(1);
    const range = await get(s.admin.token, "/admin/overview?from=2026-10-01&to=2026-10-31");
    expect(range.period).toMatchObject({ bucket: "day", bookings: 2, newMerchants: expect.any(Number) });
    expect(range.period.series.keys).toHaveLength(31);
    expect(range.parcels).toBeDefined(); // the older fields stay

    await ctx.prisma.analyticsDaily.createMany({
      data: [
        { day: new Date("2026-10-10T00:00:00Z"), metric: "visit", dimension: "", count: 5 },
        { day: new Date("2026-10-11T00:00:00Z"), metric: "visit", dimension: "", count: 7 },
        { day: new Date("2026-10-11T00:00:00Z"), metric: "visit", dimension: "source:search", count: 7 },
        { day: new Date("2026-10-11T00:00:00Z"), metric: "tracking_lookup", dimension: "", count: 3 },
      ],
    });
    await ctx.prisma.analyticsHourly.create({ data: { hour: new Date("2026-10-11T04:00:00.000Z"), metric: "visit", count: 7 } });
    const t11 = await get(s.admin.token, `/analytics/traffic?${OCT_11}`);
    expect(t11).toMatchObject({ days: 1, hourlyScope: "day", period: { visits: 7, trackingLookups: 3 }, previousPeriod: { visits: 5 } });
    expect(t11.hourly[0].hour).toBe("2026-10-10T18:00:00.000Z"); // the Dhaka day's first hour
    expect(t11.hourly[10].visits).toBe(7); // 10:00 Dhaka = 04:00Z
    expect(t11.sources).toEqual([{ key: "search", count: 7 }]);
    const t2 = await get(s.admin.token, "/analytics/traffic?from=2026-10-10&to=2026-10-11");
    expect(t2).toMatchObject({ days: 2, hourlyScope: "last24h", period: { visits: 12 } });
    expect(t2.daily.map((d: { day: string }) => d.day)).toEqual(["2026-10-10", "2026-10-11"]);
    // Without a period: the last `days` days as before.
    expect((await get(s.admin.token, "/analytics/traffic?days=14")).daily).toHaveLength(14);
  });
});
