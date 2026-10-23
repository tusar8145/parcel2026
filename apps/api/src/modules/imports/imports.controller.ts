import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Put, Req, Res } from "@nestjs/common";
import { ApiBody, ApiConsumes, ApiProduces, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import { AllowApiKey, CurrentActor, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor } from "../../common/auth/actor";
import { AppError } from "../../common/errors";
import { ApiZodBody, ApiZodQuery, ZBody, ZodPipe, ZQuery } from "../../common/zod";
import { RequireApiKeyScope } from "../merchants/api-key-scopes";
import { resolvePlace } from "../parcels/places";
import { COLUMNS, IMPORT_KINDS, KIND_LABEL } from "./columns";
import { ImportConfigService, importConfigSchema, LIMIT_CEILINGS, type ImportSettings } from "./import-config.service";
import { ImportEngineService } from "./import-engine.service";
import { ImportJobsService } from "./import-jobs.service";
import {
  editRowSchema,
  failedRowsQuerySchema,
  importKindSchema,
  importOptionsSchema,
  importRowsBodySchema,
  listImportsQuerySchema,
  rowsQuerySchema,
  templateQuerySchema,
} from "./imports.schemas";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const attachment = (name: string) => `attachment; filename="${name.replace(/["\\\r\n]/g, "_")}"`;

/**
 * Spreadsheet imports for merchants (both panels; API keys with parcels:write) and operations.
 * Download the template, POST /imports/validate (dry run: nothing is booked), page through the
 * preview, then POST /imports/:id/commit. Large files are booked in the background with
 * `import.progress` / `import.completed` events (GET /events).
 */
@ApiTags("imports")
@Controller("imports")
export class ImportsController {
  constructor(
    private readonly jobs: ImportJobsService,
    private readonly config: ImportConfigService,
    private readonly engine: ImportEngineService,
  ) {}

  /** Columns of the three templates (ecommerce, document = Banking & Financial, customer) with the required flags and defaults in force, the default destination and the limits. */
  @AllowApiKey()
  @RequireApiKeyScope("parcels:write", "parcels:read")
  @Get("config")
  async getConfig() {
    return this.configView(await this.config.settings());
  }

  /** Super admin: required columns and defaults per template, default destination, limits (up to the hard ceilings). Audited. */
  @RequirePermissions("config:manage")
  @Put("config")
  @ApiZodBody(importConfigSchema)
  async putConfig(@CurrentActor() actor: Actor, @ZBody(importConfigSchema) body: z.infer<typeof importConfigSchema>, @ReqMeta() meta: RequestMeta) {
    const saved = await this.config.save(actor, body, meta, settings => this.checkDefaults(settings));
    return this.configView(saved);
  }

  /** The limits shown before an upload ("Max 5,000 rows per file"). */
  @AllowApiKey()
  @RequireApiKeyScope("parcels:write")
  @Get("limits")
  @ApiZodQuery(templateQuerySchema)
  limits(@CurrentActor() actor: Actor, @ZQuery(templateQuerySchema) query: z.infer<typeof templateQuerySchema>) {
    return this.jobs.limits(actor, query.merchantId);
  }

  /** The .xlsx template (ecommerce, document = Banking & Financial, customer), generated from live data; `merchantId`: the Service list follows that merchant's package. */
  @AllowApiKey()
  @RequireApiKeyScope("parcels:write")
  @Get("templates/:kind")
  @ApiProduces(XLSX)
  @ApiZodQuery(templateQuerySchema)
  async template(
    @CurrentActor() actor: Actor,
    @Param("kind", new ZodPipe(importKindSchema)) kind: z.infer<typeof importKindSchema>,
    @ZQuery(templateQuerySchema) query: z.infer<typeof templateQuerySchema>,
    @Res() reply: FastifyReply,
  ) {
    const file = await this.jobs.template(actor, kind, query);
    return reply.status(200).header("content-type", XLSX).header("content-disposition", attachment(file.fileName)).header("cache-control", "no-store").send(file.buffer);
  }

  /**
   * Dry run: parses an .xlsx / .csv upload (multipart field `file`, with `kind`, `merchantId`, `intake`,
   * `dropOffHubId` as fields) or JSON `{ kind, rows: [{ column: value }] }`, and validates every row.
   * Nothing is booked. Returns the summary and the first page of rows.
   */
  @AllowApiKey()
  @RequireApiKeyScope("parcels:write")
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post("validate")
  @HttpCode(201)
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiBody({
    schema: {
      oneOf: [
        { type: "object", properties: { file: { type: "string", format: "binary" }, kind: { enum: [...IMPORT_KINDS] }, merchantId: { type: "string" }, intake: { enum: ["PICKUP", "DROP_OFF"] }, dropOffHubId: { type: "string" } }, required: ["file", "kind"] },
        { type: "object", properties: { kind: { enum: [...IMPORT_KINDS] }, rows: { type: "array", items: { type: "object" } } }, required: ["kind", "rows"] },
      ],
    },
  })
  async validate(@CurrentActor() actor: Actor, @Req() req: FastifyRequest, @Body() body: unknown, @ReqMeta() meta: RequestMeta) {
    if (!req.isMultipart()) {
      const input = importRowsBodySchema.parse(body ?? {});
      return this.jobs.validateUpload(actor, input, { rows: input.rows, fileName: input.fileName }, meta);
    }
    const settings = await this.config.settings();
    const maxBytes = Math.round(settings.limits.maxFileMb * 1024 * 1024);
    const fields: Record<string, string> = {};
    let file: { buffer: Buffer; fileName: string } | null = null;
    try {
      for await (const part of req.parts({ limits: { fileSize: maxBytes, files: 1, fields: 10 } })) {
        if (part.type === "file") file = { buffer: await part.toBuffer(), fileName: part.filename || "upload" };
        else fields[part.fieldname] = String(part.value ?? "");
      }
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "FST_REQ_FILE_TOO_LARGE") throw new AppError("FILE_TOO_LARGE", `Files can be at most ${settings.limits.maxFileMb} MB. Split it into smaller files.`, 413, { maxFileMb: settings.limits.maxFileMb });
      if (code?.startsWith("FST_")) throw new AppError("INVALID_UPLOAD", "The upload could not be read. Choose the file again.", 400);
      throw error;
    }
    if (!file) throw new AppError("VALIDATION_FAILED", "Choose a file to upload (form field \"file\")", 422);
    const options = importOptionsSchema.parse({ ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== "")) });
    return this.jobs.validateUpload(actor, options, file, meta);
  }

  /** Import history: merchants see their own imports, operations the operations imports (`mine=true`: yours). */
  @AllowApiKey()
  @RequireApiKeyScope("parcels:write", "parcels:read")
  @Get()
  @ApiZodQuery(listImportsQuerySchema)
  list(@CurrentActor() actor: Actor, @ZQuery(listImportsQuerySchema) query: z.infer<typeof listImportsQuerySchema>) {
    return this.jobs.list(actor, query);
  }

  /** One import: counts, progress, result and downloads. */
  @AllowApiKey()
  @RequireApiKeyScope("parcels:write", "parcels:read")
  @Get(":id")
  get(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string) {
    return this.jobs.get(actor, id);
  }

  /** Preview / result rows, 50 per page by default; filter all | valid | incomplete | error | created | failed | not_created. */
  @AllowApiKey()
  @RequireApiKeyScope("parcels:write", "parcels:read")
  @Get(":id/rows")
  @ApiZodQuery(rowsQuerySchema)
  rows(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZQuery(rowsQuerySchema) query: z.infer<typeof rowsQuerySchema>) {
    return this.jobs.rows(actor, id, query);
  }

  /**
   * Edits one row of a checked file before it is submitted (the preview's inline address and district /
   * zone / area): the row is checked and priced again and the file's counts follow. `detect`: the address
   * changed, so its district / zone / area are picked again from it. Returns { row, job }.
   */
  @AllowApiKey()
  @RequireApiKeyScope("parcels:write")
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Patch(":id/rows/:rowNumber")
  @ApiZodBody(editRowSchema)
  editRow(
    @CurrentActor() actor: Actor,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("rowNumber", ParseIntPipe) rowNumber: number,
    @ZBody(editRowSchema) body: z.infer<typeof editRowSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.jobs.editRow(actor, id, rowNumber, body, meta);
  }

  /** Books the valid and incomplete rows (rows with errors are skipped). Up to 100 rows at once, larger files in the background. */
  @AllowApiKey()
  @RequireApiKeyScope("parcels:write")
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post(":id/commit")
  @HttpCode(200)
  commit(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.jobs.commit(actor, id, meta);
  }

  /** Drops a validated file that won't be submitted. */
  @AllowApiKey()
  @RequireApiKeyScope("parcels:write")
  @Delete(":id")
  @HttpCode(204)
  async discard(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    await this.jobs.discard(actor, id, meta);
  }

  /** Rows that weren't created, in the template format with an Error column (xlsx, or csv). */
  @AllowApiKey()
  @RequireApiKeyScope("parcels:write", "parcels:read")
  @Get(":id/failed-rows")
  @ApiProduces(XLSX, "text/csv")
  @ApiZodQuery(failedRowsQuerySchema)
  async failedRows(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZQuery(failedRowsQuerySchema) query: z.infer<typeof failedRowsQuerySchema>, @Res() reply: FastifyReply) {
    const file = await this.jobs.failedRows(actor, id, query.format);
    return reply.status(200).header("content-type", file.contentType).header("content-disposition", attachment(file.fileName)).header("cache-control", "no-store").send(file.buffer);
  }

  /** Tracking IDs booked by the import (to print labels). */
  @AllowApiKey()
  @RequireApiKeyScope("parcels:write", "parcels:read")
  @Get(":id/tracking-ids")
  trackingIds(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string) {
    return this.jobs.trackingIds(actor, id);
  }

  private configView(settings: ImportSettings) {
    return {
      templates: Object.fromEntries(
        IMPORT_KINDS.map(kind => [
          kind,
          COLUMNS[kind].map(c => ({
            key: c.key,
            header: c.header,
            description: c.description,
            required: settings.templates[kind][c.key].required,
            default: settings.templates[kind][c.key].default,
            configurable: c.configurable,
            defaultable: c.defaultable,
            builtInRequired: c.required,
            builtInDefault: c.default ?? null,
            /** Only in the template when the package offers it (COD, open box). */
            packageOnly: c.needs ?? null,
            /** false: not in the blank template (district / zone / area are found from the full address). */
            inTemplate: c.inTemplate !== false,
          })),
        ]),
      ),
      /** What each template is called: E-commerce, Banking & Financial (kind "document"), Customer parcel. */
      titles: KIND_LABEL,
      defaultDestination: settings.defaultDestination,
      limits: settings.limits,
      ceilings: LIMIT_CEILINGS,
    };
  }

  /** Default values must pass the same rules as a cell (e.g. a service level that exists). */
  private async checkDefaults(settings: ImportSettings) {
    const problems: string[] = [];
    if (settings.defaultDestination.mode === "FIXED") {
      const catalog = (await this.engine.context({ kind: "ecommerce", settings })).catalog;
      const place = resolvePlace(catalog, settings.defaultDestination.district, settings.defaultDestination.zone);
      if (!place.ok || !place.zone) problems.push(`Default destination: ${place.ok ? "choose a zone" : place.message}`);
    }
    for (const kind of IMPORT_KINDS) {
      const ctx = await this.engine.context({ kind, settings });
      for (const col of COLUMNS[kind]) {
        const value = settings.templates[kind][col.key].default;
        if (!value) continue;
        const row = this.engine.validateRow({ ...ctx, fileMerchant: null }, 0, { [col.key]: value });
        const problem = row.errors.find(e => e.column === col.key);
        if (problem) problems.push(`${KIND_LABEL[kind]} template, ${col.header} default: ${problem.message}`);
      }
    }
    return problems;
  }
}
