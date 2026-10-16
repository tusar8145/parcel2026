import type { z } from "zod";
import { Controller, Get, HttpCode, Module, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { emailVerificationConfirmSchema } from "@delivery-fast/shared";
import { CurrentUser, OptionalActor, Public, ReqMeta, type RequestMeta } from "../../common/auth/decorators";
import type { Actor, UserActor } from "../../common/auth/actor";
import { unauthorized } from "../../common/errors";
import { ApiZodBody, ZBody } from "../../common/zod";
import { EmailVerificationService } from "./email-verification.service";

/** Verifying the account's email address (after sign-up or an email change). */
@ApiTags("auth")
@Controller("auth/email-verification")
export class EmailVerificationController {
  constructor(private readonly verification: EmailVerificationService) {}

  /** `{ email, verified, verifiedAt, pending }` for the signed-in user. */
  @Get()
  status(@CurrentUser() user: UserActor) {
    return this.verification.status(user.userId);
  }

  /** Emails a verification link and 6-digit code (60 s between sends; 429 with retryAfterSeconds). */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post()
  @HttpCode(200)
  send(@CurrentUser() user: UserActor, @ReqMeta() meta: RequestMeta) {
    return this.verification.send(user.userId, meta);
  }

  /** `{ token }` from the emailed link (no sign-in needed) or `{ code }` while signed in. */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("confirm")
  @HttpCode(200)
  @ApiZodBody(emailVerificationConfirmSchema)
  confirm(@OptionalActor() actor: Actor | undefined, @ZBody(emailVerificationConfirmSchema) body: z.infer<typeof emailVerificationConfirmSchema>, @ReqMeta() meta: RequestMeta) {
    if (body.token) return this.verification.confirmToken(body.token, meta);
    if (actor?.kind !== "user") throw unauthorized("UNAUTHENTICATED", "Sign in to enter the code, or open the link in the email");
    return this.verification.confirmCode(actor.userId, body.code!, meta);
  }
}

/** Registered in app.module (kept apart from AuthModule's files). */
@Module({ controllers: [EmailVerificationController], providers: [EmailVerificationService], exports: [EmailVerificationService] })
export class EmailVerificationModule {}
