import { Module } from "@nestjs/common";
import { LiveMapController, StaffLocationController } from "./live-map.controller";
import { LiveMapService } from "./live-map.service";
import { StaffLocationService } from "./staff-location.service";

/** Super admin › Live map, and the Operations app's position updates. */
@Module({ controllers: [LiveMapController, StaffLocationController], providers: [LiveMapService, StaffLocationService] })
export class LiveMapModule {}
