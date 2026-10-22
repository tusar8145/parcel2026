import type { Catalog } from "../pricing/pricing.service";
import { COLUMNS, type ColumnKey, type ImportKindKey } from "../imports/columns";

/** Order fields read from a parcel photo, by import column key. */
export type ScanCells = Partial<Record<ColumnKey, string>>;

type Section = "none" | "recipient" | "sender";
interface Line {
  text: string;
  section: Section;
}

const BN_DIGITS = "০১২৩৪৫৬৭৮৯";
/** Bangla digits → ASCII, unusual separators → spaces. */
const normalizeText = (s: string) =>
  s
    .replace(/[০-৯]/g, d => String(BN_DIGITS.indexOf(d)))
    .replace(/[|¦]/g, " ")
    .replace(/ /g, " ");

// Words that start a section of a label ("To:", "From:", "প্রাপক").
// (?![\p{L}\p{M}\p{N}]) instead of \b, which only knows ASCII letters (Bangla words never match it).
const RECIPIENT_MARK = /^(?:to|ship\s*to|deliver(?:y)?\s*to|receiver|recipient|consignee|customer|প্রাপক|গ্রাহক)(?![\p{L}\p{M}\p{N}])\s*[:：\-–]?/iu;
const SENDER_MARK = /^(?:from|sender|shipper|pick\s*up|pickup|return\s*to|প্রেরক|পাঠানো)(?![\p{L}\p{M}\p{N}])\s*[:：\-–]?/iu;

const LABELS: Partial<Record<ColumnKey, RegExp>> = {
  recipient_name: /^(?:name|customer\s*name|receiver\s*name|recipient\s*name|নাম|প্রাপকের\s*নাম)\s*[:：\-–]\s*(.+)$/i,
  address: /^(?:address|addr|delivery\s*address|shipping\s*address|ঠিকানা)\s*[:：\-–]?\s*(.+)$/i,
  instructions: /^(?:note|notes|instruction|instructions|remarks?|comment|নোট|মন্তব্য)\s*[:：\-–]?\s*(.+)$/i,
};
const PHONE_LABEL = /^(?:phone|mobile|mob|cell|contact|tel|ফোন|মোবাইল)\s*(?:no\.?|number)?\s*[:：\-–]?\s*/i;
const ADDRESS_WORDS = /\b(?:house|h#|road|rd|block|sector|lane|avenue|village|vill|para|thana|upazila|union|post|p\.?o|flat|floor|bazar|market|mor|more|word|ward)\b|বাসা|বাড়ি|রোড|গ্রাম|থানা|উপজেলা/i;

/** BD mobile numbers on a line (separators between digits are dropped): local 01XXXXXXXXX form. */
export function phonesIn(line: string): string[] {
  const joined = normalizeText(line).replace(/(?<=\d)[\s\-–.()]+(?=\d)/g, "");
  const out: string[] = [];
  for (const m of joined.matchAll(/(?<!\d)(?:\+?88)?0?(1[3-9]\d{8})(?!\d)/g)) out.push(`0${m[1]}`);
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
  if (t.length < 3 || t.length > 60 || /\d{3,}/.test(t) || /[:@]/.test(t)) return false;
  const words = t.split(/\s+/);
  return words.length >= 1 && words.length <= 5 && !ADDRESS_WORDS.test(t);
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The longest catalog name found in the text as a whole word (case-insensitive). */
function findName(text: string, names: string[]): string | undefined {
  const sorted = [...names].sort((a, b) => b.length - a.length);
  return sorted.find(n => new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${escapeRe(n)}(?![\\p{L}\\p{M}\\p{N}])`, "iu").test(text));
}

/** District, zone and area named in the text, as written in the service catalog. */
export function matchPlace(text: string, catalog: Pick<Catalog, "districts" | "zonesByDistrict" | "areasByZone">) {
  let district = findName(text, catalog.districts);
  const zonesOf = (d: string) => catalog.zonesByDistrict[d] ?? [];
  let zone = district ? findName(text, zonesOf(district)) : undefined;
  if (!zone) {
    // A zone named without its district (or with a district name that is also a zone): look it up.
    const all = Object.entries(catalog.zonesByDistrict).flatMap(([d, zones]) => zones.map(z => ({ d, z })));
    const hit = findName(
      text,
      all.map(x => x.z),
    );
    const owner = hit ? all.filter(x => x.z === hit) : [];
    if (hit && (owner.length === 1 || owner.some(x => x.d === district))) {
      zone = hit;
      district = owner.find(x => x.d === district)?.d ?? owner[0].d;
    }
  }
  const area = zone ? findName(text, catalog.areasByZone[zone] ?? []) : undefined;
  return { district, zone, area };
}

/**
 * Reads order fields from the text of a parcel label (OCR output, English or Bangla): the phone
 * numbers, the labelled name / address / note, COD, weight, the order reference and the district /
 * zone / area named in it. Lines after "To:" belong to the recipient, after "From:" to the sender.
 * Only the columns of the kind's template are returned; anything not found is left out.
 */
export function parseLabel(rawText: string, kind: ImportKindKey, catalog: Pick<Catalog, "districts" | "zonesByDistrict" | "areasByZone">): ScanCells {
  const lines: Line[] = [];
  let section: Section = "none";
  for (const raw of normalizeText(rawText).split(/\r?\n/)) {
    let text = raw.replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (RECIPIENT_MARK.test(text)) {
      section = "recipient";
      text = text.replace(RECIPIENT_MARK, "").trim();
      lines.push({ text: `\u0000to ${text}`, section });
      continue;
    }
    if (SENDER_MARK.test(text)) {
      section = "sender";
      text = text.replace(SENDER_MARK, "").trim();
      lines.push({ text: `\u0000from ${text}`, section });
      continue;
    }
    lines.push({ text, section });
  }
  const plain = (l: Line) => l.text.replace(/^\u0000(?:to|from) /, "");
  const out: ScanCells = {};
  const notSender = lines.filter(l => l.section !== "sender");

  // Phones: the recipient's in the "To" part (else the first outside the sender part); the sender's in "From".
  const recipientPhones = lines.filter(l => l.section === "recipient").flatMap(l => phonesIn(plain(l)));
  const otherPhones = lines.filter(l => l.section === "none").flatMap(l => phonesIn(plain(l)));
  const senderPhones = lines.filter(l => l.section === "sender").flatMap(l => phonesIn(plain(l)));
  const recipientPhone = recipientPhones[0] ?? otherPhones[0];
  if (recipientPhone) out.recipient_phone = recipientPhone;
  if (senderPhones[0] && senderPhones[0] !== recipientPhone) out.sender_phone = senderPhones[0];

  // Labelled values ("Name: …", "Address: …", "Note: …").
  const used = new Set<Line>();
  for (const [key, re] of Object.entries(LABELS) as [ColumnKey, RegExp][]) {
    const line = notSender.find(l => re.test(plain(l)));
    const value = line ? stripPhones(plain(line).match(re)![1]) : "";
    if (line && value) {
      out[key] = value;
      used.add(line);
    }
  }
  // An address may continue on the next unlabeled line.
  if (out.address) {
    const at = lines.findIndex(l => used.has(l) && LABELS.address!.test(plain(l)));
    const next = lines[at + 1];
    if (next && next.section === lines[at].section && !/[:：]/.test(plain(next)) && !phonesIn(plain(next)).length && (ADDRESS_WORDS.test(plain(next)) || findName(plain(next), catalog.districts)))
      out.address = `${out.address}, ${plain(next)}`;
  }

  // The recipient's name: "To: Name" (its first part), else a name-like line next to the recipient phone.
  if (!out.recipient_name) {
    const to = lines.find(l => l.text.startsWith("\u0000to "));
    const first = to ? stripPhones(plain(to).split(",")[0]) : "";
    if (first && nameLike(first)) {
      out.recipient_name = first;
      used.add(to!);
    } else if (recipientPhone) {
      const at = notSender.findIndex(l => phonesIn(plain(l)).includes(recipientPhone));
      const same = at >= 0 ? stripPhones(plain(notSender[at])) : "";
      const candidates = [same, at > 0 ? plain(notSender[at - 1]) : ""].filter(c => c && nameLike(c));
      if (candidates[0]) out.recipient_name = candidates[0];
    }
  }
  // "To: Name, House 12, Road 5…": the rest of the line is the address.
  if (!out.address) {
    const to = lines.find(l => l.text.startsWith("\u0000to "));
    const rest = to ? stripPhones(plain(to).split(",").slice(1).join(",")) : "";
    if (rest && (ADDRESS_WORDS.test(rest) || rest.includes(","))) out.address = rest;
  }
  // Else the longest address-looking line outside the sender part.
  if (!out.address) {
    const candidate = notSender
      .filter(l => !used.has(l))
      .map(plain)
      .map(stripPhones)
      .filter(t => t.length >= 8 && !/^(?:cod|weight|order|invoice|total|amount|note)\b/i.test(t) && (ADDRESS_WORDS.test(t) || (t.match(/,/g)?.length ?? 0) >= 2))
      .sort((a, b) => b.length - a.length)[0];
    if (candidate) out.address = candidate;
  }

  // Sender (customer parcels): "From: Name, phone".
  const from = lines.find(l => l.text.startsWith("\u0000from "));
  const senderName = from ? stripPhones(plain(from).split(",")[0]) : "";
  if (senderName && nameLike(senderName)) out.sender_name = senderName;

  const all = lines.map(plain).join("\n");
  // Cash to collect: a COD / collect / amount line, in taka.
  const codLine = lines.map(plain).find(t => /\b(?:cod|c\.o\.d|cash\s*on\s*delivery|collect(?:ion)?|amount\s*to\s*collect|due)\b|টাকা|৳/i.test(t));
  const cod = codLine?.match(/(\d[\d,]*(?:\.\d{1,2})?)/);
  if (cod) out.cod_amount = cod[1].replace(/,/g, "");
  const weight = all.match(/(\d+(?:\.\d+)?)\s*(?:kg|kgs|কেজি)\b/i);
  if (weight) out.weight_kg = weight[1];
  const ref = all.match(/\b(?:order|invoice|inv|ref(?:erence)?)\s*(?:no\.?|number|id)?\s*[:#]?\s*#?\s*([A-Z0-9][A-Z0-9\-/]{2,30})/i);
  if (ref && /\d/.test(ref[1])) out.order_ref = ref[1];

  // District / zone / area: from the address first, else anywhere outside the sender part.
  const place = matchPlace(out.address ?? "", catalog);
  const anywhere = place.district || place.zone ? place : matchPlace(notSender.map(plain).join("\n"), catalog);
  if (anywhere.district) out.district = anywhere.district;
  if (anywhere.zone) out.zone = anywhere.zone;
  if (anywhere.area) out.area = anywhere.area;

  const allowed = new Set(COLUMNS[kind].map(c => c.key));
  return Object.fromEntries(Object.entries(out).filter(([k, v]) => allowed.has(k as ColumnKey) && v)) as ScanCells;
}
