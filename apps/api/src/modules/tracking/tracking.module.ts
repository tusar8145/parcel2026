import { Module } from "@nestjs/common";
import { ParcelsModule } from "../parcels/parcels.module";
import { TrackingController } from "./tracking.controller";
import { LocationSettingsService } from "./location-settings";
import { ParcelPositionService } from "./parcel-position.service";
import { VehicleShareService } from "./vehicle-share.service";

/**
 * Location settings (rider / vehicle interval), the parcel position resolver for the drawer maps and
 * vehicle location sharing for linehaul trips (docs/architecture-contracts.md, "Parcel position and
 * vehicle location").
 */
@Module({
  imports: [ParcelsModule],
  controllers: [TrackingController],
  providers: [LocationSettingsService, ParcelPositionService, VehicleShareService],
  exports: [ParcelPositionService, VehicleShareService],
})
export class TrackingModule {}
