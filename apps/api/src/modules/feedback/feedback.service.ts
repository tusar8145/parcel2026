import { HttpStatus, Injectable } from "@nestjs/common";
import type { z } from "zod";
import type { feedbackSchema } from "@delivery-fast/shared";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { RealtimeService } from "../../common/realtime.service";
import { hasRole, merchantIdsOf, type Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { AppError, notFound } from "../../common/errors";
import { pageArgs, toPage } from "../../common/pagination";
import { ParcelsService } from "../parcels/parcels.service";
import { verifyParcelAccess } from "../parcels/parcel-access";
import type { listFeedbackQuerySchema } from "./feedback.schemas";

type Parcel = Awaited<ReturnType<ParcelsService["findByTrackingId"]>>;

const feedbackSelect = { rating: true, comment: true, source: true, createdAt: true } as const;

/**
 * The sender's 1–5 star rating of a delivered parcel (one per parcel). Given by the
 * signed-in owner on the tracking page, or with a guest-booking / feedback-request link.
 */
@Injectable()
export class FeedbackService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly parcels: ParcelsService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
  ) {}

  /** The owner (signed in) or a valid link token; anything else looks like an unknown parcel. */
  private async access(actor: Actor | undefined, trackingId: string, token: string | undefined) {
    const parcel = await this.parcels.findByTrackingId(trackingId);
    const scope = token ? verifyParcelAccess(parcel.trackingId, token) : null;
    if (scope) return { parcel, source: scope === "owner" ? ("GUEST_LINK" as const) : ("SMS_LINK" as const) };
    if (actor && this.isOwner(actor, parcel)) return { parcel, source: "TRACKING" as const };
    throw notFound("Parcel");
  }

  private isOwner(actor: Actor, parcel: Parcel) {
    if (actor.kind === "user" && hasRole(actor, "CUSTOMER") && parcel.customerId === actor.userId) return true;
    return !!parcel.merchantId && merchantIdsOf(actor).includes(parcel.merchantId);
  }

  async get(actor: Actor | undefined, trackingId: string, token: string | undefined) {
    const { parcel } = await this.access(actor, trackingId, token);
    const feedback = await this.prisma.parcelFeedback.findUnique({ where: { parcelId: parcel.id }, select: feedbackSelect });
    return { trackingId: parcel.trackingId, feedback, canGiveFeedback: parcel.status === "DELIVERED" && !feedback };
  }

  async submit(actor: Actor | undefined, trackingId: string, input: z.infer<typeof feedbackSchema>, meta: RequestMeta) {
    const { parcel, source } = await this.access(actor, trackingId, input.token);
    if (parcel.status !== "DELIVERED")
      throw new AppError("FEEDBACK_NOT_AVAILABLE", "You can rate a delivery once the parcel is delivered.", HttpStatus.CONFLICT);
    const userId = actor?.kind === "user" ? actor.userId : null;
    const feedback = await this.prisma.$transaction(async tx => {
      const existing = await tx.parcelFeedback.findUnique({ where: { parcelId: parcel.id }, select: { id: true } });
      if (existing) throw new AppError("FEEDBACK_EXISTS", "Thanks — feedback for this delivery was already received.", HttpStatus.CONFLICT);
      const row = await tx.parcelFeedback
        .create({ data: { parcelId: parcel.id, rating: input.rating, comment: input.comment, source, userId }, select: { id: true, ...feedbackSelect } })
        .catch((err: { code?: string }) => {
          if (err?.code === "P2002") throw new AppError("FEEDBACK_EXISTS", "Thanks — feedback for this delivery was already received.", HttpStatus.CONFLICT);
          throw err;
        });
      await this.audit.record(
        actor ?? "system", // link holders have no account; `source` says which link was used
        { action: "parcel.feedback", entityType: "parcel", entityId: parcel.id, data: { trackingId: parcel.trackingId, rating: input.rating, source } },
        meta,
        tx,
      );
      return row;
    });
    this.realtime.publish({ type: "feedback.created", id: feedback.id, staffPermission: "parcel:read:any" });
    const { id: _id, ...rest } = feedback;
    return { trackingId: parcel.trackingId, feedback: rest, canGiveFeedback: false };
  }

  /** Staff (operations, super admin): ratings with their parcels, newest first, plus a summary. */
  async list(query: z.infer<typeof listFeedbackQuerySchema>) {
    const where = {
      ...(query.source ? { source: query.source } : {}),
      ...(query.minRating || query.maxRating ? { rating: { gte: query.minRating ?? 1, lte: query.maxRating ?? 5 } } : {}),
      ...(query.q ? { parcel: { trackingId: { contains: query.q.toUpperCase() } } } : {}),
    };
    const [rows, summary, byRating] = await Promise.all([
      this.prisma.parcelFeedback.findMany({
        where,
        ...pageArgs(query),
        include: {
          parcel: {
            select: { trackingId: true, senderName: true, senderPhone: true, deliveryDistrict: true, deliveredAt: true, deliveryRider: { select: { id: true, code: true, user: { select: { name: true } } } } },
          },
        },
      }),
      this.prisma.parcelFeedback.aggregate({ _avg: { rating: true }, _count: { _all: true } }),
      this.prisma.parcelFeedback.groupBy({ by: ["rating"], _count: { _all: true } }),
    ]);
    const page = toPage(rows, query.limit);
    return {
      items: page.items.map(f => ({
        id: f.id,
        rating: f.rating,
        comment: f.comment,
        source: f.source,
        createdAt: f.createdAt,
        trackingId: f.parcel.trackingId,
        senderName: f.parcel.senderName,
        senderPhone: f.parcel.senderPhone,
        deliveryDistrict: f.parcel.deliveryDistrict,
        deliveredAt: f.parcel.deliveredAt,
        rider: f.parcel.deliveryRider ? { id: f.parcel.deliveryRider.id, code: f.parcel.deliveryRider.code, name: f.parcel.deliveryRider.user.name } : null,
      })),
      nextCursor: page.nextCursor,
      summary: {
        count: summary._count._all,
        average: summary._avg.rating === null ? null : Math.round(summary._avg.rating * 100) / 100,
        byRating: Object.fromEntries([1, 2, 3, 4, 5].map(r => [r, byRating.find(b => b.rating === r)?._count._all ?? 0])),
      },
    };
  }
}
