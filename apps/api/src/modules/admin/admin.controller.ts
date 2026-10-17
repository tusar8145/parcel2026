import { Controller, Delete, Get, Header, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import type { z } from "zod";
import { ROLES, type Role } from "@delivery-fast/shared";
import { ApiNotFoundResponse, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { CurrentActor, CurrentUser, Public, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor, UserActor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { AppError } from "../../common/errors";
import type { SubmitResult } from "../approvals/approvals.service";
import { createCustomRoleSchema, rolePermissionsSchema, RolesService, updateCustomRoleSchema } from "./roles.service";
import { ImpersonationService, listImpersonationsQuerySchema, startImpersonationSchema } from "./impersonation.service";
import { platformConfigSchema, PLATFORM_CONFIG_MAX_BYTES, type PlatformConfig } from "./admin.schemas";
import { DERIVED_KEYS, PlatformConfigService, RETIRED_KEYS } from "./platform-config.service";
import { OverviewService } from "./overview.service";

const DERIVED_NOTE = `Server-owned settings (${DERIVED_KEYS.join(", ")}) and the route/weight fields of merchantPricing and deliveryRates always reflect PUT /catalog and the rate cards in force. Retired lists (${RETIRED_KEYS.join(", ")}) are never stored or returned: products are the parcel products (/parcel-products).`;

@ApiTags("settings")
@Controller("settings")
export class SettingsController {
  constructor(private readonly config: PlatformConfigService) {}

  /** Shared settings every page reads (public: no personal data). 404 until a super admin first saves them. */
  @Public()
  @Get("platform-config")
  @Header("Cache-Control", "no-store")
  @ApiOkResponse({ description: `The platform configuration object. ${DERIVED_NOTE}` })
  @ApiNotFoundResponse({ description: "Nothing has been saved yet" })
  get() {
    return this.config.get();
  }

  /** Replaces the platform configuration. Any JSON object up to 256 KB; returns what GET now returns. */
  @RequirePermissions("config:manage")
  @Put("platform-config")
  @ApiZodBody(platformConfigSchema)
  @ApiOkResponse({ description: `The saved configuration (limit ${PLATFORM_CONFIG_MAX_BYTES / 1024} KB). ${DERIVED_NOTE} Values sent for them are ignored.` })
  save(@CurrentActor() actor: Actor, @ZBody(platformConfigSchema) body: PlatformConfig, @ReqMeta() meta: RequestMeta) {
    return this.config.save(actor, body, meta);
  }
}

@ApiTags("admin")
@Controller("admin")
export class AdminController {
  constructor(private readonly overviewService: OverviewService) {}

  /** Platform counts for the super admin overview and activity pages. */
  @RequirePermissions("merchant:read:any", "user:read", "audit:read")
  @Get("overview")
  overview() {
    return this.overviewService.overview();
  }
}

/** Applied at once → the result; waiting for a second super admin → 202 { status: "PENDING", changeRequest }. */
function changeResponse(reply: FastifyReply, result: SubmitResult) {
  if (result.status === "APPLIED") return result.result;
  reply.status(202);
  return result;
}

const roleParam = (value: string): Role => {
  const role = value.toUpperCase();
  if (!(ROLES as readonly string[]).includes(role)) throw new AppError("UNKNOWN_ROLE", `Unknown role ${value}`, 404);
  return role as Role;
};

/** Role and permission editor, and support access ("view as"). */
@ApiTags("admin")
@Controller("admin")
export class SecurityController {
  constructor(
    private readonly roles: RolesService,
    private readonly impersonation: ImpersonationService,
  ) {}

  /** Permissions × roles: built-in roles (with overrides) and custom roles. */
  @RequirePermissions("user:read")
  @Get("roles")
  matrix() {
    return this.roles.matrix();
  }

  /** Replaces a built-in role's permissions. SUPER_ADMIN always keeps its critical permissions. Needs a second super admin's approval. */
  @RequirePermissions("role:manage")
  @Put("roles/:role/permissions")
  @ApiZodBody(rolePermissionsSchema)
  async setRolePermissions(
    @CurrentActor() actor: Actor,
    @Param("role") role: string,
    @ZBody(rolePermissionsSchema) body: z.infer<typeof rolePermissionsSchema>,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return changeResponse(reply, await this.roles.setRolePermissions(actor, roleParam(role), body.permissions, meta));
  }

  @RequirePermissions("role:manage")
  @Post("custom-roles")
  @ApiZodBody(createCustomRoleSchema)
  async createCustomRole(
    @CurrentActor() actor: Actor,
    @ZBody(createCustomRoleSchema) body: z.infer<typeof createCustomRoleSchema>,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return changeResponse(reply, await this.roles.createCustomRole(actor, body, meta));
  }

  @RequirePermissions("role:manage")
  @Patch("custom-roles/:id")
  @ApiZodBody(updateCustomRoleSchema)
  async updateCustomRole(
    @CurrentActor() actor: Actor,
    @Param("id", ParseUUIDPipe) id: string,
    @ZBody(updateCustomRoleSchema) body: z.infer<typeof updateCustomRoleSchema>,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return changeResponse(reply, await this.roles.updateCustomRole(actor, id, body, meta));
  }

  @RequirePermissions("role:manage")
  @Delete("custom-roles/:id")
  async deleteCustomRole(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta, @Res({ passthrough: true }) reply: FastifyReply) {
    return changeResponse(reply, await this.roles.deleteCustomRole(actor, id, meta));
  }

  /**
   * Starts support access: a short-lived access token for viewing the platform as this user
   * (read-only unless readOnly: false). Reason required; audited; super admins can't be opened.
   */
  @RequirePermissions("user:impersonate")
  @Post("impersonations")
  @ApiZodBody(startImpersonationSchema)
  start(@CurrentUser() actor: UserActor, @ZBody(startImpersonationSchema) body: z.infer<typeof startImpersonationSchema>, @ReqMeta() meta: RequestMeta) {
    return this.impersonation.start(actor, body, meta);
  }

  @RequirePermissions("user:impersonate")
  @Get("impersonations")
  @ApiZodQuery(listImpersonationsQuerySchema)
  list(@ZQuery(listImpersonationsQuerySchema) query: z.infer<typeof listImpersonationsQuerySchema>) {
    return this.impersonation.list(query);
  }

  /** Ends support access (from the admin's panel, or from the impersonation tab itself). */
  @Post("impersonations/:id/end")
  @HttpCode(200)
  end(@CurrentUser() actor: UserActor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.impersonation.end(actor, id, meta);
  }
}
