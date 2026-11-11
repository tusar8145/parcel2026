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

export const ADDRESS_AI_KEY = "address-ai";
const USAGE_KEY = "address-ai.usage";
const RECENT = 50;

export const addressAiSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  /** Estimated spend (list prices) per month in USD; at the limit the AI stops until next month. */
  monthlyLimitUsd: z.coerce.number().min(0).max(10_000).default(3),
  /** Addresses read per day (Dhaka time); at the limit the AI stops until tomorrow. 0 = no daily limit. */
  dailyLimit: z.coerce.number().int().min(0).max(100_000).default(1000),
});
export type AddressAiSettings = z.infer<typeof addressAiSettingsSchema>;
/** Only the fields sent change. */
export const updateAddressAiSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  monthlyLimitUsd: z.coerce.number().min(0).max(10_000).optional(),
  dailyLimit: z.coerce.number().int().min(0).max(100_000).optional(),
});

interface Tally {
  calls: number;
  found: number;
  notFound: number;
  errors: number;
  costUsd: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
interface Usage {
  months: Record<string, Tally>;
  days: Record<string, Tally>;
  recent: { at: string; trackingId: string; address: string; query: string | null; found: boolean; error?: string; costUsd: number }[];
}
const zero = (): Tally => ({ calls: 0, found: 0, notFound: 0, errors: 0, costUsd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/** Dhaka day and month keys (UTC+6). */
const dhakaKeys = (at = new Date()) => {
  const d = new Date(at.getTime() + 6 * 3600_000).toISOString();
  return { day: d.slice(0, 10), month: d.slice(0, 7) };
};

const SYSTEM = `You turn Bangladeshi delivery addresses into a search query for OpenStreetMap (Nominatim).
Addresses may mix Bangla and English, use abbreviations (H#, Rd, Sec, Blk, Hol), floor/flat details, phone numbers,
and landmarks ("near X mosque", "opposite Y school").

Return:
- query: the most findable form, in English, most specific first and comma separated: house/holding number, road,
  block/sector, area, zone (thana), district, "Bangladesh". Drop floor, flat, room, phone numbers, names of people and
  delivery notes. Expand abbreviations (Rd -> Road, Sec -> Sector). Transliterate Bangla place names to their usual
  English spelling.
- alternatives: up to 2 broader queries to try if the first is not found, e.g. the landmark with its area
  ("Gulshan Central Mosque, Gulshan, Dhaka, Bangladesh"), or just the road with its area.
Use only places written in the address or given as its area / zone / district. Do not invent places.`;

const SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string" },
    alternatives: { type: "array", items: { type: "string" } },
  },
  required: ["query", "alternatives"],
  additionalProperties: false,
};

/**
 * AI address reading (Operational settings › AI address reading, Setting "address-ai"): when an address can't be
 * found on the map as written, Claude rewrites it into a findable query (area, road, landmark) and the map search runs
 * again, so the route plan places the parcel at its address instead of the zone centre. Optional: off, over the
 * monthly USD limit or the daily limit, without an API key or failing, parcels are placed at their zone centre as
 * before (nothing blocks). Usage (calls, found, cost) is kept per day and month in Setting "address-ai.usage".
 */
@Injectable()
export class AddressAiService {
  private readonly logger = new Logger("AddressAi");
  private client?: Anthropic;
  /** Tests replace the call (no API key, no cost). */
  callOverride?: (address: string) => Promise<{ query: string; alternatives: string[]; tokens: Tokens; model: string }>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async settings(): Promise<AddressAiSettings> {
    const row = await this.prisma.setting.findUnique({ where: { key: ADDRESS_AI_KEY } });
    const parsed = addressAiSettingsSchema.safeParse(row?.value ?? {});
    return parsed.success ? parsed.data : addressAiSettingsSchema.parse({});
  }

  async saveSettings(actor: Actor, input: z.infer<typeof updateAddressAiSettingsSchema>, meta: RequestMeta) {
    const next = { ...(await this.settings()), ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as AddressAiSettings;
    await this.prisma.$transaction(async tx => {
      await tx.setting.upsert({ where: { key: ADDRESS_AI_KEY }, create: { key: ADDRESS_AI_KEY, value: next }, update: { value: next } });
      await this.audit.record(actor, { action: "address_ai.settings", entityType: "setting", entityId: ADDRESS_AI_KEY, data: next }, meta, tx);
    });
    return this.overview();
  }

  private async usage(): Promise<Usage> {
    const row = await this.prisma.setting.findUnique({ where: { key: USAGE_KEY } });
    const v = (row?.value ?? {}) as Partial<Usage>;
    return { months: v.months ?? {}, days: v.days ?? {}, recent: v.recent ?? [] };
  }

  /** Why the AI won't run now (null = it may). */
  async blocked(): Promise<string | null> {
    const s = await this.settings();
    if (!s.enabled) return "off";
    if (!env().ANTHROPIC_API_KEY && !this.callOverride) return "no API key";
    const u = await this.usage();
    const { day, month } = dhakaKeys();
    if ((u.months[month]?.costUsd ?? 0) >= s.monthlyLimitUsd) return "monthly limit reached";
    if (s.dailyLimit > 0 && (u.days[day]?.calls ?? 0) >= s.dailyLimit) return "daily limit reached";
    return null;
  }

  /** Settings, whether it runs now, this month and today, the last 30 days and the most recent addresses. */
  async overview() {
    const [settings, u, blocked] = await Promise.all([this.settings(), this.usage(), this.blocked()]);
    const { day, month } = dhakaKeys();
    const days = Object.entries(u.days)
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .slice(0, 30)
      .map(([date, t]) => ({ date, ...t }));
    const spent = u.months[month]?.costUsd ?? 0;
    return {
      settings,
      apiKey: !!env().ANTHROPIC_API_KEY,
      model: env().SCAN_CLAUDE_MODEL,
      running: !blocked,
      blocked,
      thisMonth: { month, ...zero(), ...u.months[month], remainingUsd: Math.max(0, Math.round((settings.monthlyLimitUsd - spent) * 1e6) / 1e6) },
      today: { date: day, ...zero(), ...u.days[day] },
      days,
      recent: u.recent,
    };
  }

  /**
   * Findable queries for an address (best first), or [] when the AI doesn't run or fails. Every call is counted
   * (cost, tokens); `found` is reported afterwards with {@link record}.
   */
  async queries(p: { trackingId: string; street: string; area?: string | null; zone?: string | null; district?: string | null }): Promise<{ queries: string[]; done: (found: boolean) => Promise<void> }> {
    const none = { queries: [], done: async () => undefined };
    if (await this.blocked()) return none;
    const address = [`Address: ${p.street}`, p.area ? `Area: ${p.area}` : "", p.zone ? `Zone (thana): ${p.zone}` : "", p.district ? `District: ${p.district}` : ""].filter(Boolean).join("\n");
    try {
      const r = await this.call(address);
      const cost = costUsd(r.model, r.tokens);
      const queries = [...new Set([r.query, ...r.alternatives].map(q => q.trim()).filter(q => q.length >= 3))].slice(0, 3);
      return {
        queries,
        done: found => this.record(p.trackingId, p.street, queries[0] ?? null, found, cost, r.tokens),
      };
    } catch (error) {
      const message = error instanceof Anthropic.APIError ? `${error.status ?? ""} ${error.message}` : error instanceof Error ? error.message : String(error);
      this.logger.warn(`Address AI failed: ${message}`);
      await this.record(p.trackingId, p.street, null, false, 0, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, message.slice(0, 200));
      return none;
    }
  }

  /** Adds one call to today's and this month's totals and the recent list (one row, locked, so calls can't race). */
  private async record(trackingId: string, address: string, query: string | null, found: boolean, cost: number, t: Tokens, error?: string) {
    const { day, month } = dhakaKeys();
    const add = (x: Tally | undefined): Tally => {
      const y = { ...zero(), ...x };
      return {
        calls: y.calls + 1,
        found: y.found + (found ? 1 : 0),
        notFound: y.notFound + (!found && !error ? 1 : 0),
        errors: y.errors + (error ? 1 : 0),
        costUsd: Math.round((y.costUsd + cost) * 1e6) / 1e6,
        input: y.input + t.input,
        output: y.output + t.output,
        cacheRead: y.cacheRead + t.cacheRead,
        cacheWrite: y.cacheWrite + t.cacheWrite,
      };
    };
    try {
      await this.prisma.$transaction(async tx => {
        await tx.$executeRaw`INSERT INTO settings (key, value, "updatedAt") VALUES (${USAGE_KEY}, '{}'::jsonb, now()) ON CONFLICT (key) DO NOTHING`;
        const rows = await tx.$queryRaw<{ value: Usage }[]>`SELECT value FROM settings WHERE key = ${USAGE_KEY} FOR UPDATE`;
        const v = (rows[0]?.value ?? {}) as Partial<Usage>;
        const u: Usage = { months: v.months ?? {}, days: v.days ?? {}, recent: v.recent ?? [] };
        u.months[month] = add(u.months[month]);
        u.days[day] = add(u.days[day]);
        // Days older than 62 days are dropped (the months keep the totals).
        const oldest = dhakaKeys(new Date(Date.now() - 62 * 86_400_000)).day;
        for (const d of Object.keys(u.days)) if (d < oldest) delete u.days[d];
        u.recent = [{ at: new Date().toISOString(), trackingId, address: address.slice(0, 200), query, found, ...(error ? { error } : {}), costUsd: cost }, ...u.recent].slice(0, RECENT);
        await tx.setting.update({ where: { key: USAGE_KEY }, data: { value: u as unknown as Prisma.InputJsonObject } });
      });
    } catch (e) {
      this.logger.warn(`Address AI usage not saved: ${e instanceof Error ? e.message : e}`);
    }
  }

  private async call(address: string): Promise<{ query: string; alternatives: string[]; tokens: Tokens; model: string }> {
    if (this.callOverride) return this.callOverride(address);
    this.client ??= new Anthropic({ apiKey: env().ANTHROPIC_API_KEY, timeout: 30_000, maxRetries: 1 });
    const response = await this.client.messages.create({
      model: env().SCAN_CLAUDE_MODEL,
      max_tokens: 2000,
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      // The same instructions on every call: cached.
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: address }],
    } as never);
    const r = response as unknown as Anthropic.Message;
    if (r.stop_reason === "max_tokens") throw new Error("the answer was cut off");
    if (r.stop_reason === "refusal") throw new Error("refused");
    const text = r.content.flatMap(b => (b.type === "text" ? [b.text] : [])).join("");
    const answer = JSON.parse(text) as { query?: string; alternatives?: string[] };
    const u = r.usage;
    return {
      query: String(answer.query ?? ""),
      alternatives: Array.isArray(answer.alternatives) ? answer.alternatives.map(String) : [],
      model: r.model,
      tokens: { input: u.input_tokens, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, output: u.output_tokens },
    };
  }
}

type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number };
