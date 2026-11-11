import { HttpStatus, Injectable } from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { AppError } from "../../common/errors";
import type { Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { env } from "../../config/env";

/** The Android apps (mobile/*): the name each sends in X-App and its download on the website (public/downloads). */
export const MOBILE_APP_KEYS = ["operations", "rider", "merchant"] as const;
export type MobileAppKey = (typeof MOBILE_APP_KEYS)[number];

const KEY = "app.min-versions";
const version = z
  .string()
  .trim()
  .regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/, "Use a version like 1.4.0")
  .nullable();
export const appMinVersionsSchema = z.object({ operations: version.optional(), rider: version.optional(), merchant: version.optional() });
export type AppMinVersions = Record<MobileAppKey, string | null>;

/** "1.10.0" > "1.9.3". */
export function compareVersions(a: string, b: string) {
  const pa = a.split(/[.+]/).map(n => Number.parseInt(n, 10) || 0);
  const pb = b.split(/[.+]/).map(n => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

export const downloadUrl = (app: MobileAppKey) => `${env().APP_URL.replace(/\/+$/, "")}/downloads/${app}.apk`;

/**
 * Forced app updates: the lowest version of each Android app that may still use the API (super admin › Mobile apps).
 * Apps send X-App and X-App-Version (from Operations 1.4.0, Rider 1.5.1, Merchant 1.4.2); an older one is refused with
 * APP_UPDATE_REQUIRED (426) and the download link, and the app shows its update page. Apps that send no version (the
 * ones installed before this) are let through.
 */
@Injectable()
export class AppVersionsService {
  private cache: { at: number; value: AppMinVersions } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(): Promise<AppMinVersions> {
    if (this.cache && Date.now() - this.cache.at < 30_000) return this.cache.value;
    const row = await this.prisma.setting.findUnique({ where: { key: KEY } });
    const stored = (row?.value ?? {}) as Partial<AppMinVersions>;
    const value = Object.fromEntries(MOBILE_APP_KEYS.map(k => [k, typeof stored[k] === "string" ? stored[k] : null])) as AppMinVersions;
    this.cache = { at: Date.now(), value };
    return value;
  }

  async view() {
    const min = await this.get();
    return MOBILE_APP_KEYS.map(app => ({ app, minVersion: min[app], downloadUrl: downloadUrl(app) }));
  }

  async set(actor: Actor, input: z.infer<typeof appMinVersionsSchema>, meta: RequestMeta) {
    const before = await this.get();
    const next: AppMinVersions = { ...before };
    for (const k of MOBILE_APP_KEYS) if (input[k] !== undefined) next[k] = input[k] || null;
    await this.prisma.$transaction(async tx => {
      await tx.setting.upsert({ where: { key: KEY }, create: { key: KEY, value: next }, update: { value: next } });
      await this.audit.record(actor, { action: "app.min_versions", entityType: "setting", entityId: KEY, data: { before, after: next } }, meta, tx);
    });
    this.cache = null;
    return this.view();
  }

  /** Throws APP_UPDATE_REQUIRED when the calling app is older than its minimum. */
  async check(app: string | undefined, appVersion: string | undefined) {
    if (!app || !appVersion || !(MOBILE_APP_KEYS as readonly string[]).includes(app)) return;
    const min = (await this.get())[app as MobileAppKey];
    if (!min || compareVersions(appVersion, min) >= 0) return;
    const url = downloadUrl(app as MobileAppKey);
    throw new AppError("APP_UPDATE_REQUIRED", `This app (${appVersion}) is out of date. Install the new version (${min} or later): ${url}`, 426 as HttpStatus, {
      app,
      version: appVersion,
      minVersion: min,
      downloadUrl: url,
    });
  }
}
