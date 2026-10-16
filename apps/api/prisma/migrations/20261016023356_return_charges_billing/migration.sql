-- AlterEnum
ALTER TYPE "MerchantAdjustmentKind" ADD VALUE 'RETURN_CHARGE';

-- AlterTable
ALTER TABLE "merchant_adjustments" ADD COLUMN     "invoiceId" UUID;

-- CreateIndex
CREATE INDEX "merchant_adjustments_invoiceId_idx" ON "merchant_adjustments"("invoiceId");

