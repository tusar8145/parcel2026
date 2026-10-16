import type { z } from "zod";
import { Controller, Get, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { CurrentActor, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { hubReceiveSchema, labelsSchema, listBatchesQuerySchema } from "./hub-intake.schemas";
import { HubIntakeService } from "./hub-intake.service";

/** Hub drop-off intake: the receive desk, spreadsheet import batches and shipping labels. */
@ApiTags("operations")
@Controller("ops")
export class HubIntakeController {
  constructor(private readonly intake: HubIntakeService) {}

  /**
   * Receive one parcel at a hub by scanned or typed tracking ID / CN. Answers 200 with an
   * outcome (RECEIVED, ALREADY_RECEIVED, WRONG_HUB, NOT_FOUND, NOT_DROP_OFF, REFUSED) so a
   * batch of scans keeps going; 403 when the hub isn't the caller's.
   */
  @RequirePermissions("parcel:dispatch")
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @Post("hub-receive")
  @ApiZodBody(hubReceiveSchema)
  receive(@CurrentActor() actor: Actor, @ZBody(hubReceiveSchema) body: z.infer<typeof hubReceiveSchema>, @ReqMeta() meta: RequestMeta) {
    return this.intake.receive(actor, body, meta);
  }

  /** Spreadsheet imports, newest first, with expected and received counts. */
  @RequirePermissions("parcel:read:any")
  @Get("booking-batches")
  @ApiZodQuery(listBatchesQuerySchema)
  batches(@CurrentActor() actor: Actor, @ZQuery(listBatchesQuerySchema) query: z.infer<typeof listBatchesQuerySchema>) {
    return this.intake.listBatches(actor, query);
  }

  /** One import: every parcel and whether it has arrived (expected vs received). */
  @RequirePermissions("parcel:read:any")
  @Get("booking-batches/:id")
  batch(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string) {
    return this.intake.batchDetail(actor, id);
  }

  /** Label data for up to 500 parcels (tracking ID, recipient, COD, hubs…); printing is audited. */
  @RequirePermissions("parcel:read:any")
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post("labels")
  @ApiZodBody(labelsSchema)
  labels(@CurrentActor() actor: Actor, @ZBody(labelsSchema) body: z.infer<typeof labelsSchema>, @ReqMeta() meta: RequestMeta) {
    return this.intake.labels(actor, body, meta);
  }
}
