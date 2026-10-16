import type { z } from "zod";
import { Controller, Get, Param, Patch, Post } from "@nestjs/common";
import { ApiConflictResponse, ApiCreatedResponse, ApiNotFoundResponse, ApiOkResponse, ApiTags, ApiUnprocessableEntityResponse } from "@nestjs/swagger";
import { CurrentUser, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { UserActor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { createTicketSchema, listTicketsQuerySchema, replySchema, updateTicketSchema } from "./support.schemas";
import { SupportService } from "./support.service";

@ApiTags("support")
@Controller("support/tickets")
export class SupportController {
  constructor(private readonly support: SupportService) {}

  /** Open a ticket, optionally about one of your parcels, with up to 3 attachments (350 KB each). */
  @RequirePermissions("support:create")
  @Post()
  @ApiZodBody(createTicketSchema)
  @ApiCreatedResponse({ description: "The new ticket with its first message" })
  @ApiUnprocessableEntityResponse({ description: "VALIDATION_FAILED, or UNKNOWN_PARCEL when relatedRef isn't one of your parcels" })
  create(@CurrentUser() actor: UserActor, @ZBody(createTicketSchema) body: z.infer<typeof createTicketSchema>, @ReqMeta() meta: RequestMeta) {
    return this.support.create(actor, body, meta);
  }

  /** Your tickets; support staff see every ticket and can filter by assignee and merchant. Newest first. */
  @RequirePermissions("support:create")
  @Get()
  @ApiZodQuery(listTicketsQuerySchema)
  @ApiOkResponse({ description: "{ items, nextCursor }" })
  list(@CurrentUser() actor: UserActor, @ZQuery(listTicketsQuerySchema) query: z.infer<typeof listTicketsQuerySchema>) {
    return this.support.list(actor, query);
  }

  /** The conversation. Internal notes are only included for support staff. */
  @RequirePermissions("support:create")
  @Get(":number")
  @ApiNotFoundResponse({ description: "No such ticket, or not yours" })
  detail(@CurrentUser() actor: UserActor, @Param("number") number: string) {
    return this.support.detail(actor, number);
  }

  /** Reply (or, for staff, add an internal note). A staff reply waits for the requester; a requester reply reopens the ticket. */
  @RequirePermissions("support:create")
  @Post(":number/messages")
  @ApiZodBody(replySchema)
  @ApiCreatedResponse({ description: "The updated ticket" })
  @ApiConflictResponse({ description: "TICKET_CLOSED" })
  @ApiNotFoundResponse({ description: "No such ticket, or not yours" })
  reply(@CurrentUser() actor: UserActor, @Param("number") number: string, @ZBody(replySchema) body: z.infer<typeof replySchema>, @ReqMeta() meta: RequestMeta) {
    return this.support.reply(actor, number, body, meta);
  }

  /** Staff change status, priority and assignee. Requesters may only close their ticket or reopen a resolved one. */
  @RequirePermissions("support:create")
  @Patch(":number")
  @ApiZodBody(updateTicketSchema)
  @ApiOkResponse({ description: "The updated ticket" })
  @ApiUnprocessableEntityResponse({ description: "VALIDATION_FAILED or INVALID_ASSIGNEE" })
  @ApiNotFoundResponse({ description: "No such ticket, or not yours" })
  update(@CurrentUser() actor: UserActor, @Param("number") number: string, @ZBody(updateTicketSchema) body: z.infer<typeof updateTicketSchema>, @ReqMeta() meta: RequestMeta) {
    return this.support.update(actor, number, body, meta);
  }
}

@ApiTags("support")
@Controller("support")
export class SupportStaffController {
  constructor(private readonly support: SupportService) {}

  /** Who tickets can be assigned to (active support agents, operations managers and super admins). */
  @RequirePermissions("support:manage")
  @Get("assignees")
  @ApiOkResponse({ description: "[{ id, name, roles }]" })
  assignees() {
    return this.support.assignees();
  }
}
