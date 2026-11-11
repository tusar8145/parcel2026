import { HttpStatus, Injectable } from "@nestjs/common";
import { chargesOffOf } from "./parcel.views";
import { parcelStatusLabel, SERVICE_LEVEL_LABEL, type ParcelStatus } from "@delivery-fast/shared";
import type { z } from "zod";
import { addressText } from "../../common/address";
import { AuditService } from "../../common/audit.service";
import { merchantIdsOf, type Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { AppError } from "../../common/errors";
import { dhakaDayKey } from "../../common/period";
import { PrismaService } from "../../common/prisma.service";
import type { Prisma } from "../../generated/prisma/client";
import { STYLE, writeXlsx, type Cell } from "../imports/xlsx/xlsx-writer";
import { ParcelsService } from "./parcels.service";
import type { exportParcelsQuerySchema } from "./parcels.schemas";

/**
 * All parcels › Export: the parcels the page's filters match (or the ticked rows) as an .xlsx file.
 *
 * Every file has the booking date (the first status), reference no and recipient phone. More columns
 * follow the filters: Delivered adds the delivery details, Returned / Return scheduled the return details,
 * and an E-commerce export (the E-commerce tab or an E-commerce merchant) adds COD.
 *
 * Merchant panels › All orders: the merchant's own parcels with `merchantExportColumns`, which hold no
 * internal data (no riders, hubs or SLA state; the delivery and return charges are for owners only).
 */

/** Keeps a file a size Excel and the API's memory handle well; a longer period is exported in parts. */
export const PARCEL_EXPORT_MAX_ROWS = 50_000;
const BATCH = 2_000;

const SELECT = {
  id: true,
  trackingId: true,
  status: true,
  intake: true,
  createdAt: true,
  statusChangedAt: true,
  merchantOrderRef: true,
  senderName: true,
  senderPhone: true,
  recipientName: true,
  recipientPhone: true,
  deliveryStreet: true,
  deliveryArea: true,
  deliveryZone: true,
  deliveryDistrict: true,
  serviceLevel: true,
  weightKg: true,
  contents: true,
  productName: true,
  productLabel: true,
  deliveryTypeName: true,
  speedOption: true,
  priorityName: true,
  pricingSnapshot: true,
  originBranchCode: true,
  totalCharge: true,
  slaState: true,
  attemptCount: true,
  codAmount: true,
  codCollectedAmount: true,
  partialDelivery: true,
  deliveredAt: true,
  receiverRelation: true,
  returnRequestedAt: true,
  returnReason: true,
  returnCharge: true,
  returnReceivedAt: true,
  merchant: { select: { name: true, code: true, type: true } },
  currentHub: { select: { name: true } },
  dropOffHub: { select: { name: true } },
  pickupRider: { select: { code: true, user: { select: { name: true } } } },
  deliveryRider: { select: { code: true, user: { select: { name: true } } } },
  proof: { select: { receivedBy: true } },
  codCollection: { select: { amount: true } },
} satisfies Prisma.ParcelSelect;

type Row = Prisma.ParcelGetPayload<{ select: typeof SELECT }>;

interface Column {
  header: string;
  width: number;
  value: (p: Row) => Cell;
}

/** Date and time in Dhaka, "2026-11-05 14:30": reads the same for everyone and sorts correctly in Excel. */
const when = (d: Date | null | undefined) => (d ? new Date(d.getTime() + 6 * 3600_000).toISOString().slice(0, 16).replace("T", " ") : "");
const num = (v: { toString(): string } | null | undefined) => (v == null ? null : Number(v));
const rider = (r: { code: string; user: { name: string } } | null) => (r ? `${r.code} · ${r.user.name}` : "");
const text = (value: string | null | undefined): Cell => ({ value: value ?? "", style: STYLE.text });
const SLA_LABEL = { ON_TRACK: "On track", AT_RISK: "At risk", BREACHED: "Breached" } as const;
const CLOSED: readonly string[] = ["DELIVERED", "PICKUP_CANCELLED", "RETURNED"];
const LINE_LABEL = { ECOMMERCE: "E-commerce", BANKING_FINANCIAL: "Banking & Financial" } as const;

const BASE: Column[] = [
  { header: "Date (first status)", width: 18, value: p => when(p.createdAt) },
  { header: "Tracking ID", width: 20, value: p => text(p.trackingId) },
  { header: "Reference no", width: 20, value: p => text(p.merchantOrderRef) },
  { header: "Status", width: 26, value: p => parcelStatusLabel(p.status as ParcelStatus, { intake: p.intake, dropOffHubName: p.dropOffHub?.name }) },
  { header: "Status update date", width: 18, value: p => when(p.statusChangedAt) },
  { header: "Parcel type", width: 20, value: p => (p.merchant ? LINE_LABEL[p.merchant.type] : "Customer parcel") },
  { header: "Merchant", width: 26, value: p => p.merchant?.name ?? "" },
  { header: "Sender", width: 22, value: p => p.senderName },
  { header: "Sender phone", width: 16, value: p => text(p.senderPhone) },
  { header: "Recipient", width: 22, value: p => p.recipientName ?? "" },
  { header: "Recipient phone", width: 16, value: p => text(p.recipientPhone) },
  { header: "Address", width: 38, value: p => addressText(p.deliveryStreet, p.deliveryArea, p.deliveryZone, p.deliveryDistrict) },
  { header: "District", width: 16, value: p => p.deliveryDistrict ?? "" },
  { header: "Zone", width: 18, value: p => p.deliveryZone ?? "" },
  { header: "Service", width: 12, value: p => SERVICE_LEVEL_LABEL[p.serviceLevel] },
  { header: "Delivery type", width: 16, value: p => p.deliveryTypeName ?? p.speedOption ?? "" },
  { header: "Priority", width: 14, value: p => p.priorityName ?? "" },
  // The product as the merchant's file / form wrote it, and the system product it was matched to.
  { header: "Product", width: 24, value: p => p.productLabel ?? p.productName ?? p.contents ?? "" },
  { header: "System product", width: 20, value: p => p.productName ?? "" },
  { header: "Weight (kg)", width: 11, value: p => num(p.weightKg) },
  { header: "Current hub", width: 20, value: p => p.currentHub?.name ?? "" },
  { header: "Pickup rider", width: 24, value: p => rider(p.pickupRider) },
  { header: "Delivery rider", width: 24, value: p => rider(p.deliveryRider) },
  { header: "SLA", width: 11, value: p => (CLOSED.includes(p.status) ? "" : SLA_LABEL[p.slaState]) },
];

const DELIVERED: Column[] = [
  { header: "Delivery date", width: 18, value: p => when(p.deliveredAt) },
  { header: "Received by", width: 22, value: p => p.proof?.receivedBy ?? "" },
  { header: "Relation", width: 16, value: p => p.receiverRelation ?? "" },
  { header: "Delivery attempts", width: 11, value: p => p.attemptCount },
  { header: "Partial delivery", width: 10, value: p => (p.status === "DELIVERED" ? (p.partialDelivery ? "Yes" : "No") : "") },
];

const RETURNED: Column[] = [
  { header: "Return date", width: 18, value: p => (p.status === "RETURNED" ? when(p.statusChangedAt) : "") },
  { header: "Return requested", width: 18, value: p => when(p.returnRequestedAt) },
  { header: "Return reason", width: 30, value: p => p.returnReason ?? "" },
  { header: "Return charge (BDT)", width: 12, value: p => num(p.returnCharge) },
  { header: "Merchant confirmed", width: 18, value: p => when(p.returnReceivedAt) },
];

const COD: Column = { header: "COD (BDT)", width: 12, value: p => num(p.codAmount) };
/** What was really collected: partial deliveries take less than the COD amount. */
const COD_COLLECTED: Column = { header: "COD collected (BDT)", width: 12, value: p => num(p.codCollectedAmount ?? p.codCollection?.amount) };

const column = (header: string) => BASE.find(c => c.header === header)!;
// A package with its charges off: no charge is shown (empty, not 0).
const CHARGE: Column = { header: "Delivery charge (BDT)", width: 13, value: p => (chargesOffOf(p) ? "" : num(p.totalCharge)) };
const RETURN_CHARGE = RETURNED.find(c => c.header === "Return charge (BDT)")!;

/** A merchant's file: its own parcels, by merchant type and status, nothing internal. */
export function merchantExportColumns(opts: { statuses?: readonly string[]; ecommerce: boolean; owner: boolean }): Column[] {
  const delivered = !!opts.statuses?.includes("DELIVERED");
  const returned = !!opts.statuses?.some(s => s === "RETURNED" || s === "RETURN_SCHEDULED");
  const place = ["Recipient", "Recipient phone", "Address", "District", "Zone", "Service", "Delivery type", "Priority"].map(column);
  // The merchant's own product name (never the system product it was matched to).
  const kind: Column[] = opts.ecommerce
    ? [{ header: "Product", width: 24, value: p => p.productLabel ?? p.productName ?? p.contents ?? "" }, column("Weight (kg)"), COD]
    : [{ header: "Document", width: 26, value: p => p.contents || p.productLabel || p.productName || "" }, { header: "Origin branch", width: 16, value: p => p.originBranchCode ?? "" }];
  return [
    ...["Date (first status)", "Tracking ID", "Reference no", "Status", "Status update date"].map(column),
    ...place,
    ...kind,
    ...(opts.owner ? [CHARGE] : []),
    ...(delivered ? DELIVERED : []),
    ...(opts.ecommerce && delivered ? [COD_COLLECTED] : []),
    ...(returned ? RETURNED.filter(c => opts.owner || c !== RETURN_CHARGE) : []),
  ];
}

/** The file's columns for these filters. */
export function exportColumns(opts: { statuses?: readonly string[]; ecommerce: boolean }): Column[] {
  const delivered = !!opts.statuses?.includes("DELIVERED");
  const returned = !!opts.statuses?.some(s => s === "RETURNED" || s === "RETURN_SCHEDULED");
  return [...BASE, ...(opts.ecommerce ? [COD] : []), ...(delivered ? DELIVERED : []), ...(opts.ecommerce && delivered ? [COD_COLLECTED] : []), ...(returned ? RETURNED : [])];
}

@Injectable()
export class ParcelExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly parcels: ParcelsService,
    private readonly audit: AuditService,
  ) {}

  async export(actor: Actor, query: z.infer<typeof exportParcelsQuerySchema>, meta: RequestMeta) {
    const merchant = query.merchantId ? await this.prisma.merchant.findUnique({ where: { id: query.merchantId }, select: { type: true, name: true } }) : null;
    const ecommerce = query.line === "ECOMMERCE" || merchant?.type === "ECOMMERCE";
    const columns = exportColumns({ statuses: query.status, ecommerce });

    return this.write(actor, query, columns, merchant?.name, "parcel.export", meta);
  }

  /** A merchant's own parcels (merchant panels › New orders / All orders). */
  async merchantExport(actor: Actor, query: z.infer<typeof exportParcelsQuerySchema>, meta: RequestMeta) {
    const own = merchantIdsOf(actor);
    const merchantId = query.merchantId ?? own[0];
    if (!merchantId || !own.includes(merchantId)) throw new AppError("FORBIDDEN", "This export is for your own merchant account", HttpStatus.FORBIDDEN);
    const merchant = await this.prisma.merchant.findUniqueOrThrow({ where: { id: merchantId }, select: { type: true, name: true, status: true } });
    if (merchant.status !== "ACTIVE") throw new AppError("FORBIDDEN", "Your account must be active to export orders", HttpStatus.FORBIDDEN);
    const owner = actor.kind === "user" && actor.roles.some(r => r.merchantId === merchantId && r.role === "MERCHANT_OWNER");
    const columns = merchantExportColumns({ statuses: query.status, ecommerce: merchant.type === "ECOMMERCE", owner });
    return this.write(actor, { ...query, merchantId }, columns, merchant.name, "merchant.parcel_export", meta);
  }

  private async write(actor: Actor, query: z.infer<typeof exportParcelsQuerySchema>, columns: Column[], merchantName: string | undefined, action: string, meta: RequestMeta) {
    const filters = await this.parcels.listWhere(actor, query);
    const where: Prisma.ParcelWhereInput = query.trackingIds ? { AND: [filters, { trackingId: { in: query.trackingIds } }] } : filters;
    const matched = await this.prisma.parcel.count({ where });

    const rows: Cell[][] = [columns.map(c => ({ value: c.header, style: STYLE.headerOptional }))];
    let cursor: string | undefined;
    let count = 0;
    while (count < PARCEL_EXPORT_MAX_ROWS) {
      const batch = await this.prisma.parcel.findMany({
        where,
        select: SELECT,
        orderBy: { id: "desc" },
        take: Math.min(BATCH, PARCEL_EXPORT_MAX_ROWS - count),
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      for (const p of batch) rows.push(columns.map(c => c.value(p)));
      count += batch.length;
      if (batch.length < BATCH) break;
      cursor = batch[batch.length - 1].id;
    }

    const buffer = writeXlsx({
      title: "Parcels",
      sheets: [{ name: "Parcels", rows, widths: columns.map(c => c.width), freezeHeader: true, autoFilter: true }],
    });
    await this.audit.record(
      actor,
      { action, entityType: "parcel", data: { rows: count, matched, status: query.status ?? null, merchantId: query.merchantId ?? null, line: query.line ?? null, from: query.from ?? null, to: query.to ?? null, dateField: query.dateField ?? "created", ticked: query.trackingIds?.length ?? 0 } },
      meta,
    );
    return { buffer, fileName: this.fileName(query, merchantName), count, matched, maxRows: PARCEL_EXPORT_MAX_ROWS };
  }

  /** parcels-delivered-northstar-store-2026-10-05-to-2026-11-05.xlsx */
  private fileName(query: z.infer<typeof exportParcelsQuerySchema>, merchant?: string) {
    const status = query.status?.length === 1 ? query.status[0] : "";
    const line = query.line && !merchant ? query.line : "";
    const range = query.from || query.to ? `${query.from ? dhakaDayKey(query.from) : "start"}-to-${query.to ? dhakaDayKey(query.to) : dhakaDayKey()}` : dhakaDayKey();
    const name = ["parcels", status, merchant ?? line, range]
      .filter(Boolean)
      .join("-")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    return `${name}.xlsx`;
  }
}
