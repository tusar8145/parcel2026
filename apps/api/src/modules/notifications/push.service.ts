import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { AppError } from "../../common/errors";
import { decrypt, encrypt } from "../../common/crypto";
import type { Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { env } from "../../config/env";
import { merchantHasService } from "../packages/package-resolver";

const FCM_TIMEOUT_MS = 10_000;
const PARALLEL = 8;

/** POST /me/push-devices: the phone's Firebase token, sent by the app after sign-in (and when it changes). */
export const registerDeviceSchema = z.object({
  token: z.string().trim().min(20).max(4096),
  app: z.enum(["merchant", "rider"]),
  platform: z.enum(["android", "ios"]).default("android"),
});
export const removeDeviceSchema = z.object({ token: z.string().trim().min(20).max(4096) });

/** Super admin: the service account JSON as downloaded from Firebase (write-only) and the on/off switch. */
export const pushGatewaySchema = z.object({
  enabled: z.boolean().optional(),
  serviceAccount: z.string().trim().max(10_000).optional(),
});

interface Account {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

export interface PushMessage {
  title: string;
  body?: string | null;
  /** String values only (FCM data): link, type, notificationId… */
  data?: Record<string, string>;
}

export interface PushResult {
  devices: number;
  delivered: number;
  failed: number;
}

/** Parses a Firebase service account file ({ project_id, client_email, private_key }). */
export function parseServiceAccount(json: string): Account {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new AppError("INVALID_SERVICE_ACCOUNT", "Paste the whole service account file (JSON) downloaded from Firebase", 422);
  }
  const projectId = typeof j.project_id === "string" ? j.project_id : "";
  const clientEmail = typeof j.client_email === "string" ? j.client_email : "";
  const privateKey = typeof j.private_key === "string" ? j.private_key : "";
  if (j.type !== "service_account" || !projectId || !clientEmail || !privateKey.includes("PRIVATE KEY"))
    throw new AppError("INVALID_SERVICE_ACCOUNT", "This isn't a Firebase service account file (Project settings › Service accounts › Generate new private key)", 422);
  return { projectId, clientEmail, privateKey };
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString("base64url");

/**
 * Push notifications through Firebase Cloud Messaging (HTTP v1) to the phones of the merchant and rider
 * apps. The service account comes from super admin (stored encrypted), or in development from
 * FIREBASE_SERVICE_ACCOUNT_FILE. Tokens Firebase no longer knows are removed. Without an account, nothing
 * is sent (in-app notifications still work).
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger("Push");
  private token: { value: string; until: number; key: string } | null = null;
  private cached: { at: number; account: Account | null; source: "settings" | "file" | null } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ───────────── devices ─────────────

  /** The signed-in user's phone: a token moves to the new user when someone else signs in on that phone. */
  async register(userId: string, input: z.infer<typeof registerDeviceSchema>) {
    await this.prisma.pushDevice.upsert({
      where: { token: input.token },
      create: { userId, token: input.token, app: input.app, platform: input.platform },
      update: { userId, app: input.app, platform: input.platform, lastSeenAt: new Date() },
    });
    return { registered: true };
  }

  async remove(userId: string, token: string) {
    const { count } = await this.prisma.pushDevice.deleteMany({ where: { token, userId } });
    return { removed: count };
  }

  // ───────────── settings ─────────────

  private async account(): Promise<{ account: Account | null; source: "settings" | "file" | null }> {
    if (this.cached && Date.now() - this.cached.at < 30_000) return this.cached;
    let result: { account: Account | null; source: "settings" | "file" | null } = { account: null, source: null };
    const row = await this.prisma.pushGateway.findUnique({ where: { id: "fcm" } });
    if (row?.enabled && row.projectId && row.clientEmail && row.privateKeyEncrypted) {
      try {
        result = { account: { projectId: row.projectId, clientEmail: row.clientEmail, privateKey: decrypt(row.privateKeyEncrypted) }, source: "settings" };
      } catch (err) {
        this.logger.error({ err }, "The stored Firebase key can't be decrypted (ENCRYPTION_KEY changed?)");
      }
    }
    const file = env().FIREBASE_SERVICE_ACCOUNT_FILE;
    if (!result.account && file && !row?.enabled) {
      try {
        result = { account: parseServiceAccount(readFileSync(file, "utf8")), source: "file" };
      } catch (err) {
        this.logger.warn({ err }, `FIREBASE_SERVICE_ACCOUNT_FILE (${file}) can't be read`);
      }
    }
    this.cached = { at: Date.now(), ...result };
    return result;
  }

  /** Super admin status card: configured, on/off, project, health, phones registered. */
  async status() {
    const [row, devices, byApp] = await Promise.all([
      this.prisma.pushGateway.findUnique({ where: { id: "fcm" } }),
      this.prisma.pushDevice.count(),
      this.prisma.pushDevice.groupBy({ by: ["app"], _count: { _all: true } }),
    ]);
    const { source } = await this.account();
    return {
      provider: "firebase",
      configured: !!row?.privateKeyEncrypted,
      enabled: !!row?.enabled,
      projectId: row?.projectId ?? null,
      clientEmail: row?.clientEmail ?? null,
      active: source !== null,
      source,
      lastSuccessAt: row?.lastSuccessAt ?? null,
      lastErrorAt: row?.lastErrorAt ?? null,
      lastError: row?.lastError ?? null,
      devices,
      devicesByApp: Object.fromEntries(byApp.map(g => [g.app, g._count._all])),
    };
  }

  async save(actor: Actor, input: z.infer<typeof pushGatewaySchema>, meta: RequestMeta) {
    const account = input.serviceAccount ? parseServiceAccount(input.serviceAccount) : null;
    await this.prisma.$transaction(async tx => {
      const row = await tx.pushGateway.findUnique({ where: { id: "fcm" } });
      if (input.enabled && !account && !row?.privateKeyEncrypted) throw new AppError("GATEWAY_NOT_CONFIGURED", "Add the Firebase service account file first", 422);
      const data = {
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(account ? { projectId: account.projectId, clientEmail: account.clientEmail, privateKeyEncrypted: encrypt(account.privateKey), lastError: null, lastErrorAt: null } : {}),
        updatedById: "userId" in actor ? actor.userId : null,
      };
      await tx.pushGateway.upsert({ where: { id: "fcm" }, create: { id: "fcm", ...data }, update: data });
      await this.audit.record(
        actor,
        { action: "push_gateway.update", entityType: "push_gateway", entityId: "fcm", data: { enabled: input.enabled, keyReplaced: !!account, projectId: account?.projectId } },
        meta,
        tx,
      );
    });
    this.cached = null;
    this.token = null;
    return this.status();
  }

  // ───────────── sending ─────────────

  /** An OAuth access token for FCM from the service account (a signed JWT), kept until shortly before it expires. */
  private async accessToken(a: Account): Promise<string> {
    const key = `${a.projectId}:${a.clientEmail}`;
    if (this.token && this.token.key === key && Date.now() < this.token.until) return this.token.value;
    const now = Math.floor(Date.now() / 1000);
    const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(JSON.stringify({ iss: a.clientEmail, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
    const signature = createSign("RSA-SHA256").update(`${head}.${claims}`).sign(a.privateKey).toString("base64url");
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claims}.${signature}` }),
      signal: AbortSignal.timeout(FCM_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!res.ok || !body.access_token) throw new Error(`Firebase sign-in failed: ${body.error_description ?? res.status}`);
    this.token = { value: body.access_token, until: Date.now() + ((body.expires_in ?? 3600) - 120) * 1000, key };
    return body.access_token;
  }

  /**
   * Who may get pushes: merchant users only when their merchant's service plan has "Firebase push
   * notifications" (integration.push, Service plans & pricing); riders and everyone else always.
   */
  private async allowed(userIds: string[]): Promise<string[]> {
    const roles = await this.prisma.userRole.findMany({ where: { userId: { in: userIds } }, select: { userId: true, role: true, merchantId: true } });
    const merchantOf = new Map<string, string[]>();
    const other = new Set<string>();
    for (const r of roles) {
      if ((r.role === "MERCHANT_OWNER" || r.role === "MERCHANT_STAFF") && r.merchantId) merchantOf.set(r.userId, [...(merchantOf.get(r.userId) ?? []), r.merchantId]);
      else other.add(r.userId);
    }
    const plan = new Map<string, boolean>();
    const out: string[] = [];
    for (const id of userIds) {
      const merchants = merchantOf.get(id);
      if (!merchants || other.has(id)) {
        out.push(id);
        continue;
      }
      for (const m of merchants) {
        if (!plan.has(m)) plan.set(m, await merchantHasService(this.prisma, m, "integration.push"));
        if (plan.get(m)) {
          out.push(id);
          break;
        }
      }
    }
    return out;
  }

  /** Sends to every phone of the users. Never throws: failures are logged and recorded on the gateway. */
  async toUsers(userIds: string[], message: PushMessage): Promise<PushResult> {
    const ids = await this.allowed([...new Set(userIds)]);
    if (!ids.length) return { devices: 0, delivered: 0, failed: 0 };
    const { account } = await this.account();
    if (!account) return { devices: 0, delivered: 0, failed: 0 };
    const devices = await this.prisma.pushDevice.findMany({ where: { userId: { in: ids } }, select: { id: true, token: true } });
    if (!devices.length) return { devices: 0, delivered: 0, failed: 0 };
    let access: string;
    try {
      access = await this.accessToken(account);
    } catch (err) {
      await this.outcome(false, (err as Error).message);
      this.logger.warn({ err }, "Push: Firebase sign-in failed");
      return { devices: devices.length, delivered: 0, failed: devices.length };
    }
    let delivered = 0;
    let failed = 0;
    const gone: string[] = [];
    let lastError = "";
    const queue = [...devices];
    const worker = async () => {
      for (let d = queue.shift(); d; d = queue.shift()) {
        const r = await this.sendOne(account.projectId, access, d.token, message);
        if (r.ok) delivered++;
        else {
          failed++;
          lastError = r.error;
          if (r.gone) gone.push(d.id);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, devices.length) }, worker));
    if (gone.length) await this.prisma.pushDevice.deleteMany({ where: { id: { in: gone } } });
    // A token that no longer exists isn't a gateway problem; anything else is shown on the status card.
    if (delivered || failed > gone.length) await this.outcome(failed <= gone.length, lastError);
    return { devices: devices.length, delivered, failed };
  }

  private async sendOne(projectId: string, access: string, token: string, m: PushMessage): Promise<{ ok: true } | { ok: false; gone: boolean; error: string }> {
    try {
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`, {
        method: "POST",
        headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
        body: JSON.stringify({
          message: {
            token,
            notification: { title: m.title.slice(0, 160), ...(m.body ? { body: m.body.slice(0, 500) } : {}) },
            data: m.data ?? {},
            android: { priority: "HIGH", notification: { channel_id: "deliveryfast", icon: "ic_stat_notify", color: "#2F55C9", default_sound: true } },
          },
        }),
        signal: AbortSignal.timeout(FCM_TIMEOUT_MS),
      });
      if (res.ok) return { ok: true };
      const body = (await res.json().catch(() => ({}))) as { error?: { status?: string; message?: string; details?: { errorCode?: string }[] } };
      const code = body.error?.details?.find(d => d.errorCode)?.errorCode ?? body.error?.status ?? `${res.status}`;
      // UNREGISTERED: the app was removed or the token replaced; INVALID_ARGUMENT on a token: never valid.
      const gone = code === "UNREGISTERED" || (code === "INVALID_ARGUMENT" && /token/i.test(body.error?.message ?? "")) || res.status === 404;
      return { ok: false, gone, error: `${code}: ${body.error?.message ?? res.statusText}` };
    } catch (err) {
      return { ok: false, gone: false, error: (err as Error).message };
    }
  }

  private async outcome(ok: boolean, error: string) {
    try {
      await this.prisma.pushGateway.upsert({
        where: { id: "fcm" },
        create: { id: "fcm", ...(ok ? { lastSuccessAt: new Date() } : { lastErrorAt: new Date(), lastError: error.slice(0, 500) }) },
        update: ok ? { lastSuccessAt: new Date() } : { lastErrorAt: new Date(), lastError: error.slice(0, 500) },
      });
    } catch {
      // Health is best-effort.
    }
  }
}
