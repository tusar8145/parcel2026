-- AlterTable
ALTER TABLE "merchant_settlements" ADD COLUMN     "paymentProofFileId" UUID;

-- AddForeignKey
ALTER TABLE "merchant_settlements" ADD CONSTRAINT "merchant_settlements_paymentProofFileId_fkey" FOREIGN KEY ("paymentProofFileId") REFERENCES "stored_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

