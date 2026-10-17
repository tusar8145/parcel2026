import http from "node:http";
import type { AddressInfo } from "node:net";
import { decrypt } from "../src/common/crypto";
import { OutboxService } from "../src/modules/notifications/outbox.service";
import { SmsRateLimiter } from "../src/modules/notifications/rate-limiter";
import { NotificationSettingsService } from "../src/modules/notifications/notification-settings.service";
import { GatewayError, MailjetEmailGateway, MramSmsGateway, parseMramResponse } from "../src/modules/notifications/providers";
import { render, smsSegments, syntaxProblem } from "../src/modules/notifications/render";
import { parcelBody, resetDatabase, startApp, userWithRoles, type TestContext } from "./helpers";

/** A fake fetch that records requests and answers with the queued responses. */
function fakeFetch(...answers: { status?: number; body: string }[]) {
  const calls: { url: string; init: RequestInit; json: any }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init, json: JSON.parse(String(init.body)) });
    const a = answers.length > 1 ? answers.shift()! : answers[0];
    return new Response(a.body, { status: a.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const sms = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, to: `+88017100000${i}0`, body: `Message ${i}` }));

describe("notifications: providers and templates (unit)", () => {
  it("sends mram SMS in the documented JSON format, numbers without +", async () => {
    const f = fakeFetch({ body: "SMS SUBMITTED: ID - C20012345" });
    const gw = new MramSmsGateway({ apiKey: "k-test", senderId: "DFAST", baseUrl: "https://sms.example.test/" }, f.fn);
    const results = await gw.sendSms(sms(2));
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe("https://sms.example.test/smsapimany");
    expect(f.calls[0].init.method).toBe("POST");
    expect(f.calls[0].json).toEqual({
      api_key: "k-test",
      senderid: "DFAST",
      messages: [
        { to: "8801710000000", message: "Message 0" },
        { to: "8801710000010", message: "Message 1" },
      ],
    });
    expect(results).toEqual([
      expect.objectContaining({ id: "m0", ok: true, providerMessageId: "C20012345" }),
      expect.objectContaining({ id: "m1", ok: true, providerMessageId: "C20012345" }),
    ]);
  });

  it("batches at most 50 SMS per mram request", async () => {
    const f = fakeFetch({ body: "SMS SUBMITTED: ID - X1" });
    await new MramSmsGateway({ apiKey: "k", senderId: "S", baseUrl: "https://sms.example.test" }, f.fn).sendSms(sms(120).map((m, i) => ({ ...m, id: `m${i}` })));
    expect(f.calls.map(c => c.json.messages.length)).toEqual([50, 50, 20]);
  });

  it("treats temporary mram errors as retryable and permanent ones as final", async () => {
    // Insufficient balance: the whole request is retried later.
    const balance = fakeFetch({ body: "1007" });
    await expect(new MramSmsGateway({ apiKey: "k", senderId: "S", baseUrl: "https://x.test" }, balance.fn).sendSms(sms(1))).rejects.toBeInstanceOf(GatewayError);
    // HTTP errors too.
    const down = fakeFetch({ status: 503, body: "Service unavailable" });
    await expect(new MramSmsGateway({ apiKey: "k", senderId: "S", baseUrl: "https://x.test" }, down.fn).sendSms(sms(1))).rejects.toThrow(/503/);
    // Per-message answers: one invalid number is rejected for good, the other is sent.
    const parsed = parseMramResponse(JSON.stringify([{ response_code: 202, message_id: "A1" }, { response_code: 1012 }]), sms(2));
    expect(parsed[0]).toMatchObject({ ok: true, providerMessageId: "A1" });
    expect(parsed[1]).toMatchObject({ ok: false, permanent: true, error: "1012: Invalid number" });
  });

  it("re-sends a permanently rejected batch one by one to find the bad message", async () => {
    const f = fakeFetch({ body: "1015" }, { body: "SMS SUBMITTED: ID - OK1" }, { body: "1015" });
    const results = await new MramSmsGateway({ apiKey: "k", senderId: "S", baseUrl: "https://x.test" }, f.fn).sendSms(sms(2));
    expect(f.calls.map(c => c.json.messages.length)).toEqual([2, 1, 1]);
    expect(results).toEqual([expect.objectContaining({ id: "m0", ok: true }), expect.objectContaining({ id: "m1", ok: false, permanent: true })]);
  });

  it("sends Mailjet v3.1 requests with Basic auth and handles partial rejections", async () => {
    const f = fakeFetch({
      status: 400,
      body: JSON.stringify({
        Messages: [
          { Status: "success", To: [{ Email: "a@example.com", MessageID: 1152921500000001 }] },
          { Status: "error", Errors: [{ ErrorCode: "mj-0013", ErrorMessage: "Invalid email", StatusCode: 400 }] },
        ],
      }),
    });
    const gw = new MailjetEmailGateway({ apiKey: "pub", apiSecret: "priv", fromEmail: "no-reply@example.com", fromName: "Delivery Fast", baseUrl: "https://mail.example.test" }, f.fn);
    const results = await gw.sendEmail([
      { id: "e1", to: "a@example.com", toName: "A", subject: "Hi", text: "Text", html: "<p>Text</p>" },
      { id: "e2", to: "bad@", subject: "Hi", text: "Text", html: "<p>Text</p>" },
    ]);
    expect(f.calls[0].url).toBe("https://mail.example.test/v3.1/send");
    expect((f.calls[0].init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from("pub:priv").toString("base64")}`);
    expect(f.calls[0].json.Messages[0]).toEqual({
      From: { Email: "no-reply@example.com", Name: "Delivery Fast" },
      To: [{ Email: "a@example.com", Name: "A" }],
      Subject: "Hi",
      TextPart: "Text",
      HTMLPart: "<p>Text</p>",
      CustomID: "e1",
    });
    expect(results[0]).toMatchObject({ ok: true, providerMessageId: "1152921500000001" });
    expect(results[1]).toMatchObject({ ok: false, permanent: true, error: "mj-0013: Invalid email" });

    const unauthorized = fakeFetch({ status: 401, body: JSON.stringify({ ErrorMessage: "API key authentication/authorization failure" }) });
    await expect(new MailjetEmailGateway({ apiKey: "x", apiSecret: "y", fromEmail: "a@b.co", fromName: "X", baseUrl: "https://m.test" }, unauthorized.fn).sendEmail([{ id: "e", to: "a@b.co", subject: "s", text: "t", html: "h" }])).rejects.toThrow(/401/);
  });

  it("renders placeholders and optional sections, and checks syntax", () => {
    const t = "Parcel {{trackingId}}.{{#codAmount}} Keep Tk {{codAmount}} ready.{{/codAmount}} Code {{code}}";
    expect(render(t, { trackingId: "PP-1", codAmount: "1,500", code: "1234" })).toBe("Parcel PP-1. Keep Tk 1,500 ready. Code 1234");
    expect(render(t, { trackingId: "PP-1", codAmount: "", code: "1234" })).toBe("Parcel PP-1. Code 1234");
    expect(render("<b>{{name}}</b>", { name: "<x>" }, s => s.replace(/</g, "&lt;"))).toBe("<b>&lt;x></b>");
    expect(syntaxProblem("{{#a}} open")).toMatch(/never closed/);
    expect(syntaxProblem("{{ok}} {bad}}")).toMatch(/Placeholders/);
    expect(smsSegments("a".repeat(161))).toEqual({ encoding: "GSM-7", length: 161, segments: 2 });
    expect(smsSegments("পার্সেল").encoding).toBe("UCS-2");
  });
});

describe("notifications (e2e)", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await startApp();
  });
  beforeEach(() => resetDatabase(ctx));
  afterAll(() => ctx.app.close());

  const admin = () => userWithRoles(ctx, [{ role: "SUPER_ADMIN" }], "Admin");
  const customer = () => userWithRoles(ctx, [{ role: "CUSTOMER" }], "Customer");
  const bookedSms = () => ctx.prisma.outboxMessage.findMany({ where: { template: "parcel.booked", channel: "SMS" } });

  it("lists events with default templates and variables (super admin only)", async () => {
    const a = await admin();
    const res = await ctx.api("GET", "/notifications/events", { token: a.token });
    expect(res.status).toBe(200);
    const code = res.body.events.find((e: any) => e.event === "parcel.delivery_code");
    expect(code).toMatchObject({ mandatory: true, required: ["code"], channels: { sms: { enabled: true, locked: true, customized: false } } });
    expect(code.vars).toEqual(expect.arrayContaining(["trackingId", "code"]));
    expect(res.body.events.every((e: any) => Object.keys(e.channels).length > 0)).toBe(true);
    const c = await customer();
    expect((await ctx.api("GET", "/notifications/events", { token: c.token })).status).toBe(403);
  });

  it("edits, previews and resets a template; bookings use the edited text", async () => {
    const a = await admin();
    const bad = await ctx.api("PUT", "/notifications/templates/parcel.booked/sms", { token: a.token, body: { body: "Booked {{trackingID}}" } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("INVALID_TEMPLATE");
    const otp = await ctx.api("PUT", "/notifications/templates/auth.otp.login/sms", { token: a.token, body: { body: "Your sign-in code is ready" } });
    expect(otp.body.error.message).toContain("{{code}}");

    const saved = await ctx.api("PUT", "/notifications/templates/parcel.booked/sms", { token: a.token, body: { body: "Booked {{trackingId}} for Tk {{charge}}." } });
    expect(saved.status).toBe(200);
    expect(saved.body.channels.sms).toMatchObject({ customized: true, body: "Booked {{trackingId}} for Tk {{charge}}." });

    const preview = await ctx.api("POST", "/notifications/preview", { token: a.token, body: { event: "parcel.booked", channel: "sms" } });
    expect(preview.body.body).toBe("Booked PP-261016-4821 for Tk 185.");
    expect(preview.body.sms).toMatchObject({ encoding: "GSM-7", segments: 1 });
    const email = await ctx.api("POST", "/notifications/preview", { token: a.token, body: { event: "parcel.booked", channel: "email", vars: { name: "<script>" } } });
    expect(email.body.subject).toBe("Pickup request PP-261016-4821 received");
    expect(email.body.html).toContain("&lt;script&gt;");

    const c = await customer();
    const booked = await ctx.api("POST", "/parcels", { token: c.token, body: parcelBody() });
    expect(booked.status).toBe(201);
    expect((await bookedSms())[0].body).toBe(`Booked ${booked.body.trackingId} for Tk ${booked.body.charges.total}.`);

    const reset = await ctx.api("POST", "/notifications/templates/parcel.booked/sms/reset", { token: a.token });
    expect(reset.body.channels.sms.customized).toBe(false);
    expect(reset.body.channels.sms.body).toContain("Pickup request {{trackingId}} received");
  });

  it("enforces admin on/off switches; security messages can't be switched off", async () => {
    const a = await admin();
    const off = await ctx.api("PUT", "/notifications/templates/parcel.booked/sms", { token: a.token, body: { enabled: false } });
    expect(off.body.channels.sms.enabled).toBe(false);
    const c = await customer();
    await ctx.api("POST", "/parcels", { token: c.token, body: parcelBody() });
    expect(await bookedSms()).toHaveLength(0);

    const locked = await ctx.api("PUT", "/notifications/templates/parcel.delivery_code/sms", { token: a.token, body: { enabled: false } });
    expect(locked.status).toBe(422);
    expect(locked.body.error.code).toBe("NOTIFICATION_LOCKED");
  });

  it("migrates switched-off events from the old platform settings once", async () => {
    await ctx.prisma.setting.create({ data: { key: "platform-config", value: { notifications: [{ name: "Pickup confirmed", enabled: false }, { name: "Delivery OTP", enabled: false }, { name: "Delivery update", enabled: true }] } } });
    const service = ctx.app.get(NotificationSettingsService);
    expect(await service.migrateLegacyToggles()).toBe(2); // pickup_assigned sms + email; the delivery code is mandatory
    expect(await service.migrateLegacyToggles()).toBe(0);
    expect(await ctx.prisma.notificationTemplate.count({ where: { event: "parcel.pickup_assigned", enabled: false } })).toBe(2);
    expect(await ctx.prisma.notificationTemplate.count({ where: { event: "parcel.delivery_code" } })).toBe(0);
  });

  it("lets users opt out of non-security notifications", async () => {
    const c = await customer();
    const prefs = await ctx.api("GET", "/me/notification-preferences", { token: c.token });
    expect(prefs.status).toBe(200);
    const booked = prefs.body.events.find((e: any) => e.event === "parcel.booked");
    expect(booked.channels.sms).toEqual({ enabled: true, locked: false, available: true });
    expect(prefs.body.events.find((e: any) => e.event === "auth.otp.login").channels.sms.locked).toBe(true);
    expect(prefs.body.events.some((e: any) => e.group === "Rider")).toBe(false);

    const locked = await ctx.api("PUT", "/me/notification-preferences", { token: c.token, body: { preferences: [{ event: "auth.otp.login", channel: "sms", enabled: false }] } });
    expect(locked.body.error.code).toBe("NOTIFICATION_LOCKED");

    const saved = await ctx.api("PUT", "/me/notification-preferences", { token: c.token, body: { preferences: [{ event: "parcel.booked", channel: "sms", enabled: false }] } });
    expect(saved.status).toBe(200);
    expect(saved.body.events.find((e: any) => e.event === "parcel.booked").channels.sms.enabled).toBe(false);
    await ctx.api("POST", "/parcels", { token: c.token, body: parcelBody() });
    expect(await bookedSms()).toHaveLength(0);

    await ctx.api("PUT", "/me/notification-preferences", { token: c.token, body: { preferences: [{ event: "parcel.booked", channel: "sms", enabled: true }] } });
    expect(await ctx.prisma.notificationPreference.count()).toBe(0);
  });

  it("rate limits SMS per recipient (waits, caps) and platform-wide; codes skip the per-number limits", async () => {
    const limiter = ctx.app.get(SmsRateLimiter);
    const t0 = Date.UTC(2026, 9, 16, 4, 0, 5);
    const limits = { minIntervalSeconds: 20, perRecipientPerHour: 3, perRecipientPerDay: 4, globalPerMinute: 1000 };
    const n = "+8801711111111";
    expect(await limiter.check(n, false, limits, t0)).toEqual({ action: "send" });
    const wait = await limiter.check(n, false, limits, t0 + 5000);
    expect(wait).toMatchObject({ action: "wait", reason: expect.stringMatching(/spacing/) });
    expect((wait as { waitMs: number }).waitMs).toBe(15_000);
    expect(await limiter.check(n, true, limits, t0 + 6000)).toEqual({ action: "send" }); // a code goes out at once
    expect(await limiter.check(n, false, limits, t0 + 30_000)).toEqual({ action: "send" }); // 3rd this hour
    const hourly = await limiter.check(n, false, limits, t0 + 60_000);
    expect(hourly).toMatchObject({ action: "wait", reason: expect.stringMatching(/hourly/) });
    expect((hourly as { waitMs: number }).waitMs).toBeGreaterThan(3_000_000);
    // Next hour: 4th of the day is fine, the 5th is over the daily cap and dropped.
    expect(await limiter.check(n, false, limits, t0 + 3_600_000)).toEqual({ action: "send" });
    expect(await limiter.check(n, false, limits, t0 + 3_700_000)).toMatchObject({ action: "drop", reason: expect.stringMatching(/daily/) });

    const tight = { minIntervalSeconds: 0, perRecipientPerHour: 100, perRecipientPerDay: 100, globalPerMinute: 2 };
    const t1 = Date.UTC(2026, 9, 16, 6, 0, 1);
    expect(await limiter.check("+8801722222221", false, tight, t1)).toEqual({ action: "send" });
    expect(await limiter.check("+8801722222222", false, tight, t1)).toEqual({ action: "send" });
    expect(await limiter.check("+8801722222223", true, tight, t1)).toMatchObject({ action: "wait", reason: expect.stringMatching(/throughput/) });
  });

  it("delivers due SMS and reschedules rate-limited ones instead of dropping them", async () => {
    const outbox = ctx.app.get(OutboxService);
    const to = "+8801733333333";
    const a = await outbox.queue(ctx.prisma, { channel: "SMS", to, template: "parcel.booked", body: "first" });
    const b = await outbox.queue(ctx.prisma, { channel: "SMS", to, template: "parcel.picked_up", body: "second" });
    const code1 = await outbox.queue(ctx.prisma, { channel: "SMS", to, template: "parcel.delivery_code", body: "code 1111" });
    const failed = await outbox.deliverBatch([a, b, code1]);
    expect(failed.size).toBe(0);
    const rows = await ctx.prisma.outboxMessage.findMany({ where: { to } });
    const byBody = Object.fromEntries(rows.map(r => [r.body, r]));
    expect(byBody.first).toMatchObject({ state: "SENT", provider: "log", attempts: 1 });
    expect(byBody["code 1111"]).toMatchObject({ state: "SENT" });
    expect(byBody.second).toMatchObject({ state: "PENDING", attempts: 0 });
    expect(byBody.second.notBefore!.getTime()).toBeGreaterThan(Date.now() + 10_000);
  });

  it("stores gateway secrets encrypted, shows them masked, and test-sends through the gateway", async () => {
    const received: { url: string; headers: http.IncomingHttpHeaders; body: any }[] = [];
    const server = http.createServer((req, res) => {
      let data = "";
      req.on("data", c => (data += c));
      req.on("end", () => {
        received.push({ url: req.url!, headers: req.headers, body: JSON.parse(data) });
        if (req.url === "/v3.1/send") {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ Messages: [{ Status: "success", To: [{ Email: "ops@example.com", MessageID: 42 }] }] }));
        } else res.end("SMS SUBMITTED: ID - TEST123");
      });
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const a = await admin();
      const apiKey = "sk-test-0123456789-ABCD";
      const notReady = await ctx.api("PUT", "/notifications/gateways/sms", { token: a.token, body: { enabled: true, senderId: "DFAST" } });
      expect(notReady.body.error.code).toBe("GATEWAY_NOT_CONFIGURED");

      const saved = await ctx.api("PUT", "/notifications/gateways/sms", { token: a.token, body: { apiKey, senderId: "DFAST", baseUrl, enabled: true } });
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({ channel: "SMS", provider: "mram", configured: true, enabled: true, mode: "log", settings: { senderId: "DFAST", apiKey: "••••••••ABCD" } });
      expect(JSON.stringify(saved.body)).not.toContain(apiKey);
      const row = await ctx.prisma.notificationGateway.findUniqueOrThrow({ where: { channel: "SMS" } });
      expect(row.secretsEncrypted).not.toContain(apiKey);
      expect(JSON.stringify(row.config)).not.toContain(apiKey);
      expect(JSON.parse(decrypt(row.secretsEncrypted!))).toEqual({ apiKey });
      const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: "notification_gateway.update" } });
      expect(JSON.stringify(audit)).not.toContain(apiKey);

      // Changing other fields keeps the stored key.
      await ctx.api("PUT", "/notifications/gateways/sms", { token: a.token, body: { senderId: "DFAST2" } });
      const kept = await ctx.prisma.notificationGateway.findUniqueOrThrow({ where: { channel: "SMS" } });
      expect(JSON.parse(decrypt(kept.secretsEncrypted!))).toEqual({ apiKey });

      const test = await ctx.api("POST", "/notifications/gateways/sms/test", { token: a.token, body: { phone: "01712345678" } });
      expect(test.body).toMatchObject({ ok: true, providerMessageId: "TEST123" });
      expect(received[0].url).toBe("/smsapimany");
      expect(received[0].body).toMatchObject({ api_key: apiKey, senderid: "DFAST2", messages: [{ to: "8801712345678" }] });

      await ctx.api("PUT", "/notifications/gateways/email", { token: a.token, body: { apiKey: "mj-public", apiSecret: "mj-secret-WXYZ", fromEmail: "no-reply@example.com", fromName: "Delivery Fast", baseUrl } });
      const emailTest = await ctx.api("POST", "/notifications/gateways/email/test", { token: a.token, body: { email: "ops@example.com" } });
      expect(emailTest.body).toMatchObject({ ok: true, providerMessageId: "42" });
      expect(received[1].headers.authorization).toBe(`Basic ${Buffer.from("mj-public:mj-secret-WXYZ").toString("base64")}`);
      expect(received[1].body.Messages[0]).toMatchObject({ From: { Email: "no-reply@example.com" }, To: [{ Email: "ops@example.com" }] });

      const status = await ctx.api("GET", "/notifications/gateways", { token: a.token });
      const emailCard = status.body.find((g: any) => g.channel === "EMAIL");
      expect(emailCard.settings).toMatchObject({ apiKey: "••••••••blic", apiSecret: "••••••••WXYZ" });
      expect(emailCard.lastSuccessAt).not.toBeNull();
      expect(status.body.find((g: any) => g.channel === "SMS").warning).toMatch(/Development/);

      // Normal traffic in development is only logged, even with the gateway enabled.
      const outbox = ctx.app.get(OutboxService);
      const id = await outbox.queue(ctx.prisma, { channel: "SMS", to: "+8801744444444", template: "parcel.booked", body: "hello" });
      await outbox.deliverBatch([id]);
      expect(received).toHaveLength(2);
      expect((await ctx.prisma.outboxMessage.findUniqueOrThrow({ where: { id } })).provider).toBe("log");
    } finally {
      server.close();
    }
  });

  it("sends OTP through templates with configurable cooldown and retry-after", async () => {
    const a = await admin();
    const current = (await ctx.api("GET", "/notifications/settings", { token: a.token })).body;
    const limits = { ...current.limits, otp: { ...current.limits.otp, cooldownSeconds: 45 } };
    const badDaily = await ctx.api("PUT", "/notifications/settings", { token: a.token, body: { limits: { ...limits, sms: { ...limits.sms, perRecipientPerHour: 10, perRecipientPerDay: 5 } } } });
    expect(badDaily.status).toBe(422);
    expect((await ctx.api("PUT", "/notifications/settings", { token: a.token, body: { limits } })).status).toBe(200);

    const first = await ctx.api("POST", "/auth/otp", { body: { phone: "01755555555", purpose: "SIGNUP" } });
    expect(first.status).toBe(200);
    expect(first.body.resendAfterSeconds).toBe(45);
    const sent = await ctx.prisma.outboxMessage.findFirstOrThrow({ where: { template: "auth.otp.signup" } });
    expect(sent.to).toBe("+8801755555555");
    expect(sent.body).toContain(first.body.devCode);

    const again = await ctx.api("POST", "/auth/otp", { body: { phone: "01755555555", purpose: "SIGNUP" } });
    expect(again.status).toBe(429);
    expect(again.body.error.details.retryAfterSeconds).toBeGreaterThan(40);
    expect(again.body.error.details.retryAfterSeconds).toBeLessThanOrEqual(45);
    expect(Number(again.headers["retry-after"])).toBe(again.body.error.details.retryAfterSeconds);
  });
});
