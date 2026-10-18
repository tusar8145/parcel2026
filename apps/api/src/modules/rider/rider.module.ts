import { Module } from "@nestjs/common";
import { ParcelsModule } from "../parcels/parcels.module";
import { RiderAppController } from "./rider-app.controller";
import { RiderAdminController } from "./rider-admin.controller";
import { RiderLocationService } from "./location.service";
import { ProofService } from "./proof.service";
import { RiderPayService } from "./pay.service";
import { HandoverRequestsService } from "./handover-requests.service";
import { RiderKycService } from "./kyc.service";

/**
 * Rider app back end: live location, proof of delivery, pay (plans, earnings, payouts),
 * cash handover requests and onboarding/KYC. RiderKycService.startOnboarding is the
 * contract for the applications module (docs/architecture-contracts.md).
 */
@Module({
  imports: [ParcelsModule],
  controllers: [RiderAppController, RiderAdminController],
  providers: [RiderLocationService, ProofService, RiderPayService, HandoverRequestsService, RiderKycService],
  exports: [RiderKycService, RiderLocationService, HandoverRequestsService],
})
export class RiderModule {}
