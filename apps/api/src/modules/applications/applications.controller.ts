import type { z } from "zod";
import { Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiConflictResponse, ApiCreatedResponse, ApiNotFoundResponse, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { CurrentUser, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { UserActor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { applicationSchema, decideApplicationSchema, listApplicationsQuerySchema, type ApplicationInput } from "./applications.schemas";
import { ApplicationsService } from "./applications.service";

/**
 * Rider and franchise applications: submitted → under review → information requested →
 * approved / rejected (or withdrawn). The conversation with the applicant is the linked support
 * ticket (same number). Merchant applications use POST /merchants/applications.
 */
@ApiTags("applications")
@Controller("applications")
export class ApplicationsController {
  constructor(private readonly applications: ApplicationsService) {}

  /** Any signed-in user can apply (one open application per kind). */
  @ApiBearerAuth()
  @Post()
  @ApiZodBody(applicationSchema)
  @ApiCreatedResponse({ description: "{ application, message }" })
  @ApiConflictResponse({ description: "APPLICATION_PENDING, or ALREADY_A_RIDER" })
  submit(@CurrentUser() actor: UserActor, @ZBody(applicationSchema) body: ApplicationInput, @ReqMeta() meta: RequestMeta) {
    return this.applications.submit(actor, body, meta);
  }

  /** Your own applications and their status. */
  @ApiBearerAuth()
  @Get("mine")
  mine(@CurrentUser() actor: UserActor) {
    return this.applications.mine(actor);
  }

  /** Staff: applications, newest first, with the submitted details. */
  @RequirePermissions("support:manage")
  @Get()
  @ApiZodQuery(listApplicationsQuerySchema)
  @ApiOkResponse({ description: "{ items, nextCursor }" })
  list(@ZQuery(listApplicationsQuerySchema) query: z.infer<typeof listApplicationsQuerySchema>) {
    return this.applications.list(query);
  }

  /** Staff: one application by its number. */
  @RequirePermissions("support:manage")
  @Get(":number")
  @ApiNotFoundResponse({ description: "No such application" })
  detail(@Param("number") number: string) {
    return this.applications.detail(number);
  }

  /** Staff: review / request information / approve (riders: rider:manage — creates the rider and starts KYC onboarding) / reject. */
  @RequirePermissions("support:manage")
  @Post(":number/status")
  @HttpCode(200)
  @ApiZodBody(decideApplicationSchema)
  @ApiConflictResponse({ description: "INVALID_APPLICATION_TRANSITION or APPLICATION_CHANGED" })
  decide(@CurrentUser() actor: UserActor, @Param("number") number: string, @ZBody(decideApplicationSchema) body: z.infer<typeof decideApplicationSchema>, @ReqMeta() meta: RequestMeta) {
    return this.applications.decide(actor, number, body, meta);
  }

  /** The applicant withdraws an open application. */
  @ApiBearerAuth()
  @Post(":number/withdraw")
  @HttpCode(200)
  withdraw(@CurrentUser() actor: UserActor, @Param("number") number: string, @ReqMeta() meta: RequestMeta) {
    return this.applications.withdraw(actor, number, meta);
  }
}
