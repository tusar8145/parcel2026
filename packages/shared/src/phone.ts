/**
 * Bangladeshi mobile numbers. The country code is fixed (+880); people may type the number
 * as 1XXXXXXXXX, 01XXXXXXXXX, 8801XXXXXXXXX or +8801XXXXXXXXX (spaces and dashes ignored).
 */
const BD_MOBILE = /^(?:\+?880|0)?(1[3-9]\d{8})$/;

const clean = (input: string) => input.replace(/[\s\-().]/g, "");

export function isBdMobile(input: string): boolean {
  return BD_MOBILE.test(clean(input));
}

/** Normalises to E.164 (+8801XXXXXXXXX). Throws on anything that isn't a BD mobile number. */
export function normalizeBdPhone(input: string): string {
  const match = clean(input).match(BD_MOBILE);
  if (!match) throw new Error(`Not a Bangladeshi mobile number: ${input}`);
  return `+880${match[1]}`;
}

/** The 10 digits after +880 (what a phone field with a fixed "+880" prefix shows). */
export function localBdDigits(e164: string): string {
  return e164.replace(/^\+880/, "");
}

/**
 * A recipient's mobile printed masked on a label or sheet ("019***545", "01712***678"): a BD mobile
 * prefix with some digits hidden by "*". Kept as written (no +880 added), shown as is, never messaged.
 */
const MASKED_BD_MOBILE = /^(?:\+?880|0)?(1[3-9][\d*]{3,12})$/;

export function isMaskedBdMobile(input: string): boolean {
  const c = clean(input);
  return c.includes("*") && MASKED_BD_MOBILE.test(c) && (c.match(/\d/g)?.length ?? 0) >= 4;
}

/** "+88019***545" / "19***545" → "019***545". Throws on anything that isn't a masked BD mobile. */
export function normalizeMaskedBdPhone(input: string): string {
  const match = isMaskedBdMobile(input) ? clean(input).match(MASKED_BD_MOBILE) : null;
  if (!match) throw new Error(`Not a masked Bangladeshi mobile number: ${input}`);
  return `0${match[1]}`;
}

/** A stored phone that is masked (no SMS, no call). */
export const isMaskedPhone = (phone: string | null | undefined) => !!phone && phone.includes("*");

/** +8801712345678 -> 01712-345678 for display (a masked number as written). */
export function formatBdPhone(e164: string): string {
  if (isMaskedPhone(e164)) return e164;
  const local = `0${localBdDigits(e164)}`;
  return `${local.slice(0, 5)}-${local.slice(5)}`;
}

/** Why a typed number is invalid, for inline form messages (undefined when valid). */
export function bdPhoneProblem(input: string): string | undefined {
  const digits = clean(input).replace(/^\+?880|^0/, "");
  if (!digits) return "Enter a mobile number";
  if (!/^\d+$/.test(digits)) return "Use digits only";
  if (!digits.startsWith("1")) return "Bangladeshi mobile numbers start with 1 (e.g. 17XXXXXXXX)";
  if (digits.length !== 10) return "Enter the 10 digits after +880 (e.g. 1712345678)";
  if (!/^1[3-9]/.test(digits)) return "This isn't a valid Bangladeshi operator prefix";
  return undefined;
}
