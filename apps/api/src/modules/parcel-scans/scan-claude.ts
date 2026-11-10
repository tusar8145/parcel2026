import { Injectable, Logger } from "@nestjs/common";
import Anthropic from "@anthropic-ai/sdk";
import { SPEED_LABEL } from "@delivery-fast/shared";
import { env } from "../../config/env";
import type { Catalog } from "../pricing/pricing.service";
import { COLUMNS, type ColumnKey, type ImportKindKey } from "../imports/columns";
import { placeIn } from "../geography/place-in-text";
import { phonesIn, type ScanCells } from "./scan-parser";

type Places = Pick<Catalog, "districts" | "zonesByDistrict" | "areasByZone">;
type Values = Partial<Record<ColumnKey, string | null>>;

/** What each import column means on a label (the model reads every column of the kind's template). */
const HINTS: Record<ColumnKey, string> = {
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
  service_level: `the delivery service if written: one of ${Object.values(SPEED_LABEL).join(", ")}`,
  open_box: "Yes when the label allows opening / checking before paying, else null",
  order_ref: "the order / invoice / reference number",
  instructions: "a delivery note or instruction for the rider",
};

const SYSTEM = `You read photos of Bangladeshi parcel labels, delivery slips, invoices and order sheets (English and/or Bangla, printed or handwritten; the photo may be rotated, tilted, shadowed, cropped or show a table) and return the delivery order's fields.

Rules:
- Read only what is in the photo; never invent or guess. Use null for a field that is not there or not readable.
- The recipient receives the parcel; the sender (shop / merchant / person) sends it. Never mix them up.
- Phone numbers: Bangladeshi mobiles, 11 digits starting with 01, with +88 / 88 dropped. Bangla digits become 0-9.
- Amounts: digits only (no commas, ৳, Tk or BDT). ৳ is the taka sign, not a digit (it is often printed like a 5 or 8 before the number).
- District and thana / upazila: choose the exact names from the list below that the address belongs to (an area or road name points to its thana). Leave them null if the address doesn't say.
- Keep Bangla names and addresses in Bangla as written.`;

/** The districts and their thanas / upazilas, as the catalog spells them (cached with the system prompt). */
const placeList = (p: Places) => `Districts and their thanas / upazilas:\n${p.districts.map(d => `${d}: ${(p.zonesByDistrict[d] ?? []).join(", ")}`).join("\n")}`;

/**
 * Claude reading the whole label from the photo (SCAN_READER=claude): every column of the kind's
 * template in one call, then each value checked for its form (a BD mobile, an amount, a catalog place).
 * Null when it fails, so the caller can fall back to the local reader.
 */
@Injectable()
export class ScanClaudeService {
  private readonly logger = new Logger(ScanClaudeService.name);
  private client?: Anthropic;

  enabled() {
    return env().SCAN_READER === "claude" && !!env().ANTHROPIC_API_KEY;
  }

  async extract(input: { image: Buffer; kind: ImportKindKey; places: Places }): Promise<ScanCells | null> {
    if (!this.enabled()) return null;
    this.client ??= new Anthropic({ apiKey: env().ANTHROPIC_API_KEY, timeout: 120_000, maxRetries: 2 });
    const keys = COLUMNS[input.kind].map(c => c.key);
    const schema = {
      type: "object",
      properties: Object.fromEntries(keys.map(k => [k, { type: ["string", "null"], description: HINTS[k] }])),
      required: keys,
      additionalProperties: false,
    };
    try {
      const response = await this.client.beta.messages.create({
        model: env().SCAN_CLAUDE_MODEL,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
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
      if (response.stop_reason === "refusal") throw new Error(`refused (${response.stop_details?.category ?? "no category"})`);
      if (response.stop_reason === "max_tokens") throw new Error("the answer was cut off");
      const text = response.content.flatMap(b => (b.type === "text" ? [b.text] : [])).join("");
      return fromClaude(JSON.parse(text) as Values, input.kind, input.places);
    } catch (err) {
      const reason = err instanceof Anthropic.APIError ? `${err.status ?? ""} ${err.message}` : err instanceof Error ? err.message : String(err);
      this.logger.warn({ err: reason }, "Claude could not read a parcel photo; the local reader is used");
      return null;
    }
  }
}

/** Claude's values kept only when they have the right form; places matched to the catalog. */
export function fromClaude(values: Values, kind: ImportKindKey, places: Places): ScanCells {
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
  for (const [key, max] of [["cod_amount", 1_000_000], ["declared_value", 1_000_000]] as const) {
    const digits = str(key).replace(/[,\s]/g, "").replace(/[^\d.]/g, "");
    const n = Number(digits);
    if (/\d/.test(digits) && Number.isFinite(n) && n >= 0 && n <= max) out[key] = String(n);
  }
  const kg = Number(str("weight_kg").replace(/[^\d.]/g, ""));
  if (kg > 0 && kg <= 50) out.weight_kg = String(kg);
  const service = Object.values(SPEED_LABEL).find(s => s.toLowerCase() === str("service_level").toLowerCase());
  if (service) out.service_level = service;
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
