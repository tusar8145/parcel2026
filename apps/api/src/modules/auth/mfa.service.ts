import { HttpStatus, Injectable } from "@nestjs/common";
import { authenticator } from "otplib";
import QRCode from "qrcode";
import { randomInt } from "node:crypto";
import { MFA_REQUIRED_ROLES, type Role } from "@paira-express/shared";
import { PrismaService } from "../../common/prisma.service";
import { RedisService } from "../../common/redis.service";
import { AuditService } from "../../common/audit.service";
import { decrypt, encrypt, randomToken, safeEqual, sha256 } from "../../common/crypto";
import { AppError, conflict, unauthorized } from "../../common/errors";
import type { RequestMeta } from "../../common/auth/decorators";

/** RFC 6238: 30-second steps, 6 digits, SHA-1 (what authenticator apps expect); ±1 step for clock drift. */
const totp = authenticator.clone({ step: 30, window: 1, digits: 6 });
const ISSUER = "Paira Express";

const LOGIN_CHALLENGE_TTL_SECONDS = 10 * 60;
const SETUP_CHALLENGE_TTL_SECONDS = 15 * 60;
const PENDING_SECRET_TTL_MS = 15 * 60_000;
/** Wrong codes per sign-in challenge before the challenge is thrown away. */
const MAX_CHALLENGE_ATTEMPTS = 5;
/** Wrong codes in a row (any challenge) before MFA sign-in locks for LOCK_MINUTES. */
const MAX_FAILED_CODES = 10;
const LOCK_MINUTES = 15;
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I

export type MfaPurpose = "login" | "setup";
export interface MfaChallenge {
  userId: string;
  purpose: MfaPurpose;
  /** How the first factor was proven (password or SMS code). */
  method: "password" | "otp";
}

export const mfaRequiredFor = (roles: readonly Role[]) => roles.some(r => MFA_REQUIRED_ROLES.includes(r));

const invalidCode = () => new AppError("INVALID_MFA_CODE", "That code isn't right. Enter the current 6-digit code from your authenticator app, or a recovery code.", HttpStatus.BAD_REQUEST);
const normalizeRecovery = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * TOTP two-step verification: enrolment (QR + confirmation), verification with replay
 * protection, single-use recovery codes (hashed), and lockout after repeated wrong codes.
 * Sign-in challenges ("mfaToken") are opaque random tokens kept in Redis, never sessions.
 */
@Injectable()
export class MfaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
  ) {}

  // ───────────── sign-in challenges ─────────────

  async createChallenge(challenge: MfaChallenge): Promise<string> {
    const token = randomToken(32);
    const ttl = challenge.purpose === "setup" ? SETUP_CHALLENGE_TTL_SECONDS : LOGIN_CHALLENGE_TTL_SECONDS;
    await this.redis.set(this.challengeKey(token), JSON.stringify(challenge), "EX", ttl);
    return token;
  }

  async readChallenge(token: string, purposes: MfaPurpose[]): Promise<MfaChallenge> {
    const raw = typeof token === "string" && token.length < 200 ? await this.redis.get(this.challengeKey(token)) : null;
    const challenge = raw ? (JSON.parse(raw) as MfaChallenge) : null;
    if (!challenge || !purposes.includes(challenge.purpose)) throw unauthorized("MFA_TOKEN_INVALID", "Your sign-in expired. Please sign in again.");
    return challenge;
  }

  /** Counts a wrong code against the challenge; too many and the challenge is gone. */
  async failChallenge(token: string) {
    const key = `${this.challengeKey(token)}:attempts`;
    const attempts = await this.redis.incr(key);
    if (attempts === 1) await this.redis.expire(key, SETUP_CHALLENGE_TTL_SECONDS);
    if (attempts >= MAX_CHALLENGE_ATTEMPTS) {
      await this.redis.del(this.challengeKey(token), key);
      return true;
    }
    return false;
  }

  async consumeChallenge(token: string) {
    await this.redis.del(this.challengeKey(token), `${this.challengeKey(token)}:attempts`);
  }

  private challengeKey = (token: string) => `mfa:challenge:${sha256(token)}`;

  // ───────────── status and enrolment ─────────────

  async status(userId: string) {
    const [mfa, user, remaining] = await Promise.all([
      this.prisma.userMfa.findUnique({ where: { userId } }),
      this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { roles: { select: { role: true } } } }),
      this.prisma.mfaRecoveryCode.count({ where: { userId, usedAt: null } }),
    ]);
    return {
      enabled: !!mfa?.enabledAt,
      enabledAt: mfa?.enabledAt ?? null,
      required: mfaRequiredFor(user.roles.map(r => r.role)),
      recoveryCodesRemaining: mfa?.enabledAt ? remaining : 0,
      lockedUntil: mfa?.lockedUntil && mfa.lockedUntil > new Date() ? mfa.lockedUntil : null,
    };
  }

  /** Starts (or restarts) enrolment: a new secret waits for its first code. */
  async setup(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, phone: true, mfa: { select: { enabledAt: true } } } });
    if (user.mfa?.enabledAt) throw conflict("MFA_ALREADY_ENABLED", "Two-step verification is already on. Turn it off first to set up a new device.");
    const secret = totp.generateSecret(20); // 160 bits, base32
    const otpauthUrl = totp.keyuri(user.email ?? user.phone, ISSUER, secret);
    await this.prisma.userMfa.upsert({
      where: { userId },
      create: { userId, pendingSecretEncrypted: encrypt(secret), pendingCreatedAt: new Date() },
      update: { pendingSecretEncrypted: encrypt(secret), pendingCreatedAt: new Date() },
    });
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { errorCorrectionLevel: "M", margin: 1, width: 220 });
    return { otpauthUrl, qrDataUrl, secret };
  }

  /** Confirms enrolment with the first code; returns the recovery codes (shown once). */
  async enable(userId: string, code: string, meta: RequestMeta): Promise<string[]> {
    const mfa = await this.prisma.userMfa.findUnique({ where: { userId } });
    if (mfa?.enabledAt) throw conflict("MFA_ALREADY_ENABLED", "Two-step verification is already on");
    if (!mfa?.pendingSecretEncrypted || !mfa.pendingCreatedAt || Date.now() - mfa.pendingCreatedAt.getTime() > PENDING_SECRET_TTL_MS)
      throw new AppError("MFA_SETUP_EXPIRED", "Start the setup again: scan a new QR code", HttpStatus.BAD_REQUEST);
    await this.assertNotLocked(mfa.lockedUntil);
    const secret = decrypt(mfa.pendingSecretEncrypted);
    const step = this.matchStep(code, secret);
    if (step === null) {
      await this.recordFailure(userId, meta);
      throw invalidCode();
    }
    const codes = this.newRecoveryCodes();
    await this.prisma.$transaction(async tx => {
      await tx.userMfa.update({
        where: { userId },
        data: { secretEncrypted: mfa.pendingSecretEncrypted, pendingSecretEncrypted: null, pendingCreatedAt: null, enabledAt: new Date(), lastUsedStep: step, failedCount: 0, lockedUntil: null },
      });
      await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
      await tx.mfaRecoveryCode.createMany({ data: codes.map(c => ({ userId, codeHash: this.recoveryHash(userId, c) })) });
      await this.audit.record({ userId, name: await this.nameOf(userId) }, { action: "auth.mfa_enabled", entityType: "user", entityId: userId }, meta, tx);
    });
    return codes;
  }

  /**
   * Checks a TOTP code (or, if allowed, a recovery code, which is then used up). Wrong codes
   * count towards the lockout. Returns how the user verified.
   */
  async verify(userId: string, code: string, meta: RequestMeta, { allowRecovery = true } = {}): Promise<"totp" | "recovery"> {
    const mfa = await this.prisma.userMfa.findUnique({ where: { userId } });
    if (!mfa?.enabledAt || !mfa.secretEncrypted) throw new AppError("MFA_NOT_ENABLED", "Two-step verification isn't set up for this account", HttpStatus.BAD_REQUEST);
    await this.assertNotLocked(mfa.lockedUntil);
    const value = String(code ?? "").trim();
    if (/^\d{6}$/.test(value)) {
      const step = this.matchStep(value, decrypt(mfa.secretEncrypted));
      if (step !== null) {
        // Atomic: a code (time step) is accepted once, even under concurrent requests.
        const { count } = await this.prisma.userMfa.updateMany({
          where: { userId, OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: step } }] },
          data: { lastUsedStep: step, failedCount: 0 },
        });
        if (count) return "totp";
      }
    } else if (allowRecovery && normalizeRecovery(value).length === 10) {
      const hash = this.recoveryHash(userId, normalizeRecovery(value));
      const row = await this.prisma.mfaRecoveryCode.findFirst({ where: { userId, codeHash: hash, usedAt: null } });
      if (row && safeEqual(row.codeHash, hash)) {
        const { count } = await this.prisma.mfaRecoveryCode.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
        if (count) {
          await this.prisma.userMfa.update({ where: { userId }, data: { failedCount: 0 } });
          await this.audit.record({ userId, name: await this.nameOf(userId) }, { action: "auth.mfa_recovery_code_used", entityType: "user", entityId: userId }, meta);
          return "recovery";
        }
      }
    }
    await this.recordFailure(userId, meta);
    throw invalidCode();
  }

  async regenerateRecoveryCodes(userId: string, meta: RequestMeta) {
    const codes = this.newRecoveryCodes();
    await this.prisma.$transaction(async tx => {
      await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
      await tx.mfaRecoveryCode.createMany({ data: codes.map(c => ({ userId, codeHash: this.recoveryHash(userId, c) })) });
      await this.audit.record({ userId, name: await this.nameOf(userId) }, { action: "auth.mfa_recovery_codes_regenerated", entityType: "user", entityId: userId }, meta, tx);
    });
    return codes;
  }

  /** Removes the secret and recovery codes (caller audits and revokes sessions). */
  async remove(userId: string) {
    await this.prisma.$transaction([this.prisma.mfaRecoveryCode.deleteMany({ where: { userId } }), this.prisma.userMfa.deleteMany({ where: { userId } })]);
  }

  // ───────────── internals ─────────────

  /** The accepted time step for this code, or null. */
  private matchStep(code: string, secret: string): number | null {
    if (!/^\d{6}$/.test(String(code ?? "").trim())) return null;
    const delta = totp.checkDelta(String(code).trim(), secret);
    if (delta === null) return null;
    return Math.floor(Date.now() / 1000 / 30) + delta;
  }

  private async assertNotLocked(lockedUntil: Date | null) {
    if (lockedUntil && lockedUntil > new Date()) {
      const minutes = Math.ceil((lockedUntil.getTime() - Date.now()) / 60_000);
      throw new AppError("MFA_LOCKED", `Too many wrong codes. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`, HttpStatus.TOO_MANY_REQUESTS, {
        retryAfterSeconds: Math.ceil((lockedUntil.getTime() - Date.now()) / 1000),
      });
    }
  }

  private async recordFailure(userId: string, meta: RequestMeta) {
    const updated = await this.prisma.userMfa.update({ where: { userId }, data: { failedCount: { increment: 1 } }, select: { failedCount: true } });
    const locked = updated.failedCount >= MAX_FAILED_CODES;
    if (locked) await this.prisma.userMfa.update({ where: { userId }, data: { failedCount: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) } });
    await this.audit.record(
      { userId, name: await this.nameOf(userId) },
      { action: locked ? "auth.mfa_locked" : "auth.mfa_failed", entityType: "user", entityId: userId },
      meta,
    );
    if (locked) await this.assertNotLocked(new Date(Date.now() + LOCK_MINUTES * 60_000));
  }

  private newRecoveryCodes(): string[] {
    return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
      const raw = Array.from({ length: 10 }, () => RECOVERY_ALPHABET[randomInt(0, RECOVERY_ALPHABET.length)]).join("");
      return `${raw.slice(0, 5)}-${raw.slice(5)}`;
    });
  }

  private recoveryHash = (userId: string, code: string) => sha256(`mfa-recovery:${userId}:${normalizeRecovery(code)}`);

  private async nameOf(userId: string) {
    return (await this.prisma.user.findUnique({ where: { id: userId }, select: { name: true } }))?.name ?? "User";
  }
}
