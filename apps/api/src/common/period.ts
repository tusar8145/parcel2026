import { z } from "zod";

/**
 * Dashboard periods (Today, This week, This month, a custom range…) as Dhaka calendar days.
 *
 * Every overview / stats / summary endpoint takes the same optional `from` / `to` query
 * (YYYY-MM-DD, inclusive, read as Asia/Dhaka days: UTC+6 all year). Both or neither; from ≤ to;
 * at most MAX_PERIOD_DAYS days. Without them each endpoint uses its own default period
 * (what the page showed before). The web side is public/legacy/shared/period.js (DF.period).
 */
export const MAX_PERIOD_DAYS = 366;
const DHAKA_OFFSET_MS = 6 * 3600_000;
const DAY_MS = 86_400_000;

const isoDay = z.iso.date("Use a date like 2026-10-18");
export const periodQueryShape = { from: isoDay.optional(), to: isoDay.optional() };

/** The period checks for an object schema that includes `periodQueryShape`. */
export function periodChecks(v: { from?: string; to?: string }, ctx: z.RefinementCtx) {
  if (!v.from !== !v.to) {
    ctx.addIssue({ code: "custom", message: "Send both from and to (or neither)", path: [v.from ? "to" : "from"] });
    return;
  }
  if (!v.from || !v.to) return;
  if (v.from > v.to) ctx.addIssue({ code: "custom", message: "from must be on or before to", path: ["from"] });
  else if (daysBetween(v.from, v.to) > MAX_PERIOD_DAYS)
    ctx.addIssue({ code: "custom", message: `Choose a period of at most ${MAX_PERIOD_DAYS} days`, path: ["from"] });
}

/** `?from=&to=` on its own. */
export const periodQuerySchema = z.object(periodQueryShape).superRefine(periodChecks);
export type PeriodQuery = z.infer<typeof periodQuerySchema>;

export type PeriodPreset = "today" | "yesterday" | "this_week" | "last_7_days" | "this_month" | "last_month";

/** A resolved period: Dhaka days [from, to] and the UTC instants [start, end). */
export interface Period {
  from: string;
  to: string;
  start: Date;
  end: Date;
  days: number;
  /** Chart buckets: hours for one day, days up to ~3 months, months beyond. */
  bucket: "hour" | "day" | "month";
  /** True when the caller chose it (from/to sent). */
  chosen: boolean;
  /** The same number of days just before (for "vs previous period"). */
  previous: { from: string; to: string; start: Date; end: Date };
}

/** "YYYY-MM-DD" of the Dhaka day containing `at`. */
export const dhakaDayKey = (at: Date | number = new Date()) => new Date(new Date(at).getTime() + DHAKA_OFFSET_MS).toISOString().slice(0, 10);
/** Midnight (Dhaka) at the start of a "YYYY-MM-DD" day, as a UTC instant. */
export const dhakaDayStartOf = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - DHAKA_OFFSET_MS);
const shiftDay = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
/** Inclusive number of days from `from` to `to`. */
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;

/** The Dhaka days of a preset (weeks start on Saturday, the first day of the Bangladeshi week). */
export function presetRange(preset: PeriodPreset, now = new Date()): { from: string; to: string } {
  const today = dhakaDayKey(now);
  const [y, m] = today.split("-").map(Number);
  const monthStart = (year: number, month: number) => new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 10);
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "yesterday":
      return { from: shiftDay(today, -1), to: shiftDay(today, -1) };
    case "this_week": {
      const weekday = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sunday … 6 = Saturday
      return { from: shiftDay(today, -((weekday + 1) % 7)), to: today };
    }
    case "last_7_days":
      return { from: shiftDay(today, -6), to: today };
    case "this_month":
      return { from: monthStart(y, m), to: today };
    case "last_month":
      return { from: monthStart(y, m - 1), to: shiftDay(monthStart(y, m), -1) };
  }
}

/** The chosen period, or the endpoint's default preset. */
export function resolvePeriod(query: { from?: string; to?: string } | undefined, fallback: PeriodPreset, now = new Date()): Period {
  const chosen = !!(query?.from && query?.to);
  const { from, to } = chosen ? { from: query!.from!, to: query!.to! } : presetRange(fallback, now);
  const days = daysBetween(from, to);
  const prevTo = shiftDay(from, -1);
  const prevFrom = shiftDay(from, -days);
  return {
    from,
    to,
    start: dhakaDayStartOf(from),
    end: dhakaDayStartOf(shiftDay(to, 1)),
    days,
    bucket: days <= 1 ? "hour" : days <= 92 ? "day" : "month",
    chosen,
    previous: { from: prevFrom, to: prevTo, start: dhakaDayStartOf(prevFrom), end: dhakaDayStartOf(from) },
  };
}

/** What a response says about its period. */
export const periodView = (p: Period) => ({ from: p.from, to: p.to, start: p.start, end: p.end, days: p.days, bucket: p.bucket, previous: { from: p.previous.from, to: p.previous.to } });

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The chart buckets of a period: keys as SQL `to_char(ts + 6h, fmt)` produces them, labels, and
 * the key of the matching bucket in the previous period (same offset).
 */
export function periodBuckets(p: Period): { format: string; keys: string[]; labels: string[]; previousKeys: string[] } {
  if (p.bucket === "hour") {
    const hours = Array.from({ length: 24 }, (_, h) => h);
    const label = (h: number) => `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;
    return {
      format: "YYYY-MM-DD HH24",
      keys: hours.map(h => `${p.from} ${String(h).padStart(2, "0")}`),
      labels: hours.map(label),
      previousKeys: hours.map(h => `${p.previous.to} ${String(h).padStart(2, "0")}`),
    };
  }
  if (p.bucket === "day") {
    const days = Array.from({ length: p.days }, (_, i) => i);
    return {
      format: "YYYY-MM-DD",
      keys: days.map(i => shiftDay(p.from, i)),
      labels: days.map(i => {
        const d = new Date(`${shiftDay(p.from, i)}T00:00:00Z`);
        return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, "0")}`;
      }),
      previousKeys: days.map(i => shiftDay(p.previous.from, i)),
    };
  }
  const months: string[] = [];
  for (let key = p.from.slice(0, 7); key <= p.to.slice(0, 7); ) {
    months.push(key);
    const [y, m] = key.split("-").map(Number);
    key = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
  }
  const [py, pm] = p.previous.from.split("-").map(Number);
  const prevMonths = months.map((_, i) => new Date(Date.UTC(py, pm - 1 + i, 1)).toISOString().slice(0, 7));
  return {
    format: "YYYY-MM",
    keys: months,
    labels: months.map(k => `${MONTHS[Number(k.slice(5)) - 1]} ${k.slice(2, 4)}`),
    previousKeys: prevMonths,
  };
}

/** Bucketed rows (key → count) as the current and previous series of a chart. */
export function fillSeries(b: ReturnType<typeof periodBuckets>, rows: Map<string, number>) {
  return { current: b.keys.map(k => rows.get(k) ?? 0), previous: b.previousKeys.map(k => rows.get(k) ?? 0) };
}
