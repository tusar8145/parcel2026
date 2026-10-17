-- CreateEnum
CREATE TYPE "BulkUpdateStatus" AS ENUM ('VALIDATED', 'QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "BulkUpdateRowStatus" AS ENUM ('READY', 'WARNING', 'ERROR', 'APPLIED', 'ALREADY_DONE', 'FAILED');

-- CreateTable
CREATE TABLE "bulk_update_jobs" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "status" "BulkUpdateStatus" NOT NULL DEFAULT 'VALIDATED',
    "fileName" TEXT,
    "fileSha256" TEXT,
    "fileBytes" INTEGER NOT NULL DEFAULT 0,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "ignoredRows" INTEGER NOT NULL DEFAULT 0,
    "readyRows" INTEGER NOT NULL DEFAULT 0,
    "warningRows" INTEGER NOT NULL DEFAULT 0,
    "errorRows" INTEGER NOT NULL DEFAULT 0,
    "skippedRows" INTEGER NOT NULL DEFAULT 0,
    "processedRows" INTEGER NOT NULL DEFAULT 0,
    "appliedCount" INTEGER NOT NULL DEFAULT 0,
    "alreadyDoneCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "actor" JSONB NOT NULL,
    "createdById" UUID,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "queuedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "rowsPurgedAt" TIMESTAMP(3),

    CONSTRAINT "bulk_update_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bulk_update_rows" (
    "id" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "status" "BulkUpdateRowStatus" NOT NULL,
    "action" TEXT,
    "trackingId" TEXT,
    "parcelId" UUID,
    "expectedVersion" INTEGER,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "cells" JSONB NOT NULL,
    "plan" JSONB,
    "errors" JSONB,
    "warnings" JSONB,
    "result" TEXT,
    "dedupeKey" TEXT,

    CONSTRAINT "bulk_update_rows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bulk_update_jobs_number_key" ON "bulk_update_jobs"("number");

-- CreateIndex
CREATE INDEX "bulk_update_jobs_createdById_createdAt_idx" ON "bulk_update_jobs"("createdById", "createdAt");

-- CreateIndex
CREATE INDEX "bulk_update_jobs_status_updatedAt_idx" ON "bulk_update_jobs"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "bulk_update_rows_jobId_status_rowNumber_idx" ON "bulk_update_rows"("jobId", "status", "rowNumber");

-- CreateIndex
CREATE INDEX "bulk_update_rows_dedupeKey_status_idx" ON "bulk_update_rows"("dedupeKey", "status");

-- CreateIndex
CREATE UNIQUE INDEX "bulk_update_rows_jobId_rowNumber_key" ON "bulk_update_rows"("jobId", "rowNumber");

-- AddForeignKey
ALTER TABLE "bulk_update_rows" ADD CONSTRAINT "bulk_update_rows_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "bulk_update_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

