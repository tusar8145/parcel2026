import { Module } from "@nestjs/common";
import { ParcelsModule } from "../parcels/parcels.module";
import { PricingModule } from "../pricing/pricing.module";
import { ParcelScansModule } from "../parcel-scans/parcel-scans.module";
import { CnStockController } from "./cn-stock.controller";
import { CnStockService } from "./cn-stock.service";
import { CnParcelsController } from "./cn-parcels.controller";
import { CnParcelsService } from "./cn-parcels.service";

/** Pre-printed consignment-number stock (bookings use a CN through cn-consume.ts) and the apps' CN_Merchant / CN_Scan. */
@Module({
  imports: [ParcelsModule, PricingModule, ParcelScansModule],
  controllers: [CnStockController, CnParcelsController],
  providers: [CnStockService, CnParcelsService],
  exports: [CnStockService, CnParcelsService],
})
export class CnStockModule {}
