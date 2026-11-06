import type { z } from "zod";
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { CurrentActor, Public, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { AppError } from "../../common/errors";
import {
  applicantResponseSchema,
  inviteMerchantSchema,
  kycPolicySchema,
  kycReviewSchema,
  listInvitesQuerySchema,
  merchantNoteSchema,
  merchantSelectorSchema,
  pageWithSelectorSchema,
  rejectMerchantSchema,
  requestInfoSchema,
  uploadKycDocumentSchema,
} from "./merchants.schemas";
import { MerchantKycService } from "./merchant-kyc.service";
import { MerchantReviewService } from "./merchant-review.service";

type Selector = z.infer<typeof merchantSelectorSchema>;

/** Merchant administration (super admin): review decisions, notes, invitations and KYC. */
@ApiTags("merchants")
@Controller("merchants")
export class MerchantAdminController {
  constructor(
    private readonly review: MerchantReviewService,
    private readonly kyc: MerchantKycService,
  ) {}

  // ── invitations (static paths win over merchants/:id) ──

  @RequirePermissions("merchant:read:any")
  @Get("invites")
  @ApiZodQuery(listInvitesQuerySchema)
  invites(@ZQuery(listInvitesQuerySchema) query: z.infer<typeof listInvitesQuerySchema>) {
    return this.review.listInvites(query);
  }

  /** Sends an SMS/email with a one-time sign-up link (account.invite). */
  @RequirePermissions("merchant:manage")
  @Post("invites")
  @ApiZodBody(inviteMerchantSchema)
  invite(@CurrentActor() actor: Actor, @ZBody(inviteMerchantSchema) body: z.infer<typeof inviteMerchantSchema>, @ReqMeta() meta: RequestMeta) {
    return this.review.invite(actor, body, meta);
  }

  @RequirePermissions("merchant:manage")
  @Delete("invites/:id")
  revokeInvite(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.review.revokeInvite(actor, id, meta);
  }

  /** Public: prefill the sign-up / application form from an invitation link. */
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post("invites/lookup")
  @HttpCode(200)
  lookupInvite(@Body() body: { token?: unknown }) {
    if (typeof body?.token !== "string" || body.token.length < 10 || body.token.length > 200) throw new AppError("VALIDATION_FAILED", "Send the invitation token", 400);
    return this.review.lookupInvite(body.token);
  }

  // ── KYC policy ──

  /** What approved KYC is required for (API keys, COD payouts, activation) and which documents. */
  @Get("kyc-policy")
  async kycPolicy() {
    return this.kyc.policyView(await this.kyc.policy());
  }

  @RequirePermissions("merchant:manage")
  @Put("kyc-policy")
  @ApiZodBody(kycPolicySchema)
  setKycPolicy(@CurrentActor() actor: Actor, @ZBody(kycPolicySchema) body: z.infer<typeof kycPolicySchema>, @ReqMeta() meta: RequestMeta) {
    return this.kyc.setPolicy(actor, body, meta);
  }

  // ── review decisions ──

  @RequirePermissions("merchant:manage")
  @Post(":id/reject")
  @HttpCode(200)
  @ApiZodBody(rejectMerchantSchema)
  reject(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(rejectMerchantSchema) body: z.infer<typeof rejectMerchantSchema>, @ReqMeta() meta: RequestMeta) {
    return this.review.reject(actor, id, body, meta);
  }

  @RequirePermissions("merchant:manage")
  @Post(":id/request-info")
  @HttpCode(200)
  @ApiZodBody(requestInfoSchema)
  requestInfo(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(requestInfoSchema) body: z.infer<typeof requestInfoSchema>, @ReqMeta() meta: RequestMeta) {
    return this.review.requestInfo(actor, id, body, meta);
  }

  // ── account notes (history with author and time) ──

  @RequirePermissions("merchant:read:any")
  @Get(":id/notes")
  @ApiZodQuery(pageWithSelectorSchema)
  notes(@Param("id", ParseUUIDPipe) id: string, @ZQuery(pageWithSelectorSchema) query: z.infer<typeof pageWithSelectorSchema>) {
    return this.review.notes(id, query);
  }

  @RequirePermissions("merchant:manage")
  @Post(":id/notes")
  @ApiZodBody(merchantNoteSchema)
  addNote(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(merchantNoteSchema) body: z.infer<typeof merchantNoteSchema>, @ReqMeta() meta: RequestMeta) {
    return this.review.addNote(actor, id, body, meta);
  }

  // ── KYC review ──

  @RequirePermissions("merchant:read:any")
  @Get(":id/kyc")
  kycFor(@Param("id", ParseUUIDPipe) id: string) {
    return this.kyc.forStaff(id);
  }

  @RequirePermissions("merchant:read:any")
  @Get(":id/kyc/documents/:documentId")
  kycDocument(@Param("id", ParseUUIDPipe) id: string, @Param("documentId", ParseUUIDPipe) documentId: string) {
    return this.kyc.documentFile(id, documentId);
  }

  @RequirePermissions("merchant:manage")
  @Post(":id/kyc/review")
  @HttpCode(200)
  @ApiZodBody(kycReviewSchema)
  reviewKyc(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string, @ZBody(kycReviewSchema) body: z.infer<typeof kycReviewSchema>, @ReqMeta() meta: RequestMeta) {
    return this.kyc.review(actor, id, body, meta);
  }
}

/** The applicant / merchant side of review and KYC. */
@ApiTags("merchant self-service")
@Controller("merchants/me")
export class MerchantSelfReviewController {
  constructor(
    private readonly review: MerchantReviewService,
    private readonly kyc: MerchantKycService,
  ) {}

  /** Application status, rejection reason and messages with Delivery Fast. */
  @Get("review")
  @ApiZodQuery(merchantSelectorSchema)
  myReview(@CurrentActor() actor: Actor, @ZQuery(merchantSelectorSchema) query: Selector) {
    return this.review.myReview(actor, query.merchantId);
  }

  /** Answer an information request; the application returns to review. */
  @RequirePermissions("merchant:self")
  @Post("review/respond")
  @HttpCode(200)
  @ApiZodQuery(merchantSelectorSchema)
  @ApiZodBody(applicantResponseSchema)
  respond(@CurrentActor() actor: Actor, @ZQuery(merchantSelectorSchema) query: Selector, @ZBody(applicantResponseSchema) body: z.infer<typeof applicantResponseSchema>, @ReqMeta() meta: RequestMeta) {
    return this.review.respond(actor, query.merchantId, body, meta);
  }

  @Get("kyc")
  @ApiZodQuery(merchantSelectorSchema)
  myKyc(@CurrentActor() actor: Actor, @ZQuery(merchantSelectorSchema) query: Selector) {
    return this.kyc.mine(actor, query.merchantId);
  }

  /** Upload (or replace) one document as a data URL. Owners only. */
  @RequirePermissions("merchant:self")
  @Post("kyc/documents")
  @ApiZodQuery(merchantSelectorSchema)
  @ApiZodBody(uploadKycDocumentSchema)
  upload(@CurrentActor() actor: Actor, @ZQuery(merchantSelectorSchema) query: Selector, @ZBody(uploadKycDocumentSchema) body: z.infer<typeof uploadKycDocumentSchema>, @ReqMeta() meta: RequestMeta) {
    return this.kyc.upload(actor, query.merchantId, body, meta);
  }

  @RequirePermissions("merchant:self")
  @Get("kyc/documents/:documentId")
  @ApiZodQuery(merchantSelectorSchema)
  document(@CurrentActor() actor: Actor, @ZQuery(merchantSelectorSchema) query: Selector, @Param("documentId", ParseUUIDPipe) documentId: string) {
    return this.kyc.myDocumentFile(actor, query.merchantId, documentId);
  }

  /** Send the uploaded documents for review. */
  @RequirePermissions("merchant:self")
  @Post("kyc/submit")
  @HttpCode(200)
  @ApiZodQuery(merchantSelectorSchema)
  submit(@CurrentActor() actor: Actor, @ZQuery(merchantSelectorSchema) query: Selector, @ReqMeta() meta: RequestMeta) {
    return this.kyc.submit(actor, query.merchantId, meta);
  }
}
