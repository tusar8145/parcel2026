import { z } from "zod";
import { pageQuerySchema } from "../../common/pagination";

/** GET /me/notifications: newest first, cursor paging; `unread=true` lists only unread ones. */
export const listNotificationsQuerySchema = pageQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  unread: z
    .enum(["true", "false"])
    .optional()
    .transform(v => v === "true"),
});
