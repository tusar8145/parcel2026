import { Module } from "@nestjs/common";
import { ParcelsModule } from "../parcels/parcels.module";
import { PricingModule } from "../pricing/pricing.module";
import { LinehaulModule } from "../linehaul/linehaul.module";
import { OpsController } from "./ops.controller";
import { OpsService } from "./ops.service";
import { HubIntakeController } from "./hub-intake.controller";
import { HubIntakeService } from "./hub-intake.service";
import { StageCountsService } from "./stage-counts.service";

/** Courier Operations console: counters, dispatch, analytics, reports, bookings by staff and hub drop-off intake. */
@Module({
  imports: [ParcelsModule, PricingModule, LinehaulModule],
  controllers: [OpsController, HubIntakeController],
  providers: [OpsService, HubIntakeService, StageCountsService],
})
export class OpsModule {}
