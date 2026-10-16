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
    await db.auditLog.create({ data: { ...who, ...entry, ip: meta?.ip, requestId: meta?.requestId } });
  }
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
