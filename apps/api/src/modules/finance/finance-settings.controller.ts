import type { z } from "zod";
import { Controller, Get, Put } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CurrentActor, CurrentUser, ReqMeta, RequirePermissions, type RequestMeta } from "../../common/auth/decorators";
import type { Actor, UserActor } from "../../common/auth/actor";
import { ApiZodBody, ZBody } from "../../common/zod";
import { forbidden } from "../../common/errors";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import type { Prisma } from "../../generated/prisma/client";
import { canChangeFinanceSettings, isFinanceStaff } from "./finance.scope";
import { FINANCE_CONFIG_KEY, financeConfigSchema, readStoredFinanceConfig, updateFinanceConfigSchema } from "./finance-config";

/** Invoice settings (Super admin › Invoice settings): VAT on / off and rate, the company printed on bills, payment term, delivery charge on invoices. */
@ApiTags("finance")
@Controller("finance")
export class FinanceSettingsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @RequirePermissions("finance:read")
  @Get("config")
  config(@CurrentActor() actor: Actor) {
    if (!isFinanceStaff(actor)) throw forbidden("Only finance staff can see the finance settings");
    return readStoredFinanceConfig(this.prisma);
  }

  @RequirePermissions("finance:manage")
  @Put("config")
  @ApiZodBody(updateFinanceConfigSchema)
  async updateConfig(@CurrentUser() actor: UserActor, @ZBody(updateFinanceConfigSchema) body: z.infer<typeof updateFinanceConfigSchema>, @ReqMeta() meta: RequestMeta) {
    if (!canChangeFinanceSettings(actor)) throw forbidden("Only super admins can change the invoice settings");
    const current = await readStoredFinanceConfig(this.prisma);
    const next = financeConfigSchema.parse({ ...current, ...body, seller: { ...current.seller, ...(body.seller ?? {}) } });
    await this.prisma.$transaction(async tx => {
      await tx.setting.upsert({ where: { key: FINANCE_CONFIG_KEY }, create: { key: FINANCE_CONFIG_KEY, value: next }, update: { value: next } });
      await this.audit.record(actor, { action: "finance.config.update", entityType: "setting", entityId: FINANCE_CONFIG_KEY, data: { from: current, to: next } as unknown as Prisma.InputJsonObject }, meta, tx);
    });
    return next;
  }
}
