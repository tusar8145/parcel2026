import type { z } from "zod";
import { Controller, Get, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { CurrentActor, CurrentUser, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor, UserActor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { forbidden } from "../../common/errors";
import { createHandoverSchema, listCashRidersQuerySchema, listHandoversQuerySchema } from "./finance.schemas";
import { isFinanceStaff } from "./finance.scope";
import { CodService } from "./cod.service";

@ApiTags("cod")
@Controller("cod")
export class CodController {
  constructor(private readonly cod: CodService) {}

  /** Riders holding COD cash (hub-scoped operators see their own hubs). */
  @RequirePermissions("cod:receive")
  @Get("riders")
  @ApiZodQuery(listCashRidersQuerySchema)
  riders(@CurrentActor() actor: Actor, @ZQuery(listCashRidersQuerySchema) query: z.infer<typeof listCashRidersQuerySchema>) {
    return this.cod.ridersWithCash(actor, query);
  }

  @RequirePermissions("cod:receive")
  @Get("riders/:riderId/collections")
  riderCollections(@Param("riderId", ParseUUIDPipe) riderId: string) {
    return this.cod.riderCollections(riderId);
  }

  /** Receive a rider's cash for an exact set of collections; the amount must match to the paisa. */
  @RequirePermissions("cod:receive")
  @Post("handovers")
  @ApiZodBody(createHandoverSchema)
  handover(@CurrentUser() actor: UserActor, @ZBody(createHandoverSchema) body: z.infer<typeof createHandoverSchema>, @ReqMeta() meta: RequestMeta) {
    return this.cod.createHandover(actor, body, meta);
  }

  /** Cash receivers and finance staff. */
  @ApiBearerAuth()
  @Get("handovers")
  @ApiZodQuery(listHandoversQuerySchema)
  handovers(@CurrentActor() actor: Actor, @ZQuery(listHandoversQuerySchema) query: z.infer<typeof listHandoversQuerySchema>) {
    if (!actor.permissions.has("cod:receive") && !(actor.permissions.has("finance:read") && isFinanceStaff(actor))) throw forbidden();
    return this.cod.listHandovers(actor, query);
  }
}
