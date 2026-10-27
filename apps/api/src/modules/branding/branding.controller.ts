import type { z } from "zod";
import { Controller, Get, Header, NotFoundException, Put, Req, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { FastifyReply, FastifyRequest } from "fastify";
import { CurrentActor, Public, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor } from "../../common/auth/actor";
import { ApiZodBody, ZBody } from "../../common/zod";
import { BrandingService, brandingSchema } from "./branding.service";

/** White label: the company's name, logo, tab icon, contact details and About text. */
@ApiTags("branding")
@Controller("branding")
export class BrandingController {
  constructor(private readonly branding: BrandingService) {}

  /** For every page (signed in or not): the name, contact details, About text and image addresses. */
  @Public()
  @Get()
  @Header("Cache-Control", "public, max-age=60")
  view() {
    return this.branding.view();
  }

  @Public()
  @Get("logo")
  logo(@Req() req: FastifyRequest, @Res() res: FastifyReply) {
    return this.send("logo", req, res);
  }

  /** The browser tab icon (favicon): the uploaded one, else the default. */
  @Public()
  @Get("icon")
  icon(@Req() req: FastifyRequest, @Res() res: FastifyReply) {
    return this.send("icon", req, res);
  }

  private async send(which: "logo" | "icon", req: FastifyRequest, res: FastifyReply) {
    const img = await this.branding.image(which);
    if (!img) throw new NotFoundException("No logo uploaded");
    res.header("Cache-Control", "public, max-age=300").header("ETag", img.etag).header("X-Content-Type-Options", "nosniff");
    // An SVG is shown as an image only, never run as a page.
    if (img.type === "image/svg+xml") res.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    if (req.headers["if-none-match"] === img.etag) return res.status(304).send();
    return res.type(img.type).send(img.body);
  }

  /** Super admin › Branding & company. */
  @RequirePermissions("config:manage")
  @Put()
  @ApiZodBody(brandingSchema)
  save(@CurrentActor() actor: Actor, @ZBody(brandingSchema) body: z.infer<typeof brandingSchema>, @ReqMeta() meta: RequestMeta) {
    return this.branding.save(actor, body, meta);
  }
}
