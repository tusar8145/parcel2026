-- Riders on several hubs: every hub a rider works for (riders.hubId stays the one they work at now).
CREATE TABLE "rider_hubs" (
    "riderId" UUID NOT NULL,
    "hubId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "rider_hubs_pkey" PRIMARY KEY ("riderId","hubId")
);
CREATE INDEX "rider_hubs_hubId_idx" ON "rider_hubs"("hubId");
ALTER TABLE "rider_hubs" ADD CONSTRAINT "rider_hubs_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "riders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "rider_hubs" ADD CONSTRAINT "rider_hubs_hubId_fkey" FOREIGN KEY ("hubId") REFERENCES "hubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Every rider's current hub is one of their hubs.
INSERT INTO "rider_hubs" ("riderId", "hubId") SELECT "id", "hubId" FROM "riders" WHERE "hubId" IS NOT NULL;
