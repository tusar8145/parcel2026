import { HttpStatus, Injectable } from "@nestjs/common";
import { hashPassword } from "../../common/crypto";
import { inviteMessage } from "../notifications/account-invite";
import type { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { AppError, conflict, notFound } from "../../common/errors";
import type { Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { nextCounter } from "../../common/counters";
import { env } from "../../config/env";
import { Prisma } from "../../generated/prisma/client";
import { SessionService } from "../auth/session.service";
import { NotifyService } from "../notifications/notify.service";
import { FRANCHISE_CONFIG_KEY, readFranchiseConfig } from "./franchise-config";
import type { createFranchiseSchema, franchiseAccountSchema, franchiseStatusSchema, updateFranchiseConfigSchema, updateFranchiseSchema } from "./franchise.schemas";
import { releaseApplicant } from "../applications/applicant-role";
import { centralHubId } from "../money/accounts-config";

/** Roles whose account is managed in Admin users & roles, not from a franchise. */
const STAFF_ROLES = new Set<string>(["SUPER_ADMIN", "OPS_MANAGER", "HUB_OPERATOR", "FINANCE", "SUPPORT_AGENT"]);

const n = (v: Prisma.Decimal | number | null | undefined) => (v == null ? 0 : Number(v));

export const franchiseInclude = {
  hub: { select: { id: true, code: true, name: true, district: true, zone: true, address: true, active: true, type: true } },
  owner: { select: { id: true, name: true, phone: true, email: true, status: true, lastLoginAt: true } },
} satisfies Prisma.FranchiseInclude;
type FranchiseRow = Prisma.FranchiseGetPayload<{ include: typeof franchiseInclude }>;

export function franchiseView(f: FranchiseRow) {
  return {
    id: f.id,
    code: f.code,
    name: f.name,
    status: f.status,
    contactName: f.contactName,
    contactPhone: f.contactPhone,
    contactEmail: f.contactEmail,
    hub: f.hub,
    owner: f.owner,
    applicationId: f.applicationId,
    rates: {
      pickupPercent: n(f.pickupPercent),
      pickupMin: n(f.pickupMin),
      deliveryPercent: n(f.deliveryPercent),
      deliveryMin: n(f.deliveryMin),
      returnPercent: n(f.returnPercent),
      returnMin: n(f.returnMin),
    },
    riderRates: { pickup: n(f.riderPickupRate), delivery: n(f.riderDeliveryRate), return: n(f.riderReturnRate) },
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  };
}

/**
 * Super admin side of franchise hubs: create a franchise (its hub — Hub.type FRANCHISE — and its one account, Role
 * FRANCHISE scoped to that hub), commission rates, suspend / reactivate (the account and its riders can't sign in;
 * the hub stops taking new work) and the global settlement settings. See franchise-commission.ts for commission.
 */
@Injectable()
export class FranchiseAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    private readonly notify: NotifyService,
  ) {}

  async list() {
    const rows = await this.prisma.franchise.findMany({ include: franchiseInclude, orderBy: { createdAt: "desc" } });
    const unsettled = await this.prisma.franchiseCommission.groupBy({ by: ["franchiseId"], where: { invoiceId: null, remittanceId: null }, _sum: { amount: true } });
    const riders = await this.prisma.rider.groupBy({ by: ["hubId"], where: { hubId: { in: rows.map(r => r.hubId) } }, _count: { _all: true } });
    return rows.map(r => ({
      ...franchiseView(r),
      riders: riders.find(x => x.hubId === r.hubId)?._count._all ?? 0,
      unsettledCommission: n(unsettled.find(u => u.franchiseId === r.id)?._sum.amount),
    }));
  }

  async get(id: string) {
    const f = await this.prisma.franchise.findUnique({ where: { id }, include: franchiseInclude });
    if (!f) throw notFound("Franchise");
    return franchiseView(f);
  }

  /** Approved franchise applications without a franchise yet (super admin "Create from application"). */
  async pendingApplications() {
    const apps = await this.prisma.partnerApplication.findMany({ where: { kind: "FRANCHISE", status: "APPROVED" }, orderBy: { createdAt: "desc" }, take: 100 });
    const used = new Set((await this.prisma.franchise.findMany({ where: { applicationId: { in: apps.map(a => a.id) } }, select: { applicationId: true } })).map(f => f.applicationId));
    const users = await this.prisma.user.findMany({ where: { id: { in: apps.map(a => a.applicantId) } }, select: { id: true, name: true, phone: true, email: true } });
    return apps
      .filter(a => !used.has(a.id))
      .map(a => ({ id: a.id, number: a.number, applicant: users.find(u => u.id === a.applicantId) ?? null, details: a.details, createdAt: a.createdAt }));
  }

  async create(actor: Actor, input: z.infer<typeof createFranchiseSchema>, meta: RequestMeta) {
    const outcome = await this.prisma.$transaction(async tx => {
      let ownerId: string;
      let invited = false;
      if (input.applicationId) {
        const app = await tx.partnerApplication.findUnique({ where: { id: input.applicationId } });
        if (!app || app.kind !== "FRANCHISE") throw notFound("Franchise application");
        if (app.status !== "APPROVED") throw new AppError("APPLICATION_NOT_APPROVED", "Approve the application first", HttpStatus.UNPROCESSABLE_ENTITY);
        ownerId = app.applicantId;
      } else {
        if (!input.phone) throw new AppError("PHONE_REQUIRED", "Enter the franchise account's mobile number", HttpStatus.UNPROCESSABLE_ENTITY, { field: "phone" });
        const existing = await tx.user.findUnique({ where: { phone: input.phone }, select: { id: true } });
        if (existing) ownerId = existing.id;
        else {
          if (input.email && (await tx.user.findUnique({ where: { email: input.email }, select: { id: true } })))
            throw conflict("EMAIL_IN_USE", "This email address is already used by another account");
          ownerId = (
            await tx.user.create({ data: { name: input.contactName, phone: input.phone, email: input.email, ...(input.password ? { passwordHash: await hashPassword(input.password) } : {}) }, select: { id: true } })
          ).id;
          invited = true;
        }
      }
      if (await tx.franchise.findUnique({ where: { ownerId }, select: { id: true } })) throw conflict("ALREADY_FRANCHISE", "This account already runs a franchise");
      const owner = await tx.user.findUniqueOrThrow({ where: { id: ownerId }, select: { id: true, name: true, phone: true, email: true, status: true } });
      if (owner.status !== "ACTIVE") throw new AppError("USER_INACTIVE", "This account is suspended or deactivated", HttpStatus.UNPROCESSABLE_ENTITY);

      const seq = await nextCounter(tx, "franchise");
      const code = `FR-${1000 + seq}`;
      let hub: { id: string; code: string };
      if (input.hubId) {
        // An existing hub tagged as a franchise hub: it works as one from now on (its riders are the franchise's riders).
        const existing = await tx.hub.findUnique({ where: { id: input.hubId }, select: { id: true, code: true, name: true, type: true, active: true } });
        if (!existing) throw notFound("Hub");
        if (!existing.active) throw new AppError("HUB_INACTIVE", `${existing.name} isn't operating`, HttpStatus.UNPROCESSABLE_ENTITY, { field: "hubId" });
        if (existing.type === "FRANCHISE" || (await tx.franchise.findUnique({ where: { hubId: existing.id }, select: { id: true } })))
          throw conflict("ALREADY_FRANCHISE_HUB", `${existing.name} is already a franchise hub`);
        if ((await centralHubId(tx)) === existing.id) throw new AppError("CENTRAL_HUB", `${existing.name} is the central hub: it can't be a franchise`, HttpStatus.UNPROCESSABLE_ENTITY, { field: "hubId" });
        hub = await tx.hub.update({ where: { id: existing.id }, data: { type: "FRANCHISE" }, select: { id: true, code: true } });
      } else {
        const h = input.hub!;
        const hubCode = h.code ?? `FRH-${1000 + seq}`;
        if (await tx.hub.findUnique({ where: { code: hubCode }, select: { id: true } })) throw conflict("HUB_CODE_TAKEN", `Hub code ${hubCode} is taken`);
        const clash = await tx.hub.findFirst({ where: { name: { equals: h.name.trim(), mode: "insensitive" } }, select: { code: true } });
        if (clash) throw new AppError("HUB_NAME_TAKEN", `Hub ${clash.code} already has the name ${h.name.trim()}`, HttpStatus.CONFLICT, { field: "hub.name" });
        hub = await tx.hub.create({
          data: { code: hubCode, name: h.name, district: h.district, zone: h.zone ?? null, address: h.address, lat: h.lat ?? null, lng: h.lng ?? null, type: "FRANCHISE" },
          select: { id: true, code: true },
        });
      }
      const hubCode = hub.code;
      const franchise = await tx.franchise.create({
        data: {
          code,
          hubId: hub.id,
          ownerId,
          name: input.name,
          contactName: input.contactName,
          contactPhone: owner.phone,
          contactEmail: input.email ?? owner.email,
          applicationId: input.applicationId ?? null,
          ...input.rates,
        },
        include: franchiseInclude,
      });
      await tx.userRole.create({ data: { userId: ownerId, role: "FRANCHISE", hubId: hub.id } });
      // The application page closes: the owner now opens the franchise panel.
      await releaseApplicant(tx, ownerId);
      await this.audit.record(actor, { action: "franchise.create", entityType: "franchise", entityId: franchise.id, data: { code, hubId: hub.id, hubCode, taggedExistingHub: !!input.hubId, ownerId, applicationId: input.applicationId ?? null, rates: input.rates } }, meta, tx);
      return { franchise, owner, invited };
    });
    // The account's sessions carry their roles: end them so the next sign-in opens the franchise panel.
    await this.sessions.revokeAllForUser(outcome.owner.id, "role_change").catch(() => undefined);
    // The sign-in message only when the form asked for it (it shows the text first).
    let messageSent = false;
    if (input.sendSms) {
      const { event, vars } = inviteMessage("franchise", { inviter: actor.kind === "user" ? actor.name : "Delivery Fast", name: outcome.owner.name ?? input.contactName, franchiseName: outcome.franchise.name, hubName: outcome.franchise.hub.name });
      messageSent = (await this.notify.notifyNow({ event, to: { userId: outcome.owner.id, phone: outcome.owner.phone, email: outcome.owner.email, name: outcome.owner.name }, vars }).catch(() => [])).length > 0;
    }
    return { ...franchiseView(outcome.franchise), messageSent, newAccount: outcome.invited, passwordSet: outcome.invited && !!input.password };
  }

  async update(actor: Actor, id: string, input: z.infer<typeof updateFranchiseSchema>, meta: RequestMeta) {
    const updated = await this.prisma.$transaction(async tx => {
      const before = await tx.franchise.findUnique({ where: { id } });
      if (!before) throw notFound("Franchise");
      const f = await tx.franchise.update({
        where: { id },
        data: { name: input.name, contactName: input.contactName, contactEmail: input.contactEmail === undefined ? undefined : input.contactEmail, ...(input.rates ?? {}) },
        include: franchiseInclude,
      });
      await this.audit.record(actor, { action: "franchise.update", entityType: "franchise", entityId: id, data: { ...input } }, meta, tx);
      return f;
    });
    return franchiseView(updated);
  }

  /**
   * The franchise's sign-in account: name, mobile, email (the franchise's contact details follow) and a new password.
   * A new password or mobile signs the account out everywhere. An account that also has staff access is changed in
   * Admin users & roles instead.
   */
  async updateAccount(actor: Actor, id: string, input: z.infer<typeof franchiseAccountSchema>, meta: RequestMeta) {
    const { franchise, signOut } = await this.prisma.$transaction(async tx => {
      const f = await tx.franchise.findUnique({ where: { id }, select: { id: true, ownerId: true, owner: { select: { phone: true, email: true, roles: { select: { role: true } } } } } });
      if (!f) throw notFound("Franchise");
      if (f.owner.roles.some(r => STAFF_ROLES.has(r.role)))
        throw new AppError("STAFF_ACCOUNT", "This account also has staff access: change it in Admin users & roles", HttpStatus.UNPROCESSABLE_ENTITY);
      const phone = input.phone && input.phone !== f.owner.phone ? input.phone : undefined;
      const email = input.email !== undefined && input.email !== f.owner.email ? input.email : undefined;
      if (phone && (await tx.user.findUnique({ where: { phone }, select: { id: true } }))) throw conflict("PHONE_IN_USE", "Another account uses this mobile number");
      if (email && (await tx.user.findUnique({ where: { email }, select: { id: true } }))) throw conflict("EMAIL_IN_USE", "Another account uses this email address");
      await tx.user.update({
        where: { id: f.ownerId },
        data: {
          name: input.name,
          phone,
          email,
          ...(phone ? { phoneVerifiedAt: null } : {}),
          ...(input.password ? { passwordHash: await hashPassword(input.password), failedLoginCount: 0, lockedUntil: null } : {}),
        },
      });
      const updated = await tx.franchise.update({
        where: { id },
        data: { contactName: input.name, contactPhone: phone, contactEmail: email },
        include: franchiseInclude,
      });
      // Never the password itself in the log.
      await this.audit.record(actor, { action: "franchise.account_update", entityType: "franchise", entityId: id, data: { userId: f.ownerId, name: input.name, phone, email, newPassword: !!input.password } }, meta, tx);
      return { franchise: updated, signOut: !!input.password || !!phone };
    });
    if (signOut) await this.sessions.revokeAllForUser(franchise.ownerId, input.password ? "password_reset" : "phone_changed").catch(() => undefined);
    return franchiseView(franchise);
  }

  /**
   * SUSPENDED: the franchise panel closes, its riders' accounts are suspended (signed out at once) and the hub stops
   * taking new work (inactive). ACTIVE: all of that is reversed.
   */
  async setStatus(actor: Actor, id: string, input: z.infer<typeof franchiseStatusSchema>, meta: RequestMeta) {
    const { franchise, riderUserIds } = await this.prisma.$transaction(async tx => {
      const f = await tx.franchise.findUnique({ where: { id } });
      if (!f) throw notFound("Franchise");
      if (f.status === input.status) return { franchise: f, riderUserIds: [] as string[] };
      const riders = await tx.rider.findMany({ where: { hubId: f.hubId }, select: { userId: true } });
      const ids = riders.map(r => r.userId);
      await tx.franchise.update({ where: { id }, data: { status: input.status } });
      await tx.hub.update({ where: { id: f.hubId }, data: { active: input.status === "ACTIVE" } });
      // Riders' accounts exist only for this franchise; a franchise rider who also holds other roles keeps them.
      await tx.user.updateMany({ where: { id: { in: ids }, roles: { every: { role: "RIDER" } }, status: input.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE" }, data: { status: input.status } });
      await this.audit.record(actor, { action: input.status === "ACTIVE" ? "franchise.reactivate" : "franchise.suspend", entityType: "franchise", entityId: id, data: { reason: input.reason ?? null, riders: ids.length } }, meta, tx);
      return { franchise: f, riderUserIds: ids };
    });
    if (input.status === "SUSPENDED") {
      await this.sessions.revokeAllForUser(franchise.ownerId, "franchise_suspended").catch(() => undefined);
      for (const userId of riderUserIds) await this.sessions.revokeAllForUser(userId, "franchise_suspended").catch(() => undefined);
    }
    return this.get(id);
  }

  config() {
    return readFranchiseConfig(this.prisma);
  }

  async saveConfig(actor: Actor, input: z.infer<typeof updateFranchiseConfigSchema>, meta: RequestMeta) {
    const next = { ...(await readFranchiseConfig(this.prisma)), ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) };
    await this.prisma.$transaction(async tx => {
      await tx.setting.upsert({ where: { key: FRANCHISE_CONFIG_KEY }, create: { key: FRANCHISE_CONFIG_KEY, value: next }, update: { value: next } });
      await this.audit.record(actor, { action: "franchise.config", entityType: "setting", entityId: FRANCHISE_CONFIG_KEY, data: next }, meta, tx);
    });
    return next;
  }
}
