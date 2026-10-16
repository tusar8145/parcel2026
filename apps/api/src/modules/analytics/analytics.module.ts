import { Global, Module } from "@nestjs/common";
import { AnalyticsController } from "./analytics.controller";
import { AnalyticsService } from "./analytics.service";

/** First-party page view and tracking-lookup counts. Global: the public tracking endpoint counts lookups. */
@Global()
@Module({ controllers: [AnalyticsController], providers: [AnalyticsService], exports: [AnalyticsService] })
export class AnalyticsModule {}
