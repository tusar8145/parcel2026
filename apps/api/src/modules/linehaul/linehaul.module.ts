import { Module } from "@nestjs/common";
import { ParcelsModule } from "../parcels/parcels.module";
import { LinehaulController } from "./linehaul.controller";
import { LinehaulService } from "./linehaul.service";
import { TransferService } from "./transfer.service";

/** Linehaul between hubs: bags, trips/manifests, receiving and discrepancies; transfers by Excel (TransferService, used by bulk updates). */
@Module({ imports: [ParcelsModule], controllers: [LinehaulController], providers: [LinehaulService, TransferService], exports: [LinehaulService, TransferService] })
export class LinehaulModule {}
