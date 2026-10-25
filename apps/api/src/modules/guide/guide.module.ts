import { Module } from "@nestjs/common";
import { GuideController } from "./guide.controller";

/** System guide: what the platform's numbers, parcel statuses, money steps and roles mean (packages/shared). */
@Module({ controllers: [GuideController] })
export class GuideModule {}
