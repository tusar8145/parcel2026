import { Controller, Get, HttpCode, Param, Post, Res } from "@nestjs/common";
import { ApiOkResponse, ApiProduces, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { FastifyReply } from "fastify";
import type { z } from "zod";
import { CurrentActor, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { queueListQuerySchema, queueQuerySchema, queueScanSchema } from "./work-queue.schemas";
import { WorkQueueService } from "./work-queue.service";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const attachment = (name: string) => `attachment; filename="${name.replace(/["\\\r\n]/g, "_")}"`;

/**
 * Courier Operations work queue: each parcel's next step (pickups to assign, drop-offs and transfers to
 * receive, transfers to dispatch, deliveries to assign, …) with counts, groups (route, area, rider, hub),
 * lists, Excel, and a scan that does the step. Hub staff see their hubs' work only.
 */
@ApiTags("work-queue")
@Controller("work-queue")
export class WorkQueueController {
  constructor(private readonly queue: WorkQueueService) {}

  /** Every task with its count, plus parcels missing delivery details. */
  @RequirePermissions("parcel:read:any")
  @Get()
  @ApiZodQuery(queueQuerySchema)
  @ApiOkResponse({ description: "{ tasks: [{ key, label, hint, stage, action, actionLabel, count }], missingDetails: { key, label, count } }" })
  overview(@CurrentActor() actor: Actor, @ZQuery(queueQuerySchema) query: z.infer<typeof queueQuerySchema>) {
    return this.queue.overview(actor, query);
  }

  /** One task's groups (e.g. "Dhaka Hub → Barishal Hub"), largest first. */
  @RequirePermissions("parcel:read:any")
  @Get(":task")
  @ApiZodQuery(queueQuerySchema)
  groups(@CurrentActor() actor: Actor, @Param("task") task: string, @ZQuery(queueQuerySchema) query: z.infer<typeof queueQuerySchema>) {
    return this.queue.groups(actor, task, query);
  }

  /** The parcels of a task or one of its groups (up to 1,000; the Excel file has them all). */
  @RequirePermissions("parcel:read:any")
  @Get(":task/parcels")
  @ApiZodQuery(queueListQuerySchema)
  list(@CurrentActor() actor: Actor, @Param("task") task: string, @ZQuery(queueListQuerySchema) query: z.infer<typeof queueListQuerySchema>) {
    return this.queue.list(actor, task, query);
  }

  /** The same parcels as an Excel file. */
  @RequirePermissions("parcel:read:any")
  @Get(":task/export")
  @ApiProduces(XLSX)
  @ApiZodQuery(queueListQuerySchema)
  async export(@CurrentActor() actor: Actor, @Param("task") task: string, @ZQuery(queueListQuerySchema) query: z.infer<typeof queueListQuerySchema>, @Res() reply: FastifyReply) {
    const file = await this.queue.export(actor, task, query);
    return reply
      .status(200)
      .header("content-type", XLSX)
      .header("content-disposition", attachment(file.fileName))
      .header("cache-control", "no-store")
      .header("x-row-count", String(file.count))
      .header("access-control-expose-headers", "x-row-count, content-disposition")
      .send(file.buffer);
  }

  /** Scan a parcel to do the task's step (assign, receive, dispatch, out for delivery). Answers per parcel; never fails for a parcel problem. */
  @RequirePermissions("parcel:dispatch")
  @Post(":task/scan")
  @HttpCode(200)
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @ApiZodBody(queueScanSchema)
  @ApiOkResponse({ description: "{ ok, outcome: DONE | NOT_FOUND | NOT_IN_QUEUE | OTHER_GROUP | NO_DESTINATION | HUB_REQUIRED | REFUSED | <receive outcome>, message, code, parcel? }" })
  scan(@CurrentActor() actor: Actor, @Param("task") task: string, @ZBody(queueScanSchema) body: z.infer<typeof queueScanSchema>, @ReqMeta() meta: RequestMeta) {
    return this.queue.scan(actor, task, body, meta);
  }
}
