import { Module } from "@nestjs/common";
import { ParcelsModule } from "../parcels/parcels.module";
import { GeographyModule } from "../geography/geography.module";
import { ImportAiService } from "./import-ai.service";
import { PricingModule } from "../pricing/pricing.module";
import { ImportsController } from "./imports.controller";
import { ImportConfigService } from "./import-config.service";
import { ImportEngineService } from "./import-engine.service";
import { ImportJobsService } from "./import-jobs.service";

/** Spreadsheet imports for merchants and operations (one engine; see ImportJobsService). */
@Module({
  imports: [ParcelsModule, PricingModule, GeographyModule],
  controllers: [ImportsController],
  providers: [ImportConfigService, ImportEngineService, ImportJobsService, ImportAiService],
  exports: [ImportJobsService, ImportConfigService, ImportAiService],
})
export class ImportsModule {}
