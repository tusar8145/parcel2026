import type { z } from "zod";
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from "@nestjs/common";
import { ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { CurrentActor, CurrentUser, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor, UserActor } from "../../common/auth/actor";
import { ApiZodBody, ApiZodQuery, ZBody, ZQuery } from "../../common/zod";
import { forbidden, notFound } from "../../common/errors";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { Prisma } from "../../generated/prisma/client";
import { canChangeFinanceSettings, financeMerchantScope, isFinanceStaff } from "./finance.scope";
import { FINANCE_CONFIG_KEY, financeConfigSchema, readFinanceConfig, updateFinanceConfigSchema } from "./finance-config";
import { LedgerReportsService } from "./ledger-reports.service";
import { SYSTEM_ACCOUNTS } from "./ledger.service";
import {
  closePeriodSchema,
  createAccountSchema,
  depositSchema,
  listEntriesQuerySchema,
  manualJournalSchema,
  merchantStatementQuerySchema,
  periodSchema,
  statementQuerySchema,
  trialBalanceQuerySchema,
} from "./ledger.schemas";
import { listSchedulesQuerySchema, updateScheduleSchema } from "./finance.schemas";
import { SettlementScheduleService } from "./settlement-schedule.service";

const staffOnly = (actor: Actor) => {
  if (!isFinanceStaff(actor)) throw forbidden("Only finance staff can see the ledger");
};

/** Double-entry ledger, finance settings and the automatic settlement schedule. */
@ApiTags("finance")
@Controller("finance")
export class LedgerController {
  constructor(
    private readonly reports: LedgerReportsService,
    private readonly schedules: SettlementScheduleService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ───────────── settings ─────────────

  /** VAT rate, company BIN/address printed on invoices, invoice payment term. */
  @RequirePermissions("finance:read")
  @Get("config")
  config(@CurrentActor() actor: Actor) {
    staffOnly(actor);
    return readFinanceConfig(this.prisma);
  }

  @RequirePermissions("finance:manage")
  @Put("config")
  @ApiZodBody(updateFinanceConfigSchema)
  async updateConfig(@CurrentUser() actor: UserActor, @ZBody(updateFinanceConfigSchema) body: z.infer<typeof updateFinanceConfigSchema>, @ReqMeta() meta: RequestMeta) {
    // How settlements are approved is a control over money: super admins decide it, not finance users.
    if (body.settlementApproval !== undefined && !actor.roles.some(r => r.role === "SUPER_ADMIN"))
      throw forbidden("Only a super admin can change how settlements are approved");
    if (!canChangeFinanceSettings(actor)) throw forbidden("Only finance users and super admins can change finance settings");
    const current = await readFinanceConfig(this.prisma);
    const next = financeConfigSchema.parse({ ...current, ...body, seller: { ...current.seller, ...(body.seller ?? {}) } });
    await this.prisma.$transaction(async tx => {
      await tx.setting.upsert({ where: { key: FINANCE_CONFIG_KEY }, create: { key: FINANCE_CONFIG_KEY, value: next }, update: { value: next } });
      await this.audit.record(actor, { action: "finance.config.update", entityType: "setting", entityId: FINANCE_CONFIG_KEY, data: { from: current, to: next } as unknown as Prisma.InputJsonObject }, meta, tx);
    });
    return next;
  }

  // ───────────── ledger ─────────────

  /** Chart of accounts with current balances. */
  @RequirePermissions("finance:read")
  @Get("ledger/accounts")
  @ApiOkResponse({ description: `System accounts: ${SYSTEM_ACCOUNTS.map(a => `${a.code} ${a.name}`).join(", ")}` })
  accounts(@CurrentActor() actor: Actor) {
    staffOnly(actor);
    return this.reports.accounts();
  }

  @RequirePermissions("finance:manage")
  @Post("ledger/accounts")
  @ApiZodBody(createAccountSchema)
  createAccount(@CurrentUser() actor: UserActor, @ZBody(createAccountSchema) body: z.infer<typeof createAccountSchema>, @ReqMeta() meta: RequestMeta) {
    return this.reports.createAccount(actor, body, meta);
  }

  /** ?period=2026-10 (movements in the month) or ?asOf=… (cumulative). Debits always equal credits. */
  @RequirePermissions("finance:read")
  @Get("ledger/trial-balance")
  @ApiZodQuery(trialBalanceQuerySchema)
  trialBalance(@CurrentActor() actor: Actor, @ZQuery(trialBalanceQuerySchema) query: z.infer<typeof trialBalanceQuerySchema>) {
    staffOnly(actor);
    return this.reports.trialBalance(query);
  }

  /** Account statement with running balance (?account=2010&merchantId=…). */
  @RequirePermissions("finance:read")
  @Get("ledger/statement")
  @ApiZodQuery(statementQuerySchema)
  statement(@CurrentActor() actor: Actor, @ZQuery(statementQuerySchema) query: z.infer<typeof statementQuerySchema>) {
    staffOnly(actor);
    return this.reports.statement(query);
  }

  @RequirePermissions("finance:read")
  @Get("ledger/entries")
  @ApiZodQuery(listEntriesQuerySchema)
  entries(@CurrentActor() actor: Actor, @ZQuery(listEntriesQuerySchema) query: z.infer<typeof listEntriesQuerySchema>) {
    staffOnly(actor);
    return this.reports.entries(query);
  }

  /** Balanced correcting / opening entry (account codes, debit or credit per line). */
  @RequirePermissions("finance:manage")
  @Post("ledger/journal")
  @ApiZodBody(manualJournalSchema)
  journal(@CurrentUser() actor: UserActor, @ZBody(manualJournalSchema) body: z.infer<typeof manualJournalSchema>, @ReqMeta() meta: RequestMeta) {
    return this.reports.manualJournal(actor, body, meta);
  }

  /** Hub cash banked (bank / bKash). */
  @RequirePermissions("finance:manage")
  @Post("ledger/deposits")
  @ApiZodBody(depositSchema)
  deposit(@CurrentUser() actor: UserActor, @ZBody(depositSchema) body: z.infer<typeof depositSchema>, @ReqMeta() meta: RequestMeta) {
    return this.reports.deposit(actor, body, meta);
  }

  /** Cash the ledger says each hub and rider holds. */
  @RequirePermissions("finance:read")
  @Get("ledger/cash-positions")
  cash(@CurrentActor() actor: Actor) {
    staffOnly(actor);
    return this.reports.cashPositions();
  }

  @RequirePermissions("finance:read")
  @Get("ledger/periods")
  periods(@CurrentActor() actor: Actor) {
    staffOnly(actor);
    return this.reports.periods();
  }

  /** Closes a finished month (snapshot of its trial balance); later postings dated in it move to the next open month. */
  @RequirePermissions("finance:manage")
  @Post("ledger/periods/:period/close")
  @HttpCode(200)
  @ApiZodBody(closePeriodSchema)
  close(@CurrentUser() actor: UserActor, @Param("period") period: string, @ZBody(closePeriodSchema) body: z.infer<typeof closePeriodSchema>, @ReqMeta() meta: RequestMeta) {
    return this.reports.closePeriod(actor, periodSchema.parse(period), body, meta);
  }

  /** A merchant's statement (balance, carried-forward shortfalls, open adjustments). Merchant owners: their own. */
  @RequirePermissions("finance:read")
  @Get("merchants/:merchantId/statement")
  @ApiZodQuery(merchantStatementQuerySchema)
  merchantStatement(@CurrentActor() actor: Actor, @Param("merchantId", ParseUUIDPipe) merchantId: string, @ZQuery(merchantStatementQuerySchema) query: z.infer<typeof merchantStatementQuerySchema>) {
    const scope = financeMerchantScope(actor);
    if (scope && !scope.includes(merchantId)) throw notFound("Merchant");
    return this.reports.merchantStatement(merchantId, query);
  }

  // ───────────── settlement schedule ─────────────

  @RequirePermissions("finance:read")
  @Get("settlement-schedules")
  @ApiZodQuery(listSchedulesQuerySchema)
  listSchedules(@CurrentActor() actor: Actor, @ZQuery(listSchedulesQuerySchema) query: z.infer<typeof listSchedulesQuerySchema>) {
    staffOnly(actor);
    return this.schedules.list(query);
  }

  @RequirePermissions("finance:read")
  @Get("settlement-schedules/:merchantId")
  schedule(@CurrentActor() actor: Actor, @Param("merchantId", ParseUUIDPipe) merchantId: string) {
    return this.schedules.get(actor, merchantId);
  }

  /** cycle MANUAL | DAILY | WEEKLY | BIWEEKLY (weekday 0–6), minimumAmount. Drafts are created automatically; approval stays manual. */
  @RequirePermissions("finance:manage")
  @Put("settlement-schedules/:merchantId")
  @ApiZodBody(updateScheduleSchema)
  updateSchedule(
    @CurrentUser() actor: UserActor,
    @Param("merchantId", ParseUUIDPipe) merchantId: string,
    @ZBody(updateScheduleSchema) body: z.infer<typeof updateScheduleSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.schedules.update(actor, merchantId, body, meta);
  }

  /** Runs due schedules now (the hourly job does this automatically). */
  @RequirePermissions("finance:manage")
  @Post("settlement-schedules/run")
  @HttpCode(200)
  run(@Body() _body: unknown) {
    return this.schedules.runDue();
  }
}
