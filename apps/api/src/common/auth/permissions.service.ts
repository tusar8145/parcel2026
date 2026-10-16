import { Injectable, Logger } from "@nestjs/common";
import { effectiveRolePermissions, isPermission, ROLES, SUPER_ADMIN_ONLY_PERMISSIONS, type Permission, type Role } from "@delivery-fast/shared";
import { PrismaService } from "../prisma.service";
import { RedisService } from "../redis.service";
import type { RoleGrant } from "./actor";

/** Bumped on every role/permission definition change; every API instance reloads when it moves. */
export const AUTHZ_VERSION_KEY = "authz:version";
/** Per-user counter: access tokens issued before the latest bump are refreshed (new grants apply at once). */
export const userVersionKey = (userId: string) => `auth:user-version:${userId}`;
/** Safety net: reload definitions at least this often even if Redis lost the version key. */
const MAX_CACHE_AGE_MS = 60_000;

interface Definitions {
  version: string | null;
  loadedAt: number;
  builtIn: Map<Role, Set<Permission>>;
  custom: Map<string, { name: string; baseRole: Role; permissions: Set<Permission> }>;
}

/**
 * Resolves a signed-in user's permissions from their role grants: built-in roles (with the
 * super admin's per-role overrides) and custom roles. Definitions are cached in memory and
 * reloaded when the Redis version changes, so edits take effect on the next request on every
 * instance without signing anyone out.
 */
@Injectable()
export class PermissionService {
  private readonly logger = new Logger(PermissionService.name);
  private defs: Definitions | null = null;
  private loading: Promise<Definitions> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** `version` is the current AUTHZ_VERSION_KEY value when the caller already read it. */
  async resolve(grants: RoleGrant[], version?: string | null): Promise<Set<Permission>> {
    const defs = await this.definitions(version);
    const result = new Set<Permission>();
    for (const grant of grants) {
      const set = grant.customRoleId ? defs.custom.get(grant.customRoleId)?.permissions : defs.builtIn.get(grant.role);
      for (const p of set ?? []) result.add(p);
    }
    return result;
  }

  /** Custom role names for display (unknown/inactive ids are skipped). */
  async customRoleNames(ids: string[]): Promise<Map<string, string>> {
    const defs = await this.definitions();
    return new Map(ids.flatMap(id => (defs.custom.has(id) ? [[id, defs.custom.get(id)!.name] as const] : [])));
  }

  /** Call after any role definition change (after commit). */
  async invalidate() {
    await this.redis.incr(AUTHZ_VERSION_KEY);
    this.defs = null;
  }

  /** Makes tokens issued to this user before now refresh on their next request. */
  async bumpUser(userId: string) {
    await this.redis.incr(userVersionKey(userId));
  }

  private async definitions(version?: string | null): Promise<Definitions> {
    if (version === undefined) version = await this.redis.get(AUTHZ_VERSION_KEY).catch(() => null);
    const d = this.defs;
    if (d && d.version === version && Date.now() - d.loadedAt < MAX_CACHE_AGE_MS) return d;
    this.loading ??= this.load(version).finally(() => (this.loading = null));
    return this.loading;
  }

  private async load(version: string | null): Promise<Definitions> {
    const [overrides, customRoles] = await Promise.all([
      this.prisma.rolePermissionOverride.findMany(),
      this.prisma.customRole.findMany({ where: { active: true } }),
    ]);
    const builtIn = new Map<Role, Set<Permission>>();
    for (const role of ROLES) builtIn.set(role, effectiveRolePermissions(role, overrides.find(o => o.role === role)));
    const custom = new Map<string, { name: string; baseRole: Role; permissions: Set<Permission> }>();
    for (const c of customRoles) {
      const perms = c.permissions.filter(isPermission).filter(p => !SUPER_ADMIN_ONLY_PERMISSIONS.includes(p));
      custom.set(c.id, { name: c.name, baseRole: c.baseRole, permissions: new Set(perms) });
    }
    this.defs = { version, loadedAt: Date.now(), builtIn, custom };
    this.logger.debug(`Loaded permission definitions (version ${version ?? "none"})`);
    return this.defs;
  }
}
