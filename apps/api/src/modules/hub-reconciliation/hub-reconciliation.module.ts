import { Module } from "@nestjs/common";
import { HubReconciliationController } from "./hub-reconciliation.controller";
import { HubReconciliationService } from "./hub-reconciliation.service";

/** End-of-day hub reconciliation (Courier Operations › Hub desk › End of day; PDF in modules/documents). */
@Module({
  controllers: [HubReconciliationController],
  providers: [HubReconciliationService],
  exports: [HubReconciliationService],
})
export class HubReconciliationModule {}
