import { Injectable } from "@nestjs/common";
import type { OtpPurpose } from "@delivery-fast/shared";
import { PrismaService } from "../../common/prisma.service";
import { RedisService } from "../../common/redis.service";
import { NotifyService } from "../notifications/notify.service";
import { NotificationSettingsService } from "../notifications/notification-settings.service";
import type { NotificationEvent } from "../notifications/events";
import { randomDigits, safeEqual, sha256 } from "../../common/crypto";
import { AppError, tooMany } from "../../common/errors";
import { env } from "../../config/env";

const OTP_TTL_SECONDS = 5 * 60;
const MAX_VERIFY_ATTEMPTS = 5;

const EVENTS: Record<OtpPurpose, NotificationEvent> = {
  SIGNUP: "auth.otp.signup",
  LOGIN: "auth.otp.login",
  PASSWORD_RESET: "auth.otp.password_reset",
};

/**
 * One-time codes by SMS. Limits (resend cooldown, per phone / per IP per hour) are editable
 * in super admin → Notifications; a 429 carries `details.retryAfterSeconds` (and a Retry-After
 * header) so the UI can show a countdown, and successful requests return `resendAfterSeconds`.
 */
@Injectable()
export class OtpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly notifications: NotifyService,
    private readonly settings: NotificationSettingsService,
  ) {}

  /** Seconds a client must wait between code requests for the same number. */
  async cooldownSeconds() {
    return (await this.settings.limits()).otp.cooldownSeconds;
  }

  /** Rate-limited; returns the code only when EXPOSE_DEV_OTP is on (never in production). */
  async issue(phone: string, purpose: OtpPurpose, ip: string): Promise<{ devCode?: string; resendAfterSeconds: number; expiresInSeconds: number }> {
    const cooldown = await this.enforceLimits(phone, purpose, ip);
    const code = randomDigits(6);
    const challenge = await this.prisma.otpChallenge.create({
      data: { phone, purpose, codeHash: "", ip, expiresAt: new Date(Date.now() + OTP_TTL_SECONDS * 1000) },
    });
    await this.prisma.otpChallenge.update({ where: { id: challenge.id }, data: { codeHash: this.hash(challenge.id, code) } });
    await this.notifications.notifyNow({ event: EVENTS[purpose], to: { phone }, vars: { code, minutes: OTP_TTL_SECONDS / 60 }, channels: ["sms"] });
    return { resendAfterSeconds: cooldown, expiresInSeconds: OTP_TTL_SECONDS, ...(env().EXPOSE_DEV_OTP ? { devCode: code } : {}) };
  }

  /**
   * Sends an informational SMS without a code, under the same limits as a code request
   * (e.g. "this number already has an account" when someone tries to sign up again).
   */
  async notify(phone: string, purpose: OtpPurpose, ip: string, event: NotificationEvent = "auth.signup_existing_account") {
    const cooldown = await this.enforceLimits(phone, purpose, ip);
    await this.notifications.notifyNow({ event, to: { phone }, channels: ["sms"] });
    return { resendAfterSeconds: cooldown };
  }

  /** Consumes the latest valid challenge. Throws a generic error on any failure. */
  async verify(phone: string, purpose: OtpPurpose, code: string): Promise<void> {
    const invalid = () => new AppError("INVALID_CODE", "That code is incorrect or has expired. Request a new one.", 400);
    const challenge = await this.prisma.otpChallenge.findFirst({
      where: { phone, purpose, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });
    if (!challenge || challenge.attempts >= MAX_VERIFY_ATTEMPTS || !challenge.codeHash) throw invalid();
    // Count the attempt first so parallel guesses can't exceed the limit.
    const { count } = await this.prisma.otpChallenge.updateMany({
      where: { id: challenge.id, attempts: { lt: MAX_VERIFY_ATTEMPTS }, consumedAt: null },
      data: { attempts: { increment: 1 } },
    });
    if (!count || !safeEqual(challenge.codeHash, this.hash(challenge.id, code))) throw invalid();
    const consumed = await this.prisma.otpChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (!consumed.count) throw invalid();
  }

  private hash = (challengeId: string, code: string) => sha256(`${challengeId}:${code}`);

  /** Returns the cooldown applied, or throws 429 with retryAfterSeconds. */
  private async enforceLimits(phone: string, purpose: OtpPurpose, ip: string): Promise<number> {
    const { cooldownSeconds, perPhonePerHour, perIpPerHour } = (await this.settings.limits()).otp;
    const cooldownKey = `otp:cooldown:${purpose}:${phone}`;
    if (!(await this.redis.set(cooldownKey, "1", "EX", cooldownSeconds, "NX"))) {
      const ttl = await this.redis.ttl(cooldownKey);
      const wait = ttl > 0 ? ttl : cooldownSeconds;
      throw tooMany(`Please wait ${wait} seconds before requesting another code`, wait);
    }
    for (const [key, max] of [
      [`otp:hour:phone:${phone}`, perPhonePerHour],
      [`otp:hour:ip:${ip}`, perIpPerHour],
    ] as const) {
      const count = await this.redis.incr(key);
      if (count === 1) await this.redis.expire(key, 3600);
      if (count > max) {
        const ttl = await this.redis.ttl(key);
        throw tooMany("Too many codes requested. Try again later.", ttl > 0 ? ttl : 3600);
      }
    }
    return cooldownSeconds;
  }
}
