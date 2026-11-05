import { HttpStatus, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { PARCEL_STATUS_LABEL, SERVICE_LEVEL_LABEL, type ParcelStatus } from "@paira-express/shared";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { AppError, conflict, notFound } from "../../common/errors";
import { pageArgs, toPage } from "../../common/pagination";
import type { Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { Prisma, type Product } from "../../generated/prisma/client";
import { dhakaDay, toCsv } from "../ops/ops-common";
import { STYLE, writeXlsx, type Cell as XlsxCell } from "../imports/xlsx/xlsx-writer";
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
  "failed-deliveries": "Failed deliveries",
  returns: "Returns (RTO)",
  "cod-reconciliation": "COD reconciliation",
  payouts: "Payouts",
  invoices: "Bills",
  branches: "Branch summary",
};

interface ReportInfo {
  kind: ReportKind;
  group: "Orders & delivery" | "Money";
  description: string;
  /** Only for this merchant type (both when empty). */
  type?: "ECOMMERCE" | "BANKING_FINANCIAL";
  /** Money: merchant owners only. */
  owner?: boolean;
}
/** What the Reports page offers: each merchant type's useful reports, nothing that needs internal data. */
const REPORTS: ReportInfo[] = [
  { kind: "orders", group: "Orders & delivery", description: "Every booking in the period with its recipient, status and delivery date." },
  { kind: "delivery-performance", group: "Orders & delivery", description: "Delivered, returned and in-progress parcels per district, with success rate and delivery time." },
  { kind: "failed-deliveries", group: "Orders & delivery", description: "Failed delivery attempts with the reason, to follow up with your recipients." },
  { kind: "returns", group: "Orders & delivery", description: "Parcels coming back to you, with the reason and whether you confirmed them." },
  { kind: "branches", group: "Orders & delivery", type: "BANKING_FINANCIAL", description: "Documents sent, delivered and returned per origin branch." },
  { kind: "cod-reconciliation", group: "Money", type: "ECOMMERCE", owner: true, description: "COD due and collected per delivered order, and the payout that paid it." },
  { kind: "payouts", group: "Money", type: "ECOMMERCE", owner: true, description: "Payouts with COD, charges deducted, the net amount and when it was paid." },
  { kind: "invoices", group: "Money", type: "BANKING_FINANCIAL", owner: true, description: "Your bills with the amounts paid and still due." },
];
const OWNER_REPORTS = new Set(REPORTS.filter(r => r.owner).map(r => r.kind));
const COD_STATE: Record<string, string> = { WITH_RIDER: "With rider", AT_HUB: "At hub", IN_TRANSIT: "On the way to settlement", AT_CENTRAL: "Ready to settle", SETTLED: "Settled", NOT_RECORDED: "Not recorded" };
const PAYOUT_STATUS: Record<string, string> = { UNPAID: "Processing", PAID: "Paid", CANCELLED: "Cancelled" };
const BILL_STATUS: Record<string, string> = { ISSUED: "Unpaid", PARTLY_PAID: "Partly paid", PAID: "Paid", VOID: "Cancelled" };
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

type Cell = string | number | null;
export interface Report {
  kind: ReportKind;
  title: string;
  from: string;
  to: string;
  columns: string[];
  rows: Cell[][];
  summary: Record<string, number>;
  /** The totals to show, in words: "COD collected" 12,500 (money), "Success rate" 92 (percent). */
  highlights: { label: string; value: number | string; format?: "money" | "percent" }[];
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
    const owner = this.isOwner(actor, m.id);
    const doc = m.type === "BANKING_FINANCIAL";
    const noun = doc ? "Documents" : "Orders";
    if (!owner && OWNER_REPORTS.has(kind)) throw new AppError("FORBIDDEN", "Only merchant owners can export financial reports", HttpStatus.FORBIDDEN);
    const range = { gte: from, lte: to };
    const base = { kind, title: kind === "orders" && doc ? "Delivery requests" : REPORT_TITLE[kind], from: from.toISOString(), to: to.toISOString() };

    if (kind === "orders") {
      const parcels = await this.prisma.parcel.findMany({ where: { merchantId: m.id, createdAt: range }, orderBy: { createdAt: "asc" }, take: REPORT_MAX_ROWS });
      const charges = sum(parcels.map(p => p.totalCharge));
      const cod = sum(parcels.map(p => p.codAmount));
      return {
        ...base,
        columns: ["Booked", "Tracking ID", "Reference no", "Recipient", "Phone", "District", "Zone", "Service", ...(doc ? ["Document", "Origin branch"] : ["Product", "Weight (kg)", "COD (BDT)"]), ...(owner ? ["Charge (BDT)"] : []), "Status", "Delivered"],
        rows: parcels.map(p => [
          iso(p.createdAt),
          p.trackingId,
          p.merchantOrderRef,
          p.recipientName,
          p.recipientPhone,
          p.deliveryDistrict,
          p.deliveryZone,
          SERVICE_LEVEL_LABEL[p.serviceLevel],
          ...(doc ? [p.contents, p.originBranchCode] : [p.contents, num(p.weightKg), num(p.codAmount)]),
          ...(owner ? [num(p.totalCharge)] : []),
          label(p.status),
          iso(p.deliveredAt),
        ]),
        summary: { orders: parcels.length, ...(doc ? {} : { cod }), ...(owner ? { charges } : {}) },
        highlights: [{ label: noun, value: parcels.length }, ...(doc ? [] : [{ label: "COD value", value: cod, format: "money" as const }]), ...(owner ? [{ label: "Charges", value: charges, format: "money" as const }] : [])],
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
      const successRate = delivered + returned ? round((delivered / (delivered + returned)) * 100, 1) : 0;
      return {
        ...base,
        columns: ["District", "Parcels", "Delivered", "Returned", "Cancelled", "In progress", "Success rate (%)", "Avg. delivery time (h)", "Avg. attempts"],
        rows,
        summary: { parcels: parcels.length, delivered, returned, successRate },
        highlights: [
          { label: noun, value: parcels.length },
          { label: "Delivered", value: delivered },
          { label: "Returned", value: returned },
          { label: "Success rate", value: successRate, format: "percent" },
        ],
      };
    }

    if (kind === "failed-deliveries") {
      const attempts = await this.prisma.deliveryAttempt.findMany({
        where: { outcome: "FAILED", createdAt: range, parcel: { merchantId: m.id } },
        select: { createdAt: true, reason: true, parcel: { select: { id: true, trackingId: true, merchantOrderRef: true, recipientName: true, recipientPhone: true, deliveryDistrict: true, status: true, attemptCount: true } } },
        orderBy: { createdAt: "desc" },
        take: REPORT_MAX_ROWS,
      });
      const reasons = new Map<string, number>();
      for (const a of attempts) reasons.set(a.reason || "Not given", (reasons.get(a.reason || "Not given") ?? 0) + 1);
      const top = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0];
      const parcelCount = new Set(attempts.map(a => a.parcel.id)).size;
      return {
        ...base,
        columns: ["Date", "Tracking ID", "Reference no", "Recipient", "Phone", "District", "Reason", "Attempts", "Status now"],
        rows: attempts.map(a => [iso(a.createdAt), a.parcel.trackingId, a.parcel.merchantOrderRef, a.parcel.recipientName, a.parcel.recipientPhone, a.parcel.deliveryDistrict, a.reason, a.parcel.attemptCount, label(a.parcel.status)]),
        summary: { attempts: attempts.length, parcels: parcelCount },
        highlights: [{ label: "Failed attempts", value: attempts.length }, { label: noun, value: parcelCount }, ...(top ? [{ label: "Top reason", value: top[0] }] : [])],
      };
    }

    if (kind === "branches") {
      const parcels = await this.prisma.parcel.findMany({ where: { merchantId: m.id, createdAt: range }, select: { originBranchCode: true, status: true }, take: REPORT_MAX_ROWS * 5 });
      const groups = new Map<string, { total: number; delivered: number; returned: number; cancelled: number }>();
      for (const p of parcels) {
        const code = p.originBranchCode || "No branch";
        const g = groups.get(code) ?? { total: 0, delivered: 0, returned: 0, cancelled: 0 };
        g.total++;
        if (p.status === "DELIVERED") g.delivered++;
        else if (p.status === "RETURNED" || p.status === "RETURN_SCHEDULED") g.returned++;
        else if (p.status === "PICKUP_CANCELLED") g.cancelled++;
        groups.set(code, g);
      }
      return {
        ...base,
        columns: ["Branch", "Documents", "Delivered", "Returned", "Cancelled", "In progress", "Success rate (%)"],
        rows: [...groups.entries()]
          .sort((a, b) => b[1].total - a[1].total)
          .map(([code, g]): Cell[] => [code, g.total, g.delivered, g.returned, g.cancelled, g.total - g.delivered - g.returned - g.cancelled, g.delivered + g.returned ? round((g.delivered / (g.delivered + g.returned)) * 100, 1) : null]),
        summary: { branches: groups.size, documents: parcels.length },
        highlights: [{ label: "Branches", value: groups.size }, { label: "Documents", value: parcels.length }],
      };
    }

    if (kind === "payouts") {
      const account = await this.prisma.account.findUnique({ where: { merchantId: m.id }, select: { id: true } });
      const payouts = account ? await this.prisma.payout.findMany({ where: { accountId: account.id, createdAt: range, status: { not: "CANCELLED" } }, orderBy: { createdAt: "desc" }, take: REPORT_MAX_ROWS }) : [];
      const net = sum(payouts.map(x => x.amount));
      const paid = sum(payouts.filter(x => x.status === "PAID").map(x => x.amount));
      return {
        ...base,
        columns: ["Payout", "Created", "COD (BDT)", "Charges (BDT)", "Adjustments (BDT)", "Net (BDT)", "Status", "Paid on", "Payment reference"],
        rows: payouts.map(x => [x.number, iso(x.createdAt), num(x.codTotal), num(x.chargesTotal), num(x.adjustmentsTotal), num(x.amount), PAYOUT_STATUS[x.status] ?? x.status, iso(x.paidAt), x.reference]),
        summary: { payouts: payouts.length, net, paid },
        highlights: [{ label: "Payouts", value: payouts.length }, { label: "Net amount", value: net, format: "money" }, { label: "Paid", value: paid, format: "money" }],
      };
    }

    if (kind === "cod-reconciliation") {
      const parcels = await this.prisma.parcel.findMany({
        where: { merchantId: m.id, status: "DELIVERED", deliveredAt: range, codAmount: { gt: 0 } },
        include: { codCollection: true },
        orderBy: { deliveredAt: "asc" },
        take: REPORT_MAX_ROWS,
      });
      // The settlement (Accounts) that paid each parcel's COD.
      const settled = new Map(
        (
          await this.prisma.accountEntry.findMany({
            where: { parcelId: { in: parcels.map(p => p.id) }, type: "COD", payoutId: { not: null }, payout: { status: { not: "CANCELLED" } } },
            select: { parcelId: true, payout: { select: { number: true, status: true, paidAt: true } } },
          })
        ).map(e => [e.parcelId!, e.payout!]),
      );
      const rows = parcels.map((p): Cell[] => {
        const c = p.codCollection;
        const payout = settled.get(p.id);
        return [
          iso(p.deliveredAt),
          p.trackingId,
          p.merchantOrderRef,
          num(p.codAmount),
          num(c?.amount),
          COD_STATE[c ? c.state : "NOT_RECORDED"] ?? c?.state ?? null,
          num(p.totalCharge),
          payout?.number ?? null,
          payout ? (PAYOUT_STATUS[payout.status] ?? payout.status) : null,
          iso(payout?.paidAt),
        ];
      });
      const paid = parcels.filter(p => p.codCollection?.state === "SETTLED");
      const collected = sum(parcels.map(p => p.codCollection?.amount ?? 0));
      const settledAmount = sum(paid.map(p => p.codCollection!.amount));
      return {
        ...base,
        columns: ["Delivered", "Tracking ID", "Order ref", "COD due (BDT)", "COD collected (BDT)", "Cash state", "Delivery charge (BDT)", "Settlement", "Settlement status", "Paid"],
        rows,
        summary: {
          parcels: parcels.length,
          codDue: sum(parcels.map(p => p.codAmount)),
          collected,
          settled: settledAmount,
          charges: sum(parcels.map(p => p.totalCharge)),
        },
        highlights: [
          { label: "Orders", value: parcels.length },
          { label: "COD collected", value: collected, format: "money" },
          { label: "Paid to you", value: settledAmount, format: "money" },
          { label: "Not paid yet", value: round(collected - settledAmount, 2), format: "money" },
        ],
      };
    }

    if (kind === "returns") {
      const parcels = await this.prisma.parcel.findMany({
        where: {
          merchantId: m.id,
          OR: [{ returnRequestedAt: range }, { status: { in: ["RETURN_SCHEDULED", "RETURNED"] }, statusChangedAt: range }],
        },
        orderBy: { statusChangedAt: "asc" },
        take: REPORT_MAX_ROWS,
      });
      const returned = parcels.filter(p => p.status === "RETURNED").length;
      const charges = sum(parcels.map(p => p.returnCharge ?? 0));
      return {
        ...base,
        // No internal columns (who requested it, the return run); the return charge is for owners.
        columns: ["Tracking ID", "Reference no", "Recipient", "District", "Reason", "Requested", "Status", "Return date", ...(owner ? ["Return charge (BDT)"] : []), "You confirmed"],
        rows: parcels.map(p => [
          p.trackingId,
          p.merchantOrderRef,
          p.recipientName,
          p.deliveryDistrict,
          p.returnReason,
          iso(p.returnRequestedAt),
          label(p.status),
          p.status === "RETURNED" ? iso(p.statusChangedAt) : null,
          ...(owner ? [num(p.returnCharge)] : []),
          iso(p.returnReceivedAt),
        ]),
        summary: { returns: parcels.length, returned, ...(owner ? { charges } : {}) },
        highlights: [{ label: "Returns", value: parcels.length }, { label: "Returned", value: returned }, ...(owner ? [{ label: "Return charges", value: charges, format: "money" as const }] : [])],
      };
    }

    // Bills (Accounts): Financial merchants' bills, with what's paid and due.
    const account = await this.prisma.account.findUnique({ where: { merchantId: m.id }, select: { id: true } });
    const bills = account ? await this.prisma.bill.findMany({ where: { accountId: account.id, issuedAt: range }, orderBy: { issuedAt: "asc" }, take: REPORT_MAX_ROWS }) : [];
    const open = bills.filter(b => b.status === "ISSUED" || b.status === "PARTLY_PAID");
    const billed = sum(bills.filter(b => b.status !== "VOID").map(b => b.total));
    const unpaid = sum(open.map(b => b.total.minus(b.paid)));
    return {
      ...base,
      columns: ["Bill", "Delivered from", "Delivered to", "Issued", "Status", "Total (BDT)", "Paid (BDT)", "Due (BDT)"],
      rows: bills.map(b => [b.number, dhakaDay(b.periodFrom), dhakaDay(new Date(b.periodTo.getTime() - 1)), iso(b.issuedAt), BILL_STATUS[b.status] ?? b.status, num(b.total), num(b.paid), b.status === "VOID" ? 0 : num(b.total.minus(b.paid))]),
      summary: { invoices: bills.length, total: billed, unpaid },
      highlights: [{ label: "Bills", value: bills.length }, { label: "Billed", value: billed, format: "money" }, { label: "Still due", value: unpaid, format: "money" }],
    };
  }

  /** The reports this person can open, grouped for the Reports page. */
  async reportCatalog(actor: Actor, query: { merchantId?: string }) {
    const m = await this.merchants.resolveOwn(actor, query.merchantId);
    const owner = this.isOwner(actor, m.id);
    return REPORTS.filter(r => (!r.type || r.type === m.type) && (!r.owner || owner)).map(({ kind, group, description }) => ({
      kind,
      group,
      description,
      title: kind === "orders" && m.type === "BANKING_FINANCIAL" ? "Delivery requests" : REPORT_TITLE[kind],
    }));
  }

  private isOwner(actor: Actor, merchantId: string) {
    return actor.kind === "api_key" || actor.roles.some(r => r.merchantId === merchantId && r.role === "MERCHANT_OWNER");
  }

  reportCsv(report: Report) {
    return toCsv(report.columns, report.rows);
  }

  /** The report as Excel: dates in Dhaka time ("2026-11-05 14:30"), numbers as numbers, IDs and phones as text. */
  reportXlsx(report: Report) {
    const dhaka = (value: string) => new Date(new Date(value).getTime() + 6 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
    const rows: XlsxCell[][] = [
      report.columns.map(value => ({ value, style: STYLE.headerOptional })),
      ...report.rows.map(row => row.map((cell): XlsxCell => (typeof cell === "string" ? { value: ISO_DATE.test(cell) ? dhaka(cell) : cell, style: STYLE.text } : cell))),
    ];
    return writeXlsx({ title: report.title, sheets: [{ name: report.title.slice(0, 31), rows, widths: report.columns.map(c => Math.min(30, Math.max(14, c.length + 4))), freezeHeader: true, autoFilter: true }] });
  }
}

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;
const sum = (values: (Prisma.Decimal | number | null | undefined)[]) => round(values.reduce<number>((a, v) => a + (v == null ? 0 : Number(v)), 0), 2);
