import { Injectable } from "@nestjs/common";
import type { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import type { Prisma } from "../../generated/prisma/client";
import { BACK_AFTER_FAILURE, forHubsWhere, RETURN_REQUESTED, stageWhere, type ParcelStage, type stageCountsQuerySchema } from "../parcels/parcel-stages";

/**
 * Parcels per journey stage for Courier Operations' menu badges, Today cards and stage metrics,
 * counted with the same filters as the paged lists (GET /parcels?stage=), optionally for some hubs
 * only ("my hub"). Read-only.
 */
@Injectable()
export class StageCountsService {
  constructor(private readonly prisma: PrismaService) {}

  async counts(query: z.infer<typeof stageCountsQuerySchema>) {
    const now = new Date();
    const hubIds = query.forHubIds?.length ? query.forHubIds : null;
    const scope: Prisma.ParcelWhereInput = hubIds ? await forHubsWhere(this.prisma, hubIds) : {};
    const count = (where: Prisma.ParcelWhereInput) => this.prisma.parcel.count({ where: { AND: [scope, where] } });
    const stage = (s: ParcelStage) => count(stageWhere(s, now));
    const [newOrders, pickupWaiting, pickingUp, hub, transfers, deliveryWaiting, delivery, exceptions, failed, needsInfo, slaRisk, problems, returnsScheduled, returnRequests, backAfterFailure] = await Promise.all([
      stage("new"),
      stage("pickup_waiting"),
      stage("pickup"),
      stage("hub"),
      stage("transfers"),
      stage("delivery_waiting"),
      stage("delivery"),
      stage("exceptions"),
      stage("failed"),
      stage("needs_info"),
      stage("sla_risk"),
      stage("problems"),
      stage("returns"),
      count(RETURN_REQUESTED),
      count(BACK_AFTER_FAILURE),
    ]);
    return {
      generatedAt: now,
      hubIds,
      /** One number per menu stage. */
      stages: {
        newOrders,
        pickup: pickupWaiting + pickingUp,
        hubDesk: hub,
        transfers,
        delivery,
        problems,
        returns: returnRequests + returnsScheduled,
      },
      /** The parts the stage pages show (failed = retry scheduled + backAfterFailure: at a hub after a failed attempt). */
      detail: { newOrders, pickupWaiting, pickingUp, hub, transfers, deliveryWaiting, delivery, exceptions, failed, backAfterFailure, needsInfo, slaRisk, problems, returnRequests, returnsScheduled },
    };
  }
}
