import { Controller, Get, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { z } from "zod";
import { CurrentActor, CurrentUser, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor, UserActor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { forbidden } from "../../common/errors";
import { createTransferSchema, listSlipsQuerySchema, listTransfersQuerySchema, onHandQuerySchema, receiveCashSchema } from "./money.schemas";
import { CashService } from "./cash.service";

const riderOf = (actor: UserActor) => {
  if (!actor.riderId) throw forbidden("Only riders have cash to hand over");
  return actor.riderId;
};

/** COD cash: the rider's My cash and handover slip, hubs receiving slips and sending transfers to the central hub. */
@ApiTags("cash")
@Controller()
export class CashController {
  constructor(private readonly cash: CashService) {}

  // ───────────── rider ─────────────

  @RequirePermissions("cod:collect")
  @Get("rider/my-cash")
  myCash(@CurrentUser() actor: UserActor) {
    return this.cash.riderCash(riderOf(actor));
  }

  /** Make (or bring up to date) the handover slip of all the cash held. */
  @RequirePermissions("cod:collect")
  @Post("rider/my-cash/slip")
  makeSlip(@CurrentUser() actor: UserActor, @ReqMeta() meta: RequestMeta) {
    return this.cash.makeSlip(actor, riderOf(actor), meta);
  }

  @RequirePermissions("cod:collect")
  @Post("rider/my-cash/slip/cancel")
  cancelSlip(@CurrentUser() actor: UserActor, @ReqMeta() meta: RequestMeta) {
    return this.cash.cancelSlip(actor, riderOf(actor), meta);
  }

  // ───────────── hubs ─────────────

  /** Riders of your hubs holding cash: make the slip for one without a phone. */
  @Get("cash/riders")
  riders(@CurrentActor() actor: Actor) {
    return this.cash.ridersWithCash(actor);
  }

  @Post("cash/riders/:riderId/slip")
  slipForRider(@CurrentUser() actor: UserActor, @Param("riderId", ParseUUIDPipe) riderId: string, @ReqMeta() meta: RequestMeta) {
    return this.cash.slipForRider(actor, riderId, meta);
  }

  @Get("cash/slips")
  @ApiZodQuery(listSlipsQuerySchema)
  slips(@CurrentActor() actor: Actor, @ZQuery(listSlipsQuerySchema) query: z.infer<typeof listSlipsQuerySchema>) {
    return this.cash.slips(actor, query);
  }

  /** By number (scanned) or id. */
  @Get("cash/slips/:key")
  slip(@CurrentActor() actor: Actor, @Param("key") key: string) {
    return this.cash.slip(actor, key);
  }

  @Post("cash/slips/:id/receive")
  @ApiZodBody(receiveCashSchema)
  receiveSlip(@CurrentUser() actor: UserActor, @Param("id", ParseUUIDPipe) id: string, @ZBody(receiveCashSchema) body: z.infer<typeof receiveCashSchema>, @ReqMeta() meta: RequestMeta) {
    return this.cash.receiveSlip(actor, id, body, meta);
  }

  @Get("cash/on-hand")
  @ApiZodQuery(onHandQuerySchema)
  onHand(@CurrentActor() actor: Actor, @ZQuery(onHandQuerySchema) query: z.infer<typeof onHandQuerySchema>) {
    return this.cash.onHand(actor, query.hubId);
  }

  @Get("cash/dues")
  dues(@CurrentActor() actor: Actor) {
    return this.cash.dues(actor);
  }

  @Get("cash/transfers")
  @ApiZodQuery(listTransfersQuerySchema)
  transfers(@CurrentActor() actor: Actor, @ZQuery(listTransfersQuerySchema) query: z.infer<typeof listTransfersQuerySchema>) {
    return this.cash.transfers(actor, query);
  }

  @Post("cash/transfers")
  @ApiZodBody(createTransferSchema)
  createTransfer(@CurrentUser() actor: UserActor, @ZBody(createTransferSchema) body: z.infer<typeof createTransferSchema>, @ReqMeta() meta: RequestMeta) {
    return this.cash.createTransfer(actor, body, meta);
  }

  /** By number (scanned) or id. */
  @Get("cash/transfers/:key")
  transfer(@CurrentActor() actor: Actor, @Param("key") key: string) {
    return this.cash.transfer(actor, key);
  }

  @Post("cash/transfers/:id/receive")
  @ApiZodBody(receiveCashSchema)
  receiveTransfer(@CurrentUser() actor: UserActor, @Param("id", ParseUUIDPipe) id: string, @ZBody(receiveCashSchema) body: z.infer<typeof receiveCashSchema>, @ReqMeta() meta: RequestMeta) {
    return this.cash.receiveTransfer(actor, id, body, meta);
  }

  @Post("cash/transfers/:id/cancel")
  cancelTransfer(@CurrentUser() actor: UserActor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.cash.cancelTransfer(actor, id, meta);
  }
}
