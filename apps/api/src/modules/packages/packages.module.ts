import { Global, Module } from "@nestjs/common";
import { PricingModule } from "../pricing/pricing.module";
import { PackagesController } from "./packages.controller";
import { PackagesService } from "./packages.service";
import { HubGroupsService } from "./hub-groups.service";
import { ParcelProductsService } from "./parcel-products.service";

/** Service packages, hub groups and products. Global: booking, imports, notifications and guards read packages. */
@Global()
@Module({
  imports: [PricingModule],
  controllers: [PackagesController],
  providers: [PackagesService, HubGroupsService, ParcelProductsService],
  exports: [PackagesService, HubGroupsService, ParcelProductsService],
})
export class PackagesModule {}
