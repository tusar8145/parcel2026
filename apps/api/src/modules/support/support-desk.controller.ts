import type { z } from "zod";
import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CurrentUser, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { UserActor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { SupportDeskService } from "./support-desk.service";
import { cannedResponseSchema, csatReportQuerySchema, csatSchema, listCannedQuerySchema, updateCannedResponseSchema, updateSlaSchema } from "./support-desk.schemas";

/** Canned responses, CSAT and SLA for the support desk. */
@ApiTags("support")
@Controller("support")
export class SupportDeskController {
  constructor(private readonly desk: SupportDeskService) {}

  // ───────────── canned responses ─────────────

  @RequirePermissions("support:manage")
  @Get("canned-responses")
  @ApiZodQuery(listCannedQuerySchema)
  listCanned(@ZQuery(listCannedQuerySchema) query: z.infer<typeof listCannedQuerySchema>) {
    return this.desk.listCanned(query);
  }

  @RequirePermissions("support:manage")
  @Post("canned-responses")
  @ApiZodBody(cannedResponseSchema)
  createCanned(@CurrentUser() actor: UserActor, @ZBody(cannedResponseSchema) body: z.infer<typeof cannedResponseSchema>, @ReqMeta() meta: RequestMeta) {
    return this.desk.createCanned(actor, body, meta);
  }

  @RequirePermissions("support:manage")
  @Patch("canned-responses/:id")
  @ApiZodBody(updateCannedResponseSchema)
  updateCanned(
    @CurrentUser() actor: UserActor,
    @Param("id", ParseUUIDPipe) id: string,
    @ZBody(updateCannedResponseSchema) body: z.infer<typeof updateCannedResponseSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.desk.updateCanned(actor, id, body, meta);
  }

  @RequirePermissions("support:manage")
  @Delete("canned-responses/:id")
  @HttpCode(204)
  async deleteCanned(@CurrentUser() actor: UserActor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    await this.desk.deleteCanned(actor, id, meta);
  }

  // ───────────── CSAT ─────────────

  /** The requester rates their resolved ticket (1–5, optional comment), once. */
  @RequirePermissions("support:create")
  @Post("tickets/:number/csat")
  @ApiZodBody(csatSchema)
  csat(@CurrentUser() actor: UserActor, @Param("number") number: string, @ZBody(csatSchema) body: z.infer<typeof csatSchema>, @ReqMeta() meta: RequestMeta) {
    return this.desk.submitCsat(actor, number, body, meta);
  }

  /** Response rate, average, distribution, per-agent averages and recent comments. */
  @RequirePermissions("support:manage")
  @Get("csat/report")
  @ApiZodQuery(csatReportQuerySchema)
  csatReport(@ZQuery(csatReportQuerySchema) query: z.infer<typeof csatReportQuerySchema>) {
    return this.desk.csatReport(query);
  }

  // ───────────── SLA ─────────────

  /** First-response and resolution targets per priority (minutes) and escalation options. */
  @RequirePermissions("support:manage")
  @Get("sla")
  sla() {
    return this.desk.getSla();
  }

  /** Operations managers and super admins. */
  @RequirePermissions("support:manage")
  @Put("sla")
  @ApiZodBody(updateSlaSchema)
  updateSla(@CurrentUser() actor: UserActor, @ZBody(updateSlaSchema) body: z.infer<typeof updateSlaSchema>, @ReqMeta() meta: RequestMeta) {
    SupportDeskService.assertCanConfigure(actor);
    return this.desk.updateSla(actor, body, meta);
  }

  /** Open / paused / breached / at-risk (due within an hour) / unassigned counts. */
  @RequirePermissions("support:manage")
  @Get("sla/overview")
  overview() {
    return this.desk.overview();
  }

  /** Runs the breach check now (the job runs every 5 minutes). */
  @RequirePermissions("support:manage")
  @Post("sla/check")
  @HttpCode(200)
  check() {
    return this.desk.checkSla();
  }
}
