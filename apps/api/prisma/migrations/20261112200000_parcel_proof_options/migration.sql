-- AlterTable
ALTER TABLE "parcels" ADD COLUMN     "proofMethod" TEXT,
ADD COLUMN     "proofRequired" BOOLEAN NOT NULL DEFAULT true;

