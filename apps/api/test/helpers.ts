import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { createApp } from "../src/app.factory";
import { PrismaService } from "../src/common/prisma.service";
import { RedisService } from "../src/common/redis.service";
import { hashPassword } from "../src/common/crypto";
import type { Role } from "../src/generated/prisma/client";
import { authenticator } from "otplib";

export const PASSWORD = "TestPassword123";

export interface TestContext {
  app: NestFastifyApplication;
  prisma: PrismaService;
  api: (method: string, url: string, opts?: { token?: string; body?: unknown; headers?: Record<string, string> }) => Promise<{ status: number; body: any; headers: Record<string, unknown> }>;
}

export async function startApp(): Promise<TestContext> {
  const app = await createApp({ logger: process.env.TEST_LOGS === "1" });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const prisma = app.get(PrismaService);
  const api: TestContext["api"] = async (method, url, opts = {}) => {
    const res = await app.inject({
      method: method as "GET",
      url: `/api/v1${url}`,
      payload: opts.body as object | undefined,
      headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...opts.headers },
    });
    return { status: res.statusCode, body: res.body ? safeJson(res.body) : undefined, headers: res.headers };
  };
  return { app, prisma, api };
}

const safeJson = (s: string) => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

/** Empties every table (keeps the schema and migrations). */
export async function resetDatabase(ctx: TestContext) {
  const tables = await ctx.prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await ctx.prisma.$executeRawUnsafe(`TRUNCATE ${tables.map(t => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await ctx.app.get(RedisService).flushdb();
}

let phoneSeq = 0;
/** A unique valid BD mobile number per call. */
export const nextPhone = () => `+88017${String(Date.now() % 1_000_000).padStart(6, "0")}${String(phoneSeq++ % 100).padStart(2, "0")}`.slice(0, 14);

/** Creates a user directly in the database with the given roles, then signs in. */
export async function userWithRoles(ctx: TestContext, roles: { role: Role; merchantId?: string; hubId?: string }[], name = "Test User") {
  const phone = nextPhone();
  const user = await ctx.prisma.user.create({
    data: { name, phone, passwordHash: await hashPassword(PASSWORD), phoneVerifiedAt: new Date(), roles: { create: roles } },
  });
  let login = await ctx.api("POST", "/auth/login", { body: { identifier: phone, password: PASSWORD } });
  if (login.status !== 200) throw new Error(`login failed: ${JSON.stringify(login.body)}`);
  // Roles that require two-step verification (super admins) enrol on first sign-in.
  let mfaSecret: string | undefined;
  if (login.body.mfaSetupRequired) {
    const setup = await ctx.api("POST", "/auth/mfa/setup", { body: { mfaToken: login.body.mfaToken } });
    mfaSecret = setup.body.secret as string;
    login = await ctx.api("POST", "/auth/mfa/enable", { body: { mfaToken: login.body.mfaToken, code: authenticator.generate(mfaSecret) } });
    if (login.status !== 200) throw new Error(`MFA enrolment failed: ${JSON.stringify(login.body)}`);
  }
  return { user, token: login.body.accessToken as string, refreshToken: login.body.refreshToken as string, phone, mfaSecret, recoveryCodes: login.body.recoveryCodes as string[] | undefined };
}

export async function riderUser(ctx: TestContext, code: string, hubId?: string) {
  const r = await userWithRoles(ctx, [{ role: "RIDER" }], `Rider ${code}`);
  const rider = await ctx.prisma.rider.create({ data: { userId: r.user.id, code, hubId } });
  // Sign in again so the token carries the rider id.
  const login = await ctx.api("POST", "/auth/login", { body: { identifier: r.phone, password: PASSWORD } });
  return { ...r, rider, token: login.body.accessToken as string };
}

export const hub = (ctx: TestContext, code = "HUB-T1") =>
  ctx.prisma.hub.create({ data: { code, name: `Test Hub ${code}`, district: "Dhaka North", address: "Test road" } });

export const parcelBody = (overrides: Record<string, unknown> = {}) => ({
  sender: { name: "Rahim Uddin", phone: "01711000000" },
  pickup: { category: "Home", street: "House 5 Road 2", zone: "Gulshan", district: "Dhaka North" },
  recipient: { name: "Nabila Ahmed", phone: "01812000000" },
  delivery: { category: "Office", street: "Road 7 Flat 3B", area: "Dhanmondi Road 7", zone: "Dhanmondi", district: "Dhaka Central" },
  serviceLevel: "Same day",
  weightKg: 2,
  packaging: "Small carton",
  contents: "Clothing",
  codAmount: 1500,
  ...overrides,
});

let directHubs = 0;
/**
 * "Collect & deliver now" needs the hub the pickup belongs to to also deliver the parcel (rider-tasks.service.ts
 * directDeliveryAllowed): the parcel's pickup hub becomes the hub serving its delivery zone (made when missing).
 */
export async function sameHubDelivery(ctx: TestContext, trackingId: string) {
  const p = await ctx.prisma.parcel.findUniqueOrThrow({ where: { trackingId }, select: { id: true, deliveryDistrict: true, deliveryZone: true, pickupHubId: true, pickupRider: { select: { hubId: true } } } });
  const district = p.deliveryDistrict ?? "Dhaka Central";
  const name = p.deliveryZone ?? "Dhanmondi";
  const zone = await ctx.prisma.deliveryZone.findFirst({ where: { district: { equals: district, mode: "insensitive" }, name: { equals: name, mode: "insensitive" }, active: true } });
  let hubId = zone?.hubId ?? p.pickupHubId ?? p.pickupRider?.hubId ?? null;
  if (!hubId) hubId = (await hub(ctx, `HUB-DD${++directHubs}`)).id;
  if (!zone) await ctx.prisma.deliveryZone.create({ data: { code: `DD-${++directHubs}-${Date.now() % 100000}`, name, district, hubId } });
  else if (!zone.hubId) await ctx.prisma.deliveryZone.update({ where: { id: zone.id }, data: { hubId } });
  await ctx.prisma.parcel.update({ where: { id: p.id }, data: { pickupHubId: hubId } });
}
