-- CreateEnum
CREATE TYPE "ParcelIntake" AS ENUM ('PICKUP', 'DROP_OFF');

-- AlterTable
ALTER TABLE "parcels" ADD COLUMN     "bookingBatchId" UUID,
ADD COLUMN     "dropOffHubId" UUID,
ADD COLUMN     "droppedOffAt" TIMESTAMP(3),
ADD COLUMN     "intake" "ParcelIntake" NOT NULL DEFAULT 'PICKUP';

-- CreateTable
CREATE TABLE "booking_batches" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "intake" "ParcelIntake" NOT NULL,
    "hubId" UUID,
    "merchantId" UUID,
    "fileName" TEXT,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "bookedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "booking_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "booking_batches_number_key" ON "booking_batches"("number");

-- CreateIndex
CREATE INDEX "booking_batches_hubId_createdAt_idx" ON "booking_batches"("hubId", "createdAt");

-- CreateIndex
CREATE INDEX "booking_batches_createdAt_idx" ON "booking_batches"("createdAt");

-- CreateIndex
CREATE INDEX "parcels_dropOffHubId_status_idx" ON "parcels"("dropOffHubId", "status");

-- CreateIndex
CREATE INDEX "parcels_bookingBatchId_idx" ON "parcels"("bookingBatchId");

-- AddForeignKey
ALTER TABLE "parcels" ADD CONSTRAINT "parcels_dropOffHubId_fkey" FOREIGN KEY ("dropOffHubId") REFERENCES "hubs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parcels" ADD CONSTRAINT "parcels_bookingBatchId_fkey" FOREIGN KEY ("bookingBatchId") REFERENCES "booking_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_batches" ADD CONSTRAINT "booking_batches_hubId_fkey" FOREIGN KEY ("hubId") REFERENCES "hubs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

