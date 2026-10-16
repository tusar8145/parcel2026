import { HttpStatus } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { PrismaService } from "./prisma.service";
import { AppError } from "./errors";
import { Prisma } from "../generated/prisma/client";

const IN_PROGRESS = 0;

/**
 * Runs `work` once per (scope, Idempotency-Key). A retry with the same key and body gets
 * the original response; the same key with a different body is rejected. The key is
 * reserved before the work runs, so concurrent duplicates can't both execute.
 */
export async function withIdempotency<T>(
  prisma: PrismaService,
  scope: string,
  key: string | undefined,
  body: unknown,
  work: () => Promise<T>,
): Promise<T> {
  if (!key) return work();
  if (!/^[\w-]{8,100}$/.test(key)) throw new AppError("INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must be 8–100 letters, digits, - or _", 400);
  const requestHash = createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");
  const id = { scope_key: { scope, key } };

  try {
    await prisma.idempotencyRecord.create({ data: { scope, key, requestHash, statusCode: IN_PROGRESS, responseBody: {} } });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
    const existing = await prisma.idempotencyRecord.findUniqueOrThrow({ where: id });
    if (existing.requestHash !== requestHash)
      throw new AppError("IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was used with a different request", HttpStatus.UNPROCESSABLE_ENTITY);
    if (existing.statusCode === IN_PROGRESS)
      throw new AppError("IDEMPOTENT_REQUEST_IN_PROGRESS", "A request with this Idempotency-Key is still being processed", HttpStatus.CONFLICT);
    return existing.responseBody as T;
  }

  try {
    const result = await work();
    await prisma.idempotencyRecord.update({ where: id, data: { statusCode: 201, responseBody: result as Prisma.InputJsonValue } });
    return result;
  } catch (error) {
    await prisma.idempotencyRecord.delete({ where: id }).catch(() => undefined); // let the client retry
    throw error;
  }
}
