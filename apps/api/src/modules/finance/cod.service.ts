import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { AppError, conflict, forbidden, notFound } from "../../common/errors";
import type { UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import type { Prisma } from "../../generated/prisma/client";
import type { createHandoverSchema } from "./finance.schemas";
import { cashHubScope, money, sum } from "./finance.scope";
import { LedgerService } from "./ledger.service";
import { cashHubProblem } from "../parcels/ops-scope";

const handoverInclude = {
  rider: { select: { id: true, code: true, user: { select: { name: true } } } },
  hub: { select: { id: true, code: true, name: true } },
  _count: { select: { collections: true } },
} satisfies Prisma.CashHandoverInclude;

type HandoverRow = Prisma.CashHandoverGetPayload<{ include: typeof handoverInclude }>;

/** A franchise counter receiving its riders' COD cash (franchise money); company hubs use handover slips (Accounts). */
@Injectable()
export class CodService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Inject(LedgerService) private readonly ledger!: LedgerService;

  /** A hub receives cash from a rider for an exact set of collections. */
  async createHandover(actor: UserActor, input: z.infer<typeof createHandoverSchema>, meta: RequestMeta) {
    const scope = cashHubScope(actor);
    if (scope !== null && !scope.includes(input.hubId)) throw forbidden("You can only receive cash at your own hub");

    const id = await this.prisma.$transaction(
      async tx => {
        const [rider, hub] = await Promise.all([tx.rider.findUnique({ where: { id: input.riderId } }), tx.hub.findUnique({ where: { id: input.hubId } })]);
        if (!rider) throw notFound("Rider");
        if (!hub || !hub.active) throw notFound("Hub");
        const riderHub = rider.hubId ? await tx.hub.findUnique({ where: { id: rider.hubId }, select: { type: true, name: true } }) : null;
        const problem = cashHubProblem({ hubId: rider.hubId, hub: riderHub }, hub);
        if (problem) throw new AppError("WRONG_CASH_HUB", problem, HttpStatus.UNPROCESSABLE_ENTITY);

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
