import { HttpStatus, Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { z } from "zod";
import { PARCEL_STATUS_LABEL, SERVICE_LEVEL_LABEL, type ParcelStatus } from "@delivery-fast/shared";
import { PrismaService } from "../../common/prisma.service";
import { AuditService, withAuditContext } from "../../common/audit.service";
import { QueueService } from "../../common/queues";
import { RealtimeService } from "../../common/realtime.service";
import { PermissionService } from "../../common/auth/permissions.service";
import { AppError, forbidden, notFound } from "../../common/errors";
import { pageArgs, toPage } from "../../common/pagination";
import { dhakaDateCode, nextCounter } from "../../common/counters";
import { userActor, type Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { runsJobs } from "../../config/env";
import { Prisma, type BulkUpdateJob, type BulkUpdateRow, type BulkUpdateRowStatus } from "../../generated/prisma/client";
import { ParcelsService } from "../parcels/parcels.service";
import { IntakeChangeService } from "../parcels/intake-change.service";
import { CompleteDetailsService } from "../parcels/complete-details.service";
import { opsHubScope } from "../parcels/ops-scope";
import { describeMissing, type MissingField } from "../parcels/incomplete";
import { PricingService } from "../pricing/pricing.service";
import { RoutingService } from "../routing/routing.service";
import { ImportJobsService } from "../imports/import-jobs.service";
import { ImportConfigService } from "../imports/import-config.service";
import { writeCsv } from "../imports/csv";
import { codeVariants } from "../ops/ops-common";
import { ACTION_LABEL, BULK_COLUMNS, headerOf, matchBulkHeaders, type BulkAction, type BulkColumn, type BulkColumnKey } from "./bulk-columns";
import { ACTIONS, columnsOf, inputKeys, isActionId, type ActionTemplate, type BulkActionId } from "./bulk-actions";
import { canUse, isKind, jobTitle, KINDS, kindsFor, kindWhere, statusLabels, type BulkKind } from "./bulk-kinds";
import { BulkPlanner, PARCEL_RELATIONS, riderLabel, statusLabelOf, type BulkPlan, type BulkRowCells, type CheckedRow, type PlannerParcel, type Problem } from "./bulk-planner";
import { buildBulkWorkbook, DATA_SHEETS, type BulkCells, type BulkLists } from "./bulk-workbook";
import type { bulkActionsQuerySchema, bulkExportQuerySchema, bulkListQuerySchema, bulkRowsQuerySchema } from "./bulk-updates.schemas";

const QUEUE = "bulk-updates";
/** Files with at most this many rows to apply are applied during the request; larger ones in the background. */
export const BULK_INLINE_ROWS = 100;
/** Rows read per round of the apply job (each row is still its own transaction). */
const CHUNK = 50;
/** A PROCESSING job not updated for this long is considered abandoned (worker restart) and resumed. */
const STALE_MS = 5 * 60_000;
const VALIDATED_TTL_MS = 24 * 3600_000;
const ROWS_RETENTION_DAYS = 90;
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

type StoredActor = { kind: "user"; userId: string; name: string };
const STATUS_FILTER: Record<string, BulkUpdateRowStatus[] | undefined> = {
  all: undefined,
  apply: ["READY", "WARNING"],
  warning: ["WARNING"],
  error: ["ERROR"],
  applied: ["APPLIED"],
  already_done: ["ALREADY_DONE"],
  failed: ["FAILED"],
  not_applied: ["ERROR", "FAILED"],
};
const SLA_LABEL = { ON_TRACK: "On track", AT_RISK: "At risk", BREACHED: "Breached" } as const;
const INTAKE_LABEL = { PICKUP: "Rider pickup", DROP_OFF: "Drop-off" } as const;
const PRE_PICKUP: ParcelStatus[] = ["PENDING_CONFIRMATION", "PICKUP_ASSIGNED", "PICKUP_CONFIRMED"];
const TERMINAL: ParcelStatus[] = ["DELIVERED", "PICKUP_CANCELLED", "RETURNED"];
const MISSING_LABEL_SHORT: Record<string, string> = { recipientName: "Recipient name", recipientPhone: "Recipient phone", address: "Address", district: "District", zone: "Zone" };

/** "2026-10-16 14:05" in Dhaka time. */
const dhaka = (d: Date | null | undefined) => (d ? new Date(d.getTime() + 6 * 3600_000).toISOString().slice(0, 16).replace("T", " ") : "");
const joinAddress = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(", ");
const kindOf = (job: Pick<BulkUpdateJob, "kind">): BulkKind => (isKind(job.kind) ? job.kind : "all");
const actionOf = (job: Pick<BulkUpdateJob, "action">): BulkActionId | null => (job.action && isActionId(job.action) ? job.action : null);
/** Columns of a bulk update from before action templates (multi-action file with an Action column), for its preview. */
const LEGACY_COLUMNS: { key: string; header: string; editable: boolean }[] = [
  { key: "tracking_id", header: "Tracking ID", editable: false },
  { key: "status", header: "Current status", editable: false },
  { key: "action", header: "Action", editable: true },
  { key: "rider", header: "Rider", editable: true },
  { key: "new_status", header: "New status", editable: true },
  { key: "hub", header: "Hub", editable: true },
  { key: "note", header: "Reason / note", editable: true },
];
/** Every column of every action template (header row detection on upload: each template's own headers and aliases). */
const ALL_COLUMNS: BulkColumn[] = [...BULK_COLUMNS, ...Object.values(ACTIONS).flatMap(t => columnsOf(t).filter(c => c.editable))];
const outdated = () =>
  new AppError(
    "BULK_TEMPLATE_OUTDATED",
    "This file was downloaded before bulk updates became one file per action. Choose the action in the bulk update dialog, download a fresh file for it and fill that in.",
    422,
  );
const messageOf = (error: unknown) => (error instanceof AppError ? (error.getResponse() as { message: string }).message : null);
/** Does the row change something the price depends on (destination, weight, service, first mile)? */
const repricedBy = (r: CheckedRow) =>
  r.action === "TO_DROP_OFF" ||
  r.action === "TO_PICKUP" ||
  ((r.action === "COMPLETE_DETAILS" || r.action === "ASSIGN_DELIVERY") &&
    !!r.plan?.details &&
    (r.plan.details.delivery?.district !== undefined || r.plan.details.delivery?.zone !== undefined || r.plan.details.delivery?.area !== undefined || r.plan.details.weightKg !== undefined || r.plan.details.serviceLevel !== undefined));

/**
 * Bulk operations by Excel (Courier Operations): download the filtered parcels as an .xlsx with
 * action columns, fill it in, upload → dry run (every row checked; nothing changes) → paginated
 * preview → apply. Each row is applied through the normal parcel services in its own transaction
 * (lifecycle, optimistic locking, notifications, webhooks, realtime, audit with the bulk update's
 * number); large files in the background with progress events. Shares the spreadsheet engine
 * (xlsx writer/reader, limits, parse slots) with imports.
 */
@Injectable()
export class BulkUpdatesService implements OnApplicationBootstrap {
  private readonly logger = new Logger("BulkUpdates");

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queues: QueueService,
    private readonly realtime: RealtimeService,
    private readonly permissions: PermissionService,
    private readonly imports: ImportJobsService,
    private readonly importConfig: ImportConfigService,
    private readonly parcels: ParcelsService,
    private readonly intake: IntakeChangeService,
    private readonly details: CompleteDetailsService,
    private readonly pricing: PricingService,
    private readonly routing: RoutingService,
  ) {}

  // ───────────── background worker ─────────────

  onApplicationBootstrap() {
    if (!runsJobs()) return;
    void this.startWorker().catch(err => this.logger.error({ err }, "Could not start the bulk update worker"));
  }

  private async queueReady() {
    await (this.queues as unknown as { ready?: Promise<void> }).ready;
    if (!(await this.queues.boss.getQueue(QUEUE))) await this.queues.boss.createQueue(QUEUE, { name: QUEUE, retryLimit: 3, retryDelay: 30, expireInSeconds: 3600 });
  }

  private async startWorker() {
    await this.queueReady();
    await this.queues.boss.work<{ id: string }>(QUEUE, { batchSize: 1, pollingIntervalSeconds: 2 }, async jobs => {
      for (const job of jobs) await this.process(job.data.id);
    });
    await this.queues.schedule("bulk-updates-cleanup", "27 3 * * *", async () => void (await this.cleanup()));
  }

  /** Discards checked files nobody applied and purges the rows of old finished bulk updates. */
  async cleanup(now = new Date()) {
    const stale = await this.prisma.bulkUpdateJob.findMany({ where: { status: "VALIDATED", createdAt: { lt: new Date(now.getTime() - VALIDATED_TTL_MS) } }, select: { id: true } });
    for (const { id } of stale) {
      await this.prisma.bulkUpdateRow.deleteMany({ where: { jobId: id } });
      await this.prisma.bulkUpdateJob.update({ where: { id }, data: { status: "DISCARDED", rowsPurgedAt: now } });
    }
    const old = await this.prisma.bulkUpdateJob.findMany({
      where: { status: { in: ["COMPLETED", "FAILED"] }, rowsPurgedAt: null, completedAt: { lt: new Date(now.getTime() - ROWS_RETENTION_DAYS * 86_400_000) } },
      select: { id: true },
    });
    for (const { id } of old) {
      // Applied rows keep their dedupe keys out of the way of later uploads only while the rows are kept.
      await this.prisma.bulkUpdateRow.deleteMany({ where: { jobId: id } });
      await this.prisma.bulkUpdateJob.update({ where: { id }, data: { rowsPurgedAt: now } });
    }
    return { discarded: stale.length, purged: old.length };
  }

  // ───────────── scope and limits ─────────────

  private staff(actor: Actor) {
    if (actor.kind !== "user" || !actor.permissions.has("parcel:dispatch") || !actor.permissions.has("parcel:read:any")) throw forbidden("Bulk updates are for operations staff");
    return actor;
  }

  /**
   * The parcels this person may work on: the whole network, or for hub operators the parcels held
   * at, heading to or to be dropped off at their hubs, those with their hubs' riders, and pickup
   * requests in zones their hubs serve.
   */
  private async scopeWhere(actor: Actor): Promise<Prisma.ParcelWhereInput> {
    const scope = opsHubScope(actor);
    if (!scope) return {};
    const zones = await this.prisma.deliveryZone.findMany({ where: { hubId: { in: scope }, active: true }, select: { district: true, name: true } });
    return {
      OR: [
        { currentHubId: { in: scope } },
        { dropOffHubId: { in: scope } },
        { pickupRider: { hubId: { in: scope } } },
        { deliveryRider: { hubId: { in: scope } } },
        ...(zones.length
          ? [
              {
                status: "PENDING_CONFIRMATION" as const,
                intake: "PICKUP" as const,
                OR: zones.map(z => ({ pickupDistrict: { equals: z.district, mode: "insensitive" as const }, pickupZone: { equals: z.name, mode: "insensitive" as const } })),
              },
            ]
          : []),
      ],
    };
  }

  /** The pages the caller may use: each page's actions (id, label, one line), statuses and quick filters. */
  kinds(actor: Actor) {
    const user = this.staff(actor);
    return kindsFor(user.permissions).map(def => ({
      kind: def.kind,
      page: def.page,
      title: def.title,
      scope: def.scope,
      actions: def.actions.map(id => ({ action: id, label: ACTIONS[id].label, summary: ACTIONS[id].summary })),
      statuses: def.statuses.map((s, i) => ({ value: s, label: statusLabels(def.statuses)[i] })),
      presets: def.presets,
    }));
  }

  /** Refuses a page the caller has no action of. */
  private kindFor(actor: Actor, kind: BulkKind) {
    const user = this.staff(actor);
    const def = kindsFor(user.permissions).find(k => k.kind === kind);
    if (!def) throw forbidden(`You can't use the ${KINDS[kind].page} bulk update`);
    return def;
  }

  /** Refuses an action that isn't one of the page's (or that the caller can't perform). */
  private templateFor(actor: Actor, kind: BulkKind, action: BulkActionId): ActionTemplate {
    const def = this.kindFor(actor, kind);
    const t = ACTIONS[action];
    if (def.actions.includes(action)) return t;
    if (KINDS[kind].actions.includes(action) || !canUse(this.staff(actor).permissions, t)) throw forbidden(`You can't use "${t.label}" in bulk`);
    throw new AppError(
      "BULK_ACTION_NOT_ON_PAGE",
      `"${t.label}" isn't an action of the ${KINDS[kind].page} page. Choose one of ${def.actions.map(a => `"${ACTIONS[a].label}"`).join(", ")} (or use All parcels).`,
      422,
      { action, kind, actions: def.actions },
    );
  }

  /** The parcels of a page that can take an action, in the caller's scope and the dialog's filters. */
  private async actionWhere(actor: Actor, kind: BulkKind, t: ActionTemplate, query: z.infer<typeof bulkActionsQuerySchema>, scope?: Prisma.ParcelWhereInput): Promise<Prisma.ParcelWhereInput> {
    const page = kindWhere(kind);
    const eligible = t.where();
    return { AND: [scope ?? (await this.scopeWhere(actor)), ...(page ? [page] : []), ...(eligible ? [eligible] : []), ...this.filterWhere(query)] };
  }

  /**
   * The actions of a page (GET /bulk-updates/actions?kind=): label, one line, what to fill in, the
   * columns of its file and how many parcels can take it now (page, the dialog's filters, hub scope).
   */
  async actions(actor: Actor, query: z.infer<typeof bulkActionsQuerySchema>) {
    const def = this.kindFor(actor, query.kind);
    const scope = opsHubScope(actor);
    if (scope && query.hubId && !scope.includes(query.hubId)) throw forbidden("You can only see your own hubs' parcels");
    const scopeWhere = await this.scopeWhere(actor);
    return Promise.all(
      def.actions.map(async id => {
        const t = ACTIONS[id];
        const columns = columnsOf(t).filter(c => !c.hidden);
        return {
          action: id,
          label: t.label,
          title: jobTitle(query.kind, id),
          summary: t.summary,
          howTo: `${t.label}: ${t.howTo}`,
          does: t.does,
          parcels: t.parcels,
          skipBlank: t.skipBlank,
          fill: columns.filter(c => c.editable).map(c => c.header),
          columns: columns.map(c => ({ key: c.key, header: c.header, editable: c.editable, required: !!c.required })),
          ...(t.statuses ? { statuses: t.statuses.map((s, i) => ({ value: s, label: statusLabels(t.statuses!)[i] })) } : {}),
          count: await this.prisma.parcel.count({ where: await this.actionWhere(actor, query.kind, t, query, scopeWhere) }),
        };
      }),
    );
  }

  /** Same row and file limits as operations imports (super admin → Spreadsheet imports). */
  async limits(actor: Actor) {
    this.staff(actor);
    const settings = await this.importConfig.settings();
    const limits = this.imports.limitsFor(settings, true);
    return { ...limits, inlineRows: BULK_INLINE_ROWS };
  }

  // ───────────── export ─────────────

  private filterWhere(query: z.infer<typeof bulkActionsQuerySchema>): Prisma.ParcelWhereInput[] {
    const and: Prisma.ParcelWhereInput[] = [];
    if (query.preset === "pending_review") and.push({ status: "PENDING_CONFIRMATION", intake: "PICKUP" });
    if (query.preset === "at_hub_unassigned") and.push({ status: "AT_HUB", deliveryRiderId: null });
    if (query.preset === "needs_info") and.push({ incomplete: true });
    if (query.status?.length) and.push({ status: { in: query.status } });
    if (query.merchantId) and.push({ merchantId: query.merchantId });
    if (query.hubId) and.push({ OR: [{ currentHubId: query.hubId }, { dropOffHubId: query.hubId }] });
    if (query.dropOffHubId) and.push({ dropOffHubId: query.dropOffHubId });
    if (query.intake) and.push({ intake: query.intake });
    if (query.incomplete !== undefined) and.push({ incomplete: query.incomplete });
    if (query.from || query.to) and.push({ createdAt: { gte: query.from, lte: query.to } });
    if (query.sla === "AWAITING_REVIEW") and.push({ status: "PENDING_CONFIRMATION", intake: "PICKUP" });
    else if (query.sla) and.push({ slaState: query.sla, status: { notIn: TERMINAL } });
    if (query.line === "customer") and.push({ merchantId: null });
    if (query.line === "ecommerce") and.push({ merchant: { type: "ECOMMERCE" } });
    if (query.line === "document") and.push({ merchant: { type: "BANKING_FINANCIAL" } });
    const q = query.q?.trim();
    if (q)
      and.push({
        OR: [
          { trackingId: { contains: q, mode: "insensitive" } },
          { merchantOrderRef: { contains: q, mode: "insensitive" } },
          { recipientName: { contains: q, mode: "insensitive" } },
          { senderName: { contains: q, mode: "insensitive" } },
          { recipientPhone: { contains: q.replace(/\D/g, "").slice(-10) || q } },
        ],
      });
    return and;
  }

  private async filterText(query: z.infer<typeof bulkExportQuerySchema>) {
    const parts: string[] = [`${ACTIONS[query.action].label} on ${KINDS[query.kind].page}`];
    if (query.preset === "pending_review") parts.push("pending operations confirmation (awaiting review)");
    if (query.preset === "at_hub_unassigned") parts.push("at a hub without a delivery rider");
    if (query.preset === "needs_info") parts.push("needs info");
    if (query.status?.length) parts.push(`status ${query.status.map(s => PARCEL_STATUS_LABEL[s as ParcelStatus]).join(" / ")}`);
    if (query.merchantId) parts.push(`merchant ${(await this.prisma.merchant.findUnique({ where: { id: query.merchantId }, select: { name: true } }))?.name ?? "?"}`);
    if (query.hubId) parts.push(`hub ${(await this.prisma.hub.findUnique({ where: { id: query.hubId }, select: { name: true } }))?.name ?? "?"}`);
    if (query.intake) parts.push(INTAKE_LABEL[query.intake]);
    if (query.incomplete) parts.push("needs info");
    if (query.sla) parts.push(`SLA ${query.sla === "AWAITING_REVIEW" ? "awaiting review" : SLA_LABEL[query.sla].toLowerCase()}`);
    if (query.line) parts.push({ ecommerce: "e-commerce", document: "documents", customer: "customer parcels" }[query.line]);
    if (query.from || query.to) parts.push(`created ${query.from ? dhaka(query.from).slice(0, 10) : "…"} to ${query.to ? dhaka(query.to).slice(0, 10) : "…"}`);
    if (query.q) parts.push(`search "${query.q}"`);
    return parts.join(", ");
  }

  /** Hubs and riders for the dropdowns: the caller's hubs and riders (hub operators), else the network. */
  private async lists(actor: Actor): Promise<BulkLists> {
    const scope = opsHubScope(actor);
    const [hubs, riders, catalog] = await Promise.all([
      this.prisma.hub.findMany({ where: { active: true, ...(scope ? { id: { in: scope } } : {}) }, orderBy: { name: "asc" }, select: { id: true, name: true, code: true } }),
      this.prisma.rider.findMany({
        where: { active: true, user: { status: "ACTIVE" }, ...(scope ? { hubId: { in: scope } } : {}) },
        orderBy: { code: "asc" },
        include: { user: { select: { name: true } }, hub: { select: { id: true, name: true } } },
      }),
      this.pricing.catalog(),
    ]);
    const dupNames = new Set(hubs.filter((h, i) => hubs.findIndex(x => x.name.toLowerCase() === h.name.toLowerCase()) !== i).map(h => h.name.toLowerCase()));
    const hubLabel = (h: { name: string; code: string }) => (dupNames.has(h.name.toLowerCase()) ? `${h.name} (${h.code})` : h.name);
    const label = (r: (typeof riders)[number]) => `${riderLabel(r)} · ${r.hub?.name ?? "no hub"}`;
    return {
      hubs: hubs.map(h => ({ label: hubLabel(h), riders: riders.filter(r => r.hubId === h.id).map(label) })),
      riders: riders.map(label),
      districts: catalog.districts,
      zonesByDistrict: catalog.zonesByDistrict,
      areasByZone: catalog.areasByZone,
    };
  }

  /** The .xlsx of the filtered parcels (at most the operations row limit) with the action columns. */
  async export(actor: Actor, query: z.infer<typeof bulkExportQuerySchema>, meta: RequestMeta) {
    const t = this.templateFor(actor, query.kind, query.action);
    const settings = await this.importConfig.settings();
    const limits = this.imports.limitsFor(settings, true);
    const scope = opsHubScope(actor);
    if (scope && query.hubId && !scope.includes(query.hubId)) throw forbidden("You can only download your own hubs' parcels");
    const where = await this.actionWhere(actor, query.kind, t, query);
    const [matched, parcels] = await Promise.all([
      this.prisma.parcel.count({ where }),
      this.prisma.parcel.findMany({
        where,
        include: {
          ...PARCEL_RELATIONS,
          pickupRider: { include: { user: { select: { name: true } }, hub: { select: { name: true } } } },
          deliveryRider: { include: { user: { select: { name: true } }, hub: { select: { name: true } } } },
          merchant: { select: { code: true, name: true } },
          cnStock: { select: { cn: true } },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: limits.maxRows,
      }),
    ]);
    const suggests = t.lead.includes("suggested_rider");
    const [lists, suggested, filterText] = await Promise.all([this.lists(actor), suggests ? this.routing.suggestFor(actor, parcels) : { suggestions: [] }, this.filterText(query)]);
    const suggestion = new Map(suggested.suggestions.map(s => [s.trackingId, s]));
    const riderHub = (r: { hub: { name: string } | null } | null) => (r?.hub ? ` · ${r.hub.name}` : "");
    const rows = parcels.map(p => {
      const status = p.status as ParcelStatus;
      const s = suggests ? suggestion.get(p.trackingId) : undefined;
      const awaitingReview = status === "PENDING_CONFIRMATION" && p.intake === "PICKUP";
      const cells: BulkCells = {
        tracking_id: p.trackingId,
        cn: p.cnStock?.cn ?? "",
        merchant: p.merchant ? `${p.merchant.code} · ${p.merchant.name}` : `Website · ${p.senderName}`,
        sender: `${p.senderName} · ${joinAddress(p.pickupStreet, p.pickupArea, p.pickupZone, p.pickupDistrict)}`,
        recipient_name: p.recipientName ?? "",
        recipient_phone: p.recipientPhone ?? "",
        recipient_address: joinAddress(p.deliveryStreet, p.deliveryArea),
        district: p.deliveryDistrict ?? "",
        zone: p.deliveryZone ?? "",
        intake: INTAKE_LABEL[p.intake],
        drop_off_hub: p.dropOffHub?.name ?? "",
        status: statusLabelOf(p),
        pickup_rider: p.pickupRider ? `${riderLabel(p.pickupRider)}${riderHub(p.pickupRider)}` : "",
        delivery_rider: p.deliveryRider ? `${riderLabel(p.deliveryRider)}${riderHub(p.deliveryRider)}` : "",
        current_hub: p.currentHub?.name ?? "",
        cod: Number(p.codAmount),
        weight: Number(p.weightKg),
        service: SERVICE_LEVEL_LABEL[p.serviceLevel],
        created: dhaka(p.createdAt),
        sla_due: dhaka(PRE_PICKUP.includes(status) ? (p.pickupDueAt ?? p.deliveryDueAt) : p.deliveryDueAt),
        sla_state: TERMINAL.includes(status) ? "—" : awaitingReview ? "Awaiting review" : status === "PENDING_CONFIRMATION" ? "Awaiting drop-off" : SLA_LABEL[p.slaState],
        missing: p.missingFields.map(f => MISSING_LABEL_SHORT[f] ?? f).join(", "),
        suggested_rider: s ? lists.riders.find(r => r.startsWith(`${s.rider.code} ·`)) ?? s.rider.label : "",
        version: p.version,
      };
      return { cells };
    });
    const buffer = buildBulkWorkbook({ kind: query.kind, action: t.id, rows, lists, maxRows: limits.maxRows, maxFileMb: limits.maxFileMb, filterText, matched });
    await this.audit.record(actor, { action: "bulk_update.export", entityType: "bulk_update", data: { kind: query.kind, action: t.id, rows: rows.length, matched, filter: filterText } }, meta);
    const stamp = dhaka(new Date()).replace(/[-: ]/g, "").slice(0, 12);
    const prefix = `delivery-fast-${query.kind === "all" ? "all-parcels" : query.kind.replace(/_/g, "-")}-${t.id.replace(/_/g, "-")}`;
    return { buffer, fileName: `${prefix}-${stamp}.xlsx`, count: rows.length, matched, maxRows: limits.maxRows };
  }

  // ───────────── validate (dry run) ─────────────

  /** Finds the header row and reads every row (cells by column key) plus the file's template values. */
  private sheetRows(rows: string[][]) {
    let headerIndex = -1;
    let match: ReturnType<typeof matchBulkHeaders> | null = null;
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      const m = matchBulkHeaders(rows[i] ?? [], ALL_COLUMNS);
      if (m.map.includes("tracking_id")) {
        headerIndex = i;
        match = m;
        break;
      }
    }
    if (!match) throw new AppError("TEMPLATE_MISMATCH", "We couldn't find the header row with Tracking ID. Download the file for the action and keep the first row as it is.", 422);
    const result: { rowNumber: number; cells: BulkRowCells }[] = [];
    const templates = new Set<string>();
    const header = rows[headerIndex] ?? [];
    for (let i = headerIndex + 1; i < rows.length; i++) {
      const raw = rows[i] ?? [];
      const cells: BulkRowCells = {};
      match.map.forEach((key, c) => {
        const v = String(raw[c] ?? "").trim();
        if (key && v) cells[key] = v;
      });
      if (!Object.keys(cells).length) continue; // an empty row is skipped
      if (cells.template) templates.add(cells.template.trim().toLowerCase());
      result.push({ rowNumber: i + 1, cells });
    }
    const present = new Map<BulkColumnKey, string>();
    match.map.forEach((key, c) => {
      if (key && !present.has(key)) present.set(key, String(header[c] ?? "").trim());
    });
    return { rows: result, unknownColumns: match.unknown, present, templates, legacyAction: match.legacyAction };
  }

  /**
   * The page and action a file was downloaded for (its hidden `template` column, "<kind>:<action>")
   * against the page and action it is uploaded with: another action's file is refused, and another
   * page's file unless uploaded on All parcels. A file without a template takes the chosen action; a
   * multi-action file from before action templates is refused politely (BULK_TEMPLATE_OUTDATED).
   */
  private fileTemplate(parsed: { templates: Set<string>; legacyAction: boolean }, pageKind: BulkKind, pageAction?: BulkActionId): { kind: BulkKind; action: BulkActionId } {
    const values = [...parsed.templates];
    if (values.length > 1) {
      const names = values.map(v => {
        const [k, a] = v.split(":");
        return a && isActionId(a) && isKind(k) ? jobTitle(k, a) : v;
      });
      throw new AppError("BULK_KIND_MIXED", `This file mixes rows of different files (${names.join(" and ")}). Upload each action's rows in its own file.`, 422, { templates: values });
    }
    const value = values[0];
    if (!value) {
      if (parsed.legacyAction) throw outdated();
      if (!pageAction) throw new AppError("VALIDATION_FAILED", "Choose the action this file is for.", 422);
      return { kind: pageKind, action: pageAction };
    }
    const [kindText, actionText] = value.split(":");
    if (!isKind(kindText)) throw new AppError("TEMPLATE_MISMATCH", `The template column says "${value}", which isn't a bulk update file. Download the file again and keep the hidden columns as they are.`, 422);
    if (!actionText) throw outdated();
    if (!isActionId(actionText)) throw new AppError("TEMPLATE_MISMATCH", `The template column says "${value}", which isn't a bulk update action. Download the file again and keep the hidden columns as they are.`, 422);
    const fileKind: BulkKind = kindText;
    const fileAction: BulkActionId = actionText;
    const fileLabel = ACTIONS[fileAction].label;
    if (pageKind !== "all" && fileKind !== pageKind) {
      const file = KINDS[fileKind].page;
      const page = KINDS[pageKind].page;
      throw new AppError(
        "BULK_KIND_MISMATCH",
        `This is the "${fileLabel}" file of ${file}. Upload it on the ${fileKind === "all" ? "All parcels page" : `${file} page (or All parcels)`}, or download a ${page} file here and fill that in.`,
        422,
        { fileKind, pageKind, fileAction },
      );
    }
    if (pageAction && fileAction !== pageAction)
      throw new AppError(
        "BULK_ACTION_MISMATCH",
        `This is the "${fileLabel}" file. Choose "${fileLabel}" to upload it, or download the "${ACTIONS[pageAction].label}" file and fill that in.`,
        422,
        { fileAction, pageAction, fileKind },
      );
    return { kind: fileKind, action: fileAction };
  }

  /** Loads what the rows refer to and checks every row (the same rules as the apply step). */
  private async check(actor: Actor, rows: { rowNumber: number; cells: BulkRowCells }[], t: ActionTemplate): Promise<CheckedRow[]> {
    const typed = [...new Set(rows.map(r => r.cells.tracking_id?.trim().toUpperCase()).filter((v): v is string => !!v))];
    const variants = new Map(typed.map(t => [t, codeVariants(t)]));
    const found: PlannerParcel[] = [];
    const all = [...new Set([...variants.values()].flat())];
    for (let i = 0; i < all.length; i += 5000) found.push(...(await this.prisma.parcel.findMany({ where: { trackingId: { in: all.slice(i, i + 5000) } }, include: PARCEL_RELATIONS })));
    const byId = new Map(found.map(p => [p.trackingId, p]));
    const parcels = new Map<string, PlannerParcel>();
    for (const [t, vs] of variants) {
      const hit = vs.map(v => byId.get(v)).find(Boolean);
      if (hit) parcels.set(t, hit);
    }
    const scopeWhere = await this.scopeWhere(actor);
    const ids = found.map(p => p.id);
    const inScope = new Set<string>();
    for (let i = 0; i < ids.length; i += 5000)
      for (const p of await this.prisma.parcel.findMany({ where: { AND: [{ id: { in: ids.slice(i, i + 5000) } }, scopeWhere] }, select: { id: true } })) inScope.add(p.id);
    const codes = [...new Set(rows.flatMap(r => [r.cells.rider, r.cells.suggested_rider]).filter((v): v is string => !!v?.trim()).map(v => v.split("·")[0].trim().toUpperCase()))];
    const [riders, hubs, catalog] = await Promise.all([
      codes.length
        ? this.prisma.rider.findMany({
            where: { code: { in: codes, mode: "insensitive" } },
            include: {
              user: { select: { name: true, status: true } },
              hub: { select: { id: true, name: true } },
              _count: { select: { deliveries: { where: { status: { in: ["ASSIGNED", "OUT_FOR_DELIVERY", "RETRY_SCHEDULED", "EXCEPTION"] } } }, pickups: { where: { status: { in: ["PICKUP_ASSIGNED", "PICKUP_CONFIRMED"] } } } } },
            },
          })
        : [],
      this.prisma.hub.findMany({ select: { id: true, name: true, code: true, active: true } }),
      this.pricing.catalog(),
    ]);
    const planner = new BulkPlanner({
      parcels,
      inScope,
      riders: riders.map(r => ({ ...r, load: r._count.deliveries + r._count.pickups })),
      hubs,
      catalog,
      scope: opsHubScope(actor),
    });
    const checked = rows.map(r => planner.check(r.rowNumber, r.cells, t));
    await this.previewPrices(checked, new Map(found.map(p => [p.id, p])));
    return checked;
  }

  /**
   * Rows that re-price the parcel (Complete details / Assign delivery with Set … columns that change
   * the destination, weight or service; Change to drop-off / rider pickup) get its charge before →
   * after in `plan.price`, from the same engine and frozen package as the single actions. A change
   * the package refuses (SERVICE_NOT_IN_PACKAGE…) makes the row an error.
   */
  private async previewPrices(rows: CheckedRow[], parcels: Map<string, PlannerParcel>) {
    const priced = rows.filter(r => (r.status === "READY" || r.status === "WARNING") && r.plan && r.parcelId && repricedBy(r));
    for (let i = 0; i < priced.length; i += 10)
      await Promise.all(
        priced.slice(i, i + 10).map(async row => {
          const plan = row.plan!;
          const parcel = parcels.get(row.parcelId!)!;
          try {
            const { before, after } =
              row.action === "TO_DROP_OFF" || row.action === "TO_PICKUP"
                ? await this.intake.previewCharge(parcel, row.action === "TO_DROP_OFF" ? plan.hubId! : null)
                : await this.details.previewCharge(parcel, plan.details!);
            plan.price = { before, after, difference: Math.round((after - before) * 100) / 100 };
          } catch (error) {
            const message = messageOf(error);
            if (!message) {
              this.logger.warn({ err: error, trackingId: row.trackingId }, "Could not preview the new price");
              return;
            }
            row.errors.push({ column: plan.details?.serviceLevel ? "set_service" : "status", message });
            row.status = "ERROR";
          }
        }),
      );
  }

  /** Re-pricing totals of the rows that will apply (or were applied): their charges before and after. */
  private async pricingTotals(job: BulkUpdateJob) {
    if (job.rowsPurgedAt) return null;
    const [r] = await this.prisma.$queryRaw<{ rows: number; before: Prisma.Decimal | null; after: Prisma.Decimal | null }[]>`
      SELECT count(*)::int AS rows, sum((plan->'price'->>'before')::numeric) AS before, sum((plan->'price'->>'after')::numeric) AS after
      FROM bulk_update_rows
      WHERE "jobId" = ${job.id}::uuid AND status IN ('READY', 'WARNING', 'APPLIED') AND plan->'price' IS NOT NULL`;
    if (!r?.rows) return { rows: 0, before: 0, after: 0, difference: 0 };
    const before = Number(r.before ?? 0);
    const after = Number(r.after ?? 0);
    return { rows: r.rows, before, after, difference: Math.round((after - before) * 100) / 100 };
  }

  async validateUpload(actor: Actor, file: { buffer: Buffer; fileName: string }, meta: RequestMeta, pageKind: BulkKind = "all", pageAction?: BulkActionId) {
    const user = this.staff(actor);
    this.kindFor(actor, pageKind);
    if (pageAction) this.templateFor(actor, pageKind, pageAction);
    const settings = await this.importConfig.settings();
    const limits = this.imports.limitsFor(settings, true);
    if (file.buffer.length > limits.maxBytes) throw new AppError("FILE_TOO_LARGE", `Files can be at most ${limits.maxFileMb} MB. Split it into smaller files.`, 413, { maxFileMb: limits.maxFileMb });
    const fileName = (file.fileName || "upload").slice(0, 200);
    const started = Date.now();
    const parsed = await this.imports.withParseSlot(async () => this.sheetRows(this.imports.parseFile(file.buffer, fileName, limits.maxRows, undefined, DATA_SHEETS).rows));
    const { kind, action } = this.fileTemplate(parsed, pageKind, pageAction);
    const t = this.templateFor(actor, kind, action);
    // Only the template's columns are read; any other known column is reported as ignored.
    const keys = new Set(columnsOf(t).map(c => c.key));
    const ignoredColumns = [...parsed.unknownColumns, ...[...parsed.present].filter(([key]) => !keys.has(key)).map(([, header]) => header)];
    const inputs = inputKeys(t);
    let ignored = 0;
    const rows = parsed.rows.flatMap(r => {
      const cells: BulkRowCells = {};
      for (const [k, v] of Object.entries(r.cells) as [BulkColumnKey, string][]) if (keys.has(k)) cells[k] = v;
      // A template that needs input skips the rows where nothing was filled in.
      if (t.skipBlank && !inputs.some(k => cells[k]?.trim())) {
        ignored++;
        return [];
      }
      return [{ rowNumber: r.rowNumber, cells }];
    });
    if (!rows.length) {
      const fill = columnsOf(t)
        .filter(c => c.editable && c.key !== "priority")
        .map(c => c.header.replace(/\s*\*$/, ""));
      throw new AppError(
        "NO_ACTIONS",
        ignored
          ? `None of the ${ignored.toLocaleString("en-US")} rows has ${fill.length > 1 ? `any of ${fill.join(", ")}` : fill[0]} filled in. Fill it in for the parcels to change ("${t.label}").`
          : "The file has no parcels below the header row.",
        422,
      );
    }
    const results = await this.check(actor, rows, t);
    const counts = { READY: 0, WARNING: 0, ERROR: 0, ALREADY_DONE: 0 };
    for (const r of results) counts[r.status]++;
    const stored: StoredActor = { kind: "user", userId: user.userId, name: user.name };
    const job = await this.prisma.$transaction(
      async tx => {
        const day = dhakaDateCode();
        const number = `BLK-${day}-${String(await nextCounter(tx, `bulk-update:${day}`)).padStart(3, "0")}`;
        const created = await tx.bulkUpdateJob.create({
          data: {
            number,
            kind,
            action,
            fileName,
            fileSha256: createHash("sha256").update(file.buffer).digest("hex"),
            fileBytes: file.buffer.length,
            totalRows: results.length,
            ignoredRows: ignored,
            readyRows: counts.READY,
            warningRows: counts.WARNING,
            errorRows: counts.ERROR,
            skippedRows: counts.ALREADY_DONE,
            actor: stored,
            createdById: user.userId,
          },
        });
        for (let i = 0; i < results.length; i += 1000)
          await tx.bulkUpdateRow.createMany({
            data: results.slice(i, i + 1000).map(r => ({
              jobId: created.id,
              rowNumber: r.rowNumber,
              status: r.status,
              action: r.action,
              trackingId: r.trackingId,
              parcelId: r.parcelId,
              expectedVersion: r.expectedVersion,
              priority: r.priority,
              cells: r.cells as Prisma.InputJsonObject,
              plan: r.plan ? (r.plan as unknown as Prisma.InputJsonObject) : Prisma.DbNull,
              errors: r.errors.length ? (r.errors as unknown as Prisma.InputJsonArray) : Prisma.DbNull,
              warnings: r.warnings.length ? (r.warnings as unknown as Prisma.InputJsonArray) : Prisma.DbNull,
              result: r.result,
              dedupeKey: r.dedupeKey,
            })),
          });
        await this.audit.record(
          actor,
          {
            action: "bulk_update.validate",
            entityType: "bulk_update",
            entityId: created.id,
            data: { number, kind, action, fileName, rows: results.length, ignored, ready: counts.READY, warnings: counts.WARNING, errors: counts.ERROR, alreadyDone: counts.ALREADY_DONE },
          },
          meta,
          tx,
        );
        return created;
      },
      { timeout: 60_000 },
    );
    this.logger.log(`Checked ${job.number} (${kind}:${action}): ${results.length} rows in ${Date.now() - started} ms`);
    return { ...(await this.view(job, ignoredColumns)), rows: await this.rowsPage(job, { filter: "all", page: 1, pageSize: 50 }) };
  }

  // ───────────── reading ─────────────

  private async load(actor: Actor, id: string) {
    this.staff(actor);
    const job = await this.prisma.bulkUpdateJob.findUnique({ where: { id } });
    if (!job || !this.canSee(actor, job)) throw notFound("Bulk update");
    return job;
  }

  /** The uploader; operations managers and super admins (whole network) see everyone's. */
  private canSee(actor: Actor, job: BulkUpdateJob) {
    return (actor.kind === "user" && job.createdById === actor.userId) || opsHubScope(actor) === null;
  }

  async view(job: BulkUpdateJob, ignoredColumns: string[] = []) {
    const createdBy = job.createdById ? await this.prisma.user.findUnique({ where: { id: job.createdById }, select: { name: true } }) : null;
    const toApply = job.readyRows + job.warningRows;
    const pricing = await this.pricingTotals(job);
    const kind = kindOf(job);
    const action = actionOf(job);
    return {
      id: job.id,
      number: job.number,
      kind,
      /** "New orders bulk update". */
      kindTitle: KINDS[kind].title,
      page: KINDS[kind].page,
      /** The action template (null: a multi-action file from before 2026-10-18). */
      action,
      actionLabel: action ? ACTIONS[action].label : "Several actions",
      /** "Accept & assign pickup rider · New orders". */
      title: action ? jobTitle(kind, action) : KINDS[kind].title,
      status: job.status,
      fileName: job.fileName,
      createdBy: createdBy?.name ?? (job.actor as StoredActor).name,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      error: job.error,
      counts: { rows: job.totalRows, ignored: job.ignoredRows, ready: job.readyRows, warnings: job.warningRows, errors: job.errorRows, alreadyDone: job.skippedRows, toApply },
      progress: { processed: job.processedRows, total: toApply, percent: toApply ? Math.floor((job.processedRows / toApply) * 100) : 100 },
      result: {
        applied: job.appliedCount,
        alreadyDone: job.alreadyDoneCount + job.skippedRows,
        failed: job.failedCount,
        notApplied: job.errorRows + job.failedCount,
        skipped: job.alreadyDoneCount + job.skippedRows,
      },
      columns: action
        ? columnsOf(ACTIONS[action])
            .filter(c => !c.hidden)
            .map(c => ({ key: c.key as string, header: c.header, editable: c.editable }))
        : LEGACY_COLUMNS,
      ignoredColumns,
      /** Rows that re-price their parcel: how many, the charges before and after, and the difference (null once the rows are purged). */
      pricing,
      rowsAvailable: !job.rowsPurgedAt,
      downloads: { failedRows: action && job.errorRows + job.failedCount > 0 && !job.rowsPurgedAt ? `/api/v1/bulk-updates/${job.id}/failed-rows` : null },
    };
  }

  async get(actor: Actor, id: string) {
    return this.view(await this.load(actor, id));
  }

  private async rowsPage(job: BulkUpdateJob, query: z.infer<typeof bulkRowsQuerySchema>) {
    const where: Prisma.BulkUpdateRowWhereInput = { jobId: job.id, ...(STATUS_FILTER[query.filter] ? { status: { in: STATUS_FILTER[query.filter] } } : {}) };
    const [total, rows] = await Promise.all([
      this.prisma.bulkUpdateRow.count({ where }),
      this.prisma.bulkUpdateRow.findMany({ where, orderBy: { rowNumber: "asc" }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    ]);
    const action = actionOf(job);
    const columns = action ? columnsOf(ACTIONS[action]) : BULK_COLUMNS;
    const describe = (r: BulkUpdateRow, list: Problem[]) =>
      list.map(e => {
        const header = headerOf(e.column, columns).replace(/\s*\*$/, "");
        return { ...e, header, text: `Row ${r.rowNumber} · ${header}: ${e.message}` };
      });
    return {
      filter: query.filter,
      page: query.page,
      pageSize: query.pageSize,
      total,
      pages: Math.max(1, Math.ceil(total / query.pageSize)),
      items: rows.map(r => ({
        rowNumber: r.rowNumber,
        status: r.status,
        action: r.action,
        actionLabel: action ? ACTIONS[action].label : String((r.cells as Record<string, unknown>).action ?? "") || (r.action ? ACTION_LABEL[r.action as BulkAction] : null),
        trackingId: r.trackingId,
        cells: r.cells,
        errors: describe(r, (r.errors as Problem[] | null) ?? []),
        warnings: describe(r, (r.warnings as Problem[] | null) ?? []),
        result: r.result,
        plan: r.plan,
      })),
    };
  }

  async rows(actor: Actor, id: string, query: z.infer<typeof bulkRowsQuerySchema>) {
    const job = await this.load(actor, id);
    if (job.rowsPurgedAt) throw new AppError("ROWS_PURGED", "The rows of this bulk update are no longer kept", HttpStatus.GONE);
    return this.rowsPage(job, query);
  }

  async list(actor: Actor, query: z.infer<typeof bulkListQuerySchema>) {
    const user = this.staff(actor);
    const everyone = opsHubScope(actor) === null && !query.mine;
    const rows = await this.prisma.bulkUpdateJob.findMany({
      where: { status: { not: "DISCARDED" }, ...(everyone ? {} : { createdById: user.userId }), ...(query.kind ? { kind: query.kind } : {}), ...(query.action ? { action: query.action } : {}) },
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { items: await Promise.all(page.items.map(j => this.view(j))), nextCursor: page.nextCursor };
  }

  /** Rows not applied, in the download's format with an Error column: fix and upload again. */
  async failedRows(actor: Actor, id: string, format: "xlsx" | "csv") {
    const job = await this.load(actor, id);
    if (job.rowsPurgedAt) throw new AppError("ROWS_PURGED", "The rows of this bulk update are no longer kept", HttpStatus.GONE);
    const action = actionOf(job);
    if (!action) throw outdated();
    const rows = await this.prisma.bulkUpdateRow.findMany({ where: { jobId: job.id, status: { in: ["ERROR", "FAILED"] } }, orderBy: { rowNumber: "asc" } });
    const kind = kindOf(job);
    const columns = columnsOf(ACTIONS[action]);
    const failed = rows.map(r => ({
      cells: r.cells as BulkCells,
      error: `Row ${r.rowNumber}: ${((r.errors as Problem[] | null) ?? []).map(e => `${headerOf(e.column, columns).replace(/\s*\*$/, "")}: ${e.message}`).join("; ")}`,
    }));
    const template = `${kind}:${action}`;
    const base = `${job.number}-not-applied`;
    if (format === "csv") {
      const csv = writeCsv([[...columns.map(c => c.header), "Error"], ...failed.map(f => [...columns.map(c => c.key === "template" ? template : (f.cells[c.key] ?? "")), f.error])]);
      return { buffer: Buffer.from(csv, "utf8"), fileName: `${base}.csv`, contentType: "text/csv; charset=utf-8" };
    }
    const settings = await this.importConfig.settings();
    const limits = this.imports.limitsFor(settings, true);
    return { buffer: buildBulkWorkbook({ kind, action, rows: failed, lists: await this.lists(actor), maxRows: limits.maxRows, maxFileMb: limits.maxFileMb, failed: true }), fileName: `${base}.xlsx`, contentType: XLSX };
  }

  async discard(actor: Actor, id: string, meta: RequestMeta) {
    const job = await this.load(actor, id);
    if (job.status !== "VALIDATED") throw new AppError("BULK_UPDATE_SUBMITTED", `Bulk update ${job.number} was already applied`, HttpStatus.CONFLICT);
    await this.prisma.$transaction(async tx => {
      await tx.bulkUpdateRow.deleteMany({ where: { jobId: job.id } });
      await tx.bulkUpdateJob.update({ where: { id: job.id }, data: { status: "DISCARDED", rowsPurgedAt: new Date() } });
      await this.audit.record(actor, { action: "bulk_update.discard", entityType: "bulk_update", entityId: job.id, data: { number: job.number } }, meta, tx);
    });
  }

  // ───────────── apply ─────────────

  /** Applies the rows that passed the check: up to 100 during the request, larger files in the background. */
  async apply(actor: Actor, id: string, meta: RequestMeta, pageKind: BulkKind = "all", pageAction?: BulkActionId) {
    const job = await this.load(actor, id);
    if (actor.kind === "user" && job.createdById !== actor.userId) throw forbidden("Only the person who uploaded this file can apply it");
    const jobAction = actionOf(job);
    const title = jobAction ? jobTitle(kindOf(job), jobAction) : KINDS[kindOf(job)].title;
    if (pageKind !== "all" && kindOf(job) !== pageKind)
      throw new AppError("BULK_KIND_MISMATCH", `${job.number} is "${title}". Apply it on the ${KINDS[kindOf(job)].page} page (or All parcels).`, 422, { fileKind: job.kind, pageKind });
    if (pageAction && jobAction !== pageAction) throw new AppError("BULK_ACTION_MISMATCH", `${job.number} is "${title}", not "${ACTIONS[pageAction].label}".`, 422, { fileAction: job.action, pageAction });
    if (job.status !== "VALIDATED") throw new AppError("BULK_UPDATE_SUBMITTED", `Bulk update ${job.number} was already applied`, HttpStatus.CONFLICT, { status: job.status });
    const toApply = job.readyRows + job.warningRows;
    if (!toApply) throw new AppError("NOTHING_TO_APPLY", "No row can be applied. Fix the errors and upload the file again.", 422);
    const running = await this.prisma.bulkUpdateJob.count({ where: { createdById: job.createdById, status: { in: ["QUEUED", "PROCESSING"] } } });
    if (running) throw new AppError("BULK_UPDATE_IN_PROGRESS", "Another bulk update of yours is still running. Wait for it to finish, then apply this file.", HttpStatus.TOO_MANY_REQUESTS, { running, retryAfterSeconds: 30 });
    const queued = await this.prisma.$transaction(async tx => {
      const { count } = await tx.bulkUpdateJob.updateMany({ where: { id: job.id, status: "VALIDATED" }, data: { status: "QUEUED", queuedAt: new Date() } });
      if (!count) throw new AppError("BULK_UPDATE_SUBMITTED", `Bulk update ${job.number} was already applied`, HttpStatus.CONFLICT);
      await this.audit.record(actor, { action: "bulk_update.apply", entityType: "bulk_update", entityId: job.id, data: { number: job.number, rows: toApply } }, meta, tx);
      return tx.bulkUpdateJob.findUniqueOrThrow({ where: { id: job.id } });
    });
    if (toApply <= BULK_INLINE_ROWS) {
      await this.process(queued.id, { actor, meta });
      return { ...(await this.view(await this.prisma.bulkUpdateJob.findUniqueOrThrow({ where: { id: job.id } }))), background: false };
    }
    await this.queueReady();
    await this.queues.boss.send(QUEUE, { id: queued.id });
    return { ...(await this.view(queued)), background: true };
  }

  private async claim(id: string): Promise<boolean> {
    const stale = new Date(Date.now() - STALE_MS);
    const { count } = await this.prisma.bulkUpdateJob.updateMany({
      where: { id, OR: [{ status: "QUEUED" }, { status: "PROCESSING", updatedAt: { lt: stale } }] },
      data: { status: "PROCESSING", startedAt: new Date() },
    });
    return count > 0;
  }

  /** Re-creates the uploader as an actor, refusing if their access has gone since. */
  private async actorFor(job: BulkUpdateJob): Promise<Actor> {
    const stored = job.actor as StoredActor;
    const [user, grants] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: stored.userId }, select: { status: true, name: true } }),
      this.prisma.userRole.findMany({ where: { userId: stored.userId } }),
    ]);
    if (user?.status !== "ACTIVE") throw forbidden("The person who uploaded this file can no longer sign in");
    const roles = grants.map(g => ({ role: g.role, merchantId: g.merchantId, hubId: g.hubId, customRoleId: g.customRoleId }));
    const actor = userActor({ userId: stored.userId, sessionId: `bulk-update:${job.id}`, name: user.name, roles, permissions: await this.permissions.resolve(roles) });
    if (!actor.permissions.has("parcel:dispatch")) throw forbidden("The person who uploaded this file can no longer dispatch parcels");
    return actor;
  }

  private progressEvent(job: BulkUpdateJob, type: "bulk_update.progress" | "bulk_update.completed") {
    const toApply = job.readyRows + job.warningRows;
    this.realtime.publish({
      type,
      id: job.id,
      userIds: [job.createdById],
      staffPermission: "config:manage",
      data: { number: job.number, status: job.status, processed: job.processedRows, total: toApply, applied: job.appliedCount, alreadyDone: job.alreadyDoneCount, failed: job.failedCount },
    });
  }

  /** Applies every row not handled yet, high priority first. Safe to run again: it resumes where it stopped. */
  async process(id: string, opts: { actor?: Actor; meta?: RequestMeta } = {}) {
    if (!(await this.claim(id))) return;
    let job = await this.prisma.bulkUpdateJob.findUniqueOrThrow({ where: { id } });
    const meta: RequestMeta = opts.meta ?? { ip: "", userAgent: "bulk-update-job", requestId: `bulk-update:${id}` };
    try {
      const actor = opts.actor ?? (await this.actorFor(job));
      for (;;) {
        const rows = await this.prisma.bulkUpdateRow.findMany({ where: { jobId: id, status: { in: ["READY", "WARNING"] } }, orderBy: [{ priority: "desc" }, { rowNumber: "asc" }], take: CHUNK });
        if (!rows.length) break;
        for (const row of rows) await this.applyRow(job, row, actor, meta);
        job = await this.prisma.bulkUpdateJob.findUniqueOrThrow({ where: { id } });
        this.progressEvent(job, "bulk_update.progress");
      }
      job = await this.prisma.$transaction(async tx => {
        const done = await tx.bulkUpdateJob.update({ where: { id }, data: { status: "COMPLETED", completedAt: new Date() } });
        await this.audit.record(
          "system",
          { action: "bulk_update.complete", entityType: "bulk_update", entityId: id, data: { number: done.number, applied: done.appliedCount, alreadyDone: done.alreadyDoneCount + done.skippedRows, failed: done.failedCount, errors: done.errorRows } },
          meta,
          tx,
        );
        return done;
      });
      this.progressEvent(job, "bulk_update.completed");
    } catch (error) {
      const message = error instanceof AppError ? messageOf(error)! : "The bulk update stopped unexpectedly. Upload the file again to finish it.";
      if (!(error instanceof AppError)) this.logger.error({ err: error, bulkUpdate: id }, "Bulk update failed");
      job = await this.prisma.bulkUpdateJob.update({ where: { id }, data: { status: "FAILED", completedAt: new Date(), error: message } });
      this.progressEvent(job, "bulk_update.completed");
    }
  }

  /**
   * One row through the parcel services (each opens its own transaction), with the bulk update's
   * number on every audit record they write. Rows already done are skipped, not repeated.
   */
  private async applyRow(job: BulkUpdateJob, row: BulkUpdateRow, actor: Actor, meta: RequestMeta) {
    const plan = (row.plan ?? {}) as BulkPlan;
    const action = row.action as BulkAction;
    const finish = (status: BulkUpdateRowStatus, data: { result?: string; errors?: Problem[] }) =>
      this.prisma.$transaction([
        this.prisma.bulkUpdateRow.update({ where: { id: row.id }, data: { status, result: data.result ?? null, ...(data.errors ? { errors: data.errors as unknown as Prisma.InputJsonArray } : {}) } }),
        this.prisma.bulkUpdateJob.update({
          where: { id: job.id },
          data: {
            processedRows: { increment: 1 },
            ...(status === "APPLIED" ? { appliedCount: { increment: 1 } } : status === "ALREADY_DONE" ? { alreadyDoneCount: { increment: 1 } } : { failedCount: { increment: 1 } }),
          },
        }),
      ]);
    try {
      // The same change applied by an earlier upload of this file (same parcel, version and request).
      const earlier = row.dedupeKey
        ? await this.prisma.bulkUpdateRow.findFirst({ where: { dedupeKey: row.dedupeKey, status: "APPLIED", id: { not: row.id } }, include: { job: { select: { number: true } } } })
        : null;
      if (earlier) return void (await finish("ALREADY_DONE", { result: `Already done: applied by ${earlier.job.number} (row ${earlier.rowNumber})` }));
      const parcel = row.parcelId ? await this.prisma.parcel.findUnique({ where: { id: row.parcelId }, include: PARCEL_RELATIONS }) : null;
      if (!parcel) return void (await finish("FAILED", { errors: [{ column: "tracking_id", message: "This parcel no longer exists" }] }));
      const done = BulkPlanner.doneMessage(action, parcel, plan);
      if (done) return void (await finish("ALREADY_DONE", { result: `Already done: ${done}` }));
      const result = await withAuditContext({ bulkUpdate: { id: job.id, number: job.number, row: row.rowNumber } }, () => this.run(actor, parcel, action, plan, row.expectedVersion ?? undefined, meta));
      await finish("APPLIED", { result });
    } catch (error) {
      const message = messageOf(error);
      if (!message) this.logger.error({ err: error, bulkUpdate: job.id, row: row.rowNumber }, "Bulk update row failed");
      const code = error instanceof AppError ? (error.getResponse() as { code?: string }).code : undefined;
      const column = code === "PARCEL_CHANGED" ? "version" : code === "RIDER_UNAVAILABLE" ? "rider" : code === "DROP_OFF_WRONG_HUB" || code === "HUB_INACTIVE" ? "hub" : "status";
      const text =
        code === "PARCEL_CHANGED" ? `${row.trackingId} changed since you downloaded it (someone else updated it). Download a fresh file for it` : (message ?? "Couldn't be applied; try this row again");
      await finish("FAILED", { errors: [{ column, message: text }] });
    }
  }

  /** Calls the service that the single action uses; returns what happened. */
  private async run(actor: Actor, p: PlannerParcel, action: BulkAction, plan: BulkPlan, expectedVersion: number | undefined, meta: RequestMeta): Promise<string> {
    const id = p.trackingId;
    const note = plan.note;
    const now = (v: { statusLabel: string }) => `Now "${v.statusLabel}"`;
    switch (action) {
      case "ACCEPT_PICKUP":
        return `${now(await this.parcels.assignPickup(actor, id, { riderId: plan.riderId!, note }, meta, { expectedVersion }))} · pickup by ${plan.riderLabel}`;
      case "ASSIGN_DELIVERY": {
        let version = expectedVersion;
        if (plan.details) {
          await this.details.complete(actor, id, { ...plan.details, note, expectedVersion } as Parameters<CompleteDetailsService["complete"]>[2], meta);
          version = undefined; // completing bumped the version; it was checked just now
        }
        return `${now(await this.parcels.assignDelivery(actor, id, { riderId: plan.riderId!, note }, meta, { expectedVersion: version }))} · delivery by ${plan.riderLabel}${plan.details ? " (details completed)" : ""}`;
      }
      case "SET_STATUS":
      case "RECEIVE_AT_HUB":
        return now(await this.parcels.setStatus(actor, id, { status: plan.status!, hubId: plan.hubId, note, expectedVersion }, meta));
      case "SCHEDULE_RETURN":
        return now(await this.parcels.setStatus(actor, id, { status: "RETURN_SCHEDULED", note, expectedVersion }, meta));
      case "CANCEL":
        return now(await this.parcels.cancel(actor, id, { reason: note }, meta, { expectedVersion }));
      case "TO_DROP_OFF":
        return `${now(await this.intake.change(actor, id, { intake: "DROP_OFF", dropOffHubId: plan.hubId, note, expectedVersion }, meta))}`;
      case "TO_PICKUP":
        return `${now(await this.intake.change(actor, id, { intake: "PICKUP", note, expectedVersion }, meta))} · rider pickup`;
      case "COMPLETE_DETAILS": {
        const v = await this.details.complete(actor, id, { ...plan.details, note, expectedVersion } as Parameters<CompleteDetailsService["complete"]>[2], meta);
        return v.incomplete ? `Details saved; still needs ${describeMissing(v.missingFields as MissingField[])}` : "Details completed";
      }
      case "ADD_NOTE":
        await this.parcels.addNote(actor, id, { note: note! }, meta);
        return "Note added";
    }
  }
}

