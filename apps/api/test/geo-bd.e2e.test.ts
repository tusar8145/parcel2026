import { DEFAULT_PACKAGE_PRICES as P } from "@delivery-fast/shared";
import { DEFAULT_CATALOG, type Catalog } from "../src/modules/pricing/pricing.service";
import { readZip } from "../src/modules/imports/xlsx/zip";
import { HUBS, seedGeo } from "../src/seed/geo-bd";
import { resetDatabase, startApp, userWithRoles, type TestContext } from "./helpers";

/** The nationwide geography (prisma/data/bd-geo.json) and hub network on a clean database. */
describe("Bangladesh geography and hub network", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(async () => {
    await resetDatabase(ctx);
    await ctx.prisma.$transaction(tx => seedGeo(tx), { timeout: 120_000 });
  });
  afterAll(() => ctx.app.close());

  const catalog = async () => (await ctx.prisma.setting.findUniqueOrThrow({ where: { key: "catalog" } })).value as unknown as Catalog;

  it("loads every district, zone and area once, keeps the existing catalog, and gives every zone a hub", async () => {
    const c = await catalog();
    expect(c.districts).toHaveLength(67); // 64 districts + Dhaka North / Central / South (Dhaka city)
    expect(c.districts.slice(0, 4)).toEqual(DEFAULT_CATALOG.districts); // existing order kept
    for (const [district, zones] of Object.entries(DEFAULT_CATALOG.zonesByDistrict)) expect(c.zonesByDistrict[district].slice(0, zones.length)).toEqual(zones);
    for (const [zone, areas] of Object.entries(DEFAULT_CATALOG.areasByZone)) expect(c.areasByZone[zone]).toEqual(expect.arrayContaining(areas));
    const zones = Object.values(c.zonesByDistrict).flat();
    expect(zones.length).toBe(601);
    expect(new Set(zones.map(z => z.toLowerCase())).size).toBe(zones.length); // unique names across the country
    expect(c.zonesByDistrict["Cox's Bazar"]).toContain("Teknaf");
    expect(c.zonesByDistrict.Gazipur).toEqual(expect.arrayContaining(["Kaliganj (Gazipur)", "Tongi East"]));
    expect(Object.values(c.areasByZone).flat().length).toBeGreaterThan(4500);

    // Running it again changes nothing.
    const again = await ctx.prisma.$transaction(tx => seedGeo(tx), { timeout: 120_000 });
    expect(again).toMatchObject({ catalog: { changed: false }, hubs: { created: 0, filled: 0 }, deliveryZones: { created: 0, linked: 0 } });
    expect(await ctx.prisma.auditLog.count({ where: { action: "seed.geo_bd" } })).toBe(1);

    const hubs = await ctx.prisma.hub.findMany();
    expect(hubs).toHaveLength(HUBS.length);
    for (const h of hubs) expect(c.zonesByDistrict[h.district], h.code).toContain(h.zone);
    expect(await ctx.prisma.deliveryZone.count()).toBe(601);
    expect(await ctx.prisma.deliveryZone.count({ where: { hubId: null } })).toBe(0);
    const res = await ctx.api("GET", "/catalog");
    expect(res.body.districts).toHaveLength(67);
  });

  it("prices by district route tiers and every hub drop-off from the hub's district", async () => {
    const quote = (body: Record<string, unknown>) => ctx.api("POST", "/pricing/quote", { body: { weightKg: 0.5, serviceLevel: "Regular", codAmount: 0, ...body } });
    const same = await quote({ pickupDistrict: "Dhaka North", pickupZone: "Gulshan", deliveryDistrict: "Dhaka North", deliveryZone: "Gulshan" });
    expect(same.body).toMatchObject({ tier: "SAME_DISTRICT", totalCharge: P.sameDistrict });
    const suburban = await quote({ pickupDistrict: "Dhaka South", pickupZone: "Motijheel", deliveryDistrict: "Dhaka (Sub-urban)", deliveryZone: "Savar" });
    expect(suburban.body).toMatchObject({ tier: "DHAKA_SUBURBAN", totalCharge: P.dhakaSuburban });
    const cross = await quote({ pickupDistrict: "Dhaka North", pickupZone: "Gulshan", deliveryDistrict: "Cox's Bazar", deliveryZone: "Teknaf" });
    expect(cross.body).toMatchObject({ tier: "DIFFERENT_DISTRICT", totalCharge: P.differentDistrict });
    for (const hub of await ctx.prisma.hub.findMany()) {
      const res = await quote({ pickupDistrict: "Dhaka North", pickupZone: "Gulshan", deliveryDistrict: hub.district, deliveryZone: hub.zone, dropOffHubId: hub.id });
      expect(res.body, hub.code).toMatchObject({ tier: "SAME_DISTRICT", pickupDistrict: hub.district, origin: { hubId: hub.id, district: hub.district, zone: hub.zone } });
    }
  });

  it("imports rows to any zone of the country; a shared zone name needs its district", async () => {
    const m = await ctx.prisma.merchant.create({
      data: { code: "MR-G1", type: "ECOMMERCE", name: "Geo Shop", status: "ACTIVE", kycStatus: "APPROVED", contactName: "Owner", contactPhone: "+8801711111111", pickupAddress: "House 5 Road 2", pickupArea: "Gulshan 1", pickupDistrict: "Dhaka North" },
    });
    const owner = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: m.id }], "Owner");

    // The blank template has no place columns (district / zone / area are found from the full address).
    const started = Date.now();
    const template = await ctx.app.inject({ method: "GET", url: "/api/v1/imports/templates/ecommerce", headers: { authorization: `Bearer ${owner.token}` } });
    expect(template.statusCode).toBe(200);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(readZip(template.rawPayload, { maxBytes: 50_000_000 }).get("xl/workbook.xml")!.toString()).not.toMatch(/<definedName name="ZN_\d+">/);

    const header = ["Order ID", "Customer name", "Customer phone", "Delivery address", "District", "Zone", "Service", "Weight (kg)"];
    const row = (ref: string, district: string, zone: string) => [ref, "Nabila Ahmed", "01812000000", "Road 7, Flat 3B", district, zone, "Regular", "1"];
    const file = Buffer.from(
      `﻿${[header, row("G-1", "Cox's Bazar", "Teknaf"), row("G-2", "Gazipur", "Kaliganj"), row("G-3", "", "Kaliganj"), row("G-4", "Sylhet", "kotwali (sylhet)")].map(r => r.map(c => (/[",]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\r\n")}`,
      "utf8",
    );
    const boundary = "----dfGeoTest";
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\necommerce\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="geo.csv"\r\nContent-Type: text/csv\r\n\r\n`),
      file,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const validated = await ctx.app.inject({ method: "POST", url: "/api/v1/imports/validate", payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${owner.token}` } });
    expect(validated.statusCode, validated.body).toBe(201);
    const rows = (await ctx.api("GET", `/imports/${JSON.parse(validated.body).id}/rows?filter=all&pageSize=50`, { token: owner.token })).body.items as { status: string; errors: { column: string; message: string }[] }[];
    expect(rows.map(r => r.status)).toEqual(["VALID", "VALID", "ERROR", "VALID"]);
    expect(rows[2].errors[0]).toMatchObject({ column: "district" });
    expect(rows[2].errors[0].message).toContain("choose the district");

    // The rows not created come back with their places, whose dependent dropdowns cover the whole country.
    const id = JSON.parse(validated.body).id;
    await ctx.api("POST", `/imports/${id}/commit`, { token: owner.token });
    const failed = await ctx.app.inject({ method: "GET", url: `/api/v1/imports/${id}/failed-rows`, headers: { authorization: `Bearer ${owner.token}` } });
    expect(failed.statusCode).toBe(200);
    const workbook = readZip(failed.rawPayload, { maxBytes: 50_000_000 }).get("xl/workbook.xml")!.toString();
    expect(workbook.match(/<definedName name="ZN_\d+">/g)).toHaveLength(67);
    expect((workbook.match(/<definedName name="AR_\d+">/g) ?? []).length).toBeGreaterThan(550);
  });

  it("keeps places renamed or deleted in the geography admin out when the seed runs again", async () => {
    const admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Admin");
    const area = (await catalog()).areasByZone.Teknaf[0];
    expect((await ctx.api("DELETE", `/geography/areas?${new URLSearchParams({ district: "Cox's Bazar", zone: "Teknaf", area })}`, { token: admin.token })).status).toBe(200);
    const renamed = await ctx.api("PATCH", "/geography/zones", { token: admin.token, body: { district: "Cox's Bazar", zone: "Teknaf", name: "Teknaf Upazila" } });
    expect(renamed.body.references).toMatchObject({ "delivery_zones.name": 1 });
    const again = await ctx.prisma.$transaction(tx => seedGeo(tx), { timeout: 120_000 });
    expect(again).toMatchObject({ catalog: { changed: false }, hubs: { created: 0 }, deliveryZones: { created: 0 } });
    const c = await catalog();
    expect(c.zonesByDistrict["Cox's Bazar"]).toContain("Teknaf Upazila");
    expect(c.zonesByDistrict["Cox's Bazar"]).not.toContain("Teknaf");
    expect(c.areasByZone["Teknaf Upazila"]).not.toContain(area);
  });

  it("refuses a hub zone outside the hub's district", async () => {
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops");
    const ok = await ctx.api("POST", "/hubs", { token: ops.token, body: { code: "COX-TKF", name: "Teknaf Hub", district: "Cox's Bazar", zone: "teknaf", address: "Teknaf Sadar" } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.zone).toBe("Teknaf");
    const bad = await ctx.api("POST", "/hubs", { token: ops.token, body: { code: "COX-BAD", name: "Bad Hub", district: "Cox's Bazar", zone: "Gulshan", address: "Somewhere" } });
    expect(bad.body.error.code).toBe("HUB_ZONE_INVALID");
  });
});
