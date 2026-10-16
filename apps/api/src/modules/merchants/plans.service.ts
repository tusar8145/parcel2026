import { HttpStatus, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { AppError, conflict, notFound } from "../../common/errors";
import type { Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import type { Segment } from "../../generated/prisma/client";
import { planView } from "./merchant.views";
import type { listPlansQuerySchema, planSchema, updatePlanSchema } from "./merchants.schemas";

@Injectable()
export class PlansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: z.infer<typeof listPlansQuerySchema>) {
    const plans = await this.prisma.servicePlan.findMany({
      where: { segment: query.segment, ...(query.includeInactive ? {} : { active: true }) },
      orderBy: [{ segment: "asc" }, { monthlyFee: "asc" }, { name: "asc" }],
    });
    return plans.map(planView);
  }

  private async assertNameFree(segment: Segment, name: string, exceptId?: string) {
    const clash = await this.prisma.servicePlan.findFirst({ where: { segment, name: { equals: name, mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) } });
    if (clash) throw conflict("PLAN_NAME_TAKEN", `There is already a ${segment} plan called ${clash.name}`);
  }

  async create(actor: Actor, input: z.infer<typeof planSchema>, meta: RequestMeta) {
    await this.assertNameFree(input.segment, input.name);
    const plan = await this.prisma.$transaction(async tx => {
      const created = await tx.servicePlan.create({ data: input });
      await this.audit.record(actor, { action: "plan.create", entityType: "service_plan", entityId: created.id, data: input }, meta, tx);
      return created;
    });
    return planView(plan);
  }

  async update(actor: Actor, id: string, input: z.infer<typeof updatePlanSchema>, meta: RequestMeta) {
    const current = await this.prisma.servicePlan.findUnique({ where: { id }, include: { _count: { select: { merchants: true } } } });
    if (!current) throw notFound("Service plan");
    if (input.segment && input.segment !== current.segment && current._count.merchants > 0)
      throw new AppError("PLAN_IN_USE", `${current._count.merchants} merchant(s) are on this plan, so its segment can't change`, HttpStatus.UNPROCESSABLE_ENTITY);
    if (input.name || input.segment) await this.assertNameFree(input.segment ?? current.segment, input.name ?? current.name, id);
    const plan = await this.prisma.$transaction(async tx => {
      const updated = await tx.servicePlan.update({ where: { id }, data: input });
      await this.audit.record(actor, { action: "plan.update", entityType: "service_plan", entityId: id, data: input }, meta, tx);
      return updated;
    });
    return planView(plan);
  }
}
