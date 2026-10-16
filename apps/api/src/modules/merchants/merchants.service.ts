import { HttpStatus, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { PrismaService, type Db } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { RealtimeService } from "../../common/realtime.service";
import { nextCounter } from "../../common/counters";
import { sha256 } from "../../common/crypto";
import { AppError, conflict, forbidden, notFound } from "../../common/errors";
import { pageArgs, toPage } from "../../common/pagination";
import { actorLabel, merchantIdsOf, type Actor, type UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { env } from "../../config/env";
import { Prisma, type Role } from "../../generated/prisma/client";
import { NotifyService } from "../notifications/notify.service";
import { OutboxService } from "../notifications/outbox.service";
import { SessionService } from "../auth/session.service";
import { memberInclude, memberView, merchantView } from "./merchant.views";
import type { MerchantKycService } from "./merchant-kyc.service";
import type {
  addMemberSchema,
  adminUpdateMerchantSchema,
  listMerchantsQuerySchema,
  merchantApplicationSchema,
  pageWithSelectorSchema,
  updateMyMerchantSchema,
} from "./merchants.schemas";

const MERCHANT_ROLES: Role[] = ["MERCHANT_OWNER", "MERCHANT_STAFF"];
/** An application still being decided: the applicant can't open another one. */
export const OPEN_APPLICATION_STATUSES = ["PENDING_REVIEW", "INFO_REQUESTED"] as const;

/** Serialises concurrent writes that check-then-insert (limits, last owner, one open application). */
export const advisoryLock = (db: Db, key: string) => db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;

const ROLES_REFRESH_MESSAGE =
  "Application received. We'll review it and text you when it's approved. Your merchant access appears after you next refresh your session or sign in.";

const loginLink = () => `${env().APP_URL}/#/login`;
const payoutLabel = (p: { method: string; accountNumber: string }) => `${{ BKASH: "bKash", NAGAD: "Nagad", BANK: "Bank" }[p.method] ?? p.method} ••••${p.accountNumber.slice(-4)}`;

@Injectable()
export class MerchantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notify: NotifyService,
    private readonly outbox: OutboxService,
    private readonly sessions: SessionService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Set by MerchantKycService (avoids a constructor cycle). */
  kyc?: MerchantKycService;

  // ───────────── access ─────────────

  /**
   * The merchant a member is acting for, from their token's role grants (re-checked in the
   * database). Members of several merchants must pass merchantId. API keys act for their
   * own merchant (only on routes that accept keys, e.g. webhooks with webhooks:manage).
   */
  async resolveOwn(actor: Actor, merchantId: string | undefined, opts: { ownerOnly?: boolean } = {}) {
    if (actor.kind === "api_key") {
      if (merchantId && merchantId !== actor.merchantId) throw forbidden("This API key belongs to another merchant");
      const merchant = await this.prisma.merchant.findUnique({ where: { id: actor.merchantId }, include: { plan: true } });
      if (!merchant) throw notFound("Merchant");
      return merchant;
    }
    const memberOf = [...new Set(merchantIdsOf(actor))];
    if (!memberOf.length) throw forbidden("You're not a member of a merchant account");
    let id = merchantId;
    if (id) {
      if (!memberOf.includes(id)) throw forbidden("You're not a member of this merchant");
    } else {
      if (memberOf.length > 1)
        throw new AppError("MERCHANT_REQUIRED", "You belong to several merchants. Choose one with ?merchantId=", HttpStatus.UNPROCESSABLE_ENTITY, { merchantIds: memberOf });
      id = memberOf[0];
    }
    const allowed: Role[] = opts.ownerOnly ? ["MERCHANT_OWNER"] : MERCHANT_ROLES;
    const grant = await this.prisma.userRole.findFirst({ where: { userId: actor.userId, merchantId: id, role: { in: allowed } }, select: { id: true } });
    if (!grant) throw forbidden(opts.ownerOnly ? "Only merchant owners can do this" : "You're not a member of this merchant");
    const merchant = await this.prisma.merchant.findUnique({ where: { id }, include: { plan: true } });
    if (!merchant) throw notFound("Merchant");
    return merchant;
  }

  /** Live update for staff lists and the merchant's own members. */
  publish(merchantId: string, data: Record<string, unknown> = {}) {
    this.realtime.publish({ type: "merchant.updated", id: merchantId, merchantId, staffPermission: "merchant:read:any", data });
  }

  // ───────────── onboarding ─────────────

  async apply(actor: UserActor, input: z.infer<typeof merchantApplicationSchema>, meta: RequestMeta) {
    const { inviteToken, ...fields } = input;
    const outbox: string[] = [];
    const merchant = await this.prisma.$transaction(async tx => {
      await advisoryLock(tx, `merchant-application:${actor.userId}`);
      const open = await tx.userRole.findFirst({
        where: { userId: actor.userId, role: "MERCHANT_OWNER", merchant: { status: { in: [...OPEN_APPLICATION_STATUSES] } } },
        include: { merchant: { select: { code: true } } },
      });
      if (open) throw conflict("APPLICATION_PENDING", `Your application ${open.merchant!.code} is still being reviewed`);
      const invite = inviteToken ? await this.validInvite(tx, inviteToken) : null;
      const code = await this.nextMerchantCode(tx);
      const created = await tx.merchant.create({
        data: { ...fields, code, status: "PENDING_REVIEW", members: { create: { userId: actor.userId, role: "MERCHANT_OWNER" } } },
        include: { plan: true },
      });
      if (invite) await tx.merchantInvite.update({ where: { id: invite.id }, data: { acceptedAt: new Date(), merchantId: created.id } });
      outbox.push(
        ...(await this.notify.notify(tx, {
          event: "merchant.application_received",
          to: { userId: actor.userId, phone: created.contactPhone, email: created.contactEmail, name: created.contactName },
          vars: { businessName: created.name, reference: code },
        })),
      );
      await this.audit.record(
        actor,
        { action: "merchant.apply", entityType: "merchant", entityId: created.id, data: { code, type: input.type, name: input.name, inviteId: invite?.id ?? null } },
        meta,
        tx,
      );
      return created;
    });
    await this.outbox.flush(outbox);
    this.publish(merchant.id, { status: merchant.status });
    return { merchant: merchantView(merchant), message: ROLES_REFRESH_MESSAGE };
  }

  /** An unexpired, unused invitation for this link token (or a clear error). */
  async validInvite(db: Db, token: string) {
    const invite = await db.merchantInvite.findUnique({ where: { tokenHash: sha256(token) } });
    if (!invite || invite.revokedAt) throw new AppError("INVITE_INVALID", "This invitation link isn't valid. Ask Delivery Fast for a new one.", HttpStatus.UNPROCESSABLE_ENTITY);
    if (invite.acceptedAt) throw new AppError("INVITE_USED", "This invitation was already used", HttpStatus.CONFLICT);
    if (invite.expiresAt < new Date()) throw new AppError("INVITE_EXPIRED", "This invitation has expired. Ask Delivery Fast for a new one.", HttpStatus.UNPROCESSABLE_ENTITY);
    return invite;
  }

  /** MR-1001, MR-1002…; skips codes already taken (e.g. imported merchants). */
  private async nextMerchantCode(tx: Db) {
    for (let i = 0; i < 100; i++) {
      const code = `MR-${await nextCounter(tx, "merchant-code", 1000)}`;
      if (!(await tx.merchant.findUnique({ where: { code }, select: { id: true } }))) return code;
    }
    throw new Error("Could not allocate a merchant code");
  }

  // ───────────── administration ─────────────

  async list(query: z.infer<typeof listMerchantsQuerySchema>) {
    const q = query.q;
    const rows = await this.prisma.merchant.findMany({
      where: {
        status: query.status,
        type: query.type,
        kycStatus: query.kycStatus,
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: "insensitive" } },
                { code: { contains: q, mode: "insensitive" } },
                { contactName: { contains: q, mode: "insensitive" } },
                { contactEmail: { contains: q, mode: "insensitive" } },
                { contactPhone: { contains: q.replace(/\D/g, "").slice(-10) || q } },
              ],
            }
          : {}),
      },
      include: { plan: true, _count: { select: { parcels: true } } },
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { items: page.items.map(m => ({ ...merchantView(m), parcelCount: m._count.parcels })), nextCursor: page.nextCursor };
  }

  async detail(id: string) {
    const m = await this.prisma.merchant.findUnique({
      where: { id },
      include: {
        plan: true,
        members: { where: { role: { in: MERCHANT_ROLES } }, include: memberInclude, orderBy: { createdAt: "asc" } },
        _count: { select: { parcels: true, apiKeys: { where: { revokedAt: null } }, webhooks: true, settlements: true, invoices: true, tickets: true, notes: true } },
      },
    });
    if (!m) throw notFound("Merchant");
    const members = m.members.map(memberView);
    return {
      ...merchantView(m),
      owners: members.filter(r => r.role === "MERCHANT_OWNER"),
      staff: members.filter(r => r.role === "MERCHANT_STAFF"),
      counts: {
        parcels: m._count.parcels,
        activeApiKeys: m._count.apiKeys,
        webhooks: m._count.webhooks,
        settlements: m._count.settlements,
        invoices: m._count.invoices,
        tickets: m._count.tickets,
        notes: m._count.notes,
      },
    };
  }

  async adminUpdate(actor: Actor, id: string, input: z.infer<typeof adminUpdateMerchantSchema>, meta: RequestMeta) {
    const outbox: string[] = [];
    await this.prisma.$transaction(async tx => {
      const current = await tx.merchant.findUnique({ where: { id } });
      if (!current) throw notFound("Merchant");
      if (input.planId) {
        const plan = await tx.servicePlan.findUnique({ where: { id: input.planId } });
        if (!plan) throw notFound("Service plan");
        if (plan.segment !== current.type)
          throw new AppError("PLAN_SEGMENT_MISMATCH", `The ${plan.name} plan is for ${plan.segment} merchants, but this merchant is ${current.type}`, HttpStatus.UNPROCESSABLE_ENTITY);
        if (!plan.active && plan.id !== current.planId) throw new AppError("PLAN_INACTIVE", `The ${plan.name} plan is no longer offered`, HttpStatus.UNPROCESSABLE_ENTITY);
      }
      const approved = input.status === "ACTIVE" && current.status !== "ACTIVE";
      if (approved && current.status !== "SUSPENDED") await this.kyc?.assertAllowed(tx, current, "activation");
      const data: Prisma.MerchantUpdateInput = { ...input };
      if (input.status && input.status !== "SUSPENDED") data.rejectionReason = null;
      const updated = await tx.merchant.update({ where: { id }, data });
      if (approved)
        outbox.push(
          ...(await this.notify.notify(tx, {
            event: "merchant.approved",
            to: { phone: updated.contactPhone, email: updated.contactEmail, name: updated.contactName },
            vars: { businessName: `${updated.name} (${updated.code})`, link: loginLink() },
          })),
        );
      const action = approved ? "merchant.approve" : input.status === "SUSPENDED" && current.status !== "SUSPENDED" ? "merchant.suspend" : "merchant.update";
      if (input.status && input.status !== current.status)
        await tx.merchantNote.create({
          data: {
            merchantId: id,
            kind: "STATUS_CHANGE",
            internal: true,
            body: `Status changed from ${current.status} to ${input.status}`,
            authorId: actor.kind === "user" ? actor.userId : null,
            authorName: actorLabel(actor),
          },
        });
      await this.audit.record(actor, { action, entityType: "merchant", entityId: id, data: { changes: input, previousStatus: current.status } }, meta, tx);
    });
    await this.outbox.flush(outbox);
    this.publish(id, { status: input.status });
    return this.detail(id);
  }

  // ───────────── self-service ─────────────

  async mine(actor: Actor, merchantId: string | undefined) {
    const m = await this.resolveOwn(actor, merchantId);
    const role = (actor as UserActor).roles.find(r => r.merchantId === m.id && r.role === "MERCHANT_OWNER") ? "MERCHANT_OWNER" : "MERCHANT_STAFF";
    return { ...merchantView(m), myRole: role };
  }

  async updateMine(actor: Actor, merchantId: string | undefined, input: z.infer<typeof updateMyMerchantSchema>, meta: RequestMeta) {
    const current = await this.resolveOwn(actor, merchantId, { ownerOnly: true });
    const { payoutAccount, name, ...rest } = input;
    // The business name is reviewed: applicants may correct it until they're approved.
    if (name !== undefined && !(OPEN_APPLICATION_STATUSES as readonly string[]).includes(current.status))
      throw new AppError("NAME_LOCKED", "The business name can only change while the application is being reviewed. Contact support to rename an approved account.", HttpStatus.UNPROCESSABLE_ENTITY);
    const outbox: string[] = [];
    const merchant = await this.prisma.$transaction(async tx => {
      const updated = await tx.merchant.update({
        where: { id: current.id },
        data: { ...rest, ...(name !== undefined ? { name } : {}), ...(payoutAccount !== undefined ? { payoutAccount: payoutAccount === null ? Prisma.DbNull : payoutAccount } : {}) },
        include: { plan: true },
      });
      if (payoutAccount !== undefined)
        // Payout changes are a fraud target: tell the existing contact number.
        outbox.push(
          ...(await this.notify.notify(tx, {
            event: "merchant.payout_account_changed",
            to: { phone: current.contactPhone, email: current.contactEmail, name: current.contactName },
            vars: { businessName: `${current.name} (${current.code})`, account: payoutAccount ? payoutLabel(payoutAccount) : "none (removed)" },
          })),
        );
      const changes = {
        ...rest,
        ...(name !== undefined ? { name } : {}),
        ...(payoutAccount !== undefined ? { payoutAccount: payoutAccount ? { method: payoutAccount.method, accountLast4: payoutAccount.accountNumber.slice(-4) } : null } : {}),
      };
      await this.audit.record(actor, { action: "merchant.self_update", entityType: "merchant", entityId: current.id, data: changes }, meta, tx);
      return updated;
    });
    await this.outbox.flush(outbox);
    this.publish(current.id);
    return { ...merchantView(merchant), myRole: "MERCHANT_OWNER" };
  }

  // ───────────── members ─────────────

  async listMembers(actor: Actor, query: z.infer<typeof pageWithSelectorSchema>) {
    const m = await this.resolveOwn(actor, query.merchantId, { ownerOnly: true });
    const rows = await this.prisma.userRole.findMany({ where: { merchantId: m.id, role: { in: MERCHANT_ROLES } }, include: memberInclude, ...pageArgs(query) });
    const page = toPage(rows, query.limit);
    return { items: page.items.map(memberView), nextCursor: page.nextCursor };
  }

  async addMember(actor: Actor, merchantId: string | undefined, input: z.infer<typeof addMemberSchema>, meta: RequestMeta) {
    const m = await this.resolveOwn(actor, merchantId, { ownerOnly: true });
    const outbox: string[] = [];
    const result = await this.prisma.$transaction(async tx => {
      await advisoryLock(tx, `merchant-members:${m.id}`);
      const existing = await tx.user.findUnique({ where: { phone: input.phone }, include: { roles: { where: { merchantId: m.id, role: { in: MERCHANT_ROLES } } } } });
      if (existing?.roles.length) throw conflict("ALREADY_A_MEMBER", `${existing.name} is already a member of ${m.name}`);
      if (existing && existing.status !== "ACTIVE") throw new AppError("USER_INACTIVE", "This person's account is suspended or deactivated", HttpStatus.UNPROCESSABLE_ENTITY);
      const user = existing ?? (await tx.user.create({ data: { name: input.name, phone: input.phone } }));
      const grant = await tx.userRole.create({ data: { userId: user.id, role: input.role, merchantId: m.id }, include: memberInclude });
      const roleLabel = input.role === "MERCHANT_OWNER" ? "an owner" : "a team member";
      outbox.push(
        ...(await this.notify.notify(
          tx,
          existing
            ? { event: "merchant.member_added", to: { userId: user.id, phone: input.phone, name: user.name }, vars: { businessName: m.name, role: roleLabel, link: loginLink() } }
            : { event: "account.invite", to: { userId: user.id, phone: input.phone, name: input.name }, vars: { inviter: m.name, role: `${roleLabel} of ${m.name}`, link: loginLink() } },
        )),
      );
      await this.audit.record(actor, { action: "merchant.member_add", entityType: "merchant", entityId: m.id, data: { userRoleId: grant.id, userId: user.id, role: input.role, invited: !existing } }, meta, tx);
      return { member: memberView(grant), invited: !existing };
    });
    await this.outbox.flush(outbox);
    return result;
  }

  async removeMember(actor: Actor, merchantId: string | undefined, userRoleId: string, meta: RequestMeta) {
    const m = await this.resolveOwn(actor, merchantId, { ownerOnly: true });
    const removed = await this.prisma.$transaction(async tx => {
      await advisoryLock(tx, `merchant-members:${m.id}`);
      const grant = await tx.userRole.findFirst({ where: { id: userRoleId, merchantId: m.id, role: { in: MERCHANT_ROLES } } });
      if (!grant) throw notFound("Member");
      if (grant.role === "MERCHANT_OWNER" && (await tx.userRole.count({ where: { merchantId: m.id, role: "MERCHANT_OWNER" } })) <= 1)
        throw new AppError("LAST_OWNER", "A merchant needs at least one owner. Add another owner first.", HttpStatus.UNPROCESSABLE_ENTITY);
      await tx.userRole.delete({ where: { id: grant.id } });
      await this.audit.record(actor, { action: "merchant.member_remove", entityType: "merchant", entityId: m.id, data: { userRoleId: grant.id, userId: grant.userId, role: grant.role } }, meta, tx);
      return grant;
    });
    // Their access tokens still carry the role: end every session so it can't be used.
    await this.sessions.revokeAllForUser(removed.userId, "merchant_access_removed");
  }
}

