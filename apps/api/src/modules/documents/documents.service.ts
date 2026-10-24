import { Injectable, Logger } from "@nestjs/common";
import { addressText } from "../../common/address";
import type { Readable } from "node:stream";
import type { z } from "zod";
import { displayPriceLines, LAST_MILE_LABEL, PARCEL_STATUS_LABEL, SERVICE_LEVEL_LABEL, SPEED_LABEL, parcelStatusLabel, type ParcelStatus } from "@delivery-fast/shared";
import { env } from "../../config/env";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { actorLabel, hasRole, merchantIdsOf, type Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { AppError, forbidden, notFound } from "../../common/errors";
import type { Prisma } from "../../generated/prisma/client";
import { NotificationSettingsService } from "../notifications/notification-settings.service";
import { readFinanceConfig, vatSplit } from "../finance/finance-config";
import { financeMerchantScope } from "../finance/finance.scope";
import { InvoicesService } from "../finance/invoices.service";
import { invoicedParcels } from "../finance/invoiced";
import { SettlementsService } from "../finance/settlements.service";
import { LinehaulService } from "../linehaul/linehaul.service";
import { CnStockService } from "../cn-stock/cn-stock.service";
import { ReturnsService } from "../returns/returns.service";
import { ReportsService } from "../reports/reports.service";
import { SlaService } from "../sla/sla.service";
import { HubReconciliationService, type HubReconciliationQuery } from "../hub-reconciliation/hub-reconciliation.service";
import { codeVariants, isUuid } from "../ops/ops-common";
import { dhakaDateRange, opsHubScope } from "../parcels/ops-scope";
import { MISSING_LABEL, type MissingField } from "../parcels/incomplete";
import type { Brand, DocMeta } from "./pdf/layout";
import { A4, dhakaToday, PdfWriter } from "./pdf/writer";
import { drawLabels, LABEL_PAGE, labelPages, type LabelData } from "./render/labels";
import { drawShipmentInvoices, drawShipmentList, type ShipmentDoc } from "./render/shipments";
import { BAG_LABEL_SIZE, drawBagLabel, drawCnSheet, drawManifest, drawReturnRun, drawRunSheet, drawTableDoc, type RunSheetDoc } from "./render/operations";
import { drawFinanceInvoice, drawSettlement, drawStatement, drawFranchiseInvoice, type FranchiseInvoiceDoc } from "./render/finance";
import { MAX_INVOICES, MAX_LABELS, MAX_LIST_ROWS, type cnSheetQuerySchema, type invoicesQuerySchema, type labelsQuerySchema, type parcelListQuerySchema, type runSheetQuerySchema, type slaReportQuerySchema, type statementQuerySchema } from "./documents.schemas";

/** A generated PDF: streamed to the client as it is written. */
export interface PdfFile {
  fileName: string;
  stream: Readable;
  /** Pages, when known before generation (labels). */
  pages?: number;
  /** Parcels printed / asked for but not found (or outside the caller's scope). */
  count?: number;
  missing?: string[];
}

const LANDSCAPE: [number, number] = [A4[1], A4[0]];
const NIL = "00000000-0000-0000-0000-000000000000";
const PICKUP_PHASE: ParcelStatus[] = ["PENDING_CONFIRMATION", "PICKUP_ASSIGNED", "PICKUP_CONFIRMED", "PICKED_UP", "PICKUP_CANCELLED"];
const DELIVERY_OPEN: ParcelStatus[] = ["ASSIGNED", "OUT_FOR_DELIVERY", "RETRY_SCHEDULED"];
const PICKUP_OPEN: ParcelStatus[] = ["PICKUP_ASSIGNED", "PICKUP_CONFIRMED"];
const DELIVERY_EVENTS: ParcelStatus[] = ["ASSIGNED", "OUT_FOR_DELIVERY", "DELIVERED", "RETRY_SCHEDULED", "EXCEPTION", "READY_FOR_COLLECTION"];
const PICKUP_EVENTS: ParcelStatus[] = ["PICKUP_ASSIGNED", "PICKUP_CONFIRMED", "PICKED_UP"];

const parcelInclude = {
  merchant: { select: { id: true, name: true, code: true, type: true, contactPhone: true } },
  dropOffHub: { select: { id: true, code: true, name: true } },
  currentHub: { select: { id: true, code: true, name: true } },
  collectHub: { select: { id: true, code: true, name: true } },
  bookingBatch: { select: { number: true } },
  cnStock: { select: { cn: true } },
  pickupRider: { select: { code: true, user: { select: { name: true } } } },
  deliveryRider: { select: { code: true, user: { select: { name: true } } } },
} satisfies Prisma.ParcelInclude;
type ParcelRow = Prisma.ParcelGetPayload<{ include: typeof parcelInclude }>;

const num = (v: unknown) => (v == null ? 0 : Number(v));
const stamp = (d = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "";
  return `${get("year")}${get("month")}${get("day")}-${get("hour")}${get("minute")}`;
};
const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");

/** Minimal CSV reader for stored report runs (quotes, doubled quotes, CRLF, BOM). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") row.push(cell), (cell = "");
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  return rows.map(r => r.map(c => (c.startsWith("'") && /^'[=+\-@]/.test(c) ? c.slice(1) : c)));
}

/**
 * PDF documents for every print button: shipping labels, delivery invoices, shipment lists,
 * linehaul manifests and bag tags, rider run sheets, CN label sheets, return runs, finance tax
 * invoices, settlement statements, merchant statements and reports. Each endpoint checks the
 * same permissions and scope as the data it prints, and every generation is audited
 * (`document.generate`).
 */
/** The merchant's payout account (Merchant.payoutAccount JSON) as the settlement PDF's "Pay to", or null. */
function payToOf(raw: unknown): { method: string; accountName: string; accountNumber: string; bankName?: string; branch?: string; routingNumber?: string } | null {
  const a = raw as { method?: unknown; accountName?: unknown; accountNumber?: unknown; bankName?: unknown; branch?: unknown; routingNumber?: unknown } | null;
  if (!a || typeof a.method !== "string" || typeof a.accountNumber !== "string") return null;
  const str = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim() : undefined);
  return { method: a.method, accountName: str(a.accountName) ?? "—", accountNumber: a.accountNumber, bankName: str(a.bankName), branch: str(a.branch), routingNumber: str(a.routingNumber) };
}

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger("Documents");

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: NotificationSettingsService,
    private readonly invoices: InvoicesService,
    private readonly settlements: SettlementsService,
    private readonly linehaul: LinehaulService,
    private readonly cnStock: CnStockService,
    private readonly returns: ReturnsService,
    private readonly reports: ReportsService,
    private readonly sla: SlaService,
    private readonly reconciliation: HubReconciliationService,
  ) {}

  // ───────────── shared ─────────────

  /** Company identity printed in every header: brand settings, finance seller, website. */
  async brand(): Promise<Brand> {
    const [snap, fin] = await Promise.all([this.settings.snapshot(), readFinanceConfig(this.prisma)]);
    let website = "";
    try {
      website = new URL(env().APP_URL).host;
    } catch {
      website = "";
    }
    return {
      appName: snap.brand.appName,
      legalName: fin.seller.name,
      address: fin.seller.address,
      bin: fin.seller.bin,
      support: snap.brand.support,
      website,
      vatRate: fin.vatRate,
    };
  }

  private meta(actor: Actor, title: string, extra: Partial<DocMeta> = {}): DocMeta {
    return { title, generatedAt: new Date(), generatedBy: actorLabel(actor), ...extra };
  }

  private async record(actor: Actor, kind: string, data: Record<string, unknown>, meta: RequestMeta, entityId?: string, entityType = "document") {
    await this.audit.record(actor, { action: "document.generate", entityType, entityId, data: { kind, ...data } }, meta);
  }

  /** Runs `draw` (sync or async) and ends the document; errors end the stream with the error. */
  private finish(pdf: PdfWriter, draw: () => void | Promise<void>): Readable {
    const run = async () => {
      // Let the caller attach the stream to the response before pages are produced.
      await new Promise(resolve => setImmediate(resolve));
      await draw();
      pdf.doc.end();
    };
    run().catch(error => {
      this.logger.error({ err: error }, "PDF generation failed");
      pdf.doc.destroy(error as Error);
    });
    return pdf.doc;
  }

  private trackingUrl(trackingId: string) {
    return `${env().APP_URL.replace(/\/$/, "")}/track/${encodeURIComponent(trackingId)}`;
  }

  // ───────────── parcel scope ─────────────

  /**
   * Parcels the caller may print. Staff with parcel:read:any: the whole network, hub operators
   * their hubs' work (held at, dropped off at, heading to or picked up in zones their hubs serve,
   * or with their hubs' riders). Merchants (and their API keys): their own parcels; customers
   * theirs.
   */
  private async parcelScope(actor: Actor): Promise<Prisma.ParcelWhereInput> {
    if (actor.permissions.has("parcel:read:any")) {
      const scope = opsHubScope(actor);
      if (!scope) return {};
      const zones = await this.prisma.deliveryZone.findMany({ where: { hubId: { in: scope }, active: true }, select: { district: true, name: true } });
      const zoneMatch = (district: "pickupDistrict" | "deliveryDistrict", zone: "pickupZone" | "deliveryZone") =>
        zones.map(z => ({ [district]: { equals: z.district, mode: "insensitive" as const }, [zone]: { equals: z.name, mode: "insensitive" as const } }));
      return {
        OR: [
          { currentHubId: { in: scope } },
          { dropOffHubId: { in: scope } },
          { collectHubId: { in: scope } },
          { pickupRider: { hubId: { in: scope } } },
          { deliveryRider: { hubId: { in: scope } } },
          ...(zones.length ? [{ OR: zoneMatch("pickupDistrict", "pickupZone") }, { OR: zoneMatch("deliveryDistrict", "deliveryZone") }] : []),
        ],
      };
    }
    // A franchise: labels and receipts for parcels of its own hub (walk-ins at its counter, its riders' parcels).
    const franchiseHubs = actor.kind === "user" ? actor.roles.flatMap(r => (r.role === "FRANCHISE" && r.hubId ? [r.hubId] : [])) : [];
    if (franchiseHubs.length) {
      const inHubs = { in: franchiseHubs };
      return { OR: [{ currentHubId: inHubs }, { dropOffHubId: inHubs }, { collectHubId: inHubs }, { pickupHubId: inHubs }, { pickupRider: { hubId: inHubs } }, { deliveryRider: { hubId: inHubs } }] };
    }
    if (!actor.permissions.has("parcel:read:own")) throw forbidden("You can't print parcel documents");
    const or: Prisma.ParcelWhereInput[] = [];
    const merchants = merchantIdsOf(actor);
    if (merchants.length) or.push({ merchantId: { in: merchants } });
    if (actor.kind === "user" && hasRole(actor, "CUSTOMER")) or.push({ customerId: actor.userId });
    return or.length ? { OR: or } : { id: NIL };
  }

  /** The selected parcels within scope, in the order asked for; unknown / out-of-scope IDs are reported as missing. */
  private async loadParcels(actor: Actor, input: { ids?: string[]; batchId?: string }, max: number, what: string) {
    const scope = await this.parcelScope(actor);
    let rows: ParcelRow[];
    let missing: string[] = [];
    if (input.ids?.length) {
      const asked = [...new Set(input.ids.map(id => id.trim().toUpperCase()))];
      if (asked.length > max) throw new AppError("TOO_MANY_PARCELS", `At most ${max.toLocaleString("en-US")} ${what} per PDF (you selected ${asked.length.toLocaleString("en-US")}). Print them in smaller batches.`, 422, { max, selected: asked.length });
      const variants = [...new Set(asked.flatMap(codeVariants))];
      rows = await this.prisma.parcel.findMany({
        where: { AND: [scope, { OR: [{ trackingId: { in: variants } }, { cnStock: { cn: { in: variants } } }] }] },
        include: parcelInclude,
      });
      const index = new Map<string, number>();
      asked.forEach((id, i) => codeVariants(id).forEach(v => index.has(v) || index.set(v, i)));
      const pos = (p: ParcelRow) => Math.min(index.get(p.trackingId) ?? 1e9, p.cnStock ? (index.get(p.cnStock.cn) ?? 1e9) : 1e9);
      rows.sort((a, b) => pos(a) - pos(b));
      const found = new Set(rows.flatMap(p => [p.trackingId, p.cnStock?.cn].filter((x): x is string => !!x)));
      missing = asked.filter(id => !codeVariants(id).some(v => found.has(v)));
    } else {
      const batch = await this.prisma.bookingBatch.findUnique({ where: { id: input.batchId! }, select: { id: true } });
      if (!batch) throw notFound("Booking batch");
      const where = { AND: [scope, { bookingBatchId: batch.id }] };
      const count = await this.prisma.parcel.count({ where });
      if (count > max) throw new AppError("TOO_MANY_PARCELS", `This batch has ${count.toLocaleString("en-US")} parcels; at most ${max.toLocaleString("en-US")} ${what} fit in one PDF. Select fewer parcels.`, 422, { max, selected: count });
      rows = await this.prisma.parcel.findMany({ where, include: parcelInclude, orderBy: [{ merchantOrderRef: "asc" }, { trackingId: "asc" }] });
    }
    if (!rows.length) throw new AppError("NOT_FOUND", input.ids?.length ? "None of these parcels were found, or you can't print them" : "This batch has no parcels you can print", 404, { missing: missing.slice(0, 50) });
    return { rows, missing };
  }

  private async toLabels(rows: ParcelRow[]): Promise<LabelData[]> {
    const zoneKeys = [...new Set(rows.flatMap(p => [`${p.pickupDistrict}|${p.pickupZone}`, `${p.deliveryDistrict ?? ""}|${p.deliveryZone ?? ""}`]))]
      .map(k => k.split("|"))
      .filter(([d, z]) => d && z);
    const zones = zoneKeys.length
      ? await this.prisma.deliveryZone.findMany({
          where: { OR: zoneKeys.map(([district, name]) => ({ district: { equals: district, mode: "insensitive" as const }, name: { equals: name, mode: "insensitive" as const } })), active: true },
          select: { district: true, name: true, code: true, hub: { select: { code: true, name: true } } },
        })
      : [];
    const zoneOf = (district: string | null, name: string | null) =>
      district && name ? zones.find(z => z.district.toLowerCase() === district.toLowerCase() && z.name.toLowerCase() === name.toLowerCase()) : undefined;
    return rows.map(p => {
      const dest = zoneOf(p.deliveryDistrict, p.deliveryZone);
      const origin = p.dropOffHub ?? zoneOf(p.pickupDistrict, p.pickupZone)?.hub ?? p.currentHub ?? null;
      const destHub = p.lastMile === "HUB_COLLECT" && p.collectHub ? p.collectHub : (dest?.hub ?? null);
      return {
        trackingId: p.trackingId,
        cn: p.cnStock?.cn ?? null,
        merchant: p.merchant?.name ?? p.senderName,
        merchantCode: p.merchant?.code ?? null,
        orderRef: p.merchantOrderRef,
        sender: { name: p.senderName, phone: p.senderPhone },
        recipient: { name: p.recipientName, phone: p.recipientPhone },
        address: { street: p.deliveryStreet, area: p.deliveryArea, zone: p.deliveryZone, district: p.deliveryDistrict },
        codAmount: num(p.codAmount),
        weightKg: num(p.weightKg),
        isDocument: p.type === "DOCUMENT" || p.merchant?.type === "BANKING_FINANCIAL",
        service: p.speedOption ? ((SPEED_LABEL as Record<string, string>)[p.speedOption] ?? p.speedOption) : SERVICE_LEVEL_LABEL[p.serviceLevel],
        deliveryMode: p.lastMile ? ((LAST_MILE_LABEL as Record<string, string>)[p.lastMile] ?? p.lastMile) + (p.lastMile === "HUB_COLLECT" && p.collectHub ? ` (${p.collectHub.name})` : "") : "Home delivery",
        product: p.productName ?? p.documentType ?? p.contents ?? null,
        intake: p.intake,
        originHub: origin ? { code: origin.code, name: origin.name } : null,
        destHub: destHub ? { code: destHub.code, name: destHub.name } : null,
        zoneCode: dest?.code ?? null,
        batch: p.bookingBatch?.number ?? null,
        instructions: p.instructions,
        bookedAt: p.createdAt,
        incomplete: p.incomplete,
        missingLabels: p.missingFields.map(f => MISSING_LABEL[f as MissingField] ?? f),
        openBox: p.openBox,
        trackingUrl: this.trackingUrl(p.trackingId),
      };
    });
  }

  private async toShipments(rows: ParcelRow[], vatRate: number): Promise<ShipmentDoc[]> {
    const labels = await this.toLabels(rows);
    const merchantIds = [...new Set(rows.map(p => p.merchantId).filter((x): x is string => !!x))];
    const invoiced = await invoicedParcels(this.prisma, merchantIds);
    return rows.map((p, i) => {
      const l = labels[i];
      const snap = p.pricingSnapshot as { segment?: string; lines?: { code: string; label: string; amount: number }[] } | null;
      const chargeLines = snap?.lines?.length
        ? displayPriceLines(snap.lines.map(x => ({ code: x.code, label: x.label, amount: Number(x.amount) })), snap.segment).map(x => ({ label: x.label, amount: x.amount }))
        : [
            { label: "Delivery (base)", amount: num(p.baseCharge) },
            { label: "Weight", amount: num(p.weightCharge) },
            { label: "Service", amount: num(p.serviceCharge) },
            { label: "COD fee", amount: num(p.codFee) },
            { label: "Discount", amount: -num(p.discount) },
          ].filter(x => x.amount !== 0);
      if (num(p.reattemptCharge)) chargeLines.push({ label: "Re-attempt charge", amount: num(p.reattemptCharge) });
      const total = num(p.totalCharge) + num(p.reattemptCharge);
      const split = vatSplit(total, vatRate);
      const line: ShipmentDoc["line"] = !p.merchantId ? "customer" : l.isDocument ? "document" : "ecommerce";
      const cod = num(p.codAmount) > 0;
      const delivered = p.status === "DELIVERED";
      const billed = !cod && p.deliveredAt ? invoiced.get(p.trackingId) : undefined;
      const payment = cod
        ? delivered
          ? "COD collected from recipient"
          : "Collect COD on delivery"
        : line === "customer"
          ? "Delivery charge paid by sender"
          : billed
            ? `Billed on ${billed.number} · ${billed.status === "PAID" ? "paid" : "unpaid"}`
            : delivered
              ? "Delivered · to be invoiced"
              : "Prepaid · billed monthly";
      const deliveryCharge = cod
        ? line === "customer"
          ? "The delivery charge is settled with the sender."
          : "The delivery charge is deducted from the merchant's COD settlement."
        : line === "customer"
          ? "Paid by the sender at booking."
          : "Billed to the merchant on the monthly tax invoice.";
      const rider = p.deliveryRider ?? p.pickupRider;
      return {
        ...l,
        status: p.status,
        statusLabel: parcelStatusLabel(p.status as ParcelStatus, { intake: p.intake, dropOffHubName: p.dropOffHub?.name ?? null }) ?? PARCEL_STATUS_LABEL[p.status as ParcelStatus],
        line,
        rider: rider ? `${rider.code} · ${rider.user.name}` : null,
        deliveredAt: p.deliveredAt,
        packaging: p.packaging,
        contents: p.contents,
        declaredValue: p.declaredValue == null ? null : num(p.declaredValue),
        chargeLines,
        total,
        vat: Number(split.vat),
        taxable: Number(split.taxable),
        payment,
        deliveryCharge,
      };
    });
  }

  // ───────────── parcels: labels, invoices, list ─────────────

  async labels(actor: Actor, input: z.infer<typeof labelsQuerySchema>, meta: RequestMeta): Promise<PdfFile> {
    const { rows, missing } = await this.loadParcels(actor, input, MAX_LABELS, "labels");
    const [labels, brand] = await Promise.all([this.toLabels(rows), this.brand()]);
    const now = new Date();
    await this.record(actor, "labels", { format: input.format, count: labels.length, trackingIds: labels.map(l => l.trackingId).slice(0, 500), missing: missing.length }, meta);
    const pdf = new PdfWriter({ size: LABEL_PAGE[input.format].size as [number, number], title: `${brand.appName} shipping labels (${labels.length})` });
    return {
      fileName: `delivery-fast-labels-${input.format}-${stamp(now)}.pdf`,
      stream: this.finish(pdf, () => drawLabels(pdf, brand, labels, input.format, now)),
      pages: labelPages(input.format, labels.length),
      count: labels.length,
      missing,
    };
  }

  async shipmentInvoices(actor: Actor, input: z.infer<typeof invoicesQuerySchema>, meta: RequestMeta): Promise<PdfFile> {
    const { rows, missing } = await this.loadParcels(actor, input, MAX_INVOICES, "invoices");
    const brand = await this.brand();
    const all = await this.toShipments(rows, brand.vatRate);
    const items = input.line === "all" ? all : all.filter(s => s.line === input.line);
    const lineName = { all: "", ecommerce: "e-commerce", document: "document", customer: "customer parcel" }[input.line];
    if (!items.length) throw new AppError("NOTHING_TO_PRINT", `None of the selected parcels are ${lineName} shipments`, 422);
    await this.record(actor, "shipment_invoices", { layout: input.layout, line: input.line, count: items.length, trackingIds: items.map(s => s.trackingId).slice(0, 500), missing: missing.length }, meta);
    const title = `${input.line === "all" ? "Delivery" : lineName[0].toUpperCase() + lineName.slice(1)} invoices`;
    const docMeta = this.meta(actor, title, { subtitle: `${items.length} shipment(s)` });
    const pdf = new PdfWriter({ size: A4, title: `${brand.appName} ${title.toLowerCase()} (${items.length})`, bufferPages: input.layout === "a4" });
    return {
      fileName: `delivery-fast-invoices-${input.line}-${input.layout}-${stamp()}.pdf`,
      stream: this.finish(pdf, () => drawShipmentInvoices(pdf, brand, items, input.layout, docMeta)),
      count: items.length,
      missing,
    };
  }

  async parcelList(actor: Actor, input: z.infer<typeof parcelListQuerySchema>, meta: RequestMeta): Promise<PdfFile> {
    const { rows, missing } = await this.loadParcels(actor, input, MAX_LIST_ROWS, "rows");
    const brand = await this.brand();
    const items = await this.toShipments(rows, brand.vatRate);
    await this.record(actor, "parcel_list", { count: items.length, missing: missing.length }, meta);
    const title = input.title ?? "Shipment list";
    const docMeta = this.meta(actor, title, { subtitle: `${items.length} shipment(s)` });
    const pdf = new PdfWriter({ size: LANDSCAPE, title: `${brand.appName} ${title.toLowerCase()}`, bufferPages: true });
    return { fileName: `delivery-fast-${safeName(title.toLowerCase())}-${stamp()}.pdf`, stream: this.finish(pdf, () => void drawShipmentList(pdf, brand, items, docMeta)), count: items.length, missing };
  }

  // ───────────── linehaul ─────────────

  async manifest(actor: Actor, tripRef: string, meta: RequestMeta): Promise<PdfFile> {
    const t = await this.linehaul.getTrip(actor, tripRef);
    const brand = await this.brand();
    await this.record(actor, "linehaul_manifest", { number: t.number, parcels: t.totals.parcels }, meta, t.id, "linehaul_trip");
    const docMeta = this.meta(actor, "Linehaul manifest", { number: t.number, date: t.departedAt ?? t.plannedDepartureAt ?? t.createdAt, subtitle: `${t.originHub.code} -> ${t.destHub.code} · ${t.status.replace(/_/g, " ").toLowerCase()}` });
    const pdf = new PdfWriter({ size: A4, title: `Manifest ${t.number}`, bufferPages: true });
    const doc = {
      number: t.number,
      status: t.status.replace(/_/g, " "),
      originHub: t.originHub,
      destHub: t.destHub,
      vehicle: [t.vehicle?.regNo ?? t.vehicleRegNo, t.vehicle?.kind].filter(Boolean).join(" · ") || "—",
      driverName: t.driverName,
      driverPhone: t.driverPhone,
      plannedDepartureAt: t.plannedDepartureAt,
      departedAt: t.departedAt,
      arrivedAt: t.arrivedAt,
      note: t.note,
      bags: t.bags.map(b => ({ number: b.number, sealNo: b.sealNo, status: b.status.replace(/_/g, " "), parcels: b.totals.parcels, weightKg: b.totals.weightKg, codAmount: b.totals.codAmount, received: b.totals.received, missing: b.totals.missing })),
      parcels: t.bags.flatMap(b => b.items.map(i => ({ bag: b.number, trackingId: i.parcel.trackingId, recipient: i.parcel.recipient, zone: i.parcel.zone, district: i.parcel.district, weightKg: i.parcel.weightKg, codAmount: i.parcel.codAmount, state: i.state.toLowerCase() }))),
      totals: t.totals,
    };
    return { fileName: `delivery-fast-manifest-${safeName(t.number)}.pdf`, stream: this.finish(pdf, () => drawManifest(pdf, brand, doc, docMeta)) };
  }

  async bagLabel(actor: Actor, bagRef: string, meta: RequestMeta): Promise<PdfFile> {
    const b = await this.linehaul.getBag(actor, bagRef);
    const brand = await this.brand();
    await this.record(actor, "bag_label", { number: b.number }, meta, b.id, "linehaul_bag");
    const pdf = new PdfWriter({ size: BAG_LABEL_SIZE, title: `Bag ${b.number}` });
    const doc = { number: b.number, originHub: b.originHub, destHub: b.destHub, sealNo: b.sealNo, label: b.label, parcels: b.totals.parcels, weightKg: b.totals.weightKg, codAmount: b.totals.codAmount, trip: b.trip?.number ?? null, sealedAt: b.sealedAt };
    return { fileName: `delivery-fast-bag-${safeName(b.number)}.pdf`, stream: this.finish(pdf, () => drawBagLabel(pdf, brand, doc, new Date())) };
  }

  // ───────────── rider run sheet ─────────────

  /**
   * The rider's work for a Dhaka day, keyed on assignment (not the pickup date): today the open
   * delivery and pickup tasks plus everything the rider handled today; other days the parcels
   * with an assignment / attempt / pickup event that day. Route order from the day's optimised
   * route plan when there is one, else by zone, area and address.
   */
  async runSheet(actor: Actor, riderRef: string, query: z.infer<typeof runSheetQuerySchema>, meta: RequestMeta): Promise<PdfFile> {
    if (!actor.permissions.has("parcel:read:any")) throw forbidden("Run sheets are for operations staff");
    const rider = await this.prisma.rider.findFirst({
      where: isUuid(riderRef) ? { id: riderRef } : { code: { equals: riderRef.trim(), mode: "insensitive" } },
      include: { user: { select: { name: true, phone: true } }, hub: { select: { id: true, code: true, name: true } } },
    });
    if (!rider) throw notFound("Rider");
    const scope = opsHubScope(actor);
    if (scope && (!rider.hubId || !scope.includes(rider.hubId))) throw forbidden("You can only print run sheets for your own hub's riders");
    const today = dhakaToday();
    const day = query.date ?? today;
    const [start, end] = dhakaDateRange(day, day);
    const onDay = { createdAt: { gte: start, lt: end } };
    const parcels = await this.prisma.parcel.findMany({
      where: {
        OR: [
          ...(day === today ? [{ deliveryRiderId: rider.id, status: { in: DELIVERY_OPEN } }, { pickupRiderId: rider.id, status: { in: PICKUP_OPEN } }] : []),
          { deliveryRiderId: rider.id, events: { some: { ...onDay, status: { in: DELIVERY_EVENTS } } } },
          { pickupRiderId: rider.id, events: { some: { ...onDay, status: { in: PICKUP_EVENTS } } } },
        ],
      },
      include: { merchant: { select: { name: true } } },
      take: 1000,
    });
    const plan = await this.prisma.routePlan.findFirst({ where: { riderId: rider.id, workDate: new Date(`${day}T00:00:00Z`) }, orderBy: { createdAt: "desc" } });
    const planned = new Map(((plan?.stops as { trackingId: string; seq: number }[] | null) ?? []).map(s => [s.trackingId, s.seq]));
    const kindOf = (p: (typeof parcels)[number]) => (p.deliveryRiderId === rider.id && !PICKUP_PHASE.includes(p.status as ParcelStatus) ? "Delivery" : "Pickup");
    const sortKey = (p: (typeof parcels)[number]) => {
      const pickup = kindOf(p) === "Pickup";
      return [pickup ? p.pickupZone : (p.deliveryZone ?? ""), pickup ? (p.pickupArea ?? "") : (p.deliveryArea ?? ""), pickup ? p.pickupStreet : (p.deliveryStreet ?? ""), p.trackingId].join("|").toLowerCase();
    };
    parcels.sort((a, b) => {
      const pa = planned.get(a.trackingId);
      const pb = planned.get(b.trackingId);
      if (pa != null || pb != null) return (pa ?? 1e9) - (pb ?? 1e9);
      return sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0;
    });
    const doc: RunSheetDoc = {
      rider: { code: rider.code, name: rider.user.name, phone: rider.user.phone, hub: rider.hub ? `${rider.hub.code} · ${rider.hub.name}` : null, vehicle: rider.vehicle ? rider.vehicle.charAt(0) + rider.vehicle.slice(1).toLowerCase().replace(/_/g, " ") : null },
      date: day,
      routed: planned.size > 0,
      stops: parcels.map((p, i) => {
        const kind = kindOf(p);
        const pickup = kind === "Pickup";
        return {
          seq: i + 1,
          kind,
          trackingId: p.trackingId,
          name: pickup ? `${p.senderName}${p.merchant ? ` (${p.merchant.name})` : ""}` : p.recipientName,
          phone: pickup ? p.senderPhone : p.recipientPhone,
          address: (pickup ? addressText(p.pickupStreet, p.pickupArea, p.pickupZone, p.pickupDistrict) : addressText(p.deliveryStreet, p.deliveryArea, p.deliveryZone, p.deliveryDistrict)) || "Address pending",
          zone: pickup ? p.pickupZone : p.deliveryZone,
          codAmount: pickup ? 0 : num(p.codAmount),
          status: PARCEL_STATUS_LABEL[p.status as ParcelStatus] ?? p.status,
          // Re-attempts after failed deliveries are flagged for the rider.
          note: [!pickup && p.attemptCount > 0 ? `Re-attempt · failed ×${p.attemptCount} before` : "", p.instructions ?? ""].filter(Boolean).join(" · ") || null,
          orderRef: p.merchantOrderRef,
        };
      }),
    };
    if (!doc.stops.length) throw new AppError("NOTHING_TO_PRINT", `${rider.code} · ${rider.user.name} has no parcels assigned for ${day}`, 422);
    const brand = await this.brand();
    await this.record(actor, "run_sheet", { rider: rider.code, date: day, stops: doc.stops.length }, meta, rider.id, "rider");
    const docMeta = this.meta(actor, "Rider run sheet", { number: `${rider.code} · ${day}`, subtitle: `${rider.user.name} · ${doc.stops.length} stop(s)` });
    const pdf = new PdfWriter({ size: LANDSCAPE, title: `Run sheet ${rider.code} ${day}`, bufferPages: true });
    return { fileName: `delivery-fast-run-sheet-${safeName(rider.code)}-${day}.pdf`, stream: this.finish(pdf, () => drawRunSheet(pdf, brand, doc, docMeta)), count: doc.stops.length };
  }

  // ───────────── CN stock ─────────────

  async cnSheet(actor: Actor, batchId: string, query: z.infer<typeof cnSheetQuerySchema>, meta: RequestMeta): Promise<PdfFile> {
    // CnStockService.print checks the hub scope, counts the print and writes `cn.print`.
    const result = await this.cnStock.print(actor, batchId, { cns: query.cns?.length ? query.cns : undefined }, meta);
    if (!result.labels.length) throw new AppError("NOTHING_TO_PRINT", "No unused labels to print in this batch", 422);
    const brand = await this.brand();
    await this.record(actor, "cn_sheet", { number: result.batch.number, labels: result.labels.length }, meta, batchId, "cn_batch");
    const docMeta = this.meta(actor, "CN label sheet", { number: result.batch.number });
    const pdf = new PdfWriter({ size: A4, title: `CN labels ${result.batch.number}` });
    const doc = { number: result.batch.number, hub: result.batch.hub?.name ?? null, merchant: result.batch.merchant?.name ?? null, labels: result.labels.map(l => ({ cn: l.cn, reprint: l.reprint })) };
    return { fileName: `delivery-fast-cn-${safeName(result.batch.number)}.pdf`, stream: this.finish(pdf, () => drawCnSheet(pdf, brand, doc, docMeta)), count: doc.labels.length };
  }

  // ───────────── returns ─────────────

  async returnRun(actor: Actor, id: string, meta: RequestMeta): Promise<PdfFile> {
    const r = await this.returns.run(actor, id);
    const [brand, rider, hub] = await Promise.all([
      this.brand(),
      r.riderId ? this.prisma.rider.findUnique({ where: { id: r.riderId }, select: { code: true, user: { select: { name: true, phone: true } } } }) : null,
      r.hubId ? this.prisma.hub.findUnique({ where: { id: r.hubId }, select: { code: true, name: true } }) : null,
    ]);
    await this.record(actor, "return_run", { number: r.number, parcels: r.parcelCount }, meta, r.id, "return_run");
    const docMeta = this.meta(actor, "Return run sheet", { number: r.number, date: r.dispatchedAt ?? r.createdAt, subtitle: `${r.merchant.name} · ${r.parcelCount} parcel(s)` });
    const pdf = new PdfWriter({ size: A4, title: `Return run ${r.number}`, bufferPages: true });
    const doc = {
      number: r.number,
      status: r.status.replace(/_/g, " "),
      merchant: { code: r.merchant.code, name: r.merchant.name, address: addressText(r.merchant.pickupAddress, r.merchant.pickupArea, r.merchant.pickupDistrict), phone: r.merchant.contactPhone },
      rider: rider ? `${rider.code} · ${rider.user.name}${rider.user.phone ? ` · ${rider.user.phone}` : ""}` : null,
      hub: hub ? `${hub.code} · ${hub.name}` : null,
      note: r.note,
      createdAt: r.createdAt,
      dispatchedAt: r.dispatchedAt,
      completedAt: r.completedAt,
      parcels: (r.parcels ?? []).map(p => ({ trackingId: p.trackingId, recipient: p.recipientName, reason: p.reason, attempts: p.attemptCount, codAmount: p.codAmount, returnCharge: p.returnCharge, status: PARCEL_STATUS_LABEL[p.status as ParcelStatus] ?? p.status })),
      returnCharges: r.returnCharges ?? 0,
    };
    return { fileName: `delivery-fast-return-run-${safeName(r.number)}.pdf`, stream: this.finish(pdf, () => drawReturnRun(pdf, brand, doc, docMeta)) };
  }

  // ───────────── finance ─────────────

  async financeInvoice(actor: Actor, id: string, meta: RequestMeta): Promise<PdfFile> {
    const i = await this.invoices.detail(actor, id);
    const brand = await this.brand();
    await this.record(actor, "finance_invoice", { number: i.number }, meta, i.id, "invoice");
    const docMeta = this.meta(actor, "Tax invoice", { number: i.number, date: i.issuedAt, subtitle: `Mushak-6.3 draft · ${i.merchant.name} · ${i.status === "ISSUED" ? (i.overdue ? "overdue" : "unpaid") : i.status.toLowerCase()}` });
    const seller = (i.seller ?? {}) as { name?: string; bin?: string; address?: string };
    const lines = (Array.isArray(i.lines) ? i.lines : []) as { trackingId?: string; description?: string; amount?: number | string; taxableValue?: number | string; vat?: number | string }[];
    const doc = {
      number: i.number,
      status: i.status,
      overdue: i.overdue,
      issuedAt: i.issuedAt,
      dueAt: i.dueAt,
      periodStart: i.periodStart,
      periodEnd: i.periodEnd,
      paidAt: i.paidAt,
      paymentReference: i.paymentReference,
      vatRate: i.vatRate,
      taxableValue: num(i.taxableValue),
      vatAmount: num(i.vatAmount),
      total: num(i.total),
      seller: { name: seller.name ?? brand.legalName, bin: seller.bin ?? brand.bin, address: seller.address ?? brand.address },
      buyer: { name: i.buyer.name, code: i.buyer.code, address: i.buyer.address, phone: i.buyer.phone },
      lines: lines.map(l => ({ trackingId: l.trackingId ?? "", description: l.description ?? "Delivery service", amount: num(l.amount), taxableValue: l.taxableValue == null ? undefined : num(l.taxableValue), vat: l.vat == null ? undefined : num(l.vat) })),
      createdBy: i.createdBy?.name ?? null,
    };
    const pdf = new PdfWriter({ size: A4, title: `Tax invoice ${i.number}`, bufferPages: true });
    return { fileName: `delivery-fast-invoice-${safeName(i.number)}.pdf`, stream: this.finish(pdf, () => drawFinanceInvoice(pdf, brand, doc, docMeta)) };
  }

  /** A franchise commission invoice (the caller loads and authorises it: modules/franchise). */
  async franchiseInvoice(actor: Actor, i: FranchiseInvoiceDoc & { id: string }, meta: RequestMeta): Promise<PdfFile> {
    const brand = await this.brand();
    await this.record(actor, "franchise_invoice", { number: i.number }, meta, i.id, "franchise_invoice");
    const docMeta = this.meta(actor, "Franchise commission invoice", { number: i.number, date: i.createdAt, subtitle: `${i.franchise.name} · ${i.status.toLowerCase()}` });
    const pdf = new PdfWriter({ size: A4, title: `Franchise invoice ${i.number}`, bufferPages: true });
    return { fileName: `delivery-fast-franchise-invoice-${safeName(i.number)}.pdf`, stream: this.finish(pdf, () => drawFranchiseInvoice(pdf, brand, i, docMeta)) };
  }

  async settlement(actor: Actor, id: string, meta: RequestMeta): Promise<PdfFile> {
    const s = await this.settlements.detail(actor, id);
    const brand = await this.brand();
    await this.record(actor, "settlement_statement", { number: s.number }, meta, s.id, "settlement");
    const docMeta = this.meta(actor, "COD settlement statement", { number: s.number, subtitle: `${s.merchant.name} · ${String(s.status).toLowerCase()}` });
    const v = s as unknown as Record<string, unknown>;
    const doc = {
      number: s.number,
      status: String(s.status),
      merchant: { name: s.merchant.name, code: s.merchant.code },
      autoDrafted: !!v.autoDrafted,
      createdBy: s.createdBy?.name ?? null,
      approvedBy: s.approvedBy?.name ?? null,
      createdAt: (v.createdAt as Date) ?? new Date(),
      paidAt: (v.paidAt as Date | null) ?? null,
      reference: (v.reference as string | null) ?? null,
      payTo: payToOf(v.payoutAccount),
      paymentProof: !!v.paymentProof,
      lines: s.lines.map(l => ({ trackingId: l.trackingId, deliveredAt: l.deliveredAt, codAmount: num(l.codAmount), charge: num(l.charge), net: num(l.net) })),
      adjustments: s.adjustments.map(a => ({ kind: a.kind, description: a.description, amount: num(a.amount) })),
      codTotal: num(v.codTotal),
      chargesTotal: num(v.chargesTotal),
      adjustmentsTotal: num(v.adjustmentsTotal),
      netPayable: num(v.netPayable),
      carriedForward: num(v.carriedForward),
      vat: { rate: s.vat.rate, onCharges: num(s.vat.onCharges) },
    };
    const pdf = new PdfWriter({ size: A4, title: `Settlement ${s.number}`, bufferPages: true });
    return { fileName: `delivery-fast-settlement-${safeName(s.number)}.pdf`, stream: this.finish(pdf, () => drawSettlement(pdf, brand, doc, docMeta)) };
  }

  /**
   * Merchant panels: delivered prepaid parcels not yet covered by a tax invoice (pro-forma),
   * optionally for a delivery period and one line (documents / parcels).
   */
  async statement(actor: Actor, query: z.infer<typeof statementQuerySchema>, meta: RequestMeta): Promise<PdfFile> {
    const merchants = financeMerchantScope(actor);
    if (!merchants || merchants.length !== 1) throw forbidden("Statements are for a merchant workspace");
    const merchant = await this.prisma.merchant.findUnique({ where: { id: merchants[0] }, select: { id: true, name: true, code: true, type: true } });
    if (!merchant) throw notFound("Merchant");
    const range = query.from || query.to ? dhakaDateRange(query.from ?? "2000-01-01", query.to ?? dhakaToday()) : null;
    const [parcels, invoiced] = await Promise.all([
      this.prisma.parcel.findMany({
        where: {
          merchantId: merchant.id,
          status: "DELIVERED",
          codAmount: 0,
          ...(range ? { deliveredAt: { gte: range[0], lt: range[1] } } : {}),
          ...(query.line === "document" ? { type: "DOCUMENT" as const } : query.line === "ecommerce" ? { type: { not: "DOCUMENT" as const } } : {}),
        },
        orderBy: { deliveredAt: "asc" },
        take: MAX_LIST_ROWS,
      }),
      invoicedParcels(this.prisma, [merchant.id]),
    ]);
    const open = parcels.filter(p => p.deliveredAt && !invoiced.has(p.trackingId));
    if (!open.length) throw new AppError("NOTHING_TO_PRINT", "No delivered prepaid parcels are waiting to be invoiced", 422);
    const brand = await this.brand();
    await this.record(actor, "merchant_statement", { merchant: merchant.code, from: query.from ?? null, to: query.to ?? null, parcels: open.length }, meta, merchant.id, "merchant");
    const document = merchant.type === "BANKING_FINANCIAL" || query.line === "document";
    const period = range ? `${query.from ?? "start"} to ${query.to ?? dhakaToday()}` : "Not yet invoiced";
    const docMeta = this.meta(actor, document ? "Unbilled delivery charges" : "Delivery charges statement", { number: merchant.code, subtitle: period });
    const doc = {
      merchant: { name: merchant.name, code: merchant.code },
      period,
      document,
      parcels: open.map(p => ({
        trackingId: p.trackingId,
        item: (p.type === "DOCUMENT" ? (p.documentType ?? p.contents) : (p.productName ?? p.contents)) ?? "—",
        branch: p.originBranchCode ?? undefined,
        reference: p.merchantOrderRef ?? undefined,
        service: p.speedOption ? ((SPEED_LABEL as Record<string, string>)[p.speedOption] ?? p.speedOption) : SERVICE_LEVEL_LABEL[p.serviceLevel],
        base: num(p.baseCharge),
        extra: num(p.weightCharge) + num(p.serviceCharge),
        discount: num(p.discount),
        total: num(p.totalCharge),
        deliveredAt: p.deliveredAt,
      })),
    };
    const pdf = new PdfWriter({ size: document ? LANDSCAPE : A4, title: `${docMeta.title} ${merchant.code}`, bufferPages: true });
    return { fileName: `delivery-fast-statement-${safeName(merchant.code)}-${stamp()}.pdf`, stream: this.finish(pdf, () => drawStatement(pdf, brand, doc, docMeta)), count: open.length };
  }

  // ───────────── reports ─────────────

  async report(actor: Actor, runId: string, meta: RequestMeta): Promise<PdfFile> {
    const run = await this.reports.getRun(actor, runId);
    const rows = parseCsv(run.csv ?? "").filter(r => r.some(c => c !== ""));
    const [head = [], ...body] = rows;
    const hub = run.hubId ? await this.prisma.hub.findUnique({ where: { id: run.hubId }, select: { name: true } }) : null;
    const titles: Record<string, string> = { DELIVERIES: "Delivery summary", SLA: "SLA attainment by zone", COD: "COD by rider", RIDERS: "Rider performance" };
    const title = titles[run.kind] ?? "Report";
    const from = new Date(run.periodStart.getTime() + 6 * 3600_000).toISOString().slice(0, 10);
    const to = new Date(run.periodEnd.getTime() - 1 + 6 * 3600_000).toISOString().slice(0, 10);
    const brand = await this.brand();
    await this.record(actor, "report", { kind: run.kind, rows: body.length }, meta, run.id, "report_run");
    const docMeta = this.meta(actor, title, { number: `${from} to ${to}`, date: run.createdAt, subtitle: hub?.name ?? "Whole network" });
    const pdf = new PdfWriter({ size: head.length > 7 ? LANDSCAPE : A4, title: `${title} ${from} to ${to}`, bufferPages: true });
    const doc = { intro: [["Period", `${from} to ${to}`], ["Hub", hub?.name ?? "Whole network"], ["Rows", String(body.length)], ["Run", run.schedule?.name ?? "On demand"]] as [string, string][], sections: [{ header: head, rows: body }] };
    return { fileName: `delivery-fast-${run.kind.toLowerCase()}-${from}-to-${to}.pdf`, stream: this.finish(pdf, () => drawTableDoc(pdf, brand, doc, docMeta)) };
  }

  async slaReport(actor: Actor, query: z.infer<typeof slaReportQuerySchema>, meta: RequestMeta): Promise<PdfFile> {
    const r = await this.sla.report(actor, query);
    const hub = query.hubId ? await this.prisma.hub.findUnique({ where: { id: query.hubId }, select: { name: true } }) : null;
    const brand = await this.brand();
    await this.record(actor, "sla_report", { from: query.from, to: query.to, hubId: query.hubId ?? null }, meta);
    const pct = (v: number | null | undefined) => (v == null ? "—" : `${v}%`);
    const docMeta = this.meta(actor, "SLA report", { number: `${r.from} to ${r.to}`, subtitle: hub?.name ?? "Your hubs / whole network" });
    const doc = {
      intro: [
        ["Pickups on time", `${r.pickups.onTime} of ${r.pickups.total} (${pct(r.pickups.rate)})`],
        ["Deliveries on time", `${r.deliveries.onTime} of ${r.deliveries.total} (${pct(r.deliveries.rate)})`],
        ["Pickup alerts", `${r.alerts.pickupAtRisk} at risk · ${r.alerts.pickupBreached} breached`],
        ["Delivery alerts", `${r.alerts.deliveryAtRisk} at risk · ${r.alerts.deliveryBreached} breached`],
      ] as [string, string][],
      sections: [
        { title: "By service level", header: ["Service level", "Delivered", "On time", "On-time %", "Avg. late (min)"], rows: r.byServiceLevel.map(l => [l.label, String(l.total), String(l.onTime), pct(l.rate), l.avgLateMinutes == null ? "—" : String(l.avgLateMinutes)]) },
        { title: "By hub", header: ["Hub", "Delivered", "On time", "On-time %"], rows: r.byHub.map(h => [h.hub?.name ?? "No hub", String(h.total), String(h.onTime), pct(h.rate)]) },
        { title: "By zone (top 100)", header: ["Zone", "District", "Delivered", "On time", "Late", "On-time %"], rows: r.byZone.map(z => [z.zone, z.district, String(z.total), String(z.onTime), String(z.late), pct(z.rate)]) },
        { title: "By day", header: ["Day", "Delivered", "On time", "On-time %"], rows: r.byDay.map(d => [d.day, String(d.total), String(d.onTime), pct(d.rate)]) },
      ],
    };
    const pdf = new PdfWriter({ size: A4, title: `SLA report ${r.from} to ${r.to}`, bufferPages: true });
    return { fileName: `delivery-fast-sla-${r.from}-to-${r.to}.pdf`, stream: this.finish(pdf, () => drawTableDoc(pdf, brand, doc, docMeta)) };
  }

  /** End-of-day hub reconciliation (the same figures as GET /ops/hub-reconciliation), with signature lines. */
  async hubReconciliation(actor: Actor, query: HubReconciliationQuery, meta: RequestMeta): Promise<PdfFile> {
    const r = await this.reconciliation.report(actor, query);
    const brand = await this.brand();
    await this.record(actor, "hub_reconciliation", { hubId: r.hub.id, date: r.date }, meta, r.hub.id, "hub");
    const n = (v: number) => String(v);
    const tk = (v: string) => `৳${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const p = r.parcels;
    const sections: { title?: string; header: string[]; rows: string[][] }[] = [
      {
        title: "Parcels",
        header: ["Item", "Parcels"],
        rows: [
          ["Arrivals expected (received + still expected)", n(p.expected)],
          ["Received at the hub", n(p.received)],
          ["Still expected: in inbound bags", n(p.expectedParts.inboundBags)],
          ["Still expected: drop-offs booked here", n(p.expectedParts.dropOffs)],
          ["Still expected: picked up by our riders", n(p.expectedParts.pickedUpByRiders)],
          ["Dispatched out", n(p.dispatched)],
          ["  Out for delivery with our riders", n(p.outForDelivery)],
          [`  Transferred in bags (${p.transferBags} bag${p.transferBags === 1 ? "" : "s"})`, n(p.transferred)],
          ["Delivered by our riders", n(p.delivered)],
          [r.isToday ? "Held at the hub now" : "Held at the hub (at printing)", n(p.heldNow)],
          [r.isToday ? "Ready for collection now" : "Ready for collection (at printing)", n(p.readyForCollection)],
        ],
      },
    ];
    if (r.cash) {
      const c = r.cash;
      sections.push(
        {
          title: "Cash on delivery",
          header: ["Item", "Count", "Amount"],
          rows: [
            ["COD collected (riders + counter)", n(c.collections), tk(c.collected)],
            ["  of which at the hub counter", n(c.counterCollections), tk(c.collectedAtCounter)],
            ["Cash handovers received", n(c.handovers), tk(c.handedOver)],
            ["Collected that day, not handed over", n(c.outstandingFromDayCollections), tk(c.outstandingFromDay)],
            ["Still with riders (any day)", n(c.outstandingCollections), tk(c.outstanding)],
          ],
        },
        { title: "By rider", header: ["Rider", "Collected", "Handed over", "Still with rider"], rows: c.perRider.map(x => [`${x.rider.code} · ${x.rider.name}`, tk(x.collected), tk(x.handedOver), tk(x.withRider)]) },
      );
    }
    const doc = {
      intro: [
        ["Hub", `${r.hub.name} (${r.hub.code})`],
        ["Day", r.date],
        ["Received / expected", `${p.received} of ${p.expected}`],
        ...(r.cash ? ([["Cash handed over / collected", `${tk(r.cash.handedOver)} of ${tk(r.cash.collected)}`]] as [string, string][]) : []),
      ] as [string, string][],
      sections,
    };
    const docMeta = this.meta(actor, "End-of-day hub reconciliation", { number: r.date, subtitle: r.hub.name });
    const pdf = new PdfWriter({ size: A4, title: `Hub reconciliation ${r.hub.code} ${r.date}`, bufferPages: true });
    return { fileName: `delivery-fast-hub-reconciliation-${r.hub.code.toLowerCase()}-${r.date}.pdf`, stream: this.finish(pdf, () => drawTableDoc(pdf, brand, doc, docMeta)) };
  }
}
