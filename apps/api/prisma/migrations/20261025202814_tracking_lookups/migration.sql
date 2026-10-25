-- CreateTable
CREATE TABLE "tracking_lookups" (
    "id" UUID NOT NULL,
    "parcelId" UUID NOT NULL,
    "via" TEXT NOT NULL DEFAULT 'search',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tracking_lookups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tracking_lookups_createdAt_idx" ON "tracking_lookups"("createdAt");

-- CreateIndex
CREATE INDEX "tracking_lookups_parcelId_createdAt_idx" ON "tracking_lookups"("parcelId", "createdAt");

