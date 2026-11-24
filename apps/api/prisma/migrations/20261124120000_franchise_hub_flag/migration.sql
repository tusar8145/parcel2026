-- A hub marked as a franchise hub (before its Franchise user exists).
ALTER TABLE "hubs" ADD COLUMN "franchiseHub" BOOLEAN NOT NULL DEFAULT false;
UPDATE "hubs" SET "franchiseHub" = true WHERE "type" = 'FRANCHISE';
