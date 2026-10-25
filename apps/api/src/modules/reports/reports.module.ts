import { Module } from "@nestjs/common";
import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";
import { RiderReportService } from "./rider-report.service";
import { HubTransferReportService } from "./hub-transfer-report.service";

/** Operations reports and the hourly scheduled-report job. */
@Module({ controllers: [ReportsController], providers: [ReportsService, RiderReportService, HubTransferReportService], exports: [ReportsService] })
export class ReportsModule {}
