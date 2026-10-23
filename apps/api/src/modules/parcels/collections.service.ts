import { HttpStatus, Inject, Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { operationNow } from "../../common/operation-time";
import { z } from "zod";
import { Prisma } from "../../generated/prisma/client";
import { PrismaService, type Db } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { QueueService } from "../../common/queues";
import { StorageService } from "../../common/storage.service";
import { AppError, forbidden } from "../../common/errors";
import { decrypt, encrypt, randomDigits, safeEqual } from "../../common/crypto";
import type { Actor, UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { runsJobs } from "../../config/env";
import { NotifyService } from "../notifications/notify.service";
import { LedgerService, credit, debit } from "../finance/ledger.service";
import { PackagesService } from "../packages/packages.service";
import { ParcelsService } from "./parcels.service";
import { ParcelWorkflowService, type AfterCommit } from "./parcel-workflow.service";
import { parcelInclude, parcelView } from "./parcel.views";
import { opsHubScope } from "./ops-scope";
import { returnChargeFor } from "../returns/return-charge";
import { trackingUrl } from "./parcel-access";

const amount = z.coerce.number().min(0).max(1_000_000).transform(n => Math.round(n * 100) / 100);
const image = z
  .string()
  .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, "Must be a PNG, JPEG or WebP image")
  .max(3_000_000, "Image is too large (max ~2 MB)");

/** Hub counter hand-over of a collect-from-hub parcel: the collection code, or a photo / signature when the recipient lost it. */
export const collectSchema = z
  .object({
    code: z.string().trim().regex(/^\d{4,8}$/, "Enter the recipient's collection code").optional(),
    proof: z.object({ method: z.enum(["PHOTO", "SIGNATURE"]), image }).optional(),
    receivedBy: z.string().trim().min(1, "Enter who collected it").max(120),
    /** Cash paid at the counter; must equal the parcel's COD amount. */
    codCollected: amount.default(0),
    note: z.string().trim().max(500).optional(),
    expectedVersion: z.number().int().min(0).optional(),
  })
  .refine(v => v.code || v.proof, { message: "Enter the collection code, or take a photo / signature of the recipient's ID", path: ["code"] });

export const listCollectionsQuerySchema = z.object({
  hubId: z.uuid().optional(),
  /** ready (default): waiting at the hub; due: hold period ends within a day; all: also on the way to the hub. */
  state: z.enum(["ready", "due", "all"]).default("ready"),
  q: z.string().trim().max(80).optional(),
});

const dhakaDate = (d: Date) => d.toLocaleDateString("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short" });

/**
 * Collect from hub (service packages): the parcels waiting at a hub for their recipient, the counter
 * hand-over (code or proof, COD into hub cash) and the hold period job (reminder, then return).
 */
@Injectable()
export class CollectionsService implements OnApplicationBootstrap {
  private readonly logger = new Logger("Collections");

  constructor(
    private readonly prisma: PrismaService,
    private readonly parcels: ParcelsService,
    private readonly workflow: ParcelWorkflowService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly queues: QueueService,
  ) {}

  @Inject(NotifyService) private readonly notify!: NotifyService;
  @Inject(LedgerService) private readonly ledger!: LedgerService;
  @Inject(PackagesService) private readonly packages!: PackagesService;

  onApplicationBootstrap() {
    if (!runsJobs()) return;
    void this.queues
      .schedule("collect-from-hub", "*/15 * * * *", async () => {
        const result = await this.sweep();
        if (result.reminded || result.returned) this.logger.log(`Collect from hub: ${result.reminded} reminders, ${result.returned} sent back`);
      })
      .catch(err => this.logger.error({ err }, "Could not schedule the collect-from-hub job"));
  }

  private hubScope(actor: Actor, hubId?: string) {
    const scope = opsHubScope(actor);
    if (hubId && scope && !scope.includes(hubId)) throw forbidden("You can only see your own hub's collections");
    return hubId ? [hubId] : scope;
  }

  async list(actor: Actor, query: z.infer<typeof listCollectionsQuerySchema>) {
    const hubs = this.hubScope(actor, query.hubId);
    const soon = new Date(Date.now() + 86_400_000);
    const rows = await this.prisma.parcel.findMany({
      where: {
        lastMile: "HUB_COLLECT",
        ...(hubs ? { collectHubId: { in: hubs } } : {}),
        ...(query.state === "all"
          ? { status: { notIn: ["DELIVERED", "RETURNED", "PICKUP_CANCELLED"] } }
          : query.state === "due"
            ? { status: "READY_FOR_COLLECTION", collectionDueAt: { lte: soon } }
            : { status: "READY_FOR_COLLECTION" }),
        ...(query.q
          ? { OR: [{ trackingId: { contains: query.q, mode: "insensitive" } }, { recipientName: { contains: query.q, mode: "insensitive" } }, { recipientPhone: { contains: query.q.replace(/\D/g, "").slice(-10) || query.q } }] }
          : {}),
      },
      include: parcelInclude,
      orderBy: [{ collectionDueAt: "asc" }, { id: "asc" }],
      take: 500,
    });
    return { items: rows.map(p => parcelView(p, { internal: true })) };
  }

  /** The hub hands the parcel to the recipient: DELIVERED (collected at the hub), COD into the hub's cash. */
  async collect(actor: UserActor, trackingId: string, input: z.infer<typeof collectSchema>, meta: RequestMeta) {
    const after = this.workflow.newAfterCommit();
    await this.prisma.$transaction(
      async tx => {
        const parcel = await this.parcels.loadForUpdate(actor, trackingId, tx);
        if (parcel.lastMile !== "HUB_COLLECT") throw new AppError("NOT_COLLECT_FROM_HUB", `${parcel.trackingId} is delivered to the door, not collected at a hub`, HttpStatus.CONFLICT);
        if (parcel.status !== "READY_FOR_COLLECTION")
          throw new AppError("NOT_READY_FOR_COLLECTION", `${parcel.trackingId} isn't ready for collection yet (it must be received at the collection hub first)`, HttpStatus.CONFLICT, { status: parcel.status });
        const scope = opsHubScope(actor);
        if (scope && (!parcel.collectHubId || !scope.includes(parcel.collectHubId))) throw forbidden(`${parcel.trackingId} is collected at another hub`);
        const hub = await tx.hub.findUniqueOrThrow({ where: { id: parcel.collectHubId! }, select: { id: true, name: true } });
        const cod = Number(parcel.codAmount);
        if (cod > 0 && input.codCollected !== cod) throw new AppError("COD_MISMATCH", `Collect exactly ৳${cod.toLocaleString("en-BD")} before handing it over`, 422, { expected: cod });
        let method: "COLLECTION_CODE" | "PHOTO" | "SIGNATURE" = "COLLECTION_CODE";
        let fileId: string | undefined;
        if (input.code) {
          const expected = parcel.collectionCodeEncrypted ? decrypt(parcel.collectionCodeEncrypted) : undefined;
          if (!expected || !safeEqual(expected, input.code)) throw new AppError("INVALID_COLLECTION_CODE", "The collection code is incorrect", 422);
        } else {
          method = input.proof!.method;
          fileId = (await this.storage.saveDataUrl(input.proof!.image, `${parcel.trackingId}-collection-${method.toLowerCase()}`, actor.userId, tx)).id;
        }
        const now = operationNow();
        await this.workflow.transition(
          tx,
          parcel,
          {
            to: "DELIVERED",
            actorRole: "ops",
            data: { deliveredAt: now, attemptCount: { increment: 1 }, collectionCodeEncrypted: null, deliveryOtpEncrypted: null },
            title: `Collected at ${hub.name}`,
            description: `${input.receivedBy} collected the parcel at ${hub.name}${method === "COLLECTION_CODE" ? " with the collection code" : ` (${method === "PHOTO" ? "photo" : "signature"} proof)`}.`,
            location: hub.name,
            metadata: { hubId: hub.id, kind: "collected_at_hub" },
            internalNote: input.note,
            expectedVersion: input.expectedVersion,
          },
          actor,
          meta,
          after,
        );
        await tx.deliveryProof.create({ data: { parcelId: parcel.id, method, receivedBy: input.receivedBy, fileId, otpVerified: method === "COLLECTION_CODE", note: input.note, capturedAt: now } });
        if (cod > 0) {
          // Paid at the counter: straight into the hub's cash (no rider hand-over), settled to the merchant as usual.
          await tx.codCollection.create({ data: { parcelId: parcel.id, riderId: null, hubId: hub.id, collectedById: actor.userId, amount: cod, state: "AT_HUB", collectedAt: now } });
          await this.ledger.post(tx, {
            eventType: "COD_COLLECTED",
            reference: parcel.trackingId,
            memo: `COD paid at ${hub.name} (collect from hub)`,
            occurredAt: now,
            merchantId: parcel.merchantId,
            hubId: hub.id,
            idempotencyKey: `COD_COLLECTED:${parcel.trackingId}`,
            createdById: actor.userId,
            lines: [debit("CASH_AT_HUBS", cod, { hubId: hub.id }), credit("MERCHANT_PAYABLES", cod, { merchantId: parcel.merchantId })],
          });
        }
        await this.audit.record(actor, { action: "parcel.collect", entityType: "parcel", entityId: parcel.id, data: { trackingId: parcel.trackingId, hubId: hub.id, method, codCollected: cod } }, meta, tx);
      },
      { timeout: 15_000 },
    );
    await this.workflow.flush(after);
    return this.parcels.detail(actor, trackingId);
  }

  /** A new collection code, sent to the recipient again. */
  async resendCode(actor: Actor, trackingId: string, meta: RequestMeta) {
    const after = this.workflow.newAfterCommit();
    await this.prisma.$transaction(async tx => {
      const parcel = await this.parcels.loadForUpdate(actor, trackingId, tx);
      if (parcel.status !== "READY_FOR_COLLECTION") throw new AppError("NOT_READY_FOR_COLLECTION", `${parcel.trackingId} isn't waiting for collection`, HttpStatus.CONFLICT);
      const scope = opsHubScope(actor);
      if (scope && (!parcel.collectHubId || !scope.includes(parcel.collectHubId))) throw forbidden(`${parcel.trackingId} is collected at another hub`);
      const hub = await tx.hub.findUniqueOrThrow({ where: { id: parcel.collectHubId! }, select: { name: true, address: true } });
      const code = randomDigits(6);
      await tx.parcel.update({ where: { id: parcel.id }, data: { collectionCodeEncrypted: encrypt(code) } });
      after.outbox.push(...(await this.readyNotice(tx, parcel, hub, code)));
      await this.audit.record(actor, { action: "parcel.collection_code", entityType: "parcel", entityId: parcel.id, data: { trackingId: parcel.trackingId } }, meta, tx);
    });
    await this.workflow.flush(after);
    return this.parcels.detail(actor, trackingId);
  }

  private readyNotice(db: Db, parcel: Prisma.ParcelGetPayload<object>, hub: { name: string; address: string }, code: string) {
    return this.notify.notify(db, {
      event: "parcel.ready_for_collection",
      to: { phone: parcel.recipientPhone, name: parcel.recipientName },
      vars: {
        trackingId: parcel.trackingId,
        hub: hub.name,
        hubAddress: hub.address,
        code,
        codAmount: Number(parcel.codAmount) > 0 ? Number(parcel.codAmount).toLocaleString("en-BD") : "",
        until: parcel.collectionDueAt ? dhakaDate(parcel.collectionDueAt) : "",
        trackingUrl: trackingUrl(parcel.trackingId),
      },
      parcel,
    });
  }

  /**
   * The hold period (every 15 minutes): a reminder `collectReminderHours` before it ends, then the
   * parcels nobody collected go to Return scheduled (with the return charge).
   */
  async sweep(now = new Date()) {
    const settings = await this.packages.settings();
    let reminded = 0;
    let returned = 0;
    if (settings.collectReminderHours > 0) {
      const due = await this.prisma.parcel.findMany({
        where: { status: "READY_FOR_COLLECTION", collectionReminderAt: null, collectionDueAt: { gt: now, lte: new Date(now.getTime() + settings.collectReminderHours * 3_600_000) } },
        take: 500,
      });
      for (const parcel of due) {
        const outbox = await this.prisma.$transaction(async tx => {
          const { count } = await tx.parcel.updateMany({ where: { id: parcel.id, collectionReminderAt: null, status: "READY_FOR_COLLECTION" }, data: { collectionReminderAt: now } });
          if (!count) return [];
          const hub = parcel.collectHubId ? await tx.hub.findUnique({ where: { id: parcel.collectHubId }, select: { name: true, address: true } }) : null;
          return this.notify.notify(tx, {
            event: "parcel.collection_reminder",
            to: { phone: parcel.recipientPhone, name: parcel.recipientName },
            vars: {
              trackingId: parcel.trackingId,
              hub: hub?.name ?? "the hub",
              hubAddress: hub?.address ?? "",
              code: parcel.collectionCodeEncrypted ? decrypt(parcel.collectionCodeEncrypted) : "",
              until: parcel.collectionDueAt ? dhakaDate(parcel.collectionDueAt) : "",
              trackingUrl: trackingUrl(parcel.trackingId),
            },
            parcel,
          });
        });
        await this.workflow.flush({ outbox, webhooks: [], realtime: [] });
        reminded++;
      }
    }
    const expired = await this.prisma.parcel.findMany({ where: { status: "READY_FOR_COLLECTION", collectionDueAt: { lte: now } }, take: 500 });
    for (const parcel of expired) {
      const after: AfterCommit = this.workflow.newAfterCommit();
      try {
        await this.prisma.$transaction(async tx => {
          const fresh = await tx.parcel.findUniqueOrThrow({ where: { id: parcel.id } });
          if (fresh.status !== "READY_FOR_COLLECTION") return;
          const reason = `Not collected within ${settings.collectHoldDays} day${settings.collectHoldDays === 1 ? "" : "s"}`;
          await this.workflow.transition(
            tx,
            fresh,
            {
              to: "RETURN_SCHEDULED",
              actorRole: "ops",
              data: { returnReason: reason, returnRequestedAt: now, returnRequestedBy: "System (collect from hub)", returnCharge: fresh.returnCharge ?? returnChargeFor(fresh), collectionCodeEncrypted: null },
              title: "Return scheduled",
              description: `${reason}: the parcel goes back to the sender.`,
              metadata: { kind: "collection_expired" },
            },
            "system",
            undefined,
            after,
          );
        });
        await this.workflow.flush(after);
        returned++;
      } catch (err) {
        this.logger.warn({ err, trackingId: parcel.trackingId }, "Could not schedule the return of an uncollected parcel");
      }
    }
    return { reminded, returned };
  }
}

