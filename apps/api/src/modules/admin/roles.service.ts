import { HttpStatus, Injectable, OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import {
  CUSTOM_ROLE_BASES,
  effectiveRolePermissions,
  isPermission,
  PERMISSION_INFO,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLES,
  SUPER_ADMIN_CRITICAL_PERMISSIONS,
  SUPER_ADMIN_ONLY_PERMISSIONS,
  type Permission,
  type Role,
} from "@paira-express/shared";
import { PrismaService, type Db } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { PermissionService } from "../../common/auth/permissions.service";
import { AppError, conflict, notFound } from "../../common/errors";
import type { Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { ApprovalsService } from "../approvals/approvals.service";

const unprocessable = (code: string, message: string) => new AppError(code, message, HttpStatus.UNPROCESSABLE_ENTITY);

const permissionList = z
  .array(z.string().trim())
  .max(PERMISSIONS.length * 2)
  .transform(list => [...new Set(list)])
  .superRefine((list, ctx) => {
    const unknown = list.filter(p => !isPermission(p));
    if (unknown.length) ctx.addIssue({ code: "custom", message: `Unknown permission: ${unknown.join(", ")}` });
  })
  .transform(list => list.filter(isPermission));

export const rolePermissionsSchema = z.object({ permissions: permissionList });
const roleNameSchema = z.string().trim().min(2, "Name must be at least 2 characters").max(60, "Use at most 60 characters");
export const createCustomRoleSchema = z.object({
  name: roleNameSchema,
  description: z.string().trim().max(300, "Use at most 300 characters").default(""),
  baseRole: z.enum(CUSTOM_ROLE_BASES, `Base the role on ${CUSTOM_ROLE_BASES.join(", ")}`),
  permissions: permissionList,
});
export const updateCustomRoleSchema = z
  .object({
    name: roleNameSchema.optional(),
    description: z.string().trim().max(300, "Use at most 300 characters").optional(),
    permissions: permissionList.optional(),
    active: z.boolean().optional(),
  })
  .refine(v => Object.values(v).some(x => x !== undefined), "Send at least one field to change");

type RoleChange = { role: Role; granted: Permission[]; revoked: Permission[] };
type CustomCreate = z.infer<typeof createCustomRoleSchema>;
type CustomUpdate = z.infer<typeof updateCustomRoleSchema> & { id: string; currentName: string };
type CustomDelete = { id: string; name: string };

/**
 * Role and permission editor: built-in roles keep their base sets and can be adjusted per role
 * (granted/revoked lists); custom roles have their own set on top of a built-in base role
 * (panel access and merchant/hub scoping). Every change goes through maker-checker and takes
 * effect on the next request (PermissionService cache version).
 */
@Injectable()
export class RolesService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionService,
    private readonly approvals: ApprovalsService,
  ) {}

  onModuleInit() {
    this.approvals.register<RoleChange>({
      kind: "role.permissions",
      prepare: async payload => {
        const p = z.object({ role: z.enum(ROLES), granted: z.array(z.string()), revoked: z.array(z.string()) }).parse(payload);
        return { role: p.role, granted: p.granted.filter(isPermission), revoked: p.revoked.filter(isPermission) };
      },
      summary: p => `${p.role} permissions: ${[...p.granted.map(x => `+${x}`), ...p.revoked.map(x => `−${x}`)].join(", ") || "back to the built-in set"}`,
      apply: async (tx, p, { actor, requestedById, meta }) => {
        if (!p.granted.length && !p.revoked.length) await tx.rolePermissionOverride.deleteMany({ where: { role: p.role } });
        else
          await tx.rolePermissionOverride.upsert({
            where: { role: p.role },
            create: { role: p.role, granted: p.granted, revoked: p.revoked, updatedById: requestedById },
            update: { granted: p.granted, revoked: p.revoked, updatedById: requestedById },
          });
        await this.audit.record(actor, { action: "role.permissions_update", entityType: "role", entityId: p.role, data: { granted: p.granted, revoked: p.revoked, requestedById } }, meta, tx);
        return { role: p.role, granted: p.granted, revoked: p.revoked };
      },
      afterCommit: () => this.permissions.invalidate(),
    });

    this.approvals.register<CustomCreate>({
      kind: "custom_role.create",
      prepare: async (payload, db) => {
        const p = createCustomRoleSchema.parse(payload);
        this.assertCustomPermissions(p.permissions);
        await this.assertNameFree(db, p.name);
        return p;
      },
      summary: p => `New role "${p.name}" (based on ${p.baseRole}, ${p.permissions.length} permissions)`,
      apply: async (tx, p, { actor, requestedById, meta }) => {
        await this.assertNameFree(tx, p.name);
        const role = await tx.customRole.create({ data: { ...p, createdById: requestedById } });
        await this.audit.record(actor, { action: "custom_role.create", entityType: "custom_role", entityId: role.id, data: { ...p, requestedById } }, meta, tx);
        return { id: role.id, name: role.name };
      },
      afterCommit: () => this.permissions.invalidate(),
    });

    this.approvals.register<CustomUpdate>({
      kind: "custom_role.update",
      prepare: async (payload, db) => {
        const p = updateCustomRoleSchema.and(z.object({ id: z.uuid() })).parse(payload);
        const existing = await db.customRole.findUnique({ where: { id: p.id } });
        if (!existing) throw notFound("Role");
        if (p.permissions) this.assertCustomPermissions(p.permissions);
        if (p.name && p.name.toLowerCase() !== existing.name.toLowerCase()) await this.assertNameFree(db, p.name);
        return { ...p, currentName: existing.name };
      },
      summary: p =>
        `Change role "${p.currentName}": ${[
          p.name && p.name !== p.currentName ? `rename to "${p.name}"` : "",
          p.permissions ? `${p.permissions.length} permissions` : "",
          p.description !== undefined ? "description" : "",
          p.active === false ? "deactivate" : p.active === true ? "activate" : "",
        ]
          .filter(Boolean)
          .join(", ")}`,
      apply: async (tx, p, { actor, requestedById, meta }) => {
        const { id, currentName: _n, ...data } = p;
        const role = await tx.customRole.update({ where: { id }, data });
        await this.audit.record(actor, { action: "custom_role.update", entityType: "custom_role", entityId: id, data: { ...data, requestedById } }, meta, tx);
        return { id: role.id, name: role.name };
      },
      afterCommit: () => this.permissions.invalidate(),
    });

    this.approvals.register<CustomDelete & { userIds?: string[] }>({
      kind: "custom_role.delete",
      prepare: async (payload, db) => {
        const { id } = z.object({ id: z.uuid() }).parse(payload);
        const existing = await db.customRole.findUnique({ where: { id }, select: { name: true } });
        if (!existing) throw notFound("Role");
        return { id, name: existing.name };
      },
      summary: p => `Delete role "${p.name}" (its holders lose it)`,
      apply: async (tx, p, { actor, requestedById, meta }) => {
        const holders = await tx.userRole.findMany({ where: { customRoleId: p.id }, select: { userId: true } });
        await tx.customRole.delete({ where: { id: p.id } }); // grants cascade
        await this.audit.record(actor, { action: "custom_role.delete", entityType: "custom_role", entityId: p.id, data: { name: p.name, holders: holders.length, requestedById } }, meta, tx);
        return { id: p.id, userIds: [...new Set(holders.map(h => h.userId))] };
      },
      afterCommit: async (_p, result) => {
        await this.permissions.invalidate();
        // Their access tokens still name the deleted grant: make them refresh now.
        for (const userId of (result as { userIds: string[] }).userIds) await this.permissions.bumpUser(userId);
      },
    });
  }

  /** The permission matrix: every permission × built-in roles (with overrides) and custom roles. */
  async matrix() {
    const [overrides, customRoles, builtInCounts, customCounts] = await Promise.all([
      this.prisma.rolePermissionOverride.findMany(),
      this.prisma.customRole.findMany({ orderBy: { name: "asc" } }),
      this.prisma.userRole.groupBy({ by: ["role"], where: { customRoleId: null, user: { status: "ACTIVE" } }, _count: { _all: true } }),
      this.prisma.userRole.groupBy({ by: ["customRoleId"], where: { customRoleId: { not: null }, user: { status: "ACTIVE" } }, _count: { _all: true } }),
    ]);
    return {
      permissions: PERMISSIONS.map(key => ({ key, ...PERMISSION_INFO[key], superAdminOnly: SUPER_ADMIN_ONLY_PERMISSIONS.includes(key) })),
      builtInRoles: ROLES.map(role => {
        const o = overrides.find(x => x.role === role);
        return {
          role,
          base: ROLE_PERMISSIONS[role],
          permissions: [...effectiveRolePermissions(role, o)],
          granted: o?.granted.filter(isPermission) ?? [],
          revoked: o?.revoked.filter(isPermission) ?? [],
          locked: role === "SUPER_ADMIN" ? SUPER_ADMIN_CRITICAL_PERMISSIONS : [],
          users: builtInCounts.find(c => c.role === role)?._count._all ?? 0,
        };
      }),
      customRoles: customRoles.map(c => ({
        id: c.id,
        name: c.name,
        description: c.description,
        baseRole: c.baseRole,
        permissions: c.permissions.filter(isPermission),
        active: c.active,
        users: customCounts.find(x => x.customRoleId === c.id)?._count._all ?? 0,
        updatedAt: c.updatedAt,
      })),
      customRoleBases: CUSTOM_ROLE_BASES,
    };
  }

  /** Sets a built-in role's permissions (stored as the difference from its built-in set). */
  setRolePermissions(actor: Actor, role: Role, permissions: Permission[], meta: RequestMeta) {
    const base = new Set<Permission>(ROLE_PERMISSIONS[role]);
    const wanted = new Set(permissions);
    if (role === "SUPER_ADMIN") {
      const missing = SUPER_ADMIN_CRITICAL_PERMISSIONS.filter(p => !wanted.has(p));
      if (missing.length) throw unprocessable("LOCKOUT_PROTECTION", `Super admins always keep: ${missing.join(", ")}`);
    } else {
      const reserved = permissions.filter(p => SUPER_ADMIN_ONLY_PERMISSIONS.includes(p));
      if (reserved.length) throw unprocessable("SUPER_ADMIN_ONLY", `Only super admins can hold: ${reserved.join(", ")}`);
    }
    const granted = permissions.filter(p => !base.has(p));
    const revoked = [...base].filter(p => !wanted.has(p));
    return this.approvals.submit(actor, "role.permissions", { role, granted, revoked }, meta);
  }

  createCustomRole(actor: Actor, input: CustomCreate, meta: RequestMeta) {
    return this.approvals.submit(actor, "custom_role.create", input, meta);
  }

  updateCustomRole(actor: Actor, id: string, input: z.infer<typeof updateCustomRoleSchema>, meta: RequestMeta) {
    return this.approvals.submit(actor, "custom_role.update", { ...input, id }, meta);
  }

  deleteCustomRole(actor: Actor, id: string, meta: RequestMeta) {
    return this.approvals.submit(actor, "custom_role.delete", { id }, meta);
  }

  private assertCustomPermissions(permissions: Permission[]) {
    const reserved = permissions.filter(p => SUPER_ADMIN_ONLY_PERMISSIONS.includes(p));
    if (reserved.length) throw unprocessable("SUPER_ADMIN_ONLY", `Only super admins can hold: ${reserved.join(", ")}`);
  }

  private async assertNameFree(db: Db, name: string) {
    const clash = await db.customRole.findFirst({ where: { name: { equals: name, mode: "insensitive" } }, select: { id: true } });
    if (clash || (ROLES as readonly string[]).includes(name.toUpperCase().replace(/\s+/g, "_")))
      throw conflict("ROLE_NAME_TAKEN", `A role named "${name}" already exists`);
  }
}
