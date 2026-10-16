import { Injectable } from "@nestjs/common";
import type { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import type { Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { AppError, forbidden, notFound } from "../../common/errors";
import { nextNumber, nextTrackingId, normalizeTrackingId } from "../../common/counters";
import { pageArgs, toPage } from "../../common/pagination";
import type { Prisma } from "../../generated/prisma/client";
import { opsHubScope } from "../parcels/ops-scope";
import { assertHubInScope } from "../ops/ops-common";
import type { createBatchSchema, listBatchesQuerySchema, listStockQuerySchema, printSchema, updateBatchSchema, voidSchema } from "./cn-stock.schemas";

const batchInclude = {
  hub: { select: { id: true, code: true, name: true } },
  merchant: { select: { id: true, code: true, name: true } },
} satisfies Prisma.CnBatchInclude;

/**
 * Consignment-number stock: CNs pre-allocated in batches (from nextTrackingId, so they are
 * ordinary tracking IDs), issued to a hub counter and/or a merchant, printed as barcode
 * labels and used up when a parcel is booked with `cn` (POST /parcels, /ops/parcels).
 */
@Injectable()
export class CnStockService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async createBatch(actor: Actor, input: z.infer<typeof createBatchSchema>, meta: RequestMeta) {
    const scope = opsHubScope(actor);
    if (scope && !input.hubId) throw new AppError("HUB_REQUIRED", "Choose the hub the labels are for", 422);
    if (input.hubId) {
      assertHubInScope(actor, input.hubId, "issue labels for this hub");
      if (!(await this.prisma.hub.findUnique({ where: { id: input.hubId }, select: { id: true } }))) throw notFound("Hub");
    }
    if (input.merchantId) await this.activeMerchant(input.merchantId);
    const batch = await this.prisma.$transaction(
      async tx => {
        const created = await tx.cnBatch.create({
          data: { number: await nextNumber(tx, "CNB"), count: input.count, hubId: input.hubId, merchantId: input.merchantId, note: input.note, createdById: actor.kind === "user" ? actor.userId : null },
        });
        const cns: string[] = [];
        for (let i = 0; i < input.count; i++) cns.push(await nextTrackingId(tx));
        await tx.cnStock.createMany({ data: cns.map(cn => ({ cn, batchId: created.id })) });
        await this.audit.record(
          actor,
          { action: "cn.batch_create", entityType: "cn_batch", entityId: created.id, data: { number: created.number, count: input.count, hubId: input.hubId ?? null, merchantId: input.merchantId ?? null, first: cns[0], last: cns.at(-1) } },
          meta,
          tx,
        );
        return created;
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
    return this.getBatch(actor, batch.id);
  }

  async listBatches(actor: Actor, query: z.infer<typeof listBatchesQuerySchema>) {
    const where: Prisma.CnBatchWhereInput = {
      ...this.batchScope(actor, query.hubId),
      merchantId: query.merchantId,
      ...(query.q
        ? { OR: [{ number: { contains: query.q.toUpperCase() } }, { note: { contains: query.q, mode: "insensitive" } }, { items: { some: { cn: normalizeTrackingId(query.q) } } }] }
        : {}),
    };
    const rows = await this.prisma.cnBatch.findMany({ where, include: batchInclude, ...pageArgs(query) });
    const page = toPage(rows, query.limit);
    const counts = await this.prisma.cnStock.groupBy({ by: ["batchId", "status"], where: { batchId: { in: page.items.map(b => b.id) } }, _count: { _all: true } });
    return { items: page.items.map(b => ({ ...b, stock: statusCounts(counts.filter(c => c.batchId === b.id)) })), nextCursor: page.nextCursor };
  }

  async getBatch(actor: Actor, id: string) {
    const batch = await this.prisma.cnBatch.findUnique({ where: { id }, include: { ...batchInclude, items: { orderBy: { cn: "asc" }, include: { parcel: { select: { trackingId: true, status: true, recipientName: true } } } } } });
    if (!batch) throw notFound("CN batch");
    this.assertBatchVisible(actor, batch.hubId);
    const counts = await this.prisma.cnStock.groupBy({ by: ["status"], where: { batchId: id }, _count: { _all: true } });
    return { ...batch, stock: statusCounts(counts) };
  }

  async updateBatch(actor: Actor, id: string, input: z.infer<typeof updateBatchSchema>, meta: RequestMeta) {
    const batch = await this.prisma.cnBatch.findUnique({ where: { id } });
    if (!batch) throw notFound("CN batch");
    assertHubInScope(actor, batch.hubId, "change this hub's labels");
    if (input.hubId !== undefined) {
      if (opsHubScope(actor) && !input.hubId) throw new AppError("HUB_REQUIRED", "Hub operators keep labels at a hub", 422);
      if (input.hubId) {
        assertHubInScope(actor, input.hubId, "move labels to this hub");
        if (!(await this.prisma.hub.findUnique({ where: { id: input.hubId }, select: { id: true } }))) throw notFound("Hub");
      }
    }
    if (input.merchantId) await this.activeMerchant(input.merchantId);
    if (input.merchantId !== undefined && input.merchantId !== batch.merchantId && (await this.prisma.cnStock.count({ where: { batchId: id, status: "USED" } })))
      throw new AppError("BATCH_IN_USE", "Some labels of this batch are already used; issue a new batch to another merchant instead", 409);
    await this.prisma.$transaction(async tx => {
      await tx.cnBatch.update({ where: { id }, data: input });
      await this.audit.record(actor, { action: "cn.batch_update", entityType: "cn_batch", entityId: id, data: { number: batch.number, ...input } }, meta, tx);
    });
    return this.getBatch(actor, id);
  }

  /** Records that labels were printed; returns the CNs to print (AVAILABLE ones unless listed). */
  async print(actor: Actor, id: string, input: z.infer<typeof printSchema>, meta: RequestMeta) {
    const batch = await this.prisma.cnBatch.findUnique({ where: { id }, include: batchInclude });
    if (!batch) throw notFound("CN batch");
    assertHubInScope(actor, batch.hubId, "print this hub's labels");
    const where: Prisma.CnStockWhereInput = input.cns ? { batchId: id, cn: { in: input.cns.map(normalizeTrackingId) } } : { batchId: id, status: "AVAILABLE" };
    const items = await this.prisma.cnStock.findMany({ where, orderBy: { cn: "asc" }, select: { id: true, cn: true, status: true, printCount: true } });
    await this.prisma.$transaction(async tx => {
      await tx.cnStock.updateMany({ where: { id: { in: items.map(i => i.id) } }, data: { printCount: { increment: 1 }, lastPrintAt: new Date() } });
      await this.audit.record(actor, { action: "cn.print", entityType: "cn_batch", entityId: id, data: { number: batch.number, labels: items.length, reprints: items.filter(i => i.printCount > 0).length } }, meta, tx);
    });
    return { batch: { id: batch.id, number: batch.number, hub: batch.hub, merchant: batch.merchant }, labels: items.map(i => ({ cn: i.cn, status: i.status, reprint: i.printCount > 0 })) };
  }

  async listStock(actor: Actor, query: z.infer<typeof listStockQuerySchema>) {
    const where: Prisma.CnStockWhereInput = {
      status: query.status,
      batchId: query.batchId,
      batch: { ...this.batchScope(actor, query.hubId), merchantId: query.merchantId },
      ...(query.q ? { cn: { contains: normalizeTrackingId(query.q) } } : {}),
    };
    const rows = await this.prisma.cnStock.findMany({
      where,
      include: { batch: { select: { id: true, number: true, hub: { select: { id: true, name: true } }, merchant: { select: { id: true, name: true } } } }, parcel: { select: { trackingId: true, status: true } } },
      ...pageArgs(query),
    });
    return toPage(rows, query.limit);
  }

  /** One CN, e.g. after scanning a label at the counter. */
  async lookup(actor: Actor, cn: string) {
    const item = await this.prisma.cnStock.findUnique({
      where: { cn: normalizeTrackingId(cn) },
      include: { batch: { include: batchInclude }, parcel: { select: { trackingId: true, status: true, recipientName: true } } },
    });
    if (!item) throw notFound(`Consignment number ${cn.trim().toUpperCase()}`);
    this.assertBatchVisible(actor, item.batch.hubId);
    return item;
  }

  /** Voids unused labels (lost, damaged, misprinted). Used or already void ones are skipped. */
  async voidStock(actor: Actor, input: z.infer<typeof voidSchema>, meta: RequestMeta) {
    const cns = [...new Set(input.cns.map(normalizeTrackingId))];
    const items = await this.prisma.cnStock.findMany({ where: { cn: { in: cns } }, include: { batch: { select: { hubId: true } } } });
    for (const item of items) assertHubInScope(actor, item.batch.hubId, "void this hub's labels");
    const available = items.filter(i => i.status === "AVAILABLE");
    const voided = await this.prisma.$transaction(async tx => {
      const { count } = await tx.cnStock.updateMany({
        where: { id: { in: available.map(i => i.id) }, status: "AVAILABLE" },
        data: { status: "VOID", voidedAt: new Date(), voidedById: actor.kind === "user" ? actor.userId : null, voidReason: input.reason },
      });
      await this.audit.record(actor, { action: "cn.void", entityType: "cn_stock", data: { cns: available.map(i => i.cn), reason: input.reason } }, meta, tx);
      return count;
    });
    return {
      voided,
      skipped: [
        ...items.filter(i => i.status !== "AVAILABLE").map(i => ({ cn: i.cn, reason: i.status === "USED" ? "Already used" : "Already void" })),
        ...cns.filter(cn => !items.some(i => i.cn === cn)).map(cn => ({ cn, reason: "Not in CN stock" })),
      ],
    };
  }

  /** Unused / used / void counts (hub operators: their hubs' batches). */
  async summary(actor: Actor) {
    const scope = this.batchScope(actor);
    const [counts, batches, printed] = await Promise.all([
      this.prisma.cnStock.groupBy({ by: ["status"], where: { batch: scope }, _count: { _all: true } }),
      this.prisma.cnBatch.count({ where: scope }),
      this.prisma.cnStock.count({ where: { batch: scope, status: "AVAILABLE", printCount: { gt: 0 } } }),
    ]);
    return { batches, ...statusCounts(counts), printedUnused: printed };
  }

  private batchScope(actor: Actor, hubId?: string): Prisma.CnBatchWhereInput {
    const scope = opsHubScope(actor);
    if (scope && hubId && !scope.includes(hubId)) throw forbidden("You can only see your own hub's labels");
    if (hubId) return { hubId };
    return scope ? { hubId: { in: scope } } : {};
  }

  private assertBatchVisible(actor: Actor, hubId: string | null) {
    const scope = opsHubScope(actor);
    if (scope && (!hubId || !scope.includes(hubId))) throw forbidden("These labels belong to another hub");
  }

  private async activeMerchant(id: string) {
    const merchant = await this.prisma.merchant.findUnique({ where: { id }, select: { id: true, status: true } });
    if (!merchant) throw notFound("Merchant");
    if (merchant.status !== "ACTIVE") throw new AppError("MERCHANT_INACTIVE", "This merchant account isn't active", 422);
  }
}

function statusCounts(rows: { status: string; _count: { _all: number } }[]) {
  const get = (s: string) => rows.filter(r => r.status === s).reduce((n, r) => n + r._count._all, 0);
  const available = get("AVAILABLE");
  const used = get("USED");
  const voided = get("VOID");
  return { total: available + used + voided, available, used, void: voided };
}
