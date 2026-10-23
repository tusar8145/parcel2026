import { AsyncLocalStorage } from "node:async_hooks";
import { HttpStatus, Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from "@nestjs/common";
import { Observable, throwError } from "rxjs";
import type { Actor } from "./auth/actor";
import { withAuditContext } from "./audit.service";
import { AppError } from "./errors";

/** The header the Scan desk sends with every entry: the date & time the operation happened. */
export const OPERATION_TIME_HEADER = "x-operation-time";
/** How far back an entry may be dated (paper slips entered later), and the clock drift allowed ahead. */
export const OPERATION_TIME_MAX_AGE_DAYS = 30;
const AHEAD_MS = 5 * 60_000;

const operationTime = new AsyncLocalStorage<Date>();

/**
 * "Now" for an operation: the time chosen on the Scan desk for this request, else the real time.
 * Use it for the timestamps an operation records (tracking events, deliveredAt, COD collected…),
 * not for expiry checks or bookkeeping of the request itself.
 */
export const operationNow = (): Date => new Date(operationTime.getStore()?.getTime() ?? Date.now());

/** The chosen time when one was sent (undefined for live entries). */
export const chosenOperationTime = (): Date | undefined => operationTime.getStore();

/** Runs `work` as if it happened at `at` (tests, jobs). */
export const atOperationTime = <T>(at: Date, work: () => T): T => operationTime.run(at, work);

/** Reads and checks the header: a staff member's mutation, not in the future, at most 30 days back. */
export function parseOperationTime(value: unknown, actor: Actor | undefined, now = Date.now()): Date | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const at = new Date(value.trim());
  if (Number.isNaN(at.getTime())) throw new AppError("INVALID_OPERATION_TIME", "The operation date & time isn't a valid date.", HttpStatus.BAD_REQUEST);
  if (!actor || actor.kind !== "user" || !actor.permissions.has("parcel:dispatch"))
    throw new AppError("OPERATION_TIME_NOT_ALLOWED", "Only operations staff can record an entry at another time.", HttpStatus.FORBIDDEN);
  if (at.getTime() > now + AHEAD_MS) throw new AppError("OPERATION_TIME_IN_FUTURE", "The operation date & time can't be in the future.", HttpStatus.BAD_REQUEST);
  if (at.getTime() < now - OPERATION_TIME_MAX_AGE_DAYS * 86_400_000)
    throw new AppError("OPERATION_TIME_TOO_OLD", `The operation date & time can be at most ${OPERATION_TIME_MAX_AGE_DAYS} days back.`, HttpStatus.BAD_REQUEST);
  // A time a few seconds ahead (clocks differ) is recorded as now.
  return at.getTime() > now ? new Date(now) : at;
}

/**
 * Global: a mutation with `X-Operation-Time` runs with that time as `operationNow()`, and its audit
 * records keep it (`operationAt`) beside their real creation time.
 */
@Injectable()
export class OperationTimeInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== "http") return next.handle();
    const req = ctx.switchToHttp().getRequest<{ method: string; headers: Record<string, unknown>; actor?: Actor }>();
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next.handle();
    let at: Date | undefined;
    try {
      at = parseOperationTime(req.headers[OPERATION_TIME_HEADER], req.actor);
    } catch (error) {
      return throwError(() => error);
    }
    if (!at) return next.handle();
    const chosen = at;
    // The handler runs when the observable is subscribed: subscribe inside the stores.
    return new Observable(subscriber => {
      operationTime.run(chosen, () =>
        withAuditContext({ operationAt: chosen.toISOString() }, async () => {
          subscriber.add(next.handle().subscribe(subscriber));
        }),
      );
    });
  }
}
