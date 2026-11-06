import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { PrismaService, type Db } from "../../common/prisma.service";
import { AuditService } from "../../common/audit.service";
import { RealtimeService } from "../../common/realtime.service";
import { nextCounter } from "../../common/counters";
import { merchantCodePrefix } from "@delivery-fast/shared";
import { sha256 } from "../../common/crypto";
import { AppError, conflict, forbidden, notFound } from "../../common/errors";
import { merchantNotActive } from "./merchant-status";
import { pageArgs, toPage } from "../../common/pagination";
import { actorLabel, merchantIdsOf, type Actor, type UserActor } from "../../common/auth/actor";
import type { RequestMeta } from "../../common/auth/decorators";
import { env } from "../../config/env";
import { Prisma, type Role } from "../../generated/prisma/client";
import { NotifyService } from "../notifications/notify.service";
import { OutboxService } from "../notifications/outbox.service";
import { InboxService } from "../notifications/inbox.service";
import { SessionService } from "../auth/session.service";
import { memberInclude, memberView, merchantView } from "./merchant.views";
import { PricingService } from "../pricing/pricing.service";
import { businessColumns, matchLegacyPickup, pickupColumns, pickupHubInclude, resolveMerchantPlace, servingHub, type HubRef, type MerchantPlaceInput, type ResolvedPlace } from "./merchant-address";
import type { Merchant } from "../../generated/prisma/client";
import { resolvePlace } from "../parcels/places";
import type { MerchantKycService } from "./merchant-kyc.service";
import type {
  addMemberSchema,
  adminUpdateMerchantSchema,
  listMerchantsQuerySchema,
  merchantApplicationSchema,
  pageWithSelectorSchema,
  updateMyMerchantSchema,
} from "./merchants.schemas";

const MERCHANT_ROLES: Role[] = ["MERCHANT_OWNER", "MERCHANT_STAFF"];
/** An application still being decided: the applicant can't open another one. */
export const OPEN_APPLICATION_STATUSES = ["PENDING_REVIEW", "INFO_REQUESTED"] as const;

/** Serialises concurrent writes that check-then-insert (limits, last owner, one open application). */
export const advisoryLock = (db: Db, key: string) => db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;

const ROLES_REFRESH_MESSAGE =
  "Application received. We'll review it and text you when it's approved. Your merchant access appears after you next refresh your session or sign in.";

const loginLink = () => `${env().APP_URL}/#/login`;
const payoutLabel = (p: { method: string; accountNumber: string }) => `${{ BKASH: "bKash", NAGAD: "Nagad", BANK: "Bank" }[p.method] ?? p.method} ••••${p.accountNumber.slice(-4)}`;

type AddressChanges = { business?: MerchantPlaceInput; pickupSameAsBusiness?: boolean; pickup?: MerchantPlaceInput };
type AddressSnapshot = { pickup: string; business: string | null; pickupSameAsBusiness: boolean };
type AddressRequestRow = Prisma.MerchantAddressRequestGetPayload<object>;

@Injectable()
export class MerchantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notify: NotifyService,
    private readonly outbox: OutboxService,
    private readonly sessions: SessionService,
    private readonly realtime: RealtimeService,
  ) {}

  @Inject(InboxService) private readonly inbox!: InboxService;
  /** The service catalog addresses are checked against (property injection keeps the constructor stable). */
  @Inject(PricingService) private readonly pricing!: PricingService;

  /** Set by MerchantKycService (avoids a constructor cycle). */
  kyc?: MerchantKycService;

  // ───────────── access ─────────────

  /**
   * The merchant a member is acting for, from their token's role grants (re-checked in the
   * database). Members of several merchants must pass merchantId. API keys act for their
   * own merchant (only on routes that accept keys, e.g. webhooks with webhooks:manage).
   */
  async resolveOwn(actor: Actor, merchantId: string | undefined, opts: { ownerOnly?: boolean; allowInactive?: boolean } = {}) {
    const merchant = await this.resolveMember(actor, merchantId, opts);
    // Until the account is active (under review, information requested, not approved, suspended) the merchant
    // may only read its own account, its business verification and the review conversation (allowInactive).
    if (!opts.allowInactive && merchant.status !== "ACTIVE") throw merchantNotActive(merchant.status);
    return merchant;
  }

  private async resolveMember(actor: Actor, merchantId: string | undefined, opts: { ownerOnly?: boolean }) {
    if (actor.kind === "api_key") {
      if (merchantId && merchantId !== actor.merchantId) throw forbidden("This API key belongs to another merchant");
      const merchant = await this.prisma.merchant.findUnique({ where: { id: actor.merchantId }, include: { plan: true, ...pickupHubInclude } });
      if (!merchant) throw notFound("Merchant");
      return merchant;
    }
    const memberOf = [...new Set(merchantIdsOf(actor))];
    if (!memberOf.length) throw forbidden("You're not a member of a merchant account");
    let id = merchantId;
    if (id) {
      if (!memberOf.includes(id)) throw forbidden("You're not a member of this merchant");
    } else {
      if (memberOf.length > 1)
        throw new AppError("MERCHANT_REQUIRED", "You belong to several merchants. Choose one with ?merchantId=", HttpStatus.UNPROCESSABLE_ENTITY, { merchantIds: memberOf });
      id = memberOf[0];
    }
    const allowed: Role[] = opts.ownerOnly ? ["MERCHANT_OWNER"] : MERCHANT_ROLES;
    const grant = await this.prisma.userRole.findFirst({ where: { userId: actor.userId, merchantId: id, role: { in: allowed } }, select: { id: true } });
    if (!grant) throw forbidden(opts.ownerOnly ? "Only merchant owners can do this" : "You're not a member of this merchant");
    const merchant = await this.prisma.merchant.findUnique({ where: { id }, include: { plan: true, ...pickupHubInclude } });
    if (!merchant) throw notFound("Merchant");
    return merchant;
  }

  // ───────────── structured addresses ─────────────

  /**
   * Merchant columns for an address change: the business address, the pickup location (the
   * business address when `pickupSameAsBusiness`, else its own), contact, time, handover, plus the
   * re-derived serving hub whenever the pickup moves. Places are checked against the active catalog.
   */
  private async addressData(
    db: Db,
    input: {
      business?: MerchantPlaceInput;
      pickupSameAsBusiness?: boolean;
      pickup?: MerchantPlaceInput;
      pickupContactName?: string;
      pickupContactPhone?: string;
      pickupTime?: "MORNING" | "MIDDAY" | "AFTERNOON";
      handover?: "RIDER_PICKUP" | "HUB_DROP";
      businessCategory?: string | null;
      websiteUrl?: string | null;
    },
    current: Merchant | null,
  ): Promise<{ data: Prisma.MerchantUncheckedUpdateInput; pickupMoved: boolean; hub: HubRef | null | undefined }> {
    const touches = input.business !== undefined || input.pickupSameAsBusiness !== undefined || input.pickup !== undefined;
    const data: Prisma.MerchantUncheckedUpdateInput = {};
    if (input.businessCategory !== undefined) data.businessCategory = input.businessCategory;
    if (input.websiteUrl !== undefined) data.websiteUrl = input.websiteUrl;
    if (input.pickupContactName !== undefined) data.pickupContactName = input.pickupContactName;
    if (input.pickupContactPhone !== undefined) data.pickupContactPhone = input.pickupContactPhone;
    if (input.pickupTime !== undefined) data.pickupTime = input.pickupTime;
    if (input.handover !== undefined) data.handover = input.handover;
    if (!touches) return { data, pickupMoved: false, hub: undefined };

    const catalog = await this.pricing.catalog(db);
    const business = input.business ? resolveMerchantPlace(catalog, input.business, "business") : null;
    if (business) Object.assign(data, businessColumns(business));
    const same = input.pickupSameAsBusiness ?? (input.pickup ? false : current ? current.pickupSameAsBusiness : true);
    let pickup: ResolvedPlace | null = null;
    if (same) {
      const source = business ?? (current ? this.storedBusiness(current) : null);
      if (!source)
        throw new AppError("VALIDATION_FAILED", "Some fields need attention", HttpStatus.UNPROCESSABLE_ENTITY, [{ path: "business", message: "Add the business address first, or enter a separate pickup address" }]);
      // Copied again only when the business address or the flag changed.
      if (business || input.pickupSameAsBusiness !== undefined) pickup = source;
    } else if (input.pickup) pickup = resolveMerchantPlace(catalog, input.pickup, "pickup");
    data.pickupSameAsBusiness = same;
    if (!pickup) return { data, pickupMoved: false, hub: undefined };
    Object.assign(data, pickupColumns(pickup));
    const hub = await servingHub(db, pickup);
    data.pickupHubId = hub?.id ?? null;
    return { data, pickupMoved: true, hub };
  }

  /** The stored business address as a resolved place (null for older merchants without one). */
  private storedBusiness(m: Merchant): ResolvedPlace | null {
    if (!m.businessDistrict || !m.businessZone || !m.businessStreet) return null;
    return { district: m.businessDistrict, zone: m.businessZone, area: m.businessArea, areaOther: m.businessAreaOther, street: m.businessStreet, lat: m.businessLat, lng: m.businessLng };
  }

  /**
   * The hub that would serve pickups at a place (the website's "Drop at hub" shows it before the
   * application is sent). Public; the place must be in the active catalog.
   */
  async pickupHubFor(place: { district: string; zone: string; area?: string }) {
    const catalog = await this.pricing.catalog();
    const found = resolvePlace(catalog, place.district, place.zone);
    if (!found.ok || !found.district || !found.zone)
      throw new AppError("VALIDATION_FAILED", "Some fields need attention", HttpStatus.UNPROCESSABLE_ENTITY, [
        { path: found.ok ? "zone" : found.column, message: found.ok ? "Choose the thana / upazila" : found.message },
      ]);
    const resolved = { district: found.district, zone: found.zone, area: place.area || null };
    const hub = await servingHub(this.prisma, resolved);
    return { district: resolved.district, zone: resolved.zone, hub, routeDistrict: hub?.district ?? resolved.district };
  }

  /** Live update for staff lists and the merchant's own members. */
  publish(merchantId: string, data: Record<string, unknown> = {}) {
    this.realtime.publish({ type: "merchant.updated", id: merchantId, merchantId, staffPermission: "merchant:read:any", data });
  }

  // ───────────── onboarding ─────────────

  async apply(actor: UserActor, input: z.infer<typeof merchantApplicationSchema>, meta: RequestMeta) {
    const { inviteToken, type, name, contactName, contactPhone, contactEmail } = input;
    const outbox: string[] = [];
    const merchant = await this.prisma.$transaction(async tx => {
      await advisoryLock(tx, `merchant-application:${actor.userId}`);
      const open = await tx.userRole.findFirst({
        where: { userId: actor.userId, role: "MERCHANT_OWNER", merchant: { status: { in: [...OPEN_APPLICATION_STATUSES] } } },
        include: { merchant: { select: { code: true } } },
      });
      if (open) throw conflict("APPLICATION_PENDING", `Your application ${open.merchant!.code} is still being reviewed`);
      const invite = inviteToken ? await this.validInvite(tx, inviteToken) : null;
      // An invitation is for one merchant panel: the application must be for that type.
      if (invite?.type && invite.type !== input.type)
        throw new AppError(
          "INVITE_TYPE_MISMATCH",
          `This invitation is for ${invite.type === "BANKING_FINANCIAL" ? "a Banking & Financial" : "an E-commerce"} merchant account. Choose that account type.`,
          HttpStatus.UNPROCESSABLE_ENTITY,
          { field: "type", expected: invite.type },
        );
      const address = await this.addressData(
        tx,
        { ...input, pickupContactName: input.pickupContactName ?? contactName, pickupContactPhone: input.pickupContactPhone ?? contactPhone, pickup: input.pickupSameAsBusiness ? undefined : input.pickup },
        null,
      );
      const code = await this.nextMerchantCode(tx, type);
      const created = await tx.merchant.create({
        data: {
          ...address.data,
          type,
          name,
          contactName,
          contactPhone,
          contactEmail,
          code,
          status: "PENDING_REVIEW",
          members: { create: { userId: actor.userId, role: "MERCHANT_OWNER" } },
        } as Prisma.MerchantUncheckedCreateInput,
        include: { plan: true, ...pickupHubInclude },
      });
      if (invite) await tx.merchantInvite.update({ where: { id: invite.id }, data: { acceptedAt: new Date(), merchantId: created.id } });
      outbox.push(
        ...(await this.notify.notify(tx, {
          event: "merchant.application_received",
          to: { userId: actor.userId, phone: created.contactPhone, email: created.contactEmail, name: created.contactName },
          vars: { businessName: created.name, reference: code },
        })),
      );
      await this.audit.record(
        actor,
        {
          action: "merchant.apply",
          entityType: "merchant",
          entityId: created.id,
          data: {
            code,
            type: input.type,
            name: input.name,
            inviteId: invite?.id ?? null,
            business: { district: created.businessDistrict, zone: created.businessZone, area: created.businessArea },
            pickup: { sameAsBusiness: created.pickupSameAsBusiness, district: created.pickupDistrict, zone: created.pickupZone, area: created.pickupArea },
            pickupTime: created.pickupTime,
            handover: created.handover,
            pickupHubId: created.pickupHubId,
          },
        },
        meta,
        tx,
      );
      // Super admins' bell: a registration to review.
      await this.inbox.toStaff(tx, { roles: ["SUPER_ADMIN"] }, { type: "staff.merchant_application", title: `New merchant registration: ${created.name}`, body: `${code} · ${created.type === "BANKING_FINANCIAL" ? "Banking & Financial" : "E-commerce"}`, target: { page: "registrations" }, panel: "/super-admin" });
      return created;
    });
    await this.outbox.flush(outbox);
    this.publish(merchant.id, { status: merchant.status });
    return { merchant: merchantView(merchant), message: ROLES_REFRESH_MESSAGE };
  }

  /** An unexpired, unused invitation for this link token (or a clear error). */
  async validInvite(db: Db, token: string) {
    const invite = await db.merchantInvite.findUnique({ where: { tokenHash: sha256(token) } });
    if (!invite || invite.revokedAt) throw new AppError("INVITE_INVALID", "This invitation link isn't valid. Ask Delivery Fast for a new one.", HttpStatus.UNPROCESSABLE_ENTITY);
    if (invite.acceptedAt) throw new AppError("INVITE_USED", "This invitation was already used. If you sent the application, sign in to follow it; otherwise ask Delivery Fast for a new link.", HttpStatus.CONFLICT);
    if (invite.expiresAt < new Date()) throw new AppError("INVITE_EXPIRED", "This invitation has expired. Ask Delivery Fast for a new one.", HttpStatus.UNPROCESSABLE_ENTITY);
    return invite;
  }

  /**
   * EC-1040 (E-commerce) or FM-1041 (Banking & Financial): one running number for both, so a number is never
   * reused; skips codes already taken. Merchants made before keep their MR- code.
   */
  private async nextMerchantCode(tx: Db, type: "ECOMMERCE" | "BANKING_FINANCIAL") {
    for (let i = 0; i < 100; i++) {
      const code = `${merchantCodePrefix(type)}-${await nextCounter(tx, "merchant-code", 1000)}`;
      if (!(await tx.merchant.findUnique({ where: { code }, select: { id: true } }))) return code;
    }
    throw new Error("Could not allocate a merchant code");
  }

  // ───────────── administration ─────────────

  async list(query: z.infer<typeof listMerchantsQuerySchema>) {
    const q = query.q;
    const rows = await this.prisma.merchant.findMany({
      where: {
        // The hub a merchant belongs to (from its pickup address); "none": no hub serves its pickup area.
        ...(query.hubId ? { pickupHubId: query.hubId === "none" ? null : query.hubId } : {}),
        status: query.status,
        type: query.type,
        kycStatus: query.kycStatus,
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: "insensitive" } },
                { code: { contains: q, mode: "insensitive" } },
                { contactName: { contains: q, mode: "insensitive" } },
                { contactEmail: { contains: q, mode: "insensitive" } },
                { contactPhone: { contains: q.replace(/\D/g, "").slice(-10) || q } },
              ],
            }
          : {}),
      },
      include: { plan: true, ...pickupHubInclude, _count: { select: { parcels: true } } },
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { items: page.items.map(m => ({ ...merchantView(m), parcelCount: m._count.parcels })), nextCursor: page.nextCursor };
  }

  async detail(id: string) {
    const m = await this.prisma.merchant.findUnique({
      where: { id },
      include: {
        plan: true,
        ...pickupHubInclude,
        members: { where: { role: { in: MERCHANT_ROLES } }, include: memberInclude, orderBy: { createdAt: "asc" } },
        _count: { select: { parcels: true, apiKeys: { where: { revokedAt: null } }, webhooks: true, settlements: true, invoices: true, tickets: true, notes: true } },
      },
    });
    if (!m) throw notFound("Merchant");
    const members = m.members.map(memberView);
    return {
      ...merchantView(m),
      owners: members.filter(r => r.role === "MERCHANT_OWNER"),
      staff: members.filter(r => r.role === "MERCHANT_STAFF"),
      counts: {
        parcels: m._count.parcels,
        activeApiKeys: m._count.apiKeys,
        webhooks: m._count.webhooks,
        settlements: m._count.settlements,
        invoices: m._count.invoices,
        tickets: m._count.tickets,
        notes: m._count.notes,
      },
    };
  }

  async adminUpdate(actor: Actor, id: string, input: z.infer<typeof adminUpdateMerchantSchema>, meta: RequestMeta) {
    const outbox: string[] = [];
    await this.prisma.$transaction(async tx => {
      const current = await tx.merchant.findUnique({ where: { id } });
      if (!current) throw notFound("Merchant");
      if (input.planId) {
        const plan = await tx.servicePlan.findUnique({ where: { id: input.planId } });
        if (!plan) throw notFound("Service plan");
        if (plan.segment !== current.type)
          throw new AppError("PLAN_SEGMENT_MISMATCH", `The ${plan.name} plan is for ${plan.segment} merchants, but this merchant is ${current.type}`, HttpStatus.UNPROCESSABLE_ENTITY);
        if (!plan.active && plan.id !== current.planId) throw new AppError("PLAN_INACTIVE", `The ${plan.name} plan is no longer offered`, HttpStatus.UNPROCESSABLE_ENTITY);
      }
      const approved = input.status === "ACTIVE" && current.status !== "ACTIVE";
      if (approved && current.status !== "SUSPENDED") await this.kyc?.assertAllowed(tx, current, "activation");
      const { status, planId, name, contactName, contactPhone, contactEmail } = input;
      const address = await this.addressData(tx, input, current);
      const data: Prisma.MerchantUncheckedUpdateInput = { status, planId, name, contactName, contactPhone, contactEmail, ...address.data };
      if (input.status && input.status !== "SUSPENDED") data.rejectionReason = null;
      const updated = await tx.merchant.update({ where: { id }, data });
      if (approved)
        outbox.push(
          ...(await this.notify.notify(tx, {
            event: "merchant.approved",
            to: { phone: updated.contactPhone, email: updated.contactEmail, name: updated.contactName },
            vars: { businessName: `${updated.name} (${updated.code})`, link: loginLink() },
          })),
        );
      const action = approved ? "merchant.approve" : input.status === "SUSPENDED" && current.status !== "SUSPENDED" ? "merchant.suspend" : "merchant.update";
      if (input.status && input.status !== current.status)
        await tx.merchantNote.create({
          data: {
            merchantId: id,
            kind: "STATUS_CHANGE",
            internal: true,
            body: `Status changed from ${current.status} to ${input.status}`,
            authorId: actor.kind === "user" ? actor.userId : null,
            authorName: actorLabel(actor),
          },
        });
      await this.audit.record(
        actor,
        { action, entityType: "merchant", entityId: id, data: { changes: input, previousStatus: current.status, ...(address.pickupMoved ? { pickupHubId: address.hub?.id ?? null, previousPickupHubId: current.pickupHubId } : {}) } },
        meta,
        tx,
      );
    });
    await this.outbox.flush(outbox);
    this.publish(id, { status: input.status });
    return this.detail(id);
  }

  // ───────────── self-service ─────────────

  async mine(actor: Actor, merchantId: string | undefined) {
    const m = await this.resolveOwn(actor, merchantId, { allowInactive: true });
    const role = (actor as UserActor).roles.find(r => r.merchantId === m.id && r.role === "MERCHANT_OWNER") ? "MERCHANT_OWNER" : "MERCHANT_STAFF";
    // Older free-text pickup addresses: a best-effort catalog match the Settings form preselects.
    const pickupSuggestion = m.pickupZone ? null : matchLegacyPickup(await this.pricing.catalog(), m);
    return { ...merchantView(m), myRole: role, pickupSuggestion };
  }

  async updateMine(actor: Actor, merchantId: string | undefined, input: z.infer<typeof updateMyMerchantSchema>, meta: RequestMeta) {
    const current = await this.resolveOwn(actor, merchantId, { ownerOnly: true });
    const { payoutAccount, name, contactName, contactPhone, contactEmail, ...addressInput } = input;
    const rest = { contactName, contactPhone, contactEmail };
    // The business name is reviewed: applicants may correct it until they're approved.
    if (name !== undefined && !(OPEN_APPLICATION_STATUSES as readonly string[]).includes(current.status))
      throw new AppError("NAME_LOCKED", "The business name can only change while the application is being reviewed. Contact support to rename an approved account.", HttpStatus.UNPROCESSABLE_ENTITY);
    // An active merchant's own change of its business / pickup address waits for operations' approval (its hub follows
    // the pickup address); the other Settings fields apply at once. Applicants still being reviewed change it freely, and
    // older merchants completing an address they never structured (no pickup zone yet) aren't held up.
    const { business, pickupSameAsBusiness, pickup, ...otherAddress } = addressInput;
    const review = current.status === "ACTIVE" && !!current.pickupZone && (business !== undefined || pickupSameAsBusiness !== undefined || pickup !== undefined);
    const outbox: string[] = [];
    let addressRequest: AddressRequestRow | null = null;
    const merchant = await this.prisma.$transaction(async tx => {
      const address = await this.addressData(tx, review ? otherAddress : addressInput, current);
      if (review) addressRequest = await this.requestAddressChange(tx, actor, current, { business, pickupSameAsBusiness, pickup }, meta);
      const updated = await tx.merchant.update({
        where: { id: current.id },
        data: { ...rest, ...address.data, ...(name !== undefined ? { name } : {}), ...(payoutAccount !== undefined ? { payoutAccount: payoutAccount === null ? Prisma.DbNull : payoutAccount } : {}) },
        include: { plan: true, ...pickupHubInclude },
      });
      if (payoutAccount !== undefined)
        // Payout changes are a fraud target: tell the existing contact number.
        outbox.push(
          ...(await this.notify.notify(tx, {
            event: "merchant.payout_account_changed",
            to: { phone: current.contactPhone, email: current.contactEmail, name: current.contactName },
            vars: { businessName: `${current.name} (${current.code})`, account: payoutAccount ? payoutLabel(payoutAccount) : "none (removed)" },
          })),
        );
      const changes = {
        ...rest,
        ...(review ? otherAddress : addressInput),
        ...(address.pickupMoved ? { pickupHubId: address.hub?.id ?? null, previousPickupHubId: current.pickupHubId } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(payoutAccount !== undefined ? { payoutAccount: payoutAccount ? { method: payoutAccount.method, accountLast4: payoutAccount.accountNumber.slice(-4) } : null } : {}),
      };
      await this.audit.record(actor, { action: "merchant.self_update", entityType: "merchant", entityId: current.id, data: changes }, meta, tx);
      return updated;
    });
    await this.outbox.flush(outbox);
    this.publish(current.id);
    if (addressRequest) this.publishAddressRequests(current.id);
    return { ...merchantView(merchant), myRole: "MERCHANT_OWNER", addressRequest: await this.latestAddressRequest(current.id) };
  }

  // ───────────── address changes awaiting approval ─────────────

  /** The pickup / business address of a merchant row, readable, for the reviewer. */
  private addressSnapshot(m: Pick<Merchant, "pickupAddress" | "pickupArea" | "pickupZone" | "pickupDistrict" | "pickupSameAsBusiness" | "businessStreet" | "businessArea" | "businessZone" | "businessDistrict">) {
    const line = (...parts: (string | null | undefined)[]) => [...new Set(parts.filter(Boolean))].join(", ");
    return {
      pickup: line(m.pickupAddress, m.pickupArea, m.pickupZone, m.pickupDistrict),
      business: m.businessDistrict ? line(m.businessStreet, m.businessArea, m.businessZone, m.businessDistrict) : null,
      pickupSameAsBusiness: m.pickupSameAsBusiness,
    };
  }

  /**
   * Records an active merchant's own address change for approval (replacing an older pending one), checked now.
   * Null when the address sent is the one on file (Settings sends it with every save).
   */
  private async requestAddressChange(tx: Db, actor: Actor, current: Merchant, changes: AddressChanges, meta: RequestMeta) {
    const preview = await this.addressData(tx, changes, current);
    const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null) || String(a ?? "") === String(b ?? "");
    if (Object.entries(preview.data).every(([k, v]) => same((current as Record<string, unknown>)[k], v))) return null;
    const proposed = { ...current, ...(preview.data as Partial<Merchant>) } as Merchant;
    const now = new Date();
    await tx.merchantAddressRequest.updateMany({ where: { merchantId: current.id, status: "PENDING" }, data: { status: "CANCELLED", decidedAt: now, note: "Replaced by a newer request" } });
    const request = await tx.merchantAddressRequest.create({
      data: {
        merchantId: current.id,
        changes: JSON.parse(JSON.stringify(changes)) as Prisma.InputJsonObject,
        previous: this.addressSnapshot(current),
        proposed: this.addressSnapshot(proposed),
        previousHubId: current.pickupHubId,
        proposedHubId: preview.pickupMoved ? (preview.hub?.id ?? null) : current.pickupHubId,
        requestedById: actor.kind === "user" ? actor.userId : null,
        requestedByName: actorLabel(actor),
      },
    });
    await this.audit.record(actor, { action: "merchant.address_requested", entityType: "merchant", entityId: current.id, data: { requestId: request.id, changes, previousHubId: request.previousHubId, proposedHubId: request.proposedHubId } }, meta, tx);
    // The bell of those who approve it (Courier Operations › Merchants › Address changes to approve).
    const moved = request.proposedHubId !== request.previousHubId;
    await this.inbox.toStaff(
      tx,
      { roles: ["OPS_MANAGER"] },
      {
        type: "staff.merchant_address_request",
        title: `Address change to approve: ${current.name}`,
        body: `${current.code} · ${this.addressSnapshot(proposed).pickup}${moved ? " · the serving hub changes" : ""}`,
        target: { page: "merchants" },
        panel: "/courier-operation",
      },
    );
    return request;
  }

  private publishAddressRequests(merchantId: string) {
    this.realtime.publish({ type: "merchant.address_request", id: merchantId, merchantId, staffPermission: "merchant:address" });
  }

  private async addressRequestView(r: AddressRequestRow, merchant?: { id: string; code: string; name: string; status: string } | null) {
    const hubIds = [r.previousHubId, r.proposedHubId].filter((x): x is string => !!x);
    const hubs = hubIds.length ? await this.prisma.hub.findMany({ where: { id: { in: hubIds } }, select: { id: true, code: true, name: true } }) : [];
    const hub = (id: string | null) => hubs.find(h => h.id === id) ?? null;
    return {
      id: r.id,
      status: r.status,
      merchant: merchant ?? null,
      previous: r.previous as AddressSnapshot,
      proposed: r.proposed as AddressSnapshot,
      previousHub: hub(r.previousHubId),
      proposedHub: hub(r.proposedHubId),
      hubChanges: r.previousHubId !== r.proposedHubId,
      requestedBy: r.requestedByName,
      decidedBy: r.decidedByName,
      decidedAt: r.decidedAt,
      note: r.note,
      createdAt: r.createdAt,
    };
  }

  /** The merchant's pending request, else its latest decided one (shown in Settings). */
  private async latestAddressRequest(merchantId: string) {
    const r =
      (await this.prisma.merchantAddressRequest.findFirst({ where: { merchantId, status: "PENDING" } })) ??
      (await this.prisma.merchantAddressRequest.findFirst({ where: { merchantId, status: { in: ["APPROVED", "REJECTED"] } }, orderBy: { createdAt: "desc" } }));
    return r ? this.addressRequestView(r) : null;
  }

  async myAddressRequest(actor: Actor, merchantId: string | undefined) {
    const m = await this.resolveOwn(actor, merchantId, { allowInactive: true });
    return { request: await this.latestAddressRequest(m.id) };
  }

  async cancelMyAddressRequest(actor: Actor, merchantId: string | undefined, meta: RequestMeta) {
    const m = await this.resolveOwn(actor, merchantId, { ownerOnly: true });
    const cancelled = await this.prisma.$transaction(async tx => {
      const r = await tx.merchantAddressRequest.findFirst({ where: { merchantId: m.id, status: "PENDING" } });
      if (!r) throw notFound("Pending address change");
      await tx.merchantAddressRequest.update({ where: { id: r.id }, data: { status: "CANCELLED", decidedAt: new Date(), note: "Cancelled by the merchant" } });
      await this.audit.record(actor, { action: "merchant.address_request_cancelled", entityType: "merchant", entityId: m.id, data: { requestId: r.id } }, meta, tx);
      return r;
    });
    this.publishAddressRequests(m.id);
    return { cancelled: cancelled.id, request: await this.latestAddressRequest(m.id) };
  }

  /** Operations: address changes to review (pending: oldest first; decided: newest first). */
  async listAddressRequests(query: { status?: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED" }) {
    const status = query.status ?? "PENDING";
    const rows = await this.prisma.merchantAddressRequest.findMany({
      where: { status },
      include: { merchant: { select: { id: true, code: true, name: true, status: true } } },
      orderBy: { createdAt: status === "PENDING" ? "asc" : "desc" },
      take: 200,
    });
    return { items: await Promise.all(rows.map(r => this.addressRequestView(r, r.merchant))) };
  }

  /** Operations decide: approved, the address is applied (checked again against today's catalog) and the hub follows. */
  async decideAddressRequest(actor: Actor, id: string, input: { approve: boolean; note?: string }, meta: RequestMeta) {
    const outbox: string[] = [];
    const result = await this.prisma.$transaction(async tx => {
      const r = await tx.merchantAddressRequest.findUnique({ where: { id } });
      if (!r) throw notFound("Address change");
      if (r.status !== "PENDING") throw conflict("ADDRESS_REQUEST_DECIDED", `This address change was already ${r.status.toLowerCase()}`);
      if (!input.approve && !input.note)
        throw new AppError("VALIDATION_FAILED", "Some fields need attention", HttpStatus.UNPROCESSABLE_ENTITY, [{ path: "note", message: "Tell the merchant why the change isn't approved" }]);
      const current = await tx.merchant.findUniqueOrThrow({ where: { id: r.merchantId } });
      let hub: HubRef | null | undefined;
      if (input.approve) {
        const address = await this.addressData(tx, r.changes as AddressChanges, current);
        await tx.merchant.update({ where: { id: current.id }, data: address.data });
        hub = address.pickupMoved ? address.hub : undefined;
        await this.audit.record(
          actor,
          { action: "merchant.address_approved", entityType: "merchant", entityId: current.id, data: { requestId: r.id, changes: r.changes, ...(address.pickupMoved ? { pickupHubId: address.hub?.id ?? null, previousPickupHubId: current.pickupHubId } : {}) } },
          meta,
          tx,
        );
      } else await this.audit.record(actor, { action: "merchant.address_rejected", entityType: "merchant", entityId: current.id, data: { requestId: r.id, note: input.note } }, meta, tx);
      const decided = await tx.merchantAddressRequest.update({
        where: { id: r.id },
        data: { status: input.approve ? "APPROVED" : "REJECTED", decidedById: actor.kind === "user" ? actor.userId : null, decidedByName: actorLabel(actor), decidedAt: new Date(), note: input.note ?? null },
      });
      const details = input.approve
        ? hub === undefined
          ? "Your new address is saved."
          : hub
            ? `Pickups now go through ${hub.name}.`
            : "No hub serves the new pickup area yet; Delivery Fast will set one up."
        : (input.note ?? "");
      outbox.push(
        ...(await this.notify.notify(tx, {
          event: "merchant.address_change",
          to: { phone: current.contactPhone, email: current.contactEmail, name: current.contactName },
          vars: { businessName: `${current.name} (${current.code})`, status: input.approve ? "approved" : "not approved", details },
        })),
      );
      return { decided, merchant: { id: current.id, code: current.code, name: current.name, status: current.status } };
    });
    await this.outbox.flush(outbox);
    this.publish(result.merchant.id);
    this.publishAddressRequests(result.merchant.id);
    return this.addressRequestView(result.decided, result.merchant);
  }

  /** Operations change a merchant's address directly (no approval); the hub follows the pickup address. */
  async updateAddress(actor: Actor, id: string, input: AddressChanges, meta: RequestMeta) {
    await this.prisma.$transaction(async tx => {
      const current = await tx.merchant.findUnique({ where: { id } });
      if (!current) throw notFound("Merchant");
      const address = await this.addressData(tx, input, current);
      await tx.merchant.update({ where: { id }, data: address.data });
      await this.audit.record(
        actor,
        { action: "merchant.address_update", entityType: "merchant", entityId: id, data: { changes: input, ...(address.pickupMoved ? { pickupHubId: address.hub?.id ?? null, previousPickupHubId: current.pickupHubId } : {}) } },
        meta,
        tx,
      );
    });
    this.publish(id);
    return this.detail(id);
  }

  // ───────────── members ─────────────

  async listMembers(actor: Actor, query: z.infer<typeof pageWithSelectorSchema>) {
    const m = await this.resolveOwn(actor, query.merchantId, { ownerOnly: true });
    const rows = await this.prisma.userRole.findMany({ where: { merchantId: m.id, role: { in: MERCHANT_ROLES } }, include: memberInclude, ...pageArgs(query) });
    const page = toPage(rows, query.limit);
    return { items: page.items.map(memberView), nextCursor: page.nextCursor };
  }

  async addMember(actor: Actor, merchantId: string | undefined, input: z.infer<typeof addMemberSchema>, meta: RequestMeta) {
    const m = await this.resolveOwn(actor, merchantId, { ownerOnly: true });
    const outbox: string[] = [];
    const result = await this.prisma.$transaction(async tx => {
      await advisoryLock(tx, `merchant-members:${m.id}`);
      const existing = await tx.user.findUnique({ where: { phone: input.phone }, include: { roles: { where: { merchantId: m.id, role: { in: MERCHANT_ROLES } } } } });
      if (existing?.roles.length) throw conflict("ALREADY_A_MEMBER", `${existing.name} is already a member of ${m.name}`);
      if (existing && existing.status !== "ACTIVE") throw new AppError("USER_INACTIVE", "This person's account is suspended or deactivated", HttpStatus.UNPROCESSABLE_ENTITY);
      const user = existing ?? (await tx.user.create({ data: { name: input.name, phone: input.phone } }));
      const grant = await tx.userRole.create({ data: { userId: user.id, role: input.role, merchantId: m.id }, include: memberInclude });
      const roleLabel = input.role === "MERCHANT_OWNER" ? "an owner" : "a team member";
      if (existing) outbox.push(...(await this.notify.notify(tx, { event: "merchant.member_added", to: { userId: user.id, phone: input.phone, name: user.name }, vars: { businessName: m.name, role: roleLabel, link: loginLink() } })));
      else outbox.push(...(await this.notify.notify(tx, { event: "account.invite", to: { userId: user.id, phone: input.phone, name: input.name }, vars: { inviter: m.name, role: `${roleLabel} of ${m.name}`, link: loginLink() } })));
      await this.audit.record(actor, { action: "merchant.member_add", entityType: "merchant", entityId: m.id, data: { userRoleId: grant.id, userId: user.id, role: input.role, invited: !existing } }, meta, tx);
      return { member: memberView(grant), invited: !existing };
    });
    await this.outbox.flush(outbox);
    return result;
  }

  async removeMember(actor: Actor, merchantId: string | undefined, userRoleId: string, meta: RequestMeta) {
    const m = await this.resolveOwn(actor, merchantId, { ownerOnly: true });
    const removed = await this.prisma.$transaction(async tx => {
      await advisoryLock(tx, `merchant-members:${m.id}`);
      const grant = await tx.userRole.findFirst({ where: { id: userRoleId, merchantId: m.id, role: { in: MERCHANT_ROLES } } });
      if (!grant) throw notFound("Member");
      if (grant.role === "MERCHANT_OWNER" && (await tx.userRole.count({ where: { merchantId: m.id, role: "MERCHANT_OWNER" } })) <= 1)
        throw new AppError("LAST_OWNER", "A merchant needs at least one owner. Add another owner first.", HttpStatus.UNPROCESSABLE_ENTITY);
      await tx.userRole.delete({ where: { id: grant.id } });
      await this.audit.record(actor, { action: "merchant.member_remove", entityType: "merchant", entityId: m.id, data: { userRoleId: grant.id, userId: grant.userId, role: grant.role } }, meta, tx);
      return grant;
    });
    // Their access tokens still carry the role: end every session so it can't be used.
    await this.sessions.revokeAllForUser(removed.userId, "merchant_access_removed");
  }
}

