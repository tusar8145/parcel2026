import { HttpStatus, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { PrismaService, type Db } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { RealtimeService } from "../../common/realtime.service";
import { pageArgs, toPage } from "../../common/pagination";
import { AppError, conflict, forbidden, notFound } from "../../common/errors";
import { hasRole, type UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { env } from "../../config/env";
import type { ApplicationStatus, PartnerApplication, Prisma, TicketStatus } from "../../generated/prisma/client";
import { NotifyService } from "../notifications/notify.service";
import { OutboxService } from "../notifications/outbox.service";
import { NetworkService } from "../network/network.service";
import { RiderKycService } from "../rider/kyc.service";
import { STATUS_LABELS, SupportService } from "../support/support.service";
import { grantApplicant, releaseApplicant } from "./applicant-role";
import { OPEN_APPLICATION_STATUSES, type ApplicationInput, type ApplicationKind, type decideApplicationSchema, type listApplicationsQuerySchema } from "./applications.schemas";

/**
 * Rider and franchise applications.
 *
 * Each application is a PartnerApplication with its own lifecycle (submitted → under review →
 * info requested → approved / rejected, or withdrawn by the applicant). The conversation runs
 * on a linked support ticket with the same number, so the applicant follows up from their
 * support page and staff reply with the support desk tools; status steps also move the ticket.
 * Approving a rider application creates the rider (NetworkService.createRider) and starts rider
 * onboarding / KYC (RiderKycService.startOnboarding). Merchant applications have their own
 * lifecycle (POST /merchants/applications).
 * Until approved, the applicant holds the APPLICANT role (applicant-role.ts): their only page is
 * /application (status, the conversation, withdraw), never the website customer area.
 */
const CATEGORY: Record<ApplicationKind, string> = { RIDER: "Rider application", FRANCHISE: "Franchise application" };
const SUBMIT_ACTION = "application.submit";

const VEHICLE_LABELS: Record<string, string> = { MOTORCYCLE: "Motorcycle", BICYCLE: "Bicycle", ON_FOOT: "On foot" };
const RIDER_VEHICLE: Record<string, "MOTORBIKE" | "BICYCLE" | "ON_FOOT"> = { MOTORCYCLE: "MOTORBIKE", BICYCLE: "BICYCLE", ON_FOOT: "ON_FOOT" };
const TERRITORY_LABELS: Record<string, string> = { CITY_ZONE: "City zone", DISTRICT: "District", MULTI_DISTRICT_REGION: "Multi-district region" };
export const APPLICATION_STATUS_LABELS: Record<ApplicationStatus, string> = {
  SUBMITTED: "Submitted",
  UNDER_REVIEW: "Under review",
  INFO_REQUESTED: "Information requested",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  WITHDRAWN: "Withdrawn",
};
/** Which status steps are allowed from where. */
const NEXT: Record<ApplicationStatus, ApplicationStatus[]> = {
  SUBMITTED: ["UNDER_REVIEW", "INFO_REQUESTED", "APPROVED", "REJECTED"],
  UNDER_REVIEW: ["INFO_REQUESTED", "APPROVED", "REJECTED"],
  INFO_REQUESTED: ["UNDER_REVIEW", "APPROVED", "REJECTED"],
  APPROVED: [],
  REJECTED: [],
  WITHDRAWN: [],
};
const TICKET_STATUS: Record<ApplicationStatus, TicketStatus> = {
  SUBMITTED: "OPEN",
  UNDER_REVIEW: "IN_PROGRESS",
  INFO_REQUESTED: "WAITING_FOR_REQUESTER",
  APPROVED: "RESOLVED",
  REJECTED: "RESOLVED",
  WITHDRAWN: "CLOSED",
};

type Details = Omit<ApplicationInput, "kind">;

const applicationInclude = {
  ticket: { select: { id: true, status: true, assignee: { select: { id: true, name: true } }, _count: { select: { messages: { where: { internal: false } } } } } },
} satisfies Prisma.PartnerApplicationInclude;
type ApplicationRow = Prisma.PartnerApplicationGetPayload<{ include: typeof applicationInclude }>;

function summary(input: ApplicationInput) {
  const lines =
    input.kind === "RIDER"
      ? [`Rider application from ${input.name}`, `Phone: ${input.phone}`, input.email && `Email: ${input.email}`, `Preferred work area: ${input.area}`, `Vehicle: ${VEHICLE_LABELS[input.vehicle]}`]
      : [
          `Franchise application from ${input.name}`,
          `Phone: ${input.phone}`,
          input.email && `Email: ${input.email}`,
          `Proposed hub location: ${input.location}`,
          `Preferred territory: ${TERRITORY_LABELS[input.territory]}`,
          input.experience && `Business experience: ${input.experience}`,
        ];
  return lines.filter(Boolean).join("\n");
}

@Injectable()
export class ApplicationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly support: SupportService,
    private readonly network: NetworkService,
    private readonly kyc: RiderKycService,
    private readonly notify: NotifyService,
    private readonly outbox: OutboxService,
    private readonly realtime: RealtimeService,
  ) {}

  async submit(actor: UserActor, input: ApplicationInput, meta: RequestMeta) {
    const category = CATEGORY[input.kind];
    const { number, outboxIds } = await this.prisma.$transaction(async tx => {
      // One open application per person and kind, even when they double-submit.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`partner-application:${input.kind}:${actor.userId}`}))`;
      if (input.kind === "RIDER" && hasRole(actor, "RIDER")) throw conflict("ALREADY_A_RIDER", "You already ride with Paira Express");
      const open = await tx.partnerApplication.findFirst({ where: { applicantId: actor.userId, kind: input.kind, status: { in: [...OPEN_APPLICATION_STATUSES] } }, select: { number: true } });
      if (open) throw conflict("APPLICATION_PENDING", `Your application ${open.number} is still being reviewed`);

      const { kind, ...details } = input;
      const { ticket } = await this.support.openTicket(
        actor,
        { category, subject: `${kind === "RIDER" ? "Rider" : "Franchise"} application · ${input.name}`, priority: "NORMAL", message: summary(input) },
        tx,
      );
      const application = await tx.partnerApplication.create({
        data: { number: ticket.number, kind, applicantId: actor.userId, ticketId: ticket.id, details: details as Prisma.InputJsonObject },
      });
      await grantApplicant(tx, actor.userId);
      await this.audit.record(actor, { action: SUBMIT_ACTION, entityType: "support_ticket", entityId: ticket.id, data: { kind, number: ticket.number, applicationId: application.id, details } }, meta, tx);
      const outboxIds = await this.tell(tx, application, "We received your application and will review it soon.");
      return { number: ticket.number, outboxIds };
    });
    await this.outbox.flush(outboxIds);
    this.publish(number, actor.userId);
    return {
      application: await this.view(await this.find(number)),
      message: `Application ${number} received. Our team will review it and contact you; you can follow up from your support page.`,
    };
  }

  async list(query: z.infer<typeof listApplicationsQuerySchema>) {
    const rows = await this.prisma.partnerApplication.findMany({ where: { kind: query.kind, status: query.status }, include: applicationInclude, ...pageArgs(query) });
    const page = toPage(rows, query.limit);
    return { items: await this.views(page.items), nextCursor: page.nextCursor };
  }

  /** The signed-in user's own applications. */
  async mine(actor: UserActor) {
    const rows = await this.prisma.partnerApplication.findMany({ where: { applicantId: actor.userId }, include: applicationInclude, orderBy: { createdAt: "desc" }, take: 20 });
    return this.views(rows);
  }

  async detail(number: string) {
    return this.view(await this.find(number));
  }

  /** Staff move the application along; the applicant gets the message on their ticket and an SMS/email. */
  async decide(actor: UserActor, number: string, input: z.infer<typeof decideApplicationSchema>, meta: RequestMeta) {
    const app = await this.find(number);
    if (!NEXT[app.status].includes(input.status))
      throw conflict("INVALID_APPLICATION_TRANSITION", `An application that is ${APPLICATION_STATUS_LABELS[app.status].toLowerCase()} can't be marked ${APPLICATION_STATUS_LABELS[input.status].toLowerCase()}`);
    if (input.status === "APPROVED") {
      const needed = app.kind === "RIDER" ? "rider:manage" : "hub:manage";
      if (!actor.permissions.has(needed)) throw forbidden(app.kind === "RIDER" ? "Only operations managers can approve riders" : "Only operations managers can approve franchise partners");
    }

    // Rider approval: create the rider first (NetworkService runs its own transaction).
    let riderId: string | null = null;
    if (input.status === "APPROVED" && app.kind === "RIDER") riderId = await this.ensureRider(actor, app, input, meta);

    const outboxIds = await this.prisma.$transaction(async tx => {
      const now = new Date();
      const decided = input.status === "APPROVED" || input.status === "REJECTED";
      const updated = await tx.partnerApplication.updateMany({
        where: { id: app.id, status: app.status },
        data: {
          status: input.status,
          reviewerId: app.reviewerId ?? actor.userId,
          ...(decided ? { decidedById: actor.userId, decidedAt: now, decisionNote: input.message ?? input.note ?? null } : {}),
          ...(riderId ? { riderId } : {}),
        },
      });
      if (!updated.count) throw conflict("APPLICATION_CHANGED", "This application was just changed by someone else; reload it");
      // An approved rider opens the rider app from now on.
      if (riderId) await releaseApplicant(tx, app.applicantId);

      // The ticket follows the application, with the message to the applicant and a staff note.
      const ticket = await tx.supportTicket.findUniqueOrThrow({ where: { id: app.ticketId } });
      const toTicket = TICKET_STATUS[input.status];
      if (input.message) await tx.ticketMessage.create({ data: { ticketId: ticket.id, authorId: actor.userId, authorLabel: actor.name, body: input.message } });
      await tx.ticketMessage.create({ data: { ticketId: ticket.id, authorId: null, authorLabel: "System", body: `Application ${APPLICATION_STATUS_LABELS[input.status].toLowerCase()}`, internal: false } });
      if (input.note) await tx.ticketMessage.create({ data: { ticketId: ticket.id, authorId: actor.userId, authorLabel: actor.name, body: input.note, internal: true } });
      await tx.supportTicket.update({
        where: { id: ticket.id },
        data: {
          status: toTicket,
          updatedAt: now,
          assigneeId: ticket.assigneeId ?? actor.userId,
          firstResponseAt: ticket.firstResponseAt ?? (input.message ? now : null),
          resolvedAt: toTicket === "RESOLVED" ? now : null,
          slaPausedAt: toTicket === "WAITING_FOR_REQUESTER" || toTicket === "RESOLVED" ? (ticket.slaPausedAt ?? now) : null,
        },
      });

      const ids: string[] = [];
      if (riderId) {
        const { outboxIds: onboarding } = await this.kyc.startOnboarding(tx, { riderId, applicationId: app.id, note: input.note, notifyRider: false });
        ids.push(...onboarding);
      }
      await this.audit.record(actor, { action: "application.status", entityType: "partner_application", entityId: app.id, data: { number: app.number, from: app.status, to: input.status, riderId, message: input.message ?? null } }, meta, tx);
      const details =
        input.status === "APPROVED" && app.kind === "RIDER"
          ? `Welcome aboard! Sign in to the rider app with your phone number and upload your KYC documents.${input.message ? ` ${input.message}` : ""}`
          : (input.message ?? "");
      ids.push(...(await this.tell(tx, { ...app, status: input.status }, details)));
      return ids;
    });
    await this.outbox.flush(outboxIds);
    this.publish(app.number, app.applicantId);
    return this.detail(app.number);
  }

  /** The applicant withdraws an open application. */
  async withdraw(actor: UserActor, number: string, meta: RequestMeta) {
    const app = await this.find(number);
    if (app.applicantId !== actor.userId) throw notFound("Application");
    if (!(OPEN_APPLICATION_STATUSES as readonly string[]).includes(app.status)) throw conflict("INVALID_APPLICATION_TRANSITION", "Only applications still being reviewed can be withdrawn");
    await this.prisma.$transaction(async tx => {
      const updated = await tx.partnerApplication.updateMany({ where: { id: app.id, status: app.status }, data: { status: "WITHDRAWN", decidedAt: new Date() } });
      if (!updated.count) throw conflict("APPLICATION_CHANGED", "This application was just changed; reload it");
      await tx.supportTicket.update({ where: { id: app.ticketId }, data: { status: "CLOSED", updatedAt: new Date() } });
      await tx.ticketMessage.create({ data: { ticketId: app.ticketId, authorId: null, authorLabel: "System", body: "Application withdrawn by the applicant" } });
      await releaseApplicant(tx, actor.userId);
      await this.audit.record(actor, { action: "application.withdraw", entityType: "partner_application", entityId: app.id, data: { number: app.number } }, meta, tx);
    });
    this.publish(app.number, actor.userId);
    return this.detail(app.number);
  }

  /** After a rejection: the applicant closes the application page and uses their account as before. */
  async leave(actor: UserActor, meta: RequestMeta) {
    const released = await this.prisma.$transaction(async tx => {
      const open = await tx.partnerApplication.findFirst({ where: { applicantId: actor.userId, status: { in: [...OPEN_APPLICATION_STATUSES] } }, select: { number: true } });
      if (open) throw conflict("APPLICATION_PENDING", `Your application ${open.number} is still being reviewed; withdraw it first`);
      const done = await releaseApplicant(tx, actor.userId);
      if (done) await this.audit.record(actor, { action: "application.leave", entityType: "user", entityId: actor.userId }, meta, tx);
      return done;
    });
    return { released };
  }

  // ───────────── helpers ─────────────

  private async ensureRider(actor: UserActor, app: PartnerApplication, input: z.infer<typeof decideApplicationSchema>, meta: RequestMeta) {
    const applicant = await this.prisma.user.findUniqueOrThrow({ where: { id: app.applicantId }, include: { rider: true } });
    if (applicant.rider) return applicant.rider.id;
    const d = app.details as { name?: string; email?: string; vehicle?: string; area?: string };
    try {
      const rider = await this.network.createRider(
        actor,
        { name: applicant.name ?? d.name ?? "Rider", phone: applicant.phone, email: applicant.email ?? undefined, hubId: input.hubId, vehicle: RIDER_VEHICLE[d.vehicle ?? ""] ?? "MOTORBIKE", zone: input.zone ?? d.area },
        meta,
      );
      return (rider as { id: string }).id;
    } catch (err) {
      // A concurrent approval created it first.
      const again = await this.prisma.rider.findUnique({ where: { userId: app.applicantId }, select: { id: true } });
      if (again) return again.id;
      throw err instanceof AppError ? err : new AppError("RIDER_CREATE_FAILED", "Couldn't create the rider account", HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  private async find(number: string) {
    const app = await this.prisma.partnerApplication.findUnique({ where: { number: number.toUpperCase() }, include: applicationInclude });
    if (!app) throw notFound("Application");
    return app;
  }

  private tell(db: Db, app: Pick<PartnerApplication, "kind" | "number" | "applicantId" | "status">, details: string) {
    const status = APPLICATION_STATUS_LABELS[app.status];
    return app.kind === "RIDER"
      ? this.notify.notify(db, { event: "rider.application_status", to: { userId: app.applicantId }, vars: { status, details } })
      : this.notify.notify(db, { event: "partner.application_status", to: { userId: app.applicantId }, vars: { number: app.number, status, details, link: `${env().APP_URL}/application` } });
  }

  private publish(number: string, applicantId: string) {
    this.realtime.publish({ type: "application.updated", id: number, userIds: [applicantId], staffPermission: "support:manage" });
    void this.support.publish(number);
  }

  private async views(rows: ApplicationRow[]) {
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(rows.flatMap(r => [r.applicantId, r.reviewerId, r.decidedById]).filter((x): x is string => !!x))] } },
      select: { id: true, name: true, phone: true, email: true },
    });
    return rows.map(r => this.shape(r, users));
  }

  private async view(row: ApplicationRow) {
    return (await this.views([row]))[0];
  }

  private shape(r: ApplicationRow, users: { id: string; name: string; phone: string; email: string | null }[]) {
    const user = (id: string | null) => users.find(u => u.id === id) ?? null;
    const reviewer = user(r.reviewerId);
    const decidedBy = user(r.decidedById);
    return {
      id: r.ticketId,
      applicationId: r.id,
      number: r.number,
      kind: r.kind,
      status: r.status,
      statusLabel: APPLICATION_STATUS_LABELS[r.status],
      ticketStatus: r.ticket.status,
      ticketStatusLabel: STATUS_LABELS[r.ticket.status],
      applicant: user(r.applicantId),
      details: r.details as Details,
      assignee: r.ticket.assignee,
      reviewer: reviewer && { id: reviewer.id, name: reviewer.name },
      decidedBy: decidedBy && { id: decidedBy.id, name: decidedBy.name },
      decisionNote: r.decisionNote,
      decidedAt: r.decidedAt,
      riderId: r.riderId,
      messageCount: r.ticket._count.messages,
      allowedNext: NEXT[r.status],
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }
}
