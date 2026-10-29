import { HttpStatus, Injectable } from "@nestjs/common";
import { pickupSlotConfigSchema, type PickupSlotConfig } from "@paira-express/shared";
import type { z } from "zod";
import type { pickupSlotsQuerySchema } from "@paira-express/shared";
import { PrismaService, type Db } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import type { Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { AppError } from "../../common/errors";

const SETTING_KEY = "pickup_slots";
const DHAKA_OFFSET_MS = 6 * 3600_000; // Asia/Dhaka, no daylight saving
const DAY_MS = 86_400_000;

export interface PickupSlot {
  start: string; // ISO (UTC)
  end: string;
  label: string; // "9:00 AM – 12:00 PM"
  available: boolean;
  /** Places left when the window has a capacity; null = no limit. */
  remaining: number | null;
}

export interface PickupDay {
  date: string; // YYYY-MM-DD (Dhaka)
  label: string; // "Today", "Tomorrow", "Sat, 17 Oct"
  closed: boolean;
  slots: PickupSlot[];
}

/** YYYY-MM-DD for a moment, in Dhaka. */
export const dhakaDate = (at: Date) => new Date(at.getTime() + DHAKA_OFFSET_MS).toISOString().slice(0, 10);

/** A Dhaka wall-clock time on a Dhaka date, as a UTC Date. */
function dhakaTime(date: string, clock: string) {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = clock.split(":").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - DHAKA_OFFSET_MS);
}

const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

function clockLabel(clock: string) {
  const [hh, mm] = clock.split(":").map(Number);
  return `${hh % 12 || 12}:${String(mm).padStart(2, "0")} ${hh < 12 ? "AM" : "PM"}`;
}

function dayLabel(date: string, today: string) {
  if (date === today) return "Today";
  if (date === addDays(today, 1)) return "Tomorrow";
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

/**
 * Pickup time windows customers can choose when booking on the website. Windows per
 * weekday, closed days, booking lead time and optional capacity are configured by super
 * admins (`PUT /pickup-slots/config`, stored in settings).
 */
@Injectable()
export class PickupSlotsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async config(db: Db = this.prisma): Promise<PickupSlotConfig> {
    const row = await db.setting.findUnique({ where: { key: SETTING_KEY } });
    const parsed = pickupSlotConfigSchema.safeParse(row?.value ?? {});
    return parsed.success ? parsed.data : pickupSlotConfigSchema.parse({});
  }

  async saveConfig(actor: Actor, input: PickupSlotConfig, meta: RequestMeta) {
    const value = pickupSlotConfigSchema.parse(input);
    await this.prisma.$transaction(async tx => {
      await tx.setting.upsert({ where: { key: SETTING_KEY }, create: { key: SETTING_KEY, value }, update: { value } });
      await this.audit.record(actor, { action: "settings.pickup_slots", entityType: "setting", entityId: SETTING_KEY }, meta, tx);
    });
    return value;
  }

  /** Bookable days (or one day) with their windows and remaining capacity. */
  async list(query: z.infer<typeof pickupSlotsQuerySchema>, now = new Date()) {
    const config = await this.config();
    const today = dhakaDate(now);
    const last = addDays(today, config.daysAhead - 1);
    const dates = query.date ? [query.date] : Array.from({ length: config.daysAhead }, (_, i) => addDays(today, i));
    const days: PickupDay[] = [];
    for (const date of dates) {
      const outOfRange = date < today || date > last;
      const closed = outOfRange || config.closedWeekdays.includes(weekdayOf(date));
      const windows = closed ? [] : this.windowsFor(config, date);
      const booked = await this.bookedCounts(windows.filter(w => w.capacity !== null).map(w => w.start), query.district);
      days.push({
        date,
        label: dayLabel(date, today),
        closed,
        slots: windows.map(w => {
          const remaining = w.capacity === null ? null : Math.max(0, w.capacity - (booked.get(w.start.getTime()) ?? 0));
          const tooSoon = w.start.getTime() - now.getTime() < config.leadMinutes * 60_000;
          return {
            start: w.start.toISOString(),
            end: w.end.toISOString(),
            label: w.label,
            available: !tooSoon && (remaining === null || remaining > 0),
            remaining,
          };
        }),
      });
    }
    return { timezone: "Asia/Dhaka", leadMinutes: config.leadMinutes, days };
  }

  /**
   * Checks a requested window. Strict (website bookings): it must be one of the offered
   * windows, far enough ahead, and have capacity left — checked under a lock so two
   * bookings can't take the last place. Otherwise only basic sanity checks apply.
   */
  async assertBookable(db: Db, window: { start: Date; end: Date }, opts: { strict: boolean; district?: string }, now = new Date()) {
    const fail = (message: string) =>
      new AppError("PICKUP_SLOT_UNAVAILABLE", message, HttpStatus.CONFLICT, [{ path: "pickupWindow", message }]);
    if (!opts.strict) {
      if (window.end.getTime() < now.getTime() - DAY_MS) throw fail("The pickup window is in the past");
      return;
    }
    const config = await this.config(db);
    const date = dhakaDate(window.start);
    const today = dhakaDate(now);
    if (date < today || date > addDays(today, config.daysAhead - 1)) throw fail(`Choose a pickup time within the next ${config.daysAhead} days`);
    if (config.closedWeekdays.includes(weekdayOf(date))) throw fail("We don't collect parcels on that day. Choose another day.");
    const slot = this.windowsFor(config, date).find(w => w.start.getTime() === window.start.getTime() && w.end.getTime() === window.end.getTime());
    if (!slot) throw fail("Choose one of the offered pickup times");
    if (slot.start.getTime() - now.getTime() < config.leadMinutes * 60_000) throw fail("That pickup time is too soon. Choose a later time.");
    if (slot.capacity !== null) {
      await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`pickup-slot:${slot.start.toISOString()}:${opts.district ?? ""}`}))`;
      const taken = (await this.bookedCounts([slot.start], opts.district, db)).get(slot.start.getTime()) ?? 0;
      if (taken >= slot.capacity) throw fail("That pickup time is fully booked. Choose another time.");
    }
  }

  private windowsFor(config: PickupSlotConfig, date: string) {
    const windows = config.weekdayWindows[String(weekdayOf(date))] ?? config.windows;
    return windows.map(w => ({
      start: dhakaTime(date, w.start),
      end: dhakaTime(date, w.end),
      capacity: w.capacity ?? null,
      label: `${clockLabel(w.start)} – ${clockLabel(w.end)}`,
    }));
  }

  private async bookedCounts(starts: Date[], district?: string, db: Db = this.prisma) {
    if (!starts.length) return new Map<number, number>();
    const rows = await db.parcel.groupBy({
      by: ["pickupWindowStart"],
      where: { pickupWindowStart: { in: starts }, status: { not: "PICKUP_CANCELLED" }, ...(district ? { pickupDistrict: district } : {}) },
      _count: { _all: true },
    });
    return new Map(rows.map(r => [r.pickupWindowStart!.getTime(), r._count._all]));
  }
}
