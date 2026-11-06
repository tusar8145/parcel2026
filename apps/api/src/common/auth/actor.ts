import { permissionsFor, type Permission, type Role } from "@delivery-fast/shared";

export interface RoleGrant {
  role: Role;
  merchantId?: string | null;
  hubId?: string | null;
  /** A custom role: `role` is its base role (panel and scoping); permissions come from the custom role. */
  customRoleId?: string | null;
}

/** Present while a super admin uses support access ("view as") for this user. */
export interface ImpersonationInfo {
  id: string;
  adminUserId: string;
  adminName: string;
  readOnly: boolean;
  expiresAt: string;
}

/** Who is making the request. Attached to request.actor by AuthGuard. */
export type Actor = UserActor | ApiKeyActor;

export interface UserActor {
  kind: "user";
  userId: string;
  sessionId: string;
  name: string;
  roles: RoleGrant[];
  riderId?: string;
  permissions: Set<Permission>;
  impersonation?: ImpersonationInfo;
}

export interface ApiKeyActor {
  kind: "api_key";
  apiKeyId: string;
  merchantId: string;
  name: string;
  /** Scopes chosen at creation; empty for keys created before scopes (original access). */
  scopes?: string[];
  permissions: Set<Permission>;
}

export const API_KEY_PERMISSIONS: Permission[] = ["parcel:create", "parcel:read:own", "parcel:cancel:own"];

/** Permissions default to the built-in role sets; TokenService passes the resolved ones (overrides, custom roles). */
export function userActor(input: Omit<UserActor, "kind" | "permissions"> & { permissions?: Set<Permission> }): UserActor {
  return { kind: "user", ...input, permissions: input.permissions ?? permissionsFor(input.roles.map(r => r.role)) };
}

export const hasRole = (actor: Actor, role: Role) => actor.kind === "user" && actor.roles.some(r => r.role === role);

/** Merchants this actor acts for (merchant roles or an API key). */
export function merchantIdsOf(actor: Actor): string[] {
  if (actor.kind === "api_key") return [actor.merchantId];
  return actor.roles
    .filter(r => (r.role === "MERCHANT_OWNER" || r.role === "MERCHANT_STAFF") && r.merchantId)
    .map(r => r.merchantId!);
}

export const actorLabel = (actor: Actor) =>
  actor.kind === "api_key" ? `API key ${actor.name}` : actor.impersonation ? `${actor.impersonation.adminName} (as ${actor.name})` : actor.name;
