import { Global, Module } from "@nestjs/common";
import { AnalyticsController } from "./analytics.controller";
import { AnalyticsService } from "./analytics.service";
import { WebsiteActivityService } from "./website-activity.service";

/** First-party page view and tracking-lookup counts. Global: the public tracking endpoint counts lookups. */
@Global()
@Module({ controllers: [AnalyticsController], providers: [AnalyticsService, WebsiteActivityService], exports: [AnalyticsService, WebsiteActivityService] })
export class AnalyticsModule {}
