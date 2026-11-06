import { Global, Injectable, Logger, Module, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import PgBoss from "pg-boss";
import { env } from "../config/env";

export const QUEUE = { outbox: "outbox", webhooks: "webhooks" } as const;
type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

const POLICIES: Record<QueueName, PgBoss.Queue> = {
  outbox: { name: QUEUE.outbox, retryLimit: 5, retryDelay: 5, retryBackoff: true, expireInSeconds: 60 },
  webhooks: { name: QUEUE.webhooks, retryLimit: 8, retryDelay: 10, retryBackoff: true, expireInSeconds: 60 },
};

/**
 * Job queue on PostgreSQL (pg-boss, schema "pgboss"): no extra infrastructure, and
 * jobs survive restarts. Jobs are de-duplicated by the record id they carry.
 */
@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("Queues");
  readonly boss = new PgBoss({ connectionString: env().DATABASE_URL, schema: "pgboss", application_name: "deliveryfast-queues" });
  private ready?: Promise<void>;

  onModuleInit() {
    this.boss.on("error", error => this.logger.error({ err: error }, "Queue error"));
    this.ready = (async () => {
      await this.boss.start();
      for (const policy of Object.values(POLICIES)) {
        if (!(await this.boss.getQueue(policy.name))) await this.boss.createQueue(policy.name, policy);
      }
    })();
    return this.ready;
  }

  /** `startAfter` delays the job (e.g. an SMS waiting for its rate limit). */
  async send(queue: QueueName, id: string, options: { startAfter?: Date } = {}) {
    await this.ready;
    await this.boss.send(queue, { id }, { singletonKey: id, ...options });
  }

  /**
   * Handles fetched jobs together (e.g. one gateway request for several SMS). The handler
   * returns the record ids that failed; only their jobs are retried, the rest complete.
   */
  async workBatch(queue: QueueName, batchSize: number, handler: (jobs: { id: string; finalAttempt: boolean }[]) => Promise<Set<string>>) {
    await this.ready;
    await this.boss.work<{ id: string }>(queue, { batchSize, pollingIntervalSeconds: 1, includeMetadata: true }, async jobs => {
      const failed = await handler(jobs.map(job => ({ id: job.data.id, finalAttempt: job.retryCount >= job.retryLimit })));
      const failedJobs = jobs.filter(job => failed.has(job.data.id)).map(job => job.id);
      if (failedJobs.length) await this.boss.fail(queue, failedJobs);
    });
  }

  async work(queue: QueueName, handler: (id: string, finalAttempt: boolean) => Promise<void>) {
    await this.ready;
    await this.boss.work<{ id: string }>(queue, { batchSize: 5, pollingIntervalSeconds: 1, includeMetadata: true }, async jobs => {
      for (const job of jobs) await handler(job.data.id, job.retryCount >= job.retryLimit);
    });
  }

  /** Runs `handler` on a cron schedule (Dhaka time), once across all instances. Call from workers only. */
  async schedule(name: string, cron: string, handler: () => Promise<void>) {
    await this.ready;
    if (!(await this.boss.getQueue(name))) await this.boss.createQueue(name, { name, retryLimit: 2, expireInSeconds: 900 });
    await this.boss.schedule(name, cron, {}, { tz: "Asia/Dhaka" });
    await this.boss.work(name, async () => handler());
  }

  async onModuleDestroy() {
    await this.boss.stop({ graceful: true, timeout: 10_000 }).catch(() => undefined);
  }
}

@Global()
@Module({ providers: [QueueService], exports: [QueueService] })
export class QueueModule {}
