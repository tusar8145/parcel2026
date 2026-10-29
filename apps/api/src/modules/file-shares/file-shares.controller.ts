import { Controller, Delete, Get, HttpCode, Param, Post, Req, Res } from "@nestjs/common";
import { ApiBody, ApiConsumes, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { FastifyReply, FastifyRequest } from "fastify";
import { CurrentUser, Public, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { UserActor } from "../../common/auth/actor";
import { AppError } from "../../common/errors";
import { FileSharesService, MAX_FILE_BYTES } from "./file-shares.service";

/** `attachment` with the name as typed (UTF-8, e.g. Bangla) and a plain fallback. */
const attachment = (name: string) => `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`;

/** Courier Operations › Share files: a QR link that other devices drop files into; they show on the computer until it closes the dialog. */
@ApiTags("file-shares")
@Controller("file-shares")
export class FileSharesController {
  constructor(private readonly shares: FileSharesService) {}

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @RequirePermissions("parcel:dispatch")
  @Post()
  @HttpCode(201)
  open(@CurrentUser() actor: UserActor, @ReqMeta() meta: RequestMeta) {
    return this.shares.open(actor, meta);
  }

  @Get(":id")
  status(@CurrentUser() actor: UserActor, @Param("id") id: string) {
    return this.shares.status(actor, id);
  }

  @Get(":id/files/:fileId")
  async download(@CurrentUser() actor: UserActor, @Param("id") id: string, @Param("fileId") fileId: string, @Res() reply: FastifyReply) {
    const { file, data } = await this.shares.download(actor, id, fileId);
    return reply.status(200).header("content-type", file.mimeType).header("content-disposition", attachment(file.name)).header("cache-control", "no-store").send(data);
  }

  @Delete(":id")
  close(@CurrentUser() actor: UserActor, @Param("id") id: string) {
    return this.shares.close(actor, id);
  }

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get("public/:token")
  publicView(@Param("token") token: string) {
    return this.shares.publicView(token);
  }

  /** One file per request (multipart field `file`). */
  @Public()
  @Throttle({ default: { limit: 40, ttl: 60_000 } })
  @Post("public/:token/files")
  @HttpCode(201)
  @ApiConsumes("multipart/form-data")
  @ApiBody({ schema: { type: "object", properties: { file: { type: "string", format: "binary" } }, required: ["file"] } })
  async receive(@Param("token") token: string, @Req() req: FastifyRequest) {
    if (!req.isMultipart()) throw new AppError("VALIDATION_FAILED", 'Send the file as multipart/form-data (field "file")', 422);
    let file: { data: Buffer; name: string; mimeType: string } | null = null;
    try {
      for await (const part of req.parts({ limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 2 } }))
        if (part.type === "file") {
          const data = await part.toBuffer();
          file = { data, name: part.filename || "file", mimeType: part.mimetype };
        }
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "FST_REQ_FILE_TOO_LARGE") throw new AppError("FILE_TOO_LARGE", `Files can be at most ${MAX_FILE_BYTES / 1024 / 1024} MB`, 413);
      if (code?.startsWith("FST_")) throw new AppError("INVALID_UPLOAD", "The file could not be read. Choose it again.", 400);
      throw error;
    }
    if (!file) throw new AppError("VALIDATION_FAILED", "Choose a file to send", 422);
    return this.shares.receive(token, file);
  }
}
