import { Injectable } from "@nestjs/common";
import type { Prisma } from "../../generated/prisma/client";
import type { Db } from "../../common/prisma.service";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import type { Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { locationSettingsSchema, type LocationSettings } from "./tracking.schemas";

export const LOCATION_SETTINGS_KEY = "location-settings";

/**
 * Defaults: a position every 5 minutes while on shift (the owner asked for "every 5 / 10 minutes"),
 * and at once after a move of 50 m. The super admin changes them in Settings → "Rider location".
 */
export const DEFAULT_LOCATION_SETTINGS: LocationSettings = { intervalMinutes: 5, movementMeters: 50 };

/** A rider's or vehicle's position older than this is shown as stale (3 missed updates, at least 15 minutes). */
export const staleAfterMinutes = (s: LocationSettings) => Math.max(15, s.intervalMinutes * 3);

/** The stored settings (defaults for anything missing or invalid). */
export async function readLocationSettings(db: Db): Promise<LocationSettings> {
  const row = await db.setting.findUnique({ where: { key: LOCATION_SETTINGS_KEY } });
  const parsed = locationSettingsSchema.partial().safeParse(row?.value ?? {});
  return { ...DEFAULT_LOCATION_SETTINGS, ...(parsed.success ? parsed.data : {}) };
}

@Injectable()
export class LocationSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get() {
    const settings = await readLocationSettings(this.prisma);
    return { ...settings, staleAfterMinutes: staleAfterMinutes(settings), defaults: DEFAULT_LOCATION_SETTINGS };
  }

  async save(actor: Actor, input: LocationSettings, meta: RequestMeta) {
    await this.prisma.$transaction(async tx => {
      const before = await readLocationSettings(tx);
      const value = { intervalMinutes: input.intervalMinutes, movementMeters: input.movementMeters } satisfies Prisma.InputJsonObject;
      await tx.setting.upsert({ where: { key: LOCATION_SETTINGS_KEY }, create: { key: LOCATION_SETTINGS_KEY, value }, update: { value } });
      await this.audit.record(actor, { action: "location_settings.update", entityType: "setting", entityId: LOCATION_SETTINGS_KEY, data: { before, after: value } }, meta, tx);
    });
    return this.get();
  }
}
