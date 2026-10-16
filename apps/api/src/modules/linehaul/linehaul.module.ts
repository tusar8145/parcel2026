import { Module } from "@nestjs/common";
import { ParcelsModule } from "../parcels/parcels.module";
import { LinehaulController } from "./linehaul.controller";
import { LinehaulService } from "./linehaul.service";

/** Linehaul between hubs: bags, trips/manifests, receiving and discrepancies. */
@Module({ imports: [ParcelsModule], controllers: [LinehaulController], providers: [LinehaulService] })
export class LinehaulModule {}
