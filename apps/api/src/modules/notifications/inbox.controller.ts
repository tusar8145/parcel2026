import type { z } from "zod";
import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { CurrentUser, ReqMeta, type RequestMeta } from "../../common/auth/decorators";
import type { UserActor } from "../../common/auth/actor";
import { ApiZodQuery, ZQuery } from "../../common/zod";
import { InboxService } from "./inbox.service";
import { listNotificationsQuerySchema } from "./inbox.schemas";

/** The signed-in user's in-app notifications (the bell and Notifications page in every panel). */
@ApiTags("profile")
@ApiBearerAuth()
@Controller("me/notifications")
export class InboxController {
  constructor(private readonly inbox: InboxService) {}

  /** Newest first: { items: [{ id, type, title, body, link, readAt, createdAt }], nextCursor, unread }. */
  @Get()
  @ApiZodQuery(listNotificationsQuerySchema)
  list(@CurrentUser() actor: UserActor, @ZQuery(listNotificationsQuerySchema) query: z.infer<typeof listNotificationsQuerySchema>) {
    return this.inbox.list(actor, query);
  }

  /** { unread }: the bell's number. */
  @Get("count")
  count(@CurrentUser() actor: UserActor) {
    return this.inbox.count(actor);
  }

  /** Marks every unread notification read. */
  @Post("read-all")
  @HttpCode(200)
  readAll(@CurrentUser() actor: UserActor, @ReqMeta() meta: RequestMeta) {
    return this.inbox.readAll(actor, meta);
  }

  /** Marks one notification read (your own only; others' are 404). */
  @Post(":id/read")
  @HttpCode(200)
  read(@CurrentUser() actor: UserActor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.inbox.read(actor, id, meta);
  }
}
