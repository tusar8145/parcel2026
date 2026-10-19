-- CreateEnum
CREATE TYPE "MerchantAddressRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "merchant_address_requests" (
    "id" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "status" "MerchantAddressRequestStatus" NOT NULL DEFAULT 'PENDING',
    "changes" JSONB NOT NULL,
    "previous" JSONB NOT NULL,
    "proposed" JSONB NOT NULL,
    "previousHubId" UUID,
    "proposedHubId" UUID,
    "requestedById" UUID,
    "requestedByName" TEXT NOT NULL,
    "decidedById" UUID,
    "decidedByName" TEXT,
    "decidedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchant_address_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "merchant_address_requests_status_createdAt_idx" ON "merchant_address_requests"("status", "createdAt");

-- CreateIndex
CREATE INDEX "merchant_address_requests_merchantId_status_idx" ON "merchant_address_requests"("merchantId", "status");

-- AddForeignKey
ALTER TABLE "merchant_address_requests" ADD CONSTRAINT "merchant_address_requests_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

