import type { z } from "zod";
import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { updateProfileSchema } from "@delivery-fast/shared";
import { CurrentActor, CurrentUser, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor, UserActor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import {
  createAddressSchema,
  createUserSchema,
  listAddressesQuerySchema,
  listAuditLogsQuerySchema,
  listUsersQuerySchema,
  roleGrantSchema,
  updateAddressSchema,
  updateUserSchema,
} from "./accounts.schemas";
import { ProfileService } from "./profile.service";
import { UsersService } from "./users.service";
import { AuditLogsService } from "./audit-logs.service";

/** The signed-in user's own profile and address book (any signed-in user). */
@ApiTags("profile")
@ApiBearerAuth()
@Controller("me")
export class ProfileController {
  constructor(private readonly profile: ProfileService) {}

  @Patch()
  @ApiZodBody(updateProfileSchema)
  update(@CurrentUser() actor: UserActor, @ZBody(updateProfileSchema) body: z.infer<typeof updateProfileSchema>, @ReqMeta() meta: RequestMeta) {
    return this.profile.updateProfile(actor, body, meta);
  }

  @Get("addresses")
  @ApiZodQuery(listAddressesQuerySchema)
  listAddresses(@CurrentUser() actor: UserActor, @ZQuery(listAddressesQuerySchema) query: z.infer<typeof listAddressesQuerySchema>) {
    return this.profile.listAddresses(actor, query.role);
  }

  @Post("addresses")
  @ApiZodBody(createAddressSchema)
  createAddress(@CurrentUser() actor: UserActor, @ZBody(createAddressSchema) body: z.infer<typeof createAddressSchema>, @ReqMeta() meta: RequestMeta) {
    return this.profile.createAddress(actor, body, meta);
  }

  @Patch("addresses/:id")
  @ApiZodBody(updateAddressSchema)
  updateAddress(
    @CurrentUser() actor: UserActor,
    @Param("id", ParseUUIDPipe) id: string,
    @ZBody(updateAddressSchema) body: z.infer<typeof updateAddressSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.profile.updateAddress(actor, id, body, meta);
  }

  @Delete("addresses/:id")
  @HttpCode(204)
  async deleteAddress(@CurrentUser() actor: UserActor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    await this.profile.deleteAddress(actor, id, meta);
  }
}

@ApiTags("users")
@Controller("users")
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @RequirePermissions("user:read")
  @Get()
  @ApiZodQuery(listUsersQuerySchema)
  list(@ZQuery(listUsersQuerySchema) query: z.infer<typeof listUsersQuerySchema>) {
    return this.users.list(query);
  }

  @RequirePermissions("user:read")
  @Get(":id")
  get(@Param("id", ParseUUIDPipe) id: string) {
    return this.users.get(id);
  }

  @RequirePermissions("user:manage")
  @Post()
  @ApiZodBody(createUserSchema)
  create(@CurrentActor() actor: Actor, @ZBody(createUserSchema) body: z.infer<typeof createUserSchema>, @ReqMeta() meta: RequestMeta) {
    return this.users.create(actor, body, meta);
  }

  @RequirePermissions("user:manage")
  @Patch(":id")
  @ApiZodBody(updateUserSchema)
  update(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(updateUserSchema) body: z.infer<typeof updateUserSchema>, @ReqMeta() meta: RequestMeta) {
    return this.users.update(actor, id, body, meta);
  }

  @RequirePermissions("user:manage")
  @Post(":id/roles")
  @ApiZodBody(roleGrantSchema)
  addRole(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(roleGrantSchema) body: z.infer<typeof roleGrantSchema>, @ReqMeta() meta: RequestMeta) {
    return this.users.addRole(actor, id, body, meta);
  }

  /** Turns off a user's two-step verification (lost device). Super admins only; the user is signed out and notified. */
  @RequirePermissions("user:manage")
  @Post(":id/mfa/reset")
  @HttpCode(200)
  resetMfa(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.users.resetMfa(actor, id, meta);
  }

  @RequirePermissions("user:manage")
  @Delete(":id/roles/:roleId")
  removeRole(
    @CurrentActor() actor: Actor,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("roleId", ParseUUIDPipe) roleId: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.users.removeRole(actor, id, roleId, meta);
  }
}

@ApiTags("audit")
@Controller("audit-logs")
export class AuditLogsController {
  constructor(private readonly auditLogs: AuditLogsService) {}

  @RequirePermissions("audit:read")
  @Get()
  @ApiZodQuery(listAuditLogsQuerySchema)
  list(@ZQuery(listAuditLogsQuerySchema) query: z.infer<typeof listAuditLogsQuerySchema>) {
    return this.auditLogs.list(query);
  }
}
