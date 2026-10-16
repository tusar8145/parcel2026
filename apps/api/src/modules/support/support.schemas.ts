import { z } from "zod";
import { pageQuerySchema } from "../../common/pagination";

/** Categories requesters choose when they open a ticket. */
export const TICKET_CATEGORIES = ["Delivery issue", "Pickup or collection", "COD / payment", "Account / API", "Rider or safety", "Other"] as const;
/** Partner applications are tickets too (opened only through /applications), so the support desk works them like any request. */
export const APPLICATION_CATEGORIES = ["Rider application", "Franchise application"] as const;
const ALL_CATEGORIES = [...TICKET_CATEGORIES, ...APPLICATION_CATEGORIES] as const;
export const TICKET_STATUSES = ["OPEN", "IN_PROGRESS", "WAITING_FOR_REQUESTER", "RESOLVED", "CLOSED"] as const;
export const TICKET_PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;

export const MAX_ATTACHMENTS = 3;
export const MAX_ATTACHMENT_BYTES = 350 * 1024;
const ATTACHMENT_TYPES = ["image/png", "image/jpeg", "image/webp", "application/pdf"];

/** "In progress", "in-progress" and "IN_PROGRESS" all mean the same thing. */
export const enumLoose = <const T extends readonly [string, ...string[]]>(values: T, label: string) =>
  z.preprocess(
    v => (typeof v === "string" ? v.trim().toUpperCase().replace(/[\s-]+/g, "_") : v),
    z.enum(values, { error: `${label} must be one of: ${values.join(", ")}` }),
  );

export const statusSchema = enumLoose(TICKET_STATUSES, "Status");
export const prioritySchema = enumLoose(TICKET_PRIORITIES, "Priority");

const decodedSize = (base64: string) => Math.floor((base64.length * 3) / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);

const dataUrlSchema = z
  .string()
  .regex(/^data:[\w/+.-]+;base64,[A-Za-z0-9+/]+=*$/, "Attachments must be base64 data URLs (data:<type>;base64,…)")
  .refine(v => ATTACHMENT_TYPES.includes(v.slice(5, v.indexOf(";"))), "Attachments must be PNG, JPEG, WebP or PDF files")
  .refine(v => decodedSize(v.slice(v.indexOf(",") + 1)) <= MAX_ATTACHMENT_BYTES, "Each attachment must be 350 KB or smaller");

/** A bare data URL, or { filename, dataUrl } to keep the original name. */
const attachmentSchema = z.preprocess(
  v => (typeof v === "string" ? { dataUrl: v } : v),
  z.object({ filename: z.string().trim().min(1).max(120).optional(), dataUrl: dataUrlSchema }),
);

export const attachmentsSchema = z.array(attachmentSchema).max(MAX_ATTACHMENTS, `Attach up to ${MAX_ATTACHMENTS} files`).default([]);

const messageBody = z.string().trim().min(1, "Write a message").max(3000, "Messages can be up to 3000 characters");

export const createTicketSchema = z.object({
  category: z.enum(TICKET_CATEGORIES, { error: `Category must be one of: ${TICKET_CATEGORIES.join(", ")}` }),
  subject: z.string().trim().min(3, "Subject must be at least 3 characters").max(120, "Subject can be up to 120 characters"),
  priority: enumLoose(["LOW", "NORMAL", "HIGH"] as const, "Priority").default("NORMAL"),
  /** A tracking ID the ticket is about. */
  relatedRef: z.string().trim().toUpperCase().min(3).max(40).optional(),
  message: messageBody,
  attachments: attachmentsSchema,
});

export const replySchema = z.object({
  body: messageBody,
  attachments: attachmentsSchema,
  /** Staff-only note, never shown to the requester. */
  internal: z.boolean().default(false),
});

export const updateTicketSchema = z
  .object({
    status: statusSchema.optional(),
    priority: prioritySchema.optional(),
    assigneeId: z.uuid().nullable().optional(),
  })
  .refine(v => v.status !== undefined || v.priority !== undefined || v.assigneeId !== undefined, "Send at least one of status, priority or assigneeId");

export const listTicketsQuerySchema = pageQuerySchema.extend({
  status: statusSchema.optional(),
  category: z.enum(ALL_CATEGORIES, { error: `Category must be one of: ${ALL_CATEGORIES.join(", ")}` }).optional(),
  /** Staff only: a user id, "me" or "unassigned". */
  assigneeId: z.union([z.uuid(), z.literal("me"), z.literal("unassigned")]).optional(),
  /** Staff only. */
  merchantId: z.uuid().optional(),
  /** Ticket number or subject. */
  q: z.string().trim().min(1).max(120).optional(),
});

export type Attachment = z.infer<typeof attachmentSchema>;
