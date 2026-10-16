import type { z } from "zod";
import { Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { CurrentUser, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { UserActor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { forbidden } from "../../common/errors";
import { DisputesService, isDisputeStaff } from "./disputes.service";
import { approveDisputeSchema, createDisputeSchema, disputeNoteSchema, listDisputesQuerySchema, rejectDisputeSchema } from "./disputes.schemas";

/**
 * Refunds, claims (damaged / lost parcels, overcharges) and weight discrepancies.
 * Anyone signed in may raise one on a parcel they can see; finance and support review; finance decides.
 */
@ApiTags("disputes")
@Controller("disputes")
export class DisputesController {
  constructor(private readonly disputes: DisputesService) {}

  @ApiBearerAuth()
  @Post()
  @ApiZodBody(createDisputeSchema)
  create(@CurrentUser() actor: UserActor, @ZBody(createDisputeSchema) body: z.infer<typeof createDisputeSchema>, @ReqMeta() meta: RequestMeta) {
    return this.disputes.create(actor, body, meta);
  }

  /** Your disputes (merchant owners: your merchant's); finance and support staff see all. */
  @ApiBearerAuth()
  @Get()
  @ApiZodQuery(listDisputesQuerySchema)
  list(@CurrentUser() actor: UserActor, @ZQuery(listDisputesQuerySchema) query: z.infer<typeof listDisputesQuerySchema>) {
    return this.disputes.list(actor, query);
  }

  @ApiBearerAuth()
  @Get(":number")
  detail(@CurrentUser() actor: UserActor, @Param("number") number: string) {
    return this.disputes.detail(actor, number);
  }

  /** Message (and more evidence); staff may add internal notes. */
  @ApiBearerAuth()
  @Post(":number/notes")
  @ApiZodBody(disputeNoteSchema)
  note(@CurrentUser() actor: UserActor, @Param("number") number: string, @ZBody(disputeNoteSchema) body: z.infer<typeof disputeNoteSchema>, @ReqMeta() meta: RequestMeta) {
    return this.disputes.addNote(actor, number, body, meta);
  }

  /** Staff take it for review (OPEN → UNDER_REVIEW). */
  @ApiBearerAuth()
  @Post(":number/review")
  @HttpCode(200)
  review(@CurrentUser() actor: UserActor, @Param("number") number: string, @ReqMeta() meta: RequestMeta) {
    if (!isDisputeStaff(actor)) throw forbidden("Only finance and support staff review disputes");
    return this.disputes.review(actor, number, meta);
  }

  /** Finance approves: refund / claim (merchant balance, bank, bKash or cash) or weight re-pricing. */
  @RequirePermissions("finance:manage")
  @Post(":number/approve")
  @HttpCode(200)
  @ApiZodBody(approveDisputeSchema)
  approve(@CurrentUser() actor: UserActor, @Param("number") number: string, @ZBody(approveDisputeSchema) body: z.infer<typeof approveDisputeSchema>, @ReqMeta() meta: RequestMeta) {
    return this.disputes.approve(actor, number, body, meta);
  }

  @RequirePermissions("finance:manage")
  @Post(":number/reject")
  @HttpCode(200)
  @ApiZodBody(rejectDisputeSchema)
  reject(@CurrentUser() actor: UserActor, @Param("number") number: string, @ZBody(rejectDisputeSchema) body: z.infer<typeof rejectDisputeSchema>, @ReqMeta() meta: RequestMeta) {
    return this.disputes.reject(actor, number, body, meta);
  }
}
