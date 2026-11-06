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
      ...(query.q ? { OR: [{ action: { contains: query.q, mode: "insensitive" } }, { actorLabel: { contains: query.q, mode: "insensitive" } }, { entityId: { contains: query.q, mode: "insensitive" } }] } : {}),
    };
    if (query.page) {
      const [items, total] = await Promise.all([
        this.prisma.auditLog.findMany({ where, take: query.limit, skip: (query.page - 1) * query.limit, orderBy: { id: "desc" } }),
        this.prisma.auditLog.count({ where }),
      ]);
      return { items, nextCursor: null, total, page: query.page, pages: Math.ceil(total / query.limit) };
    }
    const rows = await this.prisma.auditLog.findMany({ where, ...pageArgs(query) });
    return toPage(rows, query.limit);
  }
}
