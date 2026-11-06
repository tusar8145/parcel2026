import { SetMetadata } from "@nestjs/common";
import type { Permission } from "@delivery-fast/shared";
import { z } from "zod";

/**
 * Merchant API key scopes. A key carries the scopes chosen when it was created; the auth
 * guard turns them into permissions (scopeToPermissions) and checks the scope a route
 * declares with @ApiKeyScope. Keys created before scopes existed (no scopes) keep the
 * original access: book, read and cancel the merchant's parcels.
 */
export const API_KEY_SCOPES = [
  "parcels:read", // list parcels, details, tracking history, proof of delivery
  "parcels:write", // book parcels (single, and spreadsheet/JSON imports via /imports)
  "parcels:cancel", // cancel before pickup is confirmed
  "returns:write", // request returns (RTO) for undeliverable parcels
  "webhooks:manage", // configure webhook endpoints
] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const API_KEY_SCOPE_LABEL: Record<ApiKeyScope, string> = {
  "parcels:read": "Read parcels and tracking",
  "parcels:write": "Book parcels (single and imports)",
  "parcels:cancel": "Cancel parcels",
  "returns:write": "Request returns",
  "webhooks:manage": "Manage webhooks",
};

const SCOPE_PERMISSIONS: Record<ApiKeyScope, Permission[]> = {
  "parcels:read": ["parcel:read:own"],
  "parcels:write": ["parcel:create"],
  "parcels:cancel": ["parcel:cancel:own"],
  "returns:write": ["parcel:read:own"],
  // Lets the key through @RequirePermissions("merchant:self") on the webhook routes that
  // also opt in with @AllowApiKey + @ApiKeyScope("webhooks:manage"); every other
  // self-service route still rejects API keys.
  "webhooks:manage": ["merchant:self"],
};

/** Permissions a scoped key gets. */
export function scopeToPermissions(scopes: readonly string[]): Permission[] {
  return [...new Set(scopes.flatMap(s => SCOPE_PERMISSIONS[s as ApiKeyScope] ?? []))];
}

export const isApiKeyScope = (value: string): value is ApiKeyScope => (API_KEY_SCOPES as readonly string[]).includes(value);

export const apiKeyScopesSchema = z
  .array(z.enum(API_KEY_SCOPES, `Unknown scope. Choose from: ${API_KEY_SCOPES.join(", ")}`))
  .min(1, "Choose at least one scope")
  .transform(scopes => [...new Set(scopes)]);

export const API_KEY_SCOPE_METADATA = "auth:api-key-scope";

/**
 * The scope(s) an API key needs for this route (any one of them). Scoped keys are refused on
 * @AllowApiKey routes that declare no scope; keys without scopes aren't checked.
 */
export const RequireApiKeyScope = (...scopes: ApiKeyScope[]) => SetMetadata(API_KEY_SCOPE_METADATA, scopes);

/** Whether a key with these scopes may use a route that declares `required`. */
export function apiKeyScopeAllows(keyScopes: readonly string[] | undefined, required: readonly string[] | undefined): boolean {
  if (!keyScopes?.length) return true; // legacy key: today's access, enforced by permissions
  if (!required?.length) return false; // fail closed: the route didn't say which scope it needs
  return required.some(scope => keyScopes.includes(scope));
}
