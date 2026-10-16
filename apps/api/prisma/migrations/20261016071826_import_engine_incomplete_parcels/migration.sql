-- CreateEnum
CREATE TYPE "ImportKind" AS ENUM ('ECOMMERCE', 'DOCUMENT');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('VALIDATED', 'QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "ImportRowStatus" AS ENUM ('VALID', 'INCOMPLETE', 'ERROR', 'CREATED', 'FAILED');

-- AlterTable
ALTER TABLE "parcels" ADD COLUMN     "importJobId" UUID,
ADD COLUMN     "importKey" TEXT,
ADD COLUMN     "incomplete" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "missingFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
ALTER COLUMN "recipientName" DROP NOT NULL,
ALTER COLUMN "recipientPhone" DROP NOT NULL,
ALTER COLUMN "deliveryStreet" DROP NOT NULL,
ALTER COLUMN "deliveryZone" DROP NOT NULL,
ALTER COLUMN "deliveryDistrict" DROP NOT NULL;

-- CreateTable
CREATE TABLE "import_jobs" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "kind" "ImportKind" NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'VALIDATED',
    "source" "ParcelChannel" NOT NULL,
    "merchantId" UUID,
    "intake" "ParcelIntake" NOT NULL DEFAULT 'PICKUP',
    "dropOffHubId" UUID,
    "bookingBatchId" UUID,
    "fileName" TEXT,
    "fileSha256" TEXT,
    "fileBytes" INTEGER NOT NULL DEFAULT 0,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "validRows" INTEGER NOT NULL DEFAULT 0,
    "incompleteRows" INTEGER NOT NULL DEFAULT 0,
    "errorRows" INTEGER NOT NULL DEFAULT 0,
    "processedRows" INTEGER NOT NULL DEFAULT 0,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "createdIncomplete" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "settings" JSONB NOT NULL,
    "actor" JSONB NOT NULL,
    "createdById" UUID,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "queuedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "rowsPurgedAt" TIMESTAMP(3),

    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_rows" (
    "id" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "status" "ImportRowStatus" NOT NULL,
    "cells" JSONB NOT NULL,
    "errors" JSONB,
    "missing" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "merchantId" UUID,
    "dedupeKey" TEXT,
    "charge" DECIMAL(12,2),
    "trackingId" TEXT,

    CONSTRAINT "import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "import_jobs_number_key" ON "import_jobs"("number");

-- CreateIndex
CREATE UNIQUE INDEX "import_jobs_bookingBatchId_key" ON "import_jobs"("bookingBatchId");

-- CreateIndex
CREATE INDEX "import_jobs_merchantId_createdAt_idx" ON "import_jobs"("merchantId", "createdAt");

-- CreateIndex
CREATE INDEX "import_jobs_createdById_createdAt_idx" ON "import_jobs"("createdById", "createdAt");

-- CreateIndex
CREATE INDEX "import_jobs_status_updatedAt_idx" ON "import_jobs"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "import_rows_jobId_status_rowNumber_idx" ON "import_rows"("jobId", "status", "rowNumber");

-- CreateIndex
CREATE UNIQUE INDEX "import_rows_jobId_rowNumber_key" ON "import_rows"("jobId", "rowNumber");

-- CreateIndex
CREATE INDEX "parcels_merchantId_incomplete_idx" ON "parcels"("merchantId", "incomplete");

-- CreateIndex
CREATE INDEX "parcels_importJobId_idx" ON "parcels"("importJobId");

-- CreateIndex
CREATE UNIQUE INDEX "parcels_merchantId_importKey_key" ON "parcels"("merchantId", "importKey");

-- AddForeignKey
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_bookingBatchId_fkey" FOREIGN KEY ("bookingBatchId") REFERENCES "booking_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "import_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

