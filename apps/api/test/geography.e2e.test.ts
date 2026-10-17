import { RealtimeService, type RealtimeEvent } from "../src/common/realtime.service";
import { GEO_META_KEY } from "../src/modules/geography/geo-catalog";
import { DEFAULT_CATALOG } from "../src/modules/pricing/pricing.service";
import { DHAKA_SUBURBAN, renameDhakaSuburban } from "../src/seed/geo-bd";
import { hub, parcelBody, resetDatabase, riderUser, startApp, userWithRoles, type TestContext } from "./helpers";

/** Geography admin: districts → zones → areas of the service catalog, and hubs. */
describe("Geography admin", () => {
  let ctx: TestContext;
  let admin: Awaited<ReturnType<typeof userWithRoles>>;
  let ops: Awaited<ReturnType<typeof userWithRoles>>;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(async () => {
    await resetDatabase(ctx);
    admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Geo Admin");
    ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Geo Ops");
  });
  afterAll(() => ctx.app.close());

  const as = (token: string) => ({
    get: (url: string) => ctx.api("GET", url, { token }),
    post: (url: string, body: unknown) => ctx.api("POST", url, { token, body }),
    patch: (url: string, body: unknown) => ctx.api("PATCH", url, { token, body }),
    del: (url: string) => ctx.api("DELETE", url, { token }),
  });
  const q = (params: Record<string, string>) => `?${new URLSearchParams(params)}`;
  const catalog = async () => (await ctx.api("GET", "/catalog")).body as { districts: string[]; zonesByDistrict: Record<string, string[]>; areasByZone: Record<string, string[]> };
  const audit = (action: string) => ctx.prisma.auditLog.findMany({ where: { action }, orderBy: { createdAt: "asc" } });

  it("creates districts, zones and areas (bulk paste) with validation, read access for operations and a live catalog refresh", async () => {
    const realtime = ctx.app.get(RealtimeService);
    const events: RealtimeEvent[] = [];
    const spy = vi.spyOn(realtime, "publish").mockImplementation((...e: RealtimeEvent[]) => void events.push(...e));
    const a = as(admin.token);
    try {
      expect((await a.post("/geography/districts", { name: "Rangamati", lat: 22.65, lng: 92.17 })).status).toBe(201);
      expect((await a.post("/geography/districts", { name: " rangamati " })).body.error).toMatchObject({ code: "DISTRICT_EXISTS" });
      expect((await a.post("/geography/districts", { name: "Bandarban", lat: 22.1 })).status).toBe(422); // both coordinates or neither
      expect((await a.post("/geography/districts", { name: "A|B" })).status).toBe(422);

      const gulshanHub = await hub(ctx, "GEO-H1");
      const zone = await a.post("/geography/zones", { district: "rangamati", name: "Kaptai", hubId: gulshanHub.id });
      expect(zone.status, JSON.stringify(zone.body)).toBe(201);
      expect(zone.body).toMatchObject({ district: "Rangamati", zone: "Kaptai", deliveryZone: { hubId: gulshanHub.id } });
      // Zone names are unique in the whole country (areas are keyed by zone).
      const taken = await a.post("/geography/zones", { district: "Rangamati", name: "gulshan" });
      expect(taken.status).toBe(409);
      expect(taken.body.error.code).toBe("ZONE_EXISTS");
      expect(taken.body.error.message).toContain("Dhaka North");
      expect((await a.post("/geography/zones", { district: "Nowhere", name: "X" })).status).toBe(404);

      const areas = await a.post("/geography/areas", { district: "Rangamati", zone: "kaptai", names: ["Kaptai Bazar", "", "  Chandraghona  ", "kaptai bazar", "x".repeat(90), "Banarupa"] });
      expect(areas.status).toBe(201);
      expect(areas.body.added).toEqual(["Kaptai Bazar", "Chandraghona", "Banarupa"]);
      expect(areas.body.skipped).toEqual([
        { line: 4, name: "kaptai bazar", reason: "listed twice" },
        { line: 5, name: "x".repeat(90), reason: "longer than 80 characters" },
      ]);

      // Bookings and every panel see it at once (no cache to wait for), and pages are told to reload.
      const c = await catalog();
      expect(c.districts).toContain("Rangamati");
      expect(c.zonesByDistrict.Rangamati).toEqual(["Kaptai"]);
      expect(c.areasByZone.Kaptai).toEqual(["Kaptai Bazar", "Chandraghona", "Banarupa"]);
      expect(events.filter(e => e.type === "catalog.updated")).toHaveLength(3);
      expect(events[0]).toMatchObject({ type: "catalog.updated", staffPermission: "support:create" });
      const quote = await ctx.api("POST", "/pricing/quote", { body: { pickupDistrict: "Rangamati", pickupZone: "Kaptai", deliveryDistrict: "Rangamati", deliveryZone: "Kaptai", weightKg: 1, serviceLevel: "Regular", codAmount: 0 } });
      expect(quote.body.sameZone).toBe(true);
    } finally {
      spy.mockRestore();
    }

    // Operations read the hierarchy but can't change it.
    const tree = await as(ops.token).get("/geography");
    expect(tree.status).toBe(200);
    const rangamati = tree.body.districts.find((d: { name: string }) => d.name === "Rangamati");
    expect(rangamati).toMatchObject({ active: true, lat: 22.65, lng: 92.17, zones: [{ name: "Kaptai", active: true, servedBy: [{ code: "GEO-H1" }], areas: expect.arrayContaining([{ name: "Banarupa", active: true }]) }] });
    expect((await as(ops.token).post("/geography/districts", { name: "Khagrachhari" })).status).toBe(403);
    expect((await ctx.api("GET", "/geography")).status).toBe(401);

    expect((await audit("geo.district.create")).map(r => r.entityId)).toEqual(["Rangamati"]);
    expect((await audit("geo.zone.create"))[0].data).toMatchObject({ district: "Rangamati", name: "Kaptai", hubId: gulshanHubId(tree) });
    expect((await audit("geo.area.bulk_create"))[0].data).toMatchObject({ added: ["Kaptai Bazar", "Chandraghona", "Banarupa"], skipped: 2 });
  });
  const gulshanHubId = (tree: { body: { districts: { name: string; zones: { servedBy: { id: string }[] }[] }[] } }) => tree.body.districts.find(d => d.name === "Rangamati")!.zones[0].servedBy[0].id;

  it("refuses to delete a place in use (with what uses it), deletes unused ones and keeps them deleted", async () => {
    const a = as(admin.token);
    const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Customer");
    // Parcel: pickup Gulshan (Dhaka North) → delivery Dhanmondi Road 7, Dhanmondi (Dhaka Central).
    expect((await ctx.api("POST", "/parcels", { token: customer.token, body: parcelBody() })).status).toBe(201);
    const r = await riderUser(ctx, "R-7001");
    await ctx.prisma.rider.update({ where: { id: r.rider.id }, data: { zone: "Dhanmondi" } });
    await ctx.prisma.slaPolicy.create({ data: { name: "Dhanmondi express", serviceLevel: "EXPRESS", destDistrict: "Dhaka Central", destZone: "Dhanmondi", pickupMinutes: 60, deliveryMinutes: 240 } });

    const zone = await a.del(`/geography/zones${q({ district: "Dhaka Central", zone: "dhanmondi" })}`);
    expect(zone.status).toBe(409);
    expect(zone.body.error.code).toBe("IN_USE");
    expect(zone.body.error.message).toContain("Deactivate it instead");
    const items = Object.fromEntries((zone.body.error.details.usage.items as { label: string; count: number }[]).map(i => [i.label, i.count]));
    expect(items).toMatchObject({ "Parcels (delivery address)": 1, "Saved addresses (address books)": 1, "Riders (service zone)": 1, "SLA policies (destination)": 1 });
    expect(zone.body.error.details.usage.total).toBe(4);

    // The same counts on the usage endpoint and in the list counts.
    expect((await as(ops.token).get(`/geography/usage${q({ district: "Dhaka Central", zone: "Dhanmondi" })}`)).body).toMatchObject({ district: "Dhaka Central", zone: "Dhanmondi", total: 4 });
    const counts = await a.get(`/geography/counts${q({ district: "Dhaka Central" })}`);
    expect(counts.body.counts.Dhanmondi.total).toBe(4);
    expect(counts.body.counts.Mirpur.total).toBe(0);
    expect((await a.get("/geography/counts")).body.counts["Dhaka North"].total).toBeGreaterThanOrEqual(2); // pickup parcel + address
    expect((await a.del(`/geography/areas${q({ district: "Dhaka Central", zone: "Dhanmondi", area: "Dhanmondi Road 7" })}`)).body.error.code).toBe("IN_USE");
    expect((await a.del(`/geography/districts${q({ district: "Dhaka North" })}`)).body.error.code).toBe("IN_USE");
    // A hub standing in a district / zone and the import default destination count too.
    await ctx.prisma.hub.create({ data: { code: "MIR-H", name: "Mirpur Test Hub", district: "Dhaka Central", zone: "Mirpur", address: "Mirpur 10" } });
    expect((await a.del(`/geography/zones${q({ district: "Dhaka Central", zone: "Mirpur" })}`)).body.error.details.usage.items).toEqual([{ key: "hubs", label: "Hubs", count: 1 }]);
    await ctx.prisma.setting.create({ data: { key: "import-config", value: { defaultDestination: { mode: "FIXED", district: "Chattogram", zone: "Agrabad" } } } });
    expect((await a.del(`/geography/zones${q({ district: "Chattogram", zone: "Agrabad" })}`)).body.error.details.usage.items).toEqual([
      { key: "import_config", label: "Spreadsheet import default destination", count: 1 },
    ]);

    // Unused: an area, a zone with areas, a whole district.
    expect((await a.del(`/geography/areas${q({ district: "Dhaka North", zone: "Banani", area: "banani block c" })}`)).body).toMatchObject({ deleted: true, area: "Banani Block C" });
    expect((await a.del(`/geography/zones${q({ district: "Dhaka North", zone: "Uttara" })}`)).body).toMatchObject({ deleted: true });
    await a.post("/geography/districts", { name: "Bandarban" });
    await a.post("/geography/zones", { district: "Bandarban", name: "Thanchi" });
    await a.post("/geography/areas", { district: "Bandarban", zone: "Thanchi", names: ["Remakri"] });
    expect((await a.del(`/geography/districts${q({ district: "Bandarban" })}`)).body).toMatchObject({ deleted: true, district: "Bandarban" });
    const c = await catalog();
    expect(c.districts).not.toContain("Bandarban");
    expect(c.areasByZone.Thanchi).toBeUndefined();
    expect(c.zonesByDistrict["Dhaka North"]).not.toContain("Uttara");
    expect(c.areasByZone.Banani ?? []).not.toContain("Banani Block C");
    // Tombstones keep the BD geography seed from bringing them back.
    const meta = (await ctx.prisma.setting.findUniqueOrThrow({ where: { key: GEO_META_KEY } })).value as { deleted: Record<string, string[]> };
    expect(meta.deleted).toMatchObject({ districts: ["Bandarban"], zones: ["Dhaka North|Uttara"], areas: ["Banani|Banani Block C"] });
    expect((await audit("geo.zone.delete"))[0]).toMatchObject({ entityType: "geography", entityId: "Dhaka North|Uttara" });
    expect(await ctx.prisma.auditLog.count({ where: { action: { in: ["geo.area.delete", "geo.district.delete"] } } })).toBe(2);
  });

  it("deactivates a zone: gone from lists and new bookings, existing parcels and hubs keep working; reactivates", async () => {
    const a = as(admin.token);
    const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Customer");
    const old = await ctx.api("POST", "/parcels", { token: customer.token, body: parcelBody() });
    expect(old.status).toBe(201);
    const dhanmondiHub = await ctx.prisma.hub.create({ data: { code: "DHN-H", name: "Dhanmondi Test Hub", district: "Dhaka Central", zone: "Dhanmondi", address: "Road 7" } });

    const off = await a.patch("/geography/zones", { district: "Dhaka Central", zone: "Dhanmondi", active: false });
    expect(off.body).toMatchObject({ zone: "Dhanmondi", active: false });
    const c = await catalog();
    expect(c.zonesByDistrict["Dhaka Central"]).toEqual(["Mirpur"]);
    expect(c.areasByZone.Dhanmondi).toBeUndefined();
    expect((await as(ops.token).get("/geography")).body.districts.find((d: { name: string }) => d.name === "Dhaka Central").zones).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Dhanmondi", active: false })]),
    );

    // New bookings are refused…
    const refused = await ctx.api("POST", "/parcels", { token: customer.token, body: parcelBody() });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: "PLACE_INACTIVE", details: { field: "zone", name: "Dhanmondi", address: "delivery address" } });
    // … an area of an inactive district too.
    await a.patch("/geography/districts", { district: "Chattogram", active: false });
    const ctg = await ctx.api("POST", "/parcels", { token: customer.token, body: parcelBody({ delivery: { category: "Office", street: "Road 1", zone: "Agrabad", district: "Chattogram" } }) });
    expect(ctg.body.error).toMatchObject({ code: "PLACE_INACTIVE", details: { field: "district" } });
    // … and hubs can't move into it, while one already there can still be edited.
    const other = await hub(ctx, "GEO-H2");
    expect((await as(ops.token).patch(`/hubs/${other.id}`, { district: "Dhaka Central", zone: "Dhanmondi" })).body.error.code).toBe("HUB_ZONE_INVALID");
    const kept = await as(ops.token).patch(`/hubs/${dhanmondiHub.id}`, { zone: "dhanmondi", capacity: 40 });
    expect(kept.body).toMatchObject({ zone: "Dhanmondi", capacity: 40, active: true });

    // The existing parcel keeps its zone and its workflow.
    const rider = await riderUser(ctx, "R-7002");
    const assigned = await as(ops.token).post(`/parcels/${old.body.trackingId}/assign-pickup`, { riderId: rider.rider.id });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    expect((await ctx.api("GET", `/parcels/${old.body.trackingId}`, { token: customer.token })).body.delivery).toMatchObject({ zone: "Dhanmondi" });

    // An inactive area only.
    await a.patch("/geography/zones", { district: "Dhaka Central", zone: "Dhanmondi", active: true });
    await a.patch("/geography/areas", { district: "Dhaka Central", zone: "Dhanmondi", area: "Dhanmondi Road 7", active: false });
    expect((await catalog()).areasByZone.Dhanmondi).toEqual([]);
    expect((await ctx.api("POST", "/parcels", { token: customer.token, body: parcelBody() })).body.error.details).toMatchObject({ field: "area" });
    await a.patch("/geography/areas", { district: "Dhaka Central", zone: "Dhanmondi", area: "Dhanmondi Road 7", active: true });
    expect((await ctx.api("POST", "/parcels", { token: customer.token, body: parcelBody() })).status).toBe(201);
    expect((await audit("geo.zone.update")).map(r => (r.data as { active?: boolean }).active)).toEqual([false, true]);

    // PUT /catalog (other catalog lists) keeps the hidden places and refuses removing used ones.
    const visible = await catalog();
    expect(visible.districts).not.toContain("Chattogram");
    const saved = await ctx.api("PUT", "/catalog", { token: admin.token, body: { ...visible, packaging: [...(visible as unknown as { packaging: string[] }).packaging, "Crate"], products: (visible as unknown as { products: string[] }).products, weightsKg: [1] } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const stored = (await ctx.prisma.setting.findUniqueOrThrow({ where: { key: "catalog" } })).value as { districts: string[]; zonesByDistrict: Record<string, string[]> };
    expect(stored.districts).toContain("Chattogram");
    expect(stored.zonesByDistrict.Chattogram).toEqual(["Agrabad"]);
    const removing = await ctx.api("PUT", "/catalog", {
      token: admin.token,
      body: {
        ...visible,
        zonesByDistrict: { ...visible.zonesByDistrict, "Dhaka Central": ["Mirpur"] },
        areasByZone: Object.fromEntries(Object.entries(visible.areasByZone).filter(([z]) => z !== "Dhanmondi")),
        packaging: ["Box"],
        products: ["Clothing"],
        weightsKg: [1],
      },
    });
    expect(removing.status).toBe(409);
    expect(removing.body.error).toMatchObject({ code: "IN_USE", details: { place: { district: "Dhaka Central", zone: "Dhanmondi" } } });
  });

  it("renames update every record that names the place, in one audited transaction", async () => {
    const a = as(admin.token);
    const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Customer");
    const booked = await ctx.api("POST", "/parcels", { token: customer.token, body: parcelBody() });
    const h = await ctx.prisma.hub.create({ data: { code: "DHN-R", name: "Dhanmondi Rename Hub", district: "Dhaka Central", zone: "Dhanmondi", address: "Road 7" } });
    await ctx.prisma.deliveryZone.create({ data: { code: "DHC-DHN", name: "Dhanmondi", district: "Dhaka Central", areas: ["Dhanmondi Road 7"], hubId: h.id } });
    const r = await riderUser(ctx, "R-7003");
    await ctx.prisma.rider.update({ where: { id: r.rider.id }, data: { zone: "dhanmondi" } });
    await ctx.prisma.slaPolicy.create({ data: { name: "To Dhanmondi", serviceLevel: "REGULAR", destDistrict: "Dhaka Central", destZone: "Dhanmondi", pickupMinutes: 60, deliveryMinutes: 600 } });
    await ctx.prisma.setting.create({ data: { key: "import-config", value: { defaultDestination: { mode: "FIXED", district: "Dhaka Central", zone: "Dhanmondi" } } } });

    // Names must stay unique.
    expect((await a.patch("/geography/zones", { district: "Dhaka Central", zone: "Dhanmondi", name: "Mirpur" })).body.error.code).toBe("ZONE_EXISTS");
    expect((await a.patch("/geography/districts", { district: "Dhaka Central", name: "dhaka north" })).body.error.code).toBe("DISTRICT_EXISTS");

    const zone = await a.patch("/geography/zones", { district: "Dhaka Central", zone: "Dhanmondi", name: "Dhanmondi R/A" });
    expect(zone.status, JSON.stringify(zone.body)).toBe(200);
    expect(zone.body.references).toMatchObject({ "parcels.deliveryZone": 1, "addresses.zone": 1, "hubs.zone": 1, "delivery_zones.name": 1, "riders.zone": 1, "sla_policies.destZone": 1, "settings.import-config": 1 });
    const area = await a.patch("/geography/areas", { district: "Dhaka Central", zone: "Dhanmondi R/A", area: "Dhanmondi Road 7", name: "Road 7 (Dhanmondi)" });
    expect(area.body.references).toMatchObject({ "parcels.deliveryArea": 1, "addresses.area": 1, "delivery_zones.areas": 1 });
    const district = await a.patch("/geography/districts", { district: "Dhaka Central", name: "Dhaka Middle" });
    expect(district.body.references).toMatchObject({ "parcels.deliveryDistrict": 1, "hubs.district": 1, "delivery_zones.district": 1, "sla_policies.destDistrict": 1 });

    const parcel = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: booked.body.trackingId } });
    expect(parcel).toMatchObject({ deliveryDistrict: "Dhaka Middle", deliveryZone: "Dhanmondi R/A", deliveryArea: "Road 7 (Dhanmondi)", pickupZone: "Gulshan" });
    expect(await ctx.prisma.hub.findUniqueOrThrow({ where: { id: h.id } })).toMatchObject({ district: "Dhaka Middle", zone: "Dhanmondi R/A" });
    expect(await ctx.prisma.deliveryZone.findUniqueOrThrow({ where: { code: "DHC-DHN" } })).toMatchObject({ district: "Dhaka Middle", name: "Dhanmondi R/A", areas: ["Road 7 (Dhanmondi)"] });
    expect((await ctx.prisma.rider.findUniqueOrThrow({ where: { id: r.rider.id } })).zone).toBe("Dhanmondi R/A");
    expect(await ctx.prisma.slaPolicy.findFirstOrThrow()).toMatchObject({ destDistrict: "Dhaka Middle", destZone: "Dhanmondi R/A" });
    expect((await ctx.prisma.setting.findUniqueOrThrow({ where: { key: "import-config" } })).value).toMatchObject({ defaultDestination: { district: "Dhaka Middle", zone: "Dhanmondi R/A" } });
    const c = await catalog();
    expect(c.zonesByDistrict["Dhaka Middle"]).toEqual(["Dhanmondi R/A", "Mirpur"]);
    expect(c.areasByZone["Dhanmondi R/A"]).toEqual(["Road 7 (Dhanmondi)"]);
    expect(c.districts).not.toContain("Dhaka Central");
    // The renamed zone prices as before: same zone → same-zone charge.
    const quote = await ctx.api("POST", "/pricing/quote", { body: { pickupDistrict: "Dhaka Middle", pickupZone: "Dhanmondi R/A", deliveryDistrict: "dhaka middle", deliveryZone: "dhanmondi r/a", weightKg: 1, serviceLevel: "Regular", codAmount: 0 } });
    expect(quote.body.sameZone).toBe(true);
    // Audited with the reference counts; the old names are tombstoned for the seed.
    expect((await audit("geo.zone.update"))[0].data).toMatchObject({ zone: "Dhanmondi", renamedTo: "Dhanmondi R/A", references: { "parcels.deliveryZone": 1 } });
    const meta = (await ctx.prisma.setting.findUniqueOrThrow({ where: { key: GEO_META_KEY } })).value as { deleted: Record<string, string[]> };
    expect(meta.deleted.districts).toEqual(["Dhaka Central"]);
    expect(meta.deleted.zones).toEqual(["Dhaka Middle|Dhanmondi"]);
  });

  it('migrates the outer "Dhaka" district to "Dhaka (Sub-urban)" with every reference, once, audited', async () => {
    const catalog = structuredClone(DEFAULT_CATALOG);
    catalog.districts.push("Dhaka");
    catalog.zonesByDistrict.Dhaka = ["Savar", "Keraniganj"];
    catalog.areasByZone.Savar = ["Savar Bazar"];
    await ctx.prisma.setting.create({ data: { key: "catalog", value: catalog } });
    const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Customer");
    const booked = await ctx.api("POST", "/parcels", { token: customer.token, body: parcelBody({ delivery: { category: "Home", street: "Road 1", area: "Savar Bazar", zone: "Savar", district: "Dhaka" } }) });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    const savar = await ctx.prisma.hub.create({ data: { code: "DHK-SAV", name: "Savar Hub", district: "Dhaka", zone: "Savar", address: "Savar Bazar" } });
    await ctx.prisma.deliveryZone.create({ data: { code: "DHA-SAVAR", name: "Savar", district: "Dhaka", areas: [], hubId: savar.id } });

    const references = await ctx.prisma.$transaction(tx => renameDhakaSuburban(tx));
    expect(references).toMatchObject({ "parcels.deliveryDistrict": 1, "addresses.district": 1, "hubs.district": 1, "delivery_zones.district": 1 });
    expect(await ctx.prisma.$transaction(tx => renameDhakaSuburban(tx))).toBeNull(); // idempotent
    const c = await catalog_();
    expect(c.districts).toContain(DHAKA_SUBURBAN);
    expect(c.districts).not.toContain("Dhaka");
    expect(c.zonesByDistrict[DHAKA_SUBURBAN]).toEqual(["Savar", "Keraniganj"]);
    expect(await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: booked.body.trackingId } })).toMatchObject({ deliveryDistrict: DHAKA_SUBURBAN, deliveryZone: "Savar" });
    expect((await ctx.prisma.hub.findUniqueOrThrow({ where: { id: savar.id } })).district).toBe(DHAKA_SUBURBAN);
    expect((await ctx.prisma.deliveryZone.findUniqueOrThrow({ where: { code: "DHA-SAVAR" } })).district).toBe(DHAKA_SUBURBAN);
    const [entry] = await audit("geo.district.update");
    expect(entry).toMatchObject({ actorType: "SYSTEM", entityId: DHAKA_SUBURBAN, data: { district: "Dhaka", renamedTo: DHAKA_SUBURBAN } });
    // The city districts are untouched.
    expect(c.zonesByDistrict["Dhaka North"]).toEqual(DEFAULT_CATALOG.zonesByDistrict["Dhaka North"]);
  });
  const catalog_ = async () => (await ctx.api("GET", "/catalog")).body as { districts: string[]; zonesByDistrict: Record<string, string[]> };

  it("hubs: validated create and edit, deactivate keeps it, delete only when unused", async () => {
    const o = as(ops.token);
    const created = await o.post("/hubs", { code: "GEO-NEW", name: "Geo New Hub", district: "dhaka north", zone: "banani", address: "Road 11", lat: 23.79, lng: 90.4 });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ district: "Dhaka North", zone: "Banani", active: true });
    expect((await o.post("/hubs", { code: "GEO-DUP", name: "geo new hub", district: "Dhaka North", address: "x road" })).body.error.code).toBe("HUB_NAME_TAKEN");
    expect((await o.post("/hubs", { code: "GEO-BAD", name: "Bad District Hub", district: "Atlantis", address: "x road" })).body.error.code).toBe("HUB_DISTRICT_INVALID");
    expect((await o.post("/hubs", { code: "GEO-BAD", name: "Bad Zone Hub", district: "Dhaka North", zone: "Mirpur", address: "x road" })).body.error.code).toBe("HUB_ZONE_INVALID");

    // Deactivate: hidden from the active list, and an edit without `active` doesn't bring it back.
    const id = created.body.id as string;
    expect((await o.patch(`/hubs/${id}`, { active: false })).body.active).toBe(false);
    expect((await o.patch(`/hubs/${id}`, { capacity: 10, name: "Geo Renamed Hub" })).body).toMatchObject({ active: false, capacity: 10, name: "Geo Renamed Hub" });
    expect(((await o.get("/hubs")).body as { id: string }[]).some(h => h.id === id)).toBe(false);
    expect(((await o.get("/hubs?includeInactive=true")).body as { id: string }[]).some(h => h.id === id)).toBe(true);
    expect((await audit("hub.deactivate")).map(r => r.entityId)).toEqual([id]);

    // In use (a rider, a served zone) → 409 with the list; unused → deleted.
    const r = await riderUser(ctx, "R-7004", id);
    await ctx.prisma.deliveryZone.create({ data: { code: "GEO-BAN", name: "Banani", district: "Dhaka North", areas: [], hubId: id } });
    const usage = await o.get(`/hubs/${id}/usage`);
    expect(usage.body).toMatchObject({ hub: { code: "GEO-NEW" }, total: 2 });
    const refused = await o.del(`/hubs/${id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("IN_USE");
    expect(Object.fromEntries((refused.body.error.details.usage.items as { label: string; count: number }[]).map(i => [i.label, i.count]))).toEqual({ Riders: 1, "Delivery zones it serves": 1 });
    expect((await as((await userWithRoles(ctx, [{ role: "HUB_OPERATOR", hubId: id }], "Hub Op")).token).del(`/hubs/${id}`)).status).toBe(403);
    await ctx.prisma.rider.update({ where: { id: r.rider.id }, data: { hubId: null } });
    await ctx.prisma.deliveryZone.deleteMany({ where: { hubId: id } });
    await ctx.prisma.userRole.deleteMany({ where: { hubId: id } });
    const deleted = await o.del(`/hubs/${id}`);
    expect(deleted.body, JSON.stringify(deleted.body)).toMatchObject({ deleted: true, code: "GEO-NEW" });
    expect(await ctx.prisma.hub.count({ where: { id } })).toBe(0);
    expect((await audit("hub.delete"))[0]).toMatchObject({ entityId: id });
    expect(((await ctx.prisma.setting.findUniqueOrThrow({ where: { key: GEO_META_KEY } })).value as { deleted: { hubs: string[] } }).deleted.hubs).toEqual(["GEO-NEW"]);
  });
});
