import { HttpStatus, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { AppError, conflict, notFound } from "../../common/errors";
import type { Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import type { Segment } from "../../generated/prisma/client";
import type { listProductsQuerySchema, productSchema, updateProductSchema } from "./packages.schemas";

/** Products (super admin): the Customer + E-commerce list and the Banking & Financial list, each product of a fixed type. */
@Injectable()
export class ParcelProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: z.infer<typeof listProductsQuerySchema>) {
    const segment: Segment | undefined = query.segment === "CUSTOMER" ? "ECOMMERCE" : query.segment;
    const rows = await this.prisma.parcelProduct.findMany({
      where: { segment, ...(query.includeInactive ? {} : { active: true }) },
      include: { _count: { select: { parcels: true } } },
      orderBy: [{ segment: "asc" }, { type: "asc" }, { name: "asc" }],
    });
    return rows.map(({ _count, ...p }) => ({ ...p, parcels: _count.parcels }));
  }

  private async assertNameFree(segment: Segment, name: string, exceptId?: string) {
    const clash = await this.prisma.parcelProduct.findFirst({ where: { segment, name: { equals: name, mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) } });
    if (clash) throw conflict("PRODUCT_NAME_TAKEN", `There is already a product called ${clash.name}`);
  }

  async create(actor: Actor, input: z.infer<typeof productSchema>, meta: RequestMeta) {
    await this.assertNameFree(input.segment, input.name);
    return this.prisma.$transaction(async tx => {
      const product = await tx.parcelProduct.create({ data: input });
      await this.audit.record(actor, { action: "parcel_product.create", entityType: "parcel_product", entityId: product.id, data: input }, meta, tx);
      return product;
    });
  }

  async update(actor: Actor, id: string, input: z.infer<typeof updateProductSchema>, meta: RequestMeta) {
    const product = await this.prisma.parcelProduct.findUnique({ where: { id } });
    if (!product) throw notFound("Product");
    if (input.name) await this.assertNameFree(product.segment, input.name, id);
    return this.prisma.$transaction(async tx => {
      const updated = await tx.parcelProduct.update({ where: { id }, data: input });
      await this.audit.record(actor, { action: "parcel_product.update", entityType: "parcel_product", entityId: id, data: input }, meta, tx);
      return updated;
    });
  }

  /** Only a product no parcel used (else deactivate it). */
  async remove(actor: Actor, id: string, meta: RequestMeta) {
    const product = await this.prisma.parcelProduct.findUnique({ where: { id }, include: { _count: { select: { parcels: true } } } });
    if (!product) throw notFound("Product");
    if (product._count.parcels)
      throw new AppError("PRODUCT_IN_USE", `${product.name} is on ${product._count.parcels} parcel(s): deactivate it instead`, HttpStatus.CONFLICT, { parcels: product._count.parcels });
    await this.prisma.$transaction(async tx => {
      await tx.parcelProduct.delete({ where: { id } });
      await this.audit.record(actor, { action: "parcel_product.delete", entityType: "parcel_product", entityId: id, data: { name: product.name, segment: product.segment } }, meta, tx);
    });
    return { deleted: true };
  }
}
