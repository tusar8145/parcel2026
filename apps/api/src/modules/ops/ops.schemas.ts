import { z } from "zod";
import { createParcelSchema, PARCEL_INTAKES } from "@paira-express/shared";

const MAX_RANGE_DAYS = 92;
const day = z.iso.date();
const todayInDhaka = () => new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);

/** Fills a default range ending today and checks it is ordered and at most 92 days long. */
function withRange<T extends { from?: string; to?: string }>(v: T, defaultDays: number) {
  const to = v.to ?? todayInDhaka();
  const from = v.from ?? new Date(Date.parse(`${to}T00:00:00Z`) - (defaultDays - 1) * 86_400_000).toISOString().slice(0, 10);
  return { ...v, from, to };
}
const rangeChecks = <T extends z.ZodType<{ from: string; to: string }>>(schema: T) =>
  schema
    .refine(v => v.from <= v.to, { message: "from must be on or before to", path: ["from"] })
    .refine(v => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 < MAX_RANGE_DAYS, { message: `Choose a range of at most ${MAX_RANGE_DAYS} days`, path: ["from"] });

/** Dhaka calendar days (inclusive); defaults to today. */
export const riderReportQuerySchema = rangeChecks(
  z.object({ from: day.optional(), to: day.optional(), riderId: z.uuid().optional() }).transform(v => withRange(v, 1)),
);
/** Dhaka calendar days (inclusive); defaults to the last 30 days. */
export const transfersQuerySchema = rangeChecks(z.object({ from: day.optional(), to: day.optional() }).transform(v => withRange(v, 30)));

/**
 * Operations booking on behalf of a merchant (or a walk-in sender when merchantId is
 * omitted). Sender and pickup default to the merchant's profile; everything else is
 * the regular booking body, validated by createParcelSchema.
 */
export const opsBookingSchema = z.looseObject({
  merchantId: z.uuid().optional(),
  /** PICKUP (default): a pickup rider collects it. DROP_OFF: the sender brings it to dropOffHubId. */
  intake: z.enum(PARCEL_INTAKES).optional(),
  /** Drop-off hub; hub operators may leave it out to use their own hub. */
  dropOffHubId: z.uuid().optional(),
});

/** For the OpenAPI document only: the booking body with sender and pickup optional. */
export const opsBookingDocSchema = createParcelSchema.extend({
  merchantId: z.uuid().optional(),
  intake: z.enum(PARCEL_INTAKES).optional(),
  dropOffHubId: z.uuid().optional(),
  sender: createParcelSchema.shape.sender.optional(),
  pickup: createParcelSchema.shape.pickup.optional(),
});

/** Query shapes for the OpenAPI document (the refined schemas above aren't plain objects). */
export const riderReportQueryDoc = z.object({ from: day.optional(), to: day.optional(), riderId: z.uuid().optional() });
export const transfersQueryDoc = z.object({ from: day.optional(), to: day.optional() });
