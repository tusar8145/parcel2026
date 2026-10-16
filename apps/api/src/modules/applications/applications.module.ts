import { Module } from "@nestjs/common";
import { SupportModule } from "../support/support.module";
import { NetworkModule } from "../network/network.module";
import { RiderModule } from "../rider/rider.module";
import { ApplicationsController } from "./applications.controller";
import { ApplicationsService } from "./applications.service";

/** Rider and franchise applications (workflow in applications.service.ts). */
@Module({ imports: [SupportModule, NetworkModule, RiderModule], controllers: [ApplicationsController], providers: [ApplicationsService] })
export class ApplicationsModule {}
