import { HttpStatus, Injectable } from "@nestjs/common";
import { PrismaService } from "../../common/prisma.service";
import { RedisService } from "../../common/redis.service";
import { AuditService } from "../../common/audit.service";
import { RealtimeService } from "../../common/realtime.service";
import { randomDigits, randomToken, safeEqual, sha256 } from "../../common/crypto";
import { AppError, tooMany } from "../../common/errors";
import type { RequestMeta } from "../../common/auth/decorators";
import { env } from "../../config/env";
import { NotifyService } from "../notifications/notify.service";
import { OutboxService } from "../notifications/outbox.service";

const TTL_HOURS = 24;
const MAX_CODE_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 60;
const MAX_PER_HOUR = 5;

const invalid = (path: "token" | "code") =>
  new AppError(
    "INVALID_CODE",
    path === "token" ? "This verification link is invalid or has expired. Request a new one." : "That code is incorrect or has expired. Request a new one.",
    HttpStatus.BAD_REQUEST,
    [{ path, message: path === "token" ? "This link is invalid or has expired" : "That code is incorrect or has expired" }],
  );

/**
 * Email verification: a link (and a 6-digit code) sent to the account's email address
 * (event auth.email_verification). An address counts as verified while the account's
 * current email equals a verified row's email, so changing the email un-verifies it.
 */
@Injectable()
export class EmailVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly notify: NotifyService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
  ) {}

  async status(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
    if (!user.email) return { email: null, verified: false, verifiedAt: null, pending: false };
    const [verified, pending] = await Promise.all([
      this.prisma.emailVerification.findFirst({ where: { userId, email: user.email, verifiedAt: { not: null } }, orderBy: { verifiedAt: "desc" }, select: { verifiedAt: true } }),
      this.prisma.emailVerification.findFirst({ where: { userId, email: user.email, verifiedAt: null, expiresAt: { gt: new Date() } }, select: { id: true } }),
    ]);
    return { email: user.email, verified: !!verified, verifiedAt: verified?.verifiedAt ?? null, pending: !verified && !!pending };
  }

  /** Sends a link and code to the account's current email. */
  async send(userId: string, meta: RequestMeta) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true, email: true, name: true } });
    if (!user.email)
      throw new AppError("NO_EMAIL", "Add an email address to your profile first.", HttpStatus.UNPROCESSABLE_ENTITY, [{ path: "email", message: "Add an email address first" }]);
    const current = await this.status(userId);
    if (current.verified) return { ...current, sent: false, message: "This email address is already verified." };
    await this.enforceLimits(userId);

    const token = randomToken(24);
    const code = randomDigits(6);
    const link = `${env().APP_URL.replace(/\/$/, "")}/account/verify-email?token=${encodeURIComponent(token)}`;
    const ids = await this.prisma.$transaction(async tx => {
      // Only the newest link/code is valid.
      await tx.emailVerification.updateMany({ where: { userId, verifiedAt: null }, data: { expiresAt: new Date() } });
      const row = await tx.emailVerification.create({
        data: { userId, email: user.email!, tokenHash: sha256(token), codeHash: "", expiresAt: new Date(Date.now() + TTL_HOURS * 3600_000) },
      });
      await tx.emailVerification.update({ where: { id: row.id }, data: { codeHash: this.codeHash(row.id, code) } });
      await this.audit.record({ userId, name: user.name }, { action: "auth.email_verification_sent", entityType: "user", entityId: userId, data: { email: user.email } }, meta, tx);
      return this.notify.notify(tx, { event: "auth.email_verification", to: { userId, email: user.email!, name: user.name }, vars: { link, code }, channels: ["email"] });
    });
    await this.outbox.flush(ids);
    return {
      ...(await this.status(userId)),
      sent: true,
      message: `We sent a verification link to ${user.email}. It expires in ${TTL_HOURS} hours.`,
      resendAfterSeconds: RESEND_COOLDOWN_SECONDS,
      ...(env().EXPOSE_DEV_OTP ? { devCode: code, devToken: token } : {}),
    };
  }

  /** The link from the email (works without signing in). */
  async confirmToken(token: string, meta: RequestMeta) {
    const row = await this.prisma.emailVerification.findUnique({ where: { tokenHash: sha256(token) }, include: { user: { select: { email: true, name: true } } } });
    if (!row || row.user.email !== row.email) throw invalid("token");
    if (row.verifiedAt) return { ...(await this.status(row.userId)), message: "Your email address is verified." };
    if (row.expiresAt < new Date()) throw invalid("token");
    return this.markVerified(row.id, row.userId, row.user.name, meta);
  }

  /** The 6-digit code from the email (signed in). */
  async confirmCode(userId: string, code: string, meta: RequestMeta) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, name: true } });
    const row = user.email
      ? await this.prisma.emailVerification.findFirst({ where: { userId, email: user.email, verifiedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" } })
      : null;
    if (!row || !row.codeHash) throw invalid("code");
    const { count } = await this.prisma.emailVerification.updateMany({
      where: { id: row.id, verifiedAt: null, attempts: { lt: MAX_CODE_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    if (!count || !safeEqual(row.codeHash, this.codeHash(row.id, code))) throw invalid("code");
    return this.markVerified(row.id, userId, user.name, meta);
  }

  private async markVerified(id: string, userId: string, name: string, meta: RequestMeta) {
    await this.prisma.$transaction(async tx => {
      await tx.emailVerification.update({ where: { id }, data: { verifiedAt: new Date() } });
      await this.audit.record({ userId, name }, { action: "auth.email_verified", entityType: "user", entityId: userId }, meta, tx);
    });
    this.realtime.publish({ type: "account.updated", id: userId, userIds: [userId] });
    return { ...(await this.status(userId)), message: "Your email address is verified." };
  }

  private codeHash = (id: string, code: string) => sha256(`email-verification:${id}:${code}`);

  private async enforceLimits(userId: string) {
    const cooldownKey = `email-verify:cooldown:${userId}`;
    if (!(await this.redis.set(cooldownKey, "1", "EX", RESEND_COOLDOWN_SECONDS, "NX"))) {
      const ttl = await this.redis.ttl(cooldownKey);
      throw tooMany(`Please wait ${ttl > 0 ? ttl : RESEND_COOLDOWN_SECONDS} seconds before requesting another email`, ttl > 0 ? ttl : RESEND_COOLDOWN_SECONDS);
    }
    const hourKey = `email-verify:hour:${userId}`;
    const count = await this.redis.incr(hourKey);
    if (count === 1) await this.redis.expire(hourKey, 3600);
    if (count > MAX_PER_HOUR) throw tooMany("Too many verification emails requested. Try again in an hour.", await this.redis.ttl(hourKey));
  }
}
