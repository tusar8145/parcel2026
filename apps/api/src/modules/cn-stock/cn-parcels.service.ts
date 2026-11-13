import { HttpStatus, Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { z } from "zod";
import { normalizeBdPhone, isBdMobile, TERMINAL_STATUSES, type ParcelStatus } from "@delivery-fast/shared";
import { PrismaService, type Db } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { StorageService } from "../../common/storage.service";
import { QueueService } from "../../common/queues";
import { RealtimeService } from "../../common/realtime.service";
import { runsJobs } from "../../config/env";
import type { Actor, UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { AppError, forbidden, notFound } from "../../common/errors";
import { normalizeTrackingId } from "../../common/counters";
import type { Parcel } from "../../generated/prisma/client";
import { ParcelsService } from "../parcels/parcels.service";
import { opsHubScope } from "../parcels/ops-scope";
import { MISSING_FIELDS, missingFieldsOf } from "../parcels/incomplete";
import { resolvePlace } from "../parcels/places";
import { assertHubInScope } from "../ops/ops-common";
import { PackagesService } from "../packages/packages.service";
import { PricingService } from "../pricing/pricing.service";
import { ScanClaudeService } from "../parcel-scans/scan-claude";
import { forClaude } from "../parcel-scans/scan-image";

const SETTINGS_KEY = "cn-scan";
const QUEUE = "cn-capture-read";
const DHAKA_OFFSET_MS = 6 * 3600_000;

export const cnSettingsSchema = z.object({
  /** CN_Scan reads the photo with the AI (off: the photo and CN are kept, details are typed in Courier Operations). */
  aiEnabled: z.boolean(),
  /** Photos the AI reads per day (Dhaka); null = no limit. */
  dailyLimit: z.number().int().min(0).max(100_000).nullable(),
});
export type CnSettings = z.infer<typeof cnSettingsSchema>;
const DEFAULT_SETTINGS: CnSettings = { aiEnabled: true, dailyLimit: null };

export const cnMerchantSchema = z.object({
  cn: z.string().trim().min(6, "Scan the CN label").max(40),
  merchantId: z.uuid("Choose the merchant"),
  /** The hub the label is scanned at (Ops app); riders use their own hub. */
  hubId: z.uuid().optional(),
});
export const cnCaptureFieldsSchema = z.object({
  cn: z.string().trim().min(6, "Scan the CN label").max(40),
  hubId: z.uuid().optional(),
  /** Optional: the merchant chosen in the app before scanning (CN_Scan with a merchant). */
  merchantId: z.uuid().optional(),
});
export const cnUsageQuerySchema = z.object({ from: z.iso.date(), to: z.iso.date() });

type Cells = Record<string, string | null | undefined>;
type Summary = Awaited<ReturnType<CnParcelsService["summary"]>>;
export type CnOutcome = { outcome: "CREATED" | "ASSIGNED" | "ALREADY" | "OTHER_MERCHANT" | "ADDED"; ok: boolean; message: string; parcel: Summary };

/**
 * The apps' CN_ features on pre-printed CN labels (CN stock): CN_Merchant (choose a merchant, scan labels: they become
 * that merchant's parcels) and CN_Scan (a photo of the parcel with its CN barcode; the AI reads the recipient into it).
 * Either can come first, at any time: the first scan uses the label up (one CN, one parcel) and creates the parcel, an
 * awaiting drop-off at the scanner's hub (received there at once when operations scan it); later scans add to that
 * parcel and never overwrite what it has (a difference is kept as a conflict to check). The parcel is then an ordinary
 * one (cnFlow: it needs no address to move or be delivered; its messages start once its merchant is known).
 */
@Injectable()
export class CnParcelsService implements OnApplicationBootstrap {
  private readonly logger = new Logger("CnParcels");

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly queues: QueueService,
    private readonly realtime: RealtimeService,
    private readonly parcels: ParcelsService,
    private readonly packages: PackagesService,
    private readonly pricing: PricingService,
    private readonly claude: ScanClaudeService,
  ) {}

  // ───────────── jobs ─────────────

  onApplicationBootstrap() {
    if (!runsJobs()) return;
    void this.startWorker().catch(err => this.logger.error({ err }, "Could not start the CN_Scan reader"));
  }

  private async queueReady() {
    await (this.queues as unknown as { ready?: Promise<void> }).ready;
    const policy = { name: QUEUE, retryLimit: 2, retryDelay: 10, expireInSeconds: 600 };
    if (!(await this.queues.boss.getQueue(QUEUE))) await this.queues.boss.createQueue(QUEUE, policy);
    else await this.queues.boss.updateQueue(QUEUE, policy);
  }

  private async startWorker() {
    await this.queueReady();
    await this.queues.boss.work<{ id: string }>(QUEUE, { batchSize: 4, pollingIntervalSeconds: 1 }, async jobs => {
      await Promise.all(jobs.map(job => this.read(job.data.id)));
    });
  }

  private async enqueue(captureId: string) {
    try {
      await this.queueReady();
      await this.queues.boss.send(QUEUE, { id: captureId }, { singletonKey: captureId });
    } catch (err) {
      this.logger.error({ err, capture: captureId }, "Could not queue a CN_Scan photo");
    }
  }

  // ───────────── settings and usage (super admin) ─────────────

  async settings(): Promise<CnSettings & { aiAvailable: boolean; readToday: number }> {
    const row = await this.prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
    const parsed = cnSettingsSchema.safeParse(row?.value);
    return { ...(parsed.success ? parsed.data : DEFAULT_SETTINGS), aiAvailable: this.claude.enabled(), readToday: await this.readToday() };
  }

  async saveSettings(actor: Actor, input: CnSettings, meta: RequestMeta) {
    const before = await this.settings();
    await this.prisma.$transaction(async tx => {
      await tx.setting.upsert({ where: { key: SETTINGS_KEY }, create: { key: SETTINGS_KEY, value: input }, update: { value: input } });
      await this.audit.record(actor, { action: "cn.settings", entityType: "setting", entityId: SETTINGS_KEY, data: { before: { aiEnabled: before.aiEnabled, dailyLimit: before.dailyLimit }, after: input } }, meta, tx);
    });
    return this.settings();
  }

  private dhakaToday() {
    const local = new Date(Date.now() + DHAKA_OFFSET_MS);
    return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - DHAKA_OFFSET_MS);
  }

  private readToday() {
    return this.prisma.cnCapture.count({ where: { createdAt: { gte: this.dhakaToday() }, status: { not: "SKIPPED" } } });
  }

  /** Does a new photo get read by the AI? (on, available, under today's limit) */
  private async aiAllowed() {
    const s = await this.settings();
    return s.aiEnabled && s.aiAvailable && (s.dailyLimit === null || s.readToday < s.dailyLimit);
  }

  /** CN_Scan usage between two Dhaka days: photos, AI readings, cost (scan_read_logs source CN). */
  async usage(input: z.infer<typeof cnUsageQuerySchema>) {
    const start = new Date(`${input.from}T00:00:00+06:00`);
    const end = new Date(new Date(`${input.to}T00:00:00+06:00`).getTime() + 86_400_000);
    const range = { gte: start, lt: end };
    const [photos, skipped, reads, daily] = await Promise.all([
      this.prisma.cnCapture.count({ where: { createdAt: range } }),
      this.prisma.cnCapture.count({ where: { createdAt: range, status: "SKIPPED" } }),
      this.prisma.scanReadLog.aggregate({ where: { createdAt: range, source: "CN" }, _count: { _all: true }, _sum: { costUsd: true, inputTokens: true, outputTokens: true } }),
      this.prisma.$queryRaw<{ day: string; reads: number; failed: number; cost: string | null }[]>`
        SELECT to_char("createdAt" + interval '6 hours', 'YYYY-MM-DD') AS day, count(*)::int AS reads,
               (count(*) FILTER (WHERE status = 'FAILED'))::int AS failed, sum("costUsd")::text AS cost
        FROM scan_read_logs WHERE source = 'CN' AND "createdAt" >= ${start.toISOString()}::timestamp AND "createdAt" < ${end.toISOString()}::timestamp
        GROUP BY 1 ORDER BY 1`,
    ]);
    return {
      from: input.from,
      to: input.to,
      photos,
      skipped,
      reads: reads._count._all,
      costUsd: Number(reads._sum.costUsd ?? 0),
      inputTokens: reads._sum.inputTokens ?? 0,
      outputTokens: reads._sum.outputTokens ?? 0,
      daily: daily.map(d => ({ day: d.day, reads: d.reads, failed: d.failed, costUsd: Number(d.cost ?? 0) })),
    };
  }

  // ───────────── who and where ─────────────

  /** Riders and operations staff (parcel:dispatch) use the CN_ features. */
  private assertCanScan(actor: Actor): asserts actor is UserActor {
    if (actor.kind !== "user" || (!actor.riderId && !actor.permissions.has("parcel:dispatch"))) throw forbidden("Only riders and operations staff can scan CN labels");
  }

  /** The hub of the scan: the rider's hub, or the Ops app's hub (the only one of a hub's staff). */
  private async hubOf(actor: UserActor, hubId?: string) {
    let id = hubId;
    if (actor.riderId && !actor.permissions.has("parcel:dispatch")) {
      const rider = await this.prisma.rider.findUnique({ where: { id: actor.riderId }, select: { hubId: true } });
      id = rider?.hubId ?? undefined;
      if (!id) throw new AppError("RIDER_NO_HUB", "You are not attached to a hub yet. Ask operations.", 422);
    } else if (id) assertHubInScope(actor, id, "scan CN labels for this hub");
    else {
      const scope = opsHubScope(actor);
      if (scope?.length === 1) id = scope[0];
    }
    if (!id) throw new AppError("HUB_REQUIRED", "Choose the hub you are working at", 422);
    const hub = await this.prisma.hub.findUnique({ where: { id }, select: { id: true, name: true, address: true, district: true, zone: true } });
    if (!hub) throw notFound("Hub");
    return hub;
  }

  private async activeMerchant(db: Db, merchantId: string) {
    const m = await db.merchant.findUnique({
      where: { id: merchantId },
      select: { id: true, code: true, name: true, status: true, type: true, contactName: true, contactPhone: true, pickupAddress: true, pickupArea: true, pickupDistrict: true, pickupZone: true },
    });
    if (!m) throw notFound("Merchant");
    if (m.status !== "ACTIVE") throw new AppError("MERCHANT_NOT_ACTIVE", `${m.name} isn't active`, 422);
    return m;
  }

  // ───────────── the parcel of a CN ─────────────

  /**
   * The CN's parcel: the existing one, or a new one when this is the label's first scan (the label is used up here, so
   * two scans of one label at the same moment still make one parcel). `merchantId`: CN_Merchant's merchant; a label
   * issued to a merchant (CN stock) always belongs to that merchant.
   */
  private async parcelOf(tx: Db, actor: UserActor, rawCn: string, hub: { id: string; name: string; address: string; district: string; zone: string | null }, feature: string, merchantId?: string) {
    const cn = normalizeTrackingId(rawCn);
    const existing = await tx.parcel.findUnique({ where: { trackingId: cn } });
    if (existing) return { parcel: existing, created: false };
    const stock = await tx.cnStock.findUnique({ where: { cn }, include: { batch: { select: { merchantId: true } } } });
    if (!stock) throw new AppError("CN_UNKNOWN", `${cn} isn't a CN label from our stock`, 422);
    if (stock.status === "VOID") throw new AppError("CN_VOID", `${cn} was voided and can't be used`, HttpStatus.CONFLICT);
    if (stock.batch.merchantId && merchantId && stock.batch.merchantId !== merchantId) throw new AppError("CN_NOT_YOURS", `${cn} was issued to another merchant`, HttpStatus.CONFLICT);
    const claimed = await tx.cnStock.updateMany({ where: { id: stock.id, status: "AVAILABLE" }, data: { status: "USED", usedAt: new Date() } });
    if (!claimed.count) {
      const raced = await tx.parcel.findUnique({ where: { trackingId: cn } });
      if (raced) return { parcel: raced, created: false };
      throw new AppError("CN_USED", `${cn} has already been used`, HttpStatus.CONFLICT);
    }
    const ownerId = stock.batch.merchantId ?? merchantId ?? null;
    const merchant = ownerId ? await this.activeMerchant(tx, ownerId) : null;
    const by = actor.riderId && !actor.permissions.has("parcel:dispatch") ? "Rider" : "Operations";
    const parcel = await tx.parcel.create({
      data: {
        trackingId: cn,
        channel: "OPERATIONS",
        cnFlow: true,
        merchantId: merchant?.id ?? null,
        senderName: merchant?.name ?? "CN parcel (merchant not set)",
        senderPhone: merchant?.contactPhone ?? "",
        pickupStreet: merchant?.pickupAddress ?? hub.address,
        pickupArea: merchant?.pickupArea ?? null,
        pickupZone: merchant?.pickupZone ?? hub.zone ?? hub.district,
        pickupDistrict: merchant?.pickupDistrict ?? hub.district,
        weightKg: 0.5,
        baseCharge: 0,
        weightCharge: 0,
        serviceCharge: 0,
        codFee: 0,
        totalCharge: 0,
        // Priced once its merchant is known; no message goes before that (no channel).
        pricingSnapshot: { engine: "cn-pending" },
        notifications: [],
        notifyChannels: [],
        intake: "DROP_OFF",
        dropOffHubId: hub.id,
        incomplete: true,
        missingFields: [...MISSING_FIELDS],
        events: {
          create: {
            status: "PENDING_CONFIRMATION",
            title: "CN label scanned",
            description: `${by} scanned the pre-printed label (${feature}) at ${hub.name}.`,
            location: hub.name,
            metadata: { hubId: hub.id, kind: "cn_scan", feature },
            actorUserId: actor.userId,
            actorLabel: by,
          },
        },
      },
    });
    await tx.cnStock.update({ where: { id: stock.id }, data: { parcelId: parcel.id } });
    await this.audit.record(actor, { action: "cn.parcel_create", entityType: "parcel", entityId: parcel.id, data: { trackingId: cn, feature, hubId: hub.id, merchantId: merchant?.id ?? null } }, undefined, tx);
    return { parcel: merchant ? await this.price(tx, parcel) : parcel, created: true };
  }

  /**
   * Prices a CN parcel with its merchant's service plan (to its destination, or the pickup area until that is known) and
   * turns its messages on (the plan's messages and channels). A plan that can't price it keeps 0 and sends the messages.
   */
  private async price(tx: Db, parcel: Parcel): Promise<Parcel> {
    if (!parcel.merchantId) return parcel;
    const dest = { district: parcel.deliveryDistrict ?? parcel.pickupDistrict, zone: parcel.deliveryZone ?? parcel.pickupZone };
    try {
      const quote = await this.packages.quote(
        { merchantId: parcel.merchantId },
        { pickup: { district: parcel.pickupDistrict, zone: parcel.pickupZone, area: parcel.pickupArea }, delivery: { district: dest.district, zone: dest.zone, area: parcel.deliveryArea }, weightKg: Number(parcel.weightKg), codAmount: Number(parcel.codAmount) },
        tx,
      );
      const fields = this.packages.parcelFields(quote, null);
      return await tx.parcel.update({
        where: { id: parcel.id },
        data: { ...fields, pricingSnapshot: this.packages.snapshot(quote, parcel.deliveryDistrict ? {} : { destination: dest }) },
      });
    } catch (err) {
      this.logger.warn({ err, parcel: parcel.trackingId }, "A CN parcel couldn't be priced with its merchant's plan");
      return tx.parcel.update({ where: { id: parcel.id }, data: { notifyChannels: ["sms", "email", "push"], pricingSnapshot: { engine: "cn-pending", priceError: true } } });
    }
  }

  /** After the first scan by operations: received at their hub the regular way (AT_HUB). Riders bring theirs to the hub. */
  private async receiveAtHub(actor: UserActor, parcel: Parcel, hubId: string, meta: RequestMeta) {
    if (!actor.permissions.has("parcel:dispatch") || parcel.status !== "PENDING_CONFIRMATION") return;
    try {
      await this.parcels.setStatus(actor, parcel.trackingId, { status: "AT_HUB", hubId, expectedVersion: parcel.version } as never, meta, { code: parcel.trackingId, source: "CAMERA" });
    } catch (err) {
      this.logger.warn({ err, parcel: parcel.trackingId }, "A CN parcel couldn't be received at the hub");
    }
  }

  async summary(trackingId: string) {
    const p = await this.prisma.parcel.findUniqueOrThrow({
      where: { trackingId },
      select: { trackingId: true, status: true, incomplete: true, missingFields: true, recipientName: true, recipientPhone: true, deliveryStreet: true, codAmount: true, merchant: { select: { id: true, code: true, name: true } }, currentHub: { select: { name: true } }, dropOffHub: { select: { name: true } }, _count: { select: { cnCaptures: true } } },
    });
    return {
      trackingId: p.trackingId,
      status: p.status,
      merchant: p.merchant,
      recipientName: p.recipientName,
      recipientPhone: p.recipientPhone,
      address: p.deliveryStreet,
      codAmount: Number(p.codAmount),
      hub: p.currentHub?.name ?? p.dropOffHub?.name ?? null,
      incomplete: p.incomplete,
      missingFields: p.missingFields,
      photos: p._count.cnCaptures,
    };
  }

  private publish(parcel: Pick<Parcel, "trackingId" | "merchantId" | "currentHubId" | "dropOffHubId">, type = "parcel.updated") {
    this.realtime.publish({ type, id: parcel.trackingId, merchantId: parcel.merchantId, hubIds: [parcel.currentHubId, parcel.dropOffHubId] });
  }

  // ───────────── CN_Merchant ─────────────

  /** Active merchants to choose in CN_Merchant / CN_Scan (name, code or phone; at most 30). */
  async merchants(actor: Actor, q?: string) {
    this.assertCanScan(actor);
    const term = (q ?? "").trim();
    const rows = await this.prisma.merchant.findMany({
      where: { status: "ACTIVE", ...(term ? { OR: [{ name: { contains: term, mode: "insensitive" } }, { code: { contains: term, mode: "insensitive" } }, { contactPhone: { contains: term.replace(/D/g, "").slice(-8) || term } }] } : {}) },
      orderBy: { name: "asc" },
      take: 30,
      select: { id: true, code: true, name: true, type: true },
    });
    return { items: rows };
  }


  /** CN_Merchant: the label's parcel belongs to this merchant (new parcel, or one without a merchant yet). */
  async assignMerchant(actor: Actor, input: z.infer<typeof cnMerchantSchema>, meta: RequestMeta): Promise<CnOutcome> {
    this.assertCanScan(actor);
    const hub = await this.hubOf(actor, input.hubId);
    const merchant = await this.activeMerchant(this.prisma, input.merchantId);
    const result = await this.prisma.$transaction(async tx => {
      const { parcel, created } = await this.parcelOf(tx, actor, input.cn, hub, "CN_Merchant", merchant.id);
      if (created) return { outcome: "CREATED" as const, parcel, message: `${parcel.trackingId} is now ${merchant.name}'s parcel.` };
      if (parcel.merchantId === merchant.id) return { outcome: "ALREADY" as const, parcel, message: `${parcel.trackingId} is already ${merchant.name}'s parcel.` };
      if (parcel.merchantId) {
        const other = await tx.merchant.findUnique({ where: { id: parcel.merchantId }, select: { name: true } });
        return { outcome: "OTHER_MERCHANT" as const, parcel, message: `${parcel.trackingId} belongs to ${other?.name ?? "another merchant"}. Not changed.` };
      }
      if (!parcel.cnFlow) throw new AppError("NOT_A_CN_PARCEL", `${parcel.trackingId} was booked as a customer parcel; it can't be given to a merchant here`, HttpStatus.CONFLICT);
      if (TERMINAL_STATUSES.includes(parcel.status as ParcelStatus)) throw new AppError("PARCEL_CLOSED", `${parcel.trackingId} is already finished`, HttpStatus.CONFLICT);
      const updated = await tx.parcel.update({
        where: { id: parcel.id },
        data: {
          merchantId: merchant.id,
          senderName: merchant.name,
          senderPhone: merchant.contactPhone,
          pickupStreet: merchant.pickupAddress,
          pickupArea: merchant.pickupArea,
          pickupZone: merchant.pickupZone ?? parcel.pickupZone,
          pickupDistrict: merchant.pickupDistrict,
          version: { increment: 1 },
          events: { create: { status: parcel.status, title: "Merchant set", description: `${merchant.name} (${merchant.code}), scanned with CN_Merchant.`, visibility: "INTERNAL", actorUserId: actor.userId, actorLabel: actor.riderId ? "Rider" : "Operations" } },
        },
      });
      await this.audit.record(actor, { action: "cn.merchant", entityType: "parcel", entityId: parcel.id, data: { trackingId: parcel.trackingId, merchantId: merchant.id, hubId: hub.id } }, meta, tx);
      return { outcome: "ASSIGNED" as const, parcel: await this.price(tx, updated), message: `${parcel.trackingId} is now ${merchant.name}'s parcel.` };
    });
    if (result.outcome === "CREATED") await this.receiveAtHub(actor, result.parcel, hub.id, meta);
    this.publish(result.parcel, result.outcome === "CREATED" ? "parcel.created" : "parcel.updated");
    return { outcome: result.outcome, ok: result.outcome !== "OTHER_MERCHANT", message: result.message, parcel: await this.summary(result.parcel.trackingId) };
  }

  // ───────────── CN_Scan ─────────────

  /** CN_Scan: a photo of the parcel with its CN; the AI reads it into the parcel in the background. */
  async capture(actor: Actor, input: z.infer<typeof cnCaptureFieldsSchema>, photo: { data: Buffer; mimeType: string; filename: string }, meta: RequestMeta): Promise<CnOutcome & { reading: boolean }> {
    this.assertCanScan(actor);
    const hub = await this.hubOf(actor, input.hubId);
    if (input.merchantId) await this.activeMerchant(this.prisma, input.merchantId);
    const read = await this.aiAllowed();
    let fileId: string | undefined;
    const result = await this.prisma
      .$transaction(async tx => {
        const { parcel, created } = await this.parcelOf(tx, actor, input.cn, hub, "CN_Scan", input.merchantId);
        const file = await this.storage.save({ data: photo.data, mimeType: photo.mimeType, filename: photo.filename || `${parcel.trackingId}.jpg`, uploadedById: actor.userId }, tx);
        fileId = file.id;
        const capture = await tx.cnCapture.create({
          data: { parcelId: parcel.id, cn: parcel.trackingId, fileId: file.id, status: read ? "READING" : "SKIPPED", source: actor.riderId && !actor.permissions.has("parcel:dispatch") ? "RIDER_APP" : "OPS_APP", createdById: actor.userId },
        });
        await this.audit.record(actor, { action: "cn.capture", entityType: "parcel", entityId: parcel.id, data: { trackingId: parcel.trackingId, captureId: capture.id, hubId: hub.id, read, bytes: photo.data.length } }, meta, tx);
        return { parcel, created, capture };
      })
      .catch(async error => {
        if (fileId) await this.storage.remove([fileId]).catch(() => undefined);
        throw error;
      });
    if (result.created) await this.receiveAtHub(actor, result.parcel, hub.id, meta);
    if (read) await this.enqueue(result.capture.id);
    this.publish(result.parcel, result.created ? "parcel.created" : "parcel.updated");
    const id = result.parcel.trackingId;
    return {
      outcome: result.created ? "CREATED" : "ADDED",
      ok: true,
      reading: read,
      message: `${id}: photo saved${read ? ", reading the label…" : " (AI reading is off: type the details in Courier Operations)"}.`,
      parcel: await this.summary(id),
    };
  }

  /** Background: the AI reads the photo; empty fields of the parcel are filled, differences are kept as conflicts. */
  async read(captureId: string) {
    const capture = await this.prisma.cnCapture.findUnique({ where: { id: captureId }, include: { parcel: { include: { merchant: { select: { type: true } } } } } });
    if (!capture || capture.status !== "READING" || !capture.fileId) return;
    const file = await this.prisma.storedFile.findUnique({ where: { id: capture.fileId }, select: { storageKey: true } });
    const started = Date.now();
    const kind = capture.parcel.merchant?.type === "BANKING_FINANCIAL" ? "document" : "ecommerce";
    let cells: Cells = {};
    let status: "READ" | "FAILED" = "FAILED";
    let byClaude: Awaited<ReturnType<ScanClaudeService["extract"]>> = null;
    try {
      if (!file) throw new Error("The photo is missing");
      const catalog = await this.pricing.catalog();
      byClaude = await this.claude.extract({ image: await forClaude(await this.storage.read(file.storageKey)), kind, places: catalog, lists: { speeds: [], categories: [], priorities: [] } });
      cells = (byClaude?.cells ?? {}) as Cells;
      status = Object.keys(cells).length ? "READ" : "FAILED";
    } catch (err) {
      this.logger.warn({ err, capture: captureId }, "A CN_Scan photo could not be read");
    }
    let conflicts: { field: string; parcel: string; read: string }[] = [];
    if (status === "READ") conflicts = await this.apply(capture.parcel.id, cells).catch(err => (this.logger.warn({ err, capture: captureId }, "CN_Scan details couldn't be applied"), []));
    await this.prisma.cnCapture.update({ where: { id: captureId }, data: { status, cells: cells as object, conflicts, readAt: new Date() } });
    await this.prisma.scanReadLog
      .create({
        data: {
          source: "CN",
          captureId,
          kind: kind === "document" ? "DOCUMENT" : "ECOMMERCE",
          merchantId: capture.parcel.merchantId,
          userId: capture.createdById,
          reader: "CLAUDE",
          model: byClaude?.model ?? null,
          status,
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
      .catch(err => this.logger.warn({ err, capture: captureId }, "Could not log a CN_Scan reading"));
    this.publish(capture.parcel);
  }

  /** The read fields into the parcel: only empty ones are filled; a different value is returned as a conflict. */
  private async apply(parcelId: string, cells: Cells) {
    const catalog = await this.pricing.catalog();
    return this.prisma.$transaction(async tx => {
      const p = await tx.parcel.findUniqueOrThrow({ where: { id: parcelId } });
      if (["DELIVERED", "RETURNED", "PICKUP_CANCELLED"].includes(p.status)) return [];
      const conflicts: { field: string; parcel: string; read: string }[] = [];
      const data: Record<string, unknown> = {};
      const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
      const put = (field: string, label: string, current: string | null | undefined, value: string, write: () => void) => {
        if (!value) return;
        if (!current || !String(current).trim()) write();
        else if (String(current).trim().toLowerCase() !== value.toLowerCase()) conflicts.push({ field: label, parcel: String(current), read: value });
      };
      put("recipientName", "recipient name", p.recipientName, text(cells.recipient_name).slice(0, 120), () => (data.recipientName = text(cells.recipient_name).slice(0, 120)));
      const phone = text(cells.recipient_phone);
      if (phone && isBdMobile(phone)) {
        const e164 = normalizeBdPhone(phone);
        put("recipientPhone", "recipient phone", p.recipientPhone, e164, () => (data.recipientPhone = e164));
      }
      put("deliveryStreet", "delivery address", p.deliveryStreet, text(cells.address).slice(0, 200), () => (data.deliveryStreet = text(cells.address).slice(0, 200)));
      const place = resolvePlace(catalog, text(cells.district) || null, text(cells.zone) || null);
      if (place.ok && place.district) {
        put("deliveryDistrict", "district", p.deliveryDistrict, place.district, () => (data.deliveryDistrict = place.district));
        if (place.zone) put("deliveryZone", "zone", p.deliveryZone, place.zone, () => (data.deliveryZone = place.zone));
      }
      put("deliveryArea", "area", p.deliveryArea, text(cells.area).slice(0, 120), () => (data.deliveryArea = text(cells.area).slice(0, 120)));
      const cod = Number(text(cells.cod_amount).replace(/[^\d.]/g, ""));
      if (Number.isFinite(cod) && cod > 0 && cod < 10_000_000) {
        if (Number(p.codAmount) === 0) data.codAmount = cod;
        else if (Number(p.codAmount) !== cod) conflicts.push({ field: "COD", parcel: String(Number(p.codAmount)), read: String(cod) });
      }
      put("instructions", "instructions", p.instructions, text(cells.instructions).slice(0, 500), () => (data.instructions = text(cells.instructions).slice(0, 500)));
      if (!Object.keys(data).length) return conflicts;
      const next = { ...p, ...data } as Parcel;
      const missing = missingFieldsOf(next);
      let updated = await tx.parcel.update({
        where: { id: p.id },
        data: {
          ...data,
          incomplete: missing.length > 0,
          missingFields: missing,
          version: { increment: 1 },
          events: { create: { status: p.status, title: "Details read from the CN photo", description: `Filled in: ${Object.keys(data).join(", ")}.`, visibility: "INTERNAL", actorLabel: "CN_Scan AI" } },
        },
      });
      // Re-priced to the destination / COD now known (with its merchant's plan).
      if (updated.merchantId && (data.deliveryDistrict || data.codAmount !== undefined)) updated = await this.price(tx, updated);
      return conflicts;
    });
  }

  /** A parcel's CN_Scan photos (Courier Operations parcel details): what was read and what differed. */
  async captures(actor: Actor, trackingId: string) {
    if (actor.kind !== "user") throw forbidden("Not allowed");
    const parcel = await this.prisma.parcel.findUnique({ where: { trackingId: normalizeTrackingId(trackingId) }, select: { id: true } });
    if (!parcel) throw notFound("Parcel");
    const rows = await this.prisma.cnCapture.findMany({ where: { parcelId: parcel.id }, orderBy: { createdAt: "desc" }, take: 20 });
    return { items: rows.map(r => ({ id: r.id, status: r.status, source: r.source, cells: r.cells, conflicts: r.conflicts, createdAt: r.createdAt, readAt: r.readAt })) };
  }

  async photo(id: string) {
    const row = await this.prisma.cnCapture.findUnique({ where: { id }, select: { fileId: true } });
    const file = row?.fileId ? await this.prisma.storedFile.findUnique({ where: { id: row.fileId }, select: { storageKey: true, mimeType: true } }) : null;
    if (!file) throw notFound("Photo");
    return { data: await this.storage.read(file.storageKey), mimeType: file.mimeType };
  }
}
