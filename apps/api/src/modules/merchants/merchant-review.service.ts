import { HttpStatus, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { randomToken, sha256 } from "../../common/crypto";
import { AppError, conflict, notFound } from "../../common/errors";
import { pageArgs, toPage } from "../../common/pagination";
import { actorLabel, type Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { env } from "../../config/env";
import type { MerchantInvite, MerchantNote, Prisma } from "../../generated/prisma/client";
import { NotifyService } from "../notifications/notify.service";
import { OutboxService } from "../notifications/outbox.service";
import { MerchantsService, OPEN_APPLICATION_STATUSES } from "./merchants.service";
import type {
  applicantResponseSchema,
  inviteMerchantSchema,
  listInvitesQuerySchema,
  merchantNoteSchema,
  pageWithSelectorSchema,
  rejectMerchantSchema,
  requestInfoSchema,
} from "./merchants.schemas";

const noteView = (n: MerchantNote, opts: { staff: boolean }) => ({
  id: n.id,
  kind: n.kind,
  body: n.body,
  internal: n.internal,
  // Applicants see "Delivery Fast" for staff messages, never staff names.
  author: opts.staff || n.kind === "APPLICANT_RESPONSE" ? n.authorName : "Delivery Fast",
  authorId: opts.staff ? n.authorId : undefined,
  at: n.createdAt,
});

const inviteState = (i: MerchantInvite) => (i.revokedAt ? "REVOKED" : i.acceptedAt ? "ACCEPTED" : i.expiresAt < new Date() ? "EXPIRED" : "PENDING");
const inviteView = (i: MerchantInvite) => ({
  id: i.id,
  name: i.name,
  businessName: i.businessName,
  phone: i.phone,
  email: i.email,
  type: i.type,
  message: i.message,
  status: inviteState(i),
  invitedBy: i.invitedByName,
  expiresAt: i.expiresAt,
  acceptedAt: i.acceptedAt,
  merchantId: i.merchantId,
  revokedAt: i.revokedAt,
  createdAt: i.createdAt,
});

const userOf = (actor: Actor) => (actor.kind === "user" ? actor.userId : null);

/**
 * Application review beyond approve/suspend: reject with a reason, ask the applicant for more
 * information (they answer and resubmit), internal account notes, and invitations.
 */
@Injectable()
export class MerchantReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notify: NotifyService,
    private readonly outbox: OutboxService,
    private readonly merchants: MerchantsService,
  ) {}

  // ───────────── staff decisions ─────────────

  async reject(actor: Actor, id: string, input: z.infer<typeof rejectMerchantSchema>, meta: RequestMeta) {
    const outbox: string[] = [];
    await this.prisma.$transaction(async tx => {
      const m = await tx.merchant.findUnique({ where: { id } });
      if (!m) throw notFound("Merchant");
      if (!(OPEN_APPLICATION_STATUSES as readonly string[]).includes(m.status))
        throw conflict("NOT_AN_OPEN_APPLICATION", m.status === "REJECTED" ? "This application was already rejected" : "Only applications under review can be rejected. Suspend active accounts instead.");
      await tx.merchant.update({ where: { id }, data: { status: "REJECTED", rejectionReason: input.reason } });
      await tx.merchantNote.create({ data: { merchantId: id, kind: "STATUS_CHANGE", body: `Application rejected: ${input.reason}`, internal: false, authorId: userOf(actor), authorName: actorLabel(actor) } });
      outbox.push(
        ...(await this.notify.notify(tx, {
          event: "merchant.rejected",
          to: { phone: m.contactPhone, email: m.contactEmail, name: m.contactName },
          vars: { businessName: m.name, reason: input.reason },
        })),
      );
      await this.audit.record(actor, { action: "merchant.reject", entityType: "merchant", entityId: id, data: { reason: input.reason, previousStatus: m.status } }, meta, tx);
    });
    await this.outbox.flush(outbox);
    this.merchants.publish(id, { status: "REJECTED" });
    return this.merchants.detail(id);
  }

  async requestInfo(actor: Actor, id: string, input: z.infer<typeof requestInfoSchema>, meta: RequestMeta) {
    const outbox: string[] = [];
    await this.prisma.$transaction(async tx => {
      const m = await tx.merchant.findUnique({ where: { id } });
      if (!m) throw notFound("Merchant");
      if (!(OPEN_APPLICATION_STATUSES as readonly string[]).includes(m.status)) throw conflict("NOT_AN_OPEN_APPLICATION", "Only applications under review can be asked for more information");
      await tx.merchant.update({ where: { id }, data: { status: "INFO_REQUESTED" } });
      await tx.merchantNote.create({ data: { merchantId: id, kind: "INFO_REQUEST", body: input.message, internal: false, authorId: userOf(actor), authorName: actorLabel(actor) } });
      outbox.push(
        ...(await this.notify.notify(tx, {
          event: "merchant.info_requested",
          to: { phone: m.contactPhone, email: m.contactEmail, name: m.contactName },
          vars: { businessName: m.name, details: input.message, link: `${env().APP_URL}/${m.type === "BANKING_FINANCIAL" ? "banking-merchant" : "ecommerce-merchant"}` },
        })),
      );
      await this.audit.record(actor, { action: "merchant.request_info", entityType: "merchant", entityId: id, data: { previousStatus: m.status } }, meta, tx);
    });
    await this.outbox.flush(outbox);
    this.merchants.publish(id, { status: "INFO_REQUESTED" });
    return this.merchants.detail(id);
  }

  // ───────────── applicant side ─────────────

  /** The applicant's view: status, rejection reason and the conversation with Delivery Fast. */
  async myReview(actor: Actor, merchantId: string | undefined) {
    const m = await this.merchants.resolveOwn(actor, merchantId);
    const messages = await this.prisma.merchantNote.findMany({ where: { merchantId: m.id, internal: false }, orderBy: { createdAt: "asc" }, take: 200 });
    return {
      merchantId: m.id,
      status: m.status,
      rejectionReason: m.rejectionReason,
      canRespond: m.status === "INFO_REQUESTED",
      messages: messages.map(n => noteView(n, { staff: false })),
    };
  }

  /** Answers an information request; the application goes back to review. */
  async respond(actor: Actor, merchantId: string | undefined, input: z.infer<typeof applicantResponseSchema>, meta: RequestMeta) {
    const m = await this.merchants.resolveOwn(actor, merchantId, { ownerOnly: true });
    await this.prisma.$transaction(async tx => {
      const { count } = await tx.merchant.updateMany({ where: { id: m.id, status: "INFO_REQUESTED" }, data: { status: "PENDING_REVIEW" } });
      if (!count) throw conflict("NO_INFO_REQUESTED", "Delivery Fast hasn't asked for more information");
      await tx.merchantNote.create({ data: { merchantId: m.id, kind: "APPLICANT_RESPONSE", body: input.message, internal: false, authorId: userOf(actor), authorName: actorLabel(actor) } });
      await this.audit.record(actor, { action: "merchant.applicant_response", entityType: "merchant", entityId: m.id, data: {} }, meta, tx);
    });
    this.merchants.publish(m.id, { status: "PENDING_REVIEW" });
    return this.myReview(actor, m.id);
  }

  // ───────────── notes ─────────────

  async notes(id: string, query: z.infer<typeof pageWithSelectorSchema>) {
    if (!(await this.prisma.merchant.findUnique({ where: { id }, select: { id: true } }))) throw notFound("Merchant");
    const rows = await this.prisma.merchantNote.findMany({ where: { merchantId: id }, ...pageArgs(query) });
    const page = toPage(rows, query.limit);
    return { items: page.items.map(n => noteView(n, { staff: true })), nextCursor: page.nextCursor };
  }

  async addNote(actor: Actor, id: string, input: z.infer<typeof merchantNoteSchema>, meta: RequestMeta) {
    if (!(await this.prisma.merchant.findUnique({ where: { id }, select: { id: true } }))) throw notFound("Merchant");
    const note = await this.prisma.$transaction(async tx => {
      const created = await tx.merchantNote.create({ data: { merchantId: id, kind: "NOTE", body: input.body, internal: true, authorId: userOf(actor), authorName: actorLabel(actor) } });
      await this.audit.record(actor, { action: "merchant.note", entityType: "merchant", entityId: id, data: { noteId: created.id } }, meta, tx);
      return created;
    });
    return noteView(note, { staff: true });
  }

  // ───────────── invitations ─────────────

  async invite(actor: Actor, input: z.infer<typeof inviteMerchantSchema>, meta: RequestMeta) {
    const token = randomToken(24);
    const link = `${env().APP_URL.replace(/\/$/, "")}/merchant?invite=${encodeURIComponent(token)}`; // the website's merchant application form
    const outbox: string[] = [];
    const invite = await this.prisma.$transaction(async tx => {
      const open = await tx.merchantInvite.findFirst({
        where: {
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: new Date() },
          OR: [...(input.phone ? [{ phone: input.phone }] : []), ...(input.email ? [{ email: input.email }] : [])],
        },
      });
      if (open) throw conflict("INVITE_PENDING", `${open.name} already has an open invitation (expires ${open.expiresAt.toISOString().slice(0, 10)}). Revoke it to send a new one.`);
      const created = await tx.merchantInvite.create({
        data: {
          name: input.name,
          businessName: input.businessName,
          phone: input.phone,
          email: input.email,
          type: input.type,
          message: input.message,
          tokenHash: sha256(token),
          invitedById: userOf(actor),
          invitedByName: actorLabel(actor),
          expiresAt: new Date(Date.now() + input.expiresInDays * 86_400_000),
        },
      });
      outbox.push(
        ...(await this.notify.notify(tx, {
          event: "account.invite",
          to: { phone: input.phone, email: input.email, name: input.name },
          vars: { inviter: "Delivery Fast", role: `${input.type === "BANKING_FINANCIAL" ? "a Banking & Financial" : "an E-commerce"} merchant${input.businessName ? ` (${input.businessName})` : ""}`, link },
        })),
      );
      await this.audit.record(actor, { action: "merchant.invite", entityType: "merchant_invite", entityId: created.id, data: { name: input.name, type: input.type, phone: input.phone ?? null, email: input.email ?? null } }, meta, tx);
      return created;
    });
    await this.outbox.flush(outbox);
    // The link is returned once so staff can share it another way too.
    return { ...inviteView(invite), link, message: "Invitation sent. The link works once and expires on the date shown." };
  }

  async listInvites(query: z.infer<typeof listInvitesQuerySchema>) {
    const now = new Date();
    const where: Prisma.MerchantInviteWhereInput =
      query.status === "PENDING"
        ? { acceptedAt: null, revokedAt: null, expiresAt: { gt: now } }
        : query.status === "ACCEPTED"
          ? { acceptedAt: { not: null } }
          : query.status === "REVOKED"
            ? { revokedAt: { not: null } }
            : query.status === "EXPIRED"
              ? { acceptedAt: null, revokedAt: null, expiresAt: { lte: now } }
              : {};
    const rows = await this.prisma.merchantInvite.findMany({ where, ...pageArgs(query) });
    const page = toPage(rows, query.limit);
    return { items: page.items.map(inviteView), nextCursor: page.nextCursor };
  }

  async revokeInvite(actor: Actor, id: string, meta: RequestMeta) {
    const invite = await this.prisma.merchantInvite.findUnique({ where: { id } });
    if (!invite) throw notFound("Invitation");
    if (invite.acceptedAt) throw conflict("INVITE_USED", "This invitation was already used");
    if (invite.revokedAt) return inviteView(invite);
    const revoked = await this.prisma.$transaction(async tx => {
      const updated = await tx.merchantInvite.update({ where: { id }, data: { revokedAt: new Date() } });
      await this.audit.record(actor, { action: "merchant.invite_revoke", entityType: "merchant_invite", entityId: id, data: {} }, meta, tx);
      return updated;
    });
    return inviteView(revoked);
  }

  /** Public: what the sign-up page needs to prefill an invited application. */
  async lookupInvite(token: string) {
    const invite = await this.merchants.validInvite(this.prisma, token).catch(error => {
      if (error instanceof AppError) throw new AppError(error.code, error.message, HttpStatus.NOT_FOUND);
      throw error;
    });
    return { name: invite.name, businessName: invite.businessName, type: invite.type, phone: invite.phone, email: invite.email, message: invite.message, expiresAt: invite.expiresAt };
  }
}
