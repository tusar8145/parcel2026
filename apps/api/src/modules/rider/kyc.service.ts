import { HttpStatus, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { PrismaService, type Db } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { RealtimeService } from "../../common/realtime.service";
import { StorageService } from "../../common/storage.service";
import { AppError, conflict, forbidden, notFound } from "../../common/errors";
import type { Actor, UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import type { KycDocumentType, Prisma, RiderKycStatus } from "../../generated/prisma/client";
import { NotifyService } from "../notifications/notify.service";
import { OutboxService } from "../notifications/outbox.service";
import { KYC_DOCUMENT_TYPES, REQUIRED_KYC, type kycDecisionSchema, type kycDocumentReviewSchema, type kycUploadSchema } from "./rider.schemas";

export const KYC_LABEL: Record<KycDocumentType, string> = {
  NID_FRONT: "National ID (front)",
  NID_BACK: "National ID (back)",
  DRIVING_LICENSE: "Driving licence",
  PHOTO: "Rider photo",
  VEHICLE_PAPERS: "Vehicle registration papers",
};
const STATUS_TEXT: Record<RiderKycStatus, string> = {
  NOT_STARTED: "not started",
  DOCUMENTS_PENDING: "waiting for documents",
  UNDER_REVIEW: "under review",
  APPROVED: "approved",
  REJECTED: "needs changes",
};

type DocRow = Prisma.RiderKycDocumentGetPayload<{ include: { file: { select: { mimeType: true; sizeBytes: true; filename: true } } } }>;
const docView = (d: DocRow) => ({
  id: d.id,
  type: d.type,
  label: KYC_LABEL[d.type],
  status: d.status,
  documentNumber: d.documentNumber,
  expiresAt: d.expiresAt,
  rejectionReason: d.rejectionReason,
  reviewedAt: d.reviewedAt,
  uploadedAt: d.createdAt,
  file: { mimeType: d.file.mimeType, sizeBytes: d.file.sizeBytes, filename: d.file.filename, url: `/api/v1/rider-kyc/documents/${d.id}/file` },
});

/**
 * Rider onboarding and KYC. Riders upload documents (or the applications module attaches
 * them), submit for review, and operations (rider:manage) approve or reject. The rider is
 * told about every decision (rider.kyc_status) and sees the status in the rider app.
 */
@Injectable()
export class RiderKycService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
    private readonly storage: StorageService,
    private readonly notify: NotifyService,
    private readonly outbox: OutboxService,
  ) {}

  // ───────────── contract for other modules ─────────────

  /**
   * Starts (or restarts) onboarding for a rider: they are asked for their KYC documents.
   * Used by the applications module when an approved rider application becomes a rider.
   * Call inside your transaction and flush the returned outbox ids after commit
   * (OutboxService.flush). An already approved rider is left as is.
   */
  async startOnboarding(db: Db, input: { riderId: string; applicationId?: string; note?: string; notifyRider?: boolean }) {
    const rider = await db.rider.findUnique({ where: { id: input.riderId }, select: { id: true, userId: true, user: { select: { name: true } } } });
    if (!rider) throw notFound("Rider");
    const existing = await db.riderOnboarding.findUnique({ where: { riderId: rider.id } });
    if (existing?.status === "APPROVED") return { onboarding: existing, outboxIds: [] as string[] };
    const onboarding = await db.riderOnboarding.upsert({
      where: { riderId: rider.id },
      create: { riderId: rider.id, status: "DOCUMENTS_PENDING", applicationId: input.applicationId, note: input.note },
      update: { status: existing?.status === "UNDER_REVIEW" ? "UNDER_REVIEW" : "DOCUMENTS_PENDING", applicationId: input.applicationId ?? existing?.applicationId, note: input.note ?? existing?.note },
    });
    const outboxIds =
      input.notifyRider === false
        ? []
        : await this.notify.notify(db, { event: "rider.kyc_status", to: { userId: rider.userId, name: rider.user.name }, vars: { name: rider.user.name, status: STATUS_TEXT[onboarding.status] } });
    return { onboarding, outboxIds };
  }

  /** Attaches an already stored file (e.g. from a rider application) as a KYC document. */
  async attachDocument(db: Db, input: { riderId: string; type: KycDocumentType; fileId: string; documentNumber?: string; expiresAt?: Date }) {
    await db.riderKycDocument.updateMany({ where: { riderId: input.riderId, type: input.type, supersededAt: null }, data: { supersededAt: new Date() } });
    return db.riderKycDocument.create({ data: { riderId: input.riderId, type: input.type, fileId: input.fileId, documentNumber: input.documentNumber, expiresAt: input.expiresAt } });
  }

  // ───────────── rider app ─────────────

  async mine(actor: UserActor) {
    if (!actor.riderId) throw forbidden("Only riders have KYC documents");
    return this.state(actor.riderId);
  }

  async upload(actor: UserActor, input: z.infer<typeof kycUploadSchema>, meta: RequestMeta) {
    if (!actor.riderId) throw forbidden("Only riders can upload KYC documents");
    const riderId = actor.riderId;
    await this.prisma.$transaction(
      async tx => {
        const onboarding = await tx.riderOnboarding.findUnique({ where: { riderId } });
        const file = await this.storage.saveDataUrl(input.file, `kyc-${input.type.toLowerCase()}`, actor.userId, tx);
        const doc = await this.attachDocument(tx, { riderId, type: input.type, fileId: file.id, documentNumber: input.documentNumber, expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined });
        // A change after approval or rejection goes back to review / waits for the rest.
        const status: RiderKycStatus = !onboarding || onboarding.status === "REJECTED" || onboarding.status === "NOT_STARTED" ? "DOCUMENTS_PENDING" : onboarding.status === "APPROVED" ? "UNDER_REVIEW" : onboarding.status;
        await tx.riderOnboarding.upsert({ where: { riderId }, create: { riderId, status }, update: { status, ...(status === "UNDER_REVIEW" ? { submittedAt: new Date() } : {}) } });
        await this.audit.record(actor, { action: "rider.kyc.upload", entityType: "rider_kyc_document", entityId: doc.id, data: { type: input.type, fileId: file.id } }, meta, tx);
      },
      { timeout: 15_000 },
    );
    return this.state(riderId);
  }

  /** The rider sends their documents for review once every required one is uploaded. */
  async submit(actor: UserActor, meta: RequestMeta) {
    if (!actor.riderId) throw forbidden();
    const riderId = actor.riderId;
    const current = await this.state(riderId);
    if (current.status === "UNDER_REVIEW" || current.status === "APPROVED") throw conflict("KYC_ALREADY_SUBMITTED", `Your documents are already ${STATUS_TEXT[current.status]}`);
    if (current.missing.length)
      throw new AppError("KYC_INCOMPLETE", `Upload ${current.missing.map(t => KYC_LABEL[t as KycDocumentType]).join(", ")} first`, HttpStatus.UNPROCESSABLE_ENTITY, { missing: current.missing });
    await this.prisma.$transaction(async tx => {
      await tx.riderOnboarding.upsert({ where: { riderId }, create: { riderId, status: "UNDER_REVIEW", submittedAt: new Date() }, update: { status: "UNDER_REVIEW", submittedAt: new Date() } });
      await this.audit.record(actor, { action: "rider.kyc.submit", entityType: "rider", entityId: riderId }, meta, tx);
    });
    this.publish(riderId, "UNDER_REVIEW");
    return this.state(riderId);
  }

  // ───────────── operations review ─────────────

  async queue(actor: Actor, status?: RiderKycStatus) {
    this.requireReviewer(actor);
    const rows = await this.prisma.riderOnboarding.findMany({
      where: { status: status ?? "UNDER_REVIEW" },
      include: {
        rider: {
          select: {
            id: true,
            code: true,
            vehicle: true,
            zone: true,
            hub: { select: { id: true, name: true } },
            user: { select: { name: true, phone: true } },
            kycDocuments: { where: { supersededAt: null }, select: { status: true } },
          },
        },
      },
      orderBy: [{ submittedAt: "asc" }, { startedAt: "asc" }],
      take: 500,
    });
    return rows.map(r => ({
      riderId: r.riderId,
      code: r.rider.code,
      name: r.rider.user.name,
      phone: r.rider.user.phone,
      vehicle: r.rider.vehicle,
      zone: r.rider.zone,
      hub: r.rider.hub,
      status: r.status,
      submittedAt: r.submittedAt,
      startedAt: r.startedAt,
      reviewedAt: r.reviewedAt,
      applicationId: r.applicationId,
      documents: { total: r.rider.kycDocuments.length, pending: r.rider.kycDocuments.filter(d => d.status === "PENDING").length, rejected: r.rider.kycDocuments.filter(d => d.status === "REJECTED").length },
    }));
  }

  async detail(actor: Actor, riderId: string) {
    this.requireReviewer(actor);
    const rider = await this.prisma.rider.findUnique({ where: { id: riderId }, select: { code: true, vehicle: true, user: { select: { name: true, phone: true } } } });
    if (!rider) throw notFound("Rider");
    return { rider: { id: riderId, code: rider.code, name: rider.user.name, phone: rider.user.phone, vehicle: rider.vehicle }, ...(await this.state(riderId)) };
  }

  async reviewDocument(actor: Actor, id: string, input: z.infer<typeof kycDocumentReviewSchema>, meta: RequestMeta) {
    this.requireReviewer(actor);
    const doc = await this.prisma.riderKycDocument.findUnique({ where: { id } });
    if (!doc) throw notFound("Document");
    if (doc.supersededAt) throw conflict("KYC_DOCUMENT_REPLACED", "The rider uploaded a newer version of this document");
    await this.prisma.$transaction(async tx => {
      await tx.riderKycDocument.update({
        where: { id },
        data: { status: input.decision === "APPROVE" ? "APPROVED" : "REJECTED", rejectionReason: input.decision === "REJECT" ? input.reason : null, reviewedById: actor.kind === "user" ? actor.userId : null, reviewedAt: new Date() },
      });
      await this.audit.record(actor, { action: `rider.kyc.document.${input.decision.toLowerCase()}`, entityType: "rider_kyc_document", entityId: id, data: { type: doc.type, reason: input.reason ?? null } }, meta, tx);
    });
    this.publish(doc.riderId);
    return this.detail(actor, doc.riderId);
  }

  /**
   * Final decision. Approving accepts every current document that is still pending and needs
   * each required document; rejecting sends the rider back to fix what the note says.
   */
  async decide(actor: Actor, riderId: string, input: z.infer<typeof kycDecisionSchema>, meta: RequestMeta) {
    this.requireReviewer(actor);
    const reviewerId = actor.kind === "user" ? actor.userId : null;
    const outboxIds = await this.prisma.$transaction(async tx => {
      const rider = await tx.rider.findUnique({ where: { id: riderId }, select: { userId: true, vehicle: true, user: { select: { name: true } } } });
      if (!rider) throw notFound("Rider");
      const docs = await tx.riderKycDocument.findMany({ where: { riderId, supersededAt: null } });
      const now = new Date();
      if (input.decision === "APPROVE") {
        if (docs.some(d => d.status === "REJECTED")) throw new AppError("KYC_HAS_REJECTED_DOCUMENTS", "Some documents were rejected. Ask the rider to upload them again first.", HttpStatus.UNPROCESSABLE_ENTITY);
        const have = new Set(docs.map(d => d.type));
        const missing = REQUIRED_KYC(rider.vehicle).filter(t => !have.has(t));
        if (missing.length) throw new AppError("KYC_INCOMPLETE", `Missing: ${missing.map(t => KYC_LABEL[t]).join(", ")}`, HttpStatus.UNPROCESSABLE_ENTITY, { missing });
        await tx.riderKycDocument.updateMany({ where: { riderId, supersededAt: null, status: "PENDING" }, data: { status: "APPROVED", reviewedById: reviewerId, reviewedAt: now } });
      }
      const status: RiderKycStatus = input.decision === "APPROVE" ? "APPROVED" : "REJECTED";
      await tx.riderOnboarding.upsert({
        where: { riderId },
        create: { riderId, status, reviewedAt: now, reviewedById: reviewerId, note: input.note },
        update: { status, reviewedAt: now, reviewedById: reviewerId, note: input.note ?? null },
      });
      await this.audit.record(actor, { action: `rider.kyc.${input.decision.toLowerCase()}`, entityType: "rider", entityId: riderId, data: { note: input.note ?? null } }, meta, tx);
      return this.notify.notify(tx, {
        event: "rider.kyc_status",
        to: { userId: rider.userId, name: rider.user.name },
        vars: { name: rider.user.name, status: STATUS_TEXT[status], note: input.note },
      });
    });
    await this.outbox.flush(outboxIds);
    this.publish(riderId, input.decision === "APPROVE" ? "APPROVED" : "REJECTED");
    return this.detail(actor, riderId);
  }

  /** The document's file, for the rider who uploaded it and reviewers (rider:manage). */
  async file(actor: Actor, id: string) {
    const doc = await this.prisma.riderKycDocument.findUnique({ where: { id }, include: { file: true } });
    const own = actor.kind === "user" && !!actor.riderId && doc?.riderId === actor.riderId;
    if (!doc || (!own && !actor.permissions.has("rider:manage"))) throw notFound("Document");
    try {
      return { file: doc.file, data: await this.storage.read(doc.file.storageKey) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw notFound("Document");
      throw err;
    }
  }

  // ───────────── helpers ─────────────

  private requireReviewer(actor: Actor) {
    if (!actor.permissions.has("rider:manage")) throw forbidden("Only operations managers can review rider documents");
  }

  private async state(riderId: string) {
    const [rider, onboarding, docs] = await Promise.all([
      this.prisma.rider.findUniqueOrThrow({ where: { id: riderId }, select: { vehicle: true } }),
      this.prisma.riderOnboarding.findUnique({ where: { riderId } }),
      this.prisma.riderKycDocument.findMany({ where: { riderId, supersededAt: null }, include: { file: { select: { mimeType: true, sizeBytes: true, filename: true } } }, orderBy: { createdAt: "asc" } }),
    ]);
    const required = REQUIRED_KYC(rider.vehicle);
    const usable = new Set(docs.filter(d => d.status !== "REJECTED").map(d => d.type));
    return {
      status: (onboarding?.status ?? "NOT_STARTED") as RiderKycStatus,
      note: onboarding?.note ?? null,
      submittedAt: onboarding?.submittedAt ?? null,
      reviewedAt: onboarding?.reviewedAt ?? null,
      required,
      optional: KYC_DOCUMENT_TYPES.filter(t => !required.includes(t as never)),
      missing: required.filter(t => !usable.has(t)),
      documents: docs.map(docView),
    };
  }

  private publish(riderId: string, status?: RiderKycStatus) {
    this.realtime.publish({ type: "rider.kyc", id: riderId, riderIds: [riderId], staffPermission: "rider:manage", data: status ? { status } : undefined });
  }
}
