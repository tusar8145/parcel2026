import { z } from "zod";
import { listParcelsQuerySchema } from "@delivery-fast/shared";
import { pageQuerySchema } from "../../common/pagination";
import { BULK_KINDS } from "./bulk-kinds";
import { BULK_ACTION_IDS } from "./bulk-actions";
import { transferOptionsSchema } from "../linehaul/linehaul.schemas";

/** The page: new_orders, pickup, hub_desk, delivery, problems, returns, or all (every action; default). */
export const bulkKindSchema = z.enum(BULK_KINDS);
/** The action template (bulk-actions.ts): accept_pickup, reassign_pickup, mark_picked_up, receive_at_hub, … */
export const bulkActionSchema = z.enum(BULK_ACTION_IDS);
/**
 * The page and action a file is uploaded or applied with: a file of another action is refused, and of
 * another page unless on All parcels. Without `action` the file's own action is used (if the page offers it).
 */
export const bulkKindQuerySchema = z.object({ kind: bulkKindSchema.default("all"), action: bulkActionSchema.optional() });

/** A page's parcels for a bulk update: the shipment filters plus SLA state, service line and presets. */
export const bulkActionsQuerySchema = listParcelsQuerySchema
  .pick({ status: true, q: true, merchantId: true, hubId: true, intake: true, dropOffHubId: true, incomplete: true, from: true, to: true })
  .extend({
    kind: bulkKindSchema.default("all"),
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

/** The download of one action's file: the page's filters plus the action (required). */
export const bulkExportQuerySchema = bulkActionsQuerySchema.extend({ action: bulkActionSchema });

export const BULK_ROW_FILTERS = ["all", "apply", "warning", "error", "applied", "already_done", "failed", "not_applied"] as const;
export const bulkRowsQuerySchema = z.object({
  filter: z.enum(BULK_ROW_FILTERS).default("all"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(200).default(50),
});

export const bulkListQuerySchema = pageQuerySchema.extend({
  /** Only the bulk updates of this page template. */
  kind: bulkKindSchema.optional(),
  /** Only the bulk updates of this action. */
  action: bulkActionSchema.optional(),
  /** Only my bulk updates (default: every operations bulk update the caller may see). */
  mine: z
    .enum(["true", "false"])
    .transform(v => v === "true")
    .optional(),
});

export const bulkFailedRowsQuerySchema = z.object({ format: z.enum(["xlsx", "csv"]).default("xlsx") });

/** Apply options (optional body): Add to transfer bag → { transfer: { seal, tripId | newTrip } }. */
export const bulkApplyBodySchema = z.object({ transfer: transferOptionsSchema.optional() });
