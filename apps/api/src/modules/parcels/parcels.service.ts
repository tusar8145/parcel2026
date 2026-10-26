import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { InboxService } from "../notifications/inbox.service";
import { notifyRider } from "../notifications/new-work";
import { notifyNewWork } from "../notifications/new-work";
import { deliveryHubsOf } from "./delivery-hub";
import { operationNow } from "../../common/operation-time";
import type { z } from "zod";
import { isCustomerCancellable, parcelPrefix, type CreateParcelInput, type ParcelStatus } from "@delivery-fast/shared";
import { TERMINAL_STATUSES, type assignRiderSchema, type cancelParcelSchema, type listParcelsQuerySchema, type updateStatusSchema } from "@delivery-fast/shared";
import { PrismaService, type Db } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { OutboxService } from "../notifications/outbox.service";
import { WebhooksService } from "../notifications/webhooks.service";
import { NotifyService } from "../notifications/notify.service";
import { PricingService } from "../pricing/pricing.service";
import { actorLabel, hasRole, merchantIdsOf, type Actor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { AppError, forbidden, notFound } from "../../common/errors";
import { nextTrackingId, normalizeTrackingId } from "../../common/counters";
import { parcelInclude, parcelView, publicTrackingView, type ParcelWithRelations } from "./parcel.views";
import { ParcelWorkflowService, parcelEvent, type AfterCommit } from "./parcel-workflow.service";
import { assertRiderAssignable, opsHubScope } from "./ops-scope";
import { failureWhere, forHubsWhere, lineWhere, stageWhere, type stageFilterSchema } from "./parcel-stages";
import type { parcelNoteSchema, updateParcelDetailsSchema } from "./parcels.schemas";
import type { Parcel, ParcelChannel, Prisma, ScanSource, Segment } from "../../generated/prisma/client";
import { PickupSlotsService } from "./pickup-slots.service";
import { canSeeLiveLocation, signParcelAccess, trackingUrl } from "./parcel-access";
import { returnChargeFor } from "../returns/return-charge";
import { claimCn, linkCn } from "../cn-stock/cn-consume";
import { slaDueDates } from "../sla/sla-policy";
import { missingFieldsOf } from "./incomplete";
import { assertActivePlaces } from "../geography/geo-catalog";
import { PackagesService, type PackageQuote } from "../packages/packages.service";
import { SPEED_LABEL, type ProductType } from "@delivery-fast/shared";

/** The recipient and the merchant stop seeing the rider's position when the last fix is older than this. */
export const LIVE_LOCATION_STALE_MINUTES = 15;

const isStaff = (actor: Actor) => actor.permissions.has("parcel:read:any");

/** Who a booking is for and how it is priced. */
export interface BookingContext {
  channel: ParcelChannel;
  customerId: string | null;
  merchantId: string | null;
  segment: Segment;
  discountPercent: number;
  actorLabel: string;
}

/** Booked for hub drop-off (operations bookings): the hub the sender brings the parcel to. */
export interface DropOffBooking {
  hub: { id: string; name: string; address: string };
}

/** Optional facts about an operations booking. */
export interface BookingOptions {
  merchantId?: string;
  dropOff?: DropOffBooking;
  /** The spreadsheet import (BookingBatch) the parcel belongs to. */
  batchId?: string;
  /** Run inside the caller's transaction (imports book a chunk of rows per transaction); the caller flushes `after`. */
  tx?: Db;
  after?: AfterCommit;
  /** false: no booking SMS/email to the sender (imports send one summary instead). */
  notify?: boolean;
  /** Booked from a spreadsheet import (modules/imports): row key, and the delivery details still missing. */
  import?: { jobId: string; key?: string; missingFields: string[]; destination?: { district: string; zone: string } };
  /** Already priced and checked against the package (imports re-check each row with PackagesService.quote). */
  quote?: PackageQuote;
  /** The product, when already resolved (null = none). */
  /** id null: a product name that isn't listed (E-commerce imports), priced as Regular. */
  product?: { id: string | null; name: string; type: string; sendMessages: boolean } | null;
}

/** A booking whose delivery details may be missing (imports book incomplete orders; see parcels/incomplete.ts). */
export type BookingInput = Omit<CreateParcelInput, "recipient" | "delivery"> & {
  recipient: { name: string | null; phone: string | null };
  delivery: Omit<CreateParcelInput["delivery"], "street" | "zone" | "district"> & { street: string | null; zone: string | null; district: string | null };
};

/** Rough promise shown to customers; operations can refine it later. */
function estimateDelivery(serviceLevel: string, sameDistrict: boolean) {
  const now = new Date();
  const hours = serviceLevel === "SAME_DAY" ? 10 : serviceLevel === "EXPRESS" ? 24 : sameDistrict ? 48 : 72;
  return new Date(now.getTime() + hours * 3600_000);
}

@Injectable()
export class ParcelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingService,
    private readonly workflow: ParcelWorkflowService,
    private readonly outbox: OutboxService,
    private readonly webhooks: WebhooksService,
    private readonly audit: AuditService,
    private readonly pickupSlots: PickupSlotsService,
  ) {}

  /** Booking notices (property injection keeps the constructor stable for parallel edits). */
  @Inject(NotifyService) private readonly notifications!: NotifyService;
  /** Service packages: defaults, enforcement and prices (global module). */
  @Inject(PackagesService) private readonly packages!: PackagesService;
  @Inject(InboxService) private readonly inbox!: InboxService;

  /** Parcels this actor may see. */
  scope(actor: Actor): Prisma.ParcelWhereInput {
    if (isStaff(actor)) return {};
    const or: Prisma.ParcelWhereInput[] = [];
    const merchants = merchantIdsOf(actor);
    if (merchants.length) or.push({ merchantId: { in: merchants } });
    if (actor.kind === "user") {
      if (hasRole(actor, "CUSTOMER")) or.push({ customerId: actor.userId });
      if (actor.riderId) or.push({ pickupRiderId: actor.riderId }, { deliveryRiderId: actor.riderId });
      // A franchise account: parcels at, dropped at, collected from or assigned for pickup to its hub, or carried by its riders.
      const hubs = actor.roles.flatMap(r => (r.role === "FRANCHISE" && r.hubId ? [r.hubId] : []));
      if (hubs.length) {
        const inHubs = { in: hubs };
        or.push({ currentHubId: inHubs }, { dropOffHubId: inHubs }, { collectHubId: inHubs }, { pickupHubId: inHubs }, { pickupRider: { hubId: inHubs } }, { deliveryRider: { hubId: inHubs } });
      }
    }
    return or.length ? { OR: or } : { id: "00000000-0000-0000-0000-000000000000" };
  }

  // ───────────── booking ─────────────

  async create(actor: Actor, input: CreateParcelInput, meta: RequestMeta, opts: BookingOptions = {}) {
    const ctx = await this.bookingContext(actor, opts.merchantId);
    const parcel = await this.book(actor, ctx, input, meta, undefined, opts);
    return this.detail(actor, parcel.trackingId);
  }

  /**
   * Website booking without an account; the sender's phone was verified by SMS
   * (GuestBookingService). `inTransaction` runs before commit (e.g. to use up the verification).
   */
  createForGuest(input: CreateParcelInput, meta: RequestMeta, inTransaction?: (tx: Db, parcel: Parcel) => Promise<void>) {
    const ctx: BookingContext = { channel: "WEBSITE", customerId: null, merchantId: null, segment: "CUSTOMER", discountPercent: 0, actorLabel: "Guest sender (phone verified)" };
    return this.book("guest", ctx, input, meta, inTransaction);
  }

  private async book(
    actor: Actor | "guest",
    ctx: BookingContext,
    input: BookingInput,
    meta: RequestMeta,
    inTransaction?: (tx: Db, parcel: Parcel) => Promise<void>,
    opts: BookingOptions = {},
  ) {
    const after = opts.after ?? this.workflow.newAfterCommit();
    // Hub drop-off: chosen by operations (opts.dropOff) or in the booking (first mile HUB_DROP, see the package).
    let dropOff = opts.dropOff;
    const droppingOff = !!dropOff || input.firstMile === "HUB_DROP";
    // Priced (and SLA'd) to the destination; an incomplete import row uses the import's default until completed.
    const dest = {
      district: input.delivery.district ?? opts.import?.destination?.district ?? input.pickup.district,
      zone: input.delivery.zone ?? opts.import?.destination?.zone ?? input.pickup.zone,
    };
    const run = async (tx: Db) => {
      // Deactivated districts / zones / areas take no new bookings (imports checked them per row already).
      if (!opts.import)
        await assertActivePlaces(tx, [
          { label: "delivery address", place: input.delivery },
          ...(droppingOff ? [] : [{ label: "pickup address", place: input.pickup }]),
        ]);
      // Website bookings must use one of the offered pickup slots (capacity is checked under a lock).
      if (input.pickupWindow) await this.pickupSlots.assertBookable(tx, input.pickupWindow, { strict: ctx.channel === "WEBSITE", district: input.pickup.district });
      if (ctx.merchantId && input.merchantOrderRef) {
        const dup = await tx.parcel.findUnique({ where: { merchantId_merchantOrderRef: { merchantId: ctx.merchantId, merchantOrderRef: input.merchantOrderRef } } });
        if (dup) throw new AppError("DUPLICATE_ORDER_REF", `Order ${input.merchantOrderRef} was already booked as ${dup.trackingId}`, HttpStatus.CONFLICT, { trackingId: dup.trackingId });
      }
      // The service package: defaults, enforcement (SERVICE_NOT_IN_PACKAGE) and the price (docs: "Service packages & pricing").
      // The product (optional) prices by its type: none = Regular.
      const subject = ctx.merchantId ? { merchantId: ctx.merchantId } : { segment: "CUSTOMER" as const };
      const pkg = opts.quote ? undefined : await this.packages.effective(subject, tx);
      const product = opts.product !== undefined ? opts.product : await this.packages.resolveProduct(pkg?.segment ?? "CUSTOMER", input.product, tx, undefined, input.contents);
      const quote =
        opts.quote ??
        (await this.packages.quote(
          subject,
          {
            pickup: { district: input.pickup.district, zone: input.pickup.zone, area: input.pickup.area },
            delivery: { district: dest.district, zone: dest.zone, area: input.delivery.area },
            weightKg: input.weightKg,
            codAmount: input.codAmount,
            productType: (product?.type as ProductType | undefined) ?? "REGULAR",
            // Drop-offs are priced from the drop-off hub, not the pickup address.
            firstMile: dropOff ? "HUB_DROP" : input.firstMile,
            dropHubId: dropOff?.hub.id ?? input.dropHubId,
            lastMile: input.lastMile,
            collectHubId: input.collectHubId,
            speed: input.speed,
            openBox: input.openBox,
            notifications: input.notifications,
            serviceLevel: input.serviceLevel,
            documentType: input.documentType,
          },
          tx,
          { pkg },
        ));
      const fields = this.packages.parcelFields(quote, product);
      if (!dropOff && quote.dropHub) dropOff = { hub: { id: quote.dropHub.id, name: quote.dropHub.name, address: quote.dropHub.address } };
      const handling = ["B2B", "TRADE", "URGENT"].includes(quote.selection.speed) ? SPEED_LABEL[quote.selection.speed] : undefined;
      // A pre-printed CN label (CN stock) becomes the tracking ID; otherwise a new one is issued.
      const cn = input.cn ? await claimCn(tx, input.cn, { merchantId: ctx.merchantId, channel: ctx.channel }) : null;
      const trackingId = cn?.cn ?? (await nextTrackingId(tx, parcelPrefix(quote.segment)));
      const due = await slaDueDates(tx, {
        serviceLevel: quote.serviceLevel,
        pickupDistrict: input.pickup.district,
        pickupZone: input.pickup.zone,
        deliveryDistrict: dest.district,
        deliveryZone: dest.zone,
        pickupWindowEnd: input.pickupWindow?.end,
      });
      const created = await tx.parcel.create({
        data: {
          trackingId,
          channel: ctx.channel,
          customerId: ctx.customerId,
          merchantId: ctx.merchantId,
          merchantOrderRef: input.merchantOrderRef,
          senderName: input.sender.name,
          senderPhone: input.sender.phone,
          pickupCategory: input.pickup.category,
          pickupStreet: input.pickup.street,
          pickupArea: input.pickup.area,
          pickupZone: input.pickup.zone,
          pickupDistrict: input.pickup.district,
          recipientName: input.recipient.name,
          recipientPhone: input.recipient.phone,
          deliveryCategory: input.delivery.category,
          deliveryStreet: input.delivery.street,
          deliveryArea: input.delivery.area,
          deliveryZone: input.delivery.zone,
          deliveryDistrict: input.delivery.district,
          type: input.type,
          weightKg: quote.selection.weightKg,
          packaging: input.packaging,
          contents: input.contents ?? product?.name,
          documentType: input.type === "DOCUMENT" || quote.segment === "BANKING_FINANCIAL" ? (handling ?? input.documentType ?? null) : null,
          declaredValue: input.declaredValue,
          instructions: input.instructions,
          receiverRelation: input.receiverRelation,
          originBranchCode: input.originBranchCode,
          codAmount: input.codAmount,
          ...fields,
          pricingSnapshot: this.packages.snapshot(quote, opts.import?.missingFields.length ? { destination: dest } : {}),
          estimatedDeliveryAt: estimateDelivery(quote.serviceLevel, input.pickup.district === dest.district),
          pickupWindowStart: input.pickupWindow?.start,
          pickupWindowEnd: input.pickupWindow?.end,
          // Drop-offs have no pickup leg; their delivery SLA starts when the hub receives them.
          pickupDueAt: dropOff ? null : due.pickupDueAt,
          deliveryDueAt: dropOff ? null : due.deliveryDueAt,
          intake: dropOff ? "DROP_OFF" : "PICKUP",
          dropOffHubId: dropOff?.hub.id,
          bookingBatchId: opts.batchId,
          incomplete: !!opts.import?.missingFields.length,
          missingFields: opts.import?.missingFields ?? [],
          importJobId: opts.import?.jobId,
          importKey: opts.import?.key,
          pickupLat: input.pickup.lat,
          pickupLng: input.pickup.lng,
          deliveryLat: input.delivery.lat,
          deliveryLng: input.delivery.lng,
          events: {
            create: {
              status: "PENDING_CONFIRMATION",
              ...(dropOff
                ? {
                    title: `Booked for drop-off at ${dropOff.hub.name}`,
                    description: `Awaiting drop-off at ${dropOff.hub.name} (${dropOff.hub.address}). The parcel is on its way once the hub receives it.`,
                    location: dropOff.hub.name,
                    metadata: { hubId: dropOff.hub.id, kind: "drop_off_booked" },
                  }
                : { title: "Pickup request submitted", description: "We received the request. Operations will confirm it shortly.", location: "Delivery Fast" }),
              actorUserId: actor !== "guest" && actor.kind === "user" ? actor.userId : null,
              actorLabel: ctx.actorLabel,
            },
          },
        },
      });
      if (opts.notify !== false)
        after.outbox.push(
        ...(await this.notifications.notify(tx, {
          event: dropOff ? "parcel.drop_off_booked" : "parcel.booked",
          to: { phone: input.sender.phone, userId: ctx.customerId, name: input.sender.name },
          parcel: { packageVersionId: fields.packageVersionId, notifications: fields.notifications },
          vars: {
            trackingId,
            charge: quote.totalCharge,
            trackingUrl: trackingUrl(trackingId, actor === "guest" ? signParcelAccess(trackingId, "owner") : undefined),
            ...(dropOff ? { hub: dropOff.hub.name, hubAddress: dropOff.hub.address } : {}),
          },
        })),
      );
      after.webhooks.push(
        ...(await this.webhooks.emit(tx, ctx.merchantId, "pickup.requested", {
          trackingId,
          merchantOrderRef: input.merchantOrderRef ?? null,
          totalCharge: quote.totalCharge,
          charges: quote.lines.map(l => ({ ...l })),
          intake: dropOff ? "DROP_OFF" : "PICKUP",
          firstMile: quote.selection.firstMile,
          lastMile: quote.selection.lastMile,
          speed: quote.selection.speed,
          ...(dropOff ? { dropOffHub: { id: dropOff.hub.id, name: dropOff.hub.name } } : {}),
          ...(quote.collectHub ? { collectHub: { id: quote.collectHub.id, name: quote.collectHub.name } } : {}),
        })),
      );
      if (ctx.customerId && input.saveAddresses) await this.saveToAddressBook(tx, ctx.customerId, input as CreateParcelInput);
      await this.audit.record(
        actor === "guest" ? "system" : actor,
        {
          action: "parcel.create",
          entityType: "parcel",
          entityId: created.id,
          data: actor === "guest" ? { trackingId, guest: true } : { trackingId, ...(dropOff ? { intake: "DROP_OFF", dropOffHubId: dropOff.hub.id } : {}), ...(opts.batchId ? { batchId: opts.batchId } : {}), ...(opts.import ? { importJobId: opts.import.jobId, missingFields: opts.import.missingFields } : {}) },
        },
        meta,
        tx,
      );
      if (cn) await linkCn(tx, cn.stockId, created.id);
      // Courier Operations' bell: a merchant booked an order (operations managers, and the hub it starts at).
      if (ctx.merchantId && (ctx.channel === "MERCHANT_PORTAL" || ctx.channel === "MERCHANT_API") && !opts.import) {
        const merchant = await tx.merchant.findUnique({ where: { id: ctx.merchantId }, select: { name: true, pickupHubId: true } });
        await notifyNewWork(this.inbox, tx, {
          hubId: dropOff?.hub.id ?? merchant?.pickupHubId,
          type: "staff.merchant_order",
          title: `New order from ${merchant?.name ?? "a merchant"}`,
          body: `${trackingId} · ${dropOff ? `drop-off at ${dropOff.hub.name}` : "rider pickup"} · to ${[dest.zone, dest.district].filter(Boolean).join(", ")}`,
          target: { page: "new-orders" },
        });
      }
      if (inTransaction) await inTransaction(tx, created);
      after.realtime.push(parcelEvent(created, "parcel.created"));
      return created;
    };
    const parcel = opts.tx ? await run(opts.tx) : await this.prisma.$transaction(run);
    if (!opts.after) await this.workflow.flush(after);
    return parcel;
  }

  /** Imports (modules/imports): who books for this merchant and how it is priced, resolved once per file. */
  importContext(actor: Actor, merchantId: string) {
    return this.bookingContext(actor, merchantId);
  }

  /** Imports: books one row with a context from importContext(), usually inside the chunk's transaction (opts.tx/after). */
  bookImported(actor: Actor, ctx: BookingContext, input: BookingInput, meta: RequestMeta, opts: BookingOptions) {
    return this.book(actor, ctx, input, meta, undefined, opts);
  }

  private async bookingContext(actor: Actor, requestedMerchantId?: string): Promise<BookingContext> {
    if (actor.kind === "api_key") return this.merchantContext(actor.apiKeyId, actor.merchantId, "MERCHANT_API", actor.name);
    const merchants = merchantIdsOf(actor);
    const merchantId = requestedMerchantId ?? (merchants.length === 1 && !hasRole(actor, "CUSTOMER") ? merchants[0] : undefined);
    if (merchantId) {
      if (!merchants.includes(merchantId) && !isStaff(actor)) throw forbidden("You can't book for this merchant");
      return this.merchantContext(actor.userId, merchantId, isStaff(actor) && !merchants.includes(merchantId) ? "OPERATIONS" : "MERCHANT_PORTAL", actor.name);
    }
    // A franchise books walk-ins at its counter like hub staff (website customer prices); it has no merchants of its own.
    const franchise = hasRole(actor, "FRANCHISE");
    if (!hasRole(actor, "CUSTOMER") && !isStaff(actor) && !franchise) throw forbidden("Only customers and merchants can book parcels");
    return {
      channel: (isStaff(actor) || franchise) && !hasRole(actor, "CUSTOMER") ? ("OPERATIONS" as const) : ("WEBSITE" as const),
      customerId: hasRole(actor, "CUSTOMER") && !franchise ? actor.userId : null,
      merchantId: null,
      segment: "CUSTOMER" as Segment,
      discountPercent: 0,
      actorLabel: franchise ? "Franchise counter" : "Customer",
    };
  }

  private async merchantContext(_by: string, merchantId: string, channel: "MERCHANT_API" | "MERCHANT_PORTAL" | "OPERATIONS", label: string) {
    const merchant = await this.prisma.merchant.findUnique({ where: { id: merchantId }, include: { plan: true } });
    if (!merchant) throw notFound("Merchant");
    if (merchant.status !== "ACTIVE") throw forbidden("This merchant account is not active yet");
    return {
      channel,
      customerId: null,
      merchantId,
      segment: (merchant.type === "BANKING_FINANCIAL" ? "BANKING_FINANCIAL" : "ECOMMERCE") as Segment,
      discountPercent: merchant.plan ? Number(merchant.plan.discountPct) : 0,
      actorLabel: `${merchant.name} (${label})`,
    };
  }

  private async saveToAddressBook(tx: Db, userId: string, input: CreateParcelInput) {
    const entries = [
      { role: "PICKUP" as const, contactName: input.sender.name, phone: input.sender.phone, ...input.pickup },
      { role: "RECEIVER" as const, contactName: input.recipient.name, phone: input.recipient.phone, ...input.delivery },
    ];
    for (const e of entries) {
      const existing = await tx.address.findFirst({
        where: { userId, role: e.role, phone: e.phone, street: e.street, zone: e.zone, district: e.district, area: e.area ?? null, category: e.category },
      });
      if (existing) await tx.address.update({ where: { id: existing.id }, data: { contactName: e.contactName } });
      else if ((await tx.address.count({ where: { userId } })) < 50)
        // Same cap as the address book API; bookings still succeed once it's full.
        await tx.address.create({
          data: { userId, role: e.role, category: e.category, contactName: e.contactName, phone: e.phone, street: e.street, area: e.area, zone: e.zone, district: e.district },
        });
    }
  }

  // ───────────── reading ─────────────

  async list(actor: Actor, query: z.infer<typeof listParcelsQuerySchema> & Partial<z.infer<typeof stageFilterSchema>>) {
    const q = query.q?.trim();
    const where: Prisma.ParcelWhereInput = {
      AND: [
        this.scope(actor),
        // Courier Operations' paged lists: journey stage, service line and "my hub" (parcel-stages.ts).
        query.stage ? stageWhere(query.stage) : {},
        query.line ? lineWhere(query.line) : {},
        query.forHubIds?.length ? await forHubsWhere(this.prisma, query.forHubIds) : {},
        // Failed deliveries (stage=failed equivalent) and "failed before" (any failed attempt).
        ...failureWhere(query),
        {
          status: query.status?.length ? { in: query.status } : undefined,
          channel: query.channel,
          merchantId: query.merchantId,
          currentHubId: query.hubId,
          intake: query.intake,
          dropOffHubId: query.dropOffHubId,
          bookingBatchId: query.batchId,
          incomplete: query.incomplete,
          createdAt: query.from || query.to ? { gte: query.from, lte: query.to } : undefined,
          ...(query.riderId ? { OR: [{ pickupRiderId: query.riderId }, { deliveryRiderId: query.riderId }] } : {}),
        },
        q
          ? {
              OR: [
                { trackingId: { contains: q, mode: "insensitive" } },
                { merchantOrderRef: { contains: q, mode: "insensitive" } },
                { recipientName: { contains: q, mode: "insensitive" } },
                { senderName: { contains: q, mode: "insensitive" } },
                // Phones only for phone-like text (+880 1712-345678, 01712…, 1712…): an order ref such as
                // "ORD-7" must not match every phone that contains a 7.
                ...(/^[\d\s+\-().]+$/.test(q) && q.replace(/\D/g, "").length >= 4 ? [{ recipientPhone: { contains: q.replace(/\D/g, "").slice(-10) } }] : []),
              ],
            }
          : {},
      ],
    };
    const rows = await this.prisma.parcel.findMany({
      where,
      include: { ...parcelInclude, events: { orderBy: { createdAt: "asc" } } },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: { id: "desc" },
    });
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const staff = isStaff(actor);
    // Staff: the hub that delivers each parcel (its next step: transfer or assign a rider here).
    const hubs = staff ? await deliveryHubsOf(this.prisma, page) : null;
    const items = page.map(p => ({ ...parcelView(p, { internal: staff }), ...(hubs ? { deliveryHub: hubs.get(p.id) ?? null } : {}) }));
    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }

  /** Detail by tracking ID, within the actor's scope (404 otherwise, so IDs don't leak). */
  async detail(actor: Actor, trackingId: string) {
    const parcel = await this.prisma.parcel.findFirst({ where: { AND: [{ trackingId: trackingId.toUpperCase() }, this.scope(actor)] }, include: parcelInclude });
    if (!parcel) throw notFound("Parcel");
    const staff = isStaff(actor);
    const view = {
      ...parcelView(parcel, { internal: staff }),
      ...(staff ? { deliveryHub: (await deliveryHubsOf(this.prisma, [parcel])).get(parcel.id) ?? null } : {}),
      liveDelivery: await this.liveDelivery(parcel),
    };
    const isAssignedRider = actor.kind === "user" && !!actor.riderId && parcel.deliveryRiderId === actor.riderId;
    return isAssignedRider ? { ...view, deliveryCodeSent: Boolean(parcel.deliveryOtpEncrypted), devDeliveryCode: this.workflow.devDeliveryCode(parcel) } : view;
  }

  /** `token`: the tracking link's ?t= (an owner / feedback link, or the recipient's live-location link from the SMS). */
  async publicTrack(trackingId: string, token?: string) {
    const parcel = await this.findByTrackingId(trackingId);
    return { ...publicTrackingView(parcel), liveDelivery: await this.liveDelivery(parcel, { showLocation: canSeeLiveLocation(parcel.trackingId, token) }) };
  }

  /**
   * Service packages, while the parcel is out for delivery: the rider's live position ("Live rider
   * location") and phone ("Share rider phone number", on the delivery day only; hidden afterwards).
   * Privacy: only the parcel's own delivery rider, only while OUT_FOR_DELIVERY, only the latest fix
   * (never the history), hidden when older than LIVE_LOCATION_STALE_MINUTES or the rider is off shift.
   * `showLocation: false` for anonymous lookups by tracking ID: the position then needs the SMS link
   * (canSeeLiveLocation) or a signed-in viewer who can see the parcel.
   */
  async liveDelivery(p: ParcelWithRelations, opts: { showLocation?: boolean } = {}) {
    if (p.status !== "OUT_FOR_DELIVERY" || !p.deliveryRiderId || !p.deliveryRider) return null;
    const live = p.services.includes("tracking.live_location");
    const sharePhone = p.services.includes("tracking.rider_phone");
    if (!live && !sharePhone) return null;
    const day = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "Asia/Dhaka" });
    const out = [...p.events].reverse().find(e => e.status === "OUT_FOR_DELIVERY");
    const deliveryDay = !!out && day(out.createdAt) === day(new Date());
    const show = live && opts.showLocation !== false;
    const fix = show
      ? await this.prisma.riderLocation.findUnique({
          where: { riderId: p.deliveryRiderId },
          select: { lat: true, lng: true, accuracy: true, heading: true, at: true, rider: { select: { status: true } } },
        })
      : null;
    const ageSeconds = fix ? Math.max(0, Math.round((Date.now() - fix.at.getTime()) / 1000)) : 0;
    const offShift = fix?.rider.status === "OFFLINE";
    const fresh = !!fix && !offShift && ageSeconds <= LIVE_LOCATION_STALE_MINUTES * 60;
    const locationStatus = !live ? null : !show ? "LINK_REQUIRED" : !fix ? "WAITING" : offShift ? "OFF_SHIFT" : fresh ? "LIVE" : "STALE";
    return {
      rider: { name: p.deliveryRider.user.name.split(/\s+/)[0], phone: sharePhone && deliveryDay ? p.deliveryRider.user.phone : null },
      location: fresh && fix ? { lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, heading: fix.heading, at: fix.at, ageSeconds } : null,
      /** LIVE · STALE (no fix for 15+ min) · WAITING (none yet) · OFF_SHIFT · LINK_REQUIRED (open the SMS link) · null (not in the package). */
      locationStatus,
      staleAfterMinutes: LIVE_LOCATION_STALE_MINUTES,
    };
  }

  /** By tracking ID as typed (case, spaces and Crockford look-alikes such as O/0 forgiven). */
  async findByTrackingId(input: string, db: Db = this.prisma) {
    const typed = input.trim().toUpperCase();
    for (const trackingId of new Set([typed, normalizeTrackingId(typed)])) {
      const parcel = await db.parcel.findUnique({ where: { trackingId }, include: parcelInclude });
      if (parcel) return parcel;
    }
    throw notFound("Parcel");
  }

  /** Loads within scope, for mutations. */
  async loadForUpdate(actor: Actor, trackingId: string, db: Db = this.prisma): Promise<Parcel> {
    const parcel = await db.parcel.findFirst({ where: { AND: [{ trackingId: trackingId.toUpperCase() }, this.scope(actor)] } });
    if (!parcel) throw notFound("Parcel");
    return parcel;
  }

  // ───────────── owner actions ─────────────

  /** `opts.expectedVersion`: optimistic locking for callers that saw a version (bulk updates). */
  async cancel(actor: Actor, trackingId: string, input: z.infer<typeof cancelParcelSchema>, meta: RequestMeta, opts: { expectedVersion?: number } = {}) {
    const after = this.workflow.newAfterCommit();
    await this.prisma.$transaction(async tx => {
      const parcel = await this.loadForUpdate(actor, trackingId, tx);
      const isOwner =
        (actor.kind === "user" && parcel.customerId === actor.userId) || (!!parcel.merchantId && merchantIdsOf(actor).includes(parcel.merchantId));
      const asOps = !isOwner && actor.permissions.has("parcel:dispatch");
      if (!isOwner && !asOps) throw forbidden("Only the sender or operations can cancel this parcel");
      if (isOwner && !isCustomerCancellable(parcel.status as ParcelStatus))
        throw new AppError("NOT_CANCELLABLE", "This request can no longer be cancelled online because operations already confirmed it. Contact support.", HttpStatus.CONFLICT);
      await this.workflow.transition(
        tx,
        parcel,
        {
          to: "PICKUP_CANCELLED",
          actorRole: asOps ? "ops" : "owner",
          data: { cancelledAt: new Date(), cancelReason: input.reason },
          title: asOps ? "Pickup cancelled by operations" : "Pickup request cancelled",
          description: input.reason ?? (asOps ? "Operations cancelled the request." : "The sender cancelled the request before confirmation."),
          location: asOps ? "Courier operations" : "Customer",
          expectedVersion: opts.expectedVersion,
        },
        actor,
        meta,
        after,
      );
    });
    await this.workflow.flush(after);
    return this.detail(actor, trackingId);
  }

  // ───────────── operations ─────────────

  async assignPickup(actor: Actor, trackingId: string, input: z.infer<typeof assignRiderSchema>, meta: RequestMeta, opts: { expectedVersion?: number } = {}) {
    return this.opsChange(actor, trackingId, meta, async (tx, parcel, after) => {
      const rider = await this.activeRider(tx, input.riderId, actor);
      await this.workflow.transition(
        tx,
        parcel,
        {
          to: "PICKUP_ASSIGNED",
          actorRole: "ops",
          data: { pickupRiderId: rider.id },
          description: `Operations accepted the request and assigned ${rider.label} to collect the parcel.`,
          internalNote: input.note,
          expectedVersion: opts.expectedVersion,
        },
        actor,
        meta,
        after,
      );
      if (parcel.pickupRiderId !== rider.id)
        await notifyRider(this.inbox, tx, rider.id, {
          type: "rider.pickup_assigned",
          title: `New pickup: ${parcel.trackingId}`,
          body: [parcel.senderName, [parcel.pickupArea, parcel.pickupZone].filter(Boolean).join(", ")].filter(Boolean).join(" · "),
          page: "Pickup queue",
        });
    });
  }

  /** Hands a waiting pickup to a hub (a franchise hub assigns its own rider); null takes it back to operations. */
  async assignPickupHub(actor: Actor, trackingId: string, input: { hubId: string | null; note?: string }, meta: RequestMeta) {
    return this.opsChange(actor, trackingId, meta, async (tx, parcel, after) => {
      if (parcel.intake !== "PICKUP" || parcel.status !== "PENDING_CONFIRMATION")
        throw new AppError("NOT_AWAITING_PICKUP", `${parcel.trackingId} isn't a rider pickup waiting to be assigned`, 422);
      const hub = input.hubId ? await tx.hub.findUnique({ where: { id: input.hubId }, select: { id: true, name: true, active: true, type: true } }) : null;
      if (input.hubId && (!hub || !hub.active)) throw notFound("Hub");
      const scope = opsHubScope(actor);
      if (scope && input.hubId && !scope.includes(input.hubId)) throw forbidden("You can only hand pickups to your own hub");
      const updated = await tx.parcel.update({ where: { id: parcel.id }, data: { pickupHubId: input.hubId, version: { increment: 1 } } });
      await this.audit.record(actor, { action: "parcel.pickup_hub", entityType: "parcel", entityId: parcel.id, data: { trackingId: parcel.trackingId, hubId: input.hubId, hub: hub?.name ?? null, franchise: hub?.type === "FRANCHISE", note: input.note ?? null } }, meta, tx);
      after.realtime.push(parcelEvent({ ...updated, pickupHubId: input.hubId ?? parcel.pickupHubId }));
    });
  }

  async assignDelivery(actor: Actor, trackingId: string, input: z.infer<typeof assignRiderSchema>, meta: RequestMeta, opts: { expectedVersion?: number } = {}) {
    return this.opsChange(actor, trackingId, meta, async (tx, parcel, after) => {
      await this.assertHubAccess(tx, actor, parcel);
      const rider = await this.activeRider(tx, input.riderId, actor);
      const hub = parcel.currentHubId ? await tx.hub.findUnique({ where: { id: parcel.currentHubId } }) : null;
      await this.workflow.transition(
        tx,
        parcel,
        {
          to: "ASSIGNED",
          actorRole: "ops",
          // No delivery code yet: the recipient gets it by SMS when the rider starts the delivery
          // (OUT_FOR_DELIVERY). A reassignment drops any earlier code so none goes stale.
          data: { deliveryRiderId: rider.id, deliveryOtpEncrypted: null },
          description: `Operations assigned the parcel${hub ? ` from ${hub.name}` : ""} to ${rider.label} for delivery.`,
          internalNote: input.note,
          expectedVersion: opts.expectedVersion,
        },
        actor,
        meta,
        after,
      );
      if (parcel.deliveryRiderId !== rider.id) {
        const cod = Number(parcel.codAmount);
        await notifyRider(this.inbox, tx, rider.id, {
          type: "rider.delivery_assigned",
          title: `New delivery: ${parcel.trackingId}`,
          body: [parcel.recipientName, [parcel.deliveryArea, parcel.deliveryZone].filter(Boolean).join(", "), cod > 0 ? `COD ৳${cod.toLocaleString("en-US")}` : null].filter(Boolean).join(" · "),
          page: "Deliveries",
        });
      }
    });
  }

  /** Generic status change by operations (hub moves, exceptions, returns). */
  async setStatus(actor: Actor, trackingId: string, input: z.infer<typeof updateStatusSchema>, meta: RequestMeta, scan?: { code: string; source: ScanSource }) {
    const to = input.status as ParcelStatus;
    if (to === "PICKUP_ASSIGNED" || to === "ASSIGNED") throw new AppError("USE_ASSIGN", "Assign a rider to change to this status", 422);
    if (to === "PICKUP_CANCELLED") return this.cancel(actor, trackingId, { reason: input.note }, meta);
    return this.opsChange(actor, trackingId, meta, async (tx, parcel, after) => {
      const data: Prisma.ParcelUncheckedUpdateInput = {};
      let location: string | undefined;
      let title: string | undefined;
      let description: string | undefined;
      let metadata: Prisma.InputJsonValue | undefined;
      // Hub operators receive parcels at their own hub and act only on parcels held there.
      const hubScope = opsHubScope(actor);
      if (to === "AT_HUB" && input.hubId) {
        if (hubScope && !hubScope.includes(input.hubId)) throw forbidden("You can only receive parcels at your own hub");
      } else await this.assertHubAccess(tx, actor, parcel);
      // A drop-off arriving at its hub: no pickup leg, the delivery SLA starts now (ParcelWorkflowService).
      if (to === "AT_HUB" && parcel.status === "PENDING_CONFIRMATION" && parcel.intake === "DROP_OFF") {
        if (!input.hubId) throw new AppError("HUB_REQUIRED", "Choose the hub the parcel is at", 422);
        const hub = await tx.hub.findUnique({ where: { id: input.hubId } });
        if (!hub) throw notFound("Hub");
        if (!hub.active) throw new AppError("HUB_INACTIVE", `${hub.name} isn't operating`, 422);
        await this.workflow.receiveDropOff(tx, parcel, { hub, code: scan?.code, source: scan?.source, note: input.note, expectedVersion: input.expectedVersion }, actor, meta, after);
        return;
      }
      if (to === "AT_HUB" || to === "IN_TRANSIT") {
        const hubId = input.hubId ?? parcel.currentHubId;
        if (to === "AT_HUB" && !hubId) throw new AppError("HUB_REQUIRED", "Choose the hub the parcel is at", 422);
        if (hubId) {
          const hub = await tx.hub.findUnique({ where: { id: hubId } });
          if (!hub) throw notFound("Hub");
          if (!hub.active && hub.id !== parcel.currentHubId) throw new AppError("HUB_INACTIVE", `${hub.name} isn't operating`, 422);
          data.currentHubId = hub.id;
          location = hub.name;
          metadata = { hubId: hub.id };
          // A move to another hub is a transfer; the transfer register reads this metadata.
          if (to === "IN_TRANSIT" && parcel.currentHubId && parcel.currentHubId !== hub.id) {
            const from = await tx.hub.findUnique({ where: { id: parcel.currentHubId } });
            title = `In transit to ${hub.name}`;
            description = `On the way from ${from?.name ?? "the previous hub"} to ${hub.name}.`;
            metadata = { kind: "hub_transfer", hubId: hub.id, fromHubId: parcel.currentHubId, fromHub: from?.name ?? null, toHubId: hub.id, toHub: hub.name };
          }
        }
        if (to === "AT_HUB") Object.assign(data, { deliveryRiderId: null, deliveryOtpEncrypted: null });
      }
      if (to === "PICKED_UP") data.pickedUpAt = operationNow();
      if (to === "OUT_FOR_DELIVERY") {
        if (!parcel.deliveryRiderId && !parcel.pickupRiderId) throw new AppError("RIDER_REQUIRED", "Assign a delivery rider first", 422);
        data.deliveryRiderId = parcel.deliveryRiderId ?? parcel.pickupRiderId;
        // The parcel is going out now: a fresh delivery code by SMS (any earlier code stops working).
        data.deliveryOtpEncrypted = await this.workflow.issueDeliveryCode(tx, parcel, after);
      }
      if (to === "RETURNED") data.deliveredAt = null;
      // Returns scheduled directly (not via a return run) still carry the reason and RTO charge.
      if (to === "RETURN_SCHEDULED") {
        if (parcel.returnCharge == null) data.returnCharge = returnChargeFor(parcel);
        if (!parcel.returnRequestedAt) Object.assign(data, { returnRequestedAt: operationNow(), returnRequestedBy: actorLabel(actor), returnReason: parcel.returnReason ?? input.note ?? null });
      }
      await this.workflow.transition(
        tx,
        parcel,
        { to, actorRole: "ops", data, location, title, description, metadata, internalNote: input.note, expectedVersion: input.expectedVersion },
        actor,
        meta,
        after,
      );
    });
  }

  /** Price-neutral corrections by operations (recipient contact, street, instructions). */
  async updateDetails(actor: Actor, trackingId: string, input: z.infer<typeof updateParcelDetailsSchema>, meta: RequestMeta) {
    return this.opsChange(actor, trackingId, meta, async (tx, parcel, after) => {
      await this.assertHubAccess(tx, actor, parcel);
      if (TERMINAL_STATUSES.includes(parcel.status as ParcelStatus))
        throw new AppError("PARCEL_CLOSED", "This parcel is closed; its details can no longer change", HttpStatus.CONFLICT);
      if (input.expectedVersion !== undefined && input.expectedVersion !== parcel.version) throw this.changedError();

      const data: Prisma.ParcelUncheckedUpdateManyInput = {};
      const changed: string[] = [];
      const set = (field: "recipientName" | "recipientPhone" | "deliveryStreet" | "deliveryArea" | "instructions", value: string | null | undefined, label: string) => {
        if (value === undefined || value === parcel[field]) return;
        (data as Record<string, string | null>)[field] = value;
        changed.push(label);
      };
      set("recipientName", input.recipient?.name, "recipient name");
      set("recipientPhone", input.recipient?.phone, "recipient phone");
      set("deliveryStreet", input.delivery?.street, "street address");
      if (input.delivery?.area !== undefined) set("deliveryArea", input.delivery.area || null, "area");
      if (input.instructions !== undefined) set("instructions", input.instructions || null, "delivery instructions");
      if (!changed.length) return;
      // An incomplete order (import) may have just received what it was missing.
      if (parcel.incomplete) {
        const missing = missingFieldsOf({ ...parcel, ...(data as Partial<Pick<Parcel, "recipientName" | "recipientPhone" | "deliveryStreet">>) });
        Object.assign(data, { incomplete: missing.length > 0, missingFields: missing });
      }
      // The delivery code goes to the recipient's phone, so a new number gets a fresh code.
      if (typeof data.recipientPhone === "string" && parcel.deliveryOtpEncrypted)
        data.deliveryOtpEncrypted = await this.workflow.issueDeliveryCode(tx, { ...parcel, recipientPhone: data.recipientPhone }, after);

      const { count } = await tx.parcel.updateMany({ where: { id: parcel.id, version: parcel.version }, data: { ...data, version: { increment: 1 } } });
      if (!count) throw this.changedError();
      await tx.trackingEvent.create({
        data: {
          parcelId: parcel.id,
          createdAt: operationNow(),
          status: parcel.status,
          title: "Details updated",
          description: `Operations updated the ${changed.join(", ")}.${input.note ? ` ${input.note}` : ""}`,
          visibility: "INTERNAL",
          actorUserId: actor.kind === "user" ? actor.userId : null,
          actorLabel: actorLabel(actor),
        },
      });
      await this.audit.record(actor, { action: "parcel.update_details", entityType: "parcel", entityId: parcel.id, data: { trackingId: parcel.trackingId, changed } }, meta, tx);
    });
  }

  /** Internal note on the parcel's timeline, visible to staff only. */
  async addNote(actor: Actor, trackingId: string, input: z.infer<typeof parcelNoteSchema>, meta: RequestMeta) {
    return this.opsChange(actor, trackingId, meta, async (tx, parcel) => {
      await tx.trackingEvent.create({
        data: {
          parcelId: parcel.id,
          createdAt: operationNow(),
          status: parcel.status,
          title: "Note",
          description: input.note,
          visibility: "INTERNAL",
          actorUserId: actor.kind === "user" ? actor.userId : null,
          actorLabel: actorLabel(actor),
        },
      });
      await this.audit.record(actor, { action: "parcel.note", entityType: "parcel", entityId: parcel.id, data: { trackingId: parcel.trackingId } }, meta, tx);
    });
  }

  /** Hub operators may act only on parcels held at (or heading to) their own hub. */
  private async assertHubAccess(db: Db, actor: Actor, parcel: Parcel) {
    const scope = opsHubScope(actor);
    if (!scope || !parcel.currentHubId || scope.includes(parcel.currentHubId)) return;
    const hub = await db.hub.findUnique({ where: { id: parcel.currentHubId }, select: { name: true } });
    throw forbidden(`${parcel.trackingId} is at ${hub?.name ?? "another hub"}. Only that hub or an operations manager can update it`);
  }

  private changedError() {
    return new AppError("PARCEL_CHANGED", "This parcel was just updated by someone else. Refresh and try again.", HttpStatus.CONFLICT);
  }

  private async opsChange(actor: Actor, trackingId: string, meta: RequestMeta, change: (tx: Db, parcel: Parcel, after: ReturnType<ParcelWorkflowService["newAfterCommit"]>) => Promise<void>) {
    const after = this.workflow.newAfterCommit();
    await this.prisma.$transaction(async tx => change(tx, await this.loadForUpdate(actor, trackingId, tx), after));
    await this.workflow.flush(after);
    return this.detail(actor, trackingId);
  }

  private async activeRider(db: Db, riderId: string, actor: Actor) {
    const rider = await db.rider.findUnique({ where: { id: riderId }, include: { user: { select: { name: true, status: true } } } });
    if (!rider || !rider.active || rider.user.status !== "ACTIVE") throw new AppError("RIDER_UNAVAILABLE", "That rider isn't active", 422);
    await assertRiderAssignable(db, actor, rider.id);
    return { id: rider.id, label: `${rider.code} · ${rider.user.name}` };
  }
}
