import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { z } from "zod";
import { CurrentActor, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { ApprovalsService, approvalSettingSchema, decideChangeSchema, listChangesQuerySchema, rejectChangeSchema } from "./approvals.service";

/**
 * Maker-checker queue: rate cards, merchant tariffs, role permissions and custom roles
 * changed by one super admin wait here until a different super admin approves them.
 */
@ApiTags("approvals")
@Controller("admin/changes")
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  /** Newest first. `status=PENDING` is the queue; items say whether you can approve or cancel them. */
  @RequirePermissions("config:manage")
  @Get()
  @ApiZodQuery(listChangesQuerySchema)
  list(@CurrentActor() actor: Actor, @ZQuery(listChangesQuerySchema) query: z.infer<typeof listChangesQuerySchema>) {
    return this.approvals.list(actor, query);
  }

  /** Pending count and whether this platform needs a second approver at all. */
  @RequirePermissions("config:manage")
  @Get("summary")
  async summary(@CurrentActor() actor: Actor) {
    return { pending: await this.approvals.pendingCount(), approvalRequired: await this.approvals.approvalRequired(actor) };
  }

  /** Second super admin approval: on / off (off by default), how many super admins there are. */
  @RequirePermissions("config:manage")
  @Get("settings")
  setting(@CurrentActor() actor: Actor) {
    return this.approvals.setting(actor);
  }

  /** Turn it on (applies at once) or off (waits for a second super admin while it is on). */
  @RequirePermissions("change:approve")
  @Put("settings")
  @ApiZodBody(approvalSettingSchema)
  saveSetting(@CurrentActor() actor: Actor, @ZBody(approvalSettingSchema) body: z.infer<typeof approvalSettingSchema>, @ReqMeta() meta: RequestMeta) {
    return this.approvals.saveSetting(actor, body.enabled, meta);
  }

  /** Applies the change (another super admin's request only). */
  @RequirePermissions("change:approve")
  @Post(":id/approve")
  @HttpCode(200)
  @ApiZodBody(decideChangeSchema)
  approve(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(decideChangeSchema) body: z.infer<typeof decideChangeSchema>, @ReqMeta() meta: RequestMeta) {
    return this.approvals.approve(actor, id, body.note, meta);
  }

  @RequirePermissions("change:approve")
  @Post(":id/reject")
  @HttpCode(200)
  @ApiZodBody(rejectChangeSchema)
  reject(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(rejectChangeSchema) body: z.infer<typeof rejectChangeSchema>, @ReqMeta() meta: RequestMeta) {
    return this.approvals.reject(actor, id, body.note, meta);
  }

  /** The requester withdraws their own pending change. */
  @RequirePermissions("config:manage")
  @Post(":id/cancel")
  @HttpCode(200)
  cancel(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.approvals.cancel(actor, id, meta);
  }
}
