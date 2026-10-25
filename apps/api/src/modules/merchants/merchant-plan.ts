import {
  FIRST_MILE_LABEL,
  INCLUDED_WEIGHT_KG,
  LAST_MILE_LABEL,
  PARCEL_NOTIFICATIONS,
  PRODUCT_TYPE_LABEL,
  ROUTE_TIER_LABEL,
  SERVICES,
  SPEED_LABEL,
  SUPPORT_NOTIFICATIONS,
  isBanking,
  packageOptions,
  priceParcel,
  servicesFor,
  type BookingSelection,
  type PackagePrices,
  type PackageSegment,
  type RouteTier,
  type SpeedOption,
} from "@delivery-fast/shared";

/**
 * "Services & pricing" in the merchant panels (GET /merchants/me/plan): the merchant's package told in
 * plain words — what their package includes and doesn't, which messages go
 * to whom, and the prices with worked examples. Pure: the service adds the package, the message
 * switches (Global notifications) and the merchant.
 */

export type ChannelState = { available: boolean; on: boolean };
export type MessageChannels = { sms: ChannelState; email: ChannelState };

const tk = (n: number) => `৳${Math.round(n).toLocaleString("en-US")}`;
const fee = (n: number, unit = "per parcel") => (n > 0 ? `+${tk(n)} ${unit}` : n < 0 ? `${tk(n).replace("৳-", "−৳")} ${unit}` : "No extra charge");

// ───────────── services ─────────────

/** Plain-language groups of the merchant page (package editor groups merged where a merchant thinks of them together). */
const SERVICE_SECTIONS: { title: string; hint: string; groups: string[] }[] = [
  { title: "Handing over your parcels", hint: "How parcels get from you to us", groups: ["firstMile"] },
  { title: "Delivering to your customers", hint: "How your customers receive them", groups: ["lastMile"] },
  { title: "Delivery service", hint: "Choose one per parcel when you book", groups: ["service"] },
  { title: "Payment & options", hint: "Collected from your customer at the door", groups: ["payment", "options"] },
  { title: "Proof of delivery", hint: "How the rider confirms the handover", groups: ["proof"] },
  { title: "Tracking & support", hint: "For you and your customers", groups: ["tracking"] },
  { title: "Integrations", hint: "Connect your shop or system", groups: ["integrations"] },
];

function serviceDetail(code: string, segment: PackageSegment, p: PackagePrices): { detail: string; price?: string } {
  const banking = isBanking(segment);
  switch (code) {
    case "first.rider_pickup":
      return { detail: "A rider collects parcels from your pickup address.", price: "No extra charge" };
    case "first.hub_drop":
      return { detail: "Bring parcels to a Delivery Fast hub yourself.", price: p.hubDropDiscount > 0 ? `You save ${tk(p.hubDropDiscount)} per parcel` : "No extra charge" };
    case "first.on_demand_pickup":
      return { detail: "Urgent pickup, dispatched before regular pickups.", price: fee(p.onDemandPickupFee) };
    case "last.doorstep":
      return { detail: "Delivered to your customer's address.", price: fee(p.homeDeliveryFee) };
    case "last.hub_collect":
      return { detail: "Your customer collects the parcel at the hub serving their area, with a collection code.", price: fee(p.hubPickupFee) };
    case "speed.regular":
      return { detail: "Standard delivery time.", price: fee(p.regularFee) };
    case "speed.express":
      return banking ? { detail: "Faster than Regular.", price: fee(p.expressFee) } : { detail: "Same-day delivery, inside the same district only.", price: fee(p.expressFee) };
    case "speed.on_demand":
      return { detail: "Highest dispatch priority.", price: fee(p.onDemandFee) };
    case "handling.b2b":
      return { detail: "Business-to-business documents, handled as documents.", price: fee(p.b2bRate) };
    case "handling.trade":
      return { detail: "Trade service documents (LCs, bills and similar).", price: fee(p.tradeRate) };
    case "handling.urgent":
      return { detail: "Corporate urgent documents. The fee already covers the urgency.", price: fee(p.urgentRate) };
    case "payment.cod":
      return { detail: "Your customer pays the product price to the rider; we pay it to you in settlements.", price: `${p.codPercent}% of the cash collected${p.codMin ? ` (minimum ${tk(p.codMin)})` : ""}` };
    case "option.open_box":
      return { detail: "Your customer may open and check the parcel before paying.", price: fee(p.openBoxFee) };
    case "proof.photo":
      return { detail: "The rider photographs the signed invoice." };
    case "proof.otp":
      return { detail: "Your customer gives the rider the delivery code from their SMS." };
    case "proof.signature":
      return { detail: "Your customer signs on the rider's phone." };
    case "tracking.website":
      return { detail: "A public tracking page for every parcel, linked in the messages." };
    case "tracking.live_location":
      return { detail: "You and your customer see the rider on a map while the parcel is out for delivery." };
    case "support.tickets":
      return { detail: "Raise and follow support tickets from your panel." };
    case "tracking.rider_phone":
      return { detail: "Your customer sees the rider's phone number on the delivery day." };
    case "integration.api":
      return { detail: "Book and track parcels from your own system with API keys." };
    case "integration.webhooks":
      return { detail: "Status updates sent to your server as they happen." };
    default:
      return { detail: "" };
  }
}

export function serviceSections(segment: PackageSegment, services: readonly string[], prices: PackagePrices) {
  const has = new Set(services);
  const offered = servicesFor(segment).filter(s => s.group !== "parcelNotifications" && s.group !== "supportNotifications");
  return SERVICE_SECTIONS.map(section => ({
    title: section.title,
    hint: section.hint,
    items: offered
      .filter(s => section.groups.includes(s.group))
      .map(s => ({ code: s.code, label: s.label, included: has.has(s.code), always: !!s.core, ...serviceDetail(s.code, segment, prices) })),
  })).filter(s => s.items.length);
}

// ───────────── messages ─────────────

const STAGE: Record<string, { stage: string; when: string }> = {
  "notify.booked": { stage: "Booking & pickup", when: "When you book a parcel for rider pickup" },
  "notify.drop_off_booked": { stage: "Booking & pickup", when: "When you book a parcel to drop at a hub" },
  "notify.changed_to_drop_off": { stage: "Booking & pickup", when: "When a booking is changed to a hub drop-off" },
  "notify.changed_to_pickup": { stage: "Booking & pickup", when: "When a booking is changed back to rider pickup" },
  "notify.pickup_assigned": { stage: "Booking & pickup", when: "When a rider is assigned to collect the parcel" },
  "notify.picked_up": { stage: "Booking & pickup", when: "When the rider collects the parcel" },
  "notify.cancelled": { stage: "Booking & pickup", when: "When a pickup is cancelled" },
  "notify.out_for_delivery": { stage: "Delivery", when: "When the rider sets out to deliver" },
  "notify.delivery_code": { stage: "Delivery", when: "When the rider starts the delivery; your customer gives this code to receive the parcel" },
  "notify.delivered": { stage: "Delivery", when: "When the parcel is delivered" },
  "notify.delivery_failed": { stage: "Delivery", when: "When a delivery attempt fails, with the reason" },
  "notify.collection": { stage: "Delivery", when: "Hub Pickup: when the parcel is ready at the hub, and a reminder before it expires" },
  "notify.feedback_request": { stage: "Delivery", when: "After delivery, asking how it went" },
  "notify.return_scheduled": { stage: "Returns", when: "When a parcel is set to come back to you" },
  "notify.returned": { stage: "Returns", when: "When the parcel is returned to you" },
};
export const MESSAGE_STAGES = ["Booking & pickup", "Delivery", "Returns"] as const;

/** Merchant account messages outside packages (sent whatever the package). */
export function accountEvents(segment: PackageSegment): string[] {
  return [
    "auth.otp.login",
    "auth.password_changed",
    "merchant.kyc_status",
    "merchant.member_added",
    "merchant.payout_account_changed",
    ...(isBanking(segment) ? [] : ["finance.settlement_paid"]),
    "finance.invoice_issued",
    "import.completed",
  ];
}

export function parcelMessages(segment: PackageSegment, services: readonly string[], channels: (events: readonly string[]) => MessageChannels) {
  const has = new Set(services);
  return PARCEL_NOTIFICATIONS.filter(n => !("segments" in n) || (n.segments as readonly string[]).includes(segment)).map(n => ({
    code: n.code,
    label: n.label,
    to: n.audience === "recipient" ? "Your customer" : "You",
    stage: STAGE[n.code]?.stage ?? "Delivery",
    when: STAGE[n.code]?.when ?? "",
    included: has.has(n.code),
    channels: channels(n.events),
  }));
}

export function supportMessages(services: readonly string[], channels: (events: readonly string[]) => MessageChannels) {
  const has = new Set(services);
  return SUPPORT_NOTIFICATIONS.map(n => ({ code: n.code, label: n.label, included: has.has(n.code), channels: channels(n.events) }));
}

// ───────────── prices ─────────────

type PriceRow = { label: string; value: string; note?: string };

const TIER_EXAMPLE: Record<RouteTier, string> = {
  DHAKA_SUBURBAN: "Dhaka city ↔ Gazipur, Narayanganj or Dhaka (Sub-urban)",
  SAME_DISTRICT: "Pickup and delivery in the same district",
  DIFFERENT_DISTRICT: "Any other route, e.g. Dhaka → Chattogram",
};

export function priceSections(segment: PackageSegment, services: readonly string[], p: PackagePrices) {
  const banking = isBanking(segment);
  const has = new Set(services);
  const routes = (["SAME_DISTRICT", "DHAKA_SUBURBAN", "DIFFERENT_DISTRICT"] as const).map(t => ({
    tier: t,
    label: ROUTE_TIER_LABEL[t],
    amount: Math.round(p[({ DHAKA_SUBURBAN: "dhakaSuburban", SAME_DISTRICT: "sameDistrict", DIFFERENT_DISTRICT: "differentDistrict" } as const)[t]]),
    example: TIER_EXAMPLE[t],
  }));
  // E-commerce: each route shown with what is sent added (one title, the sum), the way an order is priced.
  if (segment === "ECOMMERCE")
    for (const r of routes)
      Object.assign(r, {
        types: (["REGULAR", "DOCUMENT", "BOOKS"] as const).map(t => ({ type: t, label: `${r.label} + ${PRODUCT_TYPE_LABEL[t]}`, amount: r.amount + Math.round(p[({ REGULAR: "typeRegular", DOCUMENT: "typeDocument", BOOKS: "typeBooks" } as const)[t]]) })),
      });

  const extras: PriceRow[] = [];
  if (!banking) {
    extras.push({ label: "Weight", value: `${tk(p.extraKg)} per extra kg`, note: `${INCLUDED_WEIGHT_KG} kg is included; each started kg above it is charged.` });
    const types = (["REGULAR", "DOCUMENT", "BOOKS"] as const).map(t => [t, p[({ REGULAR: "typeRegular", DOCUMENT: "typeDocument", BOOKS: "typeBooks" } as const)[t]]] as const);
    if (segment !== "ECOMMERCE" && types.some(([, v]) => v > 0)) for (const [t, v] of types) extras.push({ label: `What you send: ${PRODUCT_TYPE_LABEL[t]}`, value: fee(v) });
  }
  const speedFee: Partial<Record<SpeedOption, number>> = { REGULAR: p.regularFee, EXPRESS: p.expressFee, ON_DEMAND: p.onDemandFee, B2B: p.b2bRate, TRADE: p.tradeRate, URGENT: p.urgentRate };
  for (const o of packageOptions(segment, services).speeds)
    extras.push({ label: `Service: ${SPEED_LABEL[o]}`, value: fee(speedFee[o] ?? 0), ...(o === "EXPRESS" && !banking ? { note: "Same district only." } : o === "B2B" || o === "TRADE" ? { note: "Added on top of Regular." } : {}) });
  if (has.has("last.doorstep") && p.homeDeliveryFee) extras.push({ label: LAST_MILE_LABEL.DOORSTEP, value: fee(p.homeDeliveryFee) });
  if (has.has("last.hub_collect")) extras.push({ label: LAST_MILE_LABEL.HUB_COLLECT, value: fee(p.hubPickupFee) });
  if (has.has("first.hub_drop") && p.hubDropDiscount > 0) extras.push({ label: FIRST_MILE_LABEL.HUB_DROP, value: `−${tk(p.hubDropDiscount)} per parcel`, note: "Discount when you bring the parcel to a hub." });
  if (has.has("first.on_demand_pickup")) extras.push({ label: FIRST_MILE_LABEL.ON_DEMAND_PICKUP, value: fee(p.onDemandPickupFee) });
  if (segment === "ECOMMERCE" && has.has("option.open_box")) extras.push({ label: "Open box", value: fee(p.openBoxFee) });

  const cod = !banking && has.has("payment.cod") ? [{ label: "COD fee", value: `${p.codPercent}% of the cash collected`, note: p.codMin ? `Minimum ${tk(p.codMin)} per parcel. Charged only when there is cash to collect.` : "Charged only when there is cash to collect." }] : [];

  const failed: PriceRow[] = [
    { label: "Re-attempts", value: p.freeReattempts ? `${p.freeReattempts} free` : "None free", note: p.reattemptFee ? `Then ${tk(p.reattemptFee)} for each further attempt.` : "Further attempts are free too." },
    { label: "Return to you", value: `${p.returnPercent}% of the delivery charge`, note: "Added when an undelivered parcel is returned." },
  ];
  return { routes, includedWeightKg: banking ? null : INCLUDED_WEIGHT_KG, extras, cod, failed };
}

/** Worked examples with the real formula (the same one the booking uses). */
export function priceExamples(segment: PackageSegment, services: readonly string[], p: PackagePrices) {
  const banking = isBanking(segment);
  const options = packageOptions(segment, services);
  const base: Pick<BookingSelection, "firstMile" | "lastMile" | "productType" | "openBox"> = {
    firstMile: options.defaultFirstMile ?? "RIDER_PICKUP",
    lastMile: options.defaultLastMile ?? "DOORSTEP",
    productType: "REGULAR",
    openBox: false,
  };
  const cases: { title: string; tier: RouteTier; speed: SpeedOption; weightKg: number; codAmount: number }[] = banking
    ? [
        { title: "Regular, same district", tier: "SAME_DISTRICT", speed: "REGULAR", weightKg: 0.5, codAmount: 0 },
        { title: "Regular, Dhaka → Chattogram", tier: "DIFFERENT_DISTRICT", speed: "REGULAR", weightKg: 0.5, codAmount: 0 },
        ...(["URGENT", "B2B", "TRADE", "EXPRESS", "ON_DEMAND"] as const)
          .filter(o => options.speeds.includes(o))
          .slice(0, 1)
          .map(o => ({ title: `${SPEED_LABEL[o]}, same district`, tier: "SAME_DISTRICT" as const, speed: o, weightKg: 0.5, codAmount: 0 })),
      ]
    : [
        { title: "0.5 kg, same district, prepaid", tier: "SAME_DISTRICT", speed: "REGULAR", weightKg: 0.5, codAmount: 0 },
        { title: `1.5 kg, Dhaka → Chattogram${options.cod ? ", ৳1,500 cash on delivery" : ""}`, tier: "DIFFERENT_DISTRICT", speed: "REGULAR", weightKg: 1.5, codAmount: options.cod ? 1500 : 0 },
        ...(options.speeds.includes("EXPRESS") ? [{ title: `Express (same day), 1 kg${options.cod ? ", ৳800 cash on delivery" : ""}`, tier: "SAME_DISTRICT" as const, speed: "EXPRESS" as const, weightKg: 1, codAmount: options.cod ? 800 : 0 }] : []),
      ];
  return cases.map(c => {
    const q = priceParcel(p, { segment, services, tier: c.tier, selection: { ...base, speed: c.speed, weightKg: c.weightKg, codAmount: c.codAmount } });
    return { title: c.title, lines: q.lines.map(l => ({ label: l.label, amount: l.amount })), deliveryCharge: q.deliveryCharge, codFee: q.codFee, total: q.totalCharge };
  });
}

/** Counts for the summary cards. */
export function planSummary(segment: PackageSegment, services: readonly string[]) {
  const has = new Set(services);
  const offered = SERVICES.filter(s => s.segments.includes(segment) && s.group !== "parcelNotifications" && s.group !== "supportNotifications");
  return { included: offered.filter(s => has.has(s.code)).length, notIncluded: offered.filter(s => !has.has(s.code)).length };
}
