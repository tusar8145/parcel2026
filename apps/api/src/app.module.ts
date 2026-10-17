import { Module, RequestMethod } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { LoggerModule } from "nestjs-pino";
import { randomUUID } from "node:crypto";
import { env } from "./config/env";
import { CommonModule } from "./common/common.module";
import { PrismaModule } from "./common/prisma.service";
import { RedisModule } from "./common/redis.service";
import { QueueModule } from "./common/queues";
import { AuditModule } from "./common/audit.service";
import { AuthGuard } from "./common/auth/auth.guard";
import { AllExceptionsFilter } from "./common/exception.filter";
import { RedisThrottlerStorage } from "./common/throttler-redis.storage";
import { NotificationsModule } from "./modules/notifications/notifications.module";
import { AuthModule } from "./modules/auth/auth.module";
import { HealthController } from "./modules/health/health.controller";
import { StorageModule } from "./common/storage.service";
import { RealtimeModule } from "./common/realtime.service";
import { LedgerModule } from "./modules/finance/ledger.service";
import { EventsController } from "./modules/health/events.controller";
import { NetworkModule } from "./modules/network/network.module";
import { PricingModule } from "./modules/pricing/pricing.module";
import { ParcelsModule } from "./modules/parcels/parcels.module";
import { AccountsModule } from "./modules/accounts/accounts.module";
import { MerchantsModule } from "./modules/merchants/merchants.module";
import { FinanceModule } from "./modules/finance/finance.module";
import { SupportModule } from "./modules/support/support.module";
import { AdminModule } from "./modules/admin/admin.module";
import { OpsModule } from "./modules/ops/ops.module";
import { ApplicationsModule } from "./modules/applications/applications.module";
import { RiderModule } from "./modules/rider/rider.module";
import { ApprovalsModule } from "./modules/approvals/approvals.module";
import { AnalyticsModule } from "./modules/analytics/analytics.module";
import { ReturnsModule } from "./modules/returns/returns.module";
import { PickupsModule } from "./modules/pickups/pickups.module";
import { GeoModule } from "./modules/geo/geo.module";
import { GeographyModule } from "./modules/geography/geography.module";
import { FeedbackModule } from "./modules/feedback/feedback.module";
import { EmailVerificationModule } from "./modules/auth/email-verification.controller";
import { ScansModule } from "./modules/scans/scans.module";
import { LinehaulModule } from "./modules/linehaul/linehaul.module";
import { CnStockModule } from "./modules/cn-stock/cn-stock.module";
import { SlaModule } from "./modules/sla/sla.module";
import { ShiftsModule } from "./modules/shifts/shifts.module";
import { ReportsModule } from "./modules/reports/reports.module";
import { RoutingModule } from "./modules/routing/routing.module";
import { ImportsModule } from "./modules/imports/imports.module";
import { BulkUpdatesModule } from "./modules/bulk-updates/bulk-updates.module";
import { PackagesModule } from "./modules/packages/packages.module";

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: env().LOG_LEVEL,
        genReqId: req => (req as unknown as { id?: string }).id ?? randomUUID(),
        customProps: () => ({}),
        serializers: { req: req => ({ id: req.id, method: req.method, url: req.url }), res: res => ({ statusCode: res.statusCode }) },
        redact: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
        transport: env().NODE_ENV === "development" ? { target: "pino-pretty", options: { singleLine: true } } : undefined,
        autoLogging: { ignore: req => req.url?.startsWith("/api/v1/health") ?? false },
      },
      forRoutes: [{ path: "{*path}", method: RequestMethod.ALL }],
    }),
    PrismaModule,
    RedisModule,
    QueueModule,
    CommonModule,
    AuditModule,
    ThrottlerModule.forRootAsync({
      inject: [RedisThrottlerStorage],
      useFactory: (storage: RedisThrottlerStorage) => ({ throttlers: [{ name: "default", ttl: 60_000, limit: 300 }], storage }),
    }),
    StorageModule,
    RealtimeModule,
    LedgerModule,
    NotificationsModule,
    AuthModule,
    EmailVerificationModule,
    GeoModule,
    GeographyModule,
    NetworkModule,
    PricingModule,
    PackagesModule,
    ParcelsModule,
    FeedbackModule,
    AccountsModule,
    MerchantsModule,
    FinanceModule,
    SupportModule,
    AdminModule,
    OpsModule,
    ScansModule,
    LinehaulModule,
    CnStockModule,
    SlaModule,
    ShiftsModule,
    ReportsModule,
    RoutingModule,
    ImportsModule,
    BulkUpdatesModule,
    ApplicationsModule,
    RiderModule,
    ReturnsModule,
    PickupsModule,
    ApprovalsModule,
    AnalyticsModule,
  ],
  controllers: [HealthController, EventsController],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard }, // runs first: rate limit before auth work
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
