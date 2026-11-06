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
import { ImpersonationService, impersonationTargetsQuerySchema, listImpersonationsQuerySchema, startImpersonationSchema } from "./impersonation.service";
import { platformConfigSchema, PLATFORM_CONFIG_MAX_BYTES, type PlatformConfig } from "./admin.schemas";
import { DERIVED_KEYS, PlatformConfigService, RETIRED_KEYS } from "./platform-config.service";
import { OverviewService } from "./overview.service";
import { periodQuerySchema, type PeriodQuery } from "../../common/period";

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

  /** Platform counts for the super admin overview and activity pages; `period` = the figures for from / to (Dhaka days; default this month). */
  @RequirePermissions("merchant:read:any", "user:read", "audit:read")
  @Get("overview")
  @ApiZodQuery(periodQuerySchema)
  overview(@ZQuery(periodQuerySchema) query: PeriodQuery) {
    return this.overviewService.overview(query);
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
   * Starts support access / "Log in as": a short-lived access token for viewing the platform as
   * this user (read-only unless readOnly: false). Target by userId, riderId or merchantId (its
   * owner). Reason required; audited; super admin and staff accounts can't be opened. Needs
   * user:impersonate (super admin, read-only or full access) or user:login-as (operations
   * managers: read-only, merchant members and riders only); checked in the service.
   */
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

  /** "Log in as" candidates: a merchant's members (owners first) or a rider, and whether each can be opened by you. */
  @Get("impersonations/targets")
  @ApiZodQuery(impersonationTargetsQuerySchema)
  targets(@CurrentUser() actor: UserActor, @ZQuery(impersonationTargetsQuerySchema) query: z.infer<typeof impersonationTargetsQuerySchema>) {
    return this.impersonation.targets(actor, query);
  }

  /** Ends support access (from the admin's panel, by the person who started it, or from the impersonation tab itself). */
  @Post("impersonations/:id/end")
  @HttpCode(200)
  end(@CurrentUser() actor: UserActor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.impersonation.end(actor, id, meta);
  }
}
