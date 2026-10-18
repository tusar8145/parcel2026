import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PricingModule } from "../pricing/pricing.module";
import { ParcelsModule } from "../parcels/parcels.module";
import { MerchantSelfController, MerchantsController, PlansController } from "./merchants.controller";
import { MerchantAdminController, MerchantSelfReviewController } from "./merchant-admin.controller";
import { MerchantToolsController } from "./merchant-tools.controller";
import { MerchantsService } from "./merchants.service";
import { MerchantIntegrationsService } from "./merchant-integrations.service";
import { PlansService } from "./plans.service";
import { MerchantStatsService } from "./merchant-stats.service";
import { MerchantPlanService } from "./merchant-plan.service";
import { MerchantKycService } from "./merchant-kyc.service";
import { MerchantReviewService } from "./merchant-review.service";
import { MerchantToolsService } from "./merchant-tools.service";

@Module({
  imports: [AuthModule, PricingModule, ParcelsModule],
  // Static paths (merchants/invites, merchants/kyc-policy, merchants/me/...) before merchants/:id.
  controllers: [MerchantSelfController, MerchantSelfReviewController, MerchantToolsController, MerchantAdminController, MerchantsController, PlansController],
  providers: [MerchantsService, MerchantIntegrationsService, MerchantStatsService, MerchantPlanService, PlansService, MerchantKycService, MerchantReviewService, MerchantToolsService],
  exports: [MerchantsService, MerchantKycService],
})
export class MerchantsModule {}
