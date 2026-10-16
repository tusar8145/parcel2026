import { z } from "zod";
import { phoneSchema } from "@delivery-fast/shared";
import { pageQuerySchema } from "../../common/pagination";
import { boolQuery, optionalText, scanSourceSchema } from "../ops/ops-common";

const regNo = z
  .string()
  .trim()
  .toUpperCase()
  .min(3)
  .max(40)
  .transform(v => v.replace(/\s+/g, " "));

export const vehicleSchema = z.object({
  regNo,
  kind: z.string().trim().min(2).max(40),
  capacityKg: z.number().int().min(1).max(100_000).optional(),
  ownerName: optionalText(120),
  active: z.boolean().default(true),
});
export const updateVehicleSchema = z.object({
  regNo: regNo.optional(),
  kind: z.string().trim().min(2).max(40).optional(),
  capacityKg: z.number().int().min(1).max(100_000).nullable().optional(),
  ownerName: z.string().trim().max(120).nullable().optional(),
  active: z.boolean().optional(),
});
export const listVehiclesQuerySchema = pageQuerySchema.extend({ q: optionalText(60), active: boolQuery.optional() });

const differentHubs = <T extends { originHubId: string; destHubId: string }>(v: T) => v.originHubId !== v.destHubId;
const differentHubsIssue = { message: "Choose a destination hub different from the origin", path: ["destHubId"] };

export const createBagSchema = z.object({ originHubId: z.uuid(), destHubId: z.uuid() }).refine(differentHubs, differentHubsIssue);

const BAG_STATUSES = ["OPEN", "SEALED", "IN_TRANSIT", "RECEIVED"] as const;
const direction = z.enum(["outbound", "inbound"]);

export const listBagsQuerySchema = pageQuerySchema.extend({
  hubId: z.uuid().optional(),
  direction: direction.optional(),
  status: z.enum(BAG_STATUSES).optional(),
  tripId: z.uuid().optional(),
  q: optionalText(60),
});

export const bagItemSchema = z.object({ code: z.string().trim().min(3).max(64), source: scanSourceSchema });
export const sealBagSchema = z.object({ sealNo: z.string().trim().toUpperCase().min(2).max(40) });

export const createTripSchema = z
  .object({
    originHubId: z.uuid(),
    destHubId: z.uuid(),
    vehicleId: z.uuid().optional(),
    vehicleRegNo: regNo.optional(),
    driverName: z.string().trim().min(2).max(120),
    driverPhone: phoneSchema,
    plannedDepartureAt: z.coerce.date().optional(),
    note: optionalText(500),
  })
  .refine(differentHubs, differentHubsIssue)
  .refine(v => v.vehicleId || v.vehicleRegNo, { message: "Choose a vehicle or type its registration number", path: ["vehicleRegNo"] });

const TRIP_STATUSES = ["PLANNED", "DEPARTED", "ARRIVED", "CLOSED", "CANCELLED"] as const;
const day = z.iso.date();
export const listTripsQuerySchema = pageQuerySchema.extend({
  status: z.enum(TRIP_STATUSES).optional(),
  hubId: z.uuid().optional(),
  direction: direction.optional(),
  from: day.optional(),
  to: day.optional(),
  q: optionalText(60),
});

/** A sealed bag by id or number (BG-…). */
export const tripBagSchema = z.object({ bag: z.string().trim().min(3).max(64), source: scanSourceSchema });

export const receiveBagSchema = z.object({
  hubId: z.uuid(),
  /** Parcels scanned out of the bag. Omit to receive the whole sealed bag as manifested. */
  trackingIds: z.array(z.string().trim().min(3).max(64)).max(2000).optional(),
  sealNo: z.string().trim().toUpperCase().min(2).max(40).optional(),
  note: optionalText(500),
  source: scanSourceSchema,
});

export const listDiscrepanciesQuerySchema = pageQuerySchema.extend({
  hubId: z.uuid().optional(),
  tripId: z.uuid().optional(),
  open: boolQuery.optional(),
});
export const resolveDiscrepancySchema = z.object({ resolution: z.string().trim().min(2).max(500) });
