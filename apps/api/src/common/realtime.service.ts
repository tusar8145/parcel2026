import { Global, Injectable, Logger, Module, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import Redis from "ioredis";
import { Subject, type Observable } from "rxjs";
import { env } from "../config/env";
import { merchantIdsOf, type Actor } from "./auth/actor";

/**
 * A change other people's screens should reflect right away. Only ids and the fields
 * needed to decide who may see it travel here; clients reload the details through the API.
 */
export interface RealtimeEvent {
  type: string; // "parcel.updated", "parcel.created", "ticket.updated", …
  id?: string; // tracking ID, ticket number…
  merchantId?: string | null;
  customerId?: string | null;
  riderIds?: (string | null | undefined)[];
  hubIds?: (string | null | undefined)[];
  userIds?: (string | null | undefined)[]; // explicit recipients (e.g. a ticket's requester)
  /** Staff permission that sees every event of this kind (default parcel:read:any). */
  staffPermission?: string;
  data?: Record<string, unknown>;
}

const CHANNEL = () => `df:${env().NODE_ENV}:events`;

/**
 * Publishes through Redis so every API instance can push to its own connected clients
 * (GET /events). Delivery is best effort: clients also refresh on reconnect.
 */
@Injectable()
export class RealtimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeService.name);
  private readonly events$ = new Subject<RealtimeEvent>();
  private publisher?: Redis;
  private subscriber?: Redis;

  onModuleInit() {
    this.publisher = new Redis(env().REDIS_URL, { maxRetriesPerRequest: 2 });
    this.subscriber = new Redis(env().REDIS_URL, { maxRetriesPerRequest: null });
    void this.subscriber.subscribe(CHANNEL()).catch(err => this.logger.error({ err }, "Realtime subscribe failed"));
    this.subscriber.on("message", (_channel, message) => {
      try {
        this.events$.next(JSON.parse(message) as RealtimeEvent);
      } catch {
        /* ignore malformed */
      }
    });
  }

  async onModuleDestroy() {
    this.events$.complete();
    await Promise.all([this.publisher?.quit().catch(() => undefined), this.subscriber?.quit().catch(() => undefined)]);
  }

  /** Call after the change has committed. Never throws. */
  publish(...events: RealtimeEvent[]) {
    for (const event of events) {
      void this.publisher?.publish(CHANNEL(), JSON.stringify(event)).catch(err => this.logger.warn({ err }, "Realtime publish failed"));
    }
  }

  get stream(): Observable<RealtimeEvent> {
    return this.events$.asObservable();
  }

  /** Whether this actor may be told about the event. */
  canSee(actor: Actor, event: RealtimeEvent): boolean {
    if (actor.permissions.has((event.staffPermission ?? "parcel:read:any") as never)) return true;
    if (event.merchantId && merchantIdsOf(actor).includes(event.merchantId)) return true;
    if (actor.kind !== "user") return false;
    if (event.customerId && event.customerId === actor.userId) return true;
    if (actor.riderId && event.riderIds?.includes(actor.riderId)) return true;
    if (event.userIds?.includes(actor.userId)) return true;
    const hubs = actor.roles.filter(r => r.role === "HUB_OPERATOR" && r.hubId).map(r => r.hubId);
    return !!event.hubIds?.some(h => h && hubs.includes(h));
  }
}

@Global()
@Module({ providers: [RealtimeService], exports: [RealtimeService] })
export class RealtimeModule {}
