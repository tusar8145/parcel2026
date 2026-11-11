import { Injectable, Logger } from "@nestjs/common";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "../../config/env";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import type { Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { Prisma } from "../../generated/prisma/client";
import { costUsd } from "../parcel-scans/scan-claude";
import { GeographyService } from "../geography/geography.service";
import { resolvePlace } from "../parcels/places";
import { listOf } from "../packages/catalog.service";
import { productNameOfCell, type Cells, type EngineContext } from "./import-engine.service";

export const AI_IMPORT_KEY = "import-ai";

export const aiImportSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  /** Monthly spend limit in USD (estimated from the list prices); at the limit the AI stops until next month. */
  monthlyLimitUsd: z.coerce.number().min(0).max(10_000).default(5),
  /** The super admin's rule for new categories' channels, e.g. "Cards, PIN and cheques: SMS on…". */
  channelPrompt: z.string().trim().max(4000).default(""),
});
export type AiImportSettings = z.infer<typeof aiImportSettingsSchema>;
/** Only the fields sent change (no defaults here: a partial save never resets the others). */
export const updateAiImportSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  monthlyLimitUsd: z.coerce.number().min(0).max(10_000).optional(),
  channelPrompt: z.string().trim().max(4000).optional(),
});
export const aiUsageQuerySchema = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) });

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
/** Words that don't change what a product is (sizes, colours, packing). */
const NOISE = new Set(["xs", "s", "m", "l", "xl", "xxl", "xxxl", "2xl", "3xl", "free", "size", "pcs", "pc", "piece", "pieces", "set", "pack", "black", "white", "red", "blue", "green", "yellow", "pink", "grey", "gray", "brown", "navy", "new", "original"]);
/**
 * A product's matching key: lower case, "&" = "and", punctuation and spaces dropped, plurals made singular, sizes /
 * colours / quantities left out ("T-Shirts", "t shirt", "Tshirt XL Black" → "tshirt"). Two names with the same key
 * are the same product: the system never creates the second one.
 */
export function productKey(name: string) {
  const words = name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\(.*?\)/g, " ")
    .replace(/\b\d+(\.\d+)?\s*(ml|l|ltr|g|gm|gram|kg|pcs|pc|inch|in|cm|mm)\b/g, " ")
    .split(/[^a-z0-9\u0980-\u09ff]+/)
    .filter(w => w && !NOISE.has(w) && !/^\d+$/.test(w))
    .map(w => (w.length > 4 && w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.length > 4 && /(ches|shes|xes|sses)$/.test(w) ? w.slice(0, -2) : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
  return words.join("");
}
const CHUNK = 60;
const PARALLEL = 4;

interface ProductAnswer {
  i: number;
  existing: string;
  newProduct: string;
  category: string;
  newCategory: string;
  sms: boolean;
  email: boolean;
  push: boolean;
}
interface PlaceAnswer {
  i: number;
  district: string;
  zone: string;
  newZone: boolean;
  nearZone: string;
}
interface Answer {
  products: ProductAnswer[];
  places: PlaceAnswer[];
}
type Tokens = { input: number; cacheRead: number; cacheWrite: number; output: number };

/** What one file's AI step did (shown on the import and kept in the usage log). */
export interface AiImportResult {
  rows: { rowNumber: number; cells: Cells }[];
  /** Products, categories or zones were created: the caller reloads its lists. */
  created: boolean;
  usageId: string | null;
  note: string | null;
}

const SCHEMA = {
  type: "object",
  properties: {
    products: {
      type: "array",
      items: {
        type: "object",
        properties: {
          i: { type: "integer", description: "the item's number (P<i>)" },
          existing: { type: "string", description: "the exact name of the listed product that is the same thing (a spelling, size, colour or plural variant), else \"\"" },
          newProduct: { type: "string", description: "when no listed product is the same: a short, clean product name (Title Case, no size / colour / brand / quantity), else \"\"" },
          category: { type: "string", description: "for a new product: the exact name of the listed category it belongs to, else \"\"" },
          newCategory: { type: "string", description: "for a new product that fits no listed category: a short new category name, else \"\"" },
          sms: { type: "boolean", description: "new category only: send SMS (follow the channel rule)" },
          email: { type: "boolean", description: "new category only: send email (follow the channel rule)" },
          push: { type: "boolean", description: "new category only: send push (follow the channel rule)" },
        },
        required: ["i", "existing", "newProduct", "category", "newCategory", "sms", "email", "push"],
        additionalProperties: false,
      },
    },
    places: {
      type: "array",
      items: {
        type: "object",
        properties: {
          i: { type: "integer", description: "the item's number (A<i>)" },
          district: { type: "string", description: "the exact listed district of the delivery address, else \"\"" },
          zone: { type: "string", description: "the exact listed thana / upazila of that district the address is in; or, when the address is clearly in a real thana / upazila of that district that isn't listed, its proper name; else \"\"" },
          newZone: { type: "boolean", description: "true only when zone is a real thana / upazila that isn't in the district's list" },
          nearZone: { type: "string", description: "for a new zone: the listed zone of the same district nearest to it, else \"\"" },
        },
        required: ["i", "district", "zone", "newZone", "nearZone"],
        additionalProperties: false,
      },
    },
  },
  required: ["products", "places"],
  additionalProperties: false,
};

/**
 * AI import (Operational settings › AI import, Setting "import-ai"): an Excel file's product names and delivery
 * addresses that the system's lists don't match (after the free matching) go to Claude in a few batched calls.
 * - A product: the same listed product, or a new product in a listed category, or a new category too (its SMS /
 *   email / push from the super admin's channel prompt). Created at once (tagged AI created).
 * - An address: its listed district and thana; a real thana that isn't listed becomes a new zone of the district,
 *   served by the hub of the nearest zone (routed at once, tagged AI created).
 * Each decision is remembered (AiImportAlias), so the same name never goes to the AI again. Off, over the monthly
 * USD limit or failing: the file is checked as before (nothing blocks the import).
 */
@Injectable()
export class ImportAiService {
  private readonly logger = new Logger("ImportAi");
  private client?: Anthropic;
  /** Tests replace the call (no API key needed, no cost). */
  callOverride?: (system: string, user: string) => Promise<{ answer: Answer; tokens: Tokens; model: string }>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly geography: GeographyService,
  ) {}

  async settings(): Promise<AiImportSettings> {
    const row = await this.prisma.setting.findUnique({ where: { key: AI_IMPORT_KEY } });
    const parsed = aiImportSettingsSchema.safeParse(row?.value ?? {});
    return parsed.success ? parsed.data : aiImportSettingsSchema.parse({});
  }

  /** On, with an API key (or a test call). */
  async active() {
    return (await this.settings()).enabled && (!!env().ANTHROPIC_API_KEY || !!this.callOverride);
  }

  async saveSettings(actor: Actor, input: z.infer<typeof updateAiImportSettingsSchema>, meta: RequestMeta) {
    const next = { ...(await this.settings()), ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as AiImportSettings;
    await this.prisma.$transaction(async tx => {
      await tx.setting.upsert({ where: { key: AI_IMPORT_KEY }, create: { key: AI_IMPORT_KEY, value: next as unknown as Prisma.InputJsonObject }, update: { value: next as unknown as Prisma.InputJsonObject } });
      await this.audit.record(actor, { action: "import_ai.settings", entityType: "setting", entityId: AI_IMPORT_KEY, data: { enabled: next.enabled, monthlyLimitUsd: next.monthlyLimitUsd, promptChars: next.channelPrompt.length } }, meta, tx);
    });
    return this.overview();
  }

  private monthStart(month?: string) {
    // Months in Dhaka time (UTC+6).
    const now = new Date(Date.now() + 6 * 3600_000);
    const [y, m] = month ? month.split("-").map(Number) : [now.getUTCFullYear(), now.getUTCMonth() + 1];
    return { from: new Date(Date.UTC(y, m - 1, 1) - 6 * 3600_000), to: new Date(Date.UTC(y, m, 1) - 6 * 3600_000), key: `${y}-${String(m).padStart(2, "0")}` };
  }

  async spentThisMonth() {
    const { from } = this.monthStart();
    const s = await this.prisma.aiImportUsage.aggregate({ where: { createdAt: { gte: from } }, _sum: { costUsd: true } });
    return Number(s._sum.costUsd ?? 0);
  }

  /** Settings, this month's spend and what the AI created. */
  async overview() {
    const settings = await this.settings();
    const { from } = this.monthStart();
    const [month, products, categories, zones] = await Promise.all([
      this.prisma.aiImportUsage.aggregate({
        where: { createdAt: { gte: from } },
        _sum: { costUsd: true, inputTokens: true, cacheReadTokens: true, cacheWriteTokens: true, outputTokens: true, calls: true, products: true, places: true, productsCreated: true, categoriesCreated: true, zonesCreated: true },
        _count: { _all: true },
      }),
      this.prisma.parcelProduct.count({ where: { aiCreated: true } }),
      this.prisma.productCategory.count({ where: { aiCreated: true } }),
      this.prisma.deliveryZone.count({ where: { aiCreated: true } }),
    ]);
    const spent = Number(month._sum.costUsd ?? 0);
    return {
      settings,
      apiKey: !!env().ANTHROPIC_API_KEY,
      model: env().SCAN_CLAUDE_MODEL,
      thisMonth: {
        imports: month._count._all,
        calls: month._sum.calls ?? 0,
        costUsd: Math.round(spent * 1e6) / 1e6,
        remainingUsd: Math.max(0, Math.round((settings.monthlyLimitUsd - spent) * 1e6) / 1e6),
        tokens: { input: month._sum.inputTokens ?? 0, cacheRead: month._sum.cacheReadTokens ?? 0, cacheWrite: month._sum.cacheWriteTokens ?? 0, output: month._sum.outputTokens ?? 0 },
        products: month._sum.products ?? 0,
        places: month._sum.places ?? 0,
        productsCreated: month._sum.productsCreated ?? 0,
        categoriesCreated: month._sum.categoriesCreated ?? 0,
        zonesCreated: month._sum.zonesCreated ?? 0,
      },
      created: { products, categories, zones },
    };
  }

  async usage(query: z.infer<typeof aiUsageQuerySchema>) {
    const { from, to, key } = this.monthStart(query.month);
    const rows = await this.prisma.aiImportUsage.findMany({ where: { createdAt: { gte: from, lt: to } }, orderBy: { createdAt: "desc" }, take: query.limit });
    const users = await this.prisma.user.findMany({ where: { id: { in: rows.flatMap(r => (r.userId ? [r.userId] : [])) } }, select: { id: true, name: true } });
    const merchants = await this.prisma.merchant.findMany({ where: { id: { in: rows.flatMap(r => (r.merchantId ? [r.merchantId] : [])) } }, select: { id: true, name: true } });
    const total = await this.prisma.aiImportUsage.aggregate({ where: { createdAt: { gte: from, lt: to } }, _sum: { costUsd: true }, _count: { _all: true } });
    return {
      month: key,
      totalUsd: Number(total._sum.costUsd ?? 0),
      count: total._count._all,
      items: rows.map(r => ({
        ...r,
        costUsd: Number(r.costUsd),
        user: users.find(u => u.id === r.userId)?.name ?? null,
        merchant: merchants.find(m => m.id === r.merchantId)?.name ?? null,
      })),
    };
  }

  async setImportNumber(usageId: string | null, importNumber: string) {
    if (usageId) await this.prisma.aiImportUsage.update({ where: { id: usageId }, data: { importNumber } }).catch(() => undefined);
  }

  /**
   * The AI step of a file (after the free matching): unknown product names and addresses whose district / zone
   * aren't listed. Never throws: anything wrong leaves the rows as they were (with a note).
   */
  async enrich(ctx: EngineContext, rows: { rowNumber: number; cells: Cells }[], actor: Actor, meta: RequestMeta, merchantId: string | null): Promise<AiImportResult> {
    const result = await this.enrichRows(ctx, rows, actor, meta, merchantId);
    if (!(await this.active()) || !ctx.columns.some(c => c.key === "category")) return result;
    // Every row shows its category (before Product): its product's, unless the file named one.
    const products = await this.prisma.parcelProduct.findMany({ where: { segment: listOf(ctx.pkg.segment) }, select: { name: true, category: { select: { name: true, active: true } } } });
    const categoryOf = new Map(products.flatMap(p => (p.category?.active ? [[norm(p.name), p.category.name] as const] : [])));
    for (const r of result.rows) {
      const c = r.cells;
      if ((c.category ?? "").trim() || !(c.product_type ?? "").trim()) continue;
      const cat = categoryOf.get(norm(productNameOfCell(c.product_type!)));
      if (!cat) continue;
      c.category = cat;
      c.__auto = [...new Set([...(c.__auto ?? "").split(",").filter(Boolean), "category"])].join(",");
    }
    return result;
  }

  private async enrichRows(ctx: EngineContext, rows: { rowNumber: number; cells: Cells }[], actor: Actor, meta: RequestMeta, merchantId: string | null): Promise<AiImportResult> {
    const result: AiImportResult = { rows, created: false, usageId: null, note: null };
    if (!(await this.active())) return result;
    const settings = await this.settings();
    const list = listOf(ctx.pkg.segment);
    const columns = new Set(ctx.columns.map(c => c.key));
    const out = rows.map(r => ({ rowNumber: r.rowNumber, cells: { ...r.cells } }));
    const known = new Map(ctx.products.map(p => [norm(p.name), p.name]));
    const knownByKey = new Map(ctx.products.map(p => [productKey(p.name), p.name] as const).filter(([k]) => k));
    const categoryByName = new Map(ctx.categories.map(c => [norm(c.name), c]));

    // ── what the lists don't match ──
    const productAliases = new Map(
      (await this.prisma.aiImportAlias.findMany({ where: { kind: "PRODUCT", scope: list } })).map(a => [a.text, a.target] as const),
    );
    const zoneAliases = await this.prisma.aiImportAlias.findMany({ where: { kind: "ZONE" } });
    const zoneAlias = new Map(zoneAliases.map(a => [`${norm(a.scope)}|${a.text}`, a.target] as const));
    const unknownProducts = new Map<string, { raw: string; rows: number[] }>();
    const unknownPlaces: { row: number; district: string; zone: string; address: string }[] = [];
    out.forEach((r, idx) => {
      const c = r.cells;
      const raw = (c.product_type ?? "").trim();
      if (raw && columns.has("product_type")) {
        const name = productNameOfCell(raw);
        const sameKey = knownByKey.get(productKey(name));
        if (!known.has(norm(name)) && sameKey) c.product_type = sameKey;
        else if (!known.has(norm(name))) {
          const alias = productAliases.get(norm(name));
          if (alias && known.has(norm(alias))) c.product_type = known.get(norm(alias))!;
          else {
            const e = unknownProducts.get(norm(name)) ?? { raw: raw.replace(/\s+/g, " ").slice(0, 120), rows: [] };
            e.rows.push(idx);
            unknownProducts.set(norm(name), e);
          }
        }
      }
      if (columns.has("district") && columns.has("zone")) {
        const place = resolvePlace(ctx.catalog, c.district, c.zone);
        if (place.ok && place.district && place.zone) return;
        // A zone written this way before (in this district).
        if (place.ok && place.district && c.zone?.trim()) {
          const hit = zoneAlias.get(`${norm(place.district)}|${norm(c.zone)}`);
          if (hit && (ctx.catalog.zonesByDistrict[place.district] ?? []).includes(hit)) {
            c.zone = hit;
            return;
          }
        }
        const address = [c.address, c.area, c.zone, c.district].map(v => (v ?? "").trim()).filter(Boolean).join(", ");
        if (address) unknownPlaces.push({ row: idx, district: (c.district ?? "").trim(), zone: (c.zone ?? "").trim(), address: address.slice(0, 300) });
      }
    });
    // A file category that is listed: the product goes there without the AI.
    for (const [key, e] of [...unknownProducts]) {
      const named = e.rows.map(i => (out[i].cells.category ?? "").trim()).find(Boolean);
      const cat = named ? categoryByName.get(norm(named)) : undefined;
      if (!cat) continue;
      const product = await this.createProduct(list, e.raw, cat.id);
      if (product) {
        result.created = true;
        known.set(norm(product), product);
        for (const i of e.rows) out[i].cells.product_type = product;
        await this.remember("PRODUCT", list, key, product);
      }
      unknownProducts.delete(key);
    }
    if (!unknownProducts.size && !unknownPlaces.length) return { ...result, rows: out };

    // ── the monthly limit ──
    const spent = await this.spentThisMonth();
    if (spent >= settings.monthlyLimitUsd) return { ...result, rows: out, note: `AI import: this month's limit ($${settings.monthlyLimitUsd}) is reached; unmatched products and places were left as written.` };

    // ── the calls (batched, a few at once) ──
    const productItems = [...unknownProducts.entries()].map(([key, e], n) => ({ n: n + 1, key, ...e }));
    const placeItems = unknownPlaces.map((p, n) => ({ n: n + 1, ...p }));
    const system = this.systemPrompt(ctx, settings);
    const jobs: { products: typeof productItems; places: typeof placeItems }[] = [];
    for (let i = 0, j = 0; i < productItems.length || j < placeItems.length; ) {
      const products = productItems.slice(i, i + CHUNK);
      i += products.length;
      const places = placeItems.slice(j, j + (CHUNK - products.length || CHUNK));
      j += places.length;
      jobs.push({ products, places });
    }
    const tokens: Tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    let model = env().SCAN_CLAUDE_MODEL;
    let cost = 0;
    let error: string | null = null;
    const answers: Answer[] = [];
    const started = Date.now();
    for (let k = 0; k < jobs.length; k += PARALLEL) {
      if (spent + cost >= settings.monthlyLimitUsd) {
        error = "monthly limit reached during the file";
        break;
      }
      const batch = await Promise.all(
        jobs.slice(k, k + PARALLEL).map(job =>
          this.call(system, this.userPrompt(job.products, job.places)).catch(err => {
            error = (err instanceof Anthropic.APIError ? `${err.status ?? ""} ${err.message}` : err instanceof Error ? err.message : String(err)).trim().slice(0, 300);
            return null;
          }),
        ),
      );
      for (const b of batch) {
        if (!b) continue;
        answers.push(b.answer);
        model = b.model;
        tokens.input += b.tokens.input;
        tokens.cacheRead += b.tokens.cacheRead;
        tokens.cacheWrite += b.tokens.cacheWrite;
        tokens.output += b.tokens.output;
        cost += costUsd(b.model, b.tokens);
      }
    }

    // ── apply ──
    const counts = { productsMatched: 0, productsCreated: 0, categoriesCreated: 0, placesMatched: 0, zonesCreated: 0 };
    const productByN = new Map(productItems.map(p => [p.n, p]));
    const placeByN = new Map(placeItems.map(p => [p.n, p]));
    const newCategories = new Map<string, string>();
    for (const a of answers.flatMap(x => x.products ?? [])) {
      const item = productByN.get(a.i);
      if (!item) continue;
      productByN.delete(a.i);
      let name: string | null = null;
      const existing = a.existing?.trim() ? known.get(norm(a.existing)) : undefined;
      if (existing) {
        name = existing;
        counts.productsMatched++;
      } else if (a.newProduct?.trim()) {
        let categoryId = a.category?.trim() ? categoryByName.get(norm(a.category))?.id : undefined;
        if (!categoryId && a.newCategory?.trim()) {
          const catName = a.newCategory.trim().replace(/\s+/g, " ").slice(0, 80);
          categoryId = categoryByName.get(norm(catName))?.id ?? newCategories.get(norm(catName));
          if (!categoryId) {
            const channels = settings.channelPrompt.trim() ? { notifySms: !!a.sms, notifyEmail: !!a.email, notifyPush: !!a.push } : {};
            categoryId = (await this.createCategory(list, catName, channels)) ?? undefined;
            if (categoryId) {
              newCategories.set(norm(catName), categoryId);
              counts.categoriesCreated++;
            }
          }
        }
        const created = await this.createProduct(list, a.newProduct.trim().replace(/\s+/g, " ").slice(0, 120), categoryId ?? null);
        if (created) {
          name = created;
          if (!known.has(norm(created))) counts.productsCreated++;
          known.set(norm(created), created);
        }
      }
      if (!name) continue;
      for (const i of item.rows) out[i].cells.product_type = name;
      await this.remember("PRODUCT", list, item.key, name);
    }
    let catalog = ctx.catalog;
    for (const a of answers.flatMap(x => x.places ?? [])) {
      const item = placeByN.get(a.i);
      if (!item) continue;
      placeByN.delete(a.i);
      const district = catalog.districts.find(d => norm(d) === norm(a.district ?? ""));
      if (!district || !a.zone?.trim()) continue;
      const zones = catalog.zonesByDistrict[district] ?? [];
      let zone = zones.find(z => norm(z) === norm(a.zone));
      if (!zone && a.newZone) {
        const name = a.zone.trim().replace(/\s+/g, " ").slice(0, 60);
        // Zone names are unique in the country: a name used elsewhere isn't created again.
        const elsewhere = catalog.districts.some(d => (catalog.zonesByDistrict[d] ?? []).some(z => norm(z) === norm(name)));
        if (!elsewhere && name.length >= 2) {
          zone = (await this.createZone(actor, meta, district, name, a.nearZone)) ?? undefined;
          if (zone) {
            counts.zonesCreated++;
            result.created = true;
            catalog = { ...catalog, zonesByDistrict: { ...catalog.zonesByDistrict, [district]: [...zones, zone] } };
          }
        }
      }
      if (!zone) continue;
      counts.placesMatched++;
      const cells = out[item.row].cells;
      if (item.zone && norm(item.zone) !== norm(zone)) await this.remember("ZONE", district, norm(item.zone), zone);
      cells.district = district;
      cells.zone = zone;
      cells.__auto = [...new Set([...(cells.__auto ?? "").split(",").filter(Boolean), "district", "zone"])].join(",");
    }
    if (counts.productsCreated || counts.categoriesCreated || counts.zonesCreated) result.created = true;

    const usage = await this.prisma.aiImportUsage.create({
      data: {
        merchantId,
        userId: actor.kind === "user" ? actor.userId : null,
        products: productItems.length,
        places: placeItems.length,
        ...counts,
        calls: answers.length,
        model,
        inputTokens: tokens.input,
        cacheReadTokens: tokens.cacheRead,
        cacheWriteTokens: tokens.cacheWrite,
        outputTokens: tokens.output,
        costUsd: Math.round(cost * 1e6) / 1e6,
        ms: Date.now() - started,
        error,
      },
    });
    this.logger.log({ ...counts, calls: answers.length, ...tokens, costUsd: cost, error }, "AI import step");
    return {
      rows: out,
      created: result.created,
      usageId: usage.id,
      note: error && !answers.length ? `AI import couldn't run (${error}); unmatched products and places were left as written.` : null,
    };
  }

  private systemPrompt(ctx: EngineContext, settings: AiImportSettings) {
    const byCategory = new Map<string, string[]>();
    for (const p of ctx.products) {
      const c = p.category?.name ?? "No category";
      byCategory.set(c, [...(byCategory.get(c) ?? []), p.name]);
    }
    const categories = ctx.categories.map(c => `- ${c.name} (SMS ${c.notifySms ? "on" : "off"}, email ${c.notifyEmail ? "on" : "off"}, push ${c.notifyPush ? "on" : "off"}): ${(byCategory.get(c.name) ?? []).join(", ")}`).join("\n");
    const places = ctx.catalog.districts.map(d => `${d}: ${(ctx.catalog.zonesByDistrict[d] ?? []).join(", ")}`).join("\n");
    return `You match a Bangladeshi courier's Excel orders to its lists. Products are what is being sent; places are delivery addresses.

Products (P items): for each name, if a listed product is the same thing (a spelling, plural, size, colour, brand or quantity variant), give it as "existing". Otherwise make a short clean "newProduct" name and put it in the listed category it fits ("category"); only if no category fits, give a "newCategory" (short, general, like the listed ones) and its sms / email / push from the channel rule.

Places (A items): give the listed district and its listed thana / upazila ("zone") the address is in; an area, road or neighbourhood name points to its thana. Only when the address is clearly in a real thana / upazila of that district that is not listed, give its proper name with newZone true and the nearest listed zone of the district as "nearZone". Never invent places: leave "" when unsure.

Never make a new product that is a listed product under another name (no duplicates); P items that are the same thing get the same newProduct name. Answer every item. Use the exact spelling of listed names.

Channel rule for new categories (the super admin's): ${settings.channelPrompt.trim() || "SMS, email and push on."}

Categories and their products:
${categories}

Districts and their thanas / upazilas:
${places}`;
  }

  private userPrompt(products: { n: number; raw: string }[], places: { n: number; district: string; zone: string; address: string }[]) {
    const lines = [
      ...products.map(p => `P${p.n}: ${p.raw}`),
      ...places.map(p => `A${p.n}: ${p.address}${p.district ? ` | district written: ${p.district}` : ""}${p.zone ? ` | zone written: ${p.zone}` : ""}`),
    ];
    return `Match these:\n${lines.join("\n")}`;
  }

  private async call(system: string, user: string): Promise<{ answer: Answer; tokens: Tokens; model: string }> {
    if (this.callOverride) return this.callOverride(system, user);
    this.client ??= new Anthropic({ apiKey: env().ANTHROPIC_API_KEY, timeout: 90_000, maxRetries: 2 });
    const response = await this.client.beta.messages.create({
      model: env().SCAN_CLAUDE_MODEL,
      max_tokens: 12000,
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      // The lists (categories, products, places) and the rules are the same for every call: cached.
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
    } as never);
    const r = response as unknown as Anthropic.Message;
    if (r.stop_reason === "max_tokens") throw new Error("the answer was cut off");
    if (r.stop_reason === "refusal") throw new Error("refused");
    const text = r.content.flatMap(b => (b.type === "text" ? [b.text] : [])).join("");
    const u = r.usage;
    return {
      answer: JSON.parse(text) as Answer,
      model: r.model,
      tokens: { input: u.input_tokens, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, output: u.output_tokens },
    };
  }

  private async remember(kind: "PRODUCT" | "ZONE", scope: string, text: string, target: string) {
    await this.prisma.aiImportAlias
      .upsert({ where: { kind_scope_text: { kind, scope, text } }, create: { kind, scope, text, target }, update: { target } })
      .catch(() => undefined);
  }

  /** The product (created when new, tagged AI created); its name, or null. */
  private async createProduct(list: "ECOMMERCE" | "BANKING_FINANCIAL", name: string, categoryId: string | null): Promise<string | null> {
    if (name.length < 2) return null;
    const key = productKey(name);
    const all = await this.prisma.parcelProduct.findMany({ where: { segment: list }, select: { name: true, active: true, id: true } });
    const existing = all.find(p => norm(p.name) === norm(name)) ?? (key ? all.find(p => productKey(p.name) === key) : undefined);
    if (existing) {
      if (!existing.active) await this.prisma.parcelProduct.update({ where: { id: existing.id }, data: { active: true } });
      return existing.name;
    }
    const last = await this.prisma.parcelProduct.aggregate({ where: { segment: list, categoryId }, _max: { sortOrder: true } });
    const created = await this.prisma.parcelProduct
      .create({ data: { segment: list, name, type: list === "BANKING_FINANCIAL" ? "DOCUMENT" : "REGULAR", categoryId, sortOrder: (last._max.sortOrder ?? 0) + 1, aiCreated: true } })
      .catch(() => null);
    if (created) await this.audit.record("system", { action: "parcel_product.ai_create", entityType: "parcel_product", entityId: created.id, data: { name, categoryId } });
    return created?.name ?? (await this.prisma.parcelProduct.findFirst({ where: { segment: list, name: { equals: name, mode: "insensitive" } }, select: { name: true } }))?.name ?? null;
  }

  private async createCategory(list: "ECOMMERCE" | "BANKING_FINANCIAL", name: string, channels: { notifySms?: boolean; notifyEmail?: boolean; notifyPush?: boolean }): Promise<string | null> {
    const existing = await this.prisma.productCategory.findFirst({ where: { segment: list, name: { equals: name, mode: "insensitive" } }, select: { id: true } });
    if (existing) return existing.id;
    const last = await this.prisma.productCategory.aggregate({ where: { segment: list }, _max: { sortOrder: true } });
    const created = await this.prisma.productCategory.create({ data: { segment: list, name, sortOrder: (last._max.sortOrder ?? 0) + 1, aiCreated: true, ...channels } }).catch(() => null);
    if (created) await this.audit.record("system", { action: "product_category.ai_create", entityType: "product_category", entityId: created.id, data: { name, ...channels } });
    return created?.id ?? null;
  }

  /** A new zone of the district, served by the nearest zone's hub (else the district's usual hub). */
  private async createZone(actor: Actor, meta: RequestMeta, district: string, name: string, nearZone: string): Promise<string | null> {
    const near = nearZone?.trim() ? await this.prisma.deliveryZone.findFirst({ where: { district: { equals: district, mode: "insensitive" }, name: { equals: nearZone.trim(), mode: "insensitive" }, hubId: { not: null } }, select: { hubId: true } }) : null;
    let hubId = near?.hubId ?? null;
    if (!hubId) {
      const usual = await this.prisma.deliveryZone.groupBy({ by: ["hubId"], where: { district: { equals: district, mode: "insensitive" }, hubId: { not: null }, active: true }, _count: { _all: true }, orderBy: { _count: { hubId: "desc" } }, take: 1 });
      hubId = usual[0]?.hubId ?? null;
    }
    try {
      const r = await this.geography.createZone(actor, { district, name, ...(hubId ? { hubId } : {}) } as never, meta);
      await this.prisma.deliveryZone.updateMany({ where: { district: { equals: district, mode: "insensitive" }, name: { equals: name, mode: "insensitive" } }, data: { aiCreated: true } });
      return (r as { zone: string }).zone;
    } catch (err) {
      this.logger.warn({ err, district, name }, "AI import could not create a zone");
      return null;
    }
  }
}
