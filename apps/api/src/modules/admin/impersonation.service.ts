import { HttpStatus, Injectable } from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { TokenService } from "../../common/auth/token.service";
import { AppError, forbidden, notFound } from "../../common/errors";
import { pageArgs, pageQuerySchema, toPage } from "../../common/pagination";
import type { RoleGrant, UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { NotifyService } from "../notifications/notify.service";
import { toUserView, userViewSelect } from "../auth/auth.service";

export const startImpersonationSchema = z.object({
  userId: z.uuid("Choose a user"),
  reason: z.string("Say why you need access").trim().min(10, "Say why you need access (at least 10 characters)").max(300, "Use at most 300 characters"),
  /** 5–60 minutes, default 15. */
  minutes: z.coerce.number().int().min(5, "At least 5 minutes").max(60, "At most 60 minutes").default(15),
  /** Read-only unless full access is explicitly chosen. */
  readOnly: z.boolean().default(true),
  /** Tell the account holder (SMS/email). */
  notifyUser: z.boolean().default(true),
});
export const listImpersonationsQuerySchema = pageQuerySchema.extend({
  userId: z.uuid().optional(),
  active: z.enum(["true", "false"]).transform(v => v === "true").optional(),
});

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
}) => ({
  id: s.id,
  admin: { id: s.adminUserId, name: s.adminName },
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
 * MFA and session endpoints for these tokens and audits every request; super admins'
 * accounts can't be opened this way.
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
    if (input.userId === admin.userId) throw new AppError("IMPERSONATE_SELF", "You can't open your own account this way", HttpStatus.UNPROCESSABLE_ENTITY);
    const target = await this.prisma.user.findUnique({ where: { id: input.userId }, select: { ...userViewSelect, status: true, roles: { select: { ...userViewSelect.roles.select, customRoleId: true } } } });
    if (!target) throw notFound("User");
    if (target.status !== "ACTIVE") throw new AppError("USER_INACTIVE", "This account isn't active", HttpStatus.UNPROCESSABLE_ENTITY);
    if (target.roles.some(r => r.role === "SUPER_ADMIN"))
      throw new AppError("IMPERSONATE_SUPER_ADMIN", "Super admin accounts can't be opened with support access", HttpStatus.FORBIDDEN);

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
          notifiedUser: input.notifyUser,
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
          data: { impersonationId: created.id, reason: input.reason, minutes: input.minutes, readOnly: input.readOnly, notifyUser: input.notifyUser },
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
    if (input.notifyUser) {
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
    if (!fromTab && !actor.permissions.has("user:impersonate")) throw forbidden();
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
    return { ...page, items: page.items.map(view) };
  }
}
