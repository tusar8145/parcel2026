-- CreateEnum
CREATE TYPE "PickupTimePreference" AS ENUM ('MORNING', 'MIDDAY', 'AFTERNOON');

-- CreateEnum
CREATE TYPE "MerchantHandover" AS ENUM ('RIDER_PICKUP', 'HUB_DROP');

-- AlterTable
ALTER TABLE "merchants" ADD COLUMN     "businessArea" TEXT,
ADD COLUMN     "businessAreaOther" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "businessCategory" TEXT,
ADD COLUMN     "businessDistrict" TEXT,
ADD COLUMN     "businessLat" DOUBLE PRECISION,
ADD COLUMN     "businessLng" DOUBLE PRECISION,
ADD COLUMN     "businessStreet" TEXT,
ADD COLUMN     "businessZone" TEXT,
ADD COLUMN     "handover" "MerchantHandover" NOT NULL DEFAULT 'RIDER_PICKUP',
ADD COLUMN     "pickupAreaOther" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pickupContactName" TEXT,
ADD COLUMN     "pickupContactPhone" TEXT,
ADD COLUMN     "pickupHubId" UUID,
ADD COLUMN     "pickupLat" DOUBLE PRECISION,
ADD COLUMN     "pickupLng" DOUBLE PRECISION,
ADD COLUMN     "pickupSameAsBusiness" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pickupTime" "PickupTimePreference",
ADD COLUMN     "pickupZone" TEXT,
ADD COLUMN     "websiteUrl" TEXT;

-- CreateIndex
CREATE INDEX "merchants_pickupHubId_idx" ON "merchants"("pickupHubId");

-- AddForeignKey
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_pickupHubId_fkey" FOREIGN KEY ("pickupHubId") REFERENCES "hubs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

