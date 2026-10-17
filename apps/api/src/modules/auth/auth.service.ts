import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { PANEL_FOR_ROLE, type OtpPurpose, type Role } from "@delivery-fast/shared";
import type { z } from "zod";
import type { changePasswordSchema, otpLoginSchema, passwordLoginSchema, resetPasswordSchema, signupSchema } from "@delivery-fast/shared";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { dummyPasswordHash, hashPassword, verifyPassword } from "../../common/crypto";
import { AppError, unauthorized } from "../../common/errors";
import type { RequestMeta } from "../../common/auth/decorators";
import type { UserActor } from "../../common/auth/actor";
import { OtpService } from "./otp.service";
import { MfaService, mfaRequiredFor } from "./mfa.service";
import type { SessionTokens } from "./session.service";
import { SessionService } from "./session.service";
import { NotifyService } from "../notifications/notify.service";

const MAX_FAILED_LOGINS = 5;

export type MfaChallengeResult = { mfaRequired: true; mfaToken: string; methods: string[] } | { mfaSetupRequired: true; mfaToken: string };
export type SessionResult = { session: SessionTokens; user: ReturnType<typeof toUserView> };
export type LoginResult = SessionResult | MfaChallengeResult;
const LOCK_MINUTES = 15;

const userSelect = {
  id: true,
  name: true,
  phone: true,
  email: true,
  status: true,
  passwordHash: true,
  failedLoginCount: true,
  lockedUntil: true,
  roles: {
    select: {
      role: true,
      merchantId: true,
      hubId: true,
      merchant: { select: { name: true, type: true } },
      hub: { select: { name: true } },
      customRole: { select: { id: true, name: true, active: true } },
    },
  },
  rider: { select: { id: true, code: true, hubId: true } },
  mfa: { select: { enabledAt: true } },
} as const;

/** What toUserView needs (other modules select this to build the same view). */
export const userViewSelect = {
  id: true,
  name: true,
  phone: true,
  email: true,
  roles: userSelect.roles,
  rider: userSelect.rider,
  mfa: userSelect.mfa,
} as const;

type UserRecord = NonNullable<Awaited<ReturnType<PrismaService["user"]["findUnique"]>>> & {
  roles: {
    role: Role;
    merchantId: string | null;
    hubId: string | null;
    merchant: { name: string; type: string } | null;
    hub: { name: string } | null;
    customRole?: { id: string; name: string; active: boolean } | null;
  }[];
  rider: { id: string; code: string; hubId: string | null } | null;
  mfa?: { enabledAt: Date | null } | null;
};

/** What the client gets about the signed-in user. */
export function toUserView(user: Pick<UserRecord, "id" | "name" | "phone" | "email" | "roles" | "rider" | "mfa">) {
  const roles = [...new Set(user.roles.map(r => r.role))];
  const merchantRole = user.roles.find(r => r.merchant);
  const panel = PANEL_FOR_ROLE.find(([role]) => roles.includes(role))?.[1] ?? "/account";
  return {
    id: user.id,
    name: user.name,
    phone: user.phone,
    email: user.email,
    roles,
    merchant: merchantRole ? { id: merchantRole.merchantId, name: merchantRole.merchant!.name, type: merchantRole.merchant!.type } : null,
    rider: user.rider ? { id: user.rider.id, code: user.rider.code } : null,
    customRoles: user.roles.flatMap(r => (r.customRole?.active ? [{ id: r.customRole.id, name: r.customRole.name, baseRole: r.role }] : [])),
    mfa: { enabled: !!user.mfa?.enabledAt, required: mfaRequiredFor(roles) },
    // Banking & Financial merchants have their own panel.
    panel: merchantRole?.merchant?.type === "BANKING_FINANCIAL" && panel === "/ecommerce-merchant" ? "/banking-merchant" : panel,
  };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly mfa: MfaService,
  ) {}

  /** Security notices (property injection keeps the constructor stable for parallel edits). */
  @Inject(NotifyService) private readonly notices!: NotifyService;

  /** "Your password was changed" to the account holder; a notice that can't be queued never undoes the change. */
  private async passwordChangedNotice(userId: string) {
    const at = new Date().toLocaleString("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
    await this.notices.notifyNow({ event: "auth.password_changed", to: { userId }, vars: { at } }).catch(() => undefined);
  }

  /**
   * Doesn't reveal whether the number is registered: sign-in and reset codes are only
   * sent to existing accounts, sign-up codes only to new numbers.
   */
  async requestOtp(phone: string, purpose: OtpPurpose, meta: RequestMeta) {
    const exists = !!(await this.prisma.user.findUnique({ where: { phone }, select: { id: true } }));
    const message = "If this number can be used, we've sent a 6-digit code to it.";
    if (purpose === "SIGNUP" && exists) {
      // Same response shape whichever branch runs (resendAfterSeconds drives the UI countdown).
      return { message, expiresInSeconds: 300, ...(await this.otp.notify(phone, purpose, meta.ip)) };
    }
    if (purpose !== "SIGNUP" && !exists) return { message, expiresInSeconds: 300, resendAfterSeconds: await this.otp.cooldownSeconds() };
    return { message, ...(await this.otp.issue(phone, purpose, meta.ip)) };
  }

  async signup(input: z.infer<typeof signupSchema>, meta: RequestMeta) {
    await this.otp.verify(input.phone, "SIGNUP", input.otp);
    const user = await this.prisma.$transaction(async tx => {
      if (await tx.user.findUnique({ where: { phone: input.phone } }))
        throw new AppError("PHONE_IN_USE", "This number already has an account. Sign in instead.", HttpStatus.CONFLICT);
      if (input.email && (await tx.user.findUnique({ where: { email: input.email } })))
        throw new AppError("EMAIL_IN_USE", "This email is already used by another account", HttpStatus.CONFLICT);
      const created = await tx.user.create({
        data: {
          name: input.name,
          phone: input.phone,
          email: input.email,
          passwordHash: await hashPassword(input.password),
          phoneVerifiedAt: new Date(),
          roles: { create: { role: "CUSTOMER" } },
        },
        select: userSelect,
      });
      await this.audit.record({ userId: created.id, name: created.name }, { action: "auth.signup", entityType: "user", entityId: created.id }, meta, tx);
      return created;
    });
    return this.startSession(user as unknown as UserRecord, meta);
  }

  async loginWithPassword(input: z.infer<typeof passwordLoginSchema>, meta: RequestMeta) {
    const where = input.identifier.includes("@") ? { email: input.identifier } : { phone: input.identifier };
    const user = (await this.prisma.user.findUnique({ where, select: userSelect })) as UserRecord | null;
    const invalid = () => unauthorized("INVALID_CREDENTIALS", "Incorrect phone/email or password");
    if (!user || !user.passwordHash) {
      await verifyPassword(await dummyPasswordHash(), input.password); // same timing as a real check
      throw invalid();
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
      throw new AppError("ACCOUNT_LOCKED", `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}, or reset your password.`, HttpStatus.TOO_MANY_REQUESTS);
    }
    if (!(await verifyPassword(user.passwordHash, input.password))) {
      const failed = user.failedLoginCount + 1;
      await this.prisma.user.update({
        where: { id: user.id },
        data: failed >= MAX_FAILED_LOGINS ? { failedLoginCount: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) } : { failedLoginCount: failed },
      });
      await this.audit.record({ userId: user.id, name: user.name }, { action: failed >= MAX_FAILED_LOGINS ? "auth.locked" : "auth.login_failed", entityType: "user", entityId: user.id }, meta);
      throw invalid();
    }
    return this.beginLogin(user, meta, "password");
  }

  async loginWithOtp(input: z.infer<typeof otpLoginSchema>, meta: RequestMeta) {
    await this.otp.verify(input.phone, "LOGIN", input.otp);
    const user = (await this.prisma.user.findUnique({ where: { phone: input.phone }, select: userSelect })) as UserRecord | null;
    if (!user) throw unauthorized("INVALID_CREDENTIALS", "Incorrect phone number or code");
    return this.beginLogin(user, meta, "otp");
  }

  /**
   * First factor passed. Users with two-step verification get a challenge instead of a
   * session; roles that require it but aren't enrolled yet must set it up first.
   */
  private async beginLogin(user: UserRecord, meta: RequestMeta, method: "password" | "otp"): Promise<LoginResult> {
    if (user.status !== "ACTIVE") throw unauthorized("ACCOUNT_INACTIVE", "This account is suspended. Contact support.");
    const enrolled = !!user.mfa?.enabledAt;
    if (!enrolled && !mfaRequiredFor(user.roles.map(r => r.role))) return this.startSession(user, meta);
    if (user.failedLoginCount || user.lockedUntil) await this.prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });
    const mfaToken = await this.mfa.createChallenge({ userId: user.id, purpose: enrolled ? "login" : "setup", method });
    await this.audit.record(
      { userId: user.id, name: user.name },
      { action: enrolled ? "auth.mfa_challenge" : "auth.mfa_setup_required", entityType: "user", entityId: user.id, data: { method } },
      meta,
    );
    return enrolled ? { mfaRequired: true, mfaToken, methods: ["totp", "recovery"] } : { mfaSetupRequired: true, mfaToken };
  }

  /** Second step of sign-in: a TOTP or recovery code for the challenge. */
  async loginWithMfa(input: { mfaToken: string; code: string }, meta: RequestMeta) {
    const challenge = await this.mfa.readChallenge(input.mfaToken, ["login"]);
    let how: "totp" | "recovery";
    try {
      how = await this.mfa.verify(challenge.userId, input.code, meta);
    } catch (error) {
      if (error instanceof AppError && error.code === "INVALID_MFA_CODE" && (await this.mfa.failChallenge(input.mfaToken)))
        throw unauthorized("MFA_TOKEN_INVALID", "Too many wrong codes. Please sign in again.");
      throw error;
    }
    await this.mfa.consumeChallenge(input.mfaToken);
    const user = (await this.prisma.user.findUnique({ where: { id: challenge.userId }, select: userSelect })) as UserRecord | null;
    if (!user) throw unauthorized("MFA_TOKEN_INVALID", "Your sign-in expired. Please sign in again.");
    return this.startSession(user, meta, { mfa: how, method: challenge.method });
  }

  /** Enrolment that started from a sign-in challenge (mfaSetupRequired): returns recovery codes and a session. */
  async enableMfaFromChallenge(input: { mfaToken: string; code: string }, meta: RequestMeta) {
    const challenge = await this.mfa.readChallenge(input.mfaToken, ["setup"]);
    let recoveryCodes: string[];
    try {
      recoveryCodes = await this.mfa.enable(challenge.userId, input.code, meta);
    } catch (error) {
      if (error instanceof AppError && error.code === "INVALID_MFA_CODE" && (await this.mfa.failChallenge(input.mfaToken)))
        throw unauthorized("MFA_TOKEN_INVALID", "Too many wrong codes. Please sign in again.");
      throw error;
    }
    await this.mfa.consumeChallenge(input.mfaToken);
    // Sessions from before enrolment didn't pass two-step verification.
    await this.sessions.revokeAllForUser(challenge.userId, "mfa_enabled");
    const user = (await this.prisma.user.findUniqueOrThrow({ where: { id: challenge.userId }, select: userSelect })) as UserRecord;
    return { recoveryCodes, ...(await this.startSession(user, meta, { mfa: "totp", method: challenge.method })) };
  }

  async resetPassword(input: z.infer<typeof resetPasswordSchema>, meta: RequestMeta) {
    await this.otp.verify(input.phone, "PASSWORD_RESET", input.otp);
    const user = await this.prisma.user.findUnique({ where: { phone: input.phone }, select: { id: true, name: true } });
    if (!user) throw new AppError("INVALID_CODE", "That code is incorrect or has expired. Request a new one.");
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(input.password), failedLoginCount: 0, lockedUntil: null },
    });
    await this.sessions.revokeAllForUser(user.id, "password_reset");
    await this.audit.record({ userId: user.id, name: user.name }, { action: "auth.password_reset", entityType: "user", entityId: user.id }, meta);
    await this.passwordChangedNotice(user.id);
    return { message: "Your password was changed. Sign in with your new password." };
  }

  async changePassword(actor: UserActor, input: z.infer<typeof changePasswordSchema>, meta: RequestMeta) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.userId }, select: { passwordHash: true } });
    if (!user.passwordHash || !(await verifyPassword(user.passwordHash, input.currentPassword)))
      throw new AppError("INVALID_CREDENTIALS", "Your current password is incorrect", HttpStatus.BAD_REQUEST);
    await this.prisma.user.update({ where: { id: actor.userId }, data: { passwordHash: await hashPassword(input.newPassword) } });
    await this.sessions.revokeAllForUser(actor.userId, "password_changed", actor.sessionId);
    await this.audit.record(actor, { action: "auth.password_changed", entityType: "user", entityId: actor.userId }, meta);
    await this.passwordChangedNotice(actor.userId);
    return { message: "Password changed. Other devices were signed out." };
  }

  async me(userId: string) {
    return toUserView((await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: userSelect })) as UserRecord);
  }

  async listSessions(actor: UserActor) {
    const sessions = await this.prisma.session.findMany({
      where: { userId: actor.userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, userAgent: true, ip: true, createdAt: true, lastUsedAt: true },
      orderBy: { createdAt: "desc" },
    });
    return sessions.map(s => ({ ...s, current: s.id === actor.sessionId }));
  }

  private async startSession(user: UserRecord, meta: RequestMeta, verified?: { mfa: "totp" | "recovery"; method: "password" | "otp" }): Promise<SessionResult> {
    if (user.status !== "ACTIVE") throw unauthorized("ACCOUNT_INACTIVE", "This account is suspended. Contact support.");
    await this.prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } });
    const session = await this.sessions.create(user.id, meta, undefined, verified ? new Date() : null);
    await this.audit.record(
      { userId: user.id, name: user.name },
      { action: "auth.login", entityType: "session", entityId: session.sessionId, ...(verified ? { data: { method: verified.method, mfa: verified.mfa } } : {}) },
      meta,
    );
    return { session, user: toUserView(user) };
  }
}
