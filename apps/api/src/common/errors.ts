import { HttpException, HttpStatus } from "@nestjs/common";

/**
 * Domain error with a stable machine-readable code. Responses look like
 * { "error": { "code": "PARCEL_NOT_CANCELLABLE", "message": "...", "details": ..., "requestId": "..." } }
 */
export class AppError extends HttpException {
  constructor(
    readonly code: string,
    message: string,
    status: HttpStatus = HttpStatus.BAD_REQUEST,
    readonly details?: unknown,
  ) {
    super({ code, message, details }, status);
  }
}

export const notFound = (what: string) => new AppError("NOT_FOUND", `${what} was not found`, HttpStatus.NOT_FOUND);
export const forbidden = (message = "You don't have access to this") =>
  new AppError("FORBIDDEN", message, HttpStatus.FORBIDDEN);
export const conflict = (code: string, message: string) => new AppError(code, message, HttpStatus.CONFLICT);
export const unauthorized = (code = "UNAUTHENTICATED", message = "Sign in to continue") =>
  new AppError(code, message, HttpStatus.UNAUTHORIZED);
export const tooMany = (message: string, retryAfterSeconds?: number) =>
  new AppError("RATE_LIMITED", message, HttpStatus.TOO_MANY_REQUESTS, retryAfterSeconds ? { retryAfterSeconds } : undefined);
