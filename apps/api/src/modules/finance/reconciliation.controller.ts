import type { z } from "zod";
import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CurrentActor, CurrentUser, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor, UserActor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { forbidden } from "../../common/errors";
import { isFinanceStaff } from "./finance.scope";
import { ReconciliationService } from "./reconciliation.service";
import { autoMatchSchema, exceptionsQuerySchema, ignoreLineSchema, listLinesQuerySchema, matchLineSchema, uploadStatementSchema } from "./reconciliation.schemas";

const staffOnly = (actor: Actor) => {
  if (!isFinanceStaff(actor)) throw forbidden("Only finance staff can reconcile statements");
};

/** Bank / bKash statement reconciliation (finance staff). */
@ApiTags("finance")
@Controller("finance/reconciliation")
export class ReconciliationController {
  constructor(private readonly recon: ReconciliationService) {}

  /** Upload a statement CSV ({ source, accountLabel, filename, content }); duplicates of already imported lines are skipped. */
  @RequirePermissions("finance:manage")
  @Post("statements")
  @ApiZodBody(uploadStatementSchema)
  upload(@CurrentUser() actor: UserActor, @ZBody(uploadStatementSchema) body: z.infer<typeof uploadStatementSchema>, @ReqMeta() meta: RequestMeta) {
    return this.recon.upload(actor, body, meta);
  }

  @RequirePermissions("finance:read")
  @Get("statements")
  statements(@CurrentActor() actor: Actor) {
    staffOnly(actor);
    return this.recon.statements();
  }

  @RequirePermissions("finance:read")
  @Get("statements/:id")
  statement(@CurrentActor() actor: Actor, @Param("id", ParseUUIDPipe) id: string) {
    staffOnly(actor);
    return this.recon.statementDetail(id);
  }

  @RequirePermissions("finance:read")
  @Get("lines")
  @ApiZodQuery(listLinesQuerySchema)
  lines(@CurrentActor() actor: Actor, @ZQuery(listLinesQuerySchema) query: z.infer<typeof listLinesQuerySchema>) {
    staffOnly(actor);
    return this.recon.lines(query);
  }

  /** Re-run automatic matching (all unmatched lines, or one statement's). */
  @RequirePermissions("finance:manage")
  @Post("auto-match")
  @HttpCode(200)
  @ApiZodBody(autoMatchSchema)
  autoMatch(@CurrentUser() actor: UserActor, @ZBody(autoMatchSchema) body: z.infer<typeof autoMatchSchema>, @ReqMeta() meta: RequestMeta) {
    return this.recon.autoMatch(actor, body.statementId, meta);
  }

  /** Match a line to one settlement, invoice (an issued one is marked paid) or rider payout. A note is required when amounts differ. */
  @RequirePermissions("finance:manage")
  @Post("lines/:id/match")
  @HttpCode(200)
  @ApiZodBody(matchLineSchema)
  match(@CurrentUser() actor: UserActor, @Param("id", ParseUUIDPipe) id: string, @ZBody(matchLineSchema) body: z.infer<typeof matchLineSchema>, @ReqMeta() meta: RequestMeta) {
    return this.recon.match(actor, id, body, meta);
  }

  @RequirePermissions("finance:manage")
  @Post("lines/:id/unmatch")
  @HttpCode(200)
  unmatch(@CurrentUser() actor: UserActor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.recon.unmatch(actor, id, meta);
  }

  /** Mark a line as needing no match (bank charges, transfers between own accounts…), with a reason. */
  @RequirePermissions("finance:manage")
  @Post("lines/:id/ignore")
  @HttpCode(200)
  @ApiZodBody(ignoreLineSchema)
  ignore(@CurrentUser() actor: UserActor, @Param("id", ParseUUIDPipe) id: string, @ZBody(ignoreLineSchema) body: z.infer<typeof ignoreLineSchema>, @ReqMeta() meta: RequestMeta) {
    return this.recon.ignore(actor, id, body, meta);
  }

  @RequirePermissions("finance:manage")
  @Post("lines/:id/restore")
  @HttpCode(200)
  restore(@CurrentUser() actor: UserActor, @Param("id", ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.recon.restore(actor, id, meta);
  }

  /** Unmatched lines plus paid payouts / invoice payments with no confirming bank line (default: last 60 days, older than 2 days). */
  @RequirePermissions("finance:read")
  @Get("exceptions")
  @ApiZodQuery(exceptionsQuerySchema)
  exceptions(@CurrentActor() actor: Actor, @ZQuery(exceptionsQuerySchema) query: z.infer<typeof exceptionsQuerySchema>) {
    staffOnly(actor);
    return this.recon.exceptions(query);
  }
}
