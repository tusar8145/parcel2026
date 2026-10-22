import { Module } from "@nestjs/common";
import { ImportsModule } from "../imports/imports.module";
import { PricingModule } from "../pricing/pricing.module";
import { ParcelScansController } from "./parcel-scans.controller";
import { ParcelScansService } from "./parcel-scans.service";
import { ScanReaderService } from "./scan-reader";

@Module({
  imports: [ImportsModule, PricingModule],
  controllers: [ParcelScansController],
  providers: [ParcelScansService, ScanReaderService],
  exports: [ParcelScansService],
})
export class ParcelScansModule {}
