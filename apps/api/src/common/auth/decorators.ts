import { applyDecorators, createParamDecorator, ExecutionContext, SetMetadata } from "@nestjs/common";
import { ApiBearerAuth, ApiForbiddenResponse, ApiUnauthorizedResponse } from "@nestjs/swagger";
import type { Permission } from "@paira-express/shared";
import type { Actor, UserActor } from "./actor";
import { unauthorized } from "../errors";

export const PUBLIC_KEY = "auth:public";
export const PERMISSIONS_KEY = "auth:permissions";
export const ALLOW_API_KEY = "auth:allow-api-key";

/** No authentication needed (an actor is still attached when a valid token is sent). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/** Requires every listed permission. Without this, any signed-in user is allowed. */
export const RequirePermissions = (...permissions: Permission[]) =>
  applyDecorators(
    SetMetadata(PERMISSIONS_KEY, permissions),
    ApiBearerAuth(),
    ApiUnauthorizedResponse({ description: "Not signed in" }),
    ApiForbiddenResponse({ description: `Requires: ${permissions.join(", ")}` }),
  );

/** Merchant API keys are rejected unless the route opts in. */
export const AllowApiKey = () => SetMetadata(ALLOW_API_KEY, true);

export const CurrentActor = createParamDecorator((_: unknown, ctx: ExecutionContext): Actor => {
  const actor = ctx.switchToHttp().getRequest().actor as Actor | undefined;
  if (!actor) throw unauthorized();
  return actor;
});

export const OptionalActor = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): Actor | undefined => ctx.switchToHttp().getRequest().actor,
);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): UserActor => {
  const actor = ctx.switchToHttp().getRequest().actor as Actor | undefined;
  if (!actor || actor.kind !== "user") throw unauthorized();
  return actor;
});

export interface RequestMeta {
  ip: string;
  userAgent?: string;
  requestId: string;
}

export const ReqMeta = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestMeta => {
  const req = ctx.switchToHttp().getRequest();
  return { ip: req.ip, userAgent: req.headers["user-agent"]?.slice(0, 300), requestId: String(req.id) };
});
