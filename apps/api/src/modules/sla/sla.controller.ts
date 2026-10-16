import type { z } from "zod";
import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CurrentActor, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZodPipe, ZQuery } from "../../common/zod";
import {
  acknowledgeSchema,
  listAlertsQuerySchema,
  listPoliciesQuerySchema,
  slaPolicySchema,
  slaReportQueryDoc,
  slaReportQuerySchema,
  updateSlaPolicySchema,
} from "./sla.schemas";
import { SlaService } from "./sla.service";

/** SLA policies, at-risk / breach alerts with escalation, and SLA reporting. */
@ApiTags("sla")
@Controller("sla")
export class SlaController {
  constructor(private readonly sla: SlaService) {}

  /** Configured policies plus the built-in defaults (minutes) used when none matches. */
  @RequirePermissions("parcel:read:any")
  @Get("policies")
  @ApiZodQuery(listPoliciesQuerySchema)
  policies(@ZQuery(listPoliciesQuerySchema) query: z.infer<typeof listPoliciesQuerySchema>) {
    return this.sla.listPolicies(query);
  }

  @RequirePermissions("hub:manage")
  @Post("policies")
  @ApiZodBody(slaPolicySchema)
  createPolicy(@CurrentActor() actor: Actor, @ZBody(slaPolicySchema) body: z.infer<typeof slaPolicySchema>, @ReqMeta() meta: RequestMeta) {
    return this.sla.createPolicy(actor, body, meta);
  }

  @RequirePermissions("hub:manage")
  @Patch("policies/:id")
  @ApiZodBody(updateSlaPolicySchema)
  updatePolicy(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(updateSlaPolicySchema) body: z.infer<typeof updateSlaPolicySchema>, @ReqMeta() meta: RequestMeta) {
    return this.sla.updatePolicy(actor, id, body, meta);
  }

  @RequirePermissions("hub:manage")
  @Delete("policies/:id")
  deletePolicy(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.sla.deletePolicy(actor, id, meta);
  }

  @RequirePermissions("parcel:read:any")
  @Get("summary")
  summary(@CurrentActor() actor: Actor) {
    return this.sla.summary(actor);
  }

  @RequirePermissions("parcel:read:any")
  @Get("alerts")
  @ApiZodQuery(listAlertsQuerySchema)
  alerts(@CurrentActor() actor: Actor, @ZQuery(listAlertsQuerySchema) query: z.infer<typeof listAlertsQuerySchema>) {
    return this.sla.listAlerts(actor, query);
  }

  @RequirePermissions("parcel:dispatch")
  @Post("alerts/:id/acknowledge")
  @HttpCode(200)
  @ApiZodBody(acknowledgeSchema)
  acknowledge(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(acknowledgeSchema) body: z.infer<typeof acknowledgeSchema>, @ReqMeta() meta: RequestMeta) {
    return this.sla.acknowledge(actor, id, body, meta);
  }

  /** Runs the SLA check now (it also runs every five minutes). */
  @RequirePermissions("hub:manage")
  @Post("monitor")
  @HttpCode(200)
  monitor() {
    return this.sla.monitor();
  }

  @RequirePermissions("parcel:read:any")
  @Get("report")
  @ApiZodQuery(slaReportQueryDoc)
  report(@CurrentActor() actor: Actor, @Query(new ZodPipe(slaReportQuerySchema)) query: z.infer<typeof slaReportQuerySchema>) {
    return this.sla.report(actor, query);
  }
}
