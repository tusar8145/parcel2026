import { z } from "zod";
import { emailSchema } from "@delivery-fast/shared";
import { pageQuerySchema } from "../../common/pagination";
import { boolQuery } from "../ops/ops-common";

export const REPORT_KINDS = ["DELIVERIES", "SLA", "COD", "RIDERS"] as const;
const kind = z.enum(REPORT_KINDS);
const recipients = z
  .array(emailSchema)
  .min(1, "Add at least one recipient")
  .max(20)
  .transform(list => [...new Set(list.map(e => e.toLowerCase()))]);

export const reportScheduleSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    kind,
    frequency: z.enum(["DAILY", "WEEKLY"]),
    /** WEEKLY: 0 = Sunday … 6 = Saturday. */
    weekday: z.number().int().min(0).max(6).optional(),
    /** Dhaka hour the report is sent (covering the previous day / week). */
    hour: z.number().int().min(0).max(23).default(8),
    recipients,
    hubId: z.uuid().optional(),
    active: z.boolean().default(true),
  })
  .refine(v => v.frequency === "DAILY" || v.weekday !== undefined, { message: "Choose the day of the week", path: ["weekday"] });

export const updateReportScheduleSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  frequency: z.enum(["DAILY", "WEEKLY"]).optional(),
  weekday: z.number().int().min(0).max(6).nullable().optional(),
  hour: z.number().int().min(0).max(23).optional(),
  recipients: recipients.optional(),
  hubId: z.uuid().nullable().optional(),
  active: z.boolean().optional(),
});

export const listSchedulesQuerySchema = pageQuerySchema.extend({ active: boolQuery.optional() });
export const listRunsQuerySchema = pageQuerySchema.extend({ kind: kind.optional(), scheduleId: z.uuid().optional() });

const day = z.iso.date();
export const runReportSchema = z
  .object({ kind, from: day, to: day, hubId: z.uuid().optional() })
  .refine(v => v.from <= v.to, { message: "from must be on or before to", path: ["from"] })
  .refine(v => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 < 92, { message: "Choose a range of at most 92 days", path: ["from"] });
