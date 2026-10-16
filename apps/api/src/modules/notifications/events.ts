/**
 * Every notification the platform can send. Each has an SMS and/or email template that
 * super admins can edit, and an on/off toggle. Add new events here (append; keep keys stable).
 */
export const NOTIFICATION_EVENTS = [
  // accounts
  "auth.otp.signup",
  "auth.otp.login",
  "auth.otp.password_reset",
  "auth.password_changed",
  "auth.email_verification",
  "auth.mfa_enabled",
  "account.invite",
  // parcels (sender / recipient)
  "parcel.booked",
  "parcel.pickup_assigned",
  "parcel.picked_up",
  "parcel.out_for_delivery",
  "parcel.delivery_code",
  "parcel.delivered",
  "parcel.delivery_failed",
  "parcel.cancelled",
  "parcel.return_scheduled",
  "parcel.returned",
  "parcel.feedback_request",
  "guest.booking_verification",
  // merchants
  "merchant.application_received",
  "merchant.approved",
  "merchant.rejected",
  "merchant.info_requested",
  "merchant.member_added",
  "merchant.payout_account_changed",
  "merchant.kyc_status",
  "finance.settlement_paid",
  "finance.invoice_issued",
  // riders
  "rider.application_status",
  "rider.kyc_status",
  "rider.payout_paid",
  // support
  "support.ticket_reply",
  "support.ticket_status",
  "support.csat_request",
  // operations
  "ops.sla_breach",
  "ops.scheduled_report",
  // accounts (appended)
  "auth.signup_existing_account",
  // platform security (appended)
  "auth.mfa_disabled",
  "auth.mfa_reset",
  "account.support_access",
  // finance, support and partner applications (appended)
  "finance.dispute_update",
  "support.sla_escalation",
  "partner.application_status",
  // hub drop-off bookings (appended)
  "parcel.drop_off_booked",
  // switching between rider pickup and hub drop-off (appended)
  "parcel.changed_to_drop_off",
  "parcel.changed_to_pickup",
  // spreadsheet imports (appended)
  "import.completed",
] as const;

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];
