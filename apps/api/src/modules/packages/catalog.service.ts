import { HttpStatus, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { deliveryTypeCode, findDeliveryType, SEED_CATALOG, SEED_DELIVERY_TYPES, SEED_PRIORITIES, type DeliveryTypeDef, type PackageSegment } from "@delivery-fast/shared";
import { PrismaService, type Db } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { AppError, conflict, notFound } from "../../common/errors";
import type { Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import type { Segment } from "../../generated/prisma/client";
import type {
  catalogListQuerySchema,
  categorySchema,
  deliveryTypeSchema,
  prioritySchema,
  updateCategorySchema,
  updateDeliveryTypeSchema,
  updatePrioritySchema,
} from "./packages.schemas";

/** Customer & E-commerce share the ECOMMERCE lists (products, categories, priorities); Banking & Financial has its own. */
export const listOf = (segment: PackageSegment | Segment): "ECOMMERCE" | "BANKING_FINANCIAL" => (segment === "BANKING_FINANCIAL" ? "BANKING_FINANCIAL" : "ECOMMERCE");
const lower = (s: string) => s.trim().toLowerCase();
/** Message channels a category allows (stored on its parcels at booking). */
export const channelsOf = (c: { notifySms: boolean; notifyEmail: boolean; notifyPush: boolean } | null | undefined): string[] =>
  !c ? ["sms", "email", "push"] : [...(c.notifySms ? ["sms"] : []), ...(c.notifyEmail ? ["email"] : []), ...(c.notifyPush ? ["push"] : [])];

let typesCache: { at: number; value: Promise<DeliveryTypeDef[]> } | null = null;
/** Delivery types change rarely: a minute's cache (cleared on every change in this process). */
const TYPES_TTL_MS = 60_000;

/**
 * The booking catalog managed by the super admin (Operational settings): product categories (with their message
 * channels), priorities (tags) and delivery types (each with a + charge per package version). Booking, imports and
 * Scan with phone resolve against it.
 */
@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ───────────── delivery types ─────────────

  /** Every delivery type (active and not), in order: the pricing / selection engine filters by category and active. */
  deliveryTypes(): Promise<DeliveryTypeDef[]> {
    if (typesCache && Date.now() - typesCache.at < TYPES_TTL_MS) return typesCache.value;
    const load = () => this.prisma.deliveryType.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
    const value = load()
      // A fresh database (the migration seeds existing ones): the seeded types.
      .then(async rows => (rows.length ? rows : (await this.seedDeliveryTypes(), await load())))
      .then(rows => rows.map(r => ({ code: r.code, name: r.name, segments: r.segments as PackageSegment[], slaLevel: r.slaLevel, active: r.active })));
    typesCache = { at: Date.now(), value };
    value.catch(() => (typesCache = null));
    return value;
  }

  /** The type's name for a stored code (a removed type: its code). */
  async deliveryTypeName(code: string | null | undefined) {
    if (!code) return null;
    return (await this.deliveryTypes()).find(t => t.code === code)?.name ?? code;
  }

  async listDeliveryTypes(query: z.infer<typeof catalogListQuerySchema>) {
    const rows = await this.prisma.deliveryType.findMany({
      where: { ...(query.includeInactive ? {} : { active: true }), ...(query.segment ? { segments: { has: query.segment } } : {}) },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
    const used = await this.prisma.parcel.groupBy({ by: ["speedOption"], where: { speedOption: { in: rows.map(r => r.code) } }, _count: { _all: true } });
    const count = new Map(used.map(u => [u.speedOption, u._count._all]));
    return rows.map(r => ({ ...r, parcels: count.get(r.code) ?? 0 }));
  }

  async createDeliveryType(actor: Actor, input: z.infer<typeof deliveryTypeSchema>, meta: RequestMeta) {
    const code = input.code ?? deliveryTypeCode(input.name);
    if (!/^[A-Z][A-Z0-9_]{1,39}$/.test(code)) throw new AppError("VALIDATION_FAILED", "Give the delivery type a name that starts with a letter", HttpStatus.UNPROCESSABLE_ENTITY);
    const all = await this.prisma.deliveryType.findMany();
    if (all.some(t => t.code === code)) throw conflict("DELIVERY_TYPE_TAKEN", `There is already a delivery type with the code ${code}`);
    if (findDeliveryType(input.name, all.map(t => ({ ...t, segments: t.segments as PackageSegment[] })))) throw conflict("DELIVERY_TYPE_TAKEN", `There is already a delivery type called ${input.name}`);
    const sortOrder = input.sortOrder ?? Math.max(-1, ...all.map(t => t.sortOrder)) + 1;
    const row = await this.prisma.$transaction(async tx => {
      const created = await tx.deliveryType.create({ data: { code, name: input.name, segments: input.segments, slaLevel: input.slaLevel, active: input.active, sortOrder } });
      await this.audit.record(actor, { action: "delivery_type.create", entityType: "delivery_type", entityId: created.id, data: { code, ...input } }, meta, tx);
      return created;
    });
    typesCache = null;
    return row;
  }

  async updateDeliveryType(actor: Actor, id: string, input: z.infer<typeof updateDeliveryTypeSchema>, meta: RequestMeta) {
    const type = await this.prisma.deliveryType.findUnique({ where: { id } });
    if (!type) throw notFound("Delivery type");
    if (input.name && lower(input.name) !== lower(type.name)) {
      const clash = await this.prisma.deliveryType.findFirst({ where: { id: { not: id }, name: { equals: input.name, mode: "insensitive" } } });
      if (clash) throw conflict("DELIVERY_TYPE_TAKEN", `There is already a delivery type called ${clash.name}`);
    }
    if (input.active === false) await this.keepOneActive(id, type.segments as PackageSegment[]);
    const row = await this.prisma.$transaction(async tx => {
      const updated = await tx.deliveryType.update({ where: { id }, data: input });
      await this.audit.record(actor, { action: "delivery_type.update", entityType: "delivery_type", entityId: id, data: { code: type.code, ...input } }, meta, tx);
      return updated;
    });
    typesCache = null;
    return row;
  }

  /** Every category keeps at least one active delivery type (else no booking could choose one). */
  private async keepOneActive(id: string, segments: readonly PackageSegment[]) {
    const others = await this.prisma.deliveryType.findMany({ where: { id: { not: id }, active: true } });
    const left = segments.filter(s => !others.some(o => (o.segments as string[]).includes(s)));
    if (left.length) throw new AppError("LAST_DELIVERY_TYPE", `It's the last active delivery type for ${left.join(", ")}: add or activate another first`, HttpStatus.CONFLICT);
  }

  /** Only a type no parcel used (else deactivate it). */
  async removeDeliveryType(actor: Actor, id: string, meta: RequestMeta) {
    const type = await this.prisma.deliveryType.findUnique({ where: { id } });
    if (!type) throw notFound("Delivery type");
    const parcels = await this.prisma.parcel.count({ where: { speedOption: type.code } });
    if (parcels) throw new AppError("DELIVERY_TYPE_IN_USE", `${type.name} is on ${parcels} parcel(s): deactivate it instead`, HttpStatus.CONFLICT, { parcels });
    if (type.active) await this.keepOneActive(id, type.segments as PackageSegment[]);
    await this.prisma.$transaction(async tx => {
      await tx.deliveryType.delete({ where: { id } });
      await this.audit.record(actor, { action: "delivery_type.delete", entityType: "delivery_type", entityId: id, data: { code: type.code, name: type.name } }, meta, tx);
    });
    typesCache = null;
    return { deleted: true };
  }

  // ───────────── product categories ─────────────

  async listCategories(query: z.infer<typeof catalogListQuerySchema>) {
    const rows = await this.prisma.productCategory.findMany({
      where: { ...(query.segment ? { segment: listOf(query.segment) } : {}), ...(query.includeInactive ? {} : { active: true }) },
      include: { _count: { select: { products: true, parcels: true } } },
      orderBy: [{ segment: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
    });
    return rows.map(({ _count, ...c }) => ({ ...c, products: _count.products, parcels: _count.parcels }));
  }

  private async categoryNameFree(segment: Segment, name: string, exceptId?: string) {
    const clash = await this.prisma.productCategory.findFirst({ where: { segment, name: { equals: name, mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) } });
    if (clash) throw conflict("CATEGORY_NAME_TAKEN", `There is already a category called ${clash.name}`);
  }

  async createCategory(actor: Actor, input: z.infer<typeof categorySchema>, meta: RequestMeta) {
    await this.categoryNameFree(input.segment, input.name);
    const last = await this.prisma.productCategory.aggregate({ where: { segment: input.segment }, _max: { sortOrder: true } });
    return this.prisma.$transaction(async tx => {
      const row = await tx.productCategory.create({ data: { ...input, sortOrder: input.sortOrder ?? (last._max.sortOrder ?? -1) + 1 } });
      await this.audit.record(actor, { action: "product_category.create", entityType: "product_category", entityId: row.id, data: input }, meta, tx);
      return row;
    });
  }

  async updateCategory(actor: Actor, id: string, input: z.infer<typeof updateCategorySchema>, meta: RequestMeta) {
    const row = await this.prisma.productCategory.findUnique({ where: { id } });
    if (!row) throw notFound("Category");
    if (input.name) await this.categoryNameFree(row.segment, input.name, id);
    return this.prisma.$transaction(async tx => {
      const updated = await tx.productCategory.update({ where: { id }, data: input });
      await this.audit.record(actor, { action: "product_category.update", entityType: "product_category", entityId: id, data: input }, meta, tx);
      return updated;
    });
  }

  /** Only an empty category no parcel used (else move its products / deactivate it). */
  async removeCategory(actor: Actor, id: string, meta: RequestMeta) {
    const row = await this.prisma.productCategory.findUnique({ where: { id }, include: { _count: { select: { products: true, parcels: true } } } });
    if (!row) throw notFound("Category");
    if (row._count.products) throw new AppError("CATEGORY_NOT_EMPTY", `${row.name} has ${row._count.products} product(s): move or delete them first`, HttpStatus.CONFLICT, { products: row._count.products });
    if (row._count.parcels) throw new AppError("CATEGORY_IN_USE", `${row.name} is on ${row._count.parcels} parcel(s): deactivate it instead`, HttpStatus.CONFLICT, { parcels: row._count.parcels });
    await this.prisma.$transaction(async tx => {
      await tx.productCategory.delete({ where: { id } });
      await this.audit.record(actor, { action: "product_category.delete", entityType: "product_category", entityId: id, data: { name: row.name, segment: row.segment } }, meta, tx);
    });
    return { deleted: true };
  }

  /** The active category named in a cell or a request (its id, or its name in any case). */
  async findCategory(segment: PackageSegment, raw: string | null | undefined, db: Db = this.prisma) {
    const v = lower(raw ?? "");
    if (!v) return null;
    const rows = await db.productCategory.findMany({ where: { segment: listOf(segment), active: true } });
    return rows.find(c => c.id === raw || lower(c.name) === v) ?? null;
  }

  // ───────────── priorities ─────────────

  async listPriorities(query: z.infer<typeof catalogListQuerySchema>) {
    const rows = await this.prisma.parcelPriority.findMany({
      where: { ...(query.segment ? { segment: listOf(query.segment) } : {}), ...(query.includeInactive ? {} : { active: true }) },
      include: { _count: { select: { parcels: true } } },
      orderBy: [{ segment: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
    });
    return rows.map(({ _count, ...p }) => ({ ...p, parcels: _count.parcels }));
  }

  private async priorityNameFree(segment: Segment, name: string, exceptId?: string) {
    const clash = await this.prisma.parcelPriority.findFirst({ where: { segment, name: { equals: name, mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) } });
    if (clash) throw conflict("PRIORITY_NAME_TAKEN", `There is already a priority called ${clash.name}`);
  }

  async createPriority(actor: Actor, input: z.infer<typeof prioritySchema>, meta: RequestMeta) {
    await this.priorityNameFree(input.segment, input.name);
    const last = await this.prisma.parcelPriority.aggregate({ where: { segment: input.segment }, _max: { sortOrder: true } });
    return this.prisma.$transaction(async tx => {
      if (input.isDefault) await tx.parcelPriority.updateMany({ where: { segment: input.segment }, data: { isDefault: false } });
      const row = await tx.parcelPriority.create({ data: { ...input, active: input.isDefault ? true : input.active, sortOrder: input.sortOrder ?? (last._max.sortOrder ?? -1) + 1 } });
      await this.audit.record(actor, { action: "parcel_priority.create", entityType: "parcel_priority", entityId: row.id, data: input }, meta, tx);
      return row;
    });
  }

  async updatePriority(actor: Actor, id: string, input: z.infer<typeof updatePrioritySchema>, meta: RequestMeta) {
    const row = await this.prisma.parcelPriority.findUnique({ where: { id } });
    if (!row) throw notFound("Priority");
    if (input.name) await this.priorityNameFree(row.segment, input.name, id);
    if (row.isDefault && (input.active === false || input.isDefault === false)) throw new AppError("DEFAULT_PRIORITY", "Make another priority the default first", HttpStatus.CONFLICT);
    return this.prisma.$transaction(async tx => {
      if (input.isDefault) await tx.parcelPriority.updateMany({ where: { segment: row.segment, id: { not: id } }, data: { isDefault: false } });
      const updated = await tx.parcelPriority.update({ where: { id }, data: { ...input, ...(input.isDefault ? { active: true } : {}) } });
      await this.audit.record(actor, { action: "parcel_priority.update", entityType: "parcel_priority", entityId: id, data: input }, meta, tx);
      return updated;
    });
  }

  /** Only a priority no parcel used and not the default (else deactivate it). */
  async removePriority(actor: Actor, id: string, meta: RequestMeta) {
    const row = await this.prisma.parcelPriority.findUnique({ where: { id }, include: { _count: { select: { parcels: true } } } });
    if (!row) throw notFound("Priority");
    if (row.isDefault) throw new AppError("DEFAULT_PRIORITY", "Make another priority the default first", HttpStatus.CONFLICT);
    if (row._count.parcels) throw new AppError("PRIORITY_IN_USE", `${row.name} is on ${row._count.parcels} parcel(s): deactivate it instead`, HttpStatus.CONFLICT, { parcels: row._count.parcels });
    await this.prisma.$transaction(async tx => {
      await tx.parcelPriority.delete({ where: { id } });
      await this.audit.record(actor, { action: "parcel_priority.delete", entityType: "parcel_priority", entityId: id, data: { name: row.name, segment: row.segment } }, meta, tx);
    });
    return { deleted: true };
  }

  /** The priority of a booking: the one named (active, any case), else the list's default. */
  async priorityFor(segment: PackageSegment, raw: string | null | undefined, db: Db = this.prisma) {
    const rows = await db.parcelPriority.findMany({ where: { segment: listOf(segment), active: true }, orderBy: { sortOrder: "asc" } });
    const v = lower(raw ?? "");
    if (v) return { priority: rows.find(p => lower(p.name) === v || p.id === raw) ?? null, named: true, options: rows };
    return { priority: rows.find(p => p.isDefault) ?? rows[0] ?? null, named: false, options: rows };
  }

  // ───────────── seed (fresh databases; the migration seeds existing ones) ─────────────

  /** The seeded delivery types, where missing (by code); clears the cache. */
  async seedDeliveryTypes() {
    typesCache = null;
    for (const [i, t] of SEED_DELIVERY_TYPES.entries())
      await this.prisma.deliveryType.upsert({ where: { code: t.code }, update: {}, create: { code: t.code, name: t.name, segments: [...t.segments], slaLevel: t.slaLevel, sortOrder: i } });
  }

  /** The seeded priorities of a list that has none (the first is the default). */
  async seedPriorities(db: Db = this.prisma) {
    for (const [segment, names] of Object.entries(SEED_PRIORITIES) as ["ECOMMERCE" | "BANKING_FINANCIAL", readonly string[]][]) {
      if (await db.parcelPriority.count({ where: { segment } })) continue;
      for (const [i, name] of names.entries()) await db.parcelPriority.create({ data: { segment, name, isDefault: i === 0, sortOrder: i } });
    }
  }

  /** The owner's catalog: categories and their products, created where missing; idempotent. Returns products created. */
  async seedCatalog(db: Db) {
    await this.seedPriorities(db);
    let created = 0;
    for (const [segment, categories] of Object.entries(SEED_CATALOG) as ["ECOMMERCE" | "BANKING_FINANCIAL", (typeof SEED_CATALOG)["ECOMMERCE"]][]) {
      for (const [ci, c] of categories.entries()) {
        const category =
          (await db.productCategory.findFirst({ where: { segment, name: { equals: c.name, mode: "insensitive" } } })) ??
          (await db.productCategory.create({ data: { segment, name: c.name, sortOrder: ci, notifySms: c.sms, notifyEmail: c.email, notifyPush: c.push } }));
        for (const [pi, [name, type]] of c.products.entries()) {
          const existing = await db.parcelProduct.findFirst({ where: { segment, name: { equals: name, mode: "insensitive" } } });
          if (existing) {
            if (!existing.categoryId || !existing.active) await db.parcelProduct.update({ where: { id: existing.id }, data: { active: true, categoryId: existing.categoryId ?? category.id } });
          } else {
            await db.parcelProduct.create({ data: { segment, name, type, categoryId: category.id, sortOrder: pi } });
            created++;
          }
        }
      }
    }
    return created;
  }
}
