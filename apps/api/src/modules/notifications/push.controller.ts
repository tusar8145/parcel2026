import type { z } from "zod";
import { Controller, Get, HttpCode, Post, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { CurrentActor, CurrentUser, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor, UserActor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { pageQuerySchema } from "../../common/pagination";
import { PushService, pushGatewaySchema, registerDeviceSchema, removeDeviceSchema } from "./push.service";
import { PushBroadcastService, broadcastSchema, recipientsQuerySchema, testPushSchema } from "./push-broadcast.service";

/** The apps: this phone's push token, after sign-in (and when Firebase renews it); removed at sign-out. */
@ApiTags("profile")
@ApiBearerAuth()
@Controller("me/push-devices")
export class PushDevicesController {
  constructor(private readonly push: PushService) {}

  @Post()
  @HttpCode(200)
  @ApiZodBody(registerDeviceSchema)
  register(@CurrentUser() actor: UserActor, @ZBody(registerDeviceSchema) body: z.infer<typeof registerDeviceSchema>) {
    return this.push.register(actor.userId, body);
  }

  @Post("remove")
  @HttpCode(200)
  @ApiZodBody(removeDeviceSchema)
  remove(@CurrentUser() actor: UserActor, @ZBody(removeDeviceSchema) body: z.infer<typeof removeDeviceSchema>) {
    return this.push.remove(actor.userId, body.token);
  }
}

/** Super admin: Firebase settings, a test push, and messages to all / chosen merchants and riders (with history). */
@ApiTags("notifications")
@ApiBearerAuth()
@Controller("notifications/push")
@RequirePermissions("config:manage")
export class PushAdminController {
  constructor(
    private readonly push: PushService,
    private readonly broadcasts: PushBroadcastService,
  ) {}

  @Get()
  status() {
    return this.push.status();
  }

  /** The service account file (write-only) and the on/off switch. */
  @Put()
  @ApiZodBody(pushGatewaySchema)
  save(@CurrentActor() actor: Actor, @ZBody(pushGatewaySchema) body: z.infer<typeof pushGatewaySchema>, @ReqMeta() meta: RequestMeta) {
    return this.push.save(actor, body, meta);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("test")
  @HttpCode(200)
  @ApiZodBody(testPushSchema)
  test(@ZBody(testPushSchema) body: z.infer<typeof testPushSchema>) {
    return this.broadcasts.test(body.userId);
  }

  @Get("recipients")
  @ApiZodQuery(recipientsQuerySchema)
  recipients(@ZQuery(recipientsQuerySchema) query: z.infer<typeof recipientsQuerySchema>) {
    return this.broadcasts.recipients(query);
  }

  @Get("broadcasts")
  @ApiZodQuery(pageQuerySchema)
  history(@ZQuery(pageQuerySchema) query: z.infer<typeof pageQuerySchema>) {
    return this.broadcasts.list(query);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("broadcasts")
  @HttpCode(200)
  @ApiZodBody(broadcastSchema)
  broadcast(@CurrentUser() actor: UserActor, @ZBody(broadcastSchema) body: z.infer<typeof broadcastSchema>, @ReqMeta() meta: RequestMeta) {
    return this.broadcasts.send(actor, body, meta);
  }
}
