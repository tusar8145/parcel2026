-- Removes every merchant with its API keys, webhooks and member roles (cascade), and the
-- users who were only merchant members (they would otherwise be logins with no access).
-- Run clear-shipments-and-tickets.sql first if merchants still have parcels, invoices,
-- settlements or tickets.
-- Run: psql -h localhost -U deliveryfast -d deliveryfast -f apps/api/scripts/clear-merchants.sql
BEGIN;
CREATE TEMP TABLE merchant_only_users ON COMMIT DROP AS
  SELECT u.id FROM users u
  WHERE EXISTS (SELECT 1 FROM user_roles r WHERE r."userId" = u.id AND r."merchantId" IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM user_roles r WHERE r."userId" = u.id AND r."merchantId" IS NULL);
DELETE FROM merchants;
DELETE FROM users WHERE id IN (SELECT id FROM merchant_only_users);
COMMIT;
