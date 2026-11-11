import { Module } from "@nestjs/common";
import { PricingModule } from "../pricing/pricing.module";
import { NetworkController } from "./network.controller";
import { NetworkService } from "./network.service";
import { HubLocateService } from "./hub-locate.service";
import { GeoModule } from "../geo/geo.module";
import { NetworkConfigController } from "./network-config.controller";
import { NetworkConfigService } from "./network-config.service";

@Module({
  imports: [PricingModule, GeoModule],
  controllers: [NetworkController, NetworkConfigController],
  providers: [NetworkService, NetworkConfigService, HubLocateService],
  exports: [NetworkService, NetworkConfigService],
})
export class NetworkModule {}
