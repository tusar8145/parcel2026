import type { z } from "zod";
import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req, Res } from "@nestjs/common";
import { ApiBody, ApiConsumes, ApiProduces, ApiTags } from "@nestjs/swagger";
import type { FastifyReply, FastifyRequest } from "fastify";
import { CurrentActor, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { AppError } from "../../common/errors";
import { CnParcelsService, cnCaptureFieldsSchema, cnMerchantSchema, cnSettingsSchema, cnUsageQuerySchema, type CnSettings } from "./cn-parcels.service";

const PHOTO_BYTES = 5 * 1024 * 1024;

/** A multipart upload: the `photo` file and the text fields. */
async function photoAndFields(req: FastifyRequest) {
  if (!req.isMultipart()) throw new AppError("VALIDATION_FAILED", 'Send the photo as multipart/form-data (field "photo")', 422);
  const fields: Record<string, string> = {};
  let photo: { data: Buffer; mimeType: string; filename: string } | null = null;
  try {
    for await (const part of req.parts({ limits: { fileSize: PHOTO_BYTES, files: 1, fields: 6 } })) {
      if (part.type === "file") {
        if (part.fieldname === "photo") photo = { data: await part.toBuffer(), mimeType: part.mimetype, filename: part.filename || "cn.jpg" };
        else await part.toBuffer();
      } else fields[part.fieldname] = String(part.value ?? "");
    }
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "FST_REQ_FILE_TOO_LARGE") throw new AppError("FILE_TOO_LARGE", "The photo can be at most 5 MB", 413);
    if (code?.startsWith("FST_")) throw new AppError("INVALID_UPLOAD", "The upload could not be read. Try again.", 400);
    throw error;
  }
  if (!photo) throw new AppError("VALIDATION_FAILED", 'Take the photo (form field "photo")', 422);
  if (!/^image\/(jpeg|png|webp)$/.test(photo.mimeType)) throw new AppError("VALIDATION_FAILED", "The photo must be JPEG, PNG or WebP", 422);
  const parsed = cnCaptureFieldsSchema.safeParse({ cn: fields.cn, hubId: fields.hubId || undefined, merchantId: fields.merchantId || undefined });
  if (!parsed.success) throw new AppError("VALIDATION_FAILED", parsed.error.issues[0]?.message ?? "Scan the CN label", 422);
  return { photo, fields: parsed.data };
}

/**
 * The apps' CN_ features (Ops and Rider apps): CN_Merchant and CN_Scan on pre-printed CN labels, the parcel's CN photos
 * (Courier Operations), and the CN_Scan AI switch, daily limit and cost (super admin).
 */
@ApiTags("cn-stock")
@Controller("cn")
export class CnParcelsController {
  constructor(private readonly cn: CnParcelsService) {}

  /** Active merchants to choose in the apps' CN_Merchant / CN_Scan (riders and operations staff). */
  @Get("merchants")
  merchants(@CurrentActor() actor: Actor, @Query("q") q?: string) {
    return this.cn.merchants(actor, q);
  }

  /** CN_Merchant: one scanned label becomes (or is given to) the chosen merchant's parcel. Riders and operations staff. */
  @Post("parcels/merchant")
  @HttpCode(200)
  @ApiZodBody(cnMerchantSchema)
  merchant(@CurrentActor() actor: Actor, @ZBody(cnMerchantSchema) body: z.infer<typeof cnMerchantSchema>, @ReqMeta() meta: RequestMeta) {
    return this.cn.assignMerchant(actor, body, meta);
  }

  /** CN_Scan: the parcel's photo with its CN (multipart: photo, cn, hubId?, merchantId?). Riders and operations staff. */
  @Post("parcels/capture")
  @HttpCode(201)
  @ApiConsumes("multipart/form-data")
  @ApiBody({ schema: { type: "object", properties: { photo: { type: "string", format: "binary" }, cn: { type: "string" }, hubId: { type: "string" }, merchantId: { type: "string" } }, required: ["photo", "cn"] } })
  async capture(@CurrentActor() actor: Actor, @Req() req: FastifyRequest, @ReqMeta() meta: RequestMeta) {
    const { photo, fields } = await photoAndFields(req);
    return this.cn.capture(actor, fields, photo, meta);
  }

  @RequirePermissions("parcel:read:any")
  @Get("parcels/:cn/captures")
  captures(@CurrentActor() actor: Actor, @Param("cn") cn: string) {
    return this.cn.captures(actor, cn);
  }

  @RequirePermissions("parcel:read:any")
  @Get("captures/:id/photo")
  @ApiProduces("image/jpeg", "image/png", "image/webp")
  async photo(@Param("id", ParseUUIDPipe) id: string, @Res() reply: FastifyReply) {
    const { data, mimeType } = await this.cn.photo(id);
    return reply.status(200).header("content-type", mimeType).header("content-length", data.length).header("cache-control", "private, max-age=3600").header("x-content-type-options", "nosniff").send(data);
  }

  /** The CN_Scan AI: on / off, the daily limit and today's readings (super admin › Operational settings). */
  @RequirePermissions("config:manage")
  @Get("settings")
  settings() {
    return this.cn.settings();
  }

  @RequirePermissions("config:manage")
  @Put("settings")
  @ApiZodBody(cnSettingsSchema)
  saveSettings(@CurrentActor() actor: Actor, @ZBody(cnSettingsSchema) body: CnSettings, @ReqMeta() meta: RequestMeta) {
    return this.cn.saveSettings(actor, body, meta);
  }

  @RequirePermissions("config:manage")
  @Get("usage")
  @ApiZodQuery(cnUsageQuerySchema)
  usage(@ZQuery(cnUsageQuerySchema) query: z.infer<typeof cnUsageQuerySchema>) {
    return this.cn.usage(query);
  }
}
