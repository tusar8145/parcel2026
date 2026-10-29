import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Permission } from "@paira-express/shared";
import type { FastifyRequest } from "fastify";
import { PrismaService } from "../prisma.service";
import { sha256 } from "../crypto";
import { AppError, forbidden, unauthorized } from "../errors";
import { AuditService } from "../audit.service";
import { API_KEY_PERMISSIONS, type Actor, type UserActor } from "./actor";
import { ALLOW_API_KEY, PERMISSIONS_KEY, PUBLIC_KEY } from "./decorators";
import { TokenService } from "./token.service";
import { API_KEY_SCOPE_METADATA, apiKeyScopeAllows, scopeToPermissions } from "../../modules/merchants/api-key-scopes";
import { merchantHasService } from "../../modules/packages/package-resolver";

export const API_KEY_PREFIX = "df_live_";

/**
 * Global guard. Authenticates `Authorization: Bearer <jwt | df_live_…>` and enforces
 * @RequirePermissions. Routes are private unless marked @Public().
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== "http") return true;
    const request = context.switchToHttp().getRequest<FastifyRequest & { actor?: Actor }>();
    const meta = <T>(key: string) => this.reflector.getAllAndOverride<T>(key, [context.getHandler(), context.getClass()]);
    const isPublic = meta<boolean>(PUBLIC_KEY);

    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
    if (token) {
      try {
        request.actor = token.startsWith(API_KEY_PREFIX) ? await this.apiKeyActor(token) : await this.tokens.verifyAccessToken(token);
      } catch (error) {
        if (!isPublic) throw error;
      }
    }
    // Support access ("view as"): limited and audited on every route, public ones included.
    const impersonated = request.actor;
    if (impersonated?.kind === "user" && impersonated.impersonation) this.enforceImpersonation(request, impersonated);
    if (isPublic) return true;

    const actor = request.actor;
    if (!actor) throw unauthorized();
    if (actor.kind === "api_key" && !meta<boolean>(ALLOW_API_KEY)) throw forbidden("This endpoint can't be used with an API key");
    const required = meta<Permission[]>(PERMISSIONS_KEY) ?? [];
    const missing = required.filter(p => !actor.permissions.has(p));
    if (missing.length) throw forbidden();
    // Scoped API keys: the route must declare one of the key's scopes.
    if (actor.kind === "api_key" && !apiKeyScopeAllows(actor.scopes, meta<string[]>(API_KEY_SCOPE_METADATA)))
      throw forbidden("This API key doesn't have the scope this endpoint needs");
    return true;
  }

  /**
   * Impersonation tokens never reach sign-in, password, MFA or session endpoints (the admin's
   * own refresh cookie must not be usable from the impersonation tab), can't start another
   * impersonation, never send rider GPS fixes (the admin's device location), and are read-only
   * unless a super admin chose full access. Every request is
   * written to the audit log under the admin's id.
   */
  private enforceImpersonation(request: FastifyRequest, actor: UserActor) {
    const imp = actor.impersonation!;
    const method = request.method.toUpperCase();
    const path = (request.url.split("?")[0] ?? "").replace(/\/+$/, "");
    const safe = method === "GET" || method === "HEAD" || method === "OPTIONS";
    const endOwn = method === "POST" && path === `/api/v1/admin/impersonations/${imp.id}/end`;
    const blocked =
      (path.startsWith("/api/v1/auth/") && !(method === "GET" && path === "/api/v1/auth/me")) ||
      (path.startsWith("/api/v1/admin/impersonations") && !endOwn) ||
      /\/mfa(\/|$)/.test(path) ||
      /\/password(\/|$)/.test(path) ||
      // The administrator's own device location must never be recorded as the rider's.
      (!safe && path.startsWith("/api/v1/rider/location"));
    const record = this.audit.record(
      { userId: imp.adminUserId, name: `${imp.adminName} (as ${actor.name})` },
      { action: "impersonation.request", entityType: "user", entityId: actor.userId, data: { impersonationId: imp.id, method, path, blocked: blocked || (!safe && imp.readOnly && !endOwn) } },
      { ip: request.ip, requestId: String(request.id) },
    );
    void record.catch(() => undefined);
    if (blocked) throw forbidden("Not available while viewing as another user");
    if (!safe && imp.readOnly && !endOwn) throw new AppError("IMPERSONATION_READ_ONLY", "Support access is read-only. Nothing was changed.", 403);
  }

  private async apiKeyActor(secret: string): Promise<Actor> {
    const key = await this.prisma.apiKey.findUnique({
      where: { keyHash: sha256(secret) },
      include: { merchant: { select: { status: true } } },
    });
    const now = new Date();
    if (!key || key.revokedAt || (key.expiresAt && key.expiresAt < now)) throw unauthorized("INVALID_API_KEY", "Invalid API key");
    if (key.merchant.status !== "ACTIVE") throw forbidden("This merchant account is not active");
    // Throttled write: at most once a minute per key.
    if (!key.lastUsedAt || now.getTime() - key.lastUsedAt.getTime() > 60_000) {
      void this.prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: now } }).catch(() => undefined);
    }
    // Service packages: a merchant whose package has no API integration can't use its keys.
    if (!(await merchantHasService(this.prisma, key.merchantId, "integration.api")))
      throw new AppError("SERVICE_NOT_IN_PACKAGE", "SERVICE_NOT_IN_PACKAGE: API integration. Your service package doesn't include API access; contact Paira Express to change it.", 403);
    // Keys without scopes (created before scopes existed) keep the original access.
    const scopes = key.scopes ?? [];
    const permissions = scopes.length ? scopeToPermissions(scopes) : API_KEY_PERMISSIONS;
    return { kind: "api_key", apiKeyId: key.id, merchantId: key.merchantId, name: key.name, scopes, permissions: new Set(permissions) };
  }
}
