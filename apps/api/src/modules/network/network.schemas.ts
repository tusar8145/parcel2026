import { z } from "zod";
import { emailSchema, passwordSchema, phoneSchema } from "@delivery-fast/shared";

export const hubSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,20}$/, "Use 2–20 letters, digits or dashes"),
  name: z.string().trim().min(2).max(120),
  district: z.string().trim().min(2).max(80),
  /** The catalog zone of `district` the hub stands in (drop-offs are priced from it); null = not set. */
  zone: z.string().trim().min(1).max(80).nullable().optional(),
  address: z.string().trim().min(2).max(300),
  /** The person in charge of the hub (optional). The phone may be a landline. */
  inChargeName: z.string().trim().max(120).nullable().optional(),
  inChargePhone: z.string().trim().regex(/^[0-9+() -]{6,20}$/, "Enter a phone number").nullable().optional(),
  active: z.boolean().default(true),
  /** Most parcels the hub can hold at once (planning); null = not set. */
  capacity: z.number().int().min(1).max(1_000_000).nullable().optional(),
  /** Planning location (WGS84), used by maps and route optimisation. */
  lat: z.number().min(20).max(27).nullable().optional(),
  lng: z.number().min(88).max(93).nullable().optional(),
});
/** Every field optional; `active` has no default here (a PATCH without it must not reactivate a hub). */
export const updateHubSchema = hubSchema.extend({ active: z.boolean() }).partial();

const vehicle = z.enum(["BICYCLE", "MOTORBIKE", "VAN", "ON_FOOT"]);

export const createRiderSchema = z.object({
  name: z.string().trim().min(2).max(120),
  phone: phoneSchema,
  email: emailSchema.optional(),
  /** Initial password; the rider can also sign in with an SMS code. */
  password: passwordSchema.optional(),
  code: z.string().trim().toUpperCase().regex(/^R-\d{3,6}$/, "Rider codes look like R-2048").optional(),
  hubId: z.uuid().optional(),
  /** Every hub the rider works for (several: the app works at the nearest); `hubId` (or the first) is where they start. */
  hubIds: z.array(z.uuid()).max(30).optional(),
  vehicle: vehicle.default("MOTORBIKE"),
  zone: z.string().trim().max(80).optional(),
  /** Most stops a day (assignment suggestions); empty = network default. */
  dailyCapacity: z.number().int().min(1).max(500).optional(),
  /** Send the sign-in SMS / email now (default: no message; share the details yourself). */
  sendSms: z.boolean().default(false),
});

/**
 * A rider added from the operations app (operations managers anywhere, Hub Managers at their own hub): the password is
 * set here and shared by hand; no invitation is sent.
 */
export const appRiderSchema = z.object({
  name: z.string().trim().min(2).max(120),
  phone: phoneSchema,
  email: emailSchema.optional(),
  password: passwordSchema,
  /** Where the rider works; a Hub Manager's own hub when left out. */
  hubId: z.uuid().optional(),
  vehicle: vehicle.default("MOTORBIKE"),
  zone: z.string().trim().max(80).optional(),
});

/** A new password for a rider (shared by hand). */
export const riderPasswordSchema = z.object({ password: passwordSchema });

export const updateRiderSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  phone: phoneSchema.optional(),
  email: emailSchema.nullable().optional(),
  /** A new password (shared with the rider by hand). */
  password: passwordSchema.optional(),
  /** Every hub the rider works for; the current hub moves to the first one when it isn't among them. */
  hubIds: z.array(z.uuid()).min(1).max(30).optional(),
  hubId: z.uuid().nullable().optional(),
  vehicle: vehicle.optional(),
  zone: z.string().trim().max(80).nullable().optional(),
  active: z.boolean().optional(),
  dailyCapacity: z.number().int().min(1).max(500).nullable().optional(),
});

export const riderStatusSchema = z.object({ status: z.enum(["OFFLINE", "ONLINE", "ON_BREAK"]) });

export const listRidersQuerySchema = z.object({
  hubId: z.uuid().optional(),
  /** true: leave out franchise hubs' riders (super admin › Riders; they are under Franchises). */
  company: z.enum(["true", "false"]).transform(v => v === "true").optional(),
  status: z.enum(["OFFLINE", "ONLINE", "ON_BREAK"]).optional(),
  active: z.enum(["true", "false"]).transform(v => v === "true").optional(),
  q: z.string().trim().max(80).optional(),
});

/** Super admin › Hubs & zones › Find hub locations. */
export const locateHubsSchema = z.object({ overwrite: z.boolean().default(false), hubIds: z.array(z.uuid()).max(500).optional() });
