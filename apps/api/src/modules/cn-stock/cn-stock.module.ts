import { Module } from "@nestjs/common";
import { CnStockController } from "./cn-stock.controller";
import { CnStockService } from "./cn-stock.service";

/** Pre-printed consignment-number stock. Bookings use a CN through cn-consume.ts. */
@Module({ controllers: [CnStockController], providers: [CnStockService], exports: [CnStockService] })
export class CnStockModule {}
