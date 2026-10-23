import { Body, Controller, Delete, HttpCode, Param, Post, Get } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { z } from "zod";
import { CurrentUser, Public, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { UserActor } from "../../common/auth/actor";
import { ApiZodBody, ZBody } from "../../common/zod";
import { phoneScanResultSchema, phoneScanSchema } from "./phone-scanner.schemas";
import { PhoneScannerService } from "./phone-scanner.service";

/**
 * Phone scanner (Courier Operations): a phone becomes one panel tab's barcode scanner. The tab opens a
 * link (QR code), keeps it alive while it is open and can disconnect it; codes read on the phone arrive
 * on GET /events as `phone_scanner.scan` (owner only, `data.linkId` = the tab's link).
 */
@ApiTags("phone-scanner")
@Controller("phone-scanner")
export class PhoneScannerController {
  constructor(private readonly scanner: PhoneScannerService) {}

  /** Opens a link for this tab: { id, url, qrSvg }. Keep it alive with POST …/keepalive every minute. */
  @RequirePermissions("parcel:dispatch")
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post("links")
  @HttpCode(201)
  open(@CurrentUser() actor: UserActor, @ReqMeta() meta: RequestMeta) {
    return this.scanner.open(actor, meta);
  }

  @RequirePermissions("parcel:dispatch")
  @Post("links/:id/keepalive")
  @HttpCode(200)
  keepalive(@CurrentUser() actor: UserActor, @Param("id") id: string) {
    return this.scanner.keepalive(actor, id);
  }

  /** Disconnect: the phone's link stops working at once. */
  @RequirePermissions("parcel:dispatch")
  @Delete("links/:id")
  close(@CurrentUser() actor: UserActor, @Param("id") id: string, @ReqMeta() meta: RequestMeta) {
    return this.scanner.close(actor, id, meta);
  }

  /** The page's result for scan n (the phone shows it and sounds). */
  @RequirePermissions("parcel:dispatch")
  @Post("links/:id/results")
  @HttpCode(200)
  @ApiZodBody(phoneScanResultSchema)
  result(@CurrentUser() actor: UserActor, @Param("id") id: string, @ZBody(phoneScanResultSchema) body: z.infer<typeof phoneScanResultSchema>) {
    return this.scanner.result(actor, id, body);
  }

  /** The phone's page (link token): who it scans for and its last results. 410 once disconnected. */
  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Get("public/:token")
  publicView(@Param("token") token: string) {
    return this.scanner.publicView(token);
  }

  /** A code read on the phone. */
  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post("public/:token/scans")
  @HttpCode(201)
  @ApiZodBody(phoneScanSchema)
  scan(@Param("token") token: string, @ZBody(phoneScanSchema) body: z.infer<typeof phoneScanSchema>) {
    return this.scanner.scan(token, body);
  }
}
