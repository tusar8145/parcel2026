-- CreateEnum
CREATE TYPE "ScanReader" AS ENUM ('CLAUDE', 'LOCAL');

-- CreateTable
CREATE TABLE "scan_read_logs" (
    "id" UUID NOT NULL,
    "scanId" UUID,
    "sessionId" UUID,
    "kind" "ImportKind" NOT NULL,
    "merchantId" UUID,
    "userId" UUID,
    "reader" "ScanReader" NOT NULL,
    "model" TEXT,
    "status" "ParcelScanStatus" NOT NULL,
    "fallback" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "fields" INTEGER NOT NULL DEFAULT 0,
    "ms" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheRead" INTEGER NOT NULL DEFAULT 0,
    "cacheWrite" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scan_read_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scan_read_logs_createdAt_idx" ON "scan_read_logs"("createdAt");
