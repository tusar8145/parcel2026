import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import type { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { QueueService } from "../../common/queues";
import { AppError, notFound } from "../../common/errors";
import { env, runsJobs } from "../../config/env";
import type { Actor, UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import type { SettlementCycle } from "../../generated/prisma/client";
import { Prisma } from "../../generated/prisma/client";
import { financeMerchantScope, money } from "./finance.scope";
import { SettlementsService } from "./settlements.service";
import type { listSchedulesQuerySchema, updateScheduleSchema } from "./finance.schemas";

/** Hour of day (Bangladesh time) automatic drafts are due. */
export const SCHEDULE_HOUR = 6;
const DAY = 86_400_000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Next due time for a cycle: SCHEDULE_HOUR Dhaka time on the next day (DAILY) or on the next
 * chosen weekday (WEEKLY); BIWEEKLY skips a week after each run. MANUAL never runs.
 */
export function nextRunAt(cycle: SettlementCycle, weekday: number | null, from: Date, afterRun = false): Date | null {
  if (cycle === "MANUAL") return null;
  const local = new Date(from.getTime() + 6 * 3600_000);
  let candidate = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), SCHEDULE_HOUR) - 6 * 3600_000);
  if (candidate <= from) candidate = new Date(candidate.getTime() + DAY);
  if (cycle === "DAILY") return candidate;
  const target = weekday ?? 0;
  while (new Date(candidate.getTime() + 6 * 3600_000).getUTCDay() !== target) candidate = new Date(candidate.getTime() + DAY);
  if (cycle === "BIWEEKLY" && afterRun) candidate = new Date(candidate.getTime() + 7 * DAY);
  return candidate;
}

/**
 * Per-merchant automatic settlement cycle. A pg-boss job (hourly, once across instances) drafts
 * settlements for schedules that are due; approval and payment stay manual (maker-checker:
 * the system is the maker, any finance user can approve).
 */
@Injectable()
export class SettlementScheduleService implements OnApplicationBootstrap {
  private readonly logger = new Logger("SettlementSchedule");

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queues: QueueService,
    private readonly settlements: SettlementsService,
  ) {}

  onApplicationBootstrap() {
    if (!runsJobs() || env().NODE_ENV === "test") return;
    void this.queues
      .schedule("finance-settlement-schedule", "5 * * * *", async () => {
        const results = await this.runDue();
        if (results.length) this.logger.log(`Settlement schedule: ${results.map(r => `${r.merchantCode} ${r.result}`).join("; ")}`);
      })
      .catch(err => this.logger.error({ err }, "Could not schedule the settlement job"));
  }

  async list(query: z.infer<typeof listSchedulesQuerySchema>) {
    const rows = await this.prisma.settlementSchedule.findMany({
      where: { cycle: query.cycle },
      include: { merchant: { select: { id: true, code: true, name: true, status: true } } },
      orderBy: [{ nextRunAt: { sort: "asc", nulls: "last" } }],
      take: 500,
    });
    return rows.map(r => this.view(r));
  }

  async get(actor: Actor, merchantId: string) {
    const scope = financeMerchantScope(actor);
    if (scope && !scope.includes(merchantId)) throw notFound("Merchant");
    const merchant = await this.prisma.merchant.findUnique({ where: { id: merchantId }, select: { id: true, code: true, name: true, status: true, settlementSchedule: true } });
    if (!merchant) throw notFound("Merchant");
    const { settlementSchedule: s, ...m } = merchant;
    return s ? this.view({ ...s, merchant: m }) : { merchant: m, cycle: "MANUAL", weekday: null, weekdayLabel: null, minimumAmount: 0, nextRunAt: null, lastRunAt: null, lastResult: null };
  }

  async update(actor: UserActor, merchantId: string, input: z.infer<typeof updateScheduleSchema>, meta: RequestMeta) {
    const merchant = await this.prisma.merchant.findUnique({ where: { id: merchantId }, select: { id: true } });
    if (!merchant) throw notFound("Merchant");
    const weekday = input.cycle === "WEEKLY" || input.cycle === "BIWEEKLY" ? (input.weekday ?? 0) : null;
    const data = { cycle: input.cycle, weekday, minimumAmount: input.minimumAmount, nextRunAt: nextRunAt(input.cycle, weekday, new Date()), updatedById: actor.userId };
    await this.prisma.$transaction(async tx => {
      await tx.settlementSchedule.upsert({ where: { merchantId }, create: { merchantId, ...data }, update: data });
      await this.audit.record(actor, { action: "settlement_schedule.update", entityType: "merchant", entityId: merchantId, data: { cycle: input.cycle, weekday, minimumAmount: input.minimumAmount.toFixed(2) } }, meta, tx);
    });
    return this.get(actor, merchantId);
  }

  /** Drafts settlements for every due schedule. Each schedule is claimed atomically, so overlapping runs never double-draft. */
  async runDue(now = new Date()) {
    const due = await this.prisma.settlementSchedule.findMany({
      where: { cycle: { not: "MANUAL" }, nextRunAt: { lte: now } },
      include: { merchant: { select: { code: true, status: true } } },
      take: 200,
    });
    const results: { merchantId: string; merchantCode: string; result: string; settlementId?: string }[] = [];
    for (const s of due) {
      const claimed = await this.prisma.settlementSchedule.updateMany({
        where: { merchantId: s.merchantId, nextRunAt: s.nextRunAt },
        data: { nextRunAt: nextRunAt(s.cycle, s.weekday, now, true), lastRunAt: now },
      });
      if (claimed.count !== 1) continue;
      let result: string;
      let settlementId: string | undefined;
      if (s.merchant.status !== "ACTIVE") result = `Skipped: merchant is ${s.merchant.status.toLowerCase()}`;
      else {
        const pending = await this.prisma.merchantSettlement.findFirst({ where: { merchantId: s.merchantId, autoDrafted: true, status: "DRAFT" }, select: { number: true } });
        if (pending) result = `Skipped: ${pending.number} is still waiting for approval`;
        else {
          try {
            settlementId = await this.settlements.draft("system", s.merchantId, {}, { minimumAmount: s.minimumAmount.gt(0) ? s.minimumAmount : undefined });
            const st = await this.prisma.merchantSettlement.findUniqueOrThrow({ where: { id: settlementId }, select: { number: true, netPayable: true } });
            result = `Drafted ${st.number} (৳${st.netPayable.toFixed(2)})`;
          } catch (err) {
            result = err instanceof AppError ? `Skipped: ${(err.getResponse() as { message?: string }).message ?? err.message}` : "Failed: unexpected error";
            if (!(err instanceof AppError)) this.logger.error({ err, merchantId: s.merchantId }, "Automatic settlement failed");
          }
        }
      }
      await this.prisma.settlementSchedule.update({ where: { merchantId: s.merchantId }, data: { lastResult: result.slice(0, 300) } });
      results.push({ merchantId: s.merchantId, merchantCode: s.merchant.code, result, settlementId });
    }
    if (results.length) await this.audit.record("system", { action: "settlement_schedule.run", entityType: "settlement_schedule", data: { results } as unknown as Prisma.InputJsonObject });
    return results;
  }

  private view(r: {
    merchant: { id: string; code: string; name: string; status: string };
    cycle: SettlementCycle;
    weekday: number | null;
    minimumAmount: Prisma.Decimal;
    nextRunAt: Date | null;
    lastRunAt: Date | null;
    lastResult: string | null;
  }) {
    return {
      merchant: r.merchant,
      cycle: r.cycle,
      weekday: r.weekday,
      weekdayLabel: r.weekday === null ? null : WEEKDAYS[r.weekday],
      minimumAmount: money(r.minimumAmount),
      nextRunAt: r.nextRunAt,
      lastRunAt: r.lastRunAt,
      lastResult: r.lastResult,
    };
  }
}
