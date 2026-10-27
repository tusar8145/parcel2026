-- Deletes all operational DATA (users, merchants, customers, riders, parcels and everything tied
-- to them, finance postings, support, audit, analytics) and keeps CONFIGURATION (settings,
-- rate cards, service plans, notification templates/gateways, roles, canned responses, SLA
-- policies, report schedules, ledger chart of accounts, hubs, delivery zones/routes, linehaul
-- vehicles, number counters). One transaction; TRUNCATE without CASCADE, so Postgres refuses
-- the whole script if a kept table references a truncated one.
--
-- Take a backup first:
--   pg_dump -h localhost -U pairaexpress -d pairaexpress -Fc -f apps/api/.data/backups/pairaexpress-<ts>-before-reset.dump
-- Run:
--   psql -h localhost -U pairaexpress -d pairaexpress -v ON_ERROR_STOP=1 -f apps/api/scripts/reset-data-keep-config.sql
-- Afterwards: delete the uploaded files under apps/api/.data/files and the Redis session / OTP /
-- rate-limit keys (see the comment at the end).
--
-- Counters are kept on purpose: tracking IDs, invoice, settlement, journal and merchant numbers
-- are never reused. Journal tables are append-only (row triggers); TRUNCATE is the only way
-- to empty them and is meant for resets like this one only.
\set ON_ERROR_STOP on
BEGIN;

TRUNCATE
  -- parcels and their lifecycle
  parcels, tracking_events, delivery_attempts, delivery_proofs, parcel_feedback, sla_alerts,
  scan_events, booking_batches, import_jobs, import_rows, bulk_bookings, guest_verifications,
  return_runs, disputes, dispute_notes, cn_batches, cn_stock,
  linehaul_trips, linehaul_bags, linehaul_bag_items, linehaul_discrepancies, route_plans,
  -- money
  cod_collections, cash_handovers, cash_handover_requests, merchant_settlements, invoices,
  merchant_adjustments, settlement_schedules, bank_statements, bank_statement_lines,
  journal_entries, journal_lines, ledger_periods,
  -- merchants
  merchants, api_keys, webhook_endpoints, webhook_deliveries, merchant_invites,
  merchant_kyc_documents, merchant_notes, merchant_rate_overrides, products,
  pickup_schedules, pickup_requests,
  -- riders (the rider rows themselves are deleted below)
  rider_locations, rider_location_points, rider_pay_plans, rider_earnings, rider_payouts,
  rider_onboarding, rider_kyc_documents, rider_shift_schedules, rider_attendance,
  -- users (the user rows themselves are deleted below)
  user_roles, sessions, addresses, otp_challenges, user_mfa, mfa_recovery_codes,
  email_verifications, notification_preferences, impersonation_sessions,
  -- support, applications, platform records
  support_tickets, ticket_messages, ticket_surveys, partner_applications, stored_files,
  outbox_messages, audit_logs, idempotency_records, change_requests, report_runs,
  analytics_daily, analytics_hourly;

-- delivery_routes (config) may name a default rider (ON DELETE SET NULL), so riders can't be
-- truncated; every table that references riders or users is empty now.
DELETE FROM riders;
DELETE FROM users;

-- Per-merchant entries in the platform config belong to the deleted merchants.
UPDATE settings
SET value = (
  SELECT jsonb_object_agg(k, CASE
    WHEN k IN ('merchantPlanAssignments', 'merchantDiscounts', 'merchantPlanOverrides') AND jsonb_typeof(v) = 'object' THEN '{}'::jsonb
    WHEN k = 'entitlements' AND jsonb_typeof(v) = 'array' THEN '[]'::jsonb
    ELSE v END)
  FROM jsonb_each(value) AS e(k, v))
WHERE key = 'platform-config' AND jsonb_typeof(value) = 'object';

-- Background jobs that point at deleted rows (schedules, queues and cron history are kept).
DELETE FROM pgboss.job WHERE name IN ('outbox', 'webhooks', 'imports', 'bulk-bookings');
DELETE FROM pgboss.archive WHERE name IN ('outbox', 'webhooks', 'imports', 'bulk-bookings');

INSERT INTO audit_logs (id, "actorType", "actorLabel", action, "entityType", data)
VALUES (gen_random_uuid(), 'SYSTEM', 'Data reset script', 'system.data_reset', 'database',
        '{"script": "apps/api/scripts/reset-data-keep-config.sql", "kept": "configuration"}'::jsonb);

COMMIT;

-- Redis (after commit), in the API's database:
--   auth:revoked-session:*  auth:user-version:*  mfa:challenge:*  otp:*  guest-otp:*
--   sms:rl:*  email-verify:*  throttle:*  outbox:lock:*
-- Keep: authz:version, notifications:config:version, geo:* (address cache).
