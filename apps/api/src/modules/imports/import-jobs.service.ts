import { HttpStatus, Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { QueueService } from "../../common/queues";
import { RealtimeService } from "../../common/realtime.service";
import { PermissionService } from "../../common/auth/permissions.service";
import { AppError, forbidden, notFound } from "../../common/errors";
import { pageArgs, toPage } from "../../common/pagination";
import { dhakaDateCode, nextCounter } from "../../common/counters";
import { merchantIdsOf, userActor, type Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { runsJobs } from "../../config/env";
import { Prisma, type ImportJob, type ImportRow, type ImportRowStatus, type ParcelChannel } from "../../generated/prisma/client";
import { ParcelsService, type BookingContext, type DropOffBooking } from "../parcels/parcels.service";
import { ParcelWorkflowService } from "../parcels/parcel-workflow.service";
import { opsHubScope } from "../parcels/ops-scope";
import { NotifyService } from "../notifications/notify.service";
import { OutboxService } from "../notifications/outbox.service";
import { readCsv, writeCsv } from "./csv";
import { columnsFor, kindKeyOf, KIND_ENUM, matchHeaders, type ColumnKey, type ImportKindKey } from "./columns";
import { ImportConfigService, type ImportSettings } from "./import-config.service";
import { ImportEngineService, type Cells, type EngineContext, type ImportServiceOptions, type RowResult } from "./import-engine.service";
import { PackagesService } from "../packages/packages.service";
import { FIRST_MILE_LABEL, LAST_MILE_LABEL, PARCEL_NOTIFICATIONS, resolveSelection } from "@delivery-fast/shared";
import { buildTemplate, DATA_SHEET } from "./import-templates";
import type { importOptionsSchema, listImportsQuerySchema, rowsQuerySchema } from "./imports.schemas";
import { readXlsx, type SheetData } from "./xlsx/xlsx-reader";

const QUEUE = "imports";
/** Rows booked per transaction. */
const CHUNK = 100;
/** Files with at most this many rows to book are booked during the request; larger ones in the background. */
export const INLINE_ROWS = 100;
/** A PROCESSING job not updated for this long is considered abandoned (worker restart) and resumed. */
const STALE_MS = 5 * 60_000;
/** Validated files nobody submitted are discarded after a day; finished imports keep their rows this long. */
const VALIDATED_TTL_MS = 24 * 3600_000;
const ROWS_RETENTION_DAYS = 90;
/** Queued + running imports across the platform before new submissions are refused. */
const QUEUE_DEPTH_PER_WORKER = 5;
/** Concurrent file parses per API instance (CPU-bound). */
const PARSE_SLOTS = 2;

type StoredActor = { kind: "api_key"; apiKeyId: string; name: string } | { kind: "user"; userId: string; name: string };
type Scope = { forOps: boolean; merchantId: string | null; source: ParcelChannel };
type Upload = { buffer: Buffer; fileName: string } | { rows: Record<string, string | number | boolean | null>[]; fileName?: string };

const STATUS_FILTER: Record<string, ImportRowStatus[] | undefined> = {
  all: undefined,
  valid: ["VALID"],
  incomplete: ["INCOMPLETE"],
  error: ["ERROR"],
  created: ["CREATED"],
  failed: ["FAILED"],
  not_created: ["ERROR", "FAILED"],
};

const describeErrors = (errors: { column: string; message: string }[], headerOf: (key: string) => string) => errors.map(e => `${headerOf(e.column)}: ${e.message}`).join("; ");

/**
 * The spreadsheet import engine for merchants (both panels and API keys with parcels:write) and
 * operations: templates, the dry run (validate → paginated preview), booking in the background in
 * chunks (each chunk one transaction, resumable and idempotent), progress events, history and the
 * failed-rows download. Every import is a booking batch (labels; expected vs received at the hub).
 */
@Injectable()
export class ImportJobsService implements OnApplicationBootstrap {
  private readonly logger = new Logger("Imports");
  private parsing = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: ImportEngineService,
    private readonly config: ImportConfigService,
    private readonly parcels: ParcelsService,
    private readonly workflow: ParcelWorkflowService,
    private readonly audit: AuditService,
    private readonly queues: QueueService,
    private readonly realtime: RealtimeService,
    private readonly permissions: PermissionService,
    private readonly notify: NotifyService,
    private readonly outbox: OutboxService,
    private readonly packages: PackagesService,
  ) {}

  // ───────────── background worker ─────────────

  onApplicationBootstrap() {
    if (!runsJobs()) return;
    void this.startWorkers().catch(err => this.logger.error({ err }, "Could not start the import workers"));
  }

  private async queueReady() {
    await (this.queues as unknown as { ready?: Promise<void> }).ready;
    if (!(await this.queues.boss.getQueue(QUEUE))) await this.queues.boss.createQueue(QUEUE, { name: QUEUE, retryLimit: 3, retryDelay: 30, expireInSeconds: 3600 });
  }

  private async startWorkers() {
    await this.queueReady();
    const settings = await this.config.settings();
    // One poller per allowed concurrent import on this instance; claim() enforces the platform-wide limit.
    for (let i = 0; i < settings.limits.globalConcurrent; i++)
      await this.queues.boss.work<{ id: string }>(QUEUE, { batchSize: 1, pollingIntervalSeconds: 2 }, async jobs => {
        for (const job of jobs) await this.process(job.data.id);
      });
    await this.queues.schedule("imports-cleanup", "17 3 * * *", async () => void (await this.cleanup()));
  }

  private async enqueue(id: string, startAfter?: Date) {
    await this.queueReady();
    await this.queues.boss.send(QUEUE, { id }, startAfter ? { startAfter } : {});
  }

  /** Discards validated files nobody submitted and purges the rows of old finished imports. */
  async cleanup(now = new Date()) {
    const stale = await this.prisma.importJob.findMany({ where: { status: "VALIDATED", createdAt: { lt: new Date(now.getTime() - VALIDATED_TTL_MS) } }, select: { id: true } });
    for (const { id } of stale) {
      await this.prisma.importRow.deleteMany({ where: { jobId: id } });
      await this.prisma.importJob.update({ where: { id }, data: { status: "DISCARDED", rowsPurgedAt: now } });
    }
    const old = await this.prisma.importJob.findMany({
      where: { status: { in: ["COMPLETED", "FAILED"] }, rowsPurgedAt: null, completedAt: { lt: new Date(now.getTime() - ROWS_RETENTION_DAYS * 86_400_000) } },
      select: { id: true },
    });
    for (const { id } of old) {
      await this.prisma.importRow.deleteMany({ where: { jobId: id } });
      await this.prisma.importJob.update({ where: { id }, data: { rowsPurgedAt: now } });
    }
    return { discarded: stale.length, purged: old.length };
  }

  // ───────────── who imports what ─────────────

  /** Merchant upload (members, API keys) or operations upload (parcel:dispatch). */
  private scopeFor(actor: Actor, merchantId?: string): Scope {
    if (actor.kind === "api_key") {
      if (merchantId && merchantId !== actor.merchantId) throw forbidden("This API key belongs to another merchant");
      if (!actor.permissions.has("parcel:create")) throw forbidden("This API key can't book parcels");
      return { forOps: false, merchantId: actor.merchantId, source: "MERCHANT_API" };
    }
    const mine = merchantIdsOf(actor);
    const staff = actor.permissions.has("parcel:dispatch");
    if (merchantId && mine.includes(merchantId) && actor.permissions.has("parcel:create")) return { forOps: false, merchantId, source: "MERCHANT_PORTAL" };
    if (staff) return { forOps: true, merchantId: merchantId ?? null, source: "OPERATIONS" };
    if (merchantId) throw forbidden("You're not a member of this merchant");
    if (!actor.permissions.has("parcel:create") || !mine.length) throw forbidden("Imports are for merchant accounts and operations");
    if (mine.length > 1) throw new AppError("MERCHANT_REQUIRED", "You belong to several merchants. Choose one with merchantId", HttpStatus.UNPROCESSABLE_ENTITY, { merchantIds: mine });
    return { forOps: false, merchantId: mine[0], source: "MERCHANT_PORTAL" };
  }

  /** The import, if this actor may see it (404 otherwise). */
  private async load(actor: Actor, id: string) {
    const job = await this.prisma.importJob.findUnique({ where: { id } });
    if (!job || !this.canSee(actor, job)) throw notFound("Import");
    return job;
  }

  private canSee(actor: Actor, job: ImportJob) {
    if (job.source !== "OPERATIONS" && job.merchantId && merchantIdsOf(actor).includes(job.merchantId)) return true;
    if (actor.kind === "user" && job.createdById === actor.userId) return true;
    return job.source === "OPERATIONS" && actor.permissions.has("parcel:read:any");
  }

  limitsFor(settings: ImportSettings, forOps: boolean) {
    return { maxRows: forOps ? settings.limits.opsMaxRows : settings.limits.merchantMaxRows, maxFileMb: settings.limits.maxFileMb, maxBytes: Math.round(settings.limits.maxFileMb * 1024 * 1024) };
  }

  /** What the upload screen tells people before they choose a file. */
  async limits(actor: Actor, merchantId?: string) {
    const scope = this.scopeFor(actor, merchantId);
    const settings = await this.config.settings();
    const limits = this.limitsFor(settings, scope.forOps);
    return { ...limits, inlineRows: INLINE_ROWS, perMerchantConcurrent: settings.limits.perMerchantConcurrent, forOps: scope.forOps };
  }

  // ───────────── templates ─────────────

  async template(actor: Actor, kind: ImportKindKey, query: { for?: "merchant" | "ops"; merchantId?: string }) {
    const scope = this.scopeFor(actor, query.merchantId);
    const forOps = scope.forOps && query.for !== "merchant";
    const settings = await this.config.settings();
    const ctx = await this.engine.context({ kind, forOps, settings, merchantId: scope.merchantId });
    const limits = this.limitsFor(settings, forOps);
    return {
      buffer: buildTemplate(ctx, { maxRows: limits.maxRows, maxFileMb: limits.maxFileMb }),
      fileName: `delivery-fast-${kind === "document" ? "document-consignments" : "ecommerce-orders"}-template.xlsx`,
    };
  }

  // ───────────── validate (dry run) ─────────────

  /** Runs a CPU-bound file parse in one of the instance's parse slots (imports and bulk updates share them). */
  async withParseSlot<T>(work: () => Promise<T>): Promise<T> {
    if (this.parsing >= PARSE_SLOTS) {
      const wait = new Promise<void>(resolve => this.waiting.push(resolve));
      const timeout = new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), 30_000));
      if ((await Promise.race([wait, timeout])) === "timeout") {
        throw new AppError("IMPORTS_BUSY", "Many files are being checked right now. Try again in a minute.", HttpStatus.TOO_MANY_REQUESTS, { retryAfterSeconds: 60 });
      }
    }
    this.parsing++;
    try {
      return await work();
    } finally {
      this.parsing--;
      this.waiting.shift()?.();
    }
  }

  /** .xlsx or .csv → text rows. Old binary .xls files are refused with a clear message. `prefer`: the data sheet's name. */
  parseFile(buffer: Buffer, fileName: string, maxRows: number, kind?: ImportKindKey, prefer?: string[]): SheetData {
    if (!buffer.length) throw new AppError("INVALID_FILE", "The file is empty.", 422);
    if (buffer.subarray(0, 4).toString("hex") === "d0cf11e0")
      throw new AppError("UNSUPPORTED_FILE", "Old Excel 97–2003 (.xls) files can't be read. Open it in Excel and save it as Excel Workbook (.xlsx).", 415);
    if (buffer.subarray(0, 2).toString() === "PK") return readXlsx(buffer, { maxRows, prefer: prefer ?? (kind ? [DATA_SHEET[kind]] : ["Orders", "Consignments"]) });
    if (/\.xlsx$/i.test(fileName)) throw new AppError("INVALID_FILE", "This file is not a valid .xlsx workbook.", 422);
    if (buffer.subarray(0, 1024).includes(0) && !(buffer[0] === 0xff && buffer[1] === 0xfe) && !(buffer[0] === 0xfe && buffer[1] === 0xff))
      throw new AppError("UNSUPPORTED_FILE", "Upload an Excel workbook (.xlsx) or a CSV file.", 415);
    return readCsv(buffer, { maxRows });
  }

  /** Header row (the first row naming at least two template columns, within the first 10 rows) and data rows as cells. */
  private sheetToRows(kind: ImportKindKey, sheet: SheetData) {
    let headerIndex = -1;
    let match: ReturnType<typeof matchHeaders> | null = null;
    for (let i = 0; i < Math.min(sheet.rows.length, 10); i++) {
      const m = matchHeaders(kind, sheet.rows[i] ?? []);
      if (m.map.filter(Boolean).length >= 2) {
        headerIndex = i;
        match = m;
        break;
      }
    }
    if (!match)
      throw new AppError(
        "TEMPLATE_MISMATCH",
        `We couldn't find the template's header row. Download the ${kind === "document" ? "document" : "e-commerce"} template and keep its first row.`,
        422,
      );
    const rows: { rowNumber: number; cells: Cells }[] = [];
    for (let i = headerIndex + 1; i < sheet.rows.length; i++) {
      const raw = sheet.rows[i] ?? [];
      const cells: Cells = {};
      match.map.forEach((key, c) => {
        const v = String(raw[c] ?? "").trim();
        if (key && v) cells[key] = v;
      });
      // A row with at least one non-empty cell (of any column) is a candidate.
      if (raw.some(v => String(v ?? "").trim())) rows.push({ rowNumber: i + 1, cells });
    }
    return { rows, ignoredColumns: match.unknown };
  }

  /** JSON rows (API): keys are template headers or column keys. */
  private objectsToRows(kind: ImportKindKey, objects: Record<string, string | number | boolean | null>[]) {
    const headers = [...new Set(objects.flatMap(o => Object.keys(o)))];
    const match = matchHeaders(kind, headers);
    const rows = objects.map((o, i) => {
      const cells: Cells = {};
      headers.forEach((h, c) => {
        const key = match.map[c];
        const v = o[h];
        if (key && v !== null && v !== undefined && String(v).trim()) cells[key] = String(v).trim();
      });
      return { rowNumber: i + 2, cells };
    });
    return { rows: rows.filter((_, i) => Object.values(objects[i]).some(v => v !== null && v !== undefined && String(v).trim())), ignoredColumns: match.unknown };
  }

  async validateUpload(actor: Actor, options: z.infer<typeof importOptionsSchema>, upload: Upload, meta: RequestMeta) {
    const scope = this.scopeFor(actor, options.merchantId);
    const settings = await this.config.settings();
    const limits = this.limitsFor(settings, scope.forOps);
    // Drop at hub: operations (intake DROP_OFF) or the import modal's first mile (the merchant's package must offer it).
    const dropping = options.intake === "DROP_OFF" || options.firstMile === "HUB_DROP";
    const hubId = options.dropHubId ?? options.dropOffHubId;
    if (hubId && !dropping) throw new AppError("VALIDATION_FAILED", "A rider pickup import has no drop-off hub", 422);
    if (options.intake === "PICKUP" && options.firstMile === "HUB_DROP") throw new AppError("VALIDATION_FAILED", "Choose either rider pickup or drop at hub", 422);
    // The package is checked first: a merchant without drop at hub hears that, not "choose a hub".
    if (scope.merchantId && options.firstMile === "HUB_DROP") await this.checkServices(scope.merchantId, { firstMile: "HUB_DROP", lastMile: options.lastMile, notifications: options.notifications });
    const dropOff = dropping ? await this.dropOffHub(actor, hubId) : null;
    const services: ImportServiceOptions = {
      firstMile: dropOff ? "HUB_DROP" : options.firstMile,
      dropHubId: dropOff?.hub.id,
      lastMile: options.lastMile,
      notifications: options.notifications,
    };
    if (scope.merchantId) await this.checkServices(scope.merchantId, services);
    if (scope.merchantId) {
      const merchant = await this.prisma.merchant.findUnique({ where: { id: scope.merchantId }, select: { status: true, type: true, name: true } });
      if (!merchant) throw notFound("Merchant");
      if (merchant.status !== "ACTIVE") throw forbidden("This merchant account is not active yet");
      const expected = options.kind === "document" ? "BANKING_FINANCIAL" : "ECOMMERCE";
      if (merchant.type !== expected)
        throw new AppError("WRONG_TEMPLATE", `${merchant.name} is ${merchant.type === "BANKING_FINANCIAL" ? "a document" : "an e-commerce"} merchant: use the ${merchant.type === "BANKING_FINANCIAL" ? "document" : "e-commerce"} template`, 422);
    }

    const started = Date.now();
    const fileName = (("fileName" in upload && upload.fileName) || options.fileName || "upload").slice(0, 200);
    const parsed = await this.withParseSlot(async () => {
      if ("buffer" in upload) {
        if (upload.buffer.length > limits.maxBytes)
          throw new AppError("FILE_TOO_LARGE", `Files can be at most ${limits.maxFileMb} MB. Split it into smaller files.`, 413, { maxFileMb: limits.maxFileMb });
        return this.sheetToRows(options.kind, this.parseFile(upload.buffer, fileName, limits.maxRows, options.kind));
      }
      if (upload.rows.length > limits.maxRows) throw new AppError("TOO_MANY_ROWS", `Send at most ${limits.maxRows.toLocaleString("en-US")} rows per import.`, 413, { maxRows: limits.maxRows });
      return this.objectsToRows(options.kind, upload.rows);
    });
    if (!parsed.rows.length) throw new AppError("EMPTY_FILE", "The file has no orders below the header row.", 422);
    const ctx = await this.engine.context({ kind: options.kind, forOps: scope.forOps, settings, merchantId: scope.merchantId, dropOffHubId: dropOff?.hub.id, services });
    const results = await this.engine.validate(ctx, parsed.rows);
    const parsedMs = Date.now() - started;

    const counts = { VALID: 0, INCOMPLETE: 0, ERROR: 0 };
    for (const r of results) counts[r.status]++;
    const stored: StoredActor = actor.kind === "api_key" ? { kind: "api_key", apiKeyId: actor.apiKeyId, name: actor.name } : { kind: "user", userId: actor.userId, name: actor.name };
    const fileSha256 = "buffer" in upload ? createHash("sha256").update(upload.buffer).digest("hex") : createHash("sha256").update(JSON.stringify(upload.rows)).digest("hex");
    const job = await this.prisma.$transaction(
      async tx => {
        const day = dhakaDateCode();
        const number = `IMP-${day}-${String(await nextCounter(tx, `booking-batch:${day}`)).padStart(3, "0")}`;
        const created = await tx.importJob.create({
          data: {
            number,
            kind: KIND_ENUM[options.kind],
            source: scope.source,
            merchantId: scope.merchantId,
            intake: dropOff ? "DROP_OFF" : "PICKUP",
            dropOffHubId: dropOff?.hub.id,
            fileName,
            fileSha256,
            fileBytes: "buffer" in upload ? upload.buffer.length : 0,
            totalRows: results.length,
            validRows: counts.VALID,
            incompleteRows: counts.INCOMPLETE,
            errorRows: counts.ERROR,
            settings: { ...settings, forOps: scope.forOps, ignoredColumns: parsed.ignoredColumns, services } as unknown as Prisma.InputJsonObject,
            actor: stored,
            createdById: actor.kind === "user" ? actor.userId : null,
          },
        });
        for (let i = 0; i < results.length; i += 1000)
          await tx.importRow.createMany({
            data: results.slice(i, i + 1000).map(r => ({
              jobId: created.id,
              rowNumber: r.rowNumber,
              status: r.status,
              cells: r.cells as Prisma.InputJsonObject,
              errors: r.errors.length ? (r.errors as unknown as Prisma.InputJsonArray) : Prisma.DbNull,
              missing: r.missing,
              merchantId: r.merchantId,
              dedupeKey: r.dedupeKey,
              charge: r.charge,
              priceLines: r.lines ? (r.lines as unknown as Prisma.InputJsonArray) : Prisma.DbNull,
            })),
          });
        await this.audit.record(
          actor,
          {
            action: "import.validate",
            entityType: "import",
            entityId: created.id,
            data: { number, kind: options.kind, fileName, rows: results.length, valid: counts.VALID, incomplete: counts.INCOMPLETE, errors: counts.ERROR, merchantId: scope.merchantId, intake: created.intake },
          },
          meta,
          tx,
        );
        return created;
      },
      { timeout: 60_000 },
    );
    this.logger.log(`Validated ${job.number}: ${results.length} rows in ${parsedMs} ms (${counts.VALID} valid, ${counts.INCOMPLETE} incomplete, ${counts.ERROR} errors)`);
    return { ...(await this.view(job)), rows: await this.rowsPage(job, { filter: "all", page: 1, pageSize: 50 }), timings: { validateMs: parsedMs } };
  }

  /** A merchant file's choices against its package (SERVICE_NOT_IN_PACKAGE before anything is parsed). */
  private async checkServices(merchantId: string, services: ImportServiceOptions) {
    const pkg = await this.packages.effective({ merchantId });
    const { problems } = resolveSelection(pkg.segment, pkg.services, { firstMile: services.firstMile, lastMile: services.lastMile, notifications: services.notifications });
    if (problems.length) throw this.packages.selectionError(problems);
  }

  /** The hub a drop-off import is brought to (hub operators: their own hub; merchants: any operating hub). */
  private async dropOffHub(actor: Actor, hubId: string | undefined): Promise<DropOffBooking> {
    const scope = actor.permissions.has("parcel:dispatch") ? opsHubScope(actor) : null;
    const id = hubId ?? (scope?.length === 1 ? scope[0] : undefined);
    if (!id) throw new AppError("HUB_REQUIRED", "Choose the hub the sender will bring the parcels to", 422);
    if (scope && !scope.includes(id)) throw forbidden("You can only book drop-offs at your own hub");
    const hub = await this.prisma.hub.findUnique({ where: { id }, select: { id: true, name: true, address: true, active: true } });
    if (!hub) throw notFound("Hub");
    if (!hub.active) throw new AppError("HUB_INACTIVE", `${hub.name} isn't operating`, 422);
    return { hub: { id: hub.id, name: hub.name, address: hub.address } };
  }

  // ───────────── reading ─────────────

  private headerOf(job: Pick<ImportJob, "kind">) {
    const cols = columnsFor(kindKeyOf(job.kind), true);
    return (key: string) => cols.find(c => c.key === key)?.header ?? (key === "row" ? "Row" : key);
  }

  async view(job: ImportJob) {
    const [merchant, hub, batch, createdBy] = await Promise.all([
      job.merchantId ? this.prisma.merchant.findUnique({ where: { id: job.merchantId }, select: { id: true, code: true, name: true } }) : null,
      job.dropOffHubId ? this.prisma.hub.findUnique({ where: { id: job.dropOffHubId }, select: { id: true, name: true } }) : null,
      job.bookingBatchId ? this.prisma.bookingBatch.findUnique({ where: { id: job.bookingBatchId }, select: { id: true, number: true } }) : null,
      job.createdById ? this.prisma.user.findUnique({ where: { id: job.createdById }, select: { name: true } }) : null,
    ]);
    const settings = job.settings as unknown as ImportSettings & { forOps?: boolean; ignoredColumns?: string[]; services?: ImportServiceOptions };
    const kind = kindKeyOf(job.kind);
    const forOps = settings.forOps ?? job.source === "OPERATIONS";
    const toBook = job.validRows + job.incompleteRows;
    // The price of every row that will be (or was) booked: the preview total.
    const totals = await this.prisma.importRow.aggregate({ where: { jobId: job.id, status: { in: ["VALID", "INCOMPLETE", "CREATED"] } }, _sum: { charge: true }, _count: { _all: true } });
    const services = settings.services ?? {};
    return {
      id: job.id,
      number: job.number,
      kind,
      status: job.status,
      source: job.source,
      merchant,
      intake: job.intake,
      dropOffHub: hub,
      batch,
      fileName: job.fileName,
      createdBy: createdBy?.name ?? (job.actor as StoredActor).name,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      error: job.error,
      counts: { rows: job.totalRows, valid: job.validRows, incomplete: job.incompleteRows, errors: job.errorRows },
      progress: { processed: job.processedRows, total: toBook, percent: toBook ? Math.floor((job.processedRows / toBook) * 100) : 100 },
      result: {
        created: job.createdCount,
        createdIncomplete: job.createdIncomplete,
        failed: job.failedCount,
        notCreated: job.status === "COMPLETED" ? job.totalRows - job.createdCount : job.errorRows + job.failedCount,
      },
      columns: columnsFor(kind, forOps).map(c => ({ key: c.key, header: c.header, required: !!settings.templates?.[kind]?.[c.key]?.required })),
      ignoredColumns: settings.ignoredColumns ?? [],
      /** The import modal's choices (service packages) and the total delivery charge of the rows to book. */
      services: {
        firstMile: services.firstMile ?? null,
        firstMileLabel: services.firstMile ? FIRST_MILE_LABEL[services.firstMile] : null,
        lastMile: services.lastMile ?? null,
        lastMileLabel: services.lastMile ? LAST_MILE_LABEL[services.lastMile] : null,
        notifications: services.notifications ?? null,
        notificationLabels: services.notifications ? PARCEL_NOTIFICATIONS.filter(n => services.notifications!.includes(n.code)).map(n => `${n.label} (${n.audience})`) : null,
      },
      totals: { rows: totals._count._all, charge: Number(totals._sum.charge ?? 0) },
      rowsAvailable: !job.rowsPurgedAt,
      downloads: {
        failedRows: job.errorRows + job.failedCount > 0 && !job.rowsPurgedAt ? `/api/v1/imports/${job.id}/failed-rows` : null,
      },
    };
  }

  async get(actor: Actor, id: string) {
    return this.view(await this.load(actor, id));
  }

  private async rowsPage(job: ImportJob, query: z.infer<typeof rowsQuerySchema>) {
    const where: Prisma.ImportRowWhereInput = { jobId: job.id, ...(STATUS_FILTER[query.filter] ? { status: { in: STATUS_FILTER[query.filter] } } : {}) };
    const [total, rows] = await Promise.all([
      this.prisma.importRow.count({ where }),
      this.prisma.importRow.findMany({ where, orderBy: { rowNumber: "asc" }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    ]);
    const headerOf = this.headerOf(job);
    // Products whose "Send SMS & email" switch is off: those rows are booked with no messages (the commit re-reads them).
    const silent = await this.prisma.parcelProduct.findMany({
      where: { segment: job.kind === "DOCUMENT" ? "BANKING_FINANCIAL" : "ECOMMERCE", sendMessages: false },
      select: { id: true, name: true },
    });
    const silentNames = new Set(silent.flatMap(p => [p.id, p.name.toLowerCase()]));
    const messagesOff = (cells: unknown) => {
      const product = String((cells as Record<string, unknown> | null)?.product_type ?? "").trim().toLowerCase();
      return !!product && silentNames.has(product);
    };
    return {
      filter: query.filter,
      page: query.page,
      pageSize: query.pageSize,
      total,
      pages: Math.max(1, Math.ceil(total / query.pageSize)),
      items: rows.map(r => {
        const errors = (r.errors as { column: string; message: string }[] | null) ?? [];
        return {
          rowNumber: r.rowNumber,
          status: r.status,
          cells: r.cells,
          errors: errors.map(e => ({ ...e, header: headerOf(e.column), text: `Row ${r.rowNumber} · ${headerOf(e.column)}: ${e.message}` })),
          missing: r.missing,
          charge: r.charge == null ? null : Number(r.charge),
          lines: (r.priceLines as { code: string; label: string; amount: number }[] | null) ?? null,
          trackingId: r.trackingId,
          /** The row's product has "Send SMS & email" off: no parcel messages for it, whatever the modal ticks. */
          messagesOff: messagesOff(r.cells),
          messagesNote: messagesOff(r.cells) ? "This product doesn't send messages" : null,
        };
      }),
    };
  }

  async rows(actor: Actor, id: string, query: z.infer<typeof rowsQuerySchema>) {
    const job = await this.load(actor, id);
    if (job.rowsPurgedAt) throw new AppError("ROWS_PURGED", "The rows of this import are no longer kept", HttpStatus.GONE);
    return this.rowsPage(job, query);
  }

  async list(actor: Actor, query: z.infer<typeof listImportsQuerySchema>) {
    const staff = actor.permissions.has("parcel:read:any");
    const mine = merchantIdsOf(actor);
    let where: Prisma.ImportJobWhereInput;
    if (query.merchantId && mine.includes(query.merchantId)) where = { merchantId: query.merchantId, source: { not: "OPERATIONS" } };
    else if (staff) where = { source: "OPERATIONS", ...(query.merchantId ? { merchantId: query.merchantId } : {}), ...(query.mine && actor.kind === "user" ? { createdById: actor.userId } : {}) };
    else if (mine.length) where = { merchantId: { in: query.merchantId ? [query.merchantId] : mine }, source: { not: "OPERATIONS" } };
    else throw forbidden("Imports are for merchant accounts and operations");
    if (query.merchantId && !mine.includes(query.merchantId) && !staff) throw forbidden("You're not a member of this merchant");
    const rows = await this.prisma.importJob.findMany({
      where: { ...where, status: { not: "DISCARDED" }, ...(query.kind ? { kind: KIND_ENUM[query.kind] } : {}) },
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { items: await Promise.all(page.items.map(j => this.view(j))), nextCursor: page.nextCursor };
  }

  /** Tracking IDs booked by the import (labels). */
  async trackingIds(actor: Actor, id: string) {
    const job = await this.load(actor, id);
    const parcels = await this.prisma.parcel.findMany({ where: { importJobId: job.id }, select: { trackingId: true }, orderBy: { id: "asc" }, take: 20_000 });
    return { trackingIds: parcels.map(p => p.trackingId) };
  }

  /** Rows not booked, in the template format with an extra Error column, to fix and upload again. */
  async failedRows(actor: Actor, id: string, format: "xlsx" | "csv") {
    const job = await this.load(actor, id);
    if (job.rowsPurgedAt) throw new AppError("ROWS_PURGED", "The rows of this import are no longer kept", HttpStatus.GONE);
    const rows = await this.prisma.importRow.findMany({ where: { jobId: job.id, status: { in: ["ERROR", "FAILED"] } }, orderBy: { rowNumber: "asc" } });
    const kind = kindKeyOf(job.kind);
    const settings = job.settings as unknown as ImportSettings & { forOps?: boolean };
    const forOps = settings.forOps ?? job.source === "OPERATIONS";
    const headerOf = this.headerOf(job);
    const failed = rows.map(r => ({
      cells: r.cells as Partial<Record<ColumnKey, string>>,
      error: `Row ${r.rowNumber}: ${describeErrors((r.errors as { column: string; message: string }[] | null) ?? [], headerOf)}`,
    }));
    const base = `${job.number}-not-created`;
    if (format === "csv") {
      const cols = columnsFor(kind, forOps);
      const csv = writeCsv([[...cols.map(c => c.header), "Error"], ...failed.map(f => [...cols.map(c => f.cells[c.key] ?? ""), f.error])]);
      return { buffer: Buffer.from(csv, "utf8"), fileName: `${base}.csv`, contentType: "text/csv; charset=utf-8" };
    }
    const live = await this.config.settings();
    const ctx = await this.engine.context({ kind, forOps, settings: { ...live, templates: settings.templates ?? live.templates }, merchantId: job.merchantId });
    const limits = this.limitsFor(live, forOps);
    return {
      buffer: buildTemplate(ctx, { maxRows: limits.maxRows, maxFileMb: limits.maxFileMb, rows: failed }),
      fileName: `${base}.xlsx`,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    };
  }

  // ───────────── submit ─────────────

  /** Books the valid and incomplete rows: small files at once, larger ones in the background (progress events). */
  async commit(actor: Actor, id: string, meta: RequestMeta) {
    const job = await this.load(actor, id);
    if (actor.kind === "user" && job.createdById && job.createdById !== actor.userId && job.source === "OPERATIONS")
      throw forbidden("Only the person who uploaded this file can submit it");
    if (job.status !== "VALIDATED") throw new AppError("IMPORT_SUBMITTED", `Import ${job.number} was already submitted`, HttpStatus.CONFLICT, { status: job.status });
    const toBook = job.validRows + job.incompleteRows;
    if (!toBook) throw new AppError("NOTHING_TO_IMPORT", "No row can be created. Fix the errors and upload the file again.", 422);
    const settings = await this.config.settings();
    // One running import per merchant (operations: per person), and a bounded platform-wide queue.
    const owner: Prisma.ImportJobWhereInput = job.source === "OPERATIONS" ? { source: "OPERATIONS", createdById: job.createdById } : { merchantId: job.merchantId, source: { not: "OPERATIONS" } };
    const running = await this.prisma.importJob.count({ where: { ...owner, status: { in: ["QUEUED", "PROCESSING"] } } });
    if (running >= settings.limits.perMerchantConcurrent)
      throw new AppError(
        "IMPORT_IN_PROGRESS",
        `${running === 1 ? "Another import is" : `${running} imports are`} still running. Wait for it to finish, then submit this file.`,
        HttpStatus.TOO_MANY_REQUESTS,
        { running, retryAfterSeconds: 30 },
      );
    const active = await this.prisma.importJob.count({ where: { status: { in: ["QUEUED", "PROCESSING"] } } });
    if (active >= settings.limits.globalConcurrent * QUEUE_DEPTH_PER_WORKER)
      throw new AppError("IMPORTS_BUSY", "Many imports are running right now. Try again in a few minutes.", HttpStatus.TOO_MANY_REQUESTS, { retryAfterSeconds: 120 });

    const queued = await this.prisma.$transaction(async tx => {
      const batch = await tx.bookingBatch.create({
        data: { number: job.number, intake: job.intake, hubId: job.dropOffHubId, merchantId: job.merchantId, fileName: job.fileName, createdById: job.createdById, rowCount: job.totalRows },
      });
      const { count } = await tx.importJob.updateMany({ where: { id: job.id, status: "VALIDATED" }, data: { status: "QUEUED", queuedAt: new Date(), bookingBatchId: batch.id } });
      if (!count) throw new AppError("IMPORT_SUBMITTED", `Import ${job.number} was already submitted`, HttpStatus.CONFLICT);
      await this.audit.record(actor, { action: "import.submit", entityType: "import", entityId: job.id, data: { number: job.number, rows: toBook, batchId: batch.id } }, meta, tx);
      return tx.importJob.findUniqueOrThrow({ where: { id: job.id } });
    });
    if (toBook <= INLINE_ROWS) {
      await this.process(queued.id, { actor, meta });
      return { ...(await this.view(await this.prisma.importJob.findUniqueOrThrow({ where: { id: job.id } }))), background: false };
    }
    await this.enqueue(queued.id);
    return { ...(await this.view(queued)), background: true };
  }

  async discard(actor: Actor, id: string, meta: RequestMeta) {
    const job = await this.load(actor, id);
    if (job.status !== "VALIDATED") throw new AppError("IMPORT_SUBMITTED", `Import ${job.number} was already submitted`, HttpStatus.CONFLICT);
    await this.prisma.$transaction(async tx => {
      await tx.importRow.deleteMany({ where: { jobId: job.id } });
      await tx.importJob.update({ where: { id: job.id }, data: { status: "DISCARDED", rowsPurgedAt: new Date() } });
      await this.audit.record(actor, { action: "import.discard", entityType: "import", entityId: job.id, data: { number: job.number } }, meta, tx);
    });
  }

  // ───────────── booking job ─────────────

  /** Takes the job if fewer than the allowed number of imports run platform-wide (else it is retried later). */
  private async claim(id: string, globalConcurrent: number): Promise<"claimed" | "busy" | "gone"> {
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('imports:claim'))`;
      const job = await tx.importJob.findUnique({ where: { id }, select: { status: true, updatedAt: true } });
      if (!job) return "gone";
      const stale = job.status === "PROCESSING" && Date.now() - job.updatedAt.getTime() > STALE_MS;
      if (job.status !== "QUEUED" && !stale) return "gone";
      const running = await tx.importJob.count({ where: { status: "PROCESSING", updatedAt: { gt: new Date(Date.now() - STALE_MS) }, id: { not: id } } });
      if (running >= globalConcurrent) return "busy";
      await tx.importJob.update({ where: { id }, data: { status: "PROCESSING", startedAt: new Date() } });
      return "claimed";
    });
  }

  /** Re-creates the uploader as an actor, refusing if their access has gone since. */
  private async actorFor(job: ImportJob): Promise<Actor> {
    const stored = job.actor as StoredActor;
    if (stored.kind === "api_key") {
      const key = await this.prisma.apiKey.findUnique({ where: { id: stored.apiKeyId } });
      if (!key || key.revokedAt || (key.expiresAt && key.expiresAt < new Date()) || key.merchantId !== job.merchantId) throw forbidden("The API key that uploaded this file is no longer valid");
      return { kind: "api_key", apiKeyId: key.id, merchantId: key.merchantId, name: key.name, scopes: key.scopes, permissions: new Set(["parcel:create", "parcel:read:own", "parcel:cancel:own"] as const) };
    }
    const [user, grants] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: stored.userId }, select: { status: true, name: true } }),
      this.prisma.userRole.findMany({ where: { userId: stored.userId } }),
    ]);
    if (user?.status !== "ACTIVE") throw forbidden("The person who uploaded this file can no longer sign in");
    const roles = grants.map(g => ({ role: g.role, merchantId: g.merchantId, hubId: g.hubId, customRoleId: g.customRoleId }));
    const actor = userActor({ userId: stored.userId, sessionId: `import:${job.id}`, name: user.name, roles, permissions: await this.permissions.resolve(roles) });
    const allowed = job.source === "OPERATIONS" ? actor.permissions.has("parcel:dispatch") : !!job.merchantId && merchantIdsOf(actor).includes(job.merchantId) && actor.permissions.has("parcel:create");
    if (!allowed) throw forbidden("The person who uploaded this file no longer has access");
    return actor;
  }

  private progressEvent(job: ImportJob, type: "import.progress" | "import.completed") {
    const toBook = job.validRows + job.incompleteRows;
    this.realtime.publish({
      type,
      id: job.id,
      merchantId: job.source === "OPERATIONS" ? null : job.merchantId,
      userIds: [job.createdById],
      staffPermission: "config:manage",
      data: { number: job.number, status: job.status, processed: job.processedRows, total: toBook, created: job.createdCount, failed: job.failedCount },
    });
  }

  /** Books every row not booked yet, in chunks. Safe to run again: it resumes where it stopped. */
  async process(id: string, opts: { actor?: Actor; meta?: RequestMeta } = {}) {
    const settings = await this.config.settings();
    const claim = await this.claim(id, settings.limits.globalConcurrent);
    if (claim === "busy") return void (await this.enqueue(id, new Date(Date.now() + 15_000)));
    if (claim === "gone") return;
    let job = await this.prisma.importJob.findUniqueOrThrow({ where: { id } });
    const meta: RequestMeta = opts.meta ?? { ip: "", userAgent: "import-job", requestId: `import:${id}` };
    try {
      const actor = opts.actor ?? (await this.actorFor(job));
      const kind = kindKeyOf(job.kind);
      const stored = job.settings as unknown as ImportSettings & { forOps?: boolean; services?: ImportServiceOptions };
      // The required columns and defaults shown in the preview; live catalog, merchants and prices.
      const ctx = await this.engine.context({
        kind,
        forOps: stored.forOps ?? job.source === "OPERATIONS",
        settings: { ...settings, templates: stored.templates ?? settings.templates, defaultDestination: stored.defaultDestination ?? settings.defaultDestination },
        merchantId: job.merchantId,
        dropOffHubId: job.dropOffHubId,
        services: stored.services,
      });
      const dropOff = job.dropOffHubId ? { hub: await this.prisma.hub.findUniqueOrThrow({ where: { id: job.dropOffHubId }, select: { id: true, name: true, address: true } }) } : undefined;
      const contexts = new Map<string, BookingContext>();
      for (;;) {
        const rows = await this.prisma.importRow.findMany({ where: { jobId: id, status: { in: ["VALID", "INCOMPLETE"] } }, orderBy: { rowNumber: "asc" }, take: CHUNK });
        if (!rows.length) break;
        await this.bookChunk(job, ctx, actor, rows, contexts, dropOff, meta);
        job = await this.prisma.importJob.findUniqueOrThrow({ where: { id } });
        this.progressEvent(job, "import.progress");
      }
      const [created, createdIncomplete, failed] = await Promise.all([
        this.prisma.importRow.count({ where: { jobId: id, status: "CREATED" } }),
        this.prisma.parcel.count({ where: { importJobId: id, incomplete: true } }),
        this.prisma.importRow.count({ where: { jobId: id, status: "FAILED" } }),
      ]);
      const outboxIds = await this.prisma.$transaction(async tx => {
        job = await tx.importJob.update({ where: { id }, data: { status: "COMPLETED", completedAt: new Date(), createdCount: created, createdIncomplete, failedCount: failed } });
        if (job.bookingBatchId) await tx.bookingBatch.update({ where: { id: job.bookingBatchId }, data: { bookedCount: created, failedCount: job.totalRows - created } });
        await this.audit.record("system", { action: "import.complete", entityType: "import", entityId: id, data: { number: job.number, created, createdIncomplete, notCreated: job.totalRows - created } }, meta, tx);
        return job.createdById
          ? this.notify.notify(tx, {
              event: "import.completed",
              to: { userId: job.createdById },
              vars: { number: job.number, fileName: job.fileName ?? "", created, incomplete: createdIncomplete, notCreated: job.totalRows - created, rows: job.totalRows },
            })
          : [];
      });
      await this.outbox.flush(outboxIds);
      this.progressEvent(job, "import.completed");
    } catch (error) {
      const message = error instanceof AppError ? error.message : "The import stopped unexpectedly. Submit the file again to finish it.";
      if (!(error instanceof AppError)) this.logger.error({ err: error, import: id }, "Import failed");
      job = await this.prisma.importJob.update({ where: { id }, data: { status: "FAILED", completedAt: new Date(), error: message } });
      this.progressEvent(job, "import.completed");
    }
  }

  /**
   * One chunk: the rows are checked again (orders booked meanwhile, catalog changes), then booked in
   * one transaction. If that transaction fails, each row is booked on its own so one bad row
   * doesn't hold back the others.
   */
  private async bookChunk(
    job: ImportJob,
    ctx: EngineContext,
    actor: Actor,
    rows: ImportRow[],
    contexts: Map<string, BookingContext>,
    dropOff: DropOffBooking | undefined,
    meta: RequestMeta,
  ) {
    const results = await this.engine.validate(
      ctx,
      rows.map(r => ({ rowNumber: r.rowNumber, cells: r.cells as Cells })),
      { inFileDuplicates: false },
    );
    const ok: { row: ImportRow; result: RowResult }[] = [];
    const refused: { row: ImportRow; errors: { column: string; message: string }[] }[] = [];
    for (const [i, result] of results.entries()) {
      if (result.status === "ERROR" || !result.booking || !result.merchantId) refused.push({ row: rows[i], errors: result.errors });
      else ok.push({ row: rows[i], result });
    }
    for (const { result } of ok)
      if (!contexts.has(result.merchantId!)) contexts.set(result.merchantId!, await this.parcels.importContext(actor, result.merchantId!));

    const bookAll = async (items: typeof ok) => {
      const after = this.workflow.newAfterCommit();
      await this.prisma.$transaction(
        async tx => {
          for (const { row, result } of items) {
            const parcel = await this.parcels.bookImported(actor, contexts.get(result.merchantId!)!, result.booking!, meta, {
              tx,
              after,
              notify: false,
              batchId: job.bookingBatchId ?? undefined,
              dropOff,
              // Rows without an order ref are kept idempotent by their content hash (Parcel.importKey).
              import: { jobId: job.id, key: result.dedupeKey!.startsWith("h:") ? result.dedupeKey! : undefined, missingFields: result.missing, destination: result.destination },
              // Checked against the package and priced by the engine just now.
              quote: result.quote,
              product: result.product ?? null,
            });
            await tx.importRow.update({
              where: { id: row.id },
              data: { status: "CREATED", trackingId: parcel.trackingId, charge: parcel.totalCharge, ...(result.lines ? { priceLines: result.lines as unknown as Prisma.InputJsonArray } : {}) },
            });
          }
          await tx.importJob.update({ where: { id: job.id }, data: { processedRows: { increment: items.length }, createdCount: { increment: items.length } } });
        },
        { timeout: 120_000, maxWait: 30_000 },
      );
      await this.workflow.flush(after);
    };

    if (refused.length)
      await this.prisma.$transaction([
        ...refused.map(({ row, errors }) =>
          this.prisma.importRow.update({ where: { id: row.id }, data: { status: "FAILED", errors: (errors.length ? errors : [{ column: "row", message: "couldn't be booked" }]) as unknown as Prisma.InputJsonArray } }),
        ),
        this.prisma.importJob.update({ where: { id: job.id }, data: { processedRows: { increment: refused.length }, failedCount: { increment: refused.length } } }),
      ]);
    if (!ok.length) return;
    try {
      await bookAll(ok);
    } catch (chunkError) {
      this.logger.warn(`Import ${job.number}: chunk failed (${chunkError instanceof Error ? chunkError.message : chunkError}); booking its rows one by one`);
      for (const item of ok) {
        try {
          await bookAll([item]);
        } catch (error) {
          const message =
            error instanceof AppError
              ? (error.getResponse() as { message: string }).message
              : error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
                ? "this order was booked by another upload at the same time"
                : "couldn't be booked; try this row again";
          if (!(error instanceof AppError)) this.logger.error({ err: error, import: job.id, row: item.row.rowNumber }, "Import row failed");
          await this.prisma.$transaction([
            this.prisma.importRow.update({ where: { id: item.row.id }, data: { status: "FAILED", errors: [{ column: "order_ref", message }] as unknown as Prisma.InputJsonArray } }),
            this.prisma.importJob.update({ where: { id: job.id }, data: { processedRows: { increment: 1 }, failedCount: { increment: 1 } } }),
          ]);
        }
      }
    }
  }
}
