import type { z } from "zod";
import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Req, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  changePasswordSchema,
  otpLoginSchema,
  passwordLoginSchema,
  requestOtpSchema,
  resetPasswordSchema,
  signupSchema,
} from "@paira-express/shared";
import { ApiZodBody, ZBody } from "../../common/zod";
import { CurrentUser, Public, ReqMeta, type RequestMeta } from "../../common/auth/decorators";
import type { UserActor } from "../../common/auth/actor";
import { AppError, notFound, unauthorized } from "../../common/errors";
import { env, isProduction } from "../../config/env";
import { PrismaService } from "../../common/prisma.service";
import { AuthService, type MfaChallengeResult } from "./auth.service";
import { SessionService, type SessionTokens } from "./session.service";

export const REFRESH_COOKIE = "df_rt";
const COOKIE_PATH = "/api/v1/auth";
/** Cookie-authenticated endpoints require this header, which a cross-site form can't send. */
const CLIENT_HEADER = "x-df-client";

// Per client IP per minute (AUTH_RATE_LIMIT_PER_MINUTE, default 10).
const STRICT = { default: { limit: () => env().AUTH_RATE_LIMIT_PER_MINUTE, ttl: 60_000 } };

/**
 * Sets the refresh cookie and returns the session body (plus any extra fields, e.g. recovery
 * codes). MFA challenges (no session yet) are returned as they are, without a cookie.
 */
export function sendSession<T extends { session: SessionTokens; user: unknown }>(
  req: FastifyRequest,
  reply: FastifyReply,
  result: T | MfaChallengeResult,
) {
  if (!("session" in result)) return result;
  const { session, user, ...extra } = result;
  reply.setCookie(REFRESH_COOKIE, session.refreshToken, {
    httpOnly: true,
    secure: isProduction(),
    sameSite: "lax",
    path: COOKIE_PATH,
    expires: session.refreshExpiresAt,
  });
  return {
    ...extra,
    accessToken: session.accessToken,
    expiresIn: session.expiresIn,
    // Browsers (x-df-client: web) only get the httpOnly cookie; apps keep the token themselves.
    refreshToken: req.headers[CLIENT_HEADER] === "web" ? undefined : session.refreshToken,
    user,
  };
}

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Throttle(STRICT)
  @Post("otp")
  @HttpCode(200)
  @ApiZodBody(requestOtpSchema)
  requestOtp(@ZBody(requestOtpSchema) body: { phone: string; purpose: "SIGNUP" | "LOGIN" | "PASSWORD_RESET" }, @ReqMeta() meta: RequestMeta) {
    return this.auth.requestOtp(body.phone, body.purpose, meta);
  }

  @Public()
  @Throttle(STRICT)
  @Post("signup")
  @ApiZodBody(signupSchema)
  async signup(@ZBody(signupSchema) body: z.infer<typeof signupSchema>, @Req() req: FastifyRequest, @ReqMeta() meta: RequestMeta, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.respond(req, reply, await this.auth.signup(body, meta));
  }

  @Public()
  @Throttle(STRICT)
  @Post("login")
  @HttpCode(200)
  @ApiZodBody(passwordLoginSchema)
  async login(@ZBody(passwordLoginSchema) body: z.infer<typeof passwordLoginSchema>, @Req() req: FastifyRequest, @ReqMeta() meta: RequestMeta, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.respond(req, reply, await this.auth.loginWithPassword(body, meta));
  }

  @Public()
  @Throttle(STRICT)
  @Post("login/otp")
  @HttpCode(200)
  @ApiZodBody(otpLoginSchema)
  async loginOtp(@ZBody(otpLoginSchema) body: z.infer<typeof otpLoginSchema>, @Req() req: FastifyRequest, @ReqMeta() meta: RequestMeta, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.respond(req, reply, await this.auth.loginWithOtp(body, meta));
  }

  @Public()
  @Throttle(STRICT)
  @Post("password/reset")
  @HttpCode(200)
  @ApiZodBody(resetPasswordSchema)
  resetPassword(@ZBody(resetPasswordSchema) body: z.infer<typeof resetPasswordSchema>, @ReqMeta() meta: RequestMeta) {
    return this.auth.resetPassword(body, meta);
  }

  /** Exchanges the refresh cookie (or body.refreshToken for non-browser clients) for new tokens. */
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post("refresh")
  @HttpCode(200)
  async refresh(@Req() req: FastifyRequest, @ReqMeta() meta: RequestMeta, @Res({ passthrough: true }) reply: FastifyReply) {
    const token = this.refreshTokenFrom(req);
    if (!token) throw unauthorized("NO_SESSION", "Please sign in");
    try {
      const session = await this.sessions.rotate(token, meta);
      return this.respond(req, reply, { session, user: await this.auth.me(session.userId) });
    } catch (error) {
      this.clearCookie(reply);
      throw error;
    }
  }

  @Public()
  @Post("logout")
  @HttpCode(204)
  async logout(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const token = this.refreshTokenFrom(req);
    if (token) await this.sessions.revokeByRefreshToken(token);
    this.clearCookie(reply);
  }

  @Get("me")
  async me(@CurrentUser() actor: UserActor) {
    const user = await this.auth.me(actor.userId);
    // Support access: the page shows a banner and blocks changes.
    return actor.impersonation ? { ...user, impersonation: actor.impersonation } : user;
  }

  @Post("password/change")
  @HttpCode(200)
  @ApiZodBody(changePasswordSchema)
  changePassword(@CurrentUser() actor: UserActor, @ZBody(changePasswordSchema) body: z.infer<typeof changePasswordSchema>, @ReqMeta() meta: RequestMeta) {
    return this.auth.changePassword(actor, body, meta);
  }

  @Get("sessions")
  sessionsList(@CurrentUser() actor: UserActor) {
    return this.auth.listSessions(actor);
  }

  @Delete("sessions/:id")
  @HttpCode(204)
  async revokeSession(@CurrentUser() actor: UserActor, @Param("id", ParseUUIDPipe) id: string) {
    const session = await this.prisma.session.findFirst({ where: { id, userId: actor.userId } });
    if (!session) throw notFound("Session");
    await this.sessions.revoke(id, "revoked_by_user");
  }

  @Post("logout-all")
  @HttpCode(204)
  async logoutAll(@CurrentUser() actor: UserActor, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.sessions.revokeAllForUser(actor.userId, "logout_all");
    this.clearCookie(reply);
  }

  private refreshTokenFrom(req: FastifyRequest): string | undefined {
    const fromBody = (req.body as { refreshToken?: unknown } | undefined)?.refreshToken;
    if (typeof fromBody === "string") return fromBody;
    const cookie = req.cookies?.[REFRESH_COOKIE];
    if (cookie && !req.headers[CLIENT_HEADER]) throw new AppError("MISSING_CLIENT_HEADER", `Send the ${CLIENT_HEADER} header`, 400);
    return cookie;
  }

  private respond(req: FastifyRequest, reply: FastifyReply, result: { session: SessionTokens; user: unknown } | MfaChallengeResult) {
    return sendSession(req, reply, result);
  }

  private clearCookie(reply: FastifyReply) {
    reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
  }
}
