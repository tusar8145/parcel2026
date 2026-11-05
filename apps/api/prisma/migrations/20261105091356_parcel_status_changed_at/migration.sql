-- AlterTable
ALTER TABLE "parcels" ADD COLUMN     "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "parcels_statusChangedAt_idx" ON "parcels"("statusChangedAt");

