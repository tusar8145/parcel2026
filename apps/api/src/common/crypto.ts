import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
import { env } from "../config/env";

export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** URL-safe random token with the given number of random bytes. */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

export const randomDigits = (length: number) =>
  Array.from({ length }, () => randomInt(0, 10)).join("");

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// Argon2id, OWASP-recommended parameters (19 MiB, 2 iterations).
const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
export const hashPassword = (password: string) => argonHash(password, ARGON);
export const verifyPassword = (hash: string, password: string) => argonVerify(hash, password).catch(() => false);

/** A real hash to verify against when the user doesn't exist, so timing doesn't reveal it. */
let dummyHash: Promise<string> | undefined;
export const dummyPasswordHash = () => (dummyHash ??= hashPassword(randomToken()));

// AES-256-GCM for secrets we must read back (webhook signing secrets).
const key = () => Buffer.from(env().ENCRYPTION_KEY, "base64");

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(".");
}

export function decrypt(payload: string): string {
  const [version, iv, tag, data] = payload.split(".");
  if (version !== "v1") throw new Error("Unknown ciphertext version");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

export const hmacSha256 = (secret: string, payload: string) => createHmac("sha256", secret).update(payload).digest("hex");
