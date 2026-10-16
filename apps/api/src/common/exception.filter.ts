import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { Prisma } from "../generated/prisma/client";
import { isProduction } from "../config/env";

const STATUS_CODES: Record<number, string> = {
  400: "BAD_REQUEST",
  401: "UNAUTHENTICATED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  405: "METHOD_NOT_ALLOWED",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  422: "VALIDATION_FAILED",
  429: "RATE_LIMITED",
};

/** Turns every error into the same JSON shape and never leaks internals on 5xx. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger("Exceptions");

  catch(exception: unknown, host: ArgumentsHost) {
    const request = host.switchToHttp().getRequest<FastifyRequest>();
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const { status, body } = this.toResponse(exception);
    if (status >= 500) this.logger.error({ err: exception, reqId: request.id }, "Unhandled error");
    const retryAfter = (body.details as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
    if (status === 429 && typeof retryAfter === "number" && retryAfter > 0) reply.header("retry-after", String(Math.ceil(retryAfter)));
    reply.status(status).send({ error: { ...body, requestId: request.id } });
  }

  private toResponse(exception: unknown): { status: number; body: { code: string; message: string; details?: unknown } } {
    if (exception instanceof ZodError) {
      return {
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        body: {
          code: "VALIDATION_FAILED",
          message: "Some fields need attention",
          details: exception.issues.map(i => ({ path: i.path.join("."), message: i.message })),
        },
      };
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === "P2002")
        return { status: 409, body: { code: "ALREADY_EXISTS", message: "A record with these details already exists" } };
      if (exception.code === "P2025") return { status: 404, body: { code: "NOT_FOUND", message: "Record not found" } };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === "object" && res && "code" in res) {
        const { code, message, details } = res as { code: string; message: string; details?: unknown };
        return { status, body: { code, message, details } };
      }
      const message = typeof res === "string" ? res : ((res as { message?: string | string[] }).message ?? exception.message);
      return { status, body: { code: STATUS_CODES[status] ?? "ERROR", message: Array.isArray(message) ? message.join("; ") : message } };
    }
    return {
      status: 500,
      body: {
        code: "INTERNAL_ERROR",
        message: "Something went wrong. Please try again.",
        // Outside production, show the cause to speed up debugging.
        ...(isProduction() ? {} : { details: { debug: String((exception as Error)?.message ?? exception).slice(0, 2000) } }),
      },
    };
  }
}
