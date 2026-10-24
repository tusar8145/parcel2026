import { Controller, Get, Headers, Param, ParseUUIDPipe, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiNotFoundResponse, ApiOkResponse, ApiProduces, ApiTags } from "@nestjs/swagger";
import type { FastifyReply } from "fastify";
import { AllowApiKey, CurrentActor } from "../../common/auth/decorators";
import type { Actor } from "../../common/auth/actor";
import { FilesService } from "./files.service";
import { RequireApiKeyScope } from "../merchants/api-key-scopes";
import { opensInline } from "../../common/file-types";

@ApiTags("files")
@Controller("files")
export class FilesController {
  constructor(private readonly files: FilesService) {}

  /**
   * Downloads a stored file: ticket attachments (the ticket's requester unless it's an internal note, and support
   * staff) and delivery proofs (anyone who can see the parcel). The uploader can always read their file.
   *
   * With `Accept: application/json` the file comes back as `{ id, filename, mimeType, sizeBytes, dataUrl }`, for
   * clients that keep the access token in memory and can't attach it to a plain link.
   */
  @AllowApiKey()
  @RequireApiKeyScope("parcels:read")
  @ApiBearerAuth()
  @Get(":id")
  @ApiProduces("image/*", "application/pdf", "application/octet-stream", "application/json")
  @ApiOkResponse({ description: "The file content, or JSON with a data URL when Accept is application/json" })
  @ApiNotFoundResponse({ description: "No such file, or you can't access it" })
  async download(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @Headers("accept") accept: string | undefined, @Res() reply: FastifyReply) {
    const { file, data } = await this.files.download(actor, id);
    reply.header("cache-control", "private, max-age=300").header("vary", "accept").header("x-content-type-options", "nosniff");
    if (wantsJson(accept)) {
      return reply.status(200).send({
        id: file.id,
        filename: file.filename,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        dataUrl: `data:${file.mimeType};base64,${data.toString("base64")}`,
      });
    }
    const filename = file.filename.replace(/["\\\r\n]/g, "_");
    return reply
      .status(200)
      .header("content-type", file.mimeType)
      .header("content-length", data.length)
      // Photos and PDFs open in the browser; office files, CSV and text download.
      .header("content-disposition", `${opensInline(file.mimeType) ? "inline" : "attachment"}; filename="${filename}"`)
      .send(data);
  }
}

// JSON only when the client asks for it explicitly; browsers send "*/*" or image types for links.
const wantsJson = (accept?: string) => !!accept && /(^|,)\s*application\/json\s*(;|,|$)/i.test(accept);
