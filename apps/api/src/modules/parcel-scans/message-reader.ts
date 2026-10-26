import { Controller, HttpCode, Injectable, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import { Public } from "../../common/auth/decorators";
import { ApiZodBody, ZBody } from "../../common/zod";
import { PricingService } from "../pricing/pricing.service";
import { mergeAi, ScanAiService } from "./scan-ai";
import { normalizeText, parseLabel, tidy, type ScanCells } from "./scan-parser";

export const parseMessageSchema = z.object({
  /** A message copied from SMS, WhatsApp, another platform…: name, phone, address, amount in any order, English or Bangla. */
  text: z.string().trim().min(5, "Paste the message").max(3000, "Paste up to 3,000 characters"),
  /** Whose form: customer (website), ecommerce or document (merchant panels). */
  kind: z.enum(["customer", "ecommerce", "document"]).default("customer"),
});

const PHONE = /(?:\+?88[\s-]?)?0?1[3-9](?:[\s-]?\d){8}/;
/** Where an address written after the phone ends: the amount, a greeting, a link. */
const ADDRESS_END = /(?:\b(?:total|cod|bill|amount|price|payable|collect|tk|taka|bdt|thanks?|thank\s*you|order|invoice|https?)\b|৳|টাকা|ধন্যবাদ|মোট)/iu;
const LABEL_WORD = /^(?:name|customer|receiver|recipient|to|deliver\s*to|প্রাপক|নাম)\s*[:：\-–]?\s*/iu;

/**
 * A message with no labels, one line or a few: "Karim Mia 01911223344 Mirpur 10, Block C, Road 3, Dhaka. Total 2200":
 * the words before the phone are the name, the text after it (up to the amount / thanks) the address.
 * Fills only what the label rules left empty.
 */
export function unlabelled(text: string, fields: ScanCells): ScanCells {
  const out = { ...fields };
  const lines = normalizeText(text)
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);
  const i = lines.findIndex(l => PHONE.test(l));
  if (i < 0) return out;
  const line = lines[i];
  const m = line.match(PHONE)!;
  const before = line.slice(0, m.index).replace(LABEL_WORD, "").replace(/[,;:\-–|]+\s*$/, "").trim();
  let after = line.slice(m.index! + m[0].length).replace(/^[\s,;:\-–|.]+/, "");
  // The address may go on in the next lines (until a line with the amount or a greeting).
  for (const next of lines.slice(i + 1)) {
    if (ADDRESS_END.test(next) && !after) break;
    if (ADDRESS_END.test(after)) break;
    after = after ? `${after}, ${next}` : next;
  }
  const end = after.search(ADDRESS_END);
  if (end >= 0) after = after.slice(0, end);
  after = after.replace(/[\s,;.।\-–]+$/u, "").trim();
  // A name: a few words of letters (English or Bangla), no digits.
  if (!out.recipient_name && before && !/\d/.test(before) && before.split(/\s+/).length <= 5 && /\p{L}/u.test(before)) out.recipient_name = tidy(before);
  if (!out.address && after.length >= 6 && /\p{L}/u.test(after)) out.address = tidy(after);
  // The name on a line of its own ("Abdul alim" / address / phone, in any order): the first line that reads
  // as a person's name — a few words of letters, not an address, a greeting or an order line.
  const others = lines.filter((_, k) => k !== i);
  if (!out.recipient_name) {
    const name = others.find(l => {
      const t = l.replace(LABEL_WORD, "").trim();
      return t && !/\d/.test(t) && t.split(/\s+/).length <= 5 && /^[\p{L}\p{M}.\s'-]+$/u.test(t) && !ADDRESS_LIKE.test(t) && !NOT_A_NAME.test(t);
    });
    if (name) out.recipient_name = tidy(name.replace(LABEL_WORD, ""));
  }
  // The address on lines of their own: the address-like lines (not the name, the phone, the amount).
  if (!out.address) {
    const parts = others.filter(l => l !== out.recipient_name && !ADDRESS_END.test(l) && (ADDRESS_LIKE.test(l) || /\d/.test(l)) && !PHONE.test(l));
    const joined = parts.join(", ").replace(/[\s,;.।\-–]+$/u, "").trim();
    if (joined.length >= 6) out.address = tidy(joined);
  }
  // The address ends where the amount / thanks start ("…, Road 15 cod 1200").
  if (out.address) {
    const end = out.address.search(ADDRESS_END);
    const kept = end > 0 ? out.address.slice(0, end).replace(/[\s,;.।\-–]+$/u, "").trim() : "";
    if (kept.length >= 6) out.address = tidy(kept);
  }
  // The name written into the address line ("Abdul alim Bashundhara residential area, …"): the words before
  // the first place found in it (its area / zone / district) or the first address word.
  if (!out.recipient_name && out.address) {
    const places = [out.area, out.zone, out.district].map(p => (p ?? "").split(/[\s(]/)[0]).filter(w => w.length >= 3);
    const lower = out.address.toLowerCase();
    const at = places.map(w => lower.search(new RegExp(`(?:^|\\s)${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u"))).filter(k => k > 0);
    // "Bashundhara residential area", "Mirpur road": the place's own name is the word before such a word.
    const named = out.address.match(/\s(\S+)\s+(?:residential|r\/a|area|road|rd|para|bazar|market|more|mor|lane|avenue|city)\b/iu);
    const keyword = named ? named.index! + 1 : out.address.search(ADDRESS_LIKE);
    const cut = at.length ? Math.min(...at) : keyword > 0 ? keyword : -1;
    const prefix = cut > 0 ? out.address.slice(0, cut).replace(/[\s,;:\-–]+$/, "").trim() : "";
    const words = prefix.split(/\s+/).filter(Boolean);
    if (words.length >= (at.length ? 1 : 2) && words.length <= 4 && /^[\p{L}\p{M}.\s'-]+$/u.test(prefix) && !ADDRESS_LIKE.test(prefix) && !NOT_A_NAME.test(prefix)) {
      out.recipient_name = tidy(prefix);
      out.address = tidy(out.address.slice(cut).replace(/^[\s,;:\-–]+/, ""));
    }
  }
  return out;
}

/** Words of an address (a line with them isn't a name). */
const ADDRESS_LIKE = /\b(?:house|h#|road|rd|block|sector|lane|avenue|area|residential|r\/a|village|vill|para|thana|upazila|union|post|flat|floor|bazar|market|more|mor|city|district|dhaka|chattogram|sylhet|khulna|rajshahi|barishal|rangpur|mymensingh|gazipur|narayanganj)\b|বাসা|বাড়ি|রোড|গ্রাম|থানা|উপজেলা|জেলা|এলাকা|ব্লক|সেক্টর/iu;
/** Greetings and order lines (not a name). */
const NOT_A_NAME = /\b(?:dear|hi|hello|hey|sir|madam|order|confirmed|thanks?|thank|please|parcel|delivery|details|regards|customer\s+details|shop|store)\b|প্রিয়|ধন্যবাদ|অর্ডার/iu;

/**
 * "Paste a message, fill the form": the order fields found in a copied message, by the same reading as a
 * scanned label (parcel-scans/scan-parser.ts: recipient vs sender, BD mobile numbers, the address and its
 * catalog district / zone / area — Bangla place names too —, the amount to collect, weight, note), plus the
 * local language model when one is set up (SCAN_AI_URL). Only fields the message really has are returned;
 * the form fills its empty fields with them.
 */
@Injectable()
export class MessageReaderService {
  constructor(
    private readonly pricing: PricingService,
    private readonly ai: ScanAiService,
  ) {}

  async read(input: z.infer<typeof parseMessageSchema>): Promise<{ fields: ScanCells; ai: boolean }> {
    const catalog = await this.pricing.catalog();
    let fields = unlabelled(input.text, parseLabel(input.text, input.kind, catalog));
    const ai = await this.ai.extract({ text: input.text, kind: input.kind }).catch(() => null);
    if (ai && !ai.vision) fields = mergeAi(fields, ai.values, input.text, input.kind, catalog);
    return { fields, ai: !!ai };
  }
}

@ApiTags("parcels")
@Controller()
export class MessageReaderController {
  constructor(private readonly reader: MessageReaderService) {}

  /** The order fields in a pasted message (website booking and the merchant panels' order form). Nothing is stored. */
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post("parse-message")
  @HttpCode(200)
  @ApiZodBody(parseMessageSchema)
  parse(@ZBody(parseMessageSchema) body: z.infer<typeof parseMessageSchema>) {
    return this.reader.read(body);
  }
}
