/*
  Warnings:

  - You are about to drop the column `deliveryOtpHash` on the `parcels` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "parcels" DROP COLUMN "deliveryOtpHash",
ADD COLUMN     "deliveryOtpEncrypted" TEXT;
