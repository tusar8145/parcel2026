import { z } from "zod";
import { pageQuerySchema } from "../../common/pagination";
import { boolQuery, optionalText } from "../ops/ops-common";

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour time, e.g. 08:30");
const day = z.iso.date();
const weekdays = z
  .array(z.number().int().min(0).max(6))
  .min(1, "Choose at least one day")
  .max(7)
  .transform(d => [...new Set(d)].sort());

export const scheduleSchema = z
  .object({
    riderId: z.uuid(),
    hubId: z.uuid().optional(),
    /** 0 = Sunday … 6 = Saturday. */
    weekdays,
    startTime: time,
    endTime: time,
    validFrom: day,
    validTo: day.optional(),
    note: optionalText(300),
  })
  .refine(v => v.startTime !== v.endTime, { message: "The shift must end at a different time", path: ["endTime"] })
  .refine(v => !v.validTo || v.validTo >= v.validFrom, { message: "Ends before it starts", path: ["validTo"] });

export const updateScheduleSchema = z.object({
  hubId: z.uuid().nullable().optional(),
  weekdays: weekdays.optional(),
  startTime: time.optional(),
  endTime: time.optional(),
  validTo: day.nullable().optional(),
  active: z.boolean().optional(),
  note: z.string().trim().max(300).nullable().optional(),
});

export const listSchedulesQuerySchema = pageQuerySchema.extend({ riderId: z.uuid().optional(), hubId: z.uuid().optional(), active: boolQuery.optional() });

const coords = { lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional() };
export const checkInSchema = z.object({ ...coords, note: optionalText(300) });
export const checkOutSchema = z.object({ ...coords, note: optionalText(300) });

export const listAttendanceQuerySchema = pageQuerySchema.extend({ riderId: z.uuid().optional(), hubId: z.uuid().optional(), from: day.optional(), to: day.optional() });

export const correctAttendanceSchema = z
  .object({ checkInAt: z.coerce.date().optional(), checkOutAt: z.coerce.date().nullable().optional(), note: z.string().trim().min(3).max(300) })
  .refine(v => !v.checkInAt || !v.checkOutAt || v.checkOutAt > v.checkInAt, { message: "Check-out must be after check-in", path: ["checkOutAt"] });

export const attendanceReportQueryDoc = z.object({ from: day.optional(), to: day.optional(), hubId: z.uuid().optional(), riderId: z.uuid().optional() });
export const attendanceReportQuerySchema = attendanceReportQueryDoc
  .transform(v => {
    const to = v.to ?? new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
    const from = v.from ?? new Date(Date.parse(`${to}T00:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10);
    return { ...v, from, to };
  })
  .refine(v => v.from <= v.to, { message: "from must be on or before to", path: ["from"] })
  .refine(v => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 < 92, { message: "Choose a range of at most 92 days", path: ["from"] });
