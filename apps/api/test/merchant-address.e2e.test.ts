import { resetDatabase, startApp, userWithRoles, type TestContext } from "./helpers";

/**
 * Structured merchant addresses (2026-10-18): business address, pickup location (same as the
 * business or its own), contact / time / handover, the derived serving hub and route district.
 * Catalog: the default one (Dhaka North › Gulshan [Niketon Central Mosque, Road 4 Gulshan], Banani
 * [Banani Block C], Uttara [no areas]; Dhaka Central › Dhanmondi …).
 */
describe("merchant addresses", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  afterAll(() => ctx.app.close());

  let gulshanHub: { id: string };
  let bananiHub: { id: string };
  beforeEach(async () => {
    await resetDatabase(ctx);
    gulshanHub = await ctx.prisma.hub.create({ data: { code: "DHK-GUL", name: "Gulshan Hub", district: "Dhaka North", zone: "Gulshan", address: "Road 90, Gulshan 2" } });
    bananiHub = await ctx.prisma.hub.create({ data: { code: "DHK-BAN", name: "Banani Hub", district: "Dhaka North", zone: "Banani", address: "Road 11, Banani" } });
    await ctx.prisma.deliveryZone.create({ data: { code: "DHN-GUL", name: "Gulshan", district: "Dhaka North", hubId: gulshanHub.id } });
    await ctx.prisma.deliveryZone.create({ data: { code: "DHN-BAN", name: "Banani", district: "Dhaka North", hubId: bananiHub.id } });
  });

  const business = { district: "Dhaka North", zone: "Gulshan", area: "Road 4 Gulshan", street: "House 7, Road 4, Flat B2", lat: 23.7925, lng: 90.4078 };
  const application = (overrides: Record<string, unknown> = {}) => ({
    type: "ECOMMERCE",
    name: "Address Test Shop",
    contactName: "Rumana Akter",
    contactPhone: "01811000111",
    businessCategory: "Regular",
    websiteUrl: "facebook.com/addresstestshop",
    business,
    pickupSameAsBusiness: true,
    pickupTime: "MIDDAY",
    ...overrides,
  });
  const applicant = () => userWithRoles(ctx, [{ role: "CUSTOMER" }], "Applicant");
  const apply = async (body: Record<string, unknown>) => ctx.api("POST", "/merchants/applications", { token: (await applicant()).token, body });

  it("stores an application whose pickup is the business address, with the derived hub and route district", async () => {
    const res = await apply(application());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.merchant).toMatchObject({
      businessCategory: "Regular",
      websiteUrl: "https://facebook.com/addresstestshop",
      business: { district: "Dhaka North", zone: "Gulshan", area: "Road 4 Gulshan", areaOther: false, street: "House 7, Road 4, Flat B2", lat: 23.7925, lng: 90.4078 },
      pickupSameAsBusiness: true,
      pickup: { district: "Dhaka North", zone: "Gulshan", area: "Road 4 Gulshan", street: "House 7, Road 4, Flat B2", lat: 23.7925 },
      // The old columns stay filled for booking defaults and pricing.
      pickupAddress: "House 7, Road 4, Flat B2",
      pickupArea: "Road 4 Gulshan",
      pickupDistrict: "Dhaka North",
      // Pickup contact defaults to the contact person.
      pickupContactName: "Rumana Akter",
      pickupContactPhone: "+8801811000111",
      pickupTime: "MIDDAY",
      handover: "RIDER_PICKUP",
      addressComplete: true,
      pickupHub: { id: gulshanHub.id, name: "Gulshan Hub" },
      routeDistrict: "Dhaka North",
    });
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: "merchant.apply", entityId: res.body.merchant.id } });
    expect(audit.data).toMatchObject({ pickupHubId: gulshanHub.id, pickup: { sameAsBusiness: true, zone: "Gulshan" } });
    // Super admin review sees the same structured data.
    const sa = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }]);
    const detail = await ctx.api("GET", `/merchants/${res.body.merchant.id}`, { token: sa.token });
    expect(detail.body).toMatchObject({ pickupHub: { code: "DHK-GUL" }, routeDistrict: "Dhaka North", business: { zone: "Gulshan" } });
  });

  it("stores a separate pickup address with its own contact, Drop at hub, and the hub's route district", async () => {
    const res = await apply(
      application({
        pickupSameAsBusiness: false,
        pickup: { district: "Dhaka North", zone: "Banani", area: "Banani Block C", street: "Warehouse 3, Road 27" },
        pickupContactName: "Kamal Store Keeper",
        pickupContactPhone: "+8801922333444",
        pickupTime: "AFTERNOON",
        handover: "HUB_DROP",
      }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.merchant).toMatchObject({
      business: { zone: "Gulshan" },
      pickupSameAsBusiness: false,
      pickup: { district: "Dhaka North", zone: "Banani", area: "Banani Block C", street: "Warehouse 3, Road 27", lat: null },
      pickupContactName: "Kamal Store Keeper",
      pickupContactPhone: "+8801922333444",
      pickupTime: "AFTERNOON",
      handover: "HUB_DROP",
      pickupHub: { id: bananiHub.id, name: "Banani Hub", address: "Road 11, Banani" },
      routeDistrict: "Dhaka North",
    });
  });

  it("refuses places that aren't in the catalog and requires the area of a zone that lists areas", async () => {
    const district = await apply(application({ business: { ...business, district: "Atlantis" } }));
    expect(district.status).toBe(422);
    expect(district.body.error.details[0]).toMatchObject({ path: "business.district" });
    const zone = await apply(application({ business: { ...business, zone: "Agrabad" } }));
    expect(zone.status).toBe(422);
    expect(zone.body.error.details[0]).toMatchObject({ path: "business.zone" });
    expect(zone.body.error.details[0].message).toMatch(/Agrabad.*Dhaka North/);
    const area = await apply(application({ pickupSameAsBusiness: false, pickup: { ...business, zone: "Banani", area: "Road 4 Gulshan" } }));
    expect(area.status).toBe(422);
    expect(area.body.error.details[0]).toMatchObject({ path: "pickup.area" });
    const noArea = await apply(application({ business: { ...business, area: undefined } }));
    expect(noArea.status).toBe(422);
    expect(noArea.body.error.details[0].message).toMatch(/Other/);
    const missingPickup = await apply(application({ pickupSameAsBusiness: false }));
    expect(missingPickup.status).toBe(422);
    expect(missingPickup.body.error.details.map((d: { path: string }) => d.path)).toContain("pickup");
    expect(await ctx.prisma.merchant.count()).toBe(0);
  });

  it("accepts an 'Other' area as free text, and a zone without listed areas", async () => {
    const other = await apply(application({ business: { ...business, area: undefined, otherArea: "Shahjadpur Lane 3" } }));
    expect(other.status, JSON.stringify(other.body)).toBe(201);
    expect(other.body.merchant).toMatchObject({ business: { area: "Shahjadpur Lane 3", areaOther: true }, pickup: { zone: "Gulshan", area: "Shahjadpur Lane 3", areaOther: true }, pickupArea: "Shahjadpur Lane 3" });
    // Uttara lists no areas and has no serving hub: the pickup area column holds the zone, no hub is derived.
    const uttara = await apply(application({ name: "Uttara Shop", contactPhone: "01811000222", business: { district: "dhaka north", zone: "uttara", street: "House 1, Sector 7" } }));
    expect(uttara.status, JSON.stringify(uttara.body)).toBe(201);
    expect(uttara.body.merchant).toMatchObject({ pickupDistrict: "Dhaka North", pickupArea: "Uttara", pickup: { zone: "Uttara", area: null }, pickupHub: null, routeDistrict: "Dhaka North" });
  });

  it("validates the pickup phone, the website and the map pin", async () => {
    const res = await apply(application({ pickupContactPhone: "12345", websiteUrl: "not a site", business: { ...business, lat: 51.5, lng: -0.1 } }));
    expect(res.status).toBe(422);
    const details = res.body.error.details as { path: string; message: string }[];
    expect(details.find(d => d.path === "pickupContactPhone")?.message).toMatch(/Bangladeshi mobile/);
    expect(details.map(d => d.path)).toEqual(expect.arrayContaining(["websiteUrl", "business.lat", "business.lng"]));
    const ok = await apply(application({ pickupContactPhone: "1922-333444" }));
    expect(ok.body.merchant.pickupContactPhone).toBe("+8801922333444");
  });

  it("looks up the serving hub publicly for the form's Drop at hub", async () => {
    const res = await ctx.api("GET", "/merchants/pickup-hub?district=Dhaka%20North&zone=Banani");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ district: "Dhaka North", zone: "Banani", hub: { name: "Banani Hub", address: "Road 11, Banani" }, routeDistrict: "Dhaka North" });
    expect((await ctx.api("GET", "/merchants/pickup-hub?district=Dhaka%20North&zone=Uttara")).body.hub).toBeNull();
    expect((await ctx.api("GET", "/merchants/pickup-hub?district=Dhaka%20North&zone=Nowhere")).status).toBe(422);
  });

  it("an active merchant's own address change waits for approval; approved, the hub follows (audited)", async () => {
    const owner = await applicant();
    const created = await ctx.api("POST", "/merchants/applications", { token: owner.token, body: application() });
    const id = created.body.merchant.id as string;
    await ctx.prisma.merchant.update({ where: { id }, data: { status: "ACTIVE" } });
    const login = await ctx.api("POST", "/auth/refresh", { body: { refreshToken: owner.refreshToken } });
    const token = login.body.accessToken as string;
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops Manager");

    // The address waits; the other Settings fields apply at once.
    const moved = await ctx.api("PATCH", "/merchants/me", {
      token,
      body: { pickupSameAsBusiness: false, pickup: { district: "Dhaka North", zone: "Banani", area: "Banani Block C", street: "House 2, Road 13" }, pickupTime: "MORNING", handover: "HUB_DROP" },
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body).toMatchObject({
      pickup: { zone: "Gulshan" },
      pickupHub: { id: gulshanHub.id },
      handover: "HUB_DROP",
      pickupTime: "MORNING",
      addressRequest: {
        status: "PENDING",
        previous: { pickup: "House 7, Road 4, Flat B2, Road 4 Gulshan, Gulshan, Dhaka North" },
        proposed: { pickup: "House 2, Road 13, Banani Block C, Banani, Dhaka North", pickupSameAsBusiness: false },
        previousHub: { name: "Gulshan Hub" },
        proposedHub: { name: "Banani Hub" },
        hubChanges: true,
      },
    });
    // Invalid places are refused at once, not queued.
    const bad = await ctx.api("PATCH", "/merchants/me", { token, body: { pickupSameAsBusiness: false, pickup: { district: "Dhaka North", zone: "Mars", street: "House 1, Road 1" } } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details[0].path).toBe("pickup.zone");

    // Operations see it; a rejection needs a reason.
    const queue = await ctx.api("GET", "/merchant-address-requests", { token: ops.token });
    expect(queue.body.items).toEqual([expect.objectContaining({ status: "PENDING", merchant: expect.objectContaining({ id, name: "Address Test Shop" }), proposedHub: expect.objectContaining({ name: "Banani Hub" }) })]);
    const requestId = queue.body.items[0].id as string;
    expect((await ctx.api("POST", `/merchant-address-requests/${requestId}/reject`, { token: ops.token, body: {} })).status).toBe(422);
    expect((await ctx.api("GET", "/merchant-address-requests", { token })).status).toBe(403);

    // Approved: the address is applied and the hub follows it.
    const approved = await ctx.api("POST", `/merchant-address-requests/${requestId}/approve`, { token: ops.token });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({ status: "APPROVED", decidedBy: "Ops Manager" });
    const me = await ctx.api("GET", "/merchants/me", { token });
    expect(me.body).toMatchObject({ pickup: { zone: "Banani" }, pickupHub: { id: bananiHub.id }, business: { zone: "Gulshan" } });
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: "merchant.address_approved", entityId: id } });
    expect(audit.data).toMatchObject({ pickupHubId: bananiHub.id, previousPickupHubId: gulshanHub.id });
    expect(await ctx.prisma.outboxMessage.count({ where: { template: "merchant.address_change" } })).toBeGreaterThan(0);
    expect((await ctx.api("POST", `/merchant-address-requests/${requestId}/approve`, { token: ops.token })).body.error.code).toBe("ADDRESS_REQUEST_DECIDED");

    // A second change, rejected with a reason; another one, withdrawn by the merchant.
    await ctx.api("PATCH", "/merchants/me", { token, body: { pickupSameAsBusiness: true } });
    const second = (await ctx.api("GET", "/merchant-address-requests", { token: ops.token })).body.items[0];
    const rejected = await ctx.api("POST", `/merchant-address-requests/${second.id}/reject`, { token: ops.token, body: { note: "Send a photo of the new shop sign" } });
    expect(rejected.body).toMatchObject({ status: "REJECTED", note: "Send a photo of the new shop sign" });
    expect((await ctx.api("GET", "/merchants/me/address-request", { token })).body.request).toMatchObject({ status: "REJECTED", note: "Send a photo of the new shop sign" });
    expect((await ctx.api("GET", "/merchants/me", { token })).body.pickup).toMatchObject({ zone: "Banani" });
    await ctx.api("PATCH", "/merchants/me", { token, body: { business: { district: "Dhaka North", zone: "Uttara", street: "House 9, Sector 4" } } });
    const cancelled = await ctx.api("POST", "/merchants/me/address-request/cancel", { token });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect((await ctx.api("GET", "/merchant-address-requests", { token: ops.token })).body.items).toEqual([]);
  });

  it("operations change an address directly; the merchants of a zone follow its serving hub; lists filter by hub", async () => {
    const owner = await applicant();
    const id = (await ctx.api("POST", "/merchants/applications", { token: owner.token, body: application() })).body.merchant.id as string;
    await ctx.prisma.merchant.update({ where: { id }, data: { status: "ACTIVE" } });
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }], "Ops Manager");

    const direct = await ctx.api("PATCH", `/merchants/${id}/address`, { token: ops.token, body: { pickupSameAsBusiness: false, pickup: { district: "Dhaka North", zone: "Banani", area: "Banani Block C", street: "Warehouse 3, Road 27" } } });
    expect(direct.status, JSON.stringify(direct.body)).toBe(200);
    expect(direct.body).toMatchObject({ pickup: { zone: "Banani" }, pickupHub: { id: bananiHub.id } });
    expect((await ctx.api("PATCH", `/merchants/${id}/address`, { token: owner.token, body: { pickupSameAsBusiness: true } })).status).toBe(403);

    // Banani gets the Gulshan hub as its serving hub: the merchant moves with it.
    const zone = await ctx.prisma.deliveryZone.findFirstOrThrow({ where: { code: "DHN-BAN" } });
    expect((await ctx.api("PATCH", `/zones/${zone.id}`, { token: ops.token, body: { hubId: gulshanHub.id } })).status).toBe(200);
    expect((await ctx.prisma.merchant.findUniqueOrThrow({ where: { id } })).pickupHubId).toBe(gulshanHub.id);
    expect(await ctx.prisma.auditLog.count({ where: { action: "merchant.hub_rederived", entityId: id } })).toBe(1);

    // The Gulshan hub switched off: no serving hub any more.
    expect((await ctx.api("PATCH", `/hubs/${gulshanHub.id}`, { token: ops.token, body: { active: false } })).status).toBe(200);
    expect((await ctx.prisma.merchant.findUniqueOrThrow({ where: { id } })).pickupHubId).toBeNull();

    // Merchant lists by hub ("none": no hub serves the pickup area).
    const none = await ctx.api("GET", "/merchants?hubId=none", { token: ops.token });
    expect(none.body.items.map((m: { id: string }) => m.id)).toContain(id);
    expect((await ctx.api("GET", `/merchants?hubId=${bananiHub.id}`, { token: ops.token })).body.items).toEqual([]);
  });

  it("older merchants keep their free text, get a best-effort suggestion and complete the address in Settings", async () => {
    const m = await ctx.prisma.merchant.create({
      data: { code: "MR-OLD", type: "ECOMMERCE", name: "Old Shop", status: "ACTIVE", contactName: "Owner", contactPhone: "+8801711111111", pickupAddress: "Road 1, Banani", pickupArea: "Banani Block C", pickupDistrict: "Dhaka North" },
    });
    const owner = await userWithRoles(ctx, [{ role: "MERCHANT_OWNER", merchantId: m.id }]);
    const me = await ctx.api("GET", "/merchants/me", { token: owner.token });
    expect(me.body).toMatchObject({ addressComplete: false, pickupAddress: "Road 1, Banani", pickupArea: "Banani Block C", pickup: { zone: null }, pickupSuggestion: { district: "Dhaka North", zone: "Banani", area: "Banani Block C" } });
    const done = await ctx.api("PATCH", "/merchants/me", {
      token: owner.token,
      body: { business: { district: "Dhaka North", zone: "Banani", area: "Banani Block C", street: "Road 1, Banani" }, pickupSameAsBusiness: true, pickupContactName: "Owner", pickupContactPhone: "01711111111", pickupTime: "MIDDAY" },
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ addressComplete: true, pickupHub: { id: bananiHub.id } });
  });

  it("keeps the invitation's merchant type locked", async () => {
    const sa = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }]);
    const invite = await ctx.api("POST", "/merchants/invites", { token: sa.token, body: { name: "Bank Contact", businessName: "Probashi Bank", phone: "01912345670", type: "BANKING_FINANCIAL" } });
    expect(invite.status, JSON.stringify(invite.body)).toBe(201);
    const token = new URL(invite.body.link.replace("#/", "")).searchParams.get("invite")!;
    const wrong = await apply(application({ inviteToken: token }));
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.code).toBe("INVITE_TYPE_MISMATCH");
    const right = await apply(application({ type: "BANKING_FINANCIAL", businessCategory: "Bank", inviteToken: token }));
    expect(right.status, JSON.stringify(right.body)).toBe(201);
    expect(right.body.merchant).toMatchObject({ type: "BANKING_FINANCIAL", businessCategory: "Bank", pickupHub: { id: gulshanHub.id } });
  });
});
