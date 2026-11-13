import { z } from "zod";
import { phoneSchema } from "@delivery-fast/shared";
import { NOTIFICATION_EVENTS } from "./events";
import { brandSchema, limitsSchema } from "./notification-settings.service";

export { smsGatewaySchema, emailGatewaySchema } from "./gateways.service";

export const channelSchema = z.enum(["sms", "email"]);
export const eventSchema = z.enum(NOTIFICATION_EVENTS);

const text = (max: number) => z.string().max(max);
export const updateTemplateSchema = z
  .object({
    enabled: z.boolean().optional(),
    subject: text(200).trim().min(1).nullable().optional(),
    body: text(4000).trim().min(1).nullable().optional(),
    html: text(50_000).trim().min(1).nullable().optional(),
  })
  .refine(v => Object.values(v).some(x => x !== undefined), "Nothing to change");

export const previewSchema = z.object({
  event: eventSchema,
  channel: channelSchema,
  /** Draft texts to preview instead of the saved ones. */
  subject: text(200).optional(),
  body: text(4000).optional(),
  html: text(50_000).optional(),
  /** Values for the placeholders (defaults: the event's sample values). */
  vars: z.record(z.string(), z.union([z.string().max(500), z.number()])).optional(),
});

export const settingsSchema = z
  .object({ limits: limitsSchema.optional(), brand: brandSchema.optional() })
  .refine(v => v.limits || v.brand, "Nothing to change")
  .refine(v => !v.limits || v.limits.sms.perRecipientPerDay >= v.limits.sms.perRecipientPerHour, {
    message: "The daily limit can't be lower than the hourly limit",
    path: ["limits", "sms", "perRecipientPerDay"],
  });

export const testSmsSchema = z.object({
  phone: phoneSchema,
  message: z.string().trim().min(1).max(480).optional(),
});
export const testEmailSchema = z.object({
  email: z.email().max(200),
  subject: z.string().trim().min(1).max(200).optional(),
  message: z.string().trim().min(1).max(4000).optional(),
});

export const preferencesSchema = z.object({
  preferences: z
    .array(z.object({ event: z.string().max(80), channel: channelSchema, enabled: z.boolean() }))
    .min(1)
    .max(200),
});

export const outboxQuerySchema = z.object({
  channel: z.enum(["SMS", "EMAIL"]).optional(),
  state: z.enum(["PENDING", "SENT", "FAILED"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(25),
  /** Dhaka days, inclusive. */
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  /** Messages about this merchant's parcels. */
  merchantId: z.uuid().optional(),
  /** A tracking ID or part of the recipient's number / address. */
  q: z.string().trim().max(60).optional(),
});
/** SMS (or email) per merchant in a period (their parcels' messages). */
export const outboxByMerchantQuerySchema = z.object({
  channel: z.enum(["SMS", "EMAIL"]).default("SMS"),
  from: z.iso.date(),
  to: z.iso.date(),
});
