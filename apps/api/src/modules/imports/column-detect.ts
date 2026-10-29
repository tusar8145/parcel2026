import { isBdMobile, isMaskedBdMobile } from "@paira-express/shared";
import { COLUMNS, matchHeaders, normalizeHeader, type ColumnKey, type ImportKindKey } from "./columns";
import { parseNumber } from "./import-engine.service";

/**
 * Any merchant's spreadsheet (docs/architecture-contracts.md, "Imports: any file"): finds the header row
 * (titles, blank lines and notes above it are skipped; a file may have no header row at all), tells which
 * column is which from the header words and the data under them, and which lines are not orders (blank,
 * repeated headers, totals, notes). Pure: the jobs service adds what the merchant's last file used.
 */

/** What a file column feeds: a template column, part of the delivery address, or nothing. */
export type MappedKey = ColumnKey | "__address_part" | "__scan" | "__cod";
/** Place columns: kept as they are only when the catalog knows the names, else added to the address. */
const PLACE_KEYS = new Set<MappedKey>(["district", "zone", "area", "pickup_district", "pickup_zone", "pickup_area"]);
/** Keys more than one file column may have. */
export const MULTI_KEYS = new Set<MappedKey>(["__address_part"]);

export interface ColumnGuess {
  index: number;
  /** A, B, … AA. */
  letter: string;
  header: string;
  samples: string[];
  key: MappedKey | null;
  /** saved: the merchant's last file with these headers · header: by its name · data: by its values. */
  by: "saved" | "header" | "data" | null;
}

export interface SheetLayout {
  /** 1-based row of the headers; 0 = the file has no header row. */
  headerRow: number;
  columns: ColumnGuess[];
  /** Normalised headers, to recognise the same layout next time. */
  signature: string;
  /** Our own template (or a Scan with phone workbook): every column with data has a template header. */
  template: boolean;
}

export interface DetectLists {
  districts: string[];
  zones: string[];
  areas: string[];
  products: string[];
  speeds: string[];
}

const HEADER_SCAN = 30;
const SAMPLE_ROWS = 60;

export const columnLetter = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : columnLetter(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)));
const clean = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();
const words = (h: string) => h.toLowerCase().replace(/[^a-z0-9ঀ-৿]+/g, " ").trim();

/** Header words per column (any part of the header; Bangla too). Earlier entries win ties. */
const KEYWORDS: { key: MappedKey; kind?: ImportKindKey[]; any: RegExp; not?: RegExp }[] = [
  { key: "sender_phone", kind: ["customer"], any: /\b(sender|from|pickup|shop|merchant)\b.*\b(phone|mobile|cell|contact|number|no)\b|প্রেরক.*(ফোন|মোবাইল)/ },
  { key: "sender_name", kind: ["customer"], any: /\b(sender|from|pickup)\b.*\bname\b|^sender$|প্রেরক/ },
  { key: "pickup_address", kind: ["customer"], any: /\b(sender|from|pickup)\b.*\b(address|location)\b/ },
  { key: "recipient_phone", any: /\b(phone|mobile|cell|contact|cell no|mobile no|number|ph|mob|fone)\b|ফোন|মোবাইল|নম্বর/, not: /\b(sender|merchant|shop|alt|alternative|secondary|other|2)\b|order|invoice|tracking|id\b/ },
  { key: "recipient_name", any: /\b(name|customer|receiver|recipient|consignee|client|buyer)\b|নাম|গ্রাহক/, not: /\b(sender|merchant|shop|product|item|area|zone|district|city)\b/ },
  { key: "address", any: /\b(address|addr|location|destination|shipping|thikana|ship to|deliver to)\b|ঠিকানা/, not: /\b(sender|pickup|from|email)\b/ },
  { key: "district", any: /\b(district|city|zila|zilla|jela)\b|জেলা/ },
  { key: "zone", any: /\b(thana|upazila|upozila|zone|police station|ps|sub district)\b|থানা|উপজেলা/ },
  { key: "area", any: /\b(area|locality|landmark|region)\b|এলাকা/ },
  { key: "cod_amount", any: /\b(cod|collect|collection|collectable|cash|amount|price|total|bill|due|payable|taka|tk|bdt|receivable)\b|টাকা|মূল্য/, not: /\b(delivery charge|delivery fee|shipping fee|charge|fee|paid|advance|discount|weight|value)\b/ },
  { key: "declared_value", any: /\b(value|worth|invoice value|product price|goods value)\b/, not: /\bcod\b/ },
  { key: "weight_kg", any: /\b(weight|kg|kgs|gram)\b|ওজন/ },
  { key: "order_ref", any: /\b(order|invoice|ref|reference|merchant id|order id|order no|inv)\b/, not: /\b(date|time|status|amount|total|value|tracking)\b/ },
  { key: "product_type", any: /\b(product|item|category|goods|parcel type)\b|পণ্য/, not: /\b(price|value|amount|qty|quantity|weight)\b/ },
  { key: "service_level", any: /\b(service|speed|delivery type)\b/ },
  { key: "open_box", any: /\b(open box|check before|open)\b/ },
  { key: "instructions", any: /\b(note|notes|remark|remarks|comment|comments|instruction|instructions|special)\b|মন্তব্য/ },
];
/** Columns of many merchant files that are never ours. */
const NEVER = /^(sl|s l|sl no|serial|serial no|no|#|date|order date|created|created at|time|status|payment|payment method|payment status|delivery charge|delivery fee|shipping charge|charge|fee|qty|quantity|email|e mail|tracking|tracking id|tracking no|consignment|consignment id|courier|paid|advance|discount)$/;

/** How well each column's values fit a field: 0…1 (share of the samples that look right). */
function dataFit(samples: string[], lists: DetectLists): Partial<Record<MappedKey, number>> {
  const n = samples.length;
  if (!n) return {};
  const share = (test: (v: string) => boolean) => samples.filter(test).length / n;
  const lower = (list: string[]) => new Set(list.map(x => x.toLowerCase()));
  const districts = lower(lists.districts);
  const zones = lower(lists.zones);
  const areas = lower(lists.areas);
  const products = lower(lists.products.map(p => p.replace(/\s*\(.*\)$/, "")));
  const speeds = lower(lists.speeds);
  const phone = (v: string) => isBdMobile(v.replace(/^'/, "")) || isMaskedBdMobile(v) || /^1[3-9]\d{8}$/.test(v.replace(/\D/g, "").replace(/^(880|0)/, ""));
  const num = (v: string) => (phone(v) ? null : parseNumber(v));
  const placeHit = (v: string) => {
    const t = ` ${v.toLowerCase().replace(/[^a-zঀ-৿]+/g, " ")} `;
    return [...districts, ...zones].some(p => p.length > 3 && t.includes(` ${p} `));
  };
  const looksAddress = (v: string) => v.length >= 12 && (/[,/-]/.test(v) || /\d/.test(v)) && (/\b(road|rd|house|flat|block|sector|lane|avenue|bazar|para|tower|floor|holding|village|vill|post|thana|word|ward|mohalla|gali|goli|no\.?)\b/i.test(v) || placeHit(v));
  const looksName = (v: string) => /^[A-Za-zঀ-৿.'\s-]{3,40}$/.test(v) && v.split(/\s+/).length <= 5 && !districts.has(v.toLowerCase()) && !zones.has(v.toLowerCase());
  const amounts = samples.map(num).filter((x): x is number => x !== null);
  const money = amounts.length / n >= 0.8 && amounts.every(x => x >= 0 && x <= 1_000_000) && amounts.some(x => x >= 50);
  const weight = amounts.length / n >= 0.8 && amounts.every(x => x > 0 && x <= 50) && !amounts.every(x => Number.isInteger(x) && x >= 10);
  const unique = new Set(samples).size / n;
  return {
    recipient_phone: share(phone),
    sender_phone: share(phone),
    address: share(looksAddress),
    pickup_address: share(looksAddress),
    recipient_name: share(looksName),
    sender_name: share(looksName),
    district: share(v => districts.has(v.toLowerCase())),
    zone: share(v => zones.has(v.toLowerCase())),
    area: share(v => areas.has(v.toLowerCase())),
    __address_part: share(v => districts.has(v.toLowerCase()) || zones.has(v.toLowerCase()) || areas.has(v.toLowerCase()) || placeHit(v)),
    product_type: share(v => products.has(v.toLowerCase().replace(/\s*\(.*\)$/, ""))),
    service_level: share(v => speeds.has(v.toLowerCase())),
    open_box: share(v => /^(yes|no|y|n|true|false)$/i.test(v)),
    cod_amount: money ? 0.9 : 0,
    declared_value: money ? 0.6 : 0,
    weight_kg: weight ? 0.9 : /\bkg\b/i.test(samples.join(" ")) ? 0.7 : 0,
    order_ref: share(v => /^[A-Za-z0-9#][A-Za-z0-9#_\-/.]{2,29}$/.test(v) && /\d/.test(v) && !phone(v)) * (unique > 0.9 ? 1 : 0.3),
    instructions: share(v => v.length >= 8 && /\b(call|please|before|after|deliver|fragile|careful|office|home|evening|morning)\b/i.test(v)),
  };
}

/** Is this row a header row? A score: template headers and header-like words, and no data (phones, amounts). */
function headerScore(kind: ImportKindKey, row: string[]): number {
  const cells = row.map(clean).filter(Boolean);
  if (cells.length < 2) return 0;
  const exact = matchHeaders(kind, row).map.filter(Boolean).length;
  const keyword = cells.filter(c => NEVER.test(words(c)) || KEYWORDS.some(k => (!k.kind || k.kind.includes(kind)) && k.any.test(words(c)))).length;
  const data = cells.filter(c => isBdMobile(c) || /^\d[\d,.\s]*$/.test(c) || c.length > 40).length;
  return exact * 3 + keyword * 2 - data * 3;
}

/** The header row: the best scoring row of the first 30 (index), or -1 when the file has none. */
export function findHeaderRow(kind: ImportKindKey, rows: string[][]): number {
  let best = -1;
  let bestScore = 3;
  for (let i = 0; i < Math.min(rows.length, HEADER_SCAN); i++) {
    const score = headerScore(kind, rows[i] ?? []);
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  }
  return best;
}

/** Lines that aren't orders: blank, one cell (titles, notes, signatures), a repeated header, a totals line. */
export function isExtraRow(raw: string[], header: string[] | null): boolean {
  const cells = raw.map(clean);
  const filled = cells.filter(Boolean);
  if (!filled.length) return true;
  if (header && filled.length >= 2 && cells.every((c, i) => !c || normalizeHeader(c) === normalizeHeader(header[i] ?? ""))) return true;
  const phone = filled.some(c => isBdMobile(c) || isMaskedBdMobile(c));
  if (phone) return false;
  if (filled.length === 1) return true;
  return filled.some(c => /^(grand\s+)?(sub\s*)?total\b|^sum\b|^সর্বমোট|^মোট/i.test(c));
}

/** The normalised headers of a layout (a merchant's file with the same headers is matched the same way). */
export const layoutSignature = (headers: string[]) => headers.map(h => normalizeHeader(h)).join("|");

/**
 * Header row and a field per column. `headerIndex`: the row the user chose (-1: no header row), else found.
 * `saved`: the merchant's last matching for these headers (header text → key) wins over guessing.
 */
export function detectLayout(input: { kind: ImportKindKey; rows: string[][]; lists: DetectLists; headerIndex?: number; saved?: Record<string, MappedKey | null> | null }): SheetLayout {
  const { kind, rows, lists } = input;
  const headerIndex = input.headerIndex ?? findHeaderRow(kind, rows);
  const header = headerIndex >= 0 ? (rows[headerIndex] ?? []).map(clean) : null;
  const body = rows.slice(headerIndex + 1).filter(r => !isExtraRow(r, header));
  const width = Math.max(header?.length ?? 0, ...body.slice(0, SAMPLE_ROWS).map(r => r.length), 0);
  const allowed = new Set<MappedKey>(COLUMNS[kind].map(c => c.key));
  const exact = header ? matchHeaders(kind, header).map : [];

  type Candidate = { index: number; key: MappedKey; score: number; by: "header" | "data" };
  const candidates: Candidate[] = [];
  const columns: ColumnGuess[] = [];
  for (let i = 0; i < width; i++) {
    const h = header?.[i] ?? "";
    const samples = body
      .map(r => clean(r[i]))
      .filter(Boolean)
      .slice(0, SAMPLE_ROWS);
    columns.push({ index: i, letter: columnLetter(i), header: h, samples: [...new Set(samples)].slice(0, 3), key: null, by: null });
    if (!samples.length) {
      // An empty column of our own template keeps its field (nothing to read, nothing to ignore).
      if (exact[i]) candidates.push({ index: i, key: exact[i] as MappedKey, score: 150, by: "header" });
      continue;
    }
    const w = words(h);
    const fit = dataFit(samples, lists);
    if (exact[i]) {
      candidates.push({ index: i, key: exact[i] as MappedKey, score: 200 + (fit[exact[i] as MappedKey] ?? 0) * 10, by: "header" });
      if (PLACE_KEYS.has(exact[i] as MappedKey)) candidates.push({ index: i, key: "__address_part", score: 95, by: "header" });
      continue;
    }
    if (w && NEVER.test(w)) continue;
    const named = new Set<MappedKey>();
    for (const k of KEYWORDS) {
      if (k.kind && !k.kind.includes(kind)) continue;
      if (k.key !== "__address_part" && !allowed.has(k.key)) continue;
      if (!w || !k.any.test(w) || k.not?.test(w)) continue;
      named.add(k.key);
    }
    for (const key of [...allowed, "__address_part" as const]) {
      const f = fit[key] ?? 0;
      const byName = named.has(key);
      // A header naming the field counts most; its values must not contradict it.
      let score = (byName ? 100 : 0) + f * 60;
      if (byName && f === 0 && ["recipient_phone", "sender_phone", "cod_amount", "weight_kg"].includes(key)) score -= 70;
      if (!byName && w && key !== "__address_part") score -= 25; // a named column that says something else
      if (score >= 40) candidates.push({ index: i, key, score, by: byName ? "header" : "data" });
    }
    // A District / Thana / Area column whose names aren't the catalog's: added to the address instead (places are found from it).
    if ([...named].some(k => PLACE_KEYS.has(k))) candidates.push({ index: i, key: "__address_part", score: 95, by: "header" });
  }

  // Best pairs first; each field once (address parts any number of times), each column once.
  const taken = new Set<MappedKey>();
  for (const c of candidates.sort((a, b) => b.score - a.score || a.index - b.index)) {
    const col = columns[c.index];
    if (col.key || (taken.has(c.key) && !MULTI_KEYS.has(c.key))) continue;
    // Place columns: only when the catalog knows most of the names, else they are address parts.
    if (PLACE_KEYS.has(c.key) && col.samples.length && (dataFit(body.map(r => clean(r[c.index])).filter(Boolean).slice(0, SAMPLE_ROWS), lists)[c.key.replace("pickup_", "") as MappedKey] ?? 0) < 0.7) continue;
    col.key = c.key;
    col.by = c.by;
    taken.add(c.key);
  }
  // Columns with values the merchant's last file matched (same headers): the saved choice wins.
  if (input.saved && header) {
    for (const col of columns) {
      const h = normalizeHeader(col.header);
      if (!h || !(h in input.saved)) continue;
      const key = input.saved[h];
      if (key && !MULTI_KEYS.has(key)) for (const other of columns) if (other !== col && other.key === key) other.key = other.by = null;
      col.key = key;
      col.by = "saved";
    }
  }
  const template = headerIndex >= 0 && columns.every(c => !c.samples.length || !!exact[c.index]);
  return { headerRow: headerIndex + 1, columns, signature: header ? layoutSignature(header) : "", template };
}

/** Checks a matching sent back by the dialog: known keys, each field once (address parts any number). */
export function checkMapping(kind: ImportKindKey, keys: (string | null)[]): { keys: (MappedKey | null)[]; problems: string[] } {
  const allowed = new Set<string>([...COLUMNS[kind].map(c => c.key), "__address_part", "__scan", ...(kind === "document" ? ["__cod"] : [])]);
  const seen = new Map<string, number>();
  const problems: string[] = [];
  const out = keys.map((k, i) => {
    if (!k || k === "__ignore") return null;
    if (!allowed.has(k)) {
      problems.push(`Column ${columnLetter(i)}: "${k}" is not a field of this template`);
      return null;
    }
    if (!MULTI_KEYS.has(k as MappedKey) && seen.has(k)) problems.push(`Columns ${columnLetter(seen.get(k)!)} and ${columnLetter(i)} are both ${COLUMNS[kind].find(c => c.key === k)?.header ?? k}: choose one`);
    seen.set(k, i);
    return k as MappedKey;
  });
  return { keys: out, problems };
}
