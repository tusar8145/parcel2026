import { resetDatabase, startApp, userWithRoles, type TestContext } from "./helpers";
import { BrandingService } from "../src/modules/branding/branding.service";
import { OutboxService } from "../src/modules/notifications/outbox.service";
import { NotificationSettingsService } from "../src/modules/notifications/notification-settings.service";

// A 1×1 PNG.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("branding (white label)", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(async () => {
    await resetDatabase(ctx);
    (ctx.app.get(BrandingService) as unknown as { cache: unknown }).cache = null;
  });
  afterAll(() => ctx.app.close());

  it("is public, with Paira Express's details and the default tab icon until changed", async () => {
    const res = await ctx.api("GET", "/branding");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ companyName: "Paira Express", logoUrl: null, iconUrl: "/api/v1/branding/icon?v=default", custom: false });
    expect(res.body.contact.email).toBe("info@pairaexpress.com.bd");
    // The About page's own text, ready to edit.
    expect(res.body.about.body).toContain("## Our Story");
    expect(res.body.about.intro).toContain("nationwide courier");
    const icon = await ctx.app.inject({ method: "GET", url: "/api/v1/branding/icon" });
    expect(icon.statusCode).toBe(200);
    expect(icon.headers["content-type"]).toContain("image/svg+xml");
    expect(icon.headers["content-security-policy"]).toContain("sandbox");
    expect((await ctx.app.inject({ method: "GET", url: "/api/v1/branding/logo" })).statusCode).toBe(404);
  });

  it("only platform admins change it; the name, contact, images and About text then show everywhere", async () => {
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }]);
    const admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Admin");
    const body = {
      companyName: "Swift Parcel",
      contact: { phone: "01700 000000", email: "hello@swift.example" },
      social: { facebook: "https://facebook.com/swift" },
      about: { body: "We deliver.\n\n## Why us\n- Fast" },
      logo: PNG,
      icon: PNG,
    };
    expect((await ctx.api("PUT", "/branding", { token: ops.token, body })).status).toBe(403);
    expect((await ctx.api("PUT", "/branding", { body })).status).toBe(401);

    const bad = await ctx.api("PUT", "/branding", { token: admin.token, body: { logo: "data:text/html;base64,PGI+" } });
    expect(bad.status).toBe(422);

    const saved = await ctx.api("PUT", "/branding", { token: admin.token, body });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ companyName: "Swift Parcel", legalName: "Swift Parcel", custom: true, about: { title: "About Swift Parcel" } });
    expect(saved.body.contact).toMatchObject({ phone: "01700 000000", email: "hello@swift.example", address: "House-6 Road -2A Banani, Dhaka-1213" });
    expect(saved.body.logoUrl).toMatch(/^\/api\/v1\/branding\/logo\?v=/);
    expect(saved.body.iconUrl).not.toContain("default");

    const logo = await ctx.app.inject({ method: "GET", url: "/api/v1/branding/logo" });
    expect(logo.statusCode).toBe(200);
    expect(logo.headers["content-type"]).toContain("image/png");
    const again = await ctx.app.inject({ method: "GET", url: "/api/v1/branding/logo", headers: { "if-none-match": String(logo.headers.etag) } });
    expect(again.statusCode).toBe(304);

    // A partial update keeps the rest; null removes the logo.
    const partial = await ctx.api("PUT", "/branding", { token: admin.token, body: { tagline: "Same day", logo: null } });
    expect(partial.body).toMatchObject({ companyName: "Swift Parcel", tagline: "Same day", logoUrl: null });
    expect(partial.body.contact.email).toBe("hello@swift.example");

    expect(await ctx.prisma.auditLog.count({ where: { action: "branding.update" } })).toBe(2);
  });

  it("messages and the notification brand use the company name", async () => {
    const admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Admin");
    const renamed = await ctx.api("PUT", "/branding", { token: admin.token, body: { companyName: "Swift Parcel" } });
    // The About text not written yet: Paira Express's, with the new name.
    expect(renamed.body.about.body).toContain("Swift Parcel was incorporated in 2024");
    expect(renamed.body.about.body).not.toContain("Paira Express");
    const id = await ctx.app.get(OutboxService).queue(ctx.prisma, { channel: "SMS", to: "+8801700000001", template: "test", body: "Paira Express: your parcel is on the way." });
    expect((await ctx.prisma.outboxMessage.findUniqueOrThrow({ where: { id } })).body).toBe("Swift Parcel: your parcel is on the way.");
    const snap = await ctx.app.get(NotificationSettingsService).snapshot();
    expect(snap.brand).toMatchObject({ appName: "Swift Parcel", support: "Swift Parcel support" });
  });
});
