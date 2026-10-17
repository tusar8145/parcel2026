-- AlterTable
ALTER TABLE "parcel_products" ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'REGULAR';

-- AlterTable
ALTER TABLE "parcels" ADD COLUMN     "productType" TEXT;

