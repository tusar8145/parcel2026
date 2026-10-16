import { HttpStatus, Injectable } from "@nestjs/common";
import { createHmac } from "node:crypto";
import { isCustomerCancellable, type CreateParcelInput, type ParcelStatus } from "@delivery-fast/shared";
import { PrismaService } from "../../common/prisma.service";
import { RedisService } from "../../common/redis.service";
import { randomDigits, safeEqual, sha256 } from "../../common/crypto";
import { AppError, notFound, tooMany } from "../../common/errors";
import type { RequestMeta } from "../../common/auth/decorators";
import { env } from "../../config/env";
import { NotifyService } from "../notifications/notify.service";
import { OutboxService } from "../notifications/outbox.service";
import { ParcelsService } from "./parcels.service";
import { ParcelWorkflowService } from "./parcel-workflow.service";
import { parcelView } from "./parcel.views";
import { signParcelAccess, trackingUrl, verifyParcelAccess, type ParcelAccessScope } from "./parcel-access";

const CODE_TTL_SECONDS = 10 * 60;
const VERIFIED_TTL_SECONDS = 30 * 60; // time to finish the booking after verifying
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 60;
const MAX_PER_PHONE_PER_HOUR = 5;
const MAX_PER_IP_PER_HOUR = 20;

const invalidCode = () =>
  new AppError("INVALID_CODE", "That code is incorrect or has expired. Request a new one.", HttpStatus.BAD_REQUEST, [
    { path: "code", message: "That code is incorrect or has expired. Request a new one." },
  ]);
const invalidVerification = () =>
  new AppError("GUEST_VERIFICATION_REQUIRED", "Verify your phone number again to book.", HttpStatus.UNAUTHORIZED, [
    { path: "verificationToken", message: "Verify your phone number again to book." },
  ]);

const tokenKey = () => createHmac("sha256", env().JWT_ACCESS_SECRET).update("guest-verification:v1").digest();
const signVerification = (id: string, exp: string) => createHmac("sha256", tokenKey()).update(`${id}|${exp}`).digest("base64url").slice(0, 32);

/**
 * Booking without an account: the sender verifies their phone with an SMS code
 * (event guest.booking_verification), then books once with the verification token.
 * The guest gets a tracking link with a signed token (view the full timeline, cancel
 * while pending, leave feedback).
 */
@Injectable()
export class GuestBookingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly notify: NotifyService,
    private readonly outbox: OutboxService,
    private readonly parcels: ParcelsService,
    private readonly workflow: ParcelWorkflowService,
  ) {}

  async requestCode(phone: string, meta: RequestMeta) {
    await this.enforceLimits(phone, meta.ip);
    const code = randomDigits(6);
    const verification = await this.prisma.guestVerification.create({
      data: { phone, codeHash: "", ip: meta.ip, expiresAt: new Date(Date.now() + CODE_TTL_SECONDS * 1000) },
    });
    await this.prisma.guestVerification.update({ where: { id: verification.id }, data: { codeHash: this.hash(verification.id, code) } });
    const ids = await this.notify.notify(this.prisma, {
      event: "guest.booking_verification",
      to: { phone },
      vars: { code, minutes: CODE_TTL_SECONDS / 60 },
      channels: ["sms"],
    });
    await this.outbox.flush(ids);
    return {
      message: "We sent a 6-digit code to your phone. It expires in 10 minutes.",
      expiresInSeconds: CODE_TTL_SECONDS,
      resendAfterSeconds: RESEND_COOLDOWN_SECONDS,
      ...(env().EXPOSE_DEV_OTP ? { devCode: code } : {}),
    };
  }

  /** Checks the code; returns a short-lived token for one booking with this phone. */
  async confirm(phone: string, code: string) {
    const verification = await this.prisma.guestVerification.findFirst({
      where: { phone, verifiedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });
    if (!verification || verification.attempts >= MAX_ATTEMPTS || !verification.codeHash) throw invalidCode();
    const { count } = await this.prisma.guestVerification.updateMany({
      where: { id: verification.id, attempts: { lt: MAX_ATTEMPTS }, verifiedAt: null },
      data: { attempts: { increment: 1 } },
    });
    if (!count || !safeEqual(verification.codeHash, this.hash(verification.id, code))) throw invalidCode();
    const verifiedAt = new Date();
    await this.prisma.guestVerification.update({ where: { id: verification.id }, data: { verifiedAt } });
    const expiresAt = new Date(verifiedAt.getTime() + VERIFIED_TTL_SECONDS * 1000);
    const exp = Math.floor(expiresAt.getTime() / 1000).toString(36);
    return { verificationToken: `${verification.id}.${exp}.${signVerification(verification.id, exp)}`, phone, expiresAt };
  }

  /** The verification a token refers to, or an error. */
  async verificationFor(token: string | undefined) {
    const [id, exp, sig] = (token ?? "").split(".");
    if (!id || !exp || !sig || !/^[0-9a-f-]{36}$/.test(id) || !/^[0-9a-z]{1,10}$/.test(exp)) throw invalidVerification();
    if (!safeEqual(sig, signVerification(id, exp)) || parseInt(exp, 36) * 1000 < Date.now()) throw invalidVerification();
    const verification = await this.prisma.guestVerification.findUnique({ where: { id } });
    if (!verification?.verifiedAt) throw invalidVerification();
    if (verification.usedAt)
      throw new AppError("GUEST_VERIFICATION_USED", "This verification was already used for a booking. Verify your phone again to book another parcel.", HttpStatus.CONFLICT, [
        { path: "verificationToken", message: "Verify your phone again to book another parcel." },
      ]);
    return verification;
  }

  async book(token: string | undefined, input: CreateParcelInput, meta: RequestMeta) {
    const verification = await this.verificationFor(token);
    if (verification.phone !== input.sender.phone) {
      const message = "Use the phone number you verified, or verify this number.";
      throw new AppError("VALIDATION_FAILED", "Some fields need attention", HttpStatus.UNPROCESSABLE_ENTITY, [{ path: "sender.phone", message }]);
    }
    const parcel = await this.parcels.createForGuest({ ...input, saveAddresses: false }, meta, async (tx, created) => {
      const { count } = await tx.guestVerification.updateMany({ where: { id: verification.id, usedAt: null }, data: { usedAt: new Date(), parcelId: created.id } });
      if (!count) throw new AppError("GUEST_VERIFICATION_USED", "This verification was already used for a booking.", HttpStatus.CONFLICT);
    });
    const accessToken = signParcelAccess(parcel.trackingId, "owner");
    return {
      trackingId: parcel.trackingId,
      accessToken,
      trackingUrl: trackingUrl(parcel.trackingId, accessToken),
      parcel: await this.fullView(parcel.trackingId, accessToken),
    };
  }

  /** Full timeline for the holder of a guest-booking or feedback link. */
  async fullView(trackingId: string, token: string | undefined) {
    const parcel = await this.parcels.findByTrackingId(trackingId);
    const scope = this.requireScope(parcel.trackingId, token);
    const feedback = await this.prisma.parcelFeedback.findUnique({ where: { parcelId: parcel.id }, select: { rating: true, comment: true, createdAt: true } });
    const view = parcelView(parcel, { internal: false });
    return {
      ...view,
      // Only the guest who booked may cancel with a link; a feedback link is read-only.
      canCancel: scope === "owner" && view.canCancel,
      access: scope,
      feedback,
      canGiveFeedback: parcel.status === "DELIVERED" && !feedback,
    };
  }

  async cancel(trackingId: string, token: string, reason: string | undefined, meta: RequestMeta) {
    const found = await this.parcels.findByTrackingId(trackingId);
    if (this.requireScope(found.trackingId, token) !== "owner") throw new AppError("FORBIDDEN", "This link can't cancel the booking", HttpStatus.FORBIDDEN);
    const after = this.workflow.newAfterCommit();
    await this.prisma.$transaction(async tx => {
      const parcel = await tx.parcel.findUniqueOrThrow({ where: { id: found.id } });
      if (!isCustomerCancellable(parcel.status as ParcelStatus))
        throw new AppError("NOT_CANCELLABLE", "This request can no longer be cancelled online because operations already confirmed it. Contact support.", HttpStatus.CONFLICT);
      await this.workflow.transition(
        tx,
        parcel,
        {
          to: "PICKUP_CANCELLED",
          actorRole: "owner",
          data: { cancelledAt: new Date(), cancelReason: reason },
          title: "Pickup request cancelled",
          description: reason ?? "The sender cancelled the request before confirmation.",
          location: "Customer",
        },
        "system",
        meta,
        after,
      );
    });
    await this.workflow.flush(after);
    return this.fullView(found.trackingId, token);
  }

  private requireScope(trackingId: string, token: string | undefined): ParcelAccessScope {
    const scope = verifyParcelAccess(trackingId, token);
    // Same answer as an unknown parcel, so links can't be probed.
    if (!scope) throw notFound("Parcel");
    return scope;
  }

  private hash = (id: string, code: string) => sha256(`guest:${id}:${code}`);

  private async enforceLimits(phone: string, ip: string) {
    const cooldownKey = `guest-otp:cooldown:${phone}`;
    if (!(await this.redis.set(cooldownKey, "1", "EX", RESEND_COOLDOWN_SECONDS, "NX"))) {
      const ttl = await this.redis.ttl(cooldownKey);
      throw tooMany(`Please wait ${ttl > 0 ? ttl : RESEND_COOLDOWN_SECONDS} seconds before requesting another code`, ttl > 0 ? ttl : RESEND_COOLDOWN_SECONDS);
    }
    for (const [key, max] of [
      [`guest-otp:hour:phone:${phone}`, MAX_PER_PHONE_PER_HOUR],
      [`guest-otp:hour:ip:${ip}`, MAX_PER_IP_PER_HOUR],
    ] as const) {
      const count = await this.redis.incr(key);
      if (count === 1) await this.redis.expire(key, 3600);
      if (count > max) throw tooMany("Too many codes requested. Try again in an hour.", await this.redis.ttl(key));
    }
  }
}
