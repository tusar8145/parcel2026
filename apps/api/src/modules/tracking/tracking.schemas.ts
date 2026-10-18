import { z } from "zod";
import { locationPointSchema } from "../rider/rider.schemas";

/** Rider / vehicle location interval (minutes) the super admin can choose. */
export const LOCATION_INTERVALS = [2, 5, 10] as const;

export const locationSettingsSchema = z.object({
  /** How often the rider app (and a phone sharing a vehicle's location) sends a position while nothing moves. */
  intervalMinutes: z.union([z.literal(2), z.literal(5), z.literal(10)]),
  /** A move of at least this many metres sends a position at once (between the regular updates). */
  movementMeters: z.number().int().min(25).max(1000),
});
export type LocationSettings = z.infer<typeof locationSettingsSchema>;

export const startVehicleShareSchema = z.object({
  /** The trip's id or its manifest number (MF-…), e.g. scanned from the manifest's barcode. */
  trip: z.string().trim().min(3).max(64),
});

export const vehiclePointSchema = locationPointSchema;

export const shareableTripsQuerySchema = z.object({
  q: z.string().trim().max(64).optional(),
});

export const vehicleLocationsQuerySchema = z.object({
  hubId: z.uuid().optional(),
});

export const tripHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(500),
});
