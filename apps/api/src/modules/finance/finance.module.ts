import { Module } from "@nestjs/common";
import { CodService } from "./cod.service";
import { FinanceSettingsController } from "./finance-settings.controller";

/**
 * Finance settings (VAT, the company on bills) and the franchise counter's cash receipt. Merchants' and
 * customers' money lives in modules/money (Accounts); LedgerService (rider pay, franchise) in the global LedgerModule.
 */
@Module({
  controllers: [FinanceSettingsController],
  providers: [CodService],
  exports: [CodService],
})
export class FinanceModule {}
