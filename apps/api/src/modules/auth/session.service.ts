import { Injectable } from "@nestjs/common";
import { MFA_REQUIRED_ROLES } from "@paira-express/shared";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../../common/prisma.service";
import { TokenService } from "../../common/auth/token.service";
import { randomToken, sha256 } from "../../common/crypto";
import { unauthorized } from "../../common/errors";
import { env } from "../../config/env";
import type { RequestMeta } from "../../common/auth/decorators";
import type { RoleGrant } from "../../common/auth/actor";

export interface SessionTokens {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
  sessionId: string;
  userId: string;
}

/**
 * Refresh tokens are opaque, stored hashed, and rotate on every use. Presenting a token
 * that was already rotated means it leaked: the whole session family is revoked.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
  ) {}

  /** `mfaVerifiedAt`: when this session family passed two-step verification (kept across rotations). */
  async create(userId: string, meta: RequestMeta, familyId: string = randomUUID(), mfaVerifiedAt: Date | null = null): Promise<SessionTokens> {
    const refreshToken = randomToken(48);
    const expiresAt = new Date(Date.now() + env().REFRESH_TOKEN_TTL_DAYS * 86_400_000);
    const session = await this.prisma.session.create({
      data: { userId, familyId, refreshTokenHash: sha256(refreshToken), userAgent: meta.userAgent, ip: meta.ip, expiresAt, mfaVerifiedAt },
    });
    return { ...(await this.accessFor(userId, session.id)), refreshToken, refreshExpiresAt: expiresAt, sessionId: session.id, userId };
  }

  async rotate(refreshToken: string, meta: RequestMeta): Promise<SessionTokens> {
    const session = await this.prisma.session.findUnique({ where: { refreshTokenHash: sha256(refreshToken) } });
    if (!session) throw unauthorized("INVALID_REFRESH_TOKEN", "Please sign in again");
    if (session.revokedAt) {
      if (session.revokedReason === "rotated") await this.revokeFamily(session.familyId, "refresh_token_reuse");
      throw unauthorized("INVALID_REFRESH_TOKEN", "Please sign in again");
    }
    if (session.expiresAt < new Date()) throw unauthorized("SESSION_EXPIRED", "Your session expired. Please sign in again");
    // Only one concurrent rotation wins.
    const { count } = await this.prisma.session.updateMany({
      where: { id: session.id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: "rotated" },
    });
    if (!count) throw unauthorized("INVALID_REFRESH_TOKEN", "Please sign in again");
    const user = await this.prisma.user.findUnique({
      where: { id: session.userId },
      select: { status: true, roles: { select: { role: true } }, mfa: { select: { enabledAt: true } } },
    });
    if (user?.status !== "ACTIVE") throw unauthorized("ACCOUNT_INACTIVE", "This account is not active");
    // Sessions that never passed two-step verification can't continue once it's needed
    // (MFA enabled elsewhere, or a role that requires it was granted).
    const needsMfa = !!user.mfa?.enabledAt || user.roles.some(r => MFA_REQUIRED_ROLES.includes(r.role));
    if (needsMfa && !session.mfaVerifiedAt) {
      await this.revokeFamily(session.familyId, "mfa_required");
      throw unauthorized("MFA_REQUIRED", "Sign in again to complete two-step verification");
    }
    return this.create(session.userId, meta, session.familyId, session.mfaVerifiedAt);
  }

  async revoke(sessionId: string, reason = "logout") {
    await this.prisma.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason } });
    await this.tokens.denylistSessions([sessionId]);
  }

  async revokeByRefreshToken(refreshToken: string) {
    const session = await this.prisma.session.findUnique({ where: { refreshTokenHash: sha256(refreshToken) }, select: { id: true } });
    if (session) await this.revoke(session.id);
  }

  async revokeAllForUser(userId: string, reason: string, exceptSessionId?: string) {
    const active = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
      select: { id: true },
    });
    await this.prisma.session.updateMany({ where: { id: { in: active.map(s => s.id) } }, data: { revokedAt: new Date(), revokedReason: reason } });
    await this.tokens.denylistSessions(active.map(s => s.id));
  }

  /** Marks the current session family as having passed two-step verification. */
  async markMfaVerified(sessionId: string) {
    const session = await this.prisma.session.findUnique({ where: { id: sessionId }, select: { familyId: true } });
    if (session) await this.prisma.session.updateMany({ where: { familyId: session.familyId, revokedAt: null }, data: { mfaVerifiedAt: new Date() } });
  }

  private async revokeFamily(familyId: string, reason: string) {
    const sessions = await this.prisma.session.findMany({ where: { familyId }, select: { id: true } });
    await this.prisma.session.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason } });
    await this.tokens.denylistSessions(sessions.map(s => s.id));
  }

  /** Fresh access token with the user's current roles. */
  async accessFor(userId: string, sessionId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { name: true, roles: { select: { role: true, merchantId: true, hubId: true, customRoleId: true } }, rider: { select: { id: true } } },
    });
    return this.tokens.issueAccessToken({ userId, sessionId, name: user.name, roles: user.roles as RoleGrant[], riderId: user.rider?.id });
  }
}
