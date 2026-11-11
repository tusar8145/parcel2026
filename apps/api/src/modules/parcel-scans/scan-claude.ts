import { Injectable, Logger } from "@nestjs/common";
import Anthropic from "@anthropic-ai/sdk";
import { env } from "../../config/env";
import type { Catalog } from "../pricing/pricing.service";
import { COLUMNS, type ColumnKey, type ImportKindKey } from "../imports/columns";
import { placeIn } from "../geography/place-in-text";
import { phonesIn, type ScanCells } from "./scan-parser";

type Places = Pick<Catalog, "districts" | "zonesByDistrict" | "areasByZone">;
type Values = Partial<Record<ColumnKey, string | null>>;

/** The option lists Claude chooses from (delivery types, categories, priorities: the database's). */
export interface ScanLists {
  speeds: readonly string[];
  categories: readonly string[];
  priorities: readonly string[];
  /** AI import is on: with no product name written, Claude names the item from the photo (`product_seen`). */
  guessProduct?: boolean;
}

/** The extra field Claude fills when no product name is written (AI import on). */
const PRODUCT_SEEN =
  "Only when no product / item name is written: what the item is, from what the photo shows (the parcel's contents, its packaging or a picture on it), as a short generic product name (e.g. Shoes, Mobile phone cover, Cheque book, Saree). Empty when a product name is written, or when the photo doesn't show what the item is (never guess it from the shop name).";

/** What each import column means on a label (the model reads every column of the kind's template). */
const HINTS: Record<Exclude<ColumnKey, "service_level" | "category" | "priority">, string> = {
  sender_name: "the sender (From / Sender / Shipper / Seller / প্রেরক): a person or shop name",
  sender_phone: "the sender's Bangladeshi mobile, 11 digits starting 01",
  pickup_address: "the sender's / pickup address as written",
  pickup_district: "the district of the pickup address (exact name from the district list)",
  pickup_zone: "the thana / upazila of the pickup address (exact name from that district's list)",
  pickup_area: "a smaller area / neighbourhood of the pickup address, as written",
  recipient_name: "the person receiving the parcel (To / Ship to / Deliver to / Customer / Receiver / প্রাপক), never the shop or sender",
  recipient_phone: "the recipient's Bangladeshi mobile, 11 digits starting 01 (drop +88); copy every digit exactly",
  address: "the recipient's full delivery address as written (house, road, area, city)",
  district: "the district of the delivery address (exact name from the district list)",
  zone: "the thana / upazila of the delivery address (exact name from that district's list)",
  area: "a smaller area / neighbourhood of the delivery address, as written",
  product_type: "the product / item name (e.g. Women's Shoes, Cheque book)",
  cod_amount: "cash to collect from the recipient in taka, digits only: the COD / total / collect amount, not one item's price or the delivery charge; 0 when it says paid / prepaid",
  declared_value: "the value of the goods in taka, digits only, when written separately from the COD",
  weight_kg: "the parcel weight in kg (500 gm = 0.5)",
  open_box: "Yes when the label allows opening / checking before paying, else empty",
  order_ref: "the order / invoice / reference number",
  instructions: "a delivery note or instruction for the rider",
};

const SYSTEM = `You read photos of Bangladeshi parcel labels, delivery slips, invoices and order sheets (English and/or Bangla, printed or handwritten; the photo may be rotated, tilted, shadowed, cropped or show a table) and return the delivery order's fields.

Rules:
- Read only what is in the photo; never invent or guess. Use an empty string "" for a field that is not there or not readable.
- The recipient receives the parcel; the sender (shop / merchant / person) sends it. Never mix them up.
- Phone numbers: Bangladeshi mobiles, 11 digits starting with 01, with +88 / 88 dropped. Bangla digits become 0-9.
- Amounts: digits only (no commas, ৳, Tk or BDT). ৳ is the taka sign, not a digit (it is often printed like a 5 or 8 before the number).
- District and thana / upazila: choose the exact names from the list below that the address belongs to (an area or road name points to its thana). Leave them "" if the address doesn't say.
- Keep Bangla names and addresses in Bangla as written.`;

/** Models with the server-side fallback ("default" form). */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

/** The districts and their thanas / upazilas, as the catalog spells them (cached with the system prompt). */
const placeList = (p: Places) => `Districts and their thanas / upazilas:\n${p.districts.map(d => `${d}: ${(p.zonesByDistrict[d] ?? []).join(", ")}`).join("\n")}`;

/**
 * Claude reading the whole label from the photo (SCAN_READER=claude): every column of the kind's
 * template in one call, then each value checked for its form (a BD mobile, an amount, a catalog place).
 * The fields are null when the call fails, so the caller falls back to the local reader.
 */
@Injectable()
export class ScanClaudeService {
  private readonly logger = new Logger(ScanClaudeService.name);
  private client?: Anthropic;

  enabled() {
    return env().SCAN_READER === "claude" && !!env().ANTHROPIC_API_KEY;
  }

  /** The fields (null when the call failed), with the call's tokens, time and estimated cost for the usage log. */
  async extract(input: { image: Buffer; kind: ImportKindKey; places: Places; lists: ScanLists }): Promise<ClaudeRead | null> {
    if (!this.enabled()) return null;
    this.client ??= new Anthropic({ apiKey: env().ANTHROPIC_API_KEY, timeout: 120_000, maxRetries: 2 });
    const keys: string[] = COLUMNS[input.kind].map(c => c.key);
    const guess = !!input.lists.guessProduct && keys.includes("product_type");
    if (guess) keys.push("product_seen");
    const schema = {
      type: "object",
      // Plain strings ("" = not on the photo): the API allows at most 16 nullable (union) fields; a customer parcel has 20.
      properties: Object.fromEntries(keys.map(k => [k, { type: "string", description: k === "product_seen" ? PRODUCT_SEEN : hintOf(k as ColumnKey, input.lists) }])),
      required: keys,
      additionalProperties: false,
    };
    const model = env().SCAN_CLAUDE_MODEL;
    const started = Date.now();
    const read: ClaudeRead = { cells: null, model, ms: 0, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, costUsd: 0 };
    try {
      const response = await this.client.beta.messages.create({
        model,
        max_tokens: 16000,
        // A declined photo is re-read by another model, on the models that offer it (not Haiku).
        ...(FALLBACK_MODELS.has(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        output_config: { effort: env().SCAN_CLAUDE_EFFORT, format: { type: "json_schema", schema } },
        system: [{ type: "text", text: `${SYSTEM}\n\n${placeList(input.places)}`, cache_control: { type: "ephemeral" } }],
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: input.image.toString("base64") } },
              { type: "text", text: `Fill in every field of this ${input.kind === "document" ? "Banking & Financial document" : input.kind === "customer" ? "customer parcel" : "e-commerce order"} from the photo.` },
            ],
          },
        ],
      });
      const u = response.usage;
      read.model = response.model;
      read.tokens = { input: u.input_tokens, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, output: u.output_tokens };
      read.costUsd = costUsd(read.model, read.tokens);
      if (response.stop_reason === "refusal") throw new Error(`refused (${response.stop_details?.category ?? "no category"})`);
      if (response.stop_reason === "max_tokens") throw new Error("the answer was cut off");
      const text = response.content.flatMap(b => (b.type === "text" ? [b.text] : [])).join("");
      read.cells = fromClaude(JSON.parse(text) as Values, input.kind, input.places, input.lists);
    } catch (err) {
      read.error = (err instanceof Anthropic.APIError ? `${err.status ?? ""} ${err.message}` : err instanceof Error ? err.message : String(err)).trim().slice(0, 300);
      this.logger.warn({ reason: read.error }, "Claude could not read a parcel photo; the local reader is used");
    }
    read.ms = Date.now() - started;
    this.logger.log({ model: read.model, ms: read.ms, ...read.tokens, costUsd: read.costUsd }, "Claude read a parcel photo");
    return read;
  }
}

export interface ClaudeRead {
  /** The fields, or null when the call failed (the local reader takes over). */
  cells: ScanCells | null;
  model: string;
  ms: number;
  tokens: { input: number; cacheRead: number; cacheWrite: number; output: number };
  costUsd: number;
  error?: string;
}

/**
 * List prices in USD per million tokens (input, output, cache read, 5-minute cache write = 1.25 × input).
 * An estimate for the usage page; the bill is Anthropic Console › Usage. Unknown models count 0.
 */
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
};
export function costUsd(model: string, t: ClaudeRead["tokens"]): number {
  const p = PRICES[model];
  if (!p) return 0;
  return Math.round(((t.input * p.input + t.cacheWrite * p.input * 1.25 + t.cacheRead * p.cacheRead + t.output * p.output) / 1_000_000) * 1e6) / 1e6;
}

/** Claude's values kept only when they have the right form; places matched to the catalog. */
/** A column's hint; the list columns name their options. */
function hintOf(key: ColumnKey, lists: ScanLists) {
  if (key === "service_level") return `the delivery type if written (exactly one of: ${lists.speeds.join(", ")}), else empty`;
  if (key === "category") return `the product category that fits the item (exactly one of: ${lists.categories.join(", ")}), else empty`;
  if (key === "priority") return `a priority / handling tag if written (exactly one of: ${lists.priorities.join(", ")}), else empty`;
  return HINTS[key];
}

export function fromClaude(values: Values, kind: ImportKindKey, places: Places, lists: ScanLists = { speeds: [], categories: [], priorities: [] }): ScanCells {
  const str = (k: ColumnKey) => {
    const v = values[k];
    return typeof v === "string" ? v.trim() : "";
  };
  const out: ScanCells = {};
  for (const key of ["recipient_phone", "sender_phone"] as const) {
    const phone = phonesIn(str(key))[0];
    if (phone) out[key] = phone;
  }
  if (out.sender_phone && out.sender_phone === out.recipient_phone) delete out.sender_phone;
  for (const key of ["recipient_name", "sender_name"] as const) {
    const v = str(key);
    if (v && v.length <= 120 && !/\d{4,}/.test(v)) out[key] = v;
  }
  for (const [key, max] of [["address", 200], ["pickup_address", 200], ["instructions", 500], ["order_ref", 80], ["product_type", 120]] as const) {
    const v = str(key);
    if (v && v.length <= max && !/^(?:n\/?a|none|null|not provided)$/i.test(v)) out[key] = v;
  }
  // No product name written: the item as the photo shows it (AI import on); the import matches or creates the product.
  const seen = typeof (values as Record<string, unknown>).product_seen === "string" ? String((values as Record<string, unknown>).product_seen).trim() : "";
  if (!out.product_type && lists.guessProduct && seen && seen.length <= 80 && !/^(?:n\/?a|none|null|unknown|not provided|parcel|package|box|item)$/i.test(seen)) out.product_type = seen;
  for (const [key, max] of [["cod_amount", 1_000_000], ["declared_value", 1_000_000]] as const) {
    const digits = str(key).replace(/[,\s]/g, "").replace(/[^\d.]/g, "");
    const n = Number(digits);
    if (/\d/.test(digits) && Number.isFinite(n) && n >= 0 && n <= max) out[key] = String(n);
  }
  const kg = Number(str("weight_kg").replace(/[^\d.]/g, ""));
  if (kg > 0 && kg <= 50) out.weight_kg = String(kg);
  // List columns: kept only when they are one of the options (any case).
  const pick = (options: readonly string[], v: string) => options.find(o => o.toLowerCase() === v.toLowerCase());
  const service = pick(lists.speeds, str("service_level"));
  if (service) out.service_level = service;
  const category = pick(lists.categories, str("category"));
  if (category) out.category = category;
  const priority = pick(lists.priorities, str("priority"));
  if (priority) out.priority = priority;
  if (/^(?:yes|y|true)$/i.test(str("open_box"))) out.open_box = "Yes";
  // Places: the model's names (and the address) matched to the catalog.
  const delivery = placeIn([str("area"), str("zone"), str("district"), out.address ?? ""].filter(Boolean).join(", "), places);
  if (delivery.district) out.district = delivery.district;
  if (delivery.zone) out.zone = delivery.zone;
  if (delivery.area) out.area = delivery.area;
  else if (str("area") && str("area").length <= 120) out.area = str("area");
  if (kind === "customer") {
    const pickup = placeIn([str("pickup_area"), str("pickup_zone"), str("pickup_district"), out.pickup_address ?? ""].filter(Boolean).join(", "), places);
    if (pickup.district) out.pickup_district = pickup.district;
    if (pickup.zone) out.pickup_zone = pickup.zone;
    if (pickup.area) out.pickup_area = pickup.area;
  }
  const allowed = new Set<string>(COLUMNS[kind].map(c => c.key));
  return Object.fromEntries(Object.entries(out).filter(([k, v]) => allowed.has(k) && v)) as ScanCells;
}
