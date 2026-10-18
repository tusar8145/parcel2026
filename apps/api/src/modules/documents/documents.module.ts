import { Module } from "@nestjs/common";
import { FinanceModule } from "../finance/finance.module";
import { LinehaulModule } from "../linehaul/linehaul.module";
import { CnStockModule } from "../cn-stock/cn-stock.module";
import { ReturnsModule } from "../returns/returns.module";
import { ReportsModule } from "../reports/reports.module";
import { SlaModule } from "../sla/sla.module";
import { HubReconciliationModule } from "../hub-reconciliation/hub-reconciliation.module";
import { DocumentsController } from "./documents.controller";
import { DocumentsService } from "./documents.service";

/** Printable PDFs (labels, invoices, manifests, run sheets, statements, reports) for every print button. */
@Module({
  imports: [FinanceModule, LinehaulModule, CnStockModule, ReturnsModule, ReportsModule, SlaModule, HubReconciliationModule],
  controllers: [DocumentsController],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
