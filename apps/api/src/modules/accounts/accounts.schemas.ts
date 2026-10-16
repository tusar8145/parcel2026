import { z } from "zod";
import { ADDRESS_CATEGORIES, emailSchema, latitudeSchema, longitudeSchema, passwordSchema, phoneSchema, ROLES } from "@delivery-fast/shared";
import { pageQuerySchema } from "../../common/pagination";

const text = (max: number, label: string) =>
  z.string(`${label} is required`).trim().min(1, `${label} is required`).max(max, `${label} must be at most ${max} characters`);

/** Accepts "Home" / "HOME". */
const category = z
  .string()
  .transform(v => v.trim().toUpperCase())
  .pipe(z.enum(ADDRESS_CATEGORIES, "Category must be Home, Office or Other"));

const addressRole = z.enum(["PICKUP", "RECEIVER"], "Role must be PICKUP or RECEIVER");

// ── address book ──
export const createAddressSchema = z.object({
  role: addressRole,
  category: category.default("HOME"),
  contactName: text(120, "Contact name"),
  phone: phoneSchema,
  street: text(200, "Street"),
  area: z.string().trim().max(120, "Area must be at most 120 characters").optional().transform(v => v || undefined),
  zone: text(80, "Zone"),
  district: text(80, "District"),
  /** Optional map pin (website address picker). */
  lat: latitudeSchema.optional(),
  lng: longitudeSchema.optional(),
  isDefault: z.boolean().default(false),
});

// Written out rather than .partial() so defaults never overwrite stored values on PATCH.
export const updateAddressSchema = z
  .object({
    role: addressRole.optional(),
    category: category.optional(),
    contactName: text(120, "Contact name").optional(),
    phone: phoneSchema.optional(),
    street: text(200, "Street").optional(),
    area: z.string().trim().max(120, "Area must be at most 120 characters").nullable().optional().transform(v => (v === "" ? null : v)),
    zone: text(80, "Zone").optional(),
    district: text(80, "District").optional(),
    lat: latitudeSchema.nullable().optional(),
    lng: longitudeSchema.nullable().optional(),
    isDefault: z.boolean().optional(),
  })
  .refine(v => Object.values(v).some(x => x !== undefined), "Send at least one field to change");

export const listAddressesQuerySchema = z.object({ role: addressRole.optional() });

// ── user administration ──
const userStatus = z.enum(["ACTIVE", "SUSPENDED", "DEACTIVATED"], "Status must be ACTIVE, SUSPENDED or DEACTIVATED");

export const roleGrantSchema = z.object({
  role: z.enum(ROLES, "Unknown role"),
  merchantId: z.uuid("Merchant id must be a UUID").optional(),
  hubId: z.uuid("Hub id must be a UUID").optional(),
  /** A custom role (role must be its base role). */
  customRoleId: z.uuid("Custom role id must be a UUID").optional(),
});
export type RoleGrantInput = z.infer<typeof roleGrantSchema>;

const grantKey = (g: RoleGrantInput) => `${g.role}|${g.merchantId ?? ""}|${g.hubId ?? ""}|${g.customRoleId ?? ""}`;

export const createUserSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(120, "Name must be at most 120 characters"),
  phone: phoneSchema,
  email: emailSchema.optional(),
  /** Optional: without one the user signs in with an SMS code. */
  password: passwordSchema.optional(),
  roles: z
    .array(roleGrantSchema)
    .min(1, "Give the user at least one role")
    .max(20, "At most 20 roles")
    .refine(grants => new Set(grants.map(grantKey)).size === grants.length, "The same role is listed twice"),
});

export const updateUserSchema = z
  .object({
    name: z.string().trim().min(2, "Name must be at least 2 characters").max(120, "Name must be at most 120 characters").optional(),
    email: emailSchema.nullable().optional(),
    status: userStatus.optional(),
  })
  .refine(v => v.name !== undefined || v.email !== undefined || v.status !== undefined, "Send at least one field to change");

export const listUsersQuerySchema = pageQuerySchema.extend({
  q: z.string().trim().max(80, "Search must be at most 80 characters").optional().transform(v => v || undefined),
  role: z.enum(ROLES, "Unknown role").optional(),
  /** Comma-separated: users holding any of these roles, e.g. "SUPER_ADMIN,OPS_MANAGER". */
  roles: z
    .string()
    .optional()
    .transform(v => (v ? [...new Set(v.split(",").map(s => s.trim().toUpperCase()).filter(Boolean))] : undefined))
    .pipe(z.array(z.enum(ROLES, "Unknown role")).max(ROLES.length).optional()),
  status: userStatus.optional(),
});

// ── audit log ──
export const listAuditLogsQuerySchema = pageQuerySchema
  .extend({
    actorId: z.uuid("Actor id must be a UUID").optional(),
    entityType: z.string().trim().min(1).max(60).optional(),
    entityId: z.string().trim().min(1).max(120).optional(),
    /** Prefix match: "parcel." finds every parcel action. */
    action: z.string().trim().min(1).max(80).optional(),
    from: z.coerce.date("From must be a date or ISO timestamp").optional(),
    to: z.coerce.date("To must be a date or ISO timestamp").optional(),
  })
  .refine(v => !v.from || !v.to || v.from <= v.to, { message: "From must be before To", path: ["from"] });
