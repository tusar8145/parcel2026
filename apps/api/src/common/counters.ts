import { randomBytes } from "node:crypto";
import type { Db } from "./prisma.service";

/** Atomically increments and returns a named counter (safe under concurrency). */
export async function nextCounter(db: Db, scope: string, start = 0): Promise<number> {
  const rows = await db.$queryRaw<{ value: number }[]>`
    INSERT INTO counters (scope, value) VALUES (${scope}, ${start + 1})
    ON CONFLICT (scope) DO UPDATE SET value = counters.value + 1
    RETURNING value`;
  return rows[0].value;
}

/** YYMMDD in Bangladesh time (UTC+6), e.g. 261015. */
export function dhakaDateCode(date = new Date()): string {
  const d = new Date(date.getTime() + 6 * 3600_000);
  return d.toISOString().slice(2, 10).replace(/-/g, "");
}

/** Crockford base32: no I, L, O or U, so IDs read aloud or typed by hand are unambiguous. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TRACKING_RANDOM_LENGTH = 5; // 32^5 ≈ 33.5 million IDs per day and prefix
const TRACKING_ATTEMPTS = 8;

/** `length` random Crockford base32 characters (crypto-strong, unbiased). */
export function randomCrockford(length: number): string {
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length)) {
      // 256 is a multiple of 32, so taking the low 5 bits is unbiased.
      out += CROCKFORD[byte & 31];
      if (out.length === length) break;
    }
  }
  return out;
}

/**
 * PP-261015-7K3QF: the booking date (Dhaka) plus 5 random Crockford base32 characters,
 * so IDs can't be guessed or enumerated. Retries on the (rare) collision with an existing
 * parcel or pre-allocated consignment number. Older sequential IDs (PP-261015-1001) stay valid.
 */
export async function nextTrackingId(db: Db, prefix = "PP"): Promise<string> {
  const scope = `${prefix}-${dhakaDateCode()}`;
  for (let attempt = 0; attempt < TRACKING_ATTEMPTS; attempt++) {
    const candidate = `${scope}-${randomCrockford(TRACKING_RANDOM_LENGTH)}`;
    // Counter rows double as a reservation table: the insert fails if the ID was ever issued.
    const reserved = await db.$queryRaw<{ scope: string }[]>`
      INSERT INTO counters (scope, value) VALUES (${`tracking-id:${candidate}`}, 1)
      ON CONFLICT (scope) DO NOTHING
      RETURNING scope`;
    if (!reserved.length) continue;
    if (await db.parcel.findUnique({ where: { trackingId: candidate }, select: { id: true } })) continue;
    return candidate;
  }
  throw new Error("Could not allocate a unique tracking ID");
}

/**
 * Normalises what someone typed: upper case, no spaces, and in the random part the
 * look-alikes Crockford base32 excludes (O→0, I/L→1). Older numeric IDs are unaffected.
 */
export function normalizeTrackingId(input: string): string {
  const clean = input.trim().toUpperCase().replace(/\s+/g, "");
  const match = clean.match(/^([A-Z]{2,4}-\d{6}-)([0-9A-Z]{4,8})$/);
  if (!match) return clean;
  return match[1] + match[2].replace(/O/g, "0").replace(/[IL]/g, "1");
}

/** e.g. TK-261015-0001, INV-2610-0001 */
export async function nextNumber(db: Db, prefix: string, period: "day" | "month" = "day"): Promise<string> {
  const code = period === "day" ? dhakaDateCode() : dhakaDateCode().slice(0, 4);
  const scope = `${prefix}-${code}`;
  return `${scope}-${String(await nextCounter(db, scope)).padStart(4, "0")}`;
}
