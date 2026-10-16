import { z } from "zod";
import { pageQuerySchema } from "../../common/pagination";

export { feedbackSchema } from "@delivery-fast/shared";

/** Staff list: newest first, optionally by rating range or channel source. */
export const listFeedbackQuerySchema = pageQuerySchema.extend({
  minRating: z.coerce.number().int().min(1).max(5).optional(),
  maxRating: z.coerce.number().int().min(1).max(5).optional(),
  source: z.enum(["TRACKING", "GUEST_LINK", "SMS_LINK"]).optional(),
  q: z.string().trim().max(80).optional().transform(v => v || undefined), // tracking ID
});
