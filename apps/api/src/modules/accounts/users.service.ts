import { HttpStatus, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { PrismaService, type Db } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { hashPassword } from "../../common/crypto";
import { AppError, conflict, forbidden, notFound } from "../../common/errors";
import { pageArgs, toPage } from "../../common/pagination";
import { hasRole, type Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import type { Prisma, Role } from "../../generated/prisma/client";
import { SessionService } from "../auth/session.service";
import { MfaService, mfaRequiredFor } from "../auth/mfa.service";
import { PermissionService } from "../../common/auth/permissions.service";
import { NotifyService } from "../notifications/notify.service";
import { emailInUse, isUniqueViolation } from "./profile.service";
import { env } from "../../config/env";
import type { createUserSchema, listUsersQuerySchema, RoleGrantInput, updateUserSchema } from "./accounts.schemas";

const MERCHANT_ROLES: Role[] = ["MERCHANT_OWNER", "MERCHANT_STAFF"];

const userListSelect = {
  id: true,
  name: true,
  phone: true,
  email: true,
  status: true,
  lastLoginAt: true,
  createdAt: true,
  roles: {
    select: {
      id: true,
      role: true,
      merchant: { select: { id: true, name: true } },
      hub: { select: { id: true, name: true } },
      customRole: { select: { id: true, name: true, active: true } },
    },
    orderBy: { createdAt: "asc" },
  },
  mfa: { select: { enabledAt: true } },
} satisfies Prisma.UserSelect;

// A function because the active-session filter depends on "now".
const userDetailSelect = () =>
  ({
    ...userListSelect,
    rider: { select: { id: true, code: true } },
    _count: { select: { sessions: { where: { revokedAt: null, expiresAt: { gt: new Date() } } } } },
  }) satisfies Prisma.UserSelect;

type ListedUser = Prisma.UserGetPayload<{ select: typeof userListSelect }>;

const userView = (u: ListedUser) => ({
  id: u.id,
  name: u.name,
  phone: u.phone,
  email: u.email,
  status: u.status,
  roles: u.roles.map(r => ({ id: r.id, role: r.role, merchant: r.merchant, hub: r.hub, customRole: r.customRole })),
  mfa: { enabled: !!u.mfa?.enabledAt, required: mfaRequiredFor(u.roles.map(r => r.role)) },
  lastLoginAt: u.lastLoginAt,
  createdAt: u.createdAt,
});

const unprocessable = (code: string, message: string) => new AppError(code, message, HttpStatus.UNPROCESSABLE_ENTITY);

/** Staff roles as the panels name them (super admin "Admin users & roles"). */
const STAFF_ROLE_LABEL: Partial<Record<Role, string>> = {
  SUPER_ADMIN: "Super Administrator",
  OPS_MANAGER: "Operations Administrator",
  HUB_OPERATOR: "Hub Manager",
  FINANCE: "Finance Administrator",
  SUPPORT_AGENT: "Merchant Support",
};

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    private readonly mfa: MfaService,
    private readonly permissions: PermissionService,
    private readonly notify: NotifyService,
  ) {}

  async list(query: z.infer<typeof listUsersQuerySchema>) {
    const where: Prisma.UserWhereInput = {
      status: query.status,
      AND: [
        ...(query.role ? [{ roles: { some: { role: query.role } } }] : []),
        ...(query.roles?.length ? [{ roles: { some: { role: { in: query.roles } } } }] : []),
      ],
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: "insensitive" } },
              { phone: { contains: query.q } },
              { email: { contains: query.q, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const rows = await this.prisma.user.findMany({ where, select: userListSelect, ...pageArgs(query) });
    const page = toPage(rows, query.limit);
    return { ...page, items: page.items.map(userView) };
  }

  async get(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id }, select: userDetailSelect() });
    if (!user) throw notFound("User");
    return { ...userView(user), activeSessions: user._count.sessions, rider: user.rider };
  }

  async create(actor: Actor, input: z.infer<typeof createUserSchema>, meta: RequestMeta) {
    for (const grant of input.roles) this.assertGrantable(actor, grant);
    await this.assertScopesExist(input.roles);
    await this.assertCustomRoles(input.roles);
    if (await this.prisma.user.findUnique({ where: { phone: input.phone }, select: { id: true } }))
      throw conflict("PHONE_IN_USE", "This phone number already has an account. Add a role to that user instead.");
    if (input.email && (await this.prisma.user.findUnique({ where: { email: input.email }, select: { id: true } }))) throw emailInUse();

    const passwordHash = input.password ? await hashPassword(input.password) : null;
    try {
      const user = await this.prisma.$transaction(async tx => {
        const created = await tx.user.create({
          data: {
            name: input.name,
            phone: input.phone,
            email: input.email,
            passwordHash,
            roles: { create: input.roles.map(g => ({ role: g.role, merchantId: g.merchantId, hubId: g.hubId, customRoleId: g.customRoleId })) },
          },
          select: { id: true },
        });
        await this.audit.record(
          actor,
          { action: "user.create", entityType: "user", entityId: created.id, data: { phone: input.phone, roles: input.roles, withPassword: !!input.password } },
          meta,
          tx,
        );
        return created;
      });
      // Staff accounts: tell the new person they have an account, as what, and where to sign in
      // ("Account invitation", SMS + email; without a password they sign in with an SMS code).
      const staff = [...new Set(input.roles.map(g => STAFF_ROLE_LABEL[g.role as Role]).filter(Boolean))];
      if (staff.length)
        await this.notify
          .notifyNow({
            event: "account.invite",
            to: { userId: user.id, phone: input.phone, email: input.email, name: input.name },
            vars: { inviter: actor.kind === "user" ? actor.name : "Delivery Fast", role: staff.join(" and "), link: `${env().APP_URL.replace(/\/+$/, "")}/login` },
          })
          .catch(() => undefined);
      return this.get(user.id);
    } catch (error) {
      if (isUniqueViolation(error, "phone")) throw conflict("PHONE_IN_USE", "This phone number already has an account");
      if (isUniqueViolation(error, "email")) throw emailInUse();
      throw error;
    }
  }

  async update(actor: Actor, id: string, input: z.infer<typeof updateUserSchema>, meta: RequestMeta) {
    const target = await this.prisma.user.findUnique({ where: { id }, select: { id: true, status: true, roles: { select: { role: true } } } });
    if (!target) throw notFound("User");
    const targetIsSuperAdmin = target.roles.some(r => r.role === "SUPER_ADMIN");
    if (targetIsSuperAdmin && !hasRole(actor, "SUPER_ADMIN")) throw forbidden("Only a super admin can change a super admin's account");
    const deactivating = input.status !== undefined && input.status !== "ACTIVE";
    if (deactivating && actor.kind === "user" && actor.userId === id) throw unprocessable("CANNOT_SUSPEND_SELF", "You can't suspend or deactivate your own account");
    if (input.email) {
      const owner = await this.prisma.user.findUnique({ where: { email: input.email }, select: { id: true } });
      if (owner && owner.id !== id) throw emailInUse();
    }

    try {
      await this.prisma.$transaction(async tx => {
        if (deactivating && targetIsSuperAdmin && target.status === "ACTIVE") await this.assertAnotherSuperAdmin(tx, id);
        await tx.user.update({ where: { id }, data: input });
        const action = input.status && input.status !== target.status ? "user.status_change" : "user.update";
        await this.audit.record(actor, { action, entityType: "user", entityId: id, data: { ...input, previousStatus: target.status } }, meta, tx);
      });
    } catch (error) {
      if (isUniqueViolation(error, "email")) throw emailInUse();
      throw error;
    }
    // After commit: the guard trusts access tokens, so revoked sessions must be denylisted now, not in 15 minutes.
    if (deactivating) await this.sessions.revokeAllForUser(id, `user_${input.status!.toLowerCase()}`);
    return this.get(id);
  }

  async addRole(actor: Actor, userId: string, grant: RoleGrantInput, meta: RequestMeta) {
    this.assertGrantable(actor, grant);
    if (!(await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } }))) throw notFound("User");
    await this.assertScopesExist([grant]);
    await this.assertCustomRoles([grant]);
    await this.prisma.$transaction(async tx => {
      // NULL scopes never collide in the unique index, so duplicates are checked explicitly.
      const existing = await tx.userRole.findFirst({
        where: { userId, role: grant.role, merchantId: grant.merchantId ?? null, hubId: grant.hubId ?? null, customRoleId: grant.customRoleId ?? null },
      });
      if (existing) throw conflict("ROLE_EXISTS", "The user already has this role");
      const created = await tx.userRole.create({ data: { userId, role: grant.role, merchantId: grant.merchantId, hubId: grant.hubId, customRoleId: grant.customRoleId } });
      await this.audit.record(actor, { action: "user.role_add", entityType: "user", entityId: userId, data: { roleId: created.id, ...grant } }, meta, tx);
    });
    // Grants are carried in access tokens: make the user's current tokens refresh so the new role applies now.
    await this.permissions.bumpUser(userId);
    return this.get(userId);
  }

  async removeRole(actor: Actor, userId: string, roleId: string, meta: RequestMeta) {
    const grant = await this.prisma.userRole.findFirst({ where: { id: roleId, userId } });
    if (!grant) throw notFound("Role");
    if (grant.role === "SUPER_ADMIN") {
      if (!hasRole(actor, "SUPER_ADMIN")) throw forbidden("Only a super admin can remove the super admin role");
      if (actor.kind === "user" && actor.userId === userId)
        throw unprocessable("CANNOT_REMOVE_OWN_SUPER_ADMIN", "You can't remove your own super admin role. Ask another super admin.");
    }
    await this.prisma.$transaction(async tx => {
      if (grant.role === "SUPER_ADMIN") await this.assertAnotherSuperAdmin(tx, userId);
      await tx.userRole.delete({ where: { id: roleId } });
      await this.audit.record(
        actor,
        { action: "user.role_remove", entityType: "user", entityId: userId, data: { roleId, role: grant.role, merchantId: grant.merchantId, hubId: grant.hubId } },
        meta,
        tx,
      );
    });
    // Role claims live in access tokens; sign the user out so the removal takes effect now.
    await this.sessions.revokeAllForUser(userId, "role_removed");
    return this.get(userId);
  }

  /**
   * Turns off another user's two-step verification (lost device). Their sessions end; roles
   * that require it set it up again at the next sign-in. Super admins only; audited.
   */
  async resetMfa(actor: Actor, userId: string, meta: RequestMeta) {
    if (!hasRole(actor, "SUPER_ADMIN")) throw forbidden("Only a super admin can reset two-step verification");
    if (actor.kind === "user" && actor.userId === userId)
      throw unprocessable("CANNOT_RESET_OWN_MFA", "You can't reset your own two-step verification. Use a recovery code, or ask another super admin.");
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, mfa: { select: { enabledAt: true } } } });
    if (!user) throw notFound("User");
    if (!user.mfa) throw unprocessable("MFA_NOT_ENABLED", "Two-step verification isn't set up for this user");
    await this.mfa.remove(userId);
    await this.audit.record(actor, { action: "auth.mfa_reset", entityType: "user", entityId: userId, data: { wasEnabled: !!user.mfa.enabledAt } }, meta);
    await this.sessions.revokeAllForUser(userId, "mfa_reset");
    try {
      await this.notify.notifyNow({ event: "auth.mfa_reset", to: { userId }, vars: { admin: actor.kind === "user" ? actor.name : "An administrator" } });
    } catch {
      // The reset stands even if the notice can't be queued.
    }
    return this.get(userId);
  }

  /** Custom role grants: the role must exist, be active and match the grant's base role. */
  private async assertCustomRoles(grants: RoleGrantInput[]) {
    for (const grant of grants) {
      if (!grant.customRoleId) continue;
      const custom = await this.prisma.customRole.findUnique({ where: { id: grant.customRoleId }, select: { baseRole: true, active: true } });
      if (!custom || !custom.active) throw unprocessable("CUSTOM_ROLE_NOT_FOUND", "The selected role doesn't exist or is inactive");
      if (custom.baseRole !== grant.role) throw unprocessable("CUSTOM_ROLE_BASE_MISMATCH", `This role is based on ${custom.baseRole}; send role ${custom.baseRole}`);
    }
  }

  /** Scope rules for a grant; DB existence is checked separately in one query per kind. */
  private assertGrantable(actor: Actor, grant: RoleGrantInput) {
    if (grant.role === "RIDER") throw unprocessable("USE_RIDERS_ENDPOINT", "Riders are created from the riders screen (POST /riders)");
    if (grant.role === "SUPER_ADMIN" && !hasRole(actor, "SUPER_ADMIN")) throw forbidden("Only a super admin can grant the super admin role");
    const isMerchantRole = MERCHANT_ROLES.includes(grant.role);
    const isHubRole = grant.role === "HUB_OPERATOR";
    if (isMerchantRole && !grant.merchantId) throw unprocessable("SCOPE_REQUIRED", `${grant.role} needs a merchantId`);
    if (isHubRole && !grant.hubId) throw unprocessable("SCOPE_REQUIRED", `${grant.role} needs a hubId`);
    if ((grant.merchantId && !isMerchantRole) || (grant.hubId && !isHubRole))
      throw unprocessable("SCOPE_NOT_ALLOWED", `${grant.role} can't be limited to a merchant or hub`);
  }

  private async assertScopesExist(grants: RoleGrantInput[]) {
    const merchantIds = [...new Set(grants.flatMap(g => (g.merchantId ? [g.merchantId] : [])))];
    const hubIds = [...new Set(grants.flatMap(g => (g.hubId ? [g.hubId] : [])))];
    const [merchants, hubs] = await Promise.all([
      merchantIds.length ? this.prisma.merchant.count({ where: { id: { in: merchantIds } } }) : 0,
      hubIds.length ? this.prisma.hub.count({ where: { id: { in: hubIds } } }) : 0,
    ]);
    if (merchants !== merchantIds.length) throw unprocessable("MERCHANT_NOT_FOUND", "The selected merchant doesn't exist");
    if (hubs !== hubIds.length) throw unprocessable("HUB_NOT_FOUND", "The selected hub doesn't exist");
  }

  /**
   * The platform must always keep an active super admin. The advisory lock stops two
   * admins demoting each other at the same moment and leaving none.
   */
  private async assertAnotherSuperAdmin(tx: Db, exceptUserId: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('super-admin-roles'))`;
    const others = await tx.userRole.count({ where: { role: "SUPER_ADMIN", userId: { not: exceptUserId }, user: { status: "ACTIVE" } } });
    if (!others) throw unprocessable("LAST_SUPER_ADMIN", "This is the last active super admin and can't be removed");
  }
}
