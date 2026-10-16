import { Global, Module } from "@nestjs/common";
import { ScansController } from "./scans.controller";
import { ScansService } from "./scans.service";

/** Barcode scan events (global: linehaul, CN stock and the rider app record scans). */
@Global()
@Module({ controllers: [ScansController], providers: [ScansService], exports: [ScansService] })
export class ScansModule {}
