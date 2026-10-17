import type { z } from "zod";
import { Controller, Get } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CurrentActor, RequirePermissions } from "../../common/auth/decorators";
import type { Actor } from "../../common/auth/actor";
import { ApiZodQuery, ZQuery } from "../../common/zod";
import { HubReconciliationService, hubReconciliationQuerySchema } from "./hub-reconciliation.service";

@ApiTags("ops")
@Controller()
export class HubReconciliationController {
  constructor(private readonly reconciliation: HubReconciliationService) {}

  /**
   * End-of-day hub reconciliation (read-only) for a hub and a Dhaka calendar day: arrivals expected vs
   * received, dispatched out (delivery + transfers), held now, ready for collection; and, with cod:receive
   * or finance:read, COD collected by the hub's riders vs cash handovers received vs still with riders.
   * Hub operators: their own hubs. PDF: GET /documents/hub-reconciliation.
   */
  @RequirePermissions("hub:read", "parcel:read:any")
  @Get("ops/hub-reconciliation")
  @ApiZodQuery(hubReconciliationQuerySchema)
  report(@CurrentActor() actor: Actor, @ZQuery(hubReconciliationQuerySchema) query: z.infer<typeof hubReconciliationQuerySchema>) {
    return this.reconciliation.report(actor, query);
  }
}
