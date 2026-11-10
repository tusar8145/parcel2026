import { HttpStatus, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { AppError, conflict, notFound } from "../../common/errors";
import type { Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import type { Segment } from "../../generated/prisma/client";
import { STYLE, writeXlsx, type Cell } from "../imports/xlsx/xlsx-writer";
import type { exportProductsQuerySchema, listProductsQuerySchema, productSchema, updateProductSchema } from "./packages.schemas";

/** Products (super admin): the Customer + E-commerce list and the Banking & Financial list, each under a category and of a fixed pricing type. */
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
      include: { _count: { select: { parcels: true } }, category: { select: { id: true, name: true, sortOrder: true } } },
      orderBy: [{ segment: "asc" }, { category: { sortOrder: "asc" } }, { sortOrder: "asc" }, { name: "asc" }],
    });
    return rows.map(({ _count, category, ...p }) => ({ ...p, categoryName: category?.name ?? null, parcels: _count.parcels }));
  }

  private async assertNameFree(segment: Segment, name: string, exceptId?: string) {
    const clash = await this.prisma.parcelProduct.findFirst({ where: { segment, name: { equals: name, mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) } });
    if (clash) throw conflict("PRODUCT_NAME_TAKEN", `There is already a product called ${clash.name}`);
  }

  /** The category must be one of the product's list. */
  private async assertCategory(segment: Segment, categoryId: string) {
    const category = await this.prisma.productCategory.findUnique({ where: { id: categoryId }, select: { segment: true } });
    if (!category || category.segment !== segment)
      throw new AppError("UNKNOWN_CATEGORY", "Choose a category of this list", HttpStatus.UNPROCESSABLE_ENTITY, [{ path: "categoryId", code: "UNKNOWN_CATEGORY", message: "Choose a category of this list" }]);
  }

  async create(actor: Actor, input: z.infer<typeof productSchema>, meta: RequestMeta) {
    await this.assertNameFree(input.segment, input.name);
    await this.assertCategory(input.segment, input.categoryId);
    return this.prisma.$transaction(async tx => {
      const product = await tx.parcelProduct.create({ data: input });
      await this.audit.record(actor, { action: "parcel_product.create", entityType: "parcel_product", entityId: product.id, data: input }, meta, tx);
      return product;
    });
  }

  /** The list as Excel, with the page's search and status. */
  async exportFile(query: z.infer<typeof exportProductsQuerySchema>) {
    const q = query.q?.toLowerCase();
    const rows = (await this.list({ segment: query.segment, includeInactive: true })).filter(
      p => (!q || p.name.toLowerCase().includes(q)) && (!query.status || p.active === (query.status === "active")),
    );
    if (query.sort) rows.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base", numeric: true }) * (query.sort === "asc" ? 1 : -1));
    const TYPE: Record<string, string> = { REGULAR: "Regular", DOCUMENT: "Document", BOOKS: "Books" };
    const header = ["Category", "Product", "Type", "Status", "Parcels"];
    const cells: Cell[][] = [header.map(value => ({ value, style: STYLE.headerOptional })), ...rows.map(p => [p.categoryName ?? "", p.name, TYPE[p.type] ?? p.type, p.active ? "Active" : "Inactive", p.parcels])];
    const buffer = writeXlsx({ title: "Products", sheets: [{ name: "Products", rows: cells, widths: [30, 36, 14, 12, 10], freezeHeader: true, autoFilter: true }] });
    return { buffer, fileName: `products-${query.segment === "BANKING_FINANCIAL" ? "banking-financial" : "customer-ecommerce"}.xlsx` };
  }

  async update(actor: Actor, id: string, input: z.infer<typeof updateProductSchema>, meta: RequestMeta) {
    const product = await this.prisma.parcelProduct.findUnique({ where: { id } });
    if (!product) throw notFound("Product");
    if (input.name) await this.assertNameFree(product.segment, input.name, id);
    if (input.categoryId) await this.assertCategory(product.segment, input.categoryId);
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
