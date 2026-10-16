import { Controller, Get, HttpCode, Post, Req, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ApiZodBody, ZBody } from "../../common/zod";
import { CurrentUser, OptionalActor, Public, ReqMeta, type RequestMeta } from "../../common/auth/decorators";
import type { Actor, UserActor } from "../../common/auth/actor";
import { AppError, unauthorized } from "../../common/errors";
import { env } from "../../config/env";
import { NotifyService } from "../notifications/notify.service";
import { AuditService } from "../../common/audit.service";
import { AuthService } from "./auth.service";
import { sendSession } from "./auth.controller";
import { MfaService } from "./mfa.service";
import { SessionService } from "./session.service";

const STRICT = { default: { limit: () => env().AUTH_RATE_LIMIT_PER_MINUTE, ttl: 60_000 } };

const mfaTokenSchema = z.string("Sign in again").trim().min(20, "Sign in again").max(200, "Sign in again");
/** A 6-digit authenticator code, or a recovery code (XXXXX-XXXXX). */
const mfaCodeSchema = z.string("Enter the code").trim().min(6, "Enter the 6-digit code").max(20, "That code is too long");

export const mfaLoginSchema = z.object({ mfaToken: mfaTokenSchema, code: mfaCodeSchema });
export const mfaSetupSchema = z.object({ mfaToken: mfaTokenSchema.optional() });
export const mfaEnableSchema = z.object({ code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app"), mfaToken: mfaTokenSchema.optional() });
export const mfaCodeOnlySchema = z.object({ code: mfaCodeSchema });

/**
 * Two-step verification (TOTP). See docs/architecture-contracts.md "Sign-in with MFA".
 * Setup and enable accept either a signed-in user or the mfaToken of a sign-in that requires
 * enrolment (mfaSetupRequired).
 */
@ApiTags("auth")
@Controller("auth")
export class MfaController {
  constructor(
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
    private readonly sessions: SessionService,
    private readonly notify: NotifyService,
    private readonly audit: AuditService,
  ) {}

  /** Second sign-in step: { mfaToken, code } → the normal session response. 5 wrong codes end the challenge; 10 in a row lock MFA for 15 minutes. */
  @Public()
  @Throttle(STRICT)
  @Post("login/mfa")
  @HttpCode(200)
  @ApiZodBody(mfaLoginSchema)
  async login(@ZBody(mfaLoginSchema) body: z.infer<typeof mfaLoginSchema>, @Req() req: FastifyRequest, @ReqMeta() meta: RequestMeta, @Res({ passthrough: true }) reply: FastifyReply) {
    return sendSession(req, reply, await this.auth.loginWithMfa(body, meta));
  }

  /** The signed-in user's two-step verification status. */
  @Get("mfa")
  status(@CurrentUser() actor: UserActor) {
    return this.mfa.status(actor.userId);
  }

  /** Starts enrolment: a new secret as an otpauth:// URL and QR code (confirm it with /auth/mfa/enable). */
  @Public()
  @Throttle(STRICT)
  @Post("mfa/setup")
  @HttpCode(200)
  @ApiZodBody(mfaSetupSchema)
  async setup(@OptionalActor() actor: Actor | undefined, @ZBody(mfaSetupSchema) body: z.infer<typeof mfaSetupSchema>) {
    const userId = await this.userFor(actor, body.mfaToken);
    return this.mfa.setup(userId);
  }

  /** Confirms enrolment with the first code → { recoveryCodes } (shown once), plus a session when started from an mfaToken. */
  @Public()
  @Throttle(STRICT)
  @Post("mfa/enable")
  @HttpCode(200)
  @ApiZodBody(mfaEnableSchema)
  async enable(
    @OptionalActor() actor: Actor | undefined,
    @ZBody(mfaEnableSchema) body: z.infer<typeof mfaEnableSchema>,
    @Req() req: FastifyRequest,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    if (body.mfaToken) {
      const result = await this.auth.enableMfaFromChallenge({ mfaToken: body.mfaToken, code: body.code }, meta);
      await this.notifyChange(result.user.id, "auth.mfa_enabled");
      return sendSession(req, reply, result);
    }
    const user = this.signedIn(actor);
    const recoveryCodes = await this.mfa.enable(user.userId, body.code, meta);
    // Other devices signed in without the second step; this one just proved it.
    await this.sessions.revokeAllForUser(user.userId, "mfa_enabled", user.sessionId);
    await this.sessions.markMfaVerified(user.sessionId);
    await this.notifyChange(user.userId, "auth.mfa_enabled");
    return { recoveryCodes };
  }

  /** Turns two-step verification off (needs a current code or a recovery code). Not allowed for roles that require it. */
  @Post("mfa/disable")
  @HttpCode(200)
  @ApiZodBody(mfaCodeOnlySchema)
  async disable(@CurrentUser() actor: UserActor, @ZBody(mfaCodeOnlySchema) body: z.infer<typeof mfaCodeOnlySchema>, @ReqMeta() meta: RequestMeta) {
    const status = await this.mfa.status(actor.userId);
    if (status.required)
      throw new AppError("MFA_REQUIRED_FOR_ROLE", "Your role requires two-step verification, so it can't be turned off. Another super admin can reset it if you lost your device.", 422);
    await this.mfa.verify(actor.userId, body.code, meta);
    await this.mfa.remove(actor.userId);
    await this.audit.record(actor, { action: "auth.mfa_disabled", entityType: "user", entityId: actor.userId }, meta);
    await this.notifyChange(actor.userId, "auth.mfa_disabled");
    return { enabled: false };
  }

  /** New recovery codes (the old ones stop working). Needs a current authenticator code. */
  @Post("mfa/recovery-codes")
  @HttpCode(200)
  @ApiZodBody(mfaCodeOnlySchema)
  async recoveryCodes(@CurrentUser() actor: UserActor, @ZBody(mfaCodeOnlySchema) body: z.infer<typeof mfaCodeOnlySchema>, @ReqMeta() meta: RequestMeta) {
    await this.mfa.verify(actor.userId, body.code, meta, { allowRecovery: false });
    return { recoveryCodes: await this.mfa.regenerateRecoveryCodes(actor.userId, meta) };
  }

  private signedIn(actor: Actor | undefined): UserActor {
    if (!actor || actor.kind !== "user") throw unauthorized();
    return actor;
  }

  private async userFor(actor: Actor | undefined, mfaToken?: string) {
    if (mfaToken) return (await this.mfa.readChallenge(mfaToken, ["setup"])).userId;
    return this.signedIn(actor).userId;
  }

  /** Security notice to the account holder (SMS/email per notification settings). */
  private async notifyChange(userId: string, event: "auth.mfa_enabled" | "auth.mfa_disabled") {
    try {
      const at = new Date().toLocaleString("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
      await this.notify.notifyNow({ event, to: { userId }, vars: { at } });
    } catch {
      // A notice that can't be queued must not undo the security change.
    }
  }
}
