import { hub, PASSWORD, resetDatabase, startApp, userWithRoles, type TestContext } from "./helpers";
import { GeoService } from "../src/modules/geo/geo.service";

/**
 * Super admin › Riders (several hubs, edit, password), the sign-in message off by default with its preview, the nearest
 * hub from the rider's position, franchise / merchant accounts with a password, and finding hub locations.
 */
describe("riders on several hubs, account messages and passwords, hub locations", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  const invites = (to: string) => ctx.prisma.outboxMessage.count({ where: { template: { in: ["account.invite", "merchant.invite"] }, to } });
  const login = async (phone: string, password: string) => ctx.api("POST", "/auth/login", { body: { identifier: phone, password } });

  it("adds a rider on two hubs without a message, edits them, and the app moves them to the nearest hub", async () => {
    const admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Admin");
    const gulshan = await hub(ctx, "HUB-GUL");
    const uttara = await hub(ctx, "HUB-UTT");
    await ctx.prisma.hub.update({ where: { id: gulshan.id }, data: { lat: 23.7925, lng: 90.4078 } });
    await ctx.prisma.hub.update({ where: { id: uttara.id }, data: { lat: 23.8759, lng: 90.3795 } });

    // The message preview names the rider's hub; nothing is sent by default.
    const preview = await ctx.api("POST", "/accounts/invite-preview", { token: admin.token, body: { kind: "rider", name: "Rafi", hubId: gulshan.id } });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.sms).toContain("rider");
    expect(preview.body.sms).toContain("/login");

    const made = await ctx.api("POST", "/riders", { token: admin.token, body: { name: "Rafi Rider", phone: "01913000011", hubIds: [gulshan.id, uttara.id], vehicle: "MOTORBIKE", password: PASSWORD } });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body).toMatchObject({ messageSent: false, hub: { id: gulshan.id } });
    expect(made.body.hubs.map((h: { id: string }) => h.id).sort()).toEqual([gulshan.id, uttara.id].sort());
    expect(await invites("+8801913000011")).toBe(0);
    // The password set here signs in.
    const rider = await login("+8801913000011", PASSWORD);
    expect(rider.status, JSON.stringify(rider.body)).toBe(200);
    const riderToken = rider.body.accessToken as string;

    // Both hubs list the rider (assignment); the company list has them.
    const ofUttara = (await ctx.api("GET", `/riders?hubId=${uttara.id}`, { token: admin.token })).body as { id: string }[];
    expect(ofUttara.map(r => r.id)).toContain(made.body.id);
    expect(((await ctx.api("GET", "/riders?company=true", { token: admin.token })).body as { id: string }[]).map(r => r.id)).toContain(made.body.id);

    // In Uttara: the app makes Uttara their hub (cash goes there); a location ping does the same.
    const moved = await ctx.api("POST", "/rider/me/nearest-hub", { token: riderToken, body: { lat: 23.874, lng: 90.38 } });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body).toMatchObject({ changed: true, hub: { id: uttara.id } });
    // On shift, a location ping near Gulshan moves them back.
    await ctx.api("PATCH", "/rider/me/status", { token: riderToken, body: { status: "ONLINE" } });
    const ping = await ctx.api("POST", "/rider/location", { token: riderToken, body: { lat: 23.793, lng: 90.407, accuracy: 10, at: new Date().toISOString() } });
    expect(ping.status, JSON.stringify(ping.body)).toBe(202);
    expect((await ctx.prisma.rider.findUniqueOrThrow({ where: { id: made.body.id } })).hubId).toBe(gulshan.id);

    // Edit: name, mobile, one hub only, a new password.
    const edited = await ctx.api("PATCH", `/riders/${made.body.id}`, { token: admin.token, body: { name: "Rafi Ahmed", phone: "01913000012", hubIds: [uttara.id], password: "NewPass12345" } });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body).toMatchObject({ name: "Rafi Ahmed", phone: "+8801913000012", hub: { id: uttara.id } });
    expect(edited.body.hubs).toHaveLength(1);
    expect((await login("+8801913000012", "NewPass12345")).status).toBe(200);
    // Another account's mobile is refused.
    const other = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Other");
    expect((await ctx.api("PATCH", `/riders/${made.body.id}`, { token: admin.token, body: { phone: other.phone } })).body.error.code).toBe("PHONE_IN_USE");

    // With "Send SMS": the sign-in message goes.
    const sent = await ctx.api("POST", "/riders", { token: admin.token, body: { name: "Sumon", phone: "01913000013", hubIds: [gulshan.id], vehicle: "BICYCLE", sendSms: true } });
    expect(sent.body.messageSent).toBe(true);
    expect(await invites("+8801913000013")).toBeGreaterThan(0);
  });

  it("franchise riders stay out of the company list; a franchise account gets a password and no message unless asked", async () => {
    const admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Admin");
    const company = await hub(ctx, "HUB-CO1");
    const created = await ctx.api("POST", "/franchises", {
      token: admin.token,
      body: {
        name: "Mirpur Point",
        contactName: "Mizan",
        phone: "01913000021",
        password: PASSWORD,
        hub: { name: "Mirpur Franchise", district: "Dhaka North", zone: "Gulshan", address: "Mirpur 10" },
        rates: { pickupPercent: 10, pickupMin: 15, deliveryPercent: 20, deliveryMin: 20, returnPercent: 10, returnMin: 10 },
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ messageSent: false, newAccount: true, passwordSet: true });
    expect(await invites("+8801913000021")).toBe(0);
    const owner = await login("+8801913000021", PASSWORD);
    expect(owner.status, JSON.stringify(owner.body)).toBe(200);
    const fr = await ctx.api("POST", "/franchise/riders", { token: owner.body.accessToken, body: { name: "Franchise Rider", phone: "01913000022", vehicle: "MOTORBIKE" } });
    expect(fr.status, JSON.stringify(fr.body)).toBe(201);
    const companyRider = await ctx.api("POST", "/riders", { token: admin.token, body: { name: "Company Rider", phone: "01913000023", hubIds: [company.id], vehicle: "MOTORBIKE" } });
    const list = ((await ctx.api("GET", "/riders?company=true", { token: admin.token })).body as { id: string }[]).map(r => r.id);
    expect(list).toContain(companyRider.body.id);
    expect(list).not.toContain(fr.body.id);
    // Franchises › Riders: the franchise hub's riders.
    expect(((await ctx.api("GET", `/riders?hubId=${created.body.hub.id}`, { token: admin.token })).body as { id: string }[]).map(r => r.id)).toEqual([fr.body.id]);
  });

  it("a merchant invitation with a password makes the account now; without 'Send SMS' nothing goes out", async () => {
    const admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Admin");
    const preview = await ctx.api("POST", "/accounts/invite-preview", { token: admin.token, body: { kind: "merchant", name: "Karim", businessName: "Karim Gadgets", merchantType: "ECOMMERCE" } });
    expect(preview.body.sms).toContain("Karim Gadgets");
    const invited = await ctx.api("POST", "/merchants/invites", { token: admin.token, body: { name: "Karim", businessName: "Karim Gadgets", phone: "01913000031", type: "ECOMMERCE", password: PASSWORD } });
    expect(invited.status, JSON.stringify(invited.body)).toBe(201);
    expect(invited.body).toMatchObject({ messageSent: false, accountCreated: true });
    expect(await invites("+8801913000031")).toBe(0);
    expect((await login("+8801913000031", PASSWORD)).status).toBe(200);
    // The link's form offers "sign in" (the account exists).
    const token = new URL(invited.body.link).searchParams.get("invite")!;
    expect((await ctx.api("POST", "/merchants/invites/lookup", { body: { token } })).body).toMatchObject({ hasAccount: true });
    // A password needs the mobile number.
    expect((await ctx.api("POST", "/merchants/invites", { token: admin.token, body: { name: "Mail Only", email: "m@example.com", type: "ECOMMERCE", password: PASSWORD } })).status).toBe(422);
  });

  it("onboards a merchant directly: active at once, the owner signs in with the password, no message unless asked", async () => {
    const admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Admin");
    const preview = await ctx.api("POST", "/accounts/invite-preview", { token: admin.token, body: { kind: "merchant_onboard", businessName: "Rahim Fashion" } });
    expect(preview.body).toMatchObject({ event: "merchant.approved" });
    expect(preview.body.sms).toContain("Rahim Fashion");
    const catalog = (await ctx.api("GET", "/catalog")).body as { areasByZone: Record<string, string[]> };
    const area = catalog.areasByZone.Gulshan?.[0];
    const body = { type: "ECOMMERCE", name: "Rahim Fashion", contactName: "Rahim", contactPhone: "01913000041", business: { district: "Dhaka North", zone: "Gulshan", ...(area ? { area } : {}), street: "House 5, Road 2, Gulshan" }, password: PASSWORD };
    const made = await ctx.api("POST", "/merchants/onboard", { token: admin.token, body });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body).toMatchObject({ messageSent: false, accountCreated: true, passwordSet: true, merchant: { name: "Rahim Fashion", status: "ACTIVE" } });
    expect(await invites("+8801913000041")).toBe(0);
    expect(await ctx.prisma.outboxMessage.count({ where: { template: "merchant.approved", to: "+8801913000041" } })).toBe(0);
    const owner = await login("+8801913000041", PASSWORD);
    expect(owner.status, JSON.stringify(owner.body)).toBe(200);
    expect(owner.body.user).toMatchObject({ panel: "/ecommerce-merchant" });
    // The same mobile can't own a second merchant.
    expect((await ctx.api("POST", "/merchants/onboard", { token: admin.token, body: { ...body, name: "Another" } })).body.error.code).toBe("ALREADY_MERCHANT_OWNER");
    // An invitation's account (with a password) is a customer account: it has a page to open (no redirect loop).
    await ctx.api("POST", "/merchants/invites", { token: admin.token, body: { name: "Lina", phone: "01913000042", type: "ECOMMERCE", password: PASSWORD } });
    const invited = await login("+8801913000042", PASSWORD);
    expect(invited.body.user).toMatchObject({ roles: ["CUSTOMER"], panel: "/account" });
  });

  it("finds hub locations: the geocoder, else the zone's centre", async () => {
    const admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Admin");
    const a = await hub(ctx, "HUB-L1");
    const b = await hub(ctx, "HUB-L2");
    await ctx.prisma.hub.update({ where: { id: a.id }, data: { address: "Road 11, Banani", lat: null, lng: null } });
    await ctx.prisma.hub.update({ where: { id: b.id }, data: { address: "Unknown place", zone: "Gulshan", district: "Dhaka North", lat: null, lng: null } });
    await ctx.prisma.deliveryZone.updateMany({ where: { district: "Dhaka North", name: "Gulshan" }, data: { lat: 23.78, lng: 90.41 } });
    const geo = ctx.app.get(GeoService);
    const original = geo.geocode.bind(geo);
    geo.geocode = async (text: string) => (text.startsWith("Road 11, Banani") ? { label: "Road 11, Banani, Dhaka", lat: 23.7937, lng: 90.4066, street: null, area: null, zone: null, district: null, postcode: null, source: "nominatim" } : null);
    try {
      const res = await ctx.api("POST", "/hubs/locate", { token: admin.token, body: { hubIds: [a.id, b.id] } });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const by = (id: string) => res.body.hubs.find((h: { id: string }) => h.id === id);
      expect(by(a.id)).toMatchObject({ source: "address", lat: 23.7937 });
      const zoneHasCentre = await ctx.prisma.deliveryZone.count({ where: { district: "Dhaka North", name: "Gulshan", lat: { not: null } } });
      if (zoneHasCentre) expect(by(b.id)).toMatchObject({ source: "zone centre", lat: 23.78 });
      expect((await ctx.prisma.hub.findUniqueOrThrow({ where: { id: a.id } })).lat).toBeCloseTo(23.7937, 4);
    } finally {
      geo.geocode = original;
    }
  });
});
