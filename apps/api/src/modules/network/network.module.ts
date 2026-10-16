import { Module } from "@nestjs/common";
import { PricingModule } from "../pricing/pricing.module";
import { NetworkController } from "./network.controller";
import { NetworkService } from "./network.service";
import { NetworkConfigController } from "./network-config.controller";
import { NetworkConfigService } from "./network-config.service";

@Module({
  imports: [PricingModule],
  controllers: [NetworkController, NetworkConfigController],
  providers: [NetworkService, NetworkConfigService],
  exports: [NetworkService, NetworkConfigService],
})
export class NetworkModule {}
