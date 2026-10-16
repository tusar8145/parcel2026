import { z } from "zod";

export const geocodeSchema = z.object({
  trackingIds: z.array(z.string().trim().min(3).max(64)).min(1).max(50).optional(),
  hubId: z.uuid().optional(),
  /** Parcels to try in this call (Nominatim allows about one request a second). */
  limit: z.number().int().min(1).max(25).default(10),
});

export const optimizeSchema = z
  .object({
    riderId: z.uuid(),
    includePickups: z.boolean().default(true),
    /** Where the run starts; defaults to the rider's live position, else the hub. */
    start: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).optional(),
    /** Look up missing delivery pins before planning (slower). */
    geocodeMissing: z.boolean().default(true),
  });

const day = z.iso.date();
export const plansQuerySchema = z.object({ hubId: z.uuid().optional(), riderId: z.uuid().optional(), date: day.optional() });

export const mapQuerySchema = z.object({
  hubId: z.uuid().optional(),
  /** unassigned | pickups | deliveries | all open parcels (default). */
  layer: z.enum(["all", "unassigned", "pickups", "deliveries"]).default("all"),
  limit: z.coerce.number().int().min(1).max(3000).default(1500),
});

export const suggestionsQuerySchema = z.object({
  hubId: z.uuid().optional(),
  kind: z.enum(["all", "pickup", "delivery"]).default("all"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const acceptSuggestionsSchema = z.object({
  items: z
    .array(z.object({ trackingId: z.string().trim().min(3).max(64), riderId: z.uuid() }))
    .min(1)
    .max(200),
});
