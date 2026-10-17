import { Module } from "@nestjs/common";
import { ParcelsModule } from "../parcels/parcels.module";
import { ReturnsController } from "./returns.controller";
import { ReturnsService } from "./returns.service";

/** Return to merchant (RTO): requests, return runs, receipt confirmation. */
@Module({
  imports: [ParcelsModule],
  controllers: [ReturnsController],
  providers: [ReturnsService],
  exports: [ReturnsService],
})
export class ReturnsModule {}
