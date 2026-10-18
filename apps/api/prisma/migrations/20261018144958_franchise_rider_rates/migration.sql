-- AlterTable
ALTER TABLE "franchises" ADD COLUMN     "riderDeliveryRate" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "riderPickupRate" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "riderReturnRate" DECIMAL(12,2) NOT NULL DEFAULT 0;

