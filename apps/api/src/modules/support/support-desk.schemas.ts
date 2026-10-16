import { z } from "zod";
import { instantSchema } from "../finance/finance.schemas";
import { slaConfigSchema } from "./sla";

export const cannedResponseSchema = z.object({
  title: z.string().trim().min(2, "Give it a title").max(120),
  body: z.string().trim().min(2, "Write the response").max(3000),
  category: z.string().trim().max(60).optional(),
  /** Short code agents type, e.g. "refund-eta" (letters, digits and dashes). */
  shortcut: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]{2,40}$/, "Shortcuts use 2–40 letters, digits or dashes")
    .optional(),
  active: z.boolean().default(true),
});

export const updateCannedResponseSchema = cannedResponseSchema.partial().extend({ active: z.boolean().optional(), shortcut: cannedResponseSchema.shape.shortcut.unwrap().nullable().optional() });

export const listCannedQuerySchema = z.object({
  q: z.string().trim().min(1).max(80).optional(),
  category: z.string().trim().max(60).optional(),
  includeInactive: z.preprocess(v => v === "true" || v === true || v === "1", z.boolean()).default(false),
});

export const csatSchema = z.object({
  rating: z.coerce.number("Choose a rating from 1 to 5").int("Choose a rating from 1 to 5").min(1, "Choose a rating from 1 to 5").max(5, "Choose a rating from 1 to 5"),
  comment: z.string().trim().max(1000).optional(),
});

export const csatReportQuerySchema = z.object({ from: instantSchema.optional(), to: instantSchema.optional() });

export const updateSlaSchema = slaConfigSchema;
