import { Module } from "@nestjs/common";
import { ParcelsModule } from "../parcels/parcels.module";
import { RoutingController } from "./routing.controller";
import { RoutingService } from "./routing.service";
import { AddressAiService } from "./address-ai.service";
import { AddressAiController, RiderRouteController } from "./rider-route.controller";

/** Dispatch map, geocoding (with the optional AI address reading), route optimisation (OSRM), the rider's own best route and assignment suggestions. */
@Module({ imports: [ParcelsModule], controllers: [RoutingController, RiderRouteController, AddressAiController], providers: [RoutingService, AddressAiService], exports: [RoutingService, AddressAiService] })
export class RoutingModule {}
