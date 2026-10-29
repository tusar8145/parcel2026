import { z } from "zod";
import { emailSchema, phoneSchema } from "@paira-express/shared";
import { pageQuerySchema } from "../../common/pagination";
import { enumLoose } from "../support/support.schemas";

const text = (min: number, max: number, label: string) =>
  z.string(`${label} is required`).trim().min(min, `${label} must be at least ${min} characters`).max(max, `${label} can be up to ${max} characters`);

export const APPLICATION_KINDS = ["RIDER", "FRANCHISE"] as const;
export type ApplicationKind = (typeof APPLICATION_KINDS)[number];
export const APPLICATION_STATUSES = ["SUBMITTED", "UNDER_REVIEW", "INFO_REQUESTED", "APPROVED", "REJECTED", "WITHDRAWN"] as const;
/** Still being worked on: one per person and kind. */
export const OPEN_APPLICATION_STATUSES = ["SUBMITTED", "UNDER_REVIEW", "INFO_REQUESTED"] as const;

export const VEHICLES = ["MOTORCYCLE", "BICYCLE", "ON_FOOT"] as const;
export const TERRITORIES = ["CITY_ZONE", "DISTRICT", "MULTI_DISTRICT_REGION"] as const;

const contact = {
  name: text(2, 120, "Name"),
  phone: phoneSchema,
  email: z.preprocess(v => (v === "" ? undefined : v), emailSchema.optional()),
};

/** "On foot", "on-foot" and "ON_FOOT" are accepted. */
export const riderApplicationSchema = z.object({
  kind: z.literal("RIDER"),
  ...contact,
  /** Preferred work area, e.g. "Dhaka North". */
  area: text(2, 80, "Preferred work area"),
  vehicle: enumLoose(VEHICLES, "Vehicle"),
});

export const franchiseApplicationSchema = z.object({
  kind: z.literal("FRANCHISE"),
  ...contact,
  /** Proposed hub location: district, area or market. */
  location: text(2, 120, "Proposed hub location"),
  experience: z.preprocess(v => (v === "" ? undefined : v), text(2, 300, "Business experience").optional()),
  territory: enumLoose(TERRITORIES, "Territory"),
});

export const applicationSchema = z.discriminatedUnion("kind", [riderApplicationSchema, franchiseApplicationSchema], {
  error: "kind must be RIDER or FRANCHISE",
});
export type ApplicationInput = z.infer<typeof applicationSchema>;

export const listApplicationsQuerySchema = pageQuerySchema.extend({
  kind: z.enum(APPLICATION_KINDS, "kind must be RIDER or FRANCHISE").optional(),
  status: enumLoose(APPLICATION_STATUSES, "Status").optional(),
});

/** Staff decision / step. A message is sent to the applicant (required when asking for information or rejecting). */
export const decideApplicationSchema = z
  .object({
    status: enumLoose(["UNDER_REVIEW", "INFO_REQUESTED", "APPROVED", "REJECTED"] as const, "Status"),
    message: z.string().trim().min(3).max(2000).optional(),
    /** Internal reviewer note (not shown to the applicant). */
    note: z.string().trim().max(1000).optional(),
    /** Rider approval: home hub and zone for the new rider. */
    hubId: z.uuid().optional(),
    zone: z.string().trim().max(80).optional(),
  })
  .refine(v => (v.status !== "INFO_REQUESTED" && v.status !== "REJECTED") || !!v.message, { message: "Write a message to the applicant", path: ["message"] });
