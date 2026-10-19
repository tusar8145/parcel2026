import { Module } from "@nestjs/common";
import { ParcelsModule } from "../parcels/parcels.module";
import { OpsModule } from "../ops/ops.module";
import { LinehaulModule } from "../linehaul/linehaul.module";
import { WorkQueueController } from "./work-queue.controller";
import { WorkQueueService } from "./work-queue.service";

@Module({ imports: [ParcelsModule, OpsModule, LinehaulModule], controllers: [WorkQueueController], providers: [WorkQueueService] })
export class WorkQueueModule {}
