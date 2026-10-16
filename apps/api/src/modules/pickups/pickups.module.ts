import { Module } from "@nestjs/common";
import { MerchantsModule } from "../merchants/merchants.module";
import { MerchantPickupsController, OpsPickupsController } from "./pickups.controller";
import { PickupsService } from "./pickups.service";

/** Merchant pickup scheduling (recurring and one-off) and the operations pickup list. */
@Module({
  imports: [MerchantsModule],
  controllers: [MerchantPickupsController, OpsPickupsController],
  providers: [PickupsService],
})
export class PickupsModule {}
