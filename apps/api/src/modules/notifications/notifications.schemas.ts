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
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
