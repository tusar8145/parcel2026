import { vi } from "vitest";
import { createServer, type Server } from "node:http";

// Before the app (and its cached env) loads: geo calls go to the local stand-in below.
const NOMINATIM_PORT = 47651;
vi.hoisted(() => {
  process.env.NOMINATIM_URL = "http://127.0.0.1:47651";
  process.env.NOMINATIM_MIN_INTERVAL_MS = "0";
});
import { decrypt } from "../src/common/crypto";
import { hub, parcelBody, resetDatabase, riderUser, startApp, userWithRoles, type TestContext } from "./helpers";

// A stand-in for Nominatim, so geo tests never call the public server.
const nominatimRequests: { url: string; userAgent?: string }[] = [];
const nominatim: Server = createServer((req, res) => {
  nominatimRequests.push({ url: req.url ?? "", userAgent: req.headers["user-agent"] });
  res.setHeader("content-type", "application/json");
  if (req.url?.startsWith("/search")) {
    res.end(
      JSON.stringify([
        {
          lat: "23.7937",
          lon: "90.4066",
          display_name: "Road 11, Banani, Dhaka, Bangladesh",
          address: { road: "Road 11", house_number: "42", suburb: "Banani", city: "Dhaka", postcode: "1213" },
        },
      ]),
    );
  } else if (req.url?.startsWith("/reverse")) {
    res.end(JSON.stringify({ lat: "23.78", lon: "90.41", display_name: "Gulshan Avenue, Gulshan, Dhaka, Bangladesh", address: { road: "Gulshan Avenue", suburb: "Gulshan", city: "Dhaka" } }));
  } else {
    res.statusCode = 404;
    res.end("{}");
  }
});

const SENDER = "01711000000";
// Website (customer) parcels: CP-… (system guide: parcel prefixes by line).
const CROCKFORD_ID = /^CP-\d{6}-[0-9A-HJKMNP-TV-Z]{5}$/;

describe("public website", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    await new Promise<void>(r => nominatim.listen(NOMINATIM_PORT, "127.0.0.1", r));
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(async () => {
    await ctx.app.close();
    nominatim.close();
  });

  /** The first bookable slot the API offers. */
  const firstSlot = async () => {
    const res = await ctx.api("GET", "/pickup-slots");
    expect(res.status).toBe(200);
    const slot = res.body.days.flatMap((d: { slots: { available: boolean }[] }) => d.slots).find((s: { available: boolean }) => s.available);
    expect(slot).toBeTruthy();
    return { start: slot.start as string, end: slot.end as string };
  };

  const verifyGuest = async (phone = SENDER) => {
    const sent = await ctx.api("POST", "/guest/verification", { body: { phone } });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(await ctx.prisma.outboxMessage.count({ where: { template: "guest.booking_verification" } })).toBeGreaterThan(0);
    const confirmed = await ctx.api("POST", "/guest/verification/confirm", { body: { phone, code: sent.body.devCode } });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    return confirmed.body.verificationToken as string;
  };

  it("issues random, readable tracking IDs and still finds older and mistyped ones", async () => {
    const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Rahim Uddin");
    const ids = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const res = await ctx.api("POST", "/parcels", { token: customer.token, body: parcelBody() });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.trackingId).toMatch(CROCKFORD_ID);
      ids.add(res.body.trackingId);
    }
    expect(ids.size).toBe(3);

    // Typed with spaces, lower case and an O for a zero still finds it.
    const id = [...ids][0];
    const [, date, random] = id.split("-");
    const typed = ` cp-${date}-${random.toLowerCase().replace(/0/g, "o").replace(/1/g, "l")} `;
    expect((await ctx.api("GET", `/track/${encodeURIComponent(typed)}`)).body.trackingId).toBe(id);

    // An older sequential ID stays valid.
    await ctx.prisma.parcel.update({ where: { trackingId: id }, data: { trackingId: "PP-261001-1001" } });
    expect((await ctx.api("GET", "/track/PP-261001-1001")).status).toBe(200);
  });

  it("lists pickup slots and enforces them for website bookings", async () => {
    const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }]);
    const slots = await ctx.api("GET", "/pickup-slots");
    expect(slots.body).toMatchObject({ timezone: "Asia/Dhaka" });
    expect(slots.body.days).toHaveLength(7);
    expect(slots.body.days[0].label).toBe("Today");

    const bad = await ctx.api("POST", "/parcels", {
      token: customer.token,
      body: parcelBody({ pickupWindow: { start: "2026-01-01T03:00:00.000Z", end: "2026-01-01T06:00:00.000Z" } }),
    });
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe("PICKUP_SLOT_UNAVAILABLE");

    const slot = await firstSlot();
    const ok = await ctx.api("POST", "/parcels", { token: customer.token, body: parcelBody({ pickupWindow: slot }) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.pickupWindow).toMatchObject({ start: slot.start, end: slot.end });
    expect(ok.body.pickupWindow.label).toMatch(/, \d{1,2}:\d{2} [AP]M – \d{1,2}:\d{2} [AP]M$/);
    // Shown (without personal details) on public tracking too.
    expect((await ctx.api("GET", `/track/${ok.body.trackingId}`)).body.pickupWindow.start).toBe(slot.start);
  });

  it("caps a slot at its configured capacity", async () => {
    const admin = await userWithRoles(ctx, [{ role: "SUPER_ADMIN" }]);
    const saved = await ctx.api("PUT", "/pickup-slots/config", {
      token: admin.token,
      body: { daysAhead: 7, leadMinutes: 0, closedWeekdays: [], windows: [{ start: "08:00", end: "20:00", capacity: 1 }] },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }]);
    const tomorrow = (await ctx.api("GET", "/pickup-slots")).body.days[1];
    const window = { start: tomorrow.slots[0].start, end: tomorrow.slots[0].end };
    expect((await ctx.api("POST", "/parcels", { token: customer.token, body: parcelBody({ pickupWindow: window }) })).status).toBe(201);
    const full = await ctx.api("POST", "/parcels", { token: customer.token, body: parcelBody({ pickupWindow: window }) });
    expect(full.body.error.code).toBe("PICKUP_SLOT_UNAVAILABLE");
    const after = (await ctx.api("GET", `/pickup-slots?date=${tomorrow.date}`)).body.days[0].slots[0];
    expect(after).toMatchObject({ available: false, remaining: 0 });
  });

  it("books as a guest after phone verification, with a tracking link that can cancel", async () => {
    // Without verification: rejected under the verification field.
    const noToken = await ctx.api("POST", "/guest/parcels", { body: { ...parcelBody(), verificationToken: "x.y.zzzzzzzzzz" } });
    expect(noToken.status).toBe(401);
    expect(noToken.body.error.details[0].path).toBe("verificationToken");

    // Wrong code.
    await ctx.api("POST", "/guest/verification", { body: { phone: SENDER } });
    const wrong = await ctx.api("POST", "/guest/verification/confirm", { body: { phone: SENDER, code: "000000" } });
    expect(wrong.body.error.details[0].path).toBe("code");
    // A second code within a minute is refused with retry-after.
    const again = await ctx.api("POST", "/guest/verification", { body: { phone: SENDER } });
    expect(again.status).toBe(429);
    expect(Number(again.headers["retry-after"])).toBeGreaterThan(0);
    await ctx.app.get((await import("../src/common/redis.service")).RedisService).flushdb();

    const token = await verifyGuest();
    // The sender's phone must be the verified one.
    const otherPhone = await ctx.api("POST", "/guest/parcels", { body: { ...parcelBody({ sender: { name: "Rahim", phone: "01799999999" } }), verificationToken: token } });
    expect(otherPhone.status).toBe(422);
    expect(otherPhone.body.error.details[0].path).toBe("sender.phone");

    const booked = await ctx.api("POST", "/guest/parcels", { body: { ...parcelBody({ pickupWindow: await firstSlot() }), verificationToken: token } });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    expect(booked.body.trackingId).toMatch(CROCKFORD_ID);
    expect(booked.body.trackingUrl).toContain(`/track/${booked.body.trackingId}?t=`);
    expect(booked.body.parcel).toMatchObject({ status: "PENDING_CONFIRMATION", canCancel: true, access: "owner" });
    const parcel = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId: booked.body.trackingId } });
    expect(parcel).toMatchObject({ customerId: null, channel: "WEBSITE" });

    // The verification is single-use.
    const reuse = await ctx.api("POST", "/guest/parcels", { body: { ...parcelBody(), verificationToken: token } });
    expect(reuse.body.error.code).toBe("GUEST_VERIFICATION_USED");

    // Public tracking stays masked; the link shows full details.
    const masked = await ctx.api("GET", `/track/${booked.body.trackingId}`);
    expect(JSON.stringify(masked.body)).not.toContain("+8801711000000");
    const full = await ctx.api("GET", `/track/${booked.body.trackingId}/full?t=${encodeURIComponent(booked.body.accessToken)}`);
    expect(full.status).toBe(200);
    expect(JSON.stringify(full.body)).toContain("+8801711000000");
    // A tampered token looks like an unknown parcel.
    expect((await ctx.api("GET", `/track/${booked.body.trackingId}/full?t=${booked.body.accessToken.slice(0, -2)}xx`)).status).toBe(404);

    const cancelled = await ctx.api("POST", `/track/${booked.body.trackingId}/cancel`, { body: { token: booked.body.accessToken, reason: "Booked by mistake" } });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body).toMatchObject({ status: "PICKUP_CANCELLED", canCancel: false });
  });

  it("takes one rating per delivered parcel from the owner or the feedback link, visible to staff", async () => {
    const h = await hub(ctx);
    const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }], "Rahim Uddin");
    const ops = await userWithRoles(ctx, [{ role: "OPS_MANAGER" }]);
    const rider = await riderUser(ctx, "R-3301", h.id);
    const { trackingId } = (await ctx.api("POST", "/parcels", { token: customer.token, body: parcelBody() })).body;

    // Not before delivery.
    expect((await ctx.api("POST", `/parcels/${trackingId}/feedback`, { token: customer.token, body: { rating: 5 } })).body.error.code).toBe("FEEDBACK_NOT_AVAILABLE");

    await ctx.api("POST", `/parcels/${trackingId}/assign-pickup`, { token: ops.token, body: { riderId: rider.rider.id } });
    await ctx.api("POST", `/rider/parcels/${trackingId}/pickup`, { token: rider.token, body: { outcome: "COLLECTED_TO_HUB", hubId: h.id } });
    await ctx.api("POST", `/parcels/${trackingId}/assign-delivery`, { token: ops.token, body: { riderId: rider.rider.id } });
    await ctx.api("POST", `/rider/parcels/${trackingId}/start-delivery`, { token: rider.token });
    const code = decrypt((await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId } })).deliveryOtpEncrypted!);
    const done = await ctx.api("POST", `/rider/parcels/${trackingId}/delivery`, { token: rider.token, body: { outcome: "DELIVERED", receivedBy: "Nabila", proof: { method: "OTP", otp: code }, codCollected: 1500 } });
    expect(done.body.status).toBe("DELIVERED");

    // The feedback request goes out (email only by default for SMS) with a signed link.
    const request = await ctx.prisma.outboxMessage.findMany({ where: { template: "parcel.feedback_request" } });
    const link = request.map(m => m.body.match(/https?:\/\/\S+/)?.[0]).find(Boolean);
    if (link) expect(link).toContain(`/track/${trackingId}?t=f.`);

    // Strangers and invalid ratings are refused.
    expect((await ctx.api("POST", `/parcels/${trackingId}/feedback`, { body: { rating: 5 } })).status).toBe(404);
    const invalid = await ctx.api("POST", `/parcels/${trackingId}/feedback`, { token: customer.token, body: { rating: 7 } });
    expect(invalid.status).toBe(422);
    expect(invalid.body.error.details[0].path).toBe("rating");

    const given = await ctx.api("POST", `/parcels/${trackingId}/feedback`, { token: customer.token, body: { rating: 4, comment: "Quick and polite rider" } });
    expect(given.status, JSON.stringify(given.body)).toBe(201);
    expect(given.body).toMatchObject({ feedback: { rating: 4, comment: "Quick and polite rider", source: "TRACKING" }, canGiveFeedback: false });
    expect((await ctx.api("POST", `/parcels/${trackingId}/feedback`, { token: customer.token, body: { rating: 1 } })).body.error.code).toBe("FEEDBACK_EXISTS");
    expect((await ctx.api("GET", `/parcels/${trackingId}/feedback`, { token: customer.token })).body.feedback.rating).toBe(4);

    // Staff see it with a summary; customers can't list.
    expect((await ctx.api("GET", "/feedback", { token: customer.token })).status).toBe(403);
    const list = await ctx.api("GET", "/feedback", { token: ops.token });
    expect(list.status).toBe(200);
    expect(list.body.items[0]).toMatchObject({ trackingId, rating: 4, rider: { code: "R-3301" } });
    expect(list.body.summary).toMatchObject({ count: 1, average: 4 });
  });

  it("accepts feedback with a signed feedback link", async () => {
    const customer = await userWithRoles(ctx, [{ role: "CUSTOMER" }]);
    const { trackingId } = (await ctx.api("POST", "/parcels", { token: customer.token, body: parcelBody() })).body;
    await ctx.prisma.parcel.update({ where: { trackingId }, data: { status: "DELIVERED", deliveredAt: new Date() } });
    const { signParcelAccess } = await import("../src/modules/parcels/parcel-access");
    const t = signParcelAccess(trackingId, "feedback");
    const full = await ctx.api("GET", `/track/${trackingId}/full?t=${encodeURIComponent(t)}`);
    expect(full.body).toMatchObject({ access: "feedback", canCancel: false, canGiveFeedback: true });
    const given = await ctx.api("POST", `/parcels/${trackingId}/feedback`, { body: { rating: 5, token: t } });
    expect(given.status, JSON.stringify(given.body)).toBe(201);
    expect(given.body.feedback.source).toBe("SMS_LINK");
  });

  it("searches places and reverse-geocodes pins through a cached Nominatim client", async () => {
    nominatimRequests.length = 0;
    const short = await ctx.api("GET", "/geo/search?q=ab");
    expect(short.status).toBe(422);
    expect(short.body.error.details[0].path).toBe("q");

    const first = await ctx.api("GET", "/geo/search?q=Road%2011%20Banani");
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.items[0], JSON.stringify(first.body.items[0])).toMatchObject({ label: "Road 11, Banani, Dhaka", lat: 23.7937, lng: 90.4066, street: "42 Road 11", zone: "Banani", district: "Dhaka" });
    await ctx.api("GET", "/geo/search?q=road%2011%20banani");
    expect(nominatimRequests.filter(r => r.url.startsWith("/search"))).toHaveLength(1); // cached
    expect(nominatimRequests[0].userAgent).toMatch(/PairaExpress/);
    expect(nominatimRequests[0].url).toContain("countrycodes=bd");

    const pin = await ctx.api("GET", "/geo/reverse?lat=23.78&lng=90.41");
    expect(pin.body.place).toMatchObject({ zone: "Gulshan", lat: 23.78, lng: 90.41 });
  });

  it("verifies an email address by link or code, and an email change un-verifies it", async () => {
    const user = await userWithRoles(ctx, [{ role: "CUSTOMER" }]);
    const email = `verify-${Date.now()}@example.com`;
    expect((await ctx.api("POST", "/auth/email-verification", { token: user.token })).body.error.code).toBe("NO_EMAIL");
    await ctx.prisma.user.update({ where: { id: user.user.id }, data: { email } });

    const sent = await ctx.api("POST", "/auth/email-verification", { token: user.token });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body).toMatchObject({ email, verified: false, pending: true, sent: true });
    const mail = await ctx.prisma.outboxMessage.findFirstOrThrow({ where: { template: "auth.email_verification" } });
    expect(mail.to).toBe(email);
    expect(mail.body).toContain("/account/verify-email?token=");
    expect((await ctx.api("POST", "/auth/email-verification", { token: user.token })).status).toBe(429);

    const wrong = await ctx.api("POST", "/auth/email-verification/confirm", { token: user.token, body: { code: "000000" } });
    expect(wrong.body.error.details[0].path).toBe("code");
    const ok = await ctx.api("POST", "/auth/email-verification/confirm", { token: user.token, body: { code: sent.body.devCode } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ email, verified: true });

    // Changing the address un-verifies; the link (no sign-in) verifies the new one.
    await ctx.prisma.user.update({ where: { id: user.user.id }, data: { email: `new-${email}` } });
    expect((await ctx.api("GET", "/auth/email-verification", { token: user.token })).body.verified).toBe(false);
    await ctx.app.get((await import("../src/common/redis.service")).RedisService).flushdb();
    const resent = await ctx.api("POST", "/auth/email-verification", { token: user.token });
    const viaLink = await ctx.api("POST", "/auth/email-verification/confirm", { body: { token: resent.body.devToken } });
    expect(viaLink.status, JSON.stringify(viaLink.body)).toBe(200);
    expect(viaLink.body.verified).toBe(true);
    expect((await ctx.api("POST", "/auth/email-verification/confirm", { body: { token: "not-a-real-token-at-all-123" } })).status).toBe(400);
  });
});
