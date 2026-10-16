import { Module } from "@nestjs/common";
import { ParcelsModule } from "../parcels/parcels.module";
import { FeedbackController } from "./feedback.controller";
import { FeedbackService } from "./feedback.service";

@Module({ imports: [ParcelsModule], controllers: [FeedbackController], providers: [FeedbackService] })
export class FeedbackModule {}
