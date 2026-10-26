import { Global, Module } from "@nestjs/common";
import { OutboxService } from "./outbox.service";
import { WebhooksService } from "./webhooks.service";
import { WorkersService } from "./workers.service";
import { NotifyService } from "./notify.service";
import { NotificationSettingsService } from "./notification-settings.service";
import { GatewaysService } from "./gateways.service";
import { SmsRateLimiter } from "./rate-limiter";
import { PreferencesService } from "./preferences.service";
import { NotificationPreferencesController, NotificationsAdminController } from "./notifications.controller";
import { InboxService } from "./inbox.service";
import { InboxController } from "./inbox.controller";
import { PushService } from "./push.service";
import { PushBroadcastService } from "./push-broadcast.service";
import { PushAdminController, PushDevicesController } from "./push.controller";

/**
 * Notifications: templates and toggles (super admin), user preferences, the transactional
 * outbox with SMS (mram) / email (Mailjet) gateways and SMS rate limiting, and webhooks.
 */
@Global()
@Module({
  controllers: [NotificationsAdminController, NotificationPreferencesController, InboxController, PushDevicesController, PushAdminController],
  providers: [OutboxService, WebhooksService, WorkersService, NotifyService, NotificationSettingsService, GatewaysService, SmsRateLimiter, PreferencesService, InboxService, PushService, PushBroadcastService],
  exports: [OutboxService, WebhooksService, WorkersService, NotifyService, NotificationSettingsService, InboxService, PushService],
})
export class NotificationsModule {}
