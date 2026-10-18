import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ParcelsModule } from "../parcels/parcels.module";
import { OpsModule } from "../ops/ops.module";
import { ReturnsModule } from "../returns/returns.module";
import { NetworkModule } from "../network/network.module";
import { FinanceModule } from "../finance/finance.module";
import { RiderModule } from "../rider/rider.module";
import { DocumentsModule } from "../documents/documents.module";
import { FranchiseAdminController, FranchiseFinanceController, FranchisePanelController } from "./franchise.controller";
import { FranchiseAdminService } from "./franchise-admin.service";
import { FranchisePanelService } from "./franchise-panel.service";
import { FranchiseMoneyService } from "./franchise-money.service";

/** Franchise hubs: the franchise panel, super admin management, deposits and commission invoices. */
@Module({
  imports: [AuthModule, ParcelsModule, OpsModule, ReturnsModule, NetworkModule, FinanceModule, RiderModule, DocumentsModule],
  controllers: [FranchisePanelController, FranchiseAdminController, FranchiseFinanceController],
  providers: [FranchiseAdminService, FranchisePanelService, FranchiseMoneyService],
})
export class FranchiseModule {}
