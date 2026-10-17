import { HttpStatus, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { AppError, conflict, notFound } from "../../common/errors";
import type { Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { invalidatePackageCache } from "./package-resolver";
import type { hubGroupSchema, updateHubGroupSchema } from "./packages.schemas";

const include = { hubs: { select: { id: true, code: true, name: true, active: true }, orderBy: { name: "asc" as const } } };

/** Hub groups: hubs that count as one city for pricing (same-city tier). */
@Injectable()
export class HubGroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list() {
    return this.prisma.hubGroup.findMany({ include, orderBy: { name: "asc" } });
  }

  private async assertCodeFree(code: string, exceptId?: string) {
    const clash = await this.prisma.hubGroup.findUnique({ where: { code } });
    if (clash && clash.id !== exceptId) throw conflict("HUB_GROUP_CODE_TAKEN", `Hub group code ${code} is already used by ${clash.name}`);
  }

  async create(actor: Actor, input: z.infer<typeof hubGroupSchema>, meta: RequestMeta) {
    await this.assertCodeFree(input.code);
    const group = await this.prisma.$transaction(async tx => {
      const created = await tx.hubGroup.create({ data: input, include });
      await this.audit.record(actor, { action: "hub_group.create", entityType: "hub_group", entityId: created.id, data: input }, meta, tx);
      return created;
    });
    invalidatePackageCache();
    return group;
  }

  async update(actor: Actor, id: string, input: z.infer<typeof updateHubGroupSchema>, meta: RequestMeta) {
    if (!(await this.prisma.hubGroup.findUnique({ where: { id } }))) throw notFound("Hub group");
    if (input.code) await this.assertCodeFree(input.code, id);
    const group = await this.prisma.$transaction(async tx => {
      const updated = await tx.hubGroup.update({ where: { id }, data: input, include });
      await this.audit.record(actor, { action: "hub_group.update", entityType: "hub_group", entityId: id, data: input }, meta, tx);
      return updated;
    });
    invalidatePackageCache();
    return group;
  }

  async remove(actor: Actor, id: string, meta: RequestMeta) {
    const group = await this.prisma.hubGroup.findUnique({ where: { id }, include: { _count: { select: { hubs: true } } } });
    if (!group) throw notFound("Hub group");
    if (group._count.hubs) throw new AppError("HUB_GROUP_IN_USE", `${group.name} still has ${group._count.hubs} hub(s): move them out first, or deactivate the group`, HttpStatus.CONFLICT, { hubs: group._count.hubs });
    await this.prisma.$transaction(async tx => {
      await tx.hubGroup.delete({ where: { id } });
      await this.audit.record(actor, { action: "hub_group.delete", entityType: "hub_group", entityId: id, data: { code: group.code, name: group.name } }, meta, tx);
    });
    invalidatePackageCache();
    return { deleted: true };
  }

  /** Replaces the group's hubs (a hub is in at most one group: it moves here). */
  async setHubs(actor: Actor, id: string, hubIds: string[], meta: RequestMeta) {
    const group = await this.prisma.hubGroup.findUnique({ where: { id } });
    if (!group) throw notFound("Hub group");
    const found = await this.prisma.hub.count({ where: { id: { in: hubIds } } });
    if (found !== new Set(hubIds).size) throw new AppError("UNKNOWN_HUB", "One of the hubs was not found", 422);
    const result = await this.prisma.$transaction(async tx => {
      await tx.hub.updateMany({ where: { hubGroupId: id, id: { notIn: hubIds } }, data: { hubGroupId: null } });
      await tx.hub.updateMany({ where: { id: { in: hubIds } }, data: { hubGroupId: id } });
      await this.audit.record(actor, { action: "hub_group.hubs", entityType: "hub_group", entityId: id, data: { hubIds } }, meta, tx);
      return tx.hubGroup.findUniqueOrThrow({ where: { id }, include });
    });
    invalidatePackageCache();
    return result;
  }

  async hubGroupOf(hubId: string) {
    const hub = await this.prisma.hub.findUnique({ where: { id: hubId }, select: { id: true, hubGroup: { select: { id: true, code: true, name: true, active: true } } } });
    if (!hub) throw notFound("Hub");
    return { hubId: hub.id, hubGroup: hub.hubGroup };
  }

  async setHubGroup(actor: Actor, hubId: string, hubGroupId: string | null, meta: RequestMeta) {
    const hub = await this.prisma.hub.findUnique({ where: { id: hubId }, select: { id: true, hubGroupId: true } });
    if (!hub) throw notFound("Hub");
    if (hubGroupId && !(await this.prisma.hubGroup.findUnique({ where: { id: hubGroupId } }))) throw notFound("Hub group");
    await this.prisma.$transaction(async tx => {
      await tx.hub.update({ where: { id: hubId }, data: { hubGroupId } });
      await this.audit.record(actor, { action: "hub.hub_group", entityType: "hub", entityId: hubId, data: { from: hub.hubGroupId, to: hubGroupId } }, meta, tx);
    });
    invalidatePackageCache();
    return this.hubGroupOf(hubId);
  }
}
