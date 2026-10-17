import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { z } from "zod";
import { PrismaService, type Db } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { AppError } from "../../common/errors";
import type { Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import type { Prisma } from "../../generated/prisma/client";
import { COLUMNS, IMPORT_KINDS, KIND_LABEL, type ColumnKey, type ImportKindKey } from "./columns";

export const IMPORT_CONFIG_KEY = "import-config";

/**
 * Hard ceilings for the limits super admins can set, from the benchmark on the development
 * machine (test/imports.bench.test.ts): validating 10,000 rows (480 KB .xlsx) takes ~4 s and ~380 MB
 * extra memory; booking runs in the background at ~80 rows/s (10,000 rows ≈ 2 min). 20,000 rows keeps
 * one validation under ~10 s / ~1 GB; larger files should be split.
 */
export const LIMIT_CEILINGS = { maxRows: 20_000, maxFileMb: 20, perMerchantConcurrent: 3, globalConcurrent: 8 } as const;
export const DEFAULT_LIMITS = { merchantMaxRows: 5_000, opsMaxRows: 10_000, maxFileMb: 10, perMerchantConcurrent: 1, globalConcurrent: 4 } as const;

const columnSetting = z.object({
  required: z.boolean().optional(),
  /** Used when the cell is empty; empty string or null removes the default. */
  default: z.string().trim().max(120).nullable().optional(),
});

export const importConfigSchema = z.object({
  templates: z
    .object({
      ecommerce: z.record(z.string(), columnSetting).optional(),
      document: z.record(z.string(), columnSetting).optional(),
      customer: z.record(z.string(), columnSetting).optional(),
    })
    .optional(),
  /** Where orders without a destination are priced to until completed. */
  defaultDestination: z
    .discriminatedUnion("mode", [
      z.object({ mode: z.literal("MERCHANT_CITY") }),
      z.object({ mode: z.literal("FIXED"), district: z.string().trim().min(1).max(80), zone: z.string().trim().min(1).max(80) }),
    ])
    .optional(),
  limits: z
    .object({
      merchantMaxRows: z.number().int().min(1).max(LIMIT_CEILINGS.maxRows, `At most ${LIMIT_CEILINGS.maxRows} rows per file`),
      opsMaxRows: z.number().int().min(1).max(LIMIT_CEILINGS.maxRows, `At most ${LIMIT_CEILINGS.maxRows} rows per file`),
      maxFileMb: z.number().min(0.1).max(LIMIT_CEILINGS.maxFileMb, `At most ${LIMIT_CEILINGS.maxFileMb} MB per file`),
      perMerchantConcurrent: z.number().int().min(1).max(LIMIT_CEILINGS.perMerchantConcurrent),
      globalConcurrent: z.number().int().min(1).max(LIMIT_CEILINGS.globalConcurrent),
    })
    .partial()
    .optional(),
});
export type ImportConfigInput = z.infer<typeof importConfigSchema>;

export interface ColumnSettings {
  required: boolean;
  default: string | null;
}
export interface ImportSettings {
  templates: Record<ImportKindKey, Record<ColumnKey, ColumnSettings>>;
  defaultDestination: { mode: "MERCHANT_CITY" } | { mode: "FIXED"; district: string; zone: string };
  limits: { merchantMaxRows: number; opsMaxRows: number; maxFileMb: number; perMerchantConcurrent: number; globalConcurrent: number };
}

/** Built-in settings: the column definitions' required flags and defaults. */
function builtIn(): ImportSettings {
  const templates = Object.fromEntries(
    IMPORT_KINDS.map(kind => [kind, Object.fromEntries(COLUMNS[kind].map(col => [col.key, { required: col.required, default: col.default ?? null }]))]),
  ) as ImportSettings["templates"];
  return { templates, defaultDestination: { mode: "MERCHANT_CITY" }, limits: { ...DEFAULT_LIMITS } };
}

/**
 * The stored overrides without columns that no longer exist (e.g. Merchant, Parcel type, Packaging,
 * Receiver relationship, Origin branch code of the old templates) and without flags a column doesn't
 * take. `dropped` lists what was removed ("ecommerce.packaging"), for the one-time migration.
 */
export function cleanStored(stored: ImportConfigInput): { config: ImportConfigInput; dropped: string[] } {
  const dropped: string[] = [];
  const templates: NonNullable<ImportConfigInput["templates"]> = {};
  for (const kind of IMPORT_KINDS) {
    const entries = Object.entries(stored.templates?.[kind] ?? {});
    if (!entries.length) continue;
    const kept: Record<string, z.infer<typeof columnSetting>> = {};
    for (const [key, setting] of entries) {
      const col = COLUMNS[kind].find(c => c.key === key);
      if (!col) {
        dropped.push(`${kind}.${key}`);
        continue;
      }
      const next = { ...(setting.required !== undefined && col.configurable ? { required: setting.required } : {}), ...(setting.default !== undefined && col.defaultable ? { default: setting.default } : {}) };
      if (Object.keys(next).length !== Object.keys(setting).length) dropped.push(`${kind}.${key}.${Object.keys(setting).filter(k => !(k in next)).join("+")}`);
      if (Object.keys(next).length) kept[key] = next;
    }
    templates[kind] = kept;
  }
  return { config: { ...stored, templates }, dropped };
}

/** Stored overrides on top of the built-in settings (unknown columns and non-configurable flags are ignored). */
function merge(stored: ImportConfigInput | null): ImportSettings {
  const result = builtIn();
  if (!stored) return result;
  for (const kind of IMPORT_KINDS) {
    for (const col of COLUMNS[kind]) {
      const s = stored.templates?.[kind]?.[col.key];
      if (!s) continue;
      if (s.required !== undefined && col.configurable) result.templates[kind][col.key].required = s.required;
      if (s.default !== undefined && col.defaultable) result.templates[kind][col.key].default = s.default || null;
    }
  }
  if (stored.defaultDestination) result.defaultDestination = stored.defaultDestination;
  result.limits = { ...result.limits, ...(stored.limits ?? {}) };
  return result;
}

/**
 * Import settings (Setting "import-config"): per template which columns are required and the
 * values used for empty cells, the default destination for pricing incomplete orders, and the
 * file / concurrency limits. Edited by super admins (config:manage) and audited; templates,
 * validation and instructions follow them at once.
 */
@Injectable()
export class ImportConfigService implements OnApplicationBootstrap {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  onApplicationBootstrap() {
    void this.migrateStored()
      .then(removed => removed.length && new Logger("Imports").log(`Import settings: dropped the settings of removed columns (${removed.join(", ")})`))
      .catch(err => new Logger("Imports").error({ err }, "Could not clean up the import settings"));
  }

  async settings(db: Db = this.prisma): Promise<ImportSettings> {
    const row = await db.setting.findUnique({ where: { key: IMPORT_CONFIG_KEY } });
    const parsed = row ? importConfigSchema.safeParse(row.value) : null;
    return merge(parsed?.success ? parsed.data : null);
  }

  /** Saves the overrides (merged with the stored ones); `validateDefaults` checks default values against the live option lists. */
  async save(actor: Actor, input: ImportConfigInput, meta: RequestMeta, validateDefaults: (settings: ImportSettings) => Promise<string[]>) {
    return this.prisma.$transaction(async tx => {
      const row = await tx.setting.findUnique({ where: { key: IMPORT_CONFIG_KEY } });
      const parsed = (row ? importConfigSchema.safeParse(row.value) : null)?.data;
      // Settings of removed columns are dropped whenever the config is saved.
      const previous = parsed ? cleanStored(parsed).config : {};
      const next: ImportConfigInput = {
        templates: Object.fromEntries(IMPORT_KINDS.map(kind => [kind, { ...(previous.templates?.[kind] ?? {}), ...(input.templates?.[kind] ?? {}) }])),
        defaultDestination: input.defaultDestination ?? previous.defaultDestination,
        limits: { ...(previous.limits ?? {}), ...(input.limits ?? {}) },
      };
      for (const kind of IMPORT_KINDS)
        for (const key of Object.keys(input.templates?.[kind] ?? {})) {
          const col = COLUMNS[kind].find(c => c.key === key);
          const label = `${KIND_LABEL[kind]} template`;
          if (!col) throw new AppError("VALIDATION_FAILED", `${label}: unknown column "${key}"`, 422);
          const s = input.templates![kind]![key];
          if (s.required !== undefined && !col.configurable) throw new AppError("VALIDATION_FAILED", `${label}: "${col.header}" is always ${col.required ? "required" : "optional"}`, 422);
          if (s.default && !col.defaultable) throw new AppError("VALIDATION_FAILED", `${label}: "${col.header}" can't have a default value`, 422);
        }
      const settings = merge(next);
      const problems = await validateDefaults(settings);
      if (problems.length) throw new AppError("VALIDATION_FAILED", problems[0], 422, problems.map(message => ({ message })));
      await tx.setting.upsert({
        where: { key: IMPORT_CONFIG_KEY },
        create: { key: IMPORT_CONFIG_KEY, value: next as Prisma.InputJsonObject },
        update: { value: next as Prisma.InputJsonObject },
      });
      await this.audit.record(actor, { action: "import_config.update", entityType: "setting", entityId: IMPORT_CONFIG_KEY, data: { changes: input as Prisma.InputJsonObject } }, meta, tx);
      return settings;
    });
  }

  /**
   * One-time clean-up of the stored settings after the templates changed (2026-10-18: three
   * templates, no Merchant / Parcel type / Packaging / Receiver relationship / Origin branch code /
   * document columns): settings of removed columns are dropped, audited. Returns what was dropped;
   * running it again finds nothing. Called at start-up.
   */
  async migrateStored(): Promise<string[]> {
    return this.prisma.$transaction(async tx => {
      const row = await tx.setting.findUnique({ where: { key: IMPORT_CONFIG_KEY } });
      if (!row) return [];
      const parsed = importConfigSchema.safeParse(row.value);
      if (!parsed.success) return [];
      const { config, dropped } = cleanStored(parsed.data);
      // Templates the schema doesn't know (none today) are dropped by the parse itself.
      const unknownKinds = Object.keys((row.value as { templates?: Record<string, unknown> } | null)?.templates ?? {}).filter(k => !(IMPORT_KINDS as readonly string[]).includes(k));
      if (!dropped.length && !unknownKinds.length) return [];
      await tx.setting.update({ where: { key: IMPORT_CONFIG_KEY }, data: { value: config as Prisma.InputJsonObject } });
      const removed = [...dropped, ...unknownKinds];
      await this.audit.record("system", { action: "import_config.migrate", entityType: "setting", entityId: IMPORT_CONFIG_KEY, data: { removed } }, { ip: "", userAgent: "import-config-migration", requestId: "import-config-migration" }, tx);
      return removed;
    });
  }
}
