import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { PrismaService, type Db } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { AppError } from "../../common/errors";
import type { Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import type { Prisma } from "../../generated/prisma/client";
import { COLUMNS, IMPORT_KINDS, type ColumnKey, type ImportKindKey } from "./columns";

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
export class ImportConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async settings(db: Db = this.prisma): Promise<ImportSettings> {
    const row = await db.setting.findUnique({ where: { key: IMPORT_CONFIG_KEY } });
    const parsed = row ? importConfigSchema.safeParse(row.value) : null;
    return merge(parsed?.success ? parsed.data : null);
  }

  /** Saves the overrides (merged with the stored ones); `validateDefaults` checks default values against the live option lists. */
  async save(actor: Actor, input: ImportConfigInput, meta: RequestMeta, validateDefaults: (settings: ImportSettings) => Promise<string[]>) {
    return this.prisma.$transaction(async tx => {
      const row = await tx.setting.findUnique({ where: { key: IMPORT_CONFIG_KEY } });
      const previous = (row ? importConfigSchema.safeParse(row.value) : null)?.data ?? {};
      const next: ImportConfigInput = {
        templates: {
          ecommerce: { ...(previous.templates?.ecommerce ?? {}), ...(input.templates?.ecommerce ?? {}) },
          document: { ...(previous.templates?.document ?? {}), ...(input.templates?.document ?? {}) },
        },
        defaultDestination: input.defaultDestination ?? previous.defaultDestination,
        limits: { ...(previous.limits ?? {}), ...(input.limits ?? {}) },
      };
      for (const kind of IMPORT_KINDS)
        for (const key of Object.keys(input.templates?.[kind] ?? {})) {
          const col = COLUMNS[kind].find(c => c.key === key);
          if (!col) throw new AppError("VALIDATION_FAILED", `${kind} template: unknown column "${key}"`, 422);
          const s = input.templates![kind]![key];
          if (s.required !== undefined && !col.configurable) throw new AppError("VALIDATION_FAILED", `${kind} template: "${col.header}" can't be made required here`, 422);
          if (s.default && !col.defaultable) throw new AppError("VALIDATION_FAILED", `${kind} template: "${col.header}" can't have a default value`, 422);
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
}
