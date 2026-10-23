-- AlterTable
ALTER TABLE "parcels" ADD COLUMN     "codCollectedAmount" DECIMAL(12,2),
ADD COLUMN     "partialDelivery" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "partialNote" TEXT,
ADD COLUMN     "returnChargeWaived" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "returnOfId" UUID;

-- CreateIndex
CREATE INDEX "parcels_returnOfId_idx" ON "parcels"("returnOfId");

-- AddForeignKey
ALTER TABLE "parcels" ADD CONSTRAINT "parcels_returnOfId_fkey" FOREIGN KEY ("returnOfId") REFERENCES "parcels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

