import { Controller, MessageEvent, Sse } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import { filter, interval, map, merge, takeUntil, timer, type Observable } from "rxjs";
import { CurrentActor } from "../../common/auth/decorators";
import type { Actor } from "../../common/auth/actor";
import { RealtimeService } from "../../common/realtime.service";
import { env } from "../../config/env";

/**
 * Server-Sent Events: the changes the caller may see, as they happen. Send the access token
 * in the Authorization header (browsers: fetch with a streaming body). The stream closes
 * when the token would expire; reconnect with a fresh one and reload what you show.
 */
@ApiTags("realtime")
@SkipThrottle()
@Controller("events")
export class EventsController {
  constructor(private readonly realtime: RealtimeService) {}

  @Sse()
  stream(@CurrentActor() actor: Actor): Observable<MessageEvent> {
    const events = this.realtime.stream.pipe(
      filter(event => this.realtime.canSee(actor, event)),
      map(event => ({ type: event.type, data: { type: event.type, id: event.id, ...(event.data ?? {}) } }) as MessageEvent),
    );
    const heartbeat = interval(25_000).pipe(map(() => ({ type: "ping", data: { at: Date.now() } }) as MessageEvent));
    const ready = timer(0).pipe(map(() => ({ type: "ready", data: { at: Date.now() } }) as MessageEvent));
    return merge(ready, events, heartbeat).pipe(takeUntil(timer(env().ACCESS_TOKEN_TTL_SECONDS * 1000)));
  }
}
