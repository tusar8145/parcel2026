import type { Catalog } from "../pricing/pricing.service";
import { COLUMNS, type ColumnKey, type ImportKindKey } from "../imports/columns";
import { placeIn } from "./scan-geo";

/** Order fields read from a parcel photo, by import column key. */
export type ScanCells = Partial<Record<ColumnKey, string>>;
type Places = Pick<Catalog, "districts" | "zonesByDistrict" | "areasByZone">;

type Section = "none" | "recipient" | "sender";
interface Line {
  text: string;
  section: Section;
  /** The line was a section heading ("To:", "SHIP TO") with this left after it. */
  marker?: "to" | "from";
}

const BN_DIGITS = "০১২৩৪৫৬৭৮৯";
/** Bangla digits → ASCII, unusual separators → spaces, "$" before an amount → "৳" (OCR reads ৳ as $). */
export const normalizeText = (s: string) =>
  s
    .replace(/[০-৯]/g, d => String(BN_DIGITS.indexOf(d)))
    .replace(/[|¦]/g, " ")
    .replace(/ /g, " ")
    .replace(/\$\s*(?=\d)/g, "৳");

// Words that start a section of a label ("To:", "From:", "প্রাপক").
// (?![\p{L}\p{M}\p{N}]) instead of \b, which only knows ASCII letters (Bangla words never match it).
const RECIPIENT_MARK = /^(?:to|ship\s*to|deliver(?:y)?\s*to|receiver|recipient|consignee|customer|buyer|প্রাপক|গ্রাহক|ক্রেতা)(?![\p{L}\p{M}\p{N}])\s*(?:name|নাম)?\s*[:：\-–]?/iu;
const SENDER_MARK = /^(?:from|sender|shipper|seller|merchant|pick\s*up|pickup|return\s*to|প্রেরক|পাঠানো|বিক্রেতা)(?![\p{L}\p{M}\p{N}])\s*(?:name|নাম)?\s*[:：\-–]?/iu;

const LABELS: Partial<Record<ColumnKey, RegExp>> = {
  // "Name: …", or a table row "Name  Rahim Uddin" (no colon).
  recipient_name: /^(?:name|customer\s*name|receiver\s*name|recipient\s*name|নাম|প্রাপকের\s*নাম)(?:\s*[:：\-–]\s*|\s+)(.+)$/iu,
  address: /^(?:address|addr|delivery\s*address|shipping\s*address|ঠিকানা)\s*[:：\-–.;]?\s*(.+)$/iu,
  instructions: /^(?:note|notes|instruction|instructions|remarks?|comment|নোট|মন্তব্য)\s*[:：\-–.;]?\s*(.+)$/iu,
};
const PHONE_LABEL = /^(?:phone|mobile|mob|cell|contact|tel|ফোন|মোবাইল)\s*(?:no\.?|number|নং)?\s*[:：\-–.;]?\s*/iu;
const ADDRESS_WORDS = /\b(?:house|h#|road|rd|block|sector|lane|avenue|village|vill|para|thana|upazila|union|post|p\.?o|flat|floor|bazar|market|mor|more|word|ward)\b|বাসা|বাড়ি|রোড|গ্রাম|থানা|উপজেলা/iu;

/** Letters OCR puts in place of digits inside a phone number. */
const DIGIT_SLIPS: Record<string, string> = { O: "0", o: "0", D: "0", Q: "0", I: "1", l: "1", "|": "1", "!": "1", i: "1", Z: "2", z: "2", S: "5", s: "5", B: "8", b: "6", G: "6", T: "7" };

/** BD mobile numbers on a line (separators between digits dropped, letter slips fixed): local 01XXXXXXXXX form. */
export function phonesIn(line: string): string[] {
  const joined = normalizeText(line).replace(/(?<=\d)[\s\-–.()]+(?=\d)/g, "");
  const out: string[] = [];
  // A run of digits (with a few letter slips inside it) as long as a phone number.
  for (const found of joined.match(/\+?[\dOoDQIl|!iZzSsBbGT]{10,15}/g) ?? []) {
    const run = found.replace(/^[^\d+]+|[^\d]+$/g, "");
    if ((run.match(/\d/g)?.length ?? 0) < 8) continue;
    const digits = run.replace(/[^\d+]/g, c => DIGIT_SLIPS[c] ?? "");
    for (const m of digits.matchAll(/(?<!\d)(?:\+?88)?0?(1[3-9]\d{8})(?!\d)/g)) if (!out.includes(`0${m[1]}`)) out.push(`0${m[1]}`);
  }
  return out;
}

const stripPhones = (s: string) =>
  normalizeText(s)
    .replace(/(?<=\d)[\s\-–.()]+(?=\d)/g, "")
    .replace(/(?:\+?88)?0?1[3-9]\d{8}/g, "")
    .replace(PHONE_LABEL, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,;:\-–]+|[\s,;:\-–]+$/g, "");

/** A short line of words that can be a person's or shop's name. */
const nameLike = (s: string) => {
  const t = s.trim();
  if (t.length < 3 || t.length > 60 || /\d{3,}/.test(t) || /[:@৳$]/.test(t)) return false;
  const words = t.split(/\s+/);
  return words.length <= 5 && !ADDRESS_WORDS.test(t) && !/\b(?:label|invoice|order|shipping|delivery|slip|cod|total)\b|ডেলিভারি|স্লিপ/iu.test(t);
};

// ───────────── money ─────────────

export interface Money {
  /** Taka, as read. */
  value: number;
  /** The amount without its first digit when that digit may be a misread ৳ ("৳51,450" for "৳1,450"). */
  alt?: number;
  /** The amount had a currency sign before it (৳ / $): its first digit is more likely a misread ৳. */
  marked?: boolean;
  /** Where the amount starts on the line. */
  index: number;
}
const CURRENCY = /(?:৳|\btk\.?|\btaka\b|\bbdt\b|টাকা|tk(?=\d))/iu;
/** Amounts on a line: "৳1,250.00", "Tk. 2,300/-", "850 টাকা", "BDT 1250". Numbers stuck to letters (GG-5521) or followed by kg are not money. */
export function moneyIn(line: string): Money[] {
  const t = normalizeText(line).replace(/(\d)\.(\d{3})(?=[.,]\d{1,2}\b|\b(?![.,]\d))/g, "$1,$2");
  const out: Money[] = [];
  for (const m of t.matchAll(/(৳\s*)?(?<![\p{L}\d\-#/])(\d{1,3}(?:,\d{3})+|\d+)(?:[.,](\d{1,2}))?(?![\d,]*\s*(?:kg|kgs|g|gm|gms|gram|grams|কেজি|গ্রাম|%|pcs|x\b))(?![\p{L}\d])/giu)) {
    const whole = m[2].replace(/,/g, "");
    const value = Number(whole) + (m[3] ? Number(m[3].padEnd(2, "0")) / 100 : 0);
    if (!Number.isFinite(value) || value > 10_000_000) continue;
    const money: Money = { value, index: m.index ?? 0 };
    // The ৳ sign read as a digit right before a well-grouped amount ("৳1,450" → "$51,450" or "51,450").
    if (/^[35689]\d{1,3}(,\d{3})+$/.test(m[2])) money.alt = Number(m[2].slice(1).replace(/,/g, "")) + (m[3] ? Number(m[3].padEnd(2, "0")) / 100 : 0);
    if (m[1]) money.marked = true;
    out.push(money);
  }
  return out;
}
const money = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/** Lines naming the amount to collect, most specific first. */
const COD_KEYS: RegExp[] = [
  /\b(?:cod|c\.o\.d|cash\s*on\s*delivery|collect(?:ion)?|amount\s*to\s*collect|to\s*collect|payable|due)\b|সংগ্রহ|আদায়|বাকি/iu,
  /\b(?:grand\s*total|net\s*total|total\s*amount|total)\b|মোট/iu,
  /\b(?:price|amount|value|bill)\b|মূল্য|দাম|টাকা/iu,
];
const NOT_COD = /\b(?:delivery\s*(?:charge|fee)|shipping|charge|fee|discount|paid|advance|vat|tax)\b|ডেলিভারি\s*চার্জ|পরিশোধিত/iu;

/**
 * The amount to collect: from the most specific line (COD / collect / due, then total, then price),
 * else a lone taka amount. When the ৳ sign may have been read as a digit, the amount that equals the
 * other amounts added up (price + delivery charge) is taken.
 */
export function codFrom(lines: string[]): string | undefined {
  const all = lines.map(l => ({ line: l, amounts: moneyIn(l), currency: CURRENCY.test(normalizeText(l)) }));
  let pick: { line: string; amounts: Money[] } | undefined;
  for (const key of COD_KEYS) {
    pick = all.find(x => key.test(x.line) && !(key !== COD_KEYS[0] && NOT_COD.test(x.line)) && x.amounts.length);
    if (pick) break;
  }
  pick ??= all.filter(x => x.currency && x.amounts.length && !NOT_COD.test(x.line)).at(-1);
  if (!pick) return undefined;
  // The amount after the keyword ("Road 3 … bill 1,250/-" is 1,250).
  const keyAt = COD_KEYS.map(k => pick!.line.search(k)).filter(i => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const chosen = pick.amounts.find(m => m.index >= keyAt) ?? pick.amounts[0];
  if (chosen.alt !== undefined) {
    const others = all.filter(x => x !== pick && x.currency && x.amounts.length).map(x => x.amounts[0]);
    const sum = others.reduce((a, m) => a + (m.alt !== undefined && m.value > 10 * m.alt ? m.alt : m.value), 0);
    // The shorter amount when it adds up (price + charge), or when a marked amount is implausibly large.
    if (others.length && Math.abs(sum - chosen.alt) < 0.01) return money(chosen.alt);
    if (chosen.marked && Math.abs(sum - chosen.value) >= 0.01 && chosen.value > 50_000 && chosen.alt <= 50_000) return money(chosen.alt);
  }
  return money(chosen.value);
}

/**
 * No COD / total keyword anywhere (e.g. a table cell whose "COD" label the OCR lost): a row that holds
 * only an amount (beside at most a couple of short specks) is taken as the amount to collect.
 */
export function loneAmount(lines: string[]): string | undefined {
  for (const line of [...lines].reverse()) {
    const t = normalizeText(line).trim();
    const amounts = moneyIn(t);
    if (amounts.length !== 1 || phonesIn(t).length) continue;
    const rest = t.replace(/[৳$]|\btk\.?|\btaka\b|\bbdt\b|টাকা|\/-|[\d,.]+/giu, " ").trim().split(/\s+/).filter(Boolean);
    if (rest.length > 2 || rest.some(w => w.length > 3 || ADDRESS_WORDS.test(w))) continue;
    const { value, marked } = amounts[0];
    // A bare year ("2026") is a date, not taka.
    if (!marked && !CURRENCY.test(t) && Number.isInteger(value) && value >= 1990 && value <= 2100) continue;
    if (value >= 50 && value <= 200_000) return money(value);
  }
  return undefined;
}

/** Weight in kg: "1.5 kg", "1.2KG", "500 gm" (= 0.5), "২ কেজি". */
export function weightFrom(text: string): string | undefined {
  const m = normalizeText(text).match(/(\d+(?:[.,]\d+)?)\s*(kgs?|kilo(?:gram)?s?|কেজি|g|gms?|grams?|গ্রাম)(?![\p{L}])/iu);
  if (!m) return undefined;
  const n = Number(m[1].replace(",", "."));
  const kg = /^(?:g|gms?|grams?|গ্রাম)$/iu.test(m[2]) ? n / 1000 : n;
  return kg > 0 && kg <= 100 ? String(Math.round(kg * 1000) / 1000) : undefined;
}

// ───────────── the label ─────────────

/**
 * Reads order fields from the text of a parcel label (OCR output, English or Bangla): the phone
 * numbers, the labelled name / address / note, the amount to collect, weight, the order reference and
 * the district / zone / area (scan-geo.ts: Bangla names and small OCR slips too). Lines after "To:" /
 * "SHIP TO" belong to the recipient, after "From:" to the sender. Only the columns of the kind's
 * template are returned; anything not found is left out.
 */
export function parseLabel(rawText: string, kind: ImportKindKey, catalog: Places): ScanCells {
  const lines: Line[] = [];
  let section: Section = "none";
  for (const raw of normalizeText(rawText).split(/\r?\n/)) {
    // Table borders read as brackets around cells ("[Name [Rahim Uddin").
    let text = raw.replace(/[[\]{}]/g, " ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (RECIPIENT_MARK.test(text)) {
      section = "recipient";
      text = text.replace(RECIPIENT_MARK, "").trim();
      lines.push({ text, section, marker: "to" });
      continue;
    }
    if (SENDER_MARK.test(text)) {
      section = "sender";
      text = text.replace(SENDER_MARK, "").trim();
      lines.push({ text, section, marker: "from" });
      continue;
    }
    lines.push({ text, section });
  }
  const out: ScanCells = {};
  const notSender = lines.filter(l => l.section !== "sender");

  // Phones: the recipient's in the "To" part (else the first outside the sender part); the sender's in "From".
  const recipientPhones = lines.filter(l => l.section === "recipient").flatMap(l => phonesIn(l.text));
  const otherPhones = lines.filter(l => l.section === "none").flatMap(l => phonesIn(l.text));
  const senderPhones = lines.filter(l => l.section === "sender").flatMap(l => phonesIn(l.text));
  const recipientPhone = recipientPhones[0] ?? otherPhones.find(p => !senderPhones.includes(p));
  if (recipientPhone) out.recipient_phone = recipientPhone;
  if (senderPhones[0] && senderPhones[0] !== recipientPhone) out.sender_phone = senderPhones[0];

  // Labelled values ("Name: …", "Address: …", "Note: …").
  const used = new Set<Line>();
  for (const [key, re] of Object.entries(LABELS) as [ColumnKey, RegExp][]) {
    const line = notSender.find(l => re.test(l.text));
    let value = line ? stripPhones(line.text.match(re)![1]) : "";
    // A labelled name ends where the next label starts ("Name Karim Mia Mob 0181…").
    if (key === "recipient_name") value = value.split(/\b(?:mob|mobile|phone|cell|add|addr|address|cod|bill|price|seller|from)\b/i)[0].trim();
    if (key === "recipient_name" && value && !nameLike(value)) value = "";
    if (line && value) {
      out[key] = value;
      used.add(line);
    }
  }
  // An address may continue on the next unlabeled line.
  if (out.address) {
    const at = lines.findIndex(l => used.has(l) && LABELS.address!.test(l.text));
    const next = lines[at + 1];
    if (next && !next.marker && next.section === lines[at].section && !/[:：]/.test(next.text) && !phonesIn(next.text).length && !moneyIn(next.text).length && ADDRESS_WORDS.test(next.text))
      out.address = `${out.address}, ${next.text}`;
  }

  // The recipient's name: "To: Name" (its first part), else the first name-like line of the "To" part,
  // else a name-like line next to the recipient phone.
  const to = lines.find(l => l.marker === "to");
  if (!out.recipient_name) {
    const first = to ? stripPhones(to.text.split(",")[0]) : "";
    const toPart = lines.filter(l => l.section === "recipient" && !l.marker);
    const candidate = first && nameLike(first) ? first : toPart.map(l => stripPhones(l.text)).find(t => t && nameLike(t) && !LABELS.address!.test(t));
    if (candidate) out.recipient_name = candidate;
    else if (recipientPhone) {
      const at = notSender.findIndex(l => phonesIn(l.text).includes(recipientPhone));
      const same = at >= 0 ? stripPhones(notSender[at].text) : "";
      const near = [same, at > 0 ? notSender[at - 1].text : ""].filter(c => c && nameLike(c));
      if (near[0]) out.recipient_name = near[0];
    }
  }
  // "To: Name, House 12, Road 5…": the rest of the line is the address.
  if (!out.address && to) {
    const rest = stripPhones(to.text.split(",").slice(1).join(","));
    if (rest && (ADDRESS_WORDS.test(rest) || rest.includes(","))) out.address = rest;
  }
  // Else the longest address-looking line of the "To" part, then outside the sender part.
  if (!out.address) {
    const looks = (t: string) => t.length >= 8 && !moneyIn(t).some(() => CURRENCY.test(t)) && !/^(?:cod|weight|wt|order|invoice|total|amount|note|product|price)\b/i.test(t) && (ADDRESS_WORDS.test(t) || (t.match(/,/g)?.length ?? 0) >= 2);
    const pool = (ls: Line[]) => ls.filter(l => !used.has(l) && !l.marker).map(l => stripPhones(l.text)).filter(looks).sort((a, b) => b.length - a.length)[0];
    const candidate = pool(lines.filter(l => l.section === "recipient")) ?? pool(notSender);
    if (candidate) out.address = candidate;
  }

  // Sender (customer parcels): "From: Name, phone", or the first name-like line of the "From" part.
  const from = lines.find(l => l.marker === "from");
  const fromFirst = from ? stripPhones(from.text.split(",")[0]) : "";
  const senderName = fromFirst && nameLike(fromFirst) ? fromFirst : lines.filter(l => l.section === "sender" && !l.marker).map(l => stripPhones(l.text)).find(t => t && nameLike(t));
  if (senderName) out.sender_name = senderName;

  const texts = lines.map(l => l.text);
  const all = texts.join("\n");
  const cod = codFrom(texts) ?? loneAmount(texts);
  if (cod) out.cod_amount = cod;
  const weight = weightFrom(all);
  if (weight) out.weight_kg = weight;
  const ref = all.match(/\b(?:order|invoice|inv|ref(?:erence)?)\s*(?:no\.?|number|id|code)?\s*[:#]?\s*#?\s*([A-Z0-9][A-Z0-9\-/]{2,30})/i);
  if (ref && /\d/.test(ref[1])) out.order_ref = ref[1];
  // No "Order …" label: a code shaped like one ("CUS-1001", "INV-2045") written on its own.
  else {
    const code = all.match(/(?<![\w-])([A-Z]{2,6}-\d{3,10})(?![\w-])/);
    if (code && !/^(?:road|house|block|sector|flat)$/i.test(code[1].split("-")[0])) out.order_ref = code[1];
  }

  // District / zone / area: from the address first, else anywhere outside the sender part.
  const fromAddress = placeIn(out.address ?? "", catalog);
  const place = fromAddress.zone || fromAddress.district ? fromAddress : placeIn(notSender.map(l => l.text).join("\n"), catalog);
  if (place.district) out.district = place.district;
  if (place.zone) out.zone = place.zone;
  if (place.area) out.area = place.area;

  const allowed = new Set(COLUMNS[kind].map(c => c.key));
  return Object.fromEntries(Object.entries(out).filter(([k, v]) => allowed.has(k as ColumnKey) && v)) as ScanCells;
}
