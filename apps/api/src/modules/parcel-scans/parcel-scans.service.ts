import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import QRCode from "qrcode";
import type { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { StorageService } from "../../common/storage.service";
import { QueueService } from "../../common/queues";
import { RealtimeService } from "../../common/realtime.service";
import { phoneLinkOrigin } from "../../common/phone-link";
import { AppError, notFound } from "../../common/errors";
import type { UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { env, runsJobs } from "../../config/env";
import type { ParcelScan, ParcelScanSession } from "../../generated/prisma/client";
import { COLUMNS, KIND_ENUM, KIND_LABEL, kindKeyOf, merchantTypeOf, type ImportKindKey } from "../imports/columns";
import { ImportJobsService } from "../imports/import-jobs.service";
import { PricingService } from "../pricing/pricing.service";
import type { ScanCells } from "./scan-parser";
import { readFields, ScanReaderService } from "./scan-reader";
import { mergeAi, mergeVision, ScanAiService } from "./scan-ai";
import { forClaude, forModel, upright } from "./scan-image";
import { ScanClaudeService, type ClaudeRead, type ScanLists } from "./scan-claude";
import { ImportAiService } from "../imports/import-ai.service";
import { CatalogService, listOf } from "../packages/catalog.service";
import { deliveryTypesFor } from "@delivery-fast/shared";
import { segmentOf } from "../imports/columns";
import type { createScanSessionSchema, updateScanSchema } from "./parcel-scans.schemas";

const QUEUE = "parcel-scans";
/** The open modal extends the link every minute; a tab that closes without saying so ends it after this. */
const KEEPALIVE_MS = 3 * 60_000;
/** A session never lives longer than this, modal open or not. */
const MAX_AGE_MS = 12 * 3600_000;
const MAX_SCANS = 300;
/** Photos of rows never booked are deleted after this. */
const UNUSED_DAYS = 7;
const EVENT = "parcel_scan.updated";

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const expired = () => new AppError("SCAN_LINK_EXPIRED", "This link has expired. Ask for a new QR code on the computer.", 410);

/**
 * "Scan with phone" (Courier Operations › New orders): a session opened from the modal gives a
 * one-time link (QR code) that works while the modal is open. Photos sent from the phone through
 * it are stored (compressed on the phone), read in a background job (ScanReaderService, then
 * parseLabel) into order fields, edited in the modal, downloaded / re-imported as the import
 * template with a Scan ID column, and booked by the import engine, which links each parcel to
 * its photo. The modal hears about new and read photos through `parcel_scan.updated` events.
 */
@Injectable()
export class ParcelScansService implements OnApplicationBootstrap {
  private readonly logger = new Logger("ParcelScans");

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly queues: QueueService,
    private readonly realtime: RealtimeService,
    private readonly pricing: PricingService,
    private readonly imports: ImportJobsService,
    private readonly reader: ScanReaderService,
    private readonly ai: ScanAiService,
    private readonly claude: ScanClaudeService,
    private readonly catalogs: CatalogService,
    private readonly importAi: ImportAiService,
  ) {}

  /** The kind's delivery types and priorities (Claude chooses from them); with AI import on, Claude names unnamed products. */
  private async lists(kind: ImportKindKey): Promise<ScanLists> {
    const segment = segmentOf(kind);
    const [types, priorities, guessProduct] = await Promise.all([
      this.catalogs.deliveryTypes(),
      this.prisma.parcelPriority.findMany({ where: { segment: listOf(segment), active: true }, orderBy: { sortOrder: "asc" }, select: { name: true } }),
      this.importAi.active(),
    ]);
    return { speeds: deliveryTypesFor(segment, types).map(t => t.name), categories: [], priorities: priorities.map(p => p.name), guessProduct };
  }

  onApplicationBootstrap() {
    if (!runsJobs()) return;
    void this.startWorkers().catch(err => this.logger.error({ err }, "Could not start the scan workers"));
  }

  private async queueReady() {
    await (this.queues as unknown as { ready?: Promise<void> }).ready;
    // A vision model on a CPU can take minutes per photo: a job is given 30 minutes before it counts as stuck.
    const policy = { name: QUEUE, retryLimit: 2, retryDelay: 10, expireInSeconds: 1800 };
    if (!(await this.queues.boss.getQueue(QUEUE))) await this.queues.boss.createQueue(QUEUE, policy);
    else await this.queues.boss.updateQueue(QUEUE, policy);
  }

  private async startWorkers() {
    await this.queueReady();
    // Several photos are read at the same time (Claude: 6 by default; the local OCR is CPU-bound: 2).
    const parallel = env().SCAN_CONCURRENCY ?? (this.claude.enabled() ? 6 : 2);
    await this.queues.boss.work<{ id: string }>(QUEUE, { batchSize: parallel, pollingIntervalSeconds: 1 }, async jobs => {
      await Promise.all(jobs.map(job => this.read(job.data.id)));
    });
    // Every night: photos of rows never booked, after UNUSED_DAYS.
    await this.queues.schedule("parcel-scans-cleanup", "40 3 * * *", () => this.cleanup().then(() => undefined));
  }

  // ───────────── sessions (the modal) ─────────────

  /** The phone link's origin (common/phone-link.ts). */
  linkOrigin() {
    return phoneLinkOrigin();
  }

  async create(actor: UserActor, input: z.infer<typeof createScanSessionSchema>, meta: RequestMeta) {
    const kind = input.kind;
    const merchant = await this.checkMerchant(kind, input.merchantId);
    const token = randomBytes(24).toString("base64url");
    const session = await this.prisma.$transaction(async tx => {
      const created = await tx.parcelScanSession.create({
        data: { tokenHash: hashToken(token), kind: KIND_ENUM[kind], merchantId: merchant?.id ?? null, createdById: actor.userId!, expiresAt: new Date(Date.now() + KEEPALIVE_MS) },
      });
      await this.audit.record(actor, { action: "parcel_scan.session_open", entityType: "parcel_scan_session", entityId: created.id, data: { kind, merchantId: merchant?.id ?? null } }, meta, tx);
      return created;
    });
    const url = `${this.linkOrigin()}/scan/${token}`;
    const qrSvg = await QRCode.toString(url, { type: "svg", errorCorrectionLevel: "M", margin: 1 });
    return { ...(await this.view(session)), url, qrSvg };
  }

  private async checkMerchant(kind: ImportKindKey, merchantId?: string) {
    const type = merchantTypeOf(kind);
    if (!type) {
      if (merchantId) throw new AppError("VALIDATION_FAILED", "Customer parcels have no merchant", 422);
      return null;
    }
    if (!merchantId) throw new AppError("MERCHANT_REQUIRED", `Choose the ${KIND_LABEL[kind]} merchant`, 422);
    const merchant = await this.prisma.merchant.findUnique({ where: { id: merchantId }, select: { id: true, name: true, code: true, type: true, status: true } });
    if (!merchant) throw notFound("Merchant");
    if (merchant.type !== type) throw new AppError("WRONG_TEMPLATE", `${merchant.name} is not a ${KIND_LABEL[kind]} merchant`, 422);
    if (merchant.status !== "ACTIVE") throw new AppError("MERCHANT_INACTIVE", "This merchant account is not active", 422);
    return merchant;
  }

  /** The actor's own session (404 for anyone else's). */
  private async own(actor: UserActor, id: string) {
    const session = await this.prisma.parcelScanSession.findUnique({ where: { id } });
    if (!session || session.createdById !== actor.userId) throw notFound("Scanning session");
    return session;
  }

  private open = (s: ParcelScanSession) => !s.closedAt && s.expiresAt > new Date();

  private async view(session: ParcelScanSession) {
    const [merchant, scans] = await Promise.all([
      session.merchantId ? this.prisma.merchant.findUnique({ where: { id: session.merchantId }, select: { id: true, code: true, name: true } }) : null,
      this.prisma.parcelScan.findMany({ where: { sessionId: session.id }, orderBy: { number: "asc" }, include: { parcel: { select: { trackingId: true } } } }),
    ]);
    const kind = kindKeyOf(session.kind);
    return {
      id: session.id,
      kind,
      kindLabel: KIND_LABEL[kind],
      merchant,
      open: this.open(session),
      expiresAt: session.expiresAt,
      closedAt: session.closedAt,
      /** The template's columns (key, header) in order, for the modal's table. */
      columns: COLUMNS[kind].map(c => ({ key: c.key, header: c.header })),
      scans: scans.map(s => this.scanView(s)),
      /** Scans left (super admin's scan balance); null = no limit. */
      scansLeft: await this.balance().then(b => (b.limited ? b.balance : null)),
    };
  }

  private scanView(s: ParcelScan & { parcel?: { trackingId: string } | null }) {
    return { id: s.id, number: s.number, status: s.status, hasPhoto: !!s.fileId, cells: s.cells as ScanCells, text: s.text, trackingId: s.parcel?.trackingId ?? null, createdAt: s.createdAt };
  }

  async get(actor: UserActor, id: string) {
    return this.view(await this.own(actor, id));
  }

  /** The open modal, every minute: the link keeps working for KEEPALIVE_MS more. */
  async keepalive(actor: UserActor, id: string) {
    const session = await this.own(actor, id);
    if (!this.open(session)) throw expired();
    const until = new Date(Math.min(Date.now() + KEEPALIVE_MS, session.createdAt.getTime() + MAX_AGE_MS));
    await this.prisma.parcelScanSession.update({ where: { id }, data: { expiresAt: until } });
    return { expiresAt: until };
  }

  /** The modal closed: the link stops working at once (the rows and photos stay for the import). */
  async close(actor: UserActor, id: string, meta: RequestMeta) {
    const session = await this.own(actor, id);
    if (session.closedAt) return;
    await this.prisma.$transaction(async tx => {
      await tx.parcelScanSession.update({ where: { id }, data: { closedAt: new Date() } });
      await this.audit.record(actor, { action: "parcel_scan.session_close", entityType: "parcel_scan_session", entityId: id, data: { scans: session.scanCount } }, meta, tx);
    });
  }

  // ───────────── rows ─────────────

  private cleanCells(kind: ImportKindKey, cells: Record<string, string | null | undefined>): ScanCells {
    const allowed = new Set<string>(COLUMNS[kind].map(c => c.key));
    return Object.fromEntries(Object.entries(cells).filter(([k, v]) => allowed.has(k) && typeof v === "string" && v.trim()).map(([k, v]) => [k, v!.trim()])) as ScanCells;
  }

  async updateScan(actor: UserActor, sessionId: string, scanId: string, input: z.infer<typeof updateScanSchema>, meta: RequestMeta) {
    const session = await this.own(actor, sessionId);
    const kind = kindKeyOf(session.kind);
    const allowed = new Set<string>(COLUMNS[kind].map(c => c.key));
    const unknown = Object.keys(input.cells).filter(k => !allowed.has(k));
    if (unknown.length) throw new AppError("VALIDATION_FAILED", `Not a column of the ${KIND_LABEL[kind]} template: ${unknown.join(", ")}`, 422);
    const scan = await this.prisma.parcelScan.findFirst({ where: { id: scanId, sessionId } });
    if (!scan) throw notFound("Scanned parcel");
    if (scan.parcelId) throw new AppError("ALREADY_BOOKED", "This row is already booked", 409);
    const cells = this.cleanCells(kind, { ...(scan.cells as ScanCells), ...input.cells });
    const updated = await this.prisma.$transaction(async tx => {
      const row = await tx.parcelScan.update({ where: { id: scanId }, data: { cells } });
      await this.audit.record(actor, { action: "parcel_scan.update", entityType: "parcel_scan", entityId: scanId, data: { columns: Object.keys(input.cells) } }, meta, tx);
      return row;
    });
    return this.scanView(updated);
  }

  async deleteScan(actor: UserActor, sessionId: string, scanId: string, meta: RequestMeta) {
    await this.own(actor, sessionId);
    const scan = await this.prisma.parcelScan.findFirst({ where: { id: scanId, sessionId } });
    if (!scan) throw notFound("Scanned parcel");
    if (scan.parcelId) throw new AppError("ALREADY_BOOKED", "This row is booked: its photo stays with the parcel", 409);
    await this.prisma.$transaction(async tx => {
      await tx.parcelScan.delete({ where: { id: scanId } });
      await this.audit.record(actor, { action: "parcel_scan.delete", entityType: "parcel_scan", entityId: scanId, data: { number: scan.number } }, meta, tx);
    });
    if (scan.fileId) await this.storage.remove([scan.fileId]);
  }

  /** The photo (staff with dispatch: the modal's thumbnails, and later the booked parcel's). */
  async photo(id: string) {
    const scan = await this.prisma.parcelScan.findUnique({ where: { id }, select: { file: { select: { storageKey: true, mimeType: true } } } });
    if (!scan?.file) throw notFound("Photo");
    return { data: await this.storage.read(scan.file.storageKey), mimeType: scan.file.mimeType };
  }

  // ───────────── Excel ─────────────

  async workbook(actor: UserActor, id: string) {
    const session = await this.own(actor, id);
    const kind = kindKeyOf(session.kind);
    const scans = await this.prisma.parcelScan.findMany({ where: { sessionId: id, parcelId: null }, orderBy: { number: "asc" } });
    const buffer = await this.imports.scanWorkbook(actor, kind, session.merchantId ?? undefined, scans.map(s => ({ scanId: s.id, cells: s.cells as ScanCells })));
    const day = new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
    return { buffer, fileName: `delivery-fast-scanned-${kind}-${day}.xlsx` };
  }

  /**
   * An edited workbook back into the session: rows with a Scan ID of this session replace that
   * row's fields; rows without one (added in Excel) become new rows without a photo; rows of the
   * session missing from the file are left as they are.
   */
  async importWorkbook(actor: UserActor, id: string, file: { buffer: Buffer; fileName: string }, meta: RequestMeta) {
    const session = await this.own(actor, id);
    const kind = kindKeyOf(session.kind);
    const rows = await this.imports.readRows(actor, kind, file);
    const scans = await this.prisma.parcelScan.findMany({ where: { sessionId: id }, select: { id: true, parcelId: true } });
    const byId = new Map(scans.map(s => [s.id, s]));
    let updated = 0;
    let added = 0;
    let skipped = 0;
    await this.prisma.$transaction(
      async tx => {
        for (const row of rows) {
          const { __scan: scanId, __cod: _cod, ...rest } = row.cells;
          const cells = this.cleanCells(kind, rest as Record<string, string>);
          const scan = scanId ? byId.get(scanId) : undefined;
          if (scan) {
            if (scan.parcelId) {
              skipped++;
              continue;
            }
            await tx.parcelScan.update({ where: { id: scan.id }, data: { cells } });
            updated++;
          } else if (Object.keys(cells).length) {
            if (scans.length + added >= MAX_SCANS) throw new AppError("TOO_MANY_ROWS", `A session holds at most ${MAX_SCANS} parcels`, 422);
            const { scanCount } = await tx.parcelScanSession.update({ where: { id }, data: { scanCount: { increment: 1 } } });
            await tx.parcelScan.create({ data: { sessionId: id, number: scanCount, status: "READ", cells } });
            added++;
          }
        }
        await this.audit.record(actor, { action: "parcel_scan.workbook_import", entityType: "parcel_scan_session", entityId: id, data: { fileName: file.fileName, updated, added, skipped } }, meta, tx);
      },
      { timeout: 60_000 },
    );
    return { updated, added, skipped, session: await this.view(await this.own(actor, id)) };
  }

  // ───────────── the phone (public, by link token) ─────────────

  private async byToken(token: string) {
    if (!/^[\w-]{20,64}$/.test(token)) throw expired();
    const session = await this.prisma.parcelScanSession.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!session || !this.open(session)) throw expired();
    return session;
  }

  async publicView(token: string) {
    const session = await this.byToken(token);
    const [merchant, scans] = await Promise.all([
      session.merchantId ? this.prisma.merchant.findUnique({ where: { id: session.merchantId }, select: { name: true } }) : null,
      this.prisma.parcelScan.findMany({ where: { sessionId: session.id, fileId: { not: null } }, orderBy: { number: "desc" }, take: 50, select: { number: true, status: true, createdAt: true } }),
    ]);
    const kind = kindKeyOf(session.kind);
    const { limited, balance } = await this.balance();
    return { kindLabel: KIND_LABEL[kind], merchantName: merchant?.name ?? null, photos: session.scanCount, maxPhotos: MAX_SCANS, expiresAt: session.expiresAt, scans, scansLeft: limited ? balance : null };
  }

  /** A photo from the phone (JPEG / PNG / WebP, compressed on the phone, at most 5 MB): stored, then read in the background. */
  async addPhoto(token: string, photo: { data: Buffer; mimeType: string; filename: string }, meta: RequestMeta) {
    const session = await this.byToken(token);
    if (session.scanCount >= MAX_SCANS) throw new AppError("TOO_MANY_PHOTOS", `This session holds at most ${MAX_SCANS} parcels. Submit these and start a new one.`, 422);
    const who = { userId: session.createdById, name: "Scan with phone (phone link)" };
    let fileId: string | undefined;
    const scan = await this.prisma.$transaction(async tx => {
      // Scan balance (super admin): while limited, each photo takes 1 and none is taken at 0. Taken in this
      // transaction, so a photo that isn't stored gives it back.
      const limit = await tx.scanBalance.findUnique({ where: { id: "default" } });
      if (limit?.limited) {
        const taken = await tx.scanBalance.updateMany({ where: { id: "default", limited: true, balance: { gt: 0 } }, data: { balance: { decrement: 1 } } });
        if (!taken.count) throw new AppError("SCAN_BALANCE_EMPTY", "No scans left. Ask the super admin to add scan balance.", 422);
      }
      const file = await this.storage.save({ data: photo.data, mimeType: photo.mimeType, filename: photo.filename || "parcel.jpg", uploadedById: session.createdById }, tx);
      fileId = file.id;
      const { scanCount } = await tx.parcelScanSession.update({ where: { id: session.id }, data: { scanCount: { increment: 1 } } });
      const created = await tx.parcelScan.create({ data: { sessionId: session.id, number: scanCount, fileId: file.id, status: "READING" } });
      await this.audit.record(who, { action: "parcel_scan.photo", entityType: "parcel_scan", entityId: created.id, data: { sessionId: session.id, number: scanCount, bytes: photo.data.length } }, meta, tx);
      return created;
    }).catch(async error => {
      // The object was written before the transaction failed: don't leave it behind.
      if (fileId) await this.storage.remove([fileId]).catch(() => undefined);
      throw error;
    });
    this.realtime.publish({ type: EVENT, id: session.id, userIds: [session.createdById] });
    await this.enqueue(scan.id);
    return { number: scan.number, status: scan.status };
  }

  private async enqueue(scanId: string) {
    try {
      await this.queueReady();
      await this.queues.boss.send(QUEUE, { id: scanId }, { singletonKey: scanId });
    } catch (err) {
      // The row stays "Reading…"; it can still be filled in by hand.
      this.logger.error({ err, scan: scanId }, "Could not queue a scan for reading");
    }
  }

  /** Background job: OCR, then the fields (fields already typed in the modal are kept). */
  async read(scanId: string) {
    const scan = await this.prisma.parcelScan.findUnique({ where: { id: scanId }, include: { file: { select: { storageKey: true } }, session: { select: { id: true, kind: true, merchantId: true, createdById: true } } } });
    if (!scan || scan.status !== "READING" || !scan.file) return;
    const started = Date.now();
    let text = "";
    let cells: ScanCells = {};
    let status: "READ" | "FAILED" = "READ";
    let byClaude: ClaudeRead | null = null;
    try {
      const photo = await this.storage.read(scan.file.storageKey);
      const kind = kindKeyOf(scan.session.kind);
      const catalog = await this.pricing.catalog();
      // SCAN_READER=claude: Claude reads the whole photo; the local reader only when that call fails.
      byClaude = this.claude.enabled() ? await this.claude.extract({ image: await forClaude(photo), kind, places: catalog, lists: await this.lists(kind) }) : null;
      if (byClaude?.cells) {
        cells = byClaude.cells;
        if (!Object.keys(cells).length) status = "FAILED";
      } else ({ text, cells, status } = await this.readLocal(photo, kind, catalog));
    } catch (err) {
      this.logger.warn({ err, scan: scanId }, "A parcel photo could not be read");
      status = "FAILED";
    }
    const fresh = await this.prisma.parcelScan.findUnique({ where: { id: scanId }, select: { cells: true } });
    if (!fresh) return;
    await this.prisma.parcelScan.update({ where: { id: scanId }, data: { status, text: text.slice(0, 4000) || null, cells: { ...cells, ...(fresh.cells as ScanCells) } } });
    this.realtime.publish({ type: EVENT, id: scan.session.id, userIds: [scan.session.createdById] });
    // The usage log (super admin › Scan with phone usage): every reading, with Claude's tokens and estimated cost.
    const claudeRead = !!byClaude?.cells;
    await this.prisma.scanReadLog
      .create({
        data: {
          scanId,
          sessionId: scan.session.id,
          kind: scan.session.kind,
          merchantId: scan.session.merchantId,
          userId: scan.session.createdById,
          reader: claudeRead ? "CLAUDE" : "LOCAL",
          model: byClaude?.model ?? null,
          status,
          fallback: !!byClaude && !claudeRead,
          error: byClaude?.error ?? null,
          fields: Object.keys(cells).length,
          ms: Date.now() - started,
          inputTokens: byClaude?.tokens.input ?? 0,
          cacheRead: byClaude?.tokens.cacheRead ?? 0,
          cacheWrite: byClaude?.tokens.cacheWrite ?? 0,
          outputTokens: byClaude?.tokens.output ?? 0,
          costUsd: byClaude?.costUsd ?? 0,
        },
      })
      .catch(err => this.logger.warn({ err, scan: scanId }, "Could not log a scan reading"));
  }

  // ───────────── usage and scan balance (super admin) ─────────────

  /** The scan balance: unlimited unless a super admin turned the limit on. */
  async balance() {
    const row = await this.prisma.scanBalance.findUnique({ where: { id: "default" } });
    return { limited: !!row?.limited, balance: row?.balance ?? 0, updatedAt: row?.updatedAt ?? null };
  }

  /** Turns the limit on / off, adds scans or sets the balance (one of add / set at a time). */
  async setBalance(actor: UserActor, input: { limited?: boolean; add?: number; set?: number }, meta: RequestMeta) {
    const before = await this.balance();
    const after = await this.prisma.$transaction(async tx => {
      const row = await tx.scanBalance.upsert({
        where: { id: "default" },
        create: { id: "default", limited: input.limited ?? before.limited, balance: input.set ?? input.add ?? 0, updatedById: actor.userId },
        update: {
          ...(input.limited !== undefined ? { limited: input.limited } : {}),
          ...(input.set !== undefined ? { balance: input.set } : input.add !== undefined ? { balance: { increment: input.add } } : {}),
          updatedById: actor.userId,
        },
      });
      await this.audit.record(
        actor,
        { action: "parcel_scan.balance", entityType: "scan_balance", entityId: "default", data: { before: { limited: before.limited, balance: before.balance }, after: { limited: row.limited, balance: row.balance }, ...(input.add !== undefined ? { added: input.add } : {}) } },
        meta,
        tx,
      );
      return row;
    });
    return { limited: after.limited, balance: after.balance, updatedAt: after.updatedAt };
  }

  /** Scan with phone usage between two days (Dhaka dates, inclusive): totals, per day, per model, and the log. */
  async usage(input: { from: string; to: string; page: number; pageSize: number }) {
    const start = new Date(`${input.from}T00:00:00+06:00`);
    const end = new Date(new Date(`${input.to}T00:00:00+06:00`).getTime() + 86_400_000);
    // Scan with phone only (CN_Scan has its own usage: /cn/usage).
    const where = { createdAt: { gte: start, lt: end }, source: "PHONE" };
    const sum = { costUsd: true, inputTokens: true, cacheRead: true, cacheWrite: true, outputTokens: true, ms: true } as const;
    const [all, byReader, byStatus, fallbacks, byModel, total, rows, daily] = await Promise.all([
      this.prisma.scanReadLog.aggregate({ where, _count: { _all: true }, _sum: sum }),
      this.prisma.scanReadLog.groupBy({ by: ["reader"], where, _count: { _all: true } }),
      this.prisma.scanReadLog.groupBy({ by: ["status"], where, _count: { _all: true } }),
      this.prisma.scanReadLog.count({ where: { ...where, fallback: true } }),
      this.prisma.scanReadLog.groupBy({ by: ["model"], where: { ...where, reader: "CLAUDE" }, _count: { _all: true }, _sum: sum }),
      this.prisma.scanReadLog.count({ where }),
      this.prisma.scanReadLog.findMany({ where, orderBy: { createdAt: "desc" }, skip: (input.page - 1) * input.pageSize, take: input.pageSize }),
      this.prisma.$queryRaw<{ day: string; photos: bigint; claude: bigint; failed: bigint; cost: string | null }[]>`
        SELECT to_char(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM-DD') AS day,
               count(*) AS photos,
               count(*) FILTER (WHERE reader = 'CLAUDE') AS claude,
               count(*) FILTER (WHERE status = 'FAILED') AS failed,
               sum("costUsd")::text AS cost
        FROM scan_read_logs WHERE source = 'PHONE' AND "createdAt" >= ${start} AND "createdAt" < ${end}
        GROUP BY 1 ORDER BY 1 DESC`,
    ]);
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map(r => r.userId).filter((v): v is string => !!v))] } }, select: { id: true, name: true } });
    const merchants = await this.prisma.merchant.findMany({ where: { id: { in: [...new Set(rows.map(r => r.merchantId).filter((v): v is string => !!v))] } }, select: { id: true, name: true, code: true } });
    const userName = new Map(users.map(u => [u.id, u.name]));
    const merchantOf = new Map(merchants.map(m => [m.id, m]));
    const count = <T extends string>(list: { _count: { _all: number } }[], key: (x: never) => T, value: T) => list.find(x => key(x as never) === value)?._count._all ?? 0;
    const n = (v: unknown) => Number(v ?? 0);
    return {
      from: input.from,
      to: input.to,
      /** What reads the photos now. */
      reader: this.claude.enabled() ? { name: "claude", model: env().SCAN_CLAUDE_MODEL } : { name: "local", model: null },
      balance: await this.balance(),
      totals: {
        photos: all._count._all,
        claude: count(byReader, (x: { reader: string }) => x.reader, "CLAUDE"),
        local: count(byReader, (x: { reader: string }) => x.reader, "LOCAL"),
        read: count(byStatus, (x: { status: string }) => x.status, "READ"),
        failed: count(byStatus, (x: { status: string }) => x.status, "FAILED"),
        fallbacks,
        tokens: { input: n(all._sum.inputTokens), cacheRead: n(all._sum.cacheRead), cacheWrite: n(all._sum.cacheWrite), output: n(all._sum.outputTokens) },
        costUsd: n(all._sum.costUsd),
        avgMs: all._count._all ? Math.round(n(all._sum.ms) / all._count._all) : 0,
      },
      models: byModel.map(m => ({ model: m.model, photos: m._count._all, costUsd: n(m._sum.costUsd), avgMs: m._count._all ? Math.round(n(m._sum.ms) / m._count._all) : 0 })),
      daily: daily.map(d => ({ day: d.day, photos: Number(d.photos), claude: Number(d.claude), failed: Number(d.failed), costUsd: n(d.cost) })),
      log: {
        total,
        page: input.page,
        pageSize: input.pageSize,
        items: rows.map(r => ({
          id: r.id,
          createdAt: r.createdAt,
          kind: kindKeyOf(r.kind),
          kindLabel: KIND_LABEL[kindKeyOf(r.kind)],
          merchant: r.merchantId ? (merchantOf.get(r.merchantId) ?? null) : null,
          user: r.userId ? (userName.get(r.userId) ?? null) : null,
          reader: r.reader,
          model: r.model,
          status: r.status,
          fallback: r.fallback,
          error: r.error,
          fields: r.fields,
          ms: r.ms,
          tokens: r.inputTokens + r.cacheRead + r.cacheWrite + r.outputTokens,
          costUsd: Number(r.costUsd),
        })),
      },
    };
  }

  /** The local reader: OCR + rules, and the local AI (SCAN_AI_URL) when configured. */
  private async readLocal(photo: Buffer, kind: ImportKindKey, catalog: Awaited<ReturnType<PricingService["catalog"]>>) {
    // OCR + rules (a word-by-word second reading fills fields the first one missed).
    const read = await readFields(this.reader, photo, kind, catalog);
    const text = read.text;
    let cells = read.cells;
    // The OCR read it well: sure of itself and the phone found (a confident read of the title alone isn't).
    const ocrGood = read.confidence >= 75 && !!cells.recipient_phone;
    // The local AI (when configured): a vision model reads the photo itself (turned the way the OCR read
    // it best), a text model the OCR text; either way only checked values are kept.
    const image = (await this.ai.seesImages()) ? await forModel(await upright(photo), read.angle) : undefined;
    const ai = await this.ai.extract({ text, kind, image, ocrGood });
    if (ai) cells = ai.vision ? mergeVision(cells, ai.values, kind, catalog, ocrGood) : mergeAi(cells, ai.values, text, kind, catalog);
    const status: "READ" | "FAILED" = !Object.keys(cells).length && !ocrGood ? "FAILED" : "READ";
    return { text, cells, status };
  }

  /** Nightly: rows never booked are deleted after UNUSED_DAYS with their photos; empty old sessions go too. */
  async cleanup(now = new Date()) {
    const before = new Date(now.getTime() - UNUSED_DAYS * 86_400_000);
    const stale = await this.prisma.parcelScan.findMany({ where: { parcelId: null, createdAt: { lt: before } }, select: { id: true, fileId: true }, take: 5000 });
    if (stale.length) {
      await this.prisma.parcelScan.deleteMany({ where: { id: { in: stale.map(s => s.id) } } });
      await this.storage.remove(stale.map(s => s.fileId).filter((id): id is string => !!id));
    }
    const sessions = await this.prisma.parcelScanSession.deleteMany({ where: { createdAt: { lt: before }, scans: { none: {} } } });
    if (stale.length || sessions.count) await this.audit.record("system", { action: "parcel_scan.cleanup", entityType: "parcel_scan", entityId: "unused", data: { scans: stale.length, sessions: sessions.count } });
    return { scans: stale.length, sessions: sessions.count };
  }
}
