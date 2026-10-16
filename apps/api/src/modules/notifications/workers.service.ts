import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { env } from "../../config/env";
import { QueueService } from "../../common/queues";
import { OutboxService } from "./outbox.service";
import { WebhooksService } from "./webhooks.service";

/**
 * Background workers. Run inside the API when RUN_WORKERS=true (development), or as a
 * separate process with `npm run worker` (production, scaled independently).
 */
@Injectable()
export class WorkersService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger("Workers");
  private started = false;
  private sweeper?: NodeJS.Timeout;

  constructor(
    private readonly queues: QueueService,
    private readonly outbox: OutboxService,
    private readonly webhooks: WebhooksService,
  ) {}

  onApplicationBootstrap() {
    if (env().RUN_WORKERS) void this.start();
  }

  async start() {
    if (this.started) return;
    this.started = true;
    // SMS/email in batches: one gateway request for several messages; only failures retry.
    await this.queues.workBatch("outbox", 25, async jobs => {
      const final = new Set(jobs.filter(j => j.finalAttempt).map(j => j.id));
      const failed = await this.outbox.deliverBatch(jobs.map(j => j.id), final);
      for (const [id, message] of failed) this.logger.warn({ id, message }, "Outbox delivery failed; will retry");
      return new Set(failed.keys());
    });
    await this.queues.work("webhooks", async (id, finalAttempt) => {
      try {
        await this.webhooks.deliver(id);
      } catch (error) {
        if (finalAttempt) await this.webhooks.markFailed(id);
        this.logger.warn({ id, message: (error as Error).message }, "Webhook delivery failed");
        throw error;
      }
    });
    this.sweeper = setInterval(() => void this.outbox.sweep().catch(err => this.logger.error({ err }, "Outbox sweep failed")), 60_000);
    this.logger.log("Background workers started");
  }

  onApplicationShutdown() {
    clearInterval(this.sweeper);
  }
}
