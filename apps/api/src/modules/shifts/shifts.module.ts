import { Module } from "@nestjs/common";
import { RiderShiftController, ShiftsController } from "./shifts.controller";
import { ShiftsService } from "./shifts.service";

/** Rider shifts and attendance (operations + the rider app's check-in / check-out). */
@Module({ controllers: [ShiftsController, RiderShiftController], providers: [ShiftsService], exports: [ShiftsService] })
export class ShiftsModule {}
