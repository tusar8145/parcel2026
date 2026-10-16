import { z } from "zod";
import { otpCodeSchema, phoneSchema } from "./auth";

// ── guest booking (no account): the sender's phone is verified by SMS first ──
export const guestVerificationRequestSchema = z.object({ phone: phoneSchema });
export const guestVerificationConfirmSchema = z.object({ phone: phoneSchema, code: otpCodeSchema });

/** Access to a parcel without an account: the token from a guest booking or feedback link. */
export const parcelAccessTokenSchema = z.string().trim().min(10).max(64);

export const guestCancelSchema = z.object({
  token: parcelAccessTokenSchema,
  reason: z.string().trim().max(300, "Use at most 300 characters").optional().transform(v => v || undefined),
});

// ── delivery feedback ──
export const FEEDBACK_COMMENT_MAX = 1000;
export const feedbackSchema = z.object({
  rating: z.coerce.number("Choose a rating from 1 to 5 stars").int("Choose a rating from 1 to 5 stars").min(1, "Choose a rating from 1 to 5 stars").max(5, "Choose a rating from 1 to 5 stars"),
  comment: z
    .string()
    .trim()
    .max(FEEDBACK_COMMENT_MAX, `Use at most ${FEEDBACK_COMMENT_MAX} characters`)
    .optional()
    .transform(v => v || undefined),
  /** Guest booking or feedback-link token (not needed when signed in as the owner). */
  token: parcelAccessTokenSchema.optional(),
});

// ── email verification ──
export const emailVerificationConfirmSchema = z
  .object({
    /** From the link in the email. */
    token: z.string().trim().min(20).max(128).optional(),
    /** The 6-digit code from the email (signed in). */
    code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code").optional(),
  })
  .refine(v => !!v.token !== !!v.code, "Send either the link token or the code");

// ── places ──
export const geoSearchQuerySchema = z.object({
  q: z.string().trim().min(3, "Type at least 3 characters").max(120, "Use at most 120 characters"),
  limit: z.coerce.number().int().min(1).max(10).default(5),
});
export const geoReverseQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
});

// ── pickup slots ──
export const pickupSlotsQuerySchema = z.object({
  /** YYYY-MM-DD (Dhaka). Without it, the bookable days ahead are listed. */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the YYYY-MM-DD format")
    .optional(),
  district: z.string().trim().max(80).optional(),
  zone: z.string().trim().max(80).optional(),
});

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour)");
const pickupWindowConfig = z
  .object({ start: clock, end: clock, capacity: z.number().int().min(1).max(100_000).nullable().default(null) })
  .refine(w => w.end > w.start, { message: "A window must end after it starts", path: ["end"] });

/** Super-admin configuration of the website's pickup windows. */
export const pickupSlotConfigSchema = z.object({
  /** How many days ahead customers can book (today included). */
  daysAhead: z.number().int().min(1).max(30).default(7),
  /** Minimum minutes between booking and the start of the window. */
  leadMinutes: z.number().int().min(0).max(24 * 60).default(60),
  /** Days without pickups (0 = Sunday … 6 = Saturday). */
  closedWeekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  /** Default windows for every open day. */
  windows: z.array(pickupWindowConfig).min(1).max(12).default([
    { start: "09:00", end: "12:00", capacity: null },
    { start: "12:00", end: "15:00", capacity: null },
    { start: "15:00", end: "18:00", capacity: null },
  ]),
  /** Different windows on particular weekdays, e.g. { "5": [{ start: "15:00", end: "19:00" }] } for Fridays. */
  weekdayWindows: z.record(z.string().regex(/^[0-6]$/), z.array(pickupWindowConfig).max(12)).default({}),
});
export type PickupSlotConfig = z.infer<typeof pickupSlotConfigSchema>;
