import { Module } from "@nestjs/common";
import { PricingModule } from "../pricing/pricing.module";
import { GeographyController } from "./geography.controller";
import { GeographyService } from "./geography.service";

@Module({
  imports: [PricingModule],
  controllers: [GeographyController],
  providers: [GeographyService],
  exports: [GeographyService],
})
export class GeographyModule {}
