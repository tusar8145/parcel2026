import { createHmac } from "node:crypto";
import { safeEqual } from "../../common/crypto";
import { env } from "../../config/env";

/**
 * Signed links that let someone without an account see a parcel's full timeline:
 *  - "owner"    (o): the guest who booked it — full details, cancel while pending, feedback.
 *  - "feedback" (f): the sender after delivery (SMS link) — full details and feedback.
 * Stateless (HMAC over the tracking ID, scope and expiry), short enough for an SMS.
 */
export type ParcelAccessScope = "owner" | "feedback";

const SCOPE_CODE: Record<ParcelAccessScope, string> = { owner: "o", feedback: "f" };
const CODE_SCOPE: Record<string, ParcelAccessScope> = { o: "owner", f: "feedback" };
const DEFAULT_TTL_DAYS: Record<ParcelAccessScope, number> = { owner: 120, feedback: 30 };

const key = () => createHmac("sha256", env().JWT_ACCESS_SECRET).update("parcel-access-token:v1").digest();
const sign = (trackingId: string, code: string, exp: string) =>
  createHmac("sha256", key()).update(`${trackingId.toUpperCase()}|${code}|${exp}`).digest("base64url").slice(0, 22);

export function signParcelAccess(trackingId: string, scope: ParcelAccessScope, ttlDays = DEFAULT_TTL_DAYS[scope]): string {
  const code = SCOPE_CODE[scope];
  const exp = Math.floor(Date.now() / 1000 + ttlDays * 86_400).toString(36);
  return `${code}.${exp}.${sign(trackingId, code, exp)}`;
}

/** The scope a token grants for this parcel, or null when it is invalid or expired. */
export function verifyParcelAccess(trackingId: string, token: string | undefined | null): ParcelAccessScope | null {
  if (!token || token.length > 64) return null;
  const [code, exp, sig] = token.split(".");
  const scope = CODE_SCOPE[code];
  if (!scope || !exp || !sig || !/^[0-9a-z]{1,10}$/.test(exp)) return null;
  if (parseInt(exp, 36) * 1000 < Date.now()) return null;
  return safeEqual(sig, sign(trackingId, code, exp)) ? scope : null;
}

/** Public tracking page, optionally with an access token. */
export function trackingUrl(trackingId: string, token?: string, hash?: string) {
  const base = `${env().APP_URL.replace(/\/$/, "")}/track/${encodeURIComponent(trackingId)}`;
  return `${base}${token ? `?t=${encodeURIComponent(token)}` : ""}${hash ? `#${hash}` : ""}`;
}
