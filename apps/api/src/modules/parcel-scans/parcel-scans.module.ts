import { Module } from "@nestjs/common";
import { ImportsModule } from "../imports/imports.module";
import { PricingModule } from "../pricing/pricing.module";
import { ParcelScansController } from "./parcel-scans.controller";
import { ParcelScansService } from "./parcel-scans.service";
import { ScanReaderService } from "./scan-reader";
import { ScanAiService } from "./scan-ai";
import { MessageReaderController, MessageReaderService } from "./message-reader";

@Module({
  imports: [ImportsModule, PricingModule],
  controllers: [ParcelScansController, MessageReaderController],
  providers: [ParcelScansService, ScanReaderService, ScanAiService, MessageReaderService],
  exports: [ParcelScansService],
})
export class ParcelScansModule {}
