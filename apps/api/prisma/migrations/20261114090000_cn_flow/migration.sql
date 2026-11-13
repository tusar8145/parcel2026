
-- AlterTable
ALTER TABLE "parcels" ADD COLUMN     "cnFlow" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "deliveredAccuracy" DOUBLE PRECISION,
ADD COLUMN     "deliveredLat" DOUBLE PRECISION,
ADD COLUMN     "deliveredLng" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "scan_read_logs" ADD COLUMN     "captureId" UUID,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'PHONE';

-- CreateTable
CREATE TABLE "cn_captures" (
    "id" UUID NOT NULL,
    "parcelId" UUID NOT NULL,
    "cn" TEXT NOT NULL,
    "fileId" UUID,
    "status" TEXT NOT NULL DEFAULT 'READING',
    "cells" JSONB NOT NULL DEFAULT '{}',
    "conflicts" JSONB NOT NULL DEFAULT '[]',
    "source" TEXT NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "cn_captures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cn_captures_parcelId_createdAt_idx" ON "cn_captures"("parcelId", "createdAt");

-- CreateIndex
CREATE INDEX "cn_captures_createdAt_idx" ON "cn_captures"("createdAt");

-- AddForeignKey
ALTER TABLE "cn_captures" ADD CONSTRAINT "cn_captures_parcelId_fkey" FOREIGN KEY ("parcelId") REFERENCES "parcels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
