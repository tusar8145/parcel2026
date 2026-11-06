import { HttpStatus, Injectable } from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { TokenService } from "../../common/auth/token.service";
import { AppError, forbidden, notFound } from "../../common/errors";
import { pageArgs, pageQuerySchema, toPage } from "../../common/pagination";
import type { Role } from "@delivery-fast/shared";
import type { RoleGrant, UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { NotifyService } from "../notifications/notify.service";
import { toUserView, userViewSelect } from "../auth/auth.service";

export const startImpersonationSchema = z
  .object({
  /** The account to open; or riderId (that rider's account) or merchantId (its owner, or userId's merchant) from the operations lists. */
  userId: z.uuid("Choose a user").optional(),
  riderId: z.uuid("Choose a rider").optional(),
  merchantId: z.uuid("Choose a merchant").optional(),
  reason: z.string("Say why you need access").trim().min(10, "Say why you need access (at least 10 characters)").max(300, "Use at most 300 characters"),
  /** 5–60 minutes, default 15. */
  minutes: z.coerce.number().int().min(5, "At least 5 minutes").max(60, "At most 60 minutes").default(15),
  /** Read-only unless full access is explicitly chosen. */
  readOnly: z.boolean().default(true),
  /** Tell the account holder (SMS/email/in-app). Always on for "Log in as" by operations managers. */
  notifyUser: z.boolean().default(true),
  })
  .refine(v => v.userId || v.riderId || v.merchantId, { message: "Choose a user", path: ["userId"] });
export const impersonationTargetsQuerySchema = z
  .object({ merchantId: z.uuid().optional(), riderId: z.uuid().optional() })
  .refine(v => !!v.merchantId !== !!v.riderId, { message: "Give a merchantId or a riderId", path: ["merchantId"] });
export const listImpersonationsQuerySchema = pageQuerySchema.extend({
  userId: z.uuid().optional(),
  active: z.enum(["true", "false"]).transform(v => v === "true").optional(),
});

/** Staff accounts can't be opened by anyone (super admins have their own error code). */
const STAFF_ROLES: readonly Role[] = ["SUPER_ADMIN", "OPS_MANAGER", "HUB_OPERATOR", "FINANCE", "SUPPORT_AGENT"];
/** What "Log in as" (user:login-as, operations managers) may open: merchant members and riders, read-only. */
const LOGIN_AS_ROLES: readonly Role[] = ["MERCHANT_OWNER", "MERCHANT_STAFF", "RIDER"];
const ROLE_LABEL: Partial<Record<Role, string>> = {
  MERCHANT_OWNER: "Owner",
  MERCHANT_STAFF: "Staff",
  RIDER: "Rider",
  CUSTOMER: "Customer",
  SUPER_ADMIN: "Super admin",
  OPS_MANAGER: "Operations manager",
  HUB_OPERATOR: "Hub operator",
  FINANCE: "Finance",
  SUPPORT_AGENT: "Support agent",
  FRANCHISE: "Franchise",
  APPLICANT: "Applicant",
};

/** Who may start a session, and how: full support access (super admin) or read-only "Log in as". */
export function impersonationRights(actor: UserActor) {
  const full = actor.permissions.has("user:impersonate");
  return { any: full || actor.permissions.has("user:login-as"), full };
}

/** Why this account can't be opened by this person (null when it can). */
function refusal(roles: readonly Role[], status: string, full: boolean): AppError | null {
  if (roles.includes("SUPER_ADMIN")) return new AppError("IMPERSONATE_SUPER_ADMIN", "Super admin accounts can't be opened with support access", HttpStatus.FORBIDDEN);
  if (roles.some(r => STAFF_ROLES.includes(r))) return new AppError("IMPERSONATE_STAFF", "Staff accounts can't be opened with support access", HttpStatus.FORBIDDEN);
  if (!full && !roles.some(r => LOGIN_AS_ROLES.includes(r)))
    return new AppError("IMPERSONATE_NOT_ALLOWED", "You can only log in as merchant owners, merchant staff and riders", HttpStatus.FORBIDDEN);
  if (status !== "ACTIVE") return new AppError("USER_INACTIVE", "This account isn't active", HttpStatus.UNPROCESSABLE_ENTITY);
  return null;
}

const view = (s: {
  id: string;
  adminUserId: string;
  adminName: string;
  targetUserId: string;
  targetName: string;
  reason: string;
  readOnly: boolean;
  notifiedUser: boolean;
  expiresAt: Date;
  endedAt: Date | null;
  endedReason: string | null;
  createdAt: Date;
}, adminRole?: string | null) => ({
  id: s.id,
  admin: { id: s.adminUserId, name: s.adminName, ...(adminRole !== undefined ? { role: adminRole } : {}) },
  target: { id: s.targetUserId, name: s.targetName },
  reason: s.reason,
  readOnly: s.readOnly,
  notifiedUser: s.notifiedUser,
  createdAt: s.createdAt,
  expiresAt: s.expiresAt,
  endedAt: s.endedAt,
  endedReason: s.endedReason,
  active: !s.endedAt && s.expiresAt > new Date(),
});

/**
 * Support access: a super admin views the platform as another user with a short-lived,
 * non-refreshable access token (read-only by default). AuthGuard blocks sign-in, password,
 * MFA and session endpoints for these tokens and audits every request; super admin and staff
 * accounts can't be opened this way.
 *
 * "Log in as" (Courier Operations → Merchants / Riders) uses the same sessions: super admins with
 * user:impersonate (read-only or full access), operations managers with user:login-as (read-only
 * only, merchant owners / staff and riders only, and the account holder is always told).
 */
@Injectable()
export class ImpersonationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tokens: TokenService,
    private readonly notify: NotifyService,
  ) {}

  async start(admin: UserActor, input: z.infer<typeof startImpersonationSchema>, meta: RequestMeta) {
    if (admin.impersonation) throw forbidden("Not available while viewing as another user");
    const rights = impersonationRights(admin);
    if (!rights.any) throw forbidden();
    if (!input.readOnly && !rights.full)
      throw new AppError("IMPERSONATE_FULL_ACCESS", "Only a super admin can open an account with full access. Choose read-only.", HttpStatus.FORBIDDEN);
    // Operations managers can't turn the notice off.
    const notifyUser = rights.full ? input.notifyUser : true;
    const userId = await this.resolveTarget(input);
    if (userId === admin.userId) throw new AppError("IMPERSONATE_SELF", "You can't open your own account this way", HttpStatus.UNPROCESSABLE_ENTITY);
    const target = await this.prisma.user.findUnique({ where: { id: userId }, select: { ...userViewSelect, status: true, roles: { select: { ...userViewSelect.roles.select, customRoleId: true } } } });
    if (!target) throw notFound("User");
    const refused = refusal(target.roles.map(r => r.role), target.status, rights.full);
    if (refused) throw refused;

    const expiresAt = new Date(Date.now() + input.minutes * 60_000);
    const session = await this.prisma.$transaction(async tx => {
      const created = await tx.impersonationSession.create({
        data: {
          adminUserId: admin.userId,
          adminName: admin.name,
          targetUserId: target.id,
          targetName: target.name,
          reason: input.reason,
          readOnly: input.readOnly,
          notifiedUser: notifyUser,
          expiresAt,
          ip: meta.ip,
        },
      });
      await this.audit.record(
        admin,
        {
          action: "impersonation.start",
          entityType: "user",
          entityId: target.id,
          data: { impersonationId: created.id, reason: input.reason, minutes: input.minutes, readOnly: input.readOnly, notifyUser, via: rights.full ? "support_access" : "login_as" },
        },
        meta,
        tx,
      );
      return created;
    });

    const info = { id: session.id, adminUserId: admin.userId, adminName: admin.name, readOnly: input.readOnly, expiresAt: expiresAt.toISOString() };
    const roles: RoleGrant[] = target.roles.map(r => ({ role: r.role, merchantId: r.merchantId, hubId: r.hubId, customRoleId: r.customRoleId }));
    // The impersonation id is the token's session id, so ending it denylists the token.
    const token = await this.tokens.issueAccessToken({
      userId: target.id,
      sessionId: session.id,
      name: target.name,
      roles,
      riderId: target.rider?.id,
      impersonation: info,
      ttlSeconds: input.minutes * 60,
    });
    if (notifyUser) {
      try {
        await this.notify.notifyNow({
          event: "account.support_access",
          to: { userId: target.id },
          vars: { admin: admin.name, minutes: input.minutes, mode: input.readOnly ? "view-only" : "full access" },
        });
      } catch {
        // The notice is best effort; the audit log has the record.
      }
    }
    return { ...token, impersonation: view(session), user: { ...toUserView(target), impersonation: info } };
  }

  /** Ends a session: by the admin who started it (or another super admin), or from the impersonation tab itself. */
  async end(actor: UserActor, id: string, meta: RequestMeta) {
    const session = await this.prisma.impersonationSession.findUnique({ where: { id } });
    if (!session) throw notFound("Support access session");
    const fromTab = actor.impersonation?.id === id;
    // From the admin side: any super admin, or the person who started it.
    if (!fromTab && (actor.impersonation || !(actor.permissions.has("user:impersonate") || actor.userId === session.adminUserId))) throw forbidden();
    if (!session.endedAt) {
      const reason = fromTab ? "ended_from_session" : actor.userId === session.adminUserId ? "ended_by_admin" : "ended_by_other_admin";
      await this.prisma.$transaction(async tx => {
        await tx.impersonationSession.updateMany({ where: { id, endedAt: null }, data: { endedAt: new Date(), endedReason: reason } });
        await this.audit.record(
          fromTab ? { userId: session.adminUserId, name: session.adminName } : actor,
          { action: "impersonation.end", entityType: "user", entityId: session.targetUserId, data: { impersonationId: id, reason } },
          meta,
          tx,
        );
      });
      await this.tokens.denylistSessions([id], Math.max(60, Math.ceil((session.expiresAt.getTime() - Date.now()) / 1000) + 60));
    }
    return view(await this.prisma.impersonationSession.findUniqueOrThrow({ where: { id } }));
  }

  async list(query: z.infer<typeof listImpersonationsQuerySchema>) {
    const now = new Date();
    const rows = await this.prisma.impersonationSession.findMany({
      where: {
        ...(query.userId ? { OR: [{ targetUserId: query.userId }, { adminUserId: query.userId }] } : {}),
        ...(query.active === true ? { endedAt: null, expiresAt: { gt: now } } : {}),
      },
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    // Who started each session: super admins (support access) or operations managers ("Log in as").
    const admins = await this.prisma.userRole.findMany({ where: { userId: { in: [...new Set(page.items.map(s => s.adminUserId))] } }, select: { userId: true, role: true } });
    const roleOf = (id: string) => {
      const roles = admins.filter(a => a.userId === id).map(a => a.role);
      const top = STAFF_ROLES.find(r => roles.includes(r));
      return top ? (ROLE_LABEL[top] ?? top) : null;
    };
    return { ...page, items: page.items.map(s => view(s, roleOf(s.adminUserId))) };
  }

  /** The account behind a start request: the user, the rider's account, or the merchant's owner. */
  private async resolveTarget(input: { userId?: string; riderId?: string; merchantId?: string }) {
    if (input.userId) {
      // From a merchant list: the chosen member must belong to that merchant.
      if (input.merchantId && !(await this.prisma.userRole.findFirst({ where: { userId: input.userId, merchantId: input.merchantId } })))
        throw new AppError("NOT_A_MEMBER", "This person isn't a member of that merchant", HttpStatus.UNPROCESSABLE_ENTITY);
      return input.userId;
    }
    if (input.riderId) {
      const rider = await this.prisma.rider.findUnique({ where: { id: input.riderId }, select: { userId: true } });
      if (!rider) throw notFound("Rider");
      return rider.userId;
    }
    const owner = await this.prisma.userRole.findFirst({ where: { merchantId: input.merchantId, role: "MERCHANT_OWNER" }, orderBy: { createdAt: "asc" }, select: { userId: true } });
    if (!owner) throw new AppError("NO_MERCHANT_OWNER", "This merchant has no owner account to open. Choose a member.", HttpStatus.UNPROCESSABLE_ENTITY);
    return owner.userId;
  }

  /**
   * Who "Log in as" can open for a merchant (its members, owners first) or a rider, with the
   * reason when one can't be opened by this person.
   */
  async targets(actor: UserActor, query: z.infer<typeof impersonationTargetsQuerySchema>) {
    const rights = impersonationRights(actor);
    if (!rights.any || actor.impersonation) throw forbidden();
    const select = { id: true, name: true, phone: true, status: true, roles: { select: { role: true, merchantId: true, merchant: { select: { type: true } } } } } as const;
    let users: { id: string; name: string; phone: string; status: string; roles: { role: Role; merchantId: string | null; merchant: { type: string } | null }[] }[];
    if (query.riderId) {
      const rider = await this.prisma.rider.findUnique({ where: { id: query.riderId }, select: { user: { select } } });
      if (!rider) throw notFound("Rider");
      users = [rider.user];
    } else {
      const merchant = await this.prisma.merchant.findUnique({ where: { id: query.merchantId }, select: { id: true } });
      if (!merchant) throw notFound("Merchant");
      users = await this.prisma.user.findMany({ where: { roles: { some: { merchantId: query.merchantId } } }, select, orderBy: { createdAt: "asc" } });
    }
    const items = users.map(u => {
      const grant = query.merchantId ? u.roles.find(r => r.merchantId === query.merchantId) : u.roles.find(r => r.role === "RIDER");
      const refused = refusal(u.roles.map(r => r.role), u.status, rights.full);
      return {
        userId: u.id,
        name: u.name,
        phone: u.phone,
        role: grant?.role ?? null,
        roleLabel: (grant && ROLE_LABEL[grant.role]) || "Member",
        panel: query.riderId ? "/rider" : grant?.merchant?.type === "BANKING_FINANCIAL" ? "/banking-merchant" : "/ecommerce-merchant",
        allowed: !refused,
        ...(refused ? { refusal: refused.message } : {}),
      };
    });
    items.sort((a, b) => Number(b.role === "MERCHANT_OWNER") - Number(a.role === "MERCHANT_OWNER"));
    return { items, fullAccess: rights.full };
  }
}
