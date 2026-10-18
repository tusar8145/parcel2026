import { PANEL_FOR_ROLE, type Role } from "@delivery-fast/shared";
import type { NotificationEvent } from "./events";

/**
 * In-app notifications (the bell in every panel): the text and link of each NotifyService event's
 * in-app copy, and the panel URLs they point at.
 *
 * Rule (docs/architecture-contracts.md "In-app notifications"): an event sent with an explicit
 * `to.userId` gets an in-app copy for that user when the event has an entry here and is switched on
 * for at least one channel in super admin → Global notifications. A person's own SMS / email opt-outs
 * don't remove the in-app copy; events that carry security codes (sign-in / sign-up / reset codes,
 * delivery codes, guest and email verification) never get one, and the copies never contain codes.
 */

export type Panel = "/super-admin" | "/courier-operation" | "/rider" | "/ecommerce-merchant" | "/banking-merchant" | "/account";

/** Where an item opens: a page / tab of the panel (slugs from the panels' URL scheme), a parcel or a ticket. */
export interface Target {
  page?: string;
  tab?: string;
  parcel?: string;
  ticket?: string;
}

/**
 * A panel URL in the shared scheme (`DF.nav` in public/legacy/shared/api.js): `/<panel>?page=<slug>[&tab=<slug>]`,
 * `?parcel=<tracking ID>` opens the parcel, `?ticket=<number>` the support ticket. Website customers get real
 * paths (`/track/<id>`, `/support/<ticket>`).
 */
export function panelUrl(panel: Panel, target: Target = {}): string {
  if (panel === "/account") {
    if (target.ticket) return `/support/${encodeURIComponent(target.ticket)}`;
    if (target.parcel) return `/track/${encodeURIComponent(target.parcel)}`;
    return "/account";
  }
  const params = new URLSearchParams();
  const page = target.ticket && !target.page ? "support" : target.page;
  if (page) params.set("page", page);
  if (target.tab) params.set("tab", target.tab);
  if (target.parcel) params.set("parcel", target.parcel);
  if (target.ticket) params.set("ticket", target.ticket);
  const query = params.toString();
  return query ? `${panel}?${query}` : panel;
}

/** The panel a person signs in to (the same rule as the session's `panel`). */
export function panelOf(roles: { role: Role | string; merchant?: { type: string } | null }[]): Panel {
  const names = roles.map(r => r.role);
  const panel = (PANEL_FOR_ROLE.find(([role]) => names.includes(role))?.[1] ?? "/account") as Panel;
  if (panel === "/ecommerce-merchant" && roles.find(r => r.merchant)?.merchant?.type === "BANKING_FINANCIAL") return "/banking-merchant";
  return panel;
}

type Vars = Record<string, string | number | null | undefined>;
export interface InAppCopy {
  title: string;
  body?: string | null;
  target?: Target;
}

const s = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());
const join = (...parts: unknown[]) => parts.map(s).filter(Boolean).join(" · ") || null;
const parcel = (v: Vars): Target => ({ parcel: s(v.trackingId) || undefined });
const ticket = (v: Vars): Target => ({ ticket: s(v.ticketNumber) || undefined });
const money = (v: unknown) => (s(v) ? `Tk ${s(v)}` : "");

/** In-app copies of NotifyService events (events missing here get none). `panel` is the recipient's. */
export const IN_APP: Partial<Record<NotificationEvent, (v: Vars, panel: Panel) => InAppCopy>> = {
  // account & security
  "auth.password_changed": () => ({ title: "Your password was changed", body: "If this wasn't you, reset your password and contact support right away." }),
  "auth.mfa_enabled": () => ({ title: "Two-step verification turned on", body: "Not you? Contact support right away." }),
  "auth.mfa_disabled": () => ({ title: "Two-step verification turned off", body: "Not you? Contact support right away." }),
  "auth.mfa_reset": v => ({ title: "Two-step verification was reset", body: `${s(v.admin) || "An administrator"} reset it. Set it up again at your next sign-in.` }),
  "account.support_access": v => ({ title: "Support is viewing your account", body: join(s(v.admin), s(v.mode), s(v.minutes) ? `up to ${s(v.minutes)} minutes` : "") }),
  // parcels (customers; merchants get theirs from ParcelWorkflowService, see InboxService.toMerchant)
  "parcel.booked": v => ({ title: `Booking ${s(v.trackingId)} received`, body: s(v.charge) ? `Delivery charge ${money(v.charge)}` : null, target: parcel(v) }),
  "parcel.drop_off_booked": v => ({ title: `Booking ${s(v.trackingId)} received`, body: join(s(v.hub) ? `Bring the parcel to ${s(v.hub)}` : "", s(v.charge) ? `Delivery charge ${money(v.charge)}` : ""), target: parcel(v) }),
  "parcel.changed_to_drop_off": v => ({ title: `${s(v.trackingId)}: bring it to the hub`, body: join(s(v.hub), s(v.hubAddress)), target: parcel(v) }),
  "parcel.changed_to_pickup": v => ({ title: `${s(v.trackingId)}: a rider will collect it`, body: s(v.charge) ? `Delivery charge ${money(v.charge)}` : null, target: parcel(v) }),
  "parcel.pickup_assigned": v => ({ title: `A rider is on the way for ${s(v.trackingId)}`, target: parcel(v) }),
  "parcel.picked_up": v => ({ title: `${s(v.trackingId)} was picked up`, target: parcel(v) }),
  "parcel.out_for_delivery": v => ({ title: `${s(v.trackingId)} is out for delivery`, target: parcel(v) }),
  "parcel.delivered": v => ({ title: `${s(v.trackingId)} was delivered`, body: s(v.receivedBy) ? `Received by ${s(v.receivedBy)}` : null, target: parcel(v) }),
  "parcel.delivery_failed": v => ({ title: `Delivery attempt failed: ${s(v.trackingId)}`, body: s(v.reason) || "We'll try again.", target: parcel(v) }),
  "parcel.cancelled": v => ({ title: `${s(v.trackingId)} was cancelled`, target: parcel(v) }),
  "parcel.return_scheduled": v => ({ title: `${s(v.trackingId)} is being returned`, body: join(s(v.reason), s(v.returnCharge) ? `Return charge ${money(v.returnCharge)}` : ""), target: parcel(v) }),
  "parcel.returned": v => ({ title: `${s(v.trackingId)} was returned`, body: s(v.reason) || null, target: parcel(v) }),
  // The collection code stays in the SMS only.
  "parcel.ready_for_collection": v => ({ title: `${s(v.trackingId)} is ready for collection`, body: join(s(v.hub), s(v.until) ? `until ${s(v.until)}` : ""), target: parcel(v) }),
  "parcel.collection_reminder": v => ({ title: `Collect ${s(v.trackingId)} from ${s(v.hub) || "the hub"}`, body: s(v.until) ? `By ${s(v.until)}, or it goes back to the sender.` : null, target: parcel(v) }),
  // merchants
  "merchant.application_received": v => ({ title: `Application received: ${s(v.businessName)}`, body: s(v.reference) ? `Reference ${s(v.reference)}` : null }),
  "merchant.approved": v => ({ title: `${s(v.businessName)} is approved`, body: "You can start booking.", target: { page: "overview" } }),
  "merchant.rejected": v => ({ title: "Merchant application not approved", body: s(v.reason) || s(v.businessName) || null }),
  "merchant.info_requested": v => ({ title: `More information needed for ${s(v.businessName)}`, body: s(v.details) || null, target: { page: "overview" } }),
  "merchant.member_added": v => ({ title: `You were added to ${s(v.businessName)}`, body: s(v.role) ? `As ${s(v.role)}` : null, target: { page: "overview" } }),
  "merchant.payout_account_changed": v => ({ title: "Payout account changed", body: join(s(v.businessName), s(v.account)), target: { page: "settings" } }),
  "merchant.kyc_status": v => ({ title: `KYC: ${s(v.status)}`, body: s(v.details) || s(v.businessName) || null, target: { page: "settings" } }),
  "finance.settlement_paid": v => ({ title: `Settlement ${s(v.number)} paid`, body: join(money(v.amount), s(v.reference) ? `Ref ${s(v.reference)}` : ""), target: { page: "payments" } }),
  "finance.invoice_issued": (v, panel) => ({ title: `Invoice ${s(v.number)} issued`, body: join(money(v.amount), s(v.dueDate) ? `due ${s(v.dueDate)}` : ""), target: { page: panel === "/banking-merchant" ? "billing" : "payments" } }),
  "finance.dispute_update": v => ({ title: `Claim ${s(v.number)}: ${s(v.status)}`, body: join(s(v.trackingId), s(v.details)), target: { page: "payments" } }),
  "import.completed": (v, panel) => ({
    title: `Import ${s(v.number)} finished`,
    body: join(s(v.fileName), `${s(v.created) || 0} created`, Number(v.incomplete) ? `${s(v.incomplete)} need info` : "", Number(v.notCreated) ? `${s(v.notCreated)} not created` : ""),
    target: { page: panel === "/courier-operation" ? "all-parcels" : "orders" },
  }),
  // riders
  "rider.application_status": v => ({ title: `Rider application: ${s(v.status)}`, body: s(v.details) || null }),
  "rider.kyc_status": v => ({ title: `Verification: ${s(v.status)}`, body: s(v.note) || s(v.details) || null, target: { page: "settings" } }),
  "rider.payout_paid": v => ({ title: "Payout paid", body: join(s(v.amount), s(v.method), s(v.reference) ? `Ref ${s(v.reference)}` : ""), target: { page: "earnings" } }),
  // support
  "support.ticket_reply": v => ({ title: `New reply on ${s(v.ticketNumber)}`, body: s(v.subject) || null, target: ticket(v) }),
  "support.ticket_status": v => ({ title: `${s(v.ticketNumber)} is now ${s(v.status)}`, body: s(v.subject) || null, target: ticket(v) }),
  "support.csat_request": v => ({ title: `How did we do on ${s(v.ticketNumber)}?`, body: "Rate the support you received.", target: ticket(v) }),
  "support.sla_escalation": v => ({ title: `SLA breach on ${s(v.ticketNumber)}`, body: join(s(v.breach), s(v.priority), s(v.subject)), target: ticket(v) }),
  "partner.application_status": v => ({ title: `Franchise application ${s(v.number)}: ${s(v.status)}`, body: s(v.details) || null }),
  // operations
  "ops.sla_breach": v => ({
    title: `${s(v.count)} parcel${Number(v.count) === 1 ? "" : "s"} breached SLA${s(v.hub) ? ` at ${s(v.hub)}` : ""}`,
    body: "Late on their delivery promise: open Problems › SLA late-risk.",
    target: { page: "problems", tab: "sla-late-risk" },
  }),
};
