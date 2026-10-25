import { Module } from "@nestjs/common";
import { MoneyController } from "./money.controller";
import { CashController } from "./cash.controller";
import { AccountsService } from "./accounts.service";
import { PayoutsService } from "./payouts.service";
import { BillsService } from "./bills.service";
import { CashService } from "./cash.service";
import { TabCountsController } from "./tab-counts.controller";
import { TabCountsService } from "./tab-counts.service";

/**
 * Merchants' and customers' money (Courier Operations › Accounts, rider › My cash, merchant › Balance):
 * statements, rider slips → hubs → central hub, settlements, bills and payments. Parcels add their lines
 * themselves (entries.ts, called by ParcelWorkflowService).
 */
@Module({
  controllers: [MoneyController, CashController, TabCountsController],
  providers: [AccountsService, PayoutsService, BillsService, CashService, TabCountsService],
  exports: [AccountsService, PayoutsService, BillsService, CashService],
})
export class MoneyModule {}
