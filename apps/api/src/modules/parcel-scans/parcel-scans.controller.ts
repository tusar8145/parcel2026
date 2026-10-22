import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req, Res } from "@nestjs/common";
import { ApiBody, ApiConsumes, ApiProduces, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import { CurrentUser, Public, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { UserActor } from "../../common/auth/actor";
import { AppError } from "../../common/errors";
import { ApiZodBody, ZBody } from "../../common/zod";
import { createScanSessionSchema, updateScanSchema } from "./parcel-scans.schemas";
import { ParcelScansService } from "./parcel-scans.service";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PHOTO_BYTES = 5 * 1024 * 1024;
const WORKBOOK_BYTES = 10 * 1024 * 1024;

/** The single file of a multipart upload (field `field`), with a readable error for oversize or broken uploads. */
async function oneFile(req: FastifyRequest, field: string, maxBytes: number) {
  if (!req.isMultipart()) throw new AppError("VALIDATION_FAILED", `Send the file as multipart/form-data (field "${field}")`, 422);
  try {
    for await (const part of req.parts({ limits: { fileSize: maxBytes, files: 1, fields: 3 } }))
      if (part.type === "file" && part.fieldname === field) return { buffer: await part.toBuffer(), fileName: part.filename || field, mimeType: part.mimetype };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "FST_REQ_FILE_TOO_LARGE") throw new AppError("FILE_TOO_LARGE", `The file can be at most ${Math.round(maxBytes / 1024 / 1024)} MB`, 413);
    if (code?.startsWith("FST_")) throw new AppError("INVALID_UPLOAD", "The upload could not be read. Try again.", 400);
    throw error;
  }
  throw new AppError("VALIDATION_FAILED", `Choose a file (form field "${field}")`, 422);
}

/**
 * "Scan with phone" (Courier Operations › New orders). Staff open a session (QR code + link), see
 * the photos' rows live (`parcel_scan.updated` on GET /events), edit them, download / re-import
 * them as the import template (Scan ID column) and submit them through POST /imports/validate.
 * The phone uses the public routes with the link's token while the modal is open.
 */
@ApiTags("parcel-scans")
@Controller("parcel-scans")
export class ParcelScansController {
  constructor(private readonly scans: ParcelScansService) {}

  /** Opens a session: { url, qrSvg, … }. The link works while the modal keeps the session alive (POST …/keepalive every minute). */
  @RequirePermissions("parcel:dispatch")
  @Post("sessions")
  @ApiZodBody(createScanSessionSchema)
  create(@CurrentUser() actor: UserActor, @ZBody(createScanSessionSchema) body: z.infer<typeof createScanSessionSchema>, @ReqMeta() meta: RequestMeta) {
    return this.scans.create(actor, body, meta);
  }

  /** The session with its rows (your own sessions only). */
  @RequirePermissions("parcel:dispatch")
  @Get("sessions/:id")
  get(@CurrentUser() actor: UserActor, @Param("id", ParseUUIDPipe) id: string) {
    return this.scans.get(actor, id);
  }

  @RequirePermissions("parcel:dispatch")
  @Post("sessions/:id/keepalive")
  @HttpCode(200)
  keepalive(@CurrentUser() actor: UserActor, @Param("id", ParseUUIDPipe) id: string) {
    return this.scans.keepalive(actor, id);
  }

  /** Closes the session: the phone link stops working at once. */
  @RequirePermissions("parcel:dispatch")
  @Delete("sessions/:id")
  @HttpCode(204)
  async close(@CurrentUser() actor: UserActor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    await this.scans.close(actor, id, meta);
  }

  @RequirePermissions("parcel:dispatch")
  @Patch("sessions/:id/scans/:scanId")
  @ApiZodBody(updateScanSchema)
  updateScan(
    @CurrentUser() actor: UserActor,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("scanId", ParseUUIDPipe) scanId: string,
    @ZBody(updateScanSchema) body: z.infer<typeof updateScanSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.scans.updateScan(actor, id, scanId, body, meta);
  }

  @RequirePermissions("parcel:dispatch")
  @Delete("sessions/:id/scans/:scanId")
  @HttpCode(204)
  async deleteScan(@CurrentUser() actor: UserActor, @Param("id", ParseUUIDPipe) id: string, @Param("scanId", ParseUUIDPipe) scanId: string, @ReqMeta() meta: RequestMeta) {
    await this.scans.deleteScan(actor, id, scanId, meta);
  }

  /** The rows not booked yet as the import template, with a Scan ID column (keep it to link the photos). */
  @RequirePermissions("parcel:dispatch")
  @Get("sessions/:id/workbook")
  @ApiProduces(XLSX)
  async workbook(@CurrentUser() actor: UserActor, @Param("id", ParseUUIDPipe) id: string, @Res() reply: FastifyReply) {
    const file = await this.scans.workbook(actor, id);
    return reply.status(200).header("content-type", XLSX).header("content-disposition", `attachment; filename="${file.fileName}"`).header("cache-control", "no-store").send(file.buffer);
  }

  /** An edited workbook back into the session (multipart field `file`): rows matched by Scan ID, new rows added. */
  @RequirePermissions("parcel:dispatch")
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post("sessions/:id/workbook")
  @HttpCode(200)
  @ApiConsumes("multipart/form-data")
  @ApiBody({ schema: { type: "object", properties: { file: { type: "string", format: "binary" } }, required: ["file"] } })
  async importWorkbook(@CurrentUser() actor: UserActor, @Param("id", ParseUUIDPipe) id: string, @Req() req: FastifyRequest, @ReqMeta() meta: RequestMeta) {
    const file = await oneFile(req, "file", WORKBOOK_BYTES);
    return this.scans.importWorkbook(actor, id, file, meta);
  }

  /** A row's photo (thumbnails in the modal; the booked parcel's photo later). */
  @RequirePermissions("parcel:dispatch")
  @Get("scans/:scanId/photo")
  @ApiProduces("image/jpeg", "image/png", "image/webp")
  async photo(@Param("scanId", ParseUUIDPipe) scanId: string, @Res() reply: FastifyReply) {
    const { data, mimeType } = await this.scans.photo(scanId);
    return reply.status(200).header("content-type", mimeType).header("content-length", data.length).header("cache-control", "private, max-age=3600").header("x-content-type-options", "nosniff").send(data);
  }

  // ───────────── the phone (by link token, no sign-in) ─────────────

  /** What the phone page shows: the session's type, merchant and photos so far. 410 once the modal is closed. */
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get("public/:token")
  publicView(@Param("token") token: string) {
    return this.scans.publicView(token);
  }

  /** A parcel photo from the phone (multipart field `photo`: JPEG, PNG or WebP, at most 5 MB). */
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post("public/:token/photos")
  @HttpCode(201)
  @ApiConsumes("multipart/form-data")
  @ApiBody({ schema: { type: "object", properties: { photo: { type: "string", format: "binary" } }, required: ["photo"] } })
  async addPhoto(@Param("token") token: string, @Req() req: FastifyRequest, @ReqMeta() meta: RequestMeta) {
    const file = await oneFile(req, "photo", PHOTO_BYTES);
    return this.scans.addPhoto(token, { data: file.buffer, mimeType: file.mimeType, filename: file.fileName }, meta);
  }
}
