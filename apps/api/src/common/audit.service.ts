import { AsyncLocalStorage } from "node:async_hooks";
import { Global, Injectable, Module } from "@nestjs/common";
import { PrismaService, type Db } from "./prisma.service";
import { actorLabel, type Actor } from "./auth/actor";
import type { RequestMeta } from "./auth/decorators";
import type { Prisma } from "../generated/prisma/client";

export interface AuditEntry {
  action: string;
  entityType?: string;
  entityId?: string;
  data?: Prisma.InputJsonValue;
}

const auditContext = new AsyncLocalStorage<Record<string, Prisma.InputJsonValue>>();

/**
 * Runs `work` with extra facts merged into the data of every audit record it writes, e.g.
 * `{ bulkUpdate: { id, number, row } }` while a bulk update applies a row through the normal services.
 */
export const withAuditContext = <T>(extra: Record<string, Prisma.InputJsonValue>, work: () => Promise<T>): Promise<T> => auditContext.run(extra, work);

/** Append-only record of security- and business-relevant changes. */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Pass `db` to write inside the caller's transaction. */
  async record(actor: Actor | "system" | { userId: string; name: string }, entry: AuditEntry, meta?: Partial<RequestMeta>, db: Db = this.prisma) {
    const who =
      actor === "system"
        ? { actorType: "SYSTEM" as const, actorId: null, actorLabel: "System" }
        : "kind" in actor
          ? { actorType: actor.kind === "api_key" ? ("API_KEY" as const) : ("USER" as const), actorId: actor.kind === "api_key" ? actor.apiKeyId : actor.userId, actorLabel: actorLabel(actor) }
          : { actorType: "USER" as const, actorId: actor.userId, actorLabel: actor.name };
    const extra = auditContext.getStore();
    const data =
      extra === undefined
        ? entry.data
        : entry.data && typeof entry.data === "object" && !Array.isArray(entry.data)
          ? { ...(entry.data as Prisma.InputJsonObject), ...extra }
          : { ...(entry.data === undefined ? {} : { value: entry.data }), ...extra };
    await db.auditLog.create({ data: { ...who, ...entry, data, ip: meta?.ip, requestId: meta?.requestId } });
  }
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
