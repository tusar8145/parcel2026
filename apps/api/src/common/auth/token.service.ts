import { Injectable } from "@nestjs/common";
import { jwtVerify, SignJWT, errors as joseErrors } from "jose";
import { ROLES, type Role } from "@delivery-fast/shared";
import { env } from "../../config/env";
import { RedisService } from "../redis.service";
import { unauthorized } from "../errors";
import { userActor, type ImpersonationInfo, type RoleGrant, type UserActor } from "./actor";
import { AUTHZ_VERSION_KEY, PermissionService, userVersionKey } from "./permissions.service";

const ISSUER = "deliveryfast-api";
const AUDIENCE = "deliveryfast";

interface AccessClaims {
  sid: string;
  name: string;
  roles: [Role, string | null, string | null, (string | null)?][]; // [role, merchantId, hubId, customRoleId]
  rid?: string; // rider profile id
  uv?: number; // user access version at issue time
  imp?: { id: string; by: string; byName: string; ro: boolean; exp: string }; // support access
}

/**
 * Short-lived access tokens (JWT, HS256). Role grants are embedded so requests need no DB
 * lookup; permissions are resolved per request from cached role definitions
 * (PermissionService). Revoking a session denylists its id in Redis until its tokens expire;
 * bumping a user's access version makes their older tokens refresh.
 */
@Injectable()
export class TokenService {
  private readonly secret = new TextEncoder().encode(env().JWT_ACCESS_SECRET);

  constructor(
    private readonly redis: RedisService,
    private readonly permissions: PermissionService,
  ) {}

  async issueAccessToken(input: {
    userId: string;
    sessionId: string;
    name: string;
    roles: RoleGrant[];
    riderId?: string;
    /** Support access: overrides the TTL and marks the token as impersonation. */
    impersonation?: ImpersonationInfo;
    ttlSeconds?: number;
  }) {
    const ttl = input.ttlSeconds ?? env().ACCESS_TOKEN_TTL_SECONDS;
    const uv = Number((await this.redis.get(userVersionKey(input.userId)).catch(() => null)) ?? 0);
    const claims: AccessClaims = {
      sid: input.sessionId,
      name: input.name,
      roles: input.roles.map(r => (r.customRoleId ? [r.role, r.merchantId ?? null, r.hubId ?? null, r.customRoleId] : [r.role, r.merchantId ?? null, r.hubId ?? null])),
      uv,
      ...(input.riderId ? { rid: input.riderId } : {}),
      ...(input.impersonation
        ? {
            imp: {
              id: input.impersonation.id,
              by: input.impersonation.adminUserId,
              byName: input.impersonation.adminName,
              ro: input.impersonation.readOnly,
              exp: input.impersonation.expiresAt,
            },
          }
        : {}),
    };
    const token = await new SignJWT({ ...claims })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(input.userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${ttl}s`)
      .sign(this.secret);
    return { accessToken: token, expiresIn: ttl };
  }

  async verifyAccessToken(token: string): Promise<UserActor> {
    let payload: Record<string, unknown> & { sub?: string };
    try {
      ({ payload } = await jwtVerify(token, this.secret, { issuer: ISSUER, audience: AUDIENCE, algorithms: ["HS256"] }));
    } catch (error) {
      if (error instanceof joseErrors.JWTExpired) throw unauthorized("TOKEN_EXPIRED", "Your session expired");
      throw unauthorized("INVALID_TOKEN", "Invalid access token");
    }
    const claims = payload as unknown as AccessClaims & { sub: string };
    const [revoked, authzVersion, userVersion] = await this.redis.mget(this.revokedKey(claims.sid), AUTHZ_VERSION_KEY, userVersionKey(claims.sub));
    if (revoked) throw unauthorized("SESSION_REVOKED", "You were signed out");
    // The user's grants changed after this token was issued: the client refreshes (new grants apply now).
    if (!claims.imp && userVersion && Number(userVersion) > (claims.uv ?? 0)) throw unauthorized("TOKEN_EXPIRED", "Your access changed. Refreshing your session.");
    const roles: RoleGrant[] = claims.roles
      .filter(([role]) => (ROLES as readonly string[]).includes(role))
      .map(([role, merchantId, hubId, customRoleId]) => ({ role, merchantId, hubId, ...(customRoleId ? { customRoleId } : {}) }));
    return userActor({
      userId: claims.sub,
      sessionId: claims.sid,
      name: claims.name,
      riderId: claims.rid,
      roles,
      permissions: await this.permissions.resolve(roles, authzVersion),
      ...(claims.imp
        ? { impersonation: { id: claims.imp.id, adminUserId: claims.imp.by, adminName: claims.imp.byName, readOnly: claims.imp.ro, expiresAt: claims.imp.exp } }
        : {}),
    });
  }

  /** Blocks every access token of these sessions until they would have expired anyway. */
  async denylistSessions(sessionIds: string[], ttlSeconds = env().ACCESS_TOKEN_TTL_SECONDS + 60) {
    if (!sessionIds.length) return;
    const multi = this.redis.multi();
    for (const sid of sessionIds) multi.set(this.revokedKey(sid), "1", "EX", Math.max(60, Math.ceil(ttlSeconds)));
    await multi.exec();
  }

  /** Whether this session was revoked (signed out, or support access ended). */
  async isRevoked(sessionId: string) {
    return !!(await this.redis.get(this.revokedKey(sessionId)).catch(() => null));
  }

  private revokedKey = (sid: string) => `auth:revoked-session:${sid}`;
}
