import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { AppError, conflict, forbidden, notFound } from "../../common/errors";
import { pageArgs, toPage } from "../../common/pagination";
import type { Actor, UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import type { Prisma } from "../../generated/prisma/client";
import type { createHandoverSchema, listCashRidersQuerySchema, listHandoversQuerySchema } from "./finance.schemas";
import { cashHubScope, money, scopedHubIds, sum } from "./finance.scope";
import { LedgerService } from "./ledger.service";

const handoverInclude = {
  rider: { select: { id: true, code: true, user: { select: { name: true } } } },
  hub: { select: { id: true, code: true, name: true } },
  _count: { select: { collections: true } },
} satisfies Prisma.CashHandoverInclude;

type HandoverRow = Prisma.CashHandoverGetPayload<{ include: typeof handoverInclude }>;

@Injectable()
export class CodService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Inject(LedgerService) private readonly ledger!: LedgerService;

  /** Riders currently holding COD cash, largest balance first. */
  async ridersWithCash(actor: Actor, query: z.infer<typeof listCashRidersQuerySchema>) {
    const hubIds = scopedHubIds(actor, query.hubId);
    const groups = await this.prisma.codCollection.groupBy({
      by: ["riderId"],
      where: { state: "WITH_RIDER", riderId: { not: null }, ...(hubIds ? { rider: { hubId: { in: hubIds } } } : {}) },
      _sum: { amount: true },
      _count: { _all: true },
      _min: { collectedAt: true },
    });
    const riders = await this.prisma.rider.findMany({
      where: { id: { in: groups.flatMap(g => (g.riderId ? [g.riderId] : [])) } },
      include: { user: { select: { name: true, phone: true } }, hub: { select: { id: true, code: true, name: true } } },
    });
    const byId = new Map(riders.map(r => [r.id, r]));
    return groups
      .filter(g => g.riderId && byId.has(g.riderId))
      .map(g => {
        const r = byId.get(g.riderId!)!;
        return {
          riderId: r.id,
          code: r.code,
          name: r.user.name,
          phone: r.user.phone,
          hub: r.hub,
          cashInHand: money(g._sum.amount),
          collections: g._count._all,
          oldestCollectedAt: g._min.collectedAt,
        };
      })
      .sort((a, b) => b.cashInHand - a.cashInHand || a.code.localeCompare(b.code));
  }

  async riderCollections(riderId: string) {
    const rider = await this.prisma.rider.findUnique({ where: { id: riderId }, include: { user: { select: { name: true } } } });
    if (!rider) throw notFound("Rider");
    const rows = await this.prisma.codCollection.findMany({
      where: { riderId, state: "WITH_RIDER" },
      include: { parcel: { select: { trackingId: true, recipientName: true } } },
      orderBy: { collectedAt: "asc" },
    });
    return {
      rider: { id: rider.id, code: rider.code, name: rider.user.name },
      cashInHand: money(sum(rows.map(c => c.amount))),
      collections: rows.map(c => ({ id: c.id, trackingId: c.parcel.trackingId, recipient: c.parcel.recipientName, amount: money(c.amount), collectedAt: c.collectedAt })),
    };
  }

  /** A hub receives cash from a rider for an exact set of collections. */
  async createHandover(actor: UserActor, input: z.infer<typeof createHandoverSchema>, meta: RequestMeta) {
    const scope = cashHubScope(actor);
    if (scope !== null && !scope.includes(input.hubId)) throw forbidden("You can only receive cash at your own hub");

    const id = await this.prisma.$transaction(
      async tx => {
        const [rider, hub] = await Promise.all([tx.rider.findUnique({ where: { id: input.riderId } }), tx.hub.findUnique({ where: { id: input.hubId } })]);
        if (!rider) throw notFound("Rider");
        if (!hub || !hub.active) throw notFound("Hub");

        const rows = await tx.codCollection.findMany({ where: { id: { in: input.collectionIds } } });
        const available = rows.filter(c => c.riderId === input.riderId && c.state === "WITH_RIDER" && !c.handoverId);
        if (available.length !== input.collectionIds.length) {
          const ok = new Set(available.map(c => c.id));
          throw new AppError("COLLECTION_NOT_AVAILABLE", "Some collections aren't held by this rider any more", HttpStatus.CONFLICT, {
            unavailable: input.collectionIds.filter(cid => !ok.has(cid)),
          });
        }
        const expected = sum(available.map(c => c.amount));
        if (!expected.equals(input.amountReceived))
          throw new AppError("HANDOVER_AMOUNT_MISMATCH", `The cash for these collections is ৳${expected.toFixed(2)}`, HttpStatus.UNPROCESSABLE_ENTITY, {
            expected: money(expected),
            received: money(input.amountReceived),
          });

        const handover = await tx.cashHandover.create({
          data: { riderId: rider.id, hubId: hub.id, amount: expected, receivedById: actor.userId, note: input.note },
        });
        // Guarded move: a concurrent handover of any of these collections makes this count short.
        const moved = await tx.codCollection.updateMany({
          where: { id: { in: input.collectionIds }, riderId: rider.id, state: "WITH_RIDER", handoverId: null },
          data: { state: "AT_HUB", handoverId: handover.id },
        });
        if (moved.count !== input.collectionIds.length) throw conflict("COLLECTION_NOT_AVAILABLE", "Some collections were just handed over by someone else");
        await this.ledger.record(tx, { type: "COD_HANDED_OVER", amount: expected, reference: handover.id, riderId: rider.id, hubId: hub.id, occurredAt: handover.createdAt, memo: `${rider.code} handed over ${moved.count} COD collection(s)`, createdById: actor.userId });

        await this.audit.record(
          actor,
          {
            action: "cod.handover",
            entityType: "cash_handover",
            entityId: handover.id,
            data: { riderId: rider.id, hubId: hub.id, amount: expected.toFixed(2), collectionIds: input.collectionIds, note: input.note ?? null },
          },
          meta,
          tx,
        );
        return handover.id;
      },
      { timeout: 15_000 },
    );
    return this.getHandover(id);
  }

  async listHandovers(actor: Actor, query: z.infer<typeof listHandoversQuerySchema>) {
    const hubIds = scopedHubIds(actor, query.hubId);
    const rows = await this.prisma.cashHandover.findMany({
      where: {
        riderId: query.riderId,
        hubId: hubIds ? { in: hubIds } : undefined,
        createdAt: query.from || query.to ? { gte: query.from, lt: query.to } : undefined,
      },
      include: handoverInclude,
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    const receivers = await this.receiverNames(page.items);
    return { ...page, items: page.items.map(h => this.handoverView(h, receivers)) };
  }

  private async getHandover(id: string) {
    const h = await this.prisma.cashHandover.findUniqueOrThrow({
      where: { id },
      include: { ...handoverInclude, collections: { include: { parcel: { select: { trackingId: true } } }, orderBy: { collectedAt: "asc" } } },
    });
    return {
      ...this.handoverView(h, await this.receiverNames([h])),
      collections: h.collections.map(c => ({ id: c.id, trackingId: c.parcel.trackingId, amount: money(c.amount), collectedAt: c.collectedAt })),
    };
  }

  private async receiverNames(rows: { receivedById: string }[]) {
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map(r => r.receivedById))] } }, select: { id: true, name: true } });
    return new Map(users.map(u => [u.id, u.name]));
  }

  private handoverView(h: HandoverRow, receivers: Map<string, string>) {
    return {
      id: h.id,
      rider: { id: h.rider.id, code: h.rider.code, name: h.rider.user.name, label: `${h.rider.code} · ${h.rider.user.name}` },
      hub: h.hub,
      amount: money(h.amount),
      collectionCount: h._count.collections,
      receivedBy: { id: h.receivedById, name: receivers.get(h.receivedById) ?? null },
      note: h.note,
      createdAt: h.createdAt,
    };
  }
}
