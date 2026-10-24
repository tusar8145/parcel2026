/**
 * Roles and permissions. A user can hold several roles; merchant and hub roles are
 * scoped to one merchant / hub (see UserRole in the database schema).
 */
export const ROLES = [
  "CUSTOMER",
  "MERCHANT_OWNER",
  "MERCHANT_STAFF",
  "RIDER",
  "HUB_OPERATOR",
  "OPS_MANAGER",
  "FINANCE",
  "SUPPORT_AGENT",
  "SUPER_ADMIN",
  /** The one account of a franchise hub: its own panel, scoped to that hub (no network-wide access). */
  "FRANCHISE",
  /** Applied to ride or run a franchise and waits for approval: sees only the application page (/application). */
  "APPLICANT",
] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  // parcels
  "parcel:create",
  "parcel:read:own",
  "parcel:read:any",
  "parcel:cancel:own",
  "parcel:dispatch", // confirm, assign riders, move between hubs, resolve exceptions
  "parcel:rider-update", // status updates by the assigned rider
  // network
  "hub:read",
  "hub:manage",
  "rider:read",
  "rider:manage",
  // merchants
  "merchant:read:any",
  "merchant:manage",
  "merchant:self", // own merchant: profile, members, API keys, webhooks
  "merchant:address", // change a merchant's address (its hub follows) and approve merchants' own address changes
  // money
  "cod:collect",
  "cod:receive", // hub receives rider cash
  "finance:read",
  "finance:manage",
  // support
  "support:create",
  "support:manage",
  // administration
  "user:read",
  "user:manage",
  "config:manage",
  "audit:read",
  // platform security (super admin)
  "role:manage", // edit role permissions and custom roles
  "user:impersonate", // support access: view the platform as another user
  "user:login-as", // "Log in as" a merchant member or rider, read-only (operations managers)
  "change:approve", // approve another administrator's sensitive change (maker-checker)
  "analytics:read", // website traffic and tracking-lookup analytics
  // franchise hubs
  "franchise:self", // the franchise panel: its own hub's parcels, riders, walk-ins, cash and commission
  "franchise:manage", // create franchises, set commission rates and the settlement mode, suspend
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const OPS_BASE: Permission[] = ["parcel:read:any", "parcel:dispatch", "hub:read", "rider:read", "merchant:read:any", "support:create"];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  CUSTOMER: ["parcel:create", "parcel:read:own", "parcel:cancel:own", "support:create"],
  MERCHANT_OWNER: ["parcel:create", "parcel:read:own", "parcel:cancel:own", "merchant:self", "finance:read", "support:create"],
  MERCHANT_STAFF: ["parcel:create", "parcel:read:own", "parcel:cancel:own", "support:create"],
  RIDER: ["parcel:rider-update", "cod:collect", "support:create"],
  HUB_OPERATOR: [...OPS_BASE, "cod:receive"],
  OPS_MANAGER: [...OPS_BASE, "cod:receive", "hub:manage", "rider:manage", "support:manage", "user:read", "audit:read", "user:login-as", "merchant:address", "finance:read", "finance:manage"],
  FINANCE: ["parcel:read:any", "merchant:read:any", "finance:read", "finance:manage", "cod:receive", "audit:read"],
  SUPPORT_AGENT: ["parcel:read:any", "merchant:read:any", "rider:read", "support:create", "support:manage", "user:read"],
  SUPER_ADMIN: [...PERMISSIONS],
  FRANCHISE: ["franchise:self", "support:create"],
  APPLICANT: ["support:create"],
};

export function permissionsFor(roles: readonly Role[]): Set<Permission> {
  return new Set(roles.flatMap(role => ROLE_PERMISSIONS[role]));
}

export const isPermission = (value: string): value is Permission => (PERMISSIONS as readonly string[]).includes(value);

/** Only super admins may hold these; they can't be added to other roles or custom roles. */
export const SUPER_ADMIN_ONLY_PERMISSIONS: readonly Permission[] = ["role:manage", "user:impersonate", "change:approve"];

/** Lockout protection: the built-in SUPER_ADMIN role always keeps these. */
export const SUPER_ADMIN_CRITICAL_PERMISSIONS: readonly Permission[] = [
  "user:read",
  "user:manage",
  "config:manage",
  "audit:read",
  "role:manage",
  "change:approve",
];

/** Roles that must use two-step verification (TOTP) to sign in. */
export const MFA_REQUIRED_ROLES: readonly Role[] = ["SUPER_ADMIN"];

/** Built-in roles a custom role can be based on (decides panel access and merchant/hub scoping). */
export const CUSTOM_ROLE_BASES = ["MERCHANT_STAFF", "HUB_OPERATOR", "OPS_MANAGER", "FINANCE", "SUPPORT_AGENT"] as const satisfies readonly Role[];
export type CustomRoleBase = (typeof CUSTOM_ROLE_BASES)[number];

/** Per-role change to the built-in permission set. */
export interface RolePermissionChange {
  granted: readonly string[];
  revoked: readonly string[];
}

/** A built-in role's permissions after an override (unknown keys ignored; SUPER_ADMIN keeps its critical set). */
export function effectiveRolePermissions(role: Role, change?: RolePermissionChange | null): Set<Permission> {
  const result = new Set<Permission>(ROLE_PERMISSIONS[role]);
  if (!change) return result;
  for (const p of change.granted) if (isPermission(p) && (role === "SUPER_ADMIN" || !SUPER_ADMIN_ONLY_PERMISSIONS.includes(p))) result.add(p);
  for (const p of change.revoked) if (isPermission(p) && !(role === "SUPER_ADMIN" && SUPER_ADMIN_CRITICAL_PERMISSIONS.includes(p))) result.delete(p);
  return result;
}

/** Labels for the permission editor. */
export const PERMISSION_INFO: Record<Permission, { group: string; label: string }> = {
  "parcel:create": { group: "Parcels", label: "Book parcels" },
  "parcel:read:own": { group: "Parcels", label: "See own parcels" },
  "parcel:read:any": { group: "Parcels", label: "See all parcels" },
  "parcel:cancel:own": { group: "Parcels", label: "Cancel own parcels" },
  "parcel:dispatch": { group: "Parcels", label: "Dispatch, assign riders and resolve exceptions" },
  "parcel:rider-update": { group: "Parcels", label: "Rider status updates" },
  "hub:read": { group: "Network", label: "See hubs" },
  "hub:manage": { group: "Network", label: "Manage hubs" },
  "rider:read": { group: "Network", label: "See riders" },
  "rider:manage": { group: "Network", label: "Manage riders" },
  "merchant:read:any": { group: "Merchants", label: "See all merchants" },
  "merchant:manage": { group: "Merchants", label: "Approve and manage merchants" },
  "merchant:self": { group: "Merchants", label: "Own merchant workspace (team, API keys, webhooks)" },
  "merchant:address": { group: "Merchants", label: "Change merchant addresses and approve address changes" },
  "cod:collect": { group: "Money", label: "Collect COD (rider)" },
  "cod:receive": { group: "Money", label: "Receive rider cash at a hub" },
  "finance:read": { group: "Money", label: "See finance" },
  "finance:manage": { group: "Money", label: "Settlements, invoices and payouts" },
  "support:create": { group: "Support", label: "Open support tickets" },
  "support:manage": { group: "Support", label: "Handle support tickets" },
  "user:read": { group: "Administration", label: "See user accounts" },
  "user:manage": { group: "Administration", label: "Create users and grant roles" },
  "config:manage": { group: "Administration", label: "Platform settings, pricing and catalog" },
  "audit:read": { group: "Administration", label: "Read the audit log" },
  "role:manage": { group: "Security", label: "Edit roles and permissions" },
  "user:impersonate": { group: "Security", label: "Support access (view as another user)" },
  "user:login-as": { group: "Security", label: "Log in as a merchant or rider (read-only)" },
  "change:approve": { group: "Security", label: "Approve sensitive changes (second approver)" },
  "analytics:read": { group: "Administration", label: "Website and tracking analytics" },
  "franchise:self": { group: "Franchise", label: "Franchise panel (own hub)" },
  "franchise:manage": { group: "Franchise", label: "Create and manage franchises" },
};

/** Which web panel a role signs in to, in priority order. */
export const PANEL_FOR_ROLE: [Role, string][] = [
  ["SUPER_ADMIN", "/super-admin"],
  ["OPS_MANAGER", "/courier-operation"],
  ["HUB_OPERATOR", "/courier-operation"],
  ["FINANCE", "/courier-operation"],
  ["SUPPORT_AGENT", "/courier-operation"],
  ["FRANCHISE", "/franchise"],
  ["RIDER", "/rider"],
  ["MERCHANT_OWNER", "/ecommerce-merchant"],
  ["MERCHANT_STAFF", "/ecommerce-merchant"],
  ["APPLICANT", "/application"],
  ["CUSTOMER", "/account"],
];
