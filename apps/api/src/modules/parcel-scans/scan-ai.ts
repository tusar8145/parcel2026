import { Injectable, Logger } from "@nestjs/common";
import { env } from "../../config/env";
import type { Catalog } from "../pricing/pricing.service";
import { COLUMNS, type ColumnKey, type ImportKindKey } from "../imports/columns";
import { placeIn, normPlace, englishPlaces } from "./scan-geo";
import { moneyIn, normalizeText, phonesIn, weightFrom, type ScanCells } from "./scan-parser";

type Places = Pick<Catalog, "districts" | "zonesByDistrict" | "areasByZone">;

/** The fields asked of the model (place names as written; they are matched to the catalog afterwards). */
const FIELDS = {
  recipient_name: "the person receiving the parcel (To / Ship to / Customer / প্রাপক), not the shop or sender",
  recipient_phone: "the recipient's Bangladeshi mobile number, 11 digits starting 01",
  address: "the recipient's delivery address as written (house, road, area, city)",
  district: "the district or city of the delivery address as written",
  zone: "the thana / upazila / city area of the delivery address as written",
  area: "a smaller area or neighbourhood of the delivery address, if written",
  cod_amount: "the cash to collect from the recipient in taka, digits only (the total / COD / collect amount, not a single item price or the delivery charge); ৳ may appear as $, 5 or 8 before the number",
  weight_kg: "the parcel weight in kg (500 gm = 0.5)",
  order_ref: "the order / invoice / reference number",
  instructions: "a delivery note or instruction",
  sender_name: "the sender / shop (From / Sender / প্রেরক)",
  sender_phone: "the sender's mobile number",
} as const;
type Field = keyof typeof FIELDS;

const SYSTEM = `You read the text of Bangladeshi parcel labels (OCR output: English and/or Bangla, with OCR mistakes, lines may be out of order) and return the delivery order fields as JSON.
Rules:
- Copy values from the text; never invent. Use null when a field is not on the label.
- The recipient is who receives the parcel (To, Ship to, Deliver to, Customer, Receiver, প্রাপক). The sender is the shop or person sending it (From, Sender, Shipper, Seller, প্রেরক). Never mix them up.
- Phone numbers: Bangladeshi mobiles, 11 digits starting with 01 (drop +88). Bangla digits are fine.
- Amounts: digits only, no commas or currency.
- Keep Bangla text in Bangla.`;

/** Values the model returned that are really on the label (OCR slips of a letter or two forgiven). */
function grounded(value: string, text: string) {
  const words = (s: string) =>
    normPlace(englishPlaces(normalizeText(s)))
      .split(" ")
      .filter(w => w.length >= 2);
  const have = words(text);
  const want = words(value);
  if (!want.length) return false;
  const near = (w: string) => have.some(h => h === w || (w.length >= 5 && h.length >= 4 && Math.abs(h.length - w.length) <= 2 && [...w].filter((c, i) => h[i] === c).length >= w.length - 2));
  return want.filter(near).length / want.length >= 0.7;
}

/**
 * Combines the rules' reading (parseLabel) with the model's, keeping only what the label supports:
 * a phone must be a valid BD mobile printed on the label, an amount one of the label's amounts, a name
 * or address made of the label's words, a place one of the catalog's. The model decides who is the
 * recipient and the free-text fields; the rules keep the amount to collect and the weight (they follow
 * the COD / total keywords), and fill anything the model left out.
 */
export function mergeAi(rules: ScanCells, ai: Partial<Record<Field, string | number | null>>, text: string, kind: ImportKindKey, places: Places): ScanCells {
  const out: ScanCells = { ...rules };
  const str = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());
  const labelPhones = text.split(/\r?\n/).flatMap(phonesIn);
  for (const key of ["recipient_phone", "sender_phone"] as const) {
    const phone = phonesIn(str(ai[key]))[0];
    if (phone && labelPhones.includes(phone)) out[key] = phone;
  }
  if (out.sender_phone && out.sender_phone === out.recipient_phone) delete out.sender_phone;
  for (const key of ["recipient_name", "address", "instructions", "sender_name"] as const) {
    const value = str(ai[key]);
    // A "note" that is really the order number, an amount or a phone is not a delivery note.
    if (key === "instructions" && /\b(?:order|invoice|inv|ref|cod|total|tk|bdt)\b|৳|\d{5,}/i.test(normalizeText(value))) continue;
    if (value && grounded(value, text)) out[key] = value;
  }
  const ref = str(ai.order_ref);
  if (ref && new RegExp(ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(text)) out.order_ref ??= ref;
  if (!out.cod_amount) {
    const cod = Number(str(ai.cod_amount).replace(/[^\d.]/g, ""));
    const amounts = text.split(/\r?\n/).flatMap(moneyIn);
    if (cod > 0 && amounts.some(m => Math.abs(m.value - cod) < 0.01 || (m.alt !== undefined && Math.abs(m.alt - cod) < 0.01))) out.cod_amount = String(cod);
  }
  if (!out.weight_kg) {
    const kg = Number(str(ai.weight_kg));
    if (kg > 0 && kg <= 100 && weightFrom(text)) out.weight_kg = String(kg);
  }
  // Places: the model's names (and its address) matched to the catalog; else what the rules found.
  const place = placeIn([str(ai.area), str(ai.zone), str(ai.district), out.address ?? ""].filter(Boolean).join(", "), places);
  if (place.zone || (place.district && !out.zone)) {
    delete out.district;
    delete out.zone;
    delete out.area;
    Object.assign(out, place);
  }
  const allowed = new Set<string>(COLUMNS[kind].map(c => c.key));
  return Object.fromEntries(Object.entries(out).filter(([k, v]) => allowed.has(k) && v)) as ScanCells;
}

/**
 * A local language model (Ollama, e.g. qwen2.5:3b) reading the OCR text of a label into the order
 * fields: labels come in every layout, which fixed rules can't all know. Runs on this server or the
 * LAN (SCAN_AI_URL); off when it isn't set. Any failure or timeout falls back to the rules alone.
 */
@Injectable()
export class ScanAiService {
  private readonly logger = new Logger(ScanAiService.name);

  enabled() {
    return !!env().SCAN_AI_URL;
  }

  async extract(text: string, kind: ImportKindKey): Promise<Partial<Record<Field, string | number | null>> | null> {
    const url = env().SCAN_AI_URL;
    if (!url || !text.trim()) return null;
    const columns = new Set<string>(COLUMNS[kind].map(c => c.key as ColumnKey));
    const fields = (Object.keys(FIELDS) as Field[]).filter(f => columns.has(f));
    const schema = { type: "object", properties: Object.fromEntries(fields.map(f => [f, { type: ["string", "null"], description: FIELDS[f] }])), required: fields };
    const prompt = `Fields:\n${fields.map(f => `- ${f}: ${FIELDS[f]}`).join("\n")}\n\nLabel text:\n"""\n${text.slice(0, 3000)}\n"""`;
    try {
      const res = await fetch(`${url.replace(/\/+$/, "")}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(env().SCAN_AI_TIMEOUT_MS),
        body: JSON.stringify({
          model: env().SCAN_AI_MODEL,
          stream: false,
          format: schema,
          keep_alive: "30m",
          options: { temperature: 0, num_ctx: 4096 },
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: prompt },
          ],
        }),
      });
      if (!res.ok) throw new Error(`Ollama answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as { message?: { content?: string } };
      const parsed = JSON.parse(body.message?.content ?? "{}") as Record<string, unknown>;
      return Object.fromEntries(fields.map(f => [f, typeof parsed[f] === "string" || typeof parsed[f] === "number" ? (parsed[f] as string | number) : null]));
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : err }, "The label AI could not read a photo; the rules' reading is kept");
      return null;
    }
  }
}
