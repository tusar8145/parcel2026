import { Module } from "@nestjs/common";
import { SlaController } from "./sla.controller";
import { SlaService } from "./sla.service";

/** SLA engine: policies, the five-minute monitor job, alerts, escalation and reporting. */
@Module({ controllers: [SlaController], providers: [SlaService], exports: [SlaService] })
export class SlaModule {}
