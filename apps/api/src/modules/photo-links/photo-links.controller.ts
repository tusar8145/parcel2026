import { Controller, Delete, Get, HttpCode, Param, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import { CurrentUser, Public, ReqMeta, type RequestMeta } from "../../common/auth/decorators";
import type { UserActor } from "../../common/auth/actor";
import { ApiZodBody, ZBody } from "../../common/zod";
import { PhotoLinksService } from "./photo-links.service";

const openSchema = z.object({ title: z.string().trim().max(120).optional() });
const photoSchema = z.object({
  image: z
    .string()
    .regex(/^data:image\/(jpeg|png|webp);base64,/, "Send a JPEG, PNG or WebP photo")
    .max(7_500_000, "The photo is too large (max ~5 MB)"),
});

/** "Use phone" for one photo (e.g. a payment receipt): QR link → the phone takes it → the computer gets it; the link is used once. */
@ApiTags("photo-links")
@Controller("photo-links")
export class PhotoLinksController {
  constructor(private readonly links: PhotoLinksService) {}

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post()
  @HttpCode(201)
  @ApiZodBody(openSchema)
  open(@CurrentUser() actor: UserActor, @ZBody(openSchema) body: z.infer<typeof openSchema>, @ReqMeta() meta: RequestMeta) {
    return this.links.open(actor, body, meta);
  }

  @Get(":id")
  status(@CurrentUser() actor: UserActor, @Param("id") id: string) {
    return this.links.status(actor, id);
  }

  @Delete(":id")
  close(@CurrentUser() actor: UserActor, @Param("id") id: string) {
    return this.links.close(actor, id);
  }

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get("public/:token")
  publicView(@Param("token") token: string) {
    return this.links.publicView(token);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("public/:token/photo")
  @HttpCode(201)
  @ApiZodBody(photoSchema)
  photo(@Param("token") token: string, @ZBody(photoSchema) body: z.infer<typeof photoSchema>) {
    return this.links.photo(token, body.image);
  }
}
