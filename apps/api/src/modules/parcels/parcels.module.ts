import { Module } from "@nestjs/common";
import { PricingModule } from "../pricing/pricing.module";
import { ParcelsController } from "./parcels.controller";
import { ParcelsService } from "./parcels.service";
import { ParcelWorkflowService } from "./parcel-workflow.service";
import { RiderTasksService } from "./rider-tasks.service";
import { PickupSlotsService } from "./pickup-slots.service";
import { PickupSlotsController } from "./pickup-slots.controller";
import { GuestBookingService } from "./guest-booking.service";
import { GuestBookingController } from "./guest-booking.controller";
import { IntakeChangeController } from "./intake-change.controller";
import { IntakeChangeService } from "./intake-change.service";
import { CompleteDetailsController } from "./complete-details.controller";
import { CompleteDetailsService } from "./complete-details.service";
import { CollectionsController } from "./collections.controller";
import { CollectionsService } from "./collections.service";
import { ParcelMessagesController } from "./parcel-messages.controller";
import { ParcelMessagesService } from "./parcel-messages.service";
import { HubDeskController } from "./hub-desk.controller";
import { HubDeskService } from "./hub-desk.service";
import { ParcelCorrectionsController } from "./parcel-corrections.controller";
import { ParcelCorrectionsService } from "./parcel-corrections.service";

@Module({
  imports: [PricingModule],
  controllers: [ParcelsController, GuestBookingController, PickupSlotsController, IntakeChangeController, CompleteDetailsController, CollectionsController, ParcelMessagesController, HubDeskController, ParcelCorrectionsController],
  providers: [ParcelsService, ParcelWorkflowService, RiderTasksService, PickupSlotsService, GuestBookingService, IntakeChangeService, CompleteDetailsService, CollectionsService, ParcelMessagesService, HubDeskService, ParcelCorrectionsService],
  exports: [ParcelsService, ParcelWorkflowService, HubDeskService, PickupSlotsService, IntakeChangeService, CompleteDetailsService, CollectionsService],
})
export class ParcelsModule {}
