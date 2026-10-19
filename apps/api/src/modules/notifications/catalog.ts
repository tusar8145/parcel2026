import { NOTIFICATION_EVENTS, type NotificationEvent } from "./events";

export type Channel = "sms" | "email";
export const CHANNELS: readonly Channel[] = ["sms", "email"];
export const OUTBOX_CHANNEL = { sms: "SMS", email: "EMAIL" } as const;
export const CHANNEL_OF = { SMS: "sms", EMAIL: "email" } as const;

/** Sections of the super admin template list, in display order. */
export const EVENT_GROUPS = ["Parcel", "Merchant", "Finance", "Support", "Account & security", "Operations", "Rider", "Partner"] as const;
export type EventGroup = (typeof EVENT_GROUPS)[number];

export interface EventDefinition {
  label: string;
  group: EventGroup;
  /** Who usually receives it (shown to admins). */
  audience: string;
  /**
   * Security / transactional messages: people can't opt out, admins can't switch the
   * channel off (`locked`), and SMS skip the per-recipient spacing and caps.
   */
  mandatory?: boolean;
  /** Placeholders the template may use (always also: appName, appUrl, support, name). */
  vars: string[];
  /** Placeholders a template must keep (e.g. the code in an OTP). */
  required?: string[];
  /** Sample values for previews. */
  sample: Record<string, string>;
  /** Default SMS text (short, GSM-7 friendly). Omit if the event has no SMS. */
  sms?: string;
  /** Default email. `html` defaults to the text as paragraphs. */
  email?: { subject: string; text: string; html?: string };
  /** Off unless an admin switches it on. */
  defaultOff?: Channel[];
}

export const COMMON_VARS = ["appName", "appUrl", "support", "name"] as const;

const track = { trackingId: "PP-261016-4821", trackingUrl: "https://deliveryfast.example/#/tracking/PP-261016-4821" };

/**
 * Default texts. Placeholders: {{var}}; sections {{#var}}…{{/var}} render only when var is set
 * (and not 0). Keep SMS under 160 GSM characters where possible ("Tk" instead of "৳").
 */
export const EVENT_CATALOG: Record<NotificationEvent, EventDefinition> = {
  "auth.otp.signup": {
    label: "Sign-up code",
    group: "Account & security",
    audience: "New customer",
    mandatory: true,
    vars: ["code", "minutes"],
    required: ["code"],
    sample: { code: "482913", minutes: "5" },
    sms: "{{code}} is your Delivery Fast sign-up code. It expires in {{minutes}} minutes. Never share it.",
  },
  "auth.otp.login": {
    label: "Sign-in code",
    group: "Account & security",
    audience: "Any user",
    mandatory: true,
    vars: ["code", "minutes"],
    required: ["code"],
    sample: { code: "482913", minutes: "5" },
    sms: "{{code}} is your Delivery Fast sign-in code. It expires in {{minutes}} minutes. Never share it.",
  },
  "auth.otp.password_reset": {
    label: "Password reset code",
    group: "Account & security",
    audience: "Any user",
    mandatory: true,
    vars: ["code", "minutes"],
    required: ["code"],
    sample: { code: "482913", minutes: "5" },
    sms: "{{code}} is your Delivery Fast password reset code. It expires in {{minutes}} minutes. Never share it.",
  },
  "auth.password_changed": {
    label: "Password changed",
    group: "Account & security",
    audience: "Any user",
    mandatory: true,
    vars: ["at"],
    sample: { at: "16 Oct 2026, 10:24" },
    sms: "Your Delivery Fast password was changed. If this wasn't you, contact {{support}} now.",
    email: {
      subject: "Your Delivery Fast password was changed",
      text: "Hi {{name}},\n\nThe password for your Delivery Fast account was changed on {{at}}.\n\nIf you didn't do this, reset your password at {{appUrl}} and contact {{support}} right away.",
    },
  },
  "auth.email_verification": {
    label: "Email verification",
    group: "Account & security",
    audience: "Any user",
    mandatory: true,
    vars: ["link", "code"],
    required: ["link"],
    sample: { link: "https://deliveryfast.example/account/verify-email?token=abc", code: "482913" },
    email: {
      subject: "Confirm your email address",
      text: "Hi {{name}},\n\nConfirm this email address for your Delivery Fast account: {{link}}\n\nOr enter this code on the website: {{code}} (valid for 24 hours).\n\nIf you didn't ask for this, ignore this email.",
    },
  },
  "auth.mfa_enabled": {
    label: "Two-step verification turned on",
    group: "Account & security",
    audience: "Staff and merchants",
    mandatory: true,
    vars: ["at"],
    sample: { at: "16 Oct 2026, 10:24" },
    sms: "Two-step verification was turned on for your Delivery Fast account. Not you? Contact {{support}}.",
    email: {
      subject: "Two-step verification is on",
      text: "Hi {{name}},\n\nTwo-step verification was turned on for your Delivery Fast account on {{at}}.\n\nIf this wasn't you, contact {{support}} right away.",
    },
  },
  "account.invite": {
    label: "Account invitation",
    group: "Account & security",
    audience: "Invited staff / team member",
    mandatory: true,
    vars: ["inviter", "role", "link"],
    sample: { inviter: "Alex Morgan", role: "Operations Administrator", link: "https://deliveryfast.example/#/login" },
    sms: "{{inviter}} added you to Delivery Fast as {{role}}. Sign in: {{link}}",
    email: {
      subject: "You've been invited to Delivery Fast",
      text: "Hi {{name}},\n\n{{inviter}} added you to Delivery Fast as {{role}}.\n\nSign in here: {{link}}",
    },
  },
  "parcel.booked": {
    label: "Pickup request received",
    group: "Parcel",
    audience: "Sender",
    vars: ["trackingId", "charge", "trackingUrl"],
    sample: { ...track, charge: "185" },
    sms: "Pickup request {{trackingId}} received. Delivery charge Tk {{charge}}. Track: {{trackingUrl}}",
    email: {
      subject: "Pickup request {{trackingId}} received",
      text: "Hi {{name}},\n\nWe received your pickup request {{trackingId}}. Delivery charge: Tk {{charge}}.\n\nTrack it any time: {{trackingUrl}}",
    },
  },
  "parcel.pickup_assigned": {
    label: "Pickup rider assigned",
    group: "Parcel",
    audience: "Sender",
    vars: ["trackingId", "riderName", "trackingUrl"],
    sample: { ...track, riderName: "Jordan Rivera" },
    sms: "A rider is on the way to collect {{trackingId}}. Track: {{trackingUrl}}",
    email: {
      subject: "A rider will collect {{trackingId}}",
      text: "Hi {{name}},\n\nA Delivery Fast rider has been assigned to collect parcel {{trackingId}}.\n\nTrack it: {{trackingUrl}}",
    },
    defaultOff: ["sms"],
  },
  "parcel.picked_up": {
    label: "Parcel picked up",
    group: "Parcel",
    audience: "Sender",
    vars: ["trackingId", "trackingUrl"],
    sample: track,
    sms: "Parcel {{trackingId}} was picked up. Track: {{trackingUrl}}",
    email: {
      subject: "Parcel {{trackingId}} was picked up",
      text: "Hi {{name}},\n\nOur rider collected parcel {{trackingId}}.\n\nTrack it: {{trackingUrl}}",
    },
    defaultOff: ["sms"],
  },
  "parcel.out_for_delivery": {
    label: "Out for delivery",
    group: "Parcel",
    audience: "Recipient",
    vars: ["trackingId", "riderName", "riderPhone", "trackingUrl"],
    sample: { ...track, riderName: "Jordan Rivera", riderPhone: "+8801710002048" },
    sms: "Parcel {{trackingId}} is out for delivery today.{{#riderPhone}} Rider: {{riderPhone}}.{{/riderPhone}} Track: {{trackingUrl}}",
    email: {
      subject: "Parcel {{trackingId}} is out for delivery",
      text: "Hi {{name}},\n\nParcel {{trackingId}} is out for delivery today.\n\nTrack it: {{trackingUrl}}",
    },
    defaultOff: ["sms"],
  },
  "parcel.delivery_code": {
    label: "Delivery code",
    group: "Parcel",
    audience: "Recipient",
    mandatory: true,
    vars: ["trackingId", "code", "codAmount"],
    required: ["code"],
    sample: { ...track, code: "4821", codAmount: "1,500" },
    sms: "Your Delivery Fast parcel {{trackingId}} is on its way.{{#codAmount}} Please keep Tk {{codAmount}} ready.{{/codAmount}} Give code {{code}} to the rider only after you receive the parcel.",
  },
  "parcel.delivered": {
    label: "Delivered",
    group: "Parcel",
    audience: "Sender",
    vars: ["trackingId", "receivedBy", "trackingUrl"],
    sample: { ...track, receivedBy: "Nabila Ahmed" },
    sms: "Your parcel {{trackingId}} was delivered. Details: {{trackingUrl}}",
    email: {
      subject: "Parcel {{trackingId}} was delivered",
      text: "Hi {{name}},\n\nParcel {{trackingId}} was delivered{{#receivedBy}} and received by {{receivedBy}}{{/receivedBy}}.\n\nDetails: {{trackingUrl}}",
    },
  },
  "parcel.delivery_failed": {
    label: "Delivery attempt failed",
    group: "Parcel",
    audience: "Sender",
    vars: ["trackingId", "reason", "trackingUrl"],
    sample: { ...track, reason: "Recipient unavailable" },
    sms: "We couldn't deliver {{trackingId}}{{#reason}} ({{reason}}){{/reason}}. We'll try again. Track: {{trackingUrl}}",
    email: {
      subject: "Delivery attempt for {{trackingId}} failed",
      text: "Hi {{name}},\n\nWe couldn't deliver parcel {{trackingId}}{{#reason}}: {{reason}}{{/reason}}. We'll try again.\n\nTrack it: {{trackingUrl}}",
    },
  },
  "parcel.cancelled": {
    label: "Pickup cancelled",
    group: "Parcel",
    audience: "Sender",
    vars: ["trackingId", "trackingUrl"],
    sample: track,
    sms: "Pickup request {{trackingId}} was cancelled.",
    email: {
      subject: "Pickup request {{trackingId}} was cancelled",
      text: "Hi {{name}},\n\nPickup request {{trackingId}} was cancelled. Book again any time at {{appUrl}}.",
    },
  },
  "parcel.return_scheduled": {
    label: "Return scheduled",
    group: "Parcel",
    audience: "Sender",
    vars: ["trackingId", "reason", "returnCharge", "trackingUrl"],
    sample: { ...track, reason: "Refused by recipient", returnCharge: "60" },
    sms: "Parcel {{trackingId}} will be returned to you{{#reason}} ({{reason}}){{/reason}}. Track: {{trackingUrl}}",
    email: {
      subject: "Parcel {{trackingId}} will be returned",
      text: "Hi {{name}},\n\nParcel {{trackingId}} will be returned to you{{#reason}}: {{reason}}{{/reason}}.{{#returnCharge}} Return charge: Tk {{returnCharge}}.{{/returnCharge}}\n\nTrack it: {{trackingUrl}}",
    },
  },
  "parcel.returned": {
    label: "Returned to sender",
    group: "Parcel",
    audience: "Sender",
    vars: ["trackingId", "reason", "returnCharge", "trackingUrl"],
    sample: { ...track, reason: "Refused by recipient", returnCharge: "60" },
    sms: "Parcel {{trackingId}} was returned to you. Details: {{trackingUrl}}",
    email: {
      subject: "Parcel {{trackingId}} was returned",
      text: "Hi {{name}},\n\nParcel {{trackingId}} was returned to you{{#reason}} ({{reason}}){{/reason}}.{{#returnCharge}} Return charge: Tk {{returnCharge}}.{{/returnCharge}}\n\nDetails: {{trackingUrl}}",
    },
  },
  "parcel.feedback_request": {
    label: "Feedback request",
    group: "Parcel",
    audience: "Recipient / sender",
    vars: ["trackingId", "link"],
    sample: { ...track, link: "https://deliveryfast.example/track/PP-261016-7K3QF?t=f.abc#feedback" },
    sms: "How was your Delivery Fast delivery {{trackingId}}? Tell us: {{link}}",
    email: {
      subject: "How did we do with {{trackingId}}?",
      text: "Hi {{name}},\n\nHow was your delivery of {{trackingId}}? It takes a minute: {{link}}",
    },
    defaultOff: ["sms"],
  },
  "guest.booking_verification": {
    label: "Guest booking verification",
    group: "Parcel",
    audience: "Guest sender",
    mandatory: true,
    vars: ["code", "minutes"],
    required: ["code"],
    sample: { code: "482913", minutes: "5" },
    sms: "{{code}} is your Delivery Fast booking code. It expires in {{minutes}} minutes. Never share it.",
  },
  "merchant.application_received": {
    label: "Merchant application received",
    group: "Merchant",
    audience: "Applicant",
    vars: ["businessName", "reference"],
    sample: { businessName: "Northstar Store", reference: "MER-10048" },
    sms: "We received the Delivery Fast merchant application for {{businessName}} (ref {{reference}}). We'll be in touch soon.",
    email: {
      subject: "We received your merchant application",
      text: "Hi {{name}},\n\nThanks for applying to ship with Delivery Fast. We received the application for {{businessName}} (reference {{reference}}) and will review it shortly.",
    },
  },
  "merchant.invite": {
    label: "Merchant invitation",
    group: "Merchant",
    audience: "Invited merchant",
    mandatory: true,
    vars: ["role", "link"],
    required: ["link"],
    sample: { role: "an E-commerce merchant (Northstar Store)", link: "https://deliveryfast.example/merchant?invite=abc" },
    sms: "You're invited to join Delivery Fast as {{role}}. Create your account and apply here: {{link}}",
    email: {
      subject: "Your invitation to join Delivery Fast",
      text: "Hi {{name}},\n\nYou're invited to join Delivery Fast as {{role}}.\n\nOpen this link to create your account and send your merchant application (the link works once): {{link}}",
    },
  },
  "merchant.approved": {
    label: "Merchant approved",
    group: "Merchant",
    audience: "Merchant owner",
    vars: ["businessName", "link"],
    sample: { businessName: "Northstar Store", link: "https://deliveryfast.example/#/login" },
    sms: "{{businessName}} is approved on Delivery Fast. Sign in to start booking: {{link}}",
    email: {
      subject: "{{businessName}} is approved",
      text: "Hi {{name}},\n\nGood news: {{businessName}} is approved on Delivery Fast. Sign in to start booking pickups: {{link}}",
    },
  },
  "merchant.rejected": {
    label: "Merchant application declined",
    group: "Merchant",
    audience: "Applicant",
    vars: ["businessName", "reason"],
    sample: { businessName: "Northstar Store", reason: "Trade licence could not be verified" },
    sms: "Your Delivery Fast merchant application for {{businessName}} was not approved. Contact {{support}} for details.",
    email: {
      subject: "Your merchant application",
      text: "Hi {{name}},\n\nWe couldn't approve the application for {{businessName}}{{#reason}}: {{reason}}{{/reason}}.\n\nQuestions? Contact {{support}}.",
    },
  },
  "merchant.info_requested": {
    label: "More information requested",
    group: "Merchant",
    audience: "Applicant",
    vars: ["businessName", "details", "link"],
    sample: { businessName: "Northstar Store", details: "A clearer photo of the trade licence", link: "https://deliveryfast.example/#/login" },
    sms: "Delivery Fast needs more information for {{businessName}}. Details: {{link}}",
    email: {
      subject: "We need a little more information",
      text: "Hi {{name}},\n\nTo finish reviewing {{businessName}} we need: {{details}}\n\nUpdate your application here: {{link}}",
    },
  },
  "merchant.member_added": {
    label: "Team member added",
    group: "Merchant",
    audience: "Merchant team member",
    vars: ["businessName", "role", "link"],
    sample: { businessName: "Northstar Store", role: "Staff", link: "https://deliveryfast.example/#/login" },
    sms: "You were added to {{businessName}} on Delivery Fast as {{role}}. Sign in: {{link}}",
    email: {
      subject: "You were added to {{businessName}}",
      text: "Hi {{name}},\n\nYou were added to {{businessName}} on Delivery Fast as {{role}}. Sign in: {{link}}",
    },
  },
  "merchant.payout_account_changed": {
    label: "Payout account changed",
    group: "Merchant",
    audience: "Merchant owner",
    mandatory: true,
    vars: ["businessName", "account"],
    sample: { businessName: "Northstar Store", account: "bKash ••••4521" },
    sms: "The payout account for {{businessName}} was changed to {{account}}. Not you? Contact {{support}} now.",
    email: {
      subject: "Payout account changed for {{businessName}}",
      text: "Hi {{name}},\n\nThe payout account for {{businessName}} was changed to {{account}}.\n\nIf you didn't make this change, contact {{support}} right away.",
    },
  },
  "merchant.address_change": {
    label: "Merchant address change decided",
    group: "Merchant",
    audience: "Merchant owner",
    vars: ["businessName", "status", "details"],
    sample: { businessName: "Northstar Store", status: "approved", details: "Pickups now go through Motijheel Service Center." },
    sms: "Address change for {{businessName}} {{status}}. {{details}}",
    email: {
      subject: "Address change {{status}} for {{businessName}}",
      text: "Hi {{name}},\n\nThe address change you asked for on {{businessName}} was {{status}}.{{#details}}\n\n{{details}}{{/details}}",
    },
  },
  "merchant.kyc_status": {
    label: "Merchant KYC update",
    group: "Merchant",
    audience: "Merchant owner",
    vars: ["businessName", "status", "details"],
    sample: { businessName: "Northstar Store", status: "Verified", details: "" },
    sms: "KYC for {{businessName}}: {{status}}.",
    email: {
      subject: "KYC update for {{businessName}}",
      text: "Hi {{name}},\n\nKYC status for {{businessName}}: {{status}}.{{#details}}\n\n{{details}}{{/details}}",
    },
  },
  "finance.settlement_paid": {
    label: "Settlement paid",
    group: "Finance",
    audience: "Merchant owner",
    vars: ["number", "amount", "reference"],
    sample: { number: "STL-000123", amount: "48,250.00", reference: "BEFTN-99812" },
    sms: "Delivery Fast: settlement {{number}} of Tk {{amount}} has been paid. Ref: {{reference}}",
    email: {
      subject: "Settlement {{number}} paid",
      text: "Hi {{name}},\n\nSettlement {{number}} of Tk {{amount}} has been paid. Reference: {{reference}}.",
    },
  },
  "finance.invoice_issued": {
    label: "Invoice issued",
    group: "Finance",
    audience: "Merchant owner",
    vars: ["number", "amount", "dueDate", "link"],
    sample: { number: "INV-2026-10-0042", amount: "12,400.00", dueDate: "31 Oct 2026", link: "https://deliveryfast.example/ecommerce-merchant" },
    sms: "Delivery Fast invoice {{number}} for Tk {{amount}} is due {{dueDate}}.",
    email: {
      subject: "Invoice {{number}}",
      text: "Hi {{name}},\n\nInvoice {{number}} for Tk {{amount}} is due on {{dueDate}}.\n\nView it: {{link}}",
    },
  },
  "rider.application_status": {
    label: "Rider application update",
    group: "Rider",
    audience: "Rider applicant",
    vars: ["status", "details"],
    sample: { status: "Approved", details: "" },
    sms: "Your Delivery Fast rider application: {{status}}.{{#details}} {{details}}{{/details}}",
    email: {
      subject: "Your rider application: {{status}}",
      text: "Hi {{name}},\n\nYour Delivery Fast rider application status: {{status}}.{{#details}}\n\n{{details}}{{/details}}",
    },
  },
  "rider.kyc_status": {
    label: "Rider KYC update",
    group: "Rider",
    audience: "Rider",
    vars: ["status", "note", "details"],
    sample: { status: "Verified", note: "", details: "" },
    sms: "Your Delivery Fast rider KYC: {{status}}.{{#note}} {{note}}{{/note}}",
    email: {
      subject: "Rider KYC: {{status}}",
      text: "Hi {{name}},\n\nYour rider KYC status: {{status}}.{{#note}}\n\n{{note}}{{/note}}{{#details}}\n\n{{details}}{{/details}}",
    },
  },
  "rider.payout_paid": {
    label: "Rider payout paid",
    group: "Rider",
    audience: "Rider",
    vars: ["amount", "number", "method", "reference"],
    sample: { amount: "Tk 6,800", number: "RP-000231", method: "bKash", reference: "BKASH-77120" },
    sms: "Delivery Fast paid you {{amount}}{{#method}} by {{method}}{{/method}}. Ref: {{reference}}",
    email: {
      subject: "Payout of {{amount}} sent",
      text: "Hi {{name}},\n\nWe paid you {{amount}}{{#method}} by {{method}}{{/method}}{{#number}} (payout {{number}}){{/number}}. Reference: {{reference}}.",
    },
  },
  "support.ticket_reply": {
    label: "Support reply",
    group: "Support",
    audience: "Ticket requester",
    vars: ["ticketNumber", "subject", "link"],
    sample: { ticketNumber: "TKT-1042", subject: "Parcel delayed", link: "https://deliveryfast.example/#/support" },
    sms: "Delivery Fast replied to ticket {{ticketNumber}}. View: {{link}}",
    email: {
      subject: "Re: {{subject}} [{{ticketNumber}}]",
      text: "Hi {{name}},\n\nWe replied to your ticket {{ticketNumber}} ({{subject}}).\n\nView the reply: {{link}}",
    },
    defaultOff: ["sms"],
  },
  "support.ticket_status": {
    label: "Ticket status changed",
    group: "Support",
    audience: "Ticket requester",
    vars: ["ticketNumber", "subject", "status", "link"],
    sample: { ticketNumber: "TKT-1042", subject: "Parcel delayed", status: "Resolved", link: "https://deliveryfast.example/#/support" },
    sms: "Ticket {{ticketNumber}} is now {{status}}. View: {{link}}",
    email: {
      subject: "Ticket {{ticketNumber}}: {{status}}",
      text: "Hi {{name}},\n\nYour ticket {{ticketNumber}} ({{subject}}) is now {{status}}.\n\nView it: {{link}}",
    },
    defaultOff: ["sms"],
  },
  "support.csat_request": {
    label: "Support satisfaction survey",
    group: "Support",
    audience: "Ticket requester",
    vars: ["ticketNumber", "link"],
    sample: { ticketNumber: "TKT-1042", link: "https://deliveryfast.example/#/support" },
    sms: "How did we do on ticket {{ticketNumber}}? Rate us: {{link}}",
    email: {
      subject: "How did we do? [{{ticketNumber}}]",
      text: "Hi {{name}},\n\nHow happy are you with how we handled ticket {{ticketNumber}}? Rate us: {{link}}",
    },
    defaultOff: ["sms"],
  },
  "ops.sla_breach": {
    label: "SLA breach alert",
    group: "Operations",
    audience: "Operations staff",
    vars: ["count", "hub", "link"],
    sample: { count: "7", hub: "Gulshan hub", link: "https://deliveryfast.example/courier-operation" },
    sms: "Delivery Fast: {{count}} parcels breached SLA{{#hub}} at {{hub}}{{/hub}}. {{link}}",
    email: {
      subject: "SLA alert: {{count}} parcels{{#hub}} at {{hub}}{{/hub}}",
      text: "Hi {{name}},\n\n{{count}} parcels are past their SLA{{#hub}} at {{hub}}{{/hub}}.\n\nReview them: {{link}}",
    },
    defaultOff: ["sms"],
  },
  "ops.scheduled_report": {
    label: "Scheduled report",
    group: "Operations",
    audience: "Staff",
    vars: ["report", "period", "link"],
    sample: { report: "Daily delivery summary", period: "15 Oct 2026", link: "https://deliveryfast.example/courier-operation" },
    email: {
      subject: "{{report}} · {{period}}",
      text: "Hi {{name}},\n\nYour scheduled report \"{{report}}\" for {{period}} is ready: {{link}}",
    },
  },
  "auth.signup_existing_account": {
    label: "Sign-up attempt on an existing number",
    group: "Account & security",
    audience: "Existing user",
    mandatory: true,
    vars: [],
    sample: {},
    sms: "This number already has a Delivery Fast account. Sign in, or reset your password if you forgot it.",
  },
  "auth.mfa_disabled": {
    label: "Two-step verification turned off",
    group: "Account & security",
    audience: "Staff and merchants",
    mandatory: true,
    vars: ["at"],
    sample: { at: "16 Oct 2026, 10:24" },
    sms: "Two-step verification was turned off for your Delivery Fast account. Not you? Contact {{support}}.",
    email: {
      subject: "Two-step verification is off",
      text: "Hi {{name}},\n\nTwo-step verification was turned off for your Delivery Fast account on {{at}}.\n\nIf this wasn't you, change your password and contact {{support}} right away.",
    },
  },
  "auth.mfa_reset": {
    label: "Two-step verification reset by an administrator",
    group: "Account & security",
    audience: "Staff and merchants",
    mandatory: true,
    vars: ["admin"],
    sample: { admin: "Alex Morgan" },
    sms: "A Delivery Fast administrator ({{admin}}) reset two-step verification on your account. Set it up again at your next sign-in.",
    email: {
      subject: "Your two-step verification was reset",
      text: "Hi {{name}},\n\n{{admin}} reset two-step verification on your Delivery Fast account, and your devices were signed out. Set it up again the next time you sign in.\n\nIf you didn't ask for this, contact {{support}} right away.",
    },
  },
  "account.support_access": {
    label: "Support access to an account",
    group: "Account & security",
    audience: "Any user",
    vars: ["admin", "minutes", "mode"],
    sample: { admin: "Alex Morgan", minutes: "15", mode: "view-only" },
    sms: "Delivery Fast support ({{admin}}) is viewing your account ({{mode}}) for up to {{minutes}} minutes to help with your request.",
    email: {
      subject: "Delivery Fast support is viewing your account",
      text: "Hi {{name}},\n\n{{admin}} from Delivery Fast support opened your account ({{mode}}) for up to {{minutes}} minutes to help with your request. Every action is recorded.\n\nIf you didn't ask for help, contact {{support}}.",
    },
  },
  "finance.dispute_update": {
    label: "Dispute / claim update",
    group: "Finance",
    audience: "Customer or merchant who raised it",
    vars: ["number", "trackingId", "status", "details", "link"],
    sample: { number: "DSP-261016-0001", trackingId: "PP-261016-4821", status: "Approved", details: "Tk 500 will be credited to your next settlement.", link: "https://deliveryfast.example/#/support" },
    sms: "Delivery Fast: claim {{number}} for {{trackingId}} is {{status}}.{{#details}} {{details}}{{/details}}",
    email: {
      subject: "Claim {{number}}: {{status}}",
      text: "Hi {{name}},\n\nYour claim {{number}} for parcel {{trackingId}} is now {{status}}.{{#details}}\n\n{{details}}{{/details}}\n\nView it: {{link}}",
    },
  },
  "support.sla_escalation": {
    label: "Support SLA escalation",
    group: "Support",
    audience: "Support agents and operations managers",
    vars: ["ticketNumber", "subject", "breach", "priority", "link"],
    sample: { ticketNumber: "DF-SUP-261016-0007", subject: "Parcel delayed", breach: "first response", priority: "High", link: "https://deliveryfast.example/courier-operation" },
    sms: "SLA breach ({{breach}}) on ticket {{ticketNumber}} [{{priority}}]. {{link}}",
    email: {
      subject: "SLA breach: {{ticketNumber}} ({{breach}})",
      text: "Hi {{name}},\n\nTicket {{ticketNumber}} ({{subject}}) missed its {{breach}} target and was escalated to {{priority}} priority.\n\nReview it: {{link}}",
    },
    defaultOff: ["sms"],
  },
  "partner.application_status": {
    label: "Franchise application update",
    group: "Partner",
    audience: "Franchise applicant",
    vars: ["number", "status", "details", "link"],
    sample: { number: "DF-SUP-261016-0003", status: "Under review", details: "", link: "https://deliveryfast.example/#/support" },
    sms: "Your Delivery Fast franchise application {{number}}: {{status}}.{{#details}} {{details}}{{/details}}",
    email: {
      subject: "Your franchise application: {{status}}",
      text: "Hi {{name}},\n\nYour Delivery Fast franchise application {{number}} is now: {{status}}.{{#details}}\n\n{{details}}{{/details}}\n\nFollow up: {{link}}",
    },
  },
  "parcel.drop_off_booked": {
    label: "Drop-off booking received",
    group: "Parcel",
    audience: "Sender",
    vars: ["trackingId", "charge", "hub", "hubAddress", "trackingUrl"],
    sample: { ...track, charge: "185", hub: "Gulshan Sorting Hub", hubAddress: "Plot 12, Gulshan Avenue" },
    sms: "Booking {{trackingId}} received. Bring the parcel to {{hub}}. Delivery charge Tk {{charge}}. Track: {{trackingUrl}}",
    email: {
      subject: "Booking {{trackingId}}: bring the parcel to {{hub}}",
      text: "Hi {{name}},\n\nWe received your booking {{trackingId}}. Please bring the parcel to {{hub}} ({{hubAddress}}); it is on its way as soon as the hub receives it. Delivery charge: Tk {{charge}}.\n\nTrack it any time: {{trackingUrl}}",
    },
  },
  "parcel.changed_to_drop_off": {
    label: "Changed to hub drop-off",
    group: "Parcel",
    audience: "Sender",
    vars: ["trackingId", "charge", "hub", "hubAddress", "trackingUrl"],
    sample: { ...track, charge: "185", hub: "Gulshan Sorting Hub", hubAddress: "Road 11, Gulshan 1, Dhaka" },
    sms: "{{trackingId}}: please bring the parcel to {{hub}}, no rider will come to collect it. Delivery charge Tk {{charge}}. Track: {{trackingUrl}}",
    email: {
      subject: "{{trackingId}}: bring the parcel to {{hub}}",
      text: "Hi {{name}},\n\nYour booking {{trackingId}} is now a hub drop-off: please bring the parcel to {{hub}} ({{hubAddress}}). No rider will come to collect it. It is on its way as soon as the hub receives it. Delivery charge: Tk {{charge}}.\n\nTrack it any time: {{trackingUrl}}",
    },
  },
  "parcel.changed_to_pickup": {
    label: "Changed to rider pickup",
    group: "Parcel",
    audience: "Sender",
    vars: ["trackingId", "charge", "trackingUrl"],
    sample: { ...track, charge: "185" },
    sms: "{{trackingId}}: a Delivery Fast rider will collect the parcel from your pickup address, no need to bring it to a hub. Delivery charge Tk {{charge}}. Track: {{trackingUrl}}",
    email: {
      subject: "{{trackingId}}: a rider will collect your parcel",
      text: "Hi {{name}},\n\nYour booking {{trackingId}} is now a rider pickup: a Delivery Fast rider will collect the parcel from your pickup address, so there is no need to bring it to a hub. Delivery charge: Tk {{charge}}.\n\nTrack it any time: {{trackingUrl}}",
    },
  },
  "import.completed": {
    label: "Spreadsheet import finished",
    group: "Merchant",
    audience: "Person who uploaded the file (merchant or operations)",
    vars: ["number", "fileName", "rows", "created", "incomplete", "notCreated"],
    sample: { number: "IMP-261016-004", fileName: "orders-october.xlsx", rows: "1200", created: "1180", incomplete: "35", notCreated: "20" },
    sms: "Delivery Fast: import {{number}} finished. {{created}} orders created{{#incomplete}} ({{incomplete}} need info){{/incomplete}}{{#notCreated}}, {{notCreated}} not created{{/notCreated}}.",
    email: {
      subject: "Import {{number}} finished: {{created}} orders created",
      text: "Hi {{name}},\n\nYour import {{number}} ({{fileName}}, {{rows}} rows) has finished.\n\nCreated: {{created}}{{#incomplete}}, of which {{incomplete}} need more information before delivery{{/incomplete}}.\n{{#notCreated}}Not created: {{notCreated}}. Download them from the import history with the reason for each row, fix them and upload again.\n{{/notCreated}}\nPrint the labels of the new orders from the import history.",
    },
  },
  "parcel.ready_for_collection": {
    label: "Ready for collection",
    group: "Parcel",
    audience: "Recipient",
    vars: ["trackingId", "hub", "hubAddress", "code", "codAmount", "until", "trackingUrl"],
    sample: { ...track, hub: "Gulshan Sorting Hub", hubAddress: "Plot 12, Gulshan Avenue", code: "482913", codAmount: "2,450", until: "23 Oct" },
    sms: "Parcel {{trackingId}} is ready for collection at {{hub}}, {{hubAddress}}. Collection code {{code}}.{{#codAmount}} Pay Tk {{codAmount}} at the counter.{{/codAmount}} Collect by {{until}}.",
    email: {
      subject: "Parcel {{trackingId}} is ready for collection at {{hub}}",
      text: "Hi {{name}},\n\nParcel {{trackingId}} is waiting for you at {{hub}} ({{hubAddress}}).\n\nShow this collection code at the counter: {{code}}{{#codAmount}}\nAmount to pay: Tk {{codAmount}}{{/codAmount}}\n\nPlease collect it by {{until}}; after that it goes back to the sender.\n\nTrack it: {{trackingUrl}}",
    },
  },
  "parcel.collection_reminder": {
    label: "Collection reminder",
    group: "Parcel",
    audience: "Recipient",
    vars: ["trackingId", "hub", "hubAddress", "code", "until", "trackingUrl"],
    sample: { ...track, hub: "Gulshan Sorting Hub", hubAddress: "Plot 12, Gulshan Avenue", code: "482913", until: "23 Oct" },
    sms: "Reminder: parcel {{trackingId}} is waiting at {{hub}}, {{hubAddress}}. Code {{code}}. Collect by {{until}} or it returns to the sender.",
    email: {
      subject: "Reminder: collect parcel {{trackingId}} by {{until}}",
      text: "Hi {{name}},\n\nParcel {{trackingId}} is still waiting for you at {{hub}} ({{hubAddress}}). Show the collection code {{code}} at the counter.\n\nPlease collect it by {{until}}; after that it goes back to the sender.\n\nTrack it: {{trackingUrl}}",
    },
  },
};

export const definitionOf = (event: string): EventDefinition | undefined =>
  (EVENT_CATALOG as Record<string, EventDefinition | undefined>)[event];

export const isNotificationEvent = (event: string): event is NotificationEvent => (NOTIFICATION_EVENTS as readonly string[]).includes(event);

/** Channels the event has templates for. */
export const channelsOf = (def: EventDefinition): Channel[] => CHANNELS.filter(c => (c === "sms" ? def.sms : def.email) !== undefined);

/** Legacy platform-config notification names (super admin "Global notifications") → events. */
export const LEGACY_TOGGLE_EVENTS: Record<string, NotificationEvent[]> = {
  "Pickup confirmed": ["parcel.pickup_assigned"],
  "Delivery update": ["parcel.out_for_delivery"],
  "Delivery OTP": ["parcel.delivery_code"],
  "Return started": ["parcel.return_scheduled"],
  "Sender pickup confirmation": ["parcel.picked_up"],
  "Sender delivery confirmation": ["parcel.delivered"],
  "Sender return update": ["parcel.returned"],
};
