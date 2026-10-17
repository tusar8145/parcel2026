import { z } from "zod";
import { listParcelsQuerySchema } from "@delivery-fast/shared";
import { pageQuerySchema } from "../../common/pagination";

/** The parcels to download for a bulk update: the shipment filters plus SLA state, service line and presets. */
export const bulkExportQuerySchema = listParcelsQuerySchema
  .pick({ status: true, q: true, merchantId: true, hubId: true, intake: true, dropOffHubId: true, incomplete: true, from: true, to: true })
  .extend({
    /**
     * pending_review: pickup requests waiting for operations ("Pending operations confirmation", SLA "Awaiting review");
     * at_hub_unassigned: at a hub without a delivery rider; needs_info: incomplete orders.
     */
    preset: z.enum(["pending_review", "at_hub_unassigned", "needs_info"]).optional(),
    /** AWAITING_REVIEW (pickup requests not yet accepted) or the SLA engine's state. */
    sla: z.enum(["AWAITING_REVIEW", "ON_TRACK", "AT_RISK", "BREACHED"]).optional(),
    /** Service line: merchant e-commerce, merchant documents, or website customer parcels. */
    line: z.enum(["ecommerce", "document", "customer"]).optional(),
  });

export const BULK_ROW_FILTERS = ["all", "apply", "warning", "error", "applied", "already_done", "failed", "not_applied"] as const;
export const bulkRowsQuerySchema = z.object({
  filter: z.enum(BULK_ROW_FILTERS).default("all"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(200).default(50),
});

export const bulkListQuerySchema = pageQuerySchema.extend({
  /** Only my bulk updates (default: every operations bulk update the caller may see). */
  mine: z
    .enum(["true", "false"])
    .transform(v => v === "true")
    .optional(),
});

export const bulkFailedRowsQuerySchema = z.object({ format: z.enum(["xlsx", "csv"]).default("xlsx") });
