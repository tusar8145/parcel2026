import type { z } from "zod";
import { Controller, Get, Post, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { CurrentActor, RequirePermissions } from "../../common/auth/decorators";
import type { Actor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZodPipe, ZQuery } from "../../common/zod";
import { complianceQueryDoc, complianceQuerySchema, listScansQuerySchema, recordScanSchema } from "./scans.schemas";
import { ScansService } from "./scans.service";

/** Barcode scans and scan compliance (expected vs actual scans per hub and rider). */
@ApiTags("scans")
@Controller("scans")
export class ScansController {
  constructor(private readonly scans: ScansService) {}

  /** Records a scan from the hub console (staff) or the rider app (riders). */
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @Post()
  @ApiZodBody(recordScanSchema)
  record(@CurrentActor() actor: Actor, @ZBody(recordScanSchema) body: z.infer<typeof recordScanSchema>) {
    return this.scans.recordFor(actor, body);
  }

  @RequirePermissions("hub:read")
  @Get()
  @ApiZodQuery(listScansQuerySchema)
  list(@CurrentActor() actor: Actor, @ZQuery(listScansQuerySchema) query: z.infer<typeof listScansQuerySchema>) {
    return this.scans.list(actor, query);
  }

  /** Expected vs actual scans per hub and rider in a Dhaka date range (default: the last 7 days). */
  @RequirePermissions("hub:read")
  @Get("compliance")
  @ApiZodQuery(complianceQueryDoc)
  compliance(@CurrentActor() actor: Actor, @Query(new ZodPipe(complianceQuerySchema)) query: z.infer<typeof complianceQuerySchema>) {
    return this.scans.compliance(actor, query);
  }
}
