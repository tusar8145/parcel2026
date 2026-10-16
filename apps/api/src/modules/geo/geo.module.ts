import { Global, Module } from "@nestjs/common";
import { GeoController } from "./geo.controller";
import { GeoService } from "./geo.service";

/** Global: other modules inject GeoService for server-side geocoding. */
@Global()
@Module({ controllers: [GeoController], providers: [GeoService], exports: [GeoService] })
export class GeoModule {}
