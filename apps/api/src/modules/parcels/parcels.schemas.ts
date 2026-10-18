import { z } from "zod";
import { phoneSchema } from "@delivery-fast/shared";

const optionalText = (max: number) => z.string().trim().max(max).optional().transform(v => v || undefined);

/**
 * Operations corrections to a booked parcel that don't change its price: the recipient's
 * name and phone, the street address within the same zone, and delivery instructions.
 */
export const updateParcelDetailsSchema = z
  .object({
    recipient: z.object({ name: z.string().trim().min(1).max(120).optional(), phone: phoneSchema.optional() }).optional(),
    delivery: z
      .object({
        street: z.string().trim().min(1).max(200).optional(),
        /** Empty string clears it. */
        area: z.string().trim().max(120).optional(),
      })
      .optional(),
    /** Empty string clears it. */
    instructions: z.string().trim().max(500).optional(),
    /** Why the details changed (internal; shown to staff only). */
    note: optionalText(500),
    expectedVersion: z.number().int().min(0).optional(),
  })
  .refine(v => v.recipient?.name || v.recipient?.phone || v.delivery?.street || v.delivery?.area !== undefined || v.instructions !== undefined, {
    message: "Change at least one detail",
  });

export const parcelNoteSchema = z.object({ note: z.string().trim().min(1).max(1000) });

/** Rider app "Hand over at hub" scan: the hub the rider is handing the parcel to (POST /rider/parcels/:id/handover). */
export const riderHandoverSchema = z.object({ hubId: z.uuid(), source: z.enum(["CAMERA", "KEYBOARD", "MANUAL"]).optional() });
export const riderHandoversQuerySchema = z.object({ hubId: z.uuid() });
/** GET /track/:id — `t`: the link token from the SMS / guest booking (unlocks the live rider position). */
export const trackQuerySchema = z.object({ t: z.string().trim().max(64).optional() });
