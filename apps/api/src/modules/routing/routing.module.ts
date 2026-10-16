import { Module } from "@nestjs/common";
import { ParcelsModule } from "../parcels/parcels.module";
import { RoutingController } from "./routing.controller";
import { RoutingService } from "./routing.service";

/** Dispatch map, geocoding, route optimisation (OSRM) and assignment suggestions. */
@Module({ imports: [ParcelsModule], controllers: [RoutingController], providers: [RoutingService] })
export class RoutingModule {}
