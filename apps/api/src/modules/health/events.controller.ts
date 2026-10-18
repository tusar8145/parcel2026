import { Controller, MessageEvent, Sse } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import { EMPTY, filter, from, interval, map, merge, switchMap, takeUntil, timer, type Observable } from "rxjs";
import { CurrentActor } from "../../common/auth/decorators";
import type { Actor } from "../../common/auth/actor";
import { RealtimeService } from "../../common/realtime.service";
import { TokenService } from "../../common/auth/token.service";
import { env } from "../../config/env";

/**
 * Server-Sent Events: the changes the caller may see, as they happen. Send the access token
 * in the Authorization header (browsers: fetch with a streaming body). The stream closes
 * when the token would expire; reconnect with a fresh one and reload what you show. Support
 * access streams close when the session expires or is ended (checked with each heartbeat).
 */
@ApiTags("realtime")
@SkipThrottle()
@Controller("events")
export class EventsController {
  constructor(
    private readonly realtime: RealtimeService,
    private readonly tokens: TokenService,
  ) {}

  @Sse()
  stream(@CurrentActor() actor: Actor): Observable<MessageEvent> {
    const events = this.realtime.stream.pipe(
      filter(event => this.realtime.canSee(actor, event)),
      map(event => ({ type: event.type, data: { type: event.type, id: event.id, ...(event.data ?? {}) } }) as MessageEvent),
    );
    const heartbeat = interval(25_000).pipe(map(() => ({ type: "ping", data: { at: Date.now() } }) as MessageEvent));
    const ready = timer(0).pipe(map(() => ({ type: "ready", data: { at: Date.now() } }) as MessageEvent));
    const imp = actor.kind === "user" ? actor.impersonation : undefined;
    const lifetime = Math.min(env().ACCESS_TOKEN_TTL_SECONDS * 1000, imp ? Math.max(0, Date.parse(imp.expiresAt) - Date.now()) : Infinity);
    const ended =
      imp && actor.kind === "user"
        ? interval(25_000).pipe(
            switchMap(() => from(this.tokens.isRevoked(actor.sessionId))),
            filter(Boolean),
          )
        : EMPTY;
    return merge(ready, events, heartbeat).pipe(takeUntil(merge(timer(lifetime), ended)));
  }
}
