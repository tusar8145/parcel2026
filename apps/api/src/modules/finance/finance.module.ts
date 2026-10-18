import { Module } from "@nestjs/common";
import { CodController } from "./cod.controller";
import { CodService } from "./cod.service";
import { InvoicesController } from "./invoices.controller";
import { InvoicesService } from "./invoices.service";
import { SettlementsController } from "./settlements.controller";
import { SettlementsService } from "./settlements.service";
import { LedgerController } from "./ledger.controller";
import { LedgerReportsService } from "./ledger-reports.service";
import { SettlementScheduleService } from "./settlement-schedule.service";
import { ReconciliationController } from "./reconciliation.controller";
import { ReconciliationService } from "./reconciliation.service";
import { DisputesController } from "./disputes.controller";
import { DisputesService } from "./disputes.service";

/**
 * COD cash custody (rider → hub), merchant settlements (automatic schedule, carry-forward),
 * VAT invoices, the double-entry ledger (LedgerService lives in the global LedgerModule),
 * bank / bKash reconciliation, and refunds / claims / weight disputes.
 */
@Module({
  controllers: [CodController, SettlementsController, InvoicesController, LedgerController, ReconciliationController, DisputesController],
  providers: [CodService, SettlementsService, InvoicesService, LedgerReportsService, SettlementScheduleService, ReconciliationService, DisputesService],
  exports: [SettlementsService, DisputesService, InvoicesService, CodService],
})
export class FinanceModule {}
