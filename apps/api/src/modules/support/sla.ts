import { z } from "zod";
import type { Db } from "../../common/prisma.service";
import type { SupportTicket, TicketPriority } from "../../generated/prisma/client";

/** Support settings key: SLA targets per priority and escalation behaviour. */
export const SUPPORT_SLA_KEY = "support.sla";

const target = z.object({
  /** Minutes to the first staff reply. */
  firstResponseMinutes: z.number().int().min(5).max(30 * 24 * 60),
  /** Minutes to resolution (the clock pauses while waiting for the requester). */
  resolutionMinutes: z.number().int().min(15).max(90 * 24 * 60),
});

export const slaConfigSchema = z
  .object({
    targets: z
      .object({ URGENT: target, HIGH: target, NORMAL: target, LOW: target })
      .default({
        URGENT: { firstResponseMinutes: 30, resolutionMinutes: 4 * 60 },
        HIGH: { firstResponseMinutes: 60, resolutionMinutes: 8 * 60 },
        NORMAL: { firstResponseMinutes: 4 * 60, resolutionMinutes: 24 * 60 },
        LOW: { firstResponseMinutes: 8 * 60, resolutionMinutes: 72 * 60 },
      }),
    /** On a breach: assign unassigned tickets to the least busy agent. */
    autoAssign: z.boolean().default(true),
    /** On a breach: raise the priority one step (up to URGENT). */
    raisePriority: z.boolean().default(true),
  })
  .refine(c => Object.values(c.targets).every(t => t.resolutionMinutes >= t.firstResponseMinutes), "Resolution targets must be at least the first-response targets");

export type SlaConfig = z.infer<typeof slaConfigSchema>;

export async function readSlaConfig(db: Db): Promise<SlaConfig> {
  const row = await db.setting.findUnique({ where: { key: SUPPORT_SLA_KEY } });
  const parsed = slaConfigSchema.safeParse(row?.value ?? {});
  return parsed.success ? parsed.data : slaConfigSchema.parse({});
}

const MIN = 60_000;

/** Due times for a new ticket. */
export function initialDue(cfg: SlaConfig, priority: TicketPriority, createdAt: Date) {
  const t = cfg.targets[priority];
  return { firstResponseDueAt: new Date(createdAt.getTime() + t.firstResponseMinutes * MIN), resolutionDueAt: new Date(createdAt.getTime() + t.resolutionMinutes * MIN) };
}

/** Due times after a priority change: same start, new targets, keeping time already spent paused. */
export function dueAfterPriorityChange(cfg: SlaConfig, ticket: Pick<SupportTicket, "createdAt" | "priority" | "resolutionDueAt" | "firstResponseAt">, priority: TicketPriority) {
  const oldT = cfg.targets[ticket.priority];
  const newT = cfg.targets[priority];
  const pausedMs = ticket.resolutionDueAt ? Math.max(0, ticket.resolutionDueAt.getTime() - (ticket.createdAt.getTime() + oldT.resolutionMinutes * MIN)) : 0;
  return {
    ...(ticket.firstResponseAt ? {} : { firstResponseDueAt: new Date(ticket.createdAt.getTime() + newT.firstResponseMinutes * MIN), firstResponseBreachedAt: null }),
    resolutionDueAt: new Date(ticket.createdAt.getTime() + newT.resolutionMinutes * MIN + pausedMs),
    resolutionBreachedAt: null,
  };
}

/** SLA state for views. */
export function slaView(t: Pick<SupportTicket, "status" | "firstResponseAt" | "firstResponseDueAt" | "resolutionDueAt" | "slaPausedAt" | "firstResponseBreachedAt" | "resolutionBreachedAt" | "escalationLevel" | "resolvedAt">, now = new Date()) {
  const open = t.status !== "RESOLVED" && t.status !== "CLOSED";
  const firstOverdue = !t.firstResponseAt && !!t.firstResponseDueAt && t.firstResponseDueAt < now;
  const resolutionOverdue = open && !t.slaPausedAt && !!t.resolutionDueAt && t.resolutionDueAt < now;
  return {
    firstResponseDueAt: t.firstResponseDueAt,
    firstResponseAt: t.firstResponseAt,
    resolutionDueAt: t.resolutionDueAt,
    paused: !!t.slaPausedAt,
    firstResponseBreached: !!t.firstResponseBreachedAt || (open && firstOverdue) || (!!t.firstResponseAt && !!t.firstResponseDueAt && t.firstResponseAt > t.firstResponseDueAt),
    resolutionBreached: !!t.resolutionBreachedAt || resolutionOverdue || (!!t.resolvedAt && !!t.resolutionDueAt && t.resolvedAt > t.resolutionDueAt),
    escalationLevel: t.escalationLevel,
    state: !open ? "done" : t.slaPausedAt ? "paused" : firstOverdue || resolutionOverdue ? "breached" : "on_track",
  };
}
