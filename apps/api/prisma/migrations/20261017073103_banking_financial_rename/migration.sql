-- "Document / corporate" merchants are now "Banking & Financial" merchants.
-- Renames the enum values in place: every existing row keeps its value (no data rewritten, nothing dropped).
ALTER TYPE "MerchantType" RENAME VALUE 'CORPORATE_DOCUMENT' TO 'BANKING_FINANCIAL';
ALTER TYPE "Segment" RENAME VALUE 'CORPORATE_DOCUMENT' TO 'BANKING_FINANCIAL';
