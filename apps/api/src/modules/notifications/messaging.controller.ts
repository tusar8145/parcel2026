import type { z } from "zod";
import { Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { CurrentUser, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { UserActor } from "../../common/auth/actor";
import { AppError } from "../../common/errors";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { pageQuerySchema } from "../../common/pagination";
import { MessageBroadcastService, messageAudienceSchema, messageBroadcastSchema } from "./message-broadcast.service";

const channelOf = (c: string) => {
  if (c === "sms") return "SMS" as const;
  if (c === "email") return "EMAIL" as const;
  throw new AppError("NOT_FOUND", "Unknown channel", 404);
};

/** Super admin › Messaging › SMS / Email messages: the count, send, and the history. */
@ApiTags("notifications")
@ApiBearerAuth()
@Controller("notifications/messages")
@RequirePermissions("config:manage")
export class MessagingController {
  constructor(private readonly broadcasts: MessageBroadcastService) {}

  @Post(":channel/preview")
  @HttpCode(200)
  @ApiZodBody(messageAudienceSchema)
  preview(@Param("channel") channel: string, @ZBody(messageAudienceSchema) body: z.infer<typeof messageAudienceSchema>) {
    return this.broadcasts.preview(channelOf(channel), body);
  }

  @Get(":channel")
  @ApiZodQuery(pageQuerySchema)
  history(@Param("channel") channel: string, @ZQuery(pageQuerySchema) query: z.infer<typeof pageQuerySchema>) {
    return this.broadcasts.list(channelOf(channel), query);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(":channel")
  @HttpCode(200)
  @ApiZodBody(messageBroadcastSchema)
  send(@CurrentUser() actor: UserActor, @Param("channel") channel: string, @ZBody(messageBroadcastSchema) body: z.infer<typeof messageBroadcastSchema>, @ReqMeta() meta: RequestMeta) {
    return this.broadcasts.send(actor, channelOf(channel), body, meta);
  }
}
