-- CreateEnum
CREATE TYPE "ParcelScanStatus" AS ENUM ('READING', 'READ', 'FAILED');

-- CreateTable
CREATE TABLE "parcel_scan_sessions" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "kind" "ImportKind" NOT NULL,
    "merchantId" UUID,
    "createdById" UUID NOT NULL,
    "scanCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "parcel_scan_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parcel_scans" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "fileId" UUID,
    "status" "ParcelScanStatus" NOT NULL DEFAULT 'READING',
    "text" TEXT,
    "cells" JSONB NOT NULL DEFAULT '{}',
    "parcelId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "parcel_scans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "parcel_scan_sessions_tokenHash_key" ON "parcel_scan_sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "parcel_scan_sessions_createdById_createdAt_idx" ON "parcel_scan_sessions"("createdById", "createdAt");

-- CreateIndex
CREATE INDEX "parcel_scans_parcelId_idx" ON "parcel_scans"("parcelId");

-- CreateIndex
CREATE INDEX "parcel_scans_createdAt_idx" ON "parcel_scans"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "parcel_scans_sessionId_number_key" ON "parcel_scans"("sessionId", "number");

-- AddForeignKey
ALTER TABLE "parcel_scans" ADD CONSTRAINT "parcel_scans_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "parcel_scan_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parcel_scans" ADD CONSTRAINT "parcel_scans_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "stored_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parcel_scans" ADD CONSTRAINT "parcel_scans_parcelId_fkey" FOREIGN KEY ("parcelId") REFERENCES "parcels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

