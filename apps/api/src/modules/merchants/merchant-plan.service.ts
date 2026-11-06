import { Injectable } from "@nestjs/common";
import { PARCEL_NOTIFICATIONS, isBanking, packageOptions } from "@delivery-fast/shared";
import type { Actor } from "../../common/auth/actor";
import { PackagesService } from "../packages/packages.service";
import { PricingService } from "../pricing/pricing.service";
import { NotificationSettingsService } from "../notifications/notification-settings.service";
import { EVENT_CATALOG, channelsOf, definitionOf } from "../notifications/catalog";
import { NotifyService } from "../notifications/notify.service";
import type { NotificationEvent } from "../notifications/events";
import { smsSegments } from "../notifications/render";
import { env } from "../../config/env";
import { MerchantsService } from "./merchants.service";
import {
  MESSAGE_STAGES,
  accountEvents,
  parcelMessages,
  planSummary,
  priceExamples,
  priceSections,
  serviceSections,
  supportMessages,
  type MessageChannels,
} from "./merchant-plan";

/** The merchant's "Services & pricing" page (GET /merchants/me/plan). See merchant-plan.ts. */
@Injectable()
export class MerchantPlanService {
  constructor(
    private readonly merchants: MerchantsService,
    private readonly packages: PackagesService,
    private readonly pricing: PricingService,
    private readonly settings: NotificationSettingsService,
    private readonly notify: NotifyService,
  ) {}

  /**
   * Sample texts of a parcel message, exactly as the current templates (Global notifications) render them,
   * with realistic values: the merchant's contact as "you", a customer name, the real tracking link.
   */
  private async samples(events: readonly string[], toMerchant: boolean, contactName: string) {
    const trackingId = "PP-261018-B54GG";
    const base = env().APP_URL.replace(/\/+$/, "");
    return Promise.all(
      events.map(async event => {
        const def = EVENT_CATALOG[event as NotificationEvent];
        const vars = { ...def.sample, trackingId, trackingUrl: `${base}/track/${trackingId}`, name: toMerchant ? contactName : "Nabila Ahmed" };
        const [sms, email] = await Promise.all([this.notify.render(event as NotificationEvent, "sms", vars), this.notify.render(event as NotificationEvent, "email", vars)]);
        return {
          event,
          label: def.label,
          sms: sms ? { text: sms.body, parts: smsSegments(sms.body).segments } : null,
          email: email ? { subject: email.subject ?? "", text: email.body } : null,
        };
      }),
    );
  }

  async plan(actor: Actor, merchantId: string | undefined) {
    const merchant = await this.merchants.resolveOwn(actor, merchantId);
    const [view, assignment, snapshot, catalog] = await Promise.all([
      this.packages.bookingView({ merchantId: merchant.id }),
      this.packages.merchantPackage(merchant.id),
      this.settings.snapshot(),
      this.pricing.catalog(),
    ]);
    const { segment, services, prices } = view;

    // A message is "on" for a channel when any of its events sends on it (admin switches, global channels).
    const channels = (events: readonly string[]): MessageChannels => {
      const state = (channel: "sms" | "email") => {
        const resolved = events.flatMap(e => (definitionOf(e) && channelsOf(definitionOf(e)!).includes(channel) ? [this.settings.resolve(snapshot, e, channel)!] : []));
        return { available: resolved.length > 0, on: resolved.some(r => r.enabled) };
      };
      return { sms: state("sms"), email: state("email") };
    };

    const options = packageOptions(segment, services);
    return {
      merchant: { id: merchant.id, code: merchant.code, name: merchant.name, status: merchant.status, pickupDistrict: merchant.pickupDistrict, pickupZone: merchant.pickupZone },
      segment,
      segmentLabel: view.segmentLabel,
      package: { name: view.package.name, version: view.package.version, isDefault: view.package.isDefault, effectiveFrom: view.package.effectiveFrom },
      scheduled: assignment.scheduled.map(s => ({ name: s.package?.name ?? `${view.segmentLabel} default package`, effectiveFrom: s.effectiveFrom })),
      summary: planSummary(segment, services),
      services: serviceSections(segment, services, prices),
      messages: {
        stages: MESSAGE_STAGES,
        parcel: await Promise.all(
          parcelMessages(segment, services, channels).map(async m => ({
            ...m,
            samples: await this.samples(PARCEL_NOTIFICATIONS.find(n => n.code === m.code)!.events, m.to === "You", merchant.contactName),
          })),
        ),
        support: supportMessages(services, channels),
        account: accountEvents(segment).map(event => ({
          event,
          label: EVENT_CATALOG[event as keyof typeof EVENT_CATALOG].label,
          always: !!EVENT_CATALOG[event as keyof typeof EVENT_CATALOG].mandatory,
          channels: channels([event]),
        })),
        productsWithoutMessages: view.products.filter(p => !p.sendMessages).map(p => p.name),
      },
      prices: priceSections(segment, services, prices),
      examples: priceExamples(segment, services, prices),
      // The calculator: the choices this package offers and the districts.
      calculator: {
        weight: !isBanking(segment),
        cod: options.cod,
        openBox: options.openBox,
        speeds: options.speeds.map(code => ({ code, label: view.labels.speed[code] })),
        firstMiles: options.firstMiles.map(code => ({ code, label: view.labels.firstMile[code] })),
        lastMiles: options.lastMiles.map(code => ({ code, label: view.labels.lastMile[code] })),
        districts: catalog.districts,
      },
    };
  }
}
