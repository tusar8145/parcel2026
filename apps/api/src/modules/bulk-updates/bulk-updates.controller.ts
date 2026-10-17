import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Req, Res } from "@nestjs/common";
import { ApiBody, ApiConsumes, ApiProduces, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import { CurrentActor, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor } from "../../common/auth/actor";
import { AppError } from "../../common/errors";
import { ApiZodQuery, ZQuery } from "../../common/zod";
import { BulkUpdatesService } from "./bulk-updates.service";
import { bulkExportQuerySchema, bulkFailedRowsQuerySchema, bulkListQuerySchema, bulkRowsQuerySchema } from "./bulk-updates.schemas";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const attachment = (name: string) => `attachment; filename="${name.replace(/["\\\r\n]/g, "_")}"`;

/**
 * Bulk operations by Excel (Courier Operations): GET /bulk-updates/export (the filtered parcels as an
 * .xlsx with action columns) → POST /bulk-updates/validate (dry run: nothing changes) → page through
 * the preview → POST /bulk-updates/:id/apply. Large files are applied in the background with
 * `bulk_update.progress` / `bulk_update.completed` events (GET /events).
 */
@ApiTags("bulk-updates")
@Controller("bulk-updates")
@RequirePermissions("parcel:dispatch", "parcel:read:any")
export class BulkUpdatesController {
  constructor(private readonly bulk: BulkUpdatesService) {}

  /** Row and file limits (the operations import limits). */
  @Get("limits")
  limits(@CurrentActor() actor: Actor) {
    return this.bulk.limits(actor);
  }

  /**
   * The filtered parcels (hub operators: their hubs' work) as an .xlsx: read-only data, action columns
   * with dropdowns from live data, a suggested rider, a hidden version column; at most the row limit.
   * Headers: X-Row-Count (rows in the file), X-Matched (parcels matching), X-Row-Limit.
   */
  @Get("export")
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiProduces(XLSX)
  @ApiZodQuery(bulkExportQuerySchema)
  async export(@CurrentActor() actor: Actor, @ZQuery(bulkExportQuerySchema) query: z.infer<typeof bulkExportQuerySchema>, @ReqMeta() meta: RequestMeta, @Res() reply: FastifyReply) {
    const file = await this.bulk.export(actor, query, meta);
    return reply
      .status(200)
      .header("content-type", XLSX)
      .header("content-disposition", attachment(file.fileName))
      .header("cache-control", "no-store")
      .header("x-row-count", String(file.count))
      .header("x-matched", String(file.matched))
      .header("x-row-limit", String(file.maxRows))
      .header("access-control-expose-headers", "x-row-count, x-matched, x-row-limit, content-disposition")
      .send(file.buffer);
  }

  /** Dry run: checks every row with an Action of the uploaded .xlsx / .csv (multipart field `file`). Nothing changes. */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post("validate")
  @HttpCode(201)
  @ApiConsumes("multipart/form-data")
  @ApiBody({ schema: { type: "object", properties: { file: { type: "string", format: "binary" } }, required: ["file"] } })
  async validate(@CurrentActor() actor: Actor, @Req() req: FastifyRequest, @ReqMeta() meta: RequestMeta) {
    const limits = await this.bulk.limits(actor);
    if (!req.isMultipart()) throw new AppError("VALIDATION_FAILED", "Upload the file as multipart/form-data (field \"file\")", 422);
    let file: { buffer: Buffer; fileName: string } | null = null;
    try {
      for await (const part of req.parts({ limits: { fileSize: limits.maxBytes, files: 1, fields: 5 } }))
        if (part.type === "file") file = { buffer: await part.toBuffer(), fileName: part.filename || "upload" };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "FST_REQ_FILE_TOO_LARGE") throw new AppError("FILE_TOO_LARGE", `Files can be at most ${limits.maxFileMb} MB. Split it into smaller files.`, 413, { maxFileMb: limits.maxFileMb });
      if (code?.startsWith("FST_")) throw new AppError("INVALID_UPLOAD", "The upload could not be read. Choose the file again.", 400);
      throw error;
    }
    if (!file) throw new AppError("VALIDATION_FAILED", "Choose a file to upload (form field \"file\")", 422);
    return this.bulk.validateUpload(actor, file, meta);
  }

  /** History: your bulk updates (operations managers: everyone's unless `mine=true`). */
  @Get()
  @ApiZodQuery(bulkListQuerySchema)
  list(@CurrentActor() actor: Actor, @ZQuery(bulkListQuerySchema) query: z.infer<typeof bulkListQuerySchema>) {
    return this.bulk.list(actor, query);
  }

  @Get(":id")
  get(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string) {
    return this.bulk.get(actor, id);
  }

  /** Preview / result rows; filter all | apply | warning | error | applied | already_done | failed | not_applied. */
  @Get(":id/rows")
  @ApiZodQuery(bulkRowsQuerySchema)
  rows(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZQuery(bulkRowsQuerySchema) query: z.infer<typeof bulkRowsQuerySchema>) {
    return this.bulk.rows(actor, id, query);
  }

  /** Applies the rows that passed the check (rows with errors are skipped), each in its own transaction. */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post(":id/apply")
  @HttpCode(200)
  apply(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.bulk.apply(actor, id, meta);
  }

  /** Drops a checked file that won't be applied. */
  @Delete(":id")
  @HttpCode(204)
  async discard(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    await this.bulk.discard(actor, id, meta);
  }

  /** Rows not applied, in the download's format with an Error column (xlsx, or csv). */
  @Get(":id/failed-rows")
  @ApiProduces(XLSX, "text/csv")
  @ApiZodQuery(bulkFailedRowsQuerySchema)
  async failedRows(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZQuery(bulkFailedRowsQuerySchema) query: z.infer<typeof bulkFailedRowsQuerySchema>, @Res() reply: FastifyReply) {
    const file = await this.bulk.failedRows(actor, id, query.format);
    return reply.status(200).header("content-type", file.contentType).header("content-disposition", attachment(file.fileName)).header("cache-control", "no-store").send(file.buffer);
  }
}
