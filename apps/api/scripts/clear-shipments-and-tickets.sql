-- Removes all shipments and support tickets, plus data that only exists because of them
-- (COD records, cash handovers, settlements, invoices, delivery proofs, attachments,
-- webhook delivery logs, idempotency records).
-- Keeps users, merchants, riders, hubs, pricing, settings and the audit log.
-- Run: psql -h localhost -U pairaexpress -d pairaexpress -f apps/api/scripts/clear-shipments-and-tickets.sql
BEGIN;
DELETE FROM cod_collections;
DELETE FROM cash_handovers;
DELETE FROM merchant_settlements;
DELETE FROM invoices;
DELETE FROM delivery_proofs;
DELETE FROM delivery_attempts;
DELETE FROM tracking_events;
DELETE FROM ticket_messages;
DELETE FROM support_tickets;
DELETE FROM parcels;
DELETE FROM stored_files;
DELETE FROM webhook_deliveries;
DELETE FROM idempotency_records;
COMMIT;
