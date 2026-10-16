import { Injectable } from "@nestjs/common";
import type { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import { pageArgs, toPage } from "../../common/pagination";
import type { Prisma } from "../../generated/prisma/client";
import type { listAuditLogsQuerySchema } from "./accounts.schemas";

@Injectable()
export class AuditLogsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Newest first (UUIDv7 ids are time-ordered). */
  async list(query: z.infer<typeof listAuditLogsQuerySchema>) {
    const where: Prisma.AuditLogWhereInput = {
      actorId: query.actorId,
      entityType: query.entityType,
      entityId: query.entityId,
      ...(query.action ? { action: { startsWith: query.action } } : {}),
      ...(query.from || query.to ? { createdAt: { gte: query.from, lte: query.to } } : {}),
    };
    const rows = await this.prisma.auditLog.findMany({ where, ...pageArgs(query) });
    return toPage(rows, query.limit);
  }
}
