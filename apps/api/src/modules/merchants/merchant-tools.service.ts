import { HttpStatus, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { PARCEL_STATUS_LABEL, type ParcelStatus } from "@delivery-fast/shared";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { AppError, conflict, notFound } from "../../common/errors";
import { pageArgs, toPage } from "../../common/pagination";
import type { Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { Prisma, type Product } from "../../generated/prisma/client";
import { dhakaDay, toCsv } from "../ops/ops-common";
import { MerchantsService } from "./merchants.service";
import type { listProductsQuerySchema, productSchema, ReportKind, reportQuerySchema, updateProductSchema } from "./merchants.schemas";

export const MAX_PRODUCTS = 5000;
const REPORT_MAX_DAYS = 366;
const REPORT_MAX_ROWS = 20_000;

const productView = (p: Product) => ({
  id: p.id,
  sku: p.sku,
  name: p.name,
  category: p.category,
  weightKg: p.weightKg == null ? null : Number(p.weightKg),
  packaging: p.packaging,
  price: Number(p.price),
  active: p.active,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

const num = (d: Prisma.Decimal | null | undefined) => (d == null ? null : Number(d));
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const label = (s: string) => PARCEL_STATUS_LABEL[s as ParcelStatus] ?? s;

export const REPORT_TITLE: Record<ReportKind, string> = {
  orders: "Orders",
  "delivery-performance": "Delivery performance by district",
  "cod-reconciliation": "COD reconciliation",
  returns: "Returns (RTO)",
  invoices: "Invoices",
};

type Cell = string | number | null;
export interface Report {
  kind: ReportKind;
  title: string;
  from: string;
  to: string;
  columns: string[];
  rows: Cell[][];
  summary: Record<string, number>;
}

/** Merchant product catalogue (prefills bookings) and the Reports page exports. */
@Injectable()
export class MerchantToolsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly merchants: MerchantsService,
  ) {}

  // ───────────── products ─────────────

  async listProducts(actor: Actor, query: z.infer<typeof listProductsQuerySchema>) {
    const m = await this.merchants.resolveOwn(actor, query.merchantId);
    const q = query.q;
    const rows = await this.prisma.product.findMany({
      where: {
        merchantId: m.id,
        active: query.active,
        ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { sku: { contains: q, mode: "insensitive" } }, { category: { contains: q, mode: "insensitive" } }] } : {}),
      },
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { items: page.items.map(productView), nextCursor: page.nextCursor };
  }

  async createProduct(actor: Actor, merchantId: string | undefined, input: z.infer<typeof productSchema>, meta: RequestMeta) {
    const m = await this.merchants.resolveOwn(actor, merchantId);
    const product = await this.prisma.$transaction(async tx => {
      if ((await tx.product.count({ where: { merchantId: m.id } })) >= MAX_PRODUCTS)
        throw new AppError("PRODUCT_LIMIT", `The catalogue holds at most ${MAX_PRODUCTS} products. Remove ones you no longer sell.`, HttpStatus.UNPROCESSABLE_ENTITY);
      const created = await tx.product.create({ data: { ...input, merchantId: m.id } }).catch(error => {
        throw this.duplicateSku(error, input.sku);
      });
      await this.audit.record(actor, { action: "product.create", entityType: "product", entityId: created.id, data: { merchantId: m.id, sku: created.sku } }, meta, tx);
      return created;
    });
    return productView(product);
  }

  async updateProduct(actor: Actor, merchantId: string | undefined, id: string, input: z.infer<typeof updateProductSchema>, meta: RequestMeta) {
    const m = await this.merchants.resolveOwn(actor, merchantId);
    const product = await this.prisma.$transaction(async tx => {
      const current = await tx.product.findFirst({ where: { id, merchantId: m.id } });
      if (!current) throw notFound("Product");
      const updated = await tx.product.update({ where: { id }, data: input }).catch(error => {
        throw this.duplicateSku(error, input.sku ?? current.sku);
      });
      await this.audit.record(actor, { action: "product.update", entityType: "product", entityId: id, data: { merchantId: m.id, changes: input } }, meta, tx);
      return updated;
    });
    return productView(product);
  }

  async deleteProduct(actor: Actor, merchantId: string | undefined, id: string, meta: RequestMeta) {
    const m = await this.merchants.resolveOwn(actor, merchantId);
    await this.prisma.$transaction(async tx => {
      const current = await tx.product.findFirst({ where: { id, merchantId: m.id } });
      if (!current) throw notFound("Product");
      await tx.product.delete({ where: { id } });
      await this.audit.record(actor, { action: "product.delete", entityType: "product", entityId: id, data: { merchantId: m.id, sku: current.sku } }, meta, tx);
    });
  }

  private duplicateSku(error: unknown, sku: string) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return conflict("DUPLICATE_SKU", `A product with SKU ${sku} already exists`);
    return error;
  }

  // ───────────── reports ─────────────

  async report(actor: Actor, kind: ReportKind, query: z.infer<typeof reportQuerySchema>): Promise<Report> {
    const m = await this.merchants.resolveOwn(actor, query.merchantId);
    const to = query.to ?? new Date();
    const from = query.from ?? new Date(to.getTime() - 30 * 86_400_000);
    if (from > to) throw new AppError("INVALID_RANGE", "The start date must be before the end date", HttpStatus.UNPROCESSABLE_ENTITY);
    if (to.getTime() - from.getTime() > REPORT_MAX_DAYS * 86_400_000) throw new AppError("RANGE_TOO_LONG", `Reports cover at most ${REPORT_MAX_DAYS} days`, HttpStatus.UNPROCESSABLE_ENTITY);
    // Money columns are for owners (staff see operational reports).
    const owner = actor.kind === "api_key" || actor.roles.some(r => r.merchantId === m.id && r.role === "MERCHANT_OWNER");
    if (!owner && (kind === "cod-reconciliation" || kind === "invoices")) throw new AppError("FORBIDDEN", "Only merchant owners can export financial reports", HttpStatus.FORBIDDEN);
    const range = { gte: from, lte: to };
    const base = { kind, title: REPORT_TITLE[kind], from: from.toISOString(), to: to.toISOString() };

    if (kind === "orders") {
      const parcels = await this.prisma.parcel.findMany({ where: { merchantId: m.id, createdAt: range }, orderBy: { createdAt: "asc" }, take: REPORT_MAX_ROWS });
      return {
        ...base,
        columns: ["Booked", "Tracking ID", "Order ref", "Recipient", "Phone", "District", "Zone", "Service", "Weight (kg)", "COD (BDT)", "Charge (BDT)", "Status", "Delivered"],
        rows: parcels.map(p => [
          iso(p.createdAt),
          p.trackingId,
          p.merchantOrderRef,
          p.recipientName,
          p.recipientPhone,
          p.deliveryDistrict,
          p.deliveryZone,
          p.serviceLevel,
          num(p.weightKg),
          num(p.codAmount),
          num(p.totalCharge),
          label(p.status),
          iso(p.deliveredAt),
        ]),
        summary: { orders: parcels.length, cod: sum(parcels.map(p => p.codAmount)), charges: sum(parcels.map(p => p.totalCharge)) },
      };
    }

    if (kind === "delivery-performance") {
      const parcels = await this.prisma.parcel.findMany({
        where: { merchantId: m.id, createdAt: range },
        select: { deliveryDistrict: true, status: true, createdAt: true, deliveredAt: true, pickedUpAt: true, attemptCount: true },
        take: REPORT_MAX_ROWS * 5,
      });
      const groups = new Map<string, { total: number; delivered: number; returned: number; cancelled: number; open: number; hours: number[]; attempts: number }>();
      for (const p of parcels) {
        const g = groups.get(p.deliveryDistrict ?? "Not set yet") ?? { total: 0, delivered: 0, returned: 0, cancelled: 0, open: 0, hours: [], attempts: 0 };
        g.total++;
        g.attempts += p.attemptCount;
        if (p.status === "DELIVERED") {
          g.delivered++;
          if (p.deliveredAt) g.hours.push((p.deliveredAt.getTime() - (p.pickedUpAt ?? p.createdAt).getTime()) / 3600_000);
        } else if (p.status === "RETURNED" || p.status === "RETURN_SCHEDULED") g.returned++;
        else if (p.status === "PICKUP_CANCELLED") g.cancelled++;
        else g.open++;
        groups.set(p.deliveryDistrict ?? "Not set yet", g);
      }
      const rows = [...groups.entries()]
        .sort((a, b) => b[1].total - a[1].total)
        .map(([district, g]): Cell[] => {
          const finished = g.delivered + g.returned;
          return [
            district,
            g.total,
            g.delivered,
            g.returned,
            g.cancelled,
            g.open,
            finished ? round((g.delivered / finished) * 100, 1) : null,
            g.hours.length ? round(g.hours.reduce((a, b) => a + b, 0) / g.hours.length, 1) : null,
            g.total ? round(g.attempts / g.total, 2) : null,
          ];
        });
      const delivered = parcels.filter(p => p.status === "DELIVERED").length;
      const returned = parcels.filter(p => p.status === "RETURNED" || p.status === "RETURN_SCHEDULED").length;
      return {
        ...base,
        columns: ["District", "Parcels", "Delivered", "Returned", "Cancelled", "In progress", "Success rate (%)", "Avg. delivery time (h)", "Avg. attempts"],
        rows,
        summary: { parcels: parcels.length, delivered, returned, successRate: delivered + returned ? round((delivered / (delivered + returned)) * 100, 1) : 0 },
      };
    }

    if (kind === "cod-reconciliation") {
      const parcels = await this.prisma.parcel.findMany({
        where: { merchantId: m.id, status: "DELIVERED", deliveredAt: range, codAmount: { gt: 0 } },
        include: { codCollection: { include: { settlement: { select: { number: true, status: true, paidAt: true } } } } },
        orderBy: { deliveredAt: "asc" },
        take: REPORT_MAX_ROWS,
      });
      const rows = parcels.map((p): Cell[] => {
        const c = p.codCollection;
        return [
          iso(p.deliveredAt),
          p.trackingId,
          p.merchantOrderRef,
          num(p.codAmount),
          num(c?.amount),
          c ? c.state : "NOT_RECORDED",
          num(p.totalCharge),
          c?.settlement?.number ?? null,
          c?.settlement?.status ?? null,
          iso(c?.settlement?.paidAt),
        ];
      });
      const settled = parcels.filter(p => p.codCollection?.state === "SETTLED");
      return {
        ...base,
        columns: ["Delivered", "Tracking ID", "Order ref", "COD due (BDT)", "COD collected (BDT)", "Cash state", "Delivery charge (BDT)", "Settlement", "Settlement status", "Paid"],
        rows,
        summary: {
          parcels: parcels.length,
          codDue: sum(parcels.map(p => p.codAmount)),
          collected: sum(parcels.map(p => p.codCollection?.amount ?? 0)),
          settled: sum(settled.map(p => p.codCollection!.amount)),
          charges: sum(parcels.map(p => p.totalCharge)),
        },
      };
    }

    if (kind === "returns") {
      const parcels = await this.prisma.parcel.findMany({
        where: {
          merchantId: m.id,
          OR: [{ returnRequestedAt: range }, { status: { in: ["RETURN_SCHEDULED", "RETURNED"] }, updatedAt: range }],
        },
        include: { returnRun: { select: { number: true } } },
        orderBy: { updatedAt: "asc" },
        take: REPORT_MAX_ROWS,
      });
      return {
        ...base,
        columns: ["Tracking ID", "Order ref", "Recipient", "District", "Reason", "Requested", "Requested by", "Status", "Return run", "Return charge (BDT)", "Received by merchant"],
        rows: parcels.map(p => [
          p.trackingId,
          p.merchantOrderRef,
          p.recipientName,
          p.deliveryDistrict,
          p.returnReason,
          iso(p.returnRequestedAt),
          p.returnRequestedBy,
          label(p.status),
          p.returnRun?.number ?? null,
          num(p.returnCharge),
          iso(p.returnReceivedAt),
        ]),
        summary: { returns: parcels.length, returned: parcels.filter(p => p.status === "RETURNED").length, charges: sum(parcels.map(p => p.returnCharge ?? 0)) },
      };
    }

    const invoices = await this.prisma.invoice.findMany({ where: { merchantId: m.id, issuedAt: range }, orderBy: { issuedAt: "asc" }, take: REPORT_MAX_ROWS });
    return {
      ...base,
      columns: ["Invoice", "Period start", "Period end", "Issued", "Due", "Status", "Subtotal (BDT)", "VAT (BDT)", "Total (BDT)", "Paid"],
      rows: invoices.map(i => [i.number, dhakaDay(i.periodStart), dhakaDay(new Date(i.periodEnd.getTime() - 1)), iso(i.issuedAt), iso(i.dueAt), i.status, num(i.subtotal), num(i.vatAmount), num(i.total), iso(i.paidAt)]),
      summary: { invoices: invoices.length, total: sum(invoices.map(i => i.total)), unpaid: sum(invoices.filter(i => i.status === "ISSUED").map(i => i.total)) },
    };
  }

  reportCsv(report: Report) {
    return toCsv(report.columns, report.rows);
  }
}

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;
const sum = (values: (Prisma.Decimal | number | null | undefined)[]) => round(values.reduce<number>((a, v) => a + (v == null ? 0 : Number(v)), 0), 2);
