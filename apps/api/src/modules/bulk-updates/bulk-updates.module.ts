import { Module } from "@nestjs/common";
import { ParcelsModule } from "../parcels/parcels.module";
import { PricingModule } from "../pricing/pricing.module";
import { ImportsModule } from "../imports/imports.module";
import { RoutingModule } from "../routing/routing.module";
import { BulkUpdatesController } from "./bulk-updates.controller";
import { BulkUpdatesService } from "./bulk-updates.service";

/** Bulk operations by Excel for Courier Operations (on the spreadsheet import engine). */
@Module({
  imports: [ParcelsModule, PricingModule, ImportsModule, RoutingModule],
  controllers: [BulkUpdatesController],
  providers: [BulkUpdatesService],
  exports: [BulkUpdatesService],
})
export class BulkUpdatesModule {}
