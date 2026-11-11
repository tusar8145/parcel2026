import { Controller, HttpCode, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { CurrentActor, RequirePermissions } from "../../common/auth/decorators";
import type { Actor } from "../../common/auth/actor";
import { ApiZodBody, ZBody } from "../../common/zod";
import { PrismaService } from "../../common/prisma.service";
import { NotifyService } from "./notify.service";
import { inviteMessage } from "./account-invite";
import { smsSegments } from "./render";

export const invitePreviewSchema = z.object({
  kind: z.enum(["rider", "franchise", "merchant", "merchant_onboard", "staff"]),
  /** kind staff: the role names as the message says them ("Hub Manager"). */
  staffRole: z.string().trim().max(120).optional(),
  name: z.string().trim().max(120).optional(),
  hubId: z.uuid().optional(),
  code: z.string().trim().max(20).optional(),
  franchiseName: z.string().trim().max(120).optional(),
  businessName: z.string().trim().max(160).optional(),
  merchantType: z.enum(["ECOMMERCE", "BANKING_FINANCIAL"]).optional(),
});

/** The SMS (and email subject) a new account would get, before the form sends it (the "Send SMS" switch). */
@ApiTags("notifications")
@ApiBearerAuth()
@Controller("accounts")
export class AccountInviteController {
  constructor(
    private readonly notify: NotifyService,
    private readonly prisma: PrismaService,
  ) {}

  @RequirePermissions("user:read")
  @Post("invite-preview")
  @HttpCode(200)
  @ApiZodBody(invitePreviewSchema)
  async preview(@CurrentActor() actor: Actor, @ZBody(invitePreviewSchema) body: z.infer<typeof invitePreviewSchema>) {
    const hub = body.hubId ? await this.prisma.hub.findUnique({ where: { id: body.hubId }, select: { name: true } }) : null;
    const { event, vars } = inviteMessage(body.kind, { ...body, inviter: actor.kind === "user" ? actor.name : "Delivery Fast", hubName: hub?.name ?? null });
    const [sms, email] = await Promise.all([this.notify.render(event, "sms", vars), this.notify.render(event, "email", vars)]);
    return { event, sms: sms?.body ?? null, segments: sms ? smsSegments(sms.body) : null, emailSubject: email?.subject ?? null };
  }
}
