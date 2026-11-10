-- AlterTable
ALTER TABLE "parcel_products" ADD COLUMN     "categoryId" UUID,
ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "parcels" ADD COLUMN     "categoryId" UUID,
ADD COLUMN     "categoryName" TEXT,
ADD COLUMN     "deliveryTypeName" TEXT,
ADD COLUMN     "notifyChannels" TEXT[] DEFAULT ARRAY['sms', 'email', 'push']::TEXT[],
ADD COLUMN     "priorityId" UUID,
ADD COLUMN     "priorityName" TEXT;

-- CreateTable
CREATE TABLE "product_categories" (
    "id" UUID NOT NULL,
    "segment" "Segment" NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notifySms" BOOLEAN NOT NULL DEFAULT true,
    "notifyEmail" BOOLEAN NOT NULL DEFAULT true,
    "notifyPush" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parcel_priorities" (
    "id" UUID NOT NULL,
    "segment" "Segment" NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "parcel_priorities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_types" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "segments" "Segment"[],
    "slaLevel" "ServiceLevel" NOT NULL DEFAULT 'REGULAR',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_types_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_categories_segment_name_key" ON "product_categories"("segment", "name");

-- CreateIndex
CREATE UNIQUE INDEX "parcel_priorities_segment_name_key" ON "parcel_priorities"("segment", "name");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_types_code_key" ON "delivery_types"("code");

-- CreateIndex
CREATE INDEX "parcels_categoryId_idx" ON "parcels"("categoryId");

-- CreateIndex
CREATE INDEX "parcels_priorityId_idx" ON "parcels"("priorityId");

-- AddForeignKey
ALTER TABLE "parcels" ADD CONSTRAINT "parcels_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "product_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parcels" ADD CONSTRAINT "parcels_priorityId_fkey" FOREIGN KEY ("priorityId") REFERENCES "parcel_priorities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parcel_products" ADD CONSTRAINT "parcel_products_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "product_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- The product catalog: categories with their message channels, products under them (replacing the old
-- product list; parcels keep their product name), the delivery types and the priorities.
UPDATE "parcels" SET "productId" = NULL WHERE "productId" IS NOT NULL;
DELETE FROM "parcel_products";
INSERT INTO "product_categories" ("id", "segment", "name", "sortOrder", "notifySms", "notifyEmail", "notifyPush", "updatedAt") VALUES (gen_random_uuid(), 'BANKING_FINANCIAL', 'Cards & PIN', 0, true, true, true, now());
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'Debit Card', 'REGULAR', c."id", 0, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Cards & PIN';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'Credit Card', 'REGULAR', c."id", 1, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Cards & PIN';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'Prepaid Card', 'REGULAR', c."id", 2, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Cards & PIN';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'ATM Card', 'REGULAR', c."id", 3, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Cards & PIN';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'PIN Mailer', 'DOCUMENT', c."id", 4, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Cards & PIN';
INSERT INTO "product_categories" ("id", "segment", "name", "sortOrder", "notifySms", "notifyEmail", "notifyPush", "updatedAt") VALUES (gen_random_uuid(), 'BANKING_FINANCIAL', 'Cheque Book & Passbook', 1, true, true, true, now());
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'Cheque Book', 'BOOKS', c."id", 0, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Cheque Book & Passbook';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'Passbook', 'BOOKS', c."id", 1, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Cheque Book & Passbook';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'Deposit Slip Book', 'BOOKS', c."id", 2, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Cheque Book & Passbook';
INSERT INTO "product_categories" ("id", "segment", "name", "sortOrder", "notifySms", "notifyEmail", "notifyPush", "updatedAt") VALUES (gen_random_uuid(), 'BANKING_FINANCIAL', 'Financial Instruments', 2, true, true, true, now());
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'Pay Order', 'DOCUMENT', c."id", 0, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Financial Instruments';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'Demand Draft', 'DOCUMENT', c."id", 1, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Financial Instruments';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'Fixed Deposit Receipt (FDR)', 'DOCUMENT', c."id", 2, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Financial Instruments';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'DPS Certificate', 'DOCUMENT', c."id", 3, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Financial Instruments';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'Savings Certificate (Sanchayapatra)', 'DOCUMENT', c."id", 4, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Financial Instruments';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'Bond / Investment Certificate', 'DOCUMENT', c."id", 5, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Financial Instruments';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'Bank Guarantee', 'DOCUMENT', c."id", 6, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Financial Instruments';
INSERT INTO "product_categories" ("id", "segment", "name", "sortOrder", "notifySms", "notifyEmail", "notifyPush", "updatedAt") VALUES (gen_random_uuid(), 'BANKING_FINANCIAL', 'Statements & Certificates', 3, false, true, false, now());
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'Bank Statement', 'DOCUMENT', c."id", 0, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Statements & Certificates';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'Credit Card Statement', 'DOCUMENT', c."id", 1, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Statements & Certificates';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'Solvency Certificate', 'DOCUMENT', c."id", 2, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Statements & Certificates';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'Balance Confirmation Certificate', 'DOCUMENT', c."id", 3, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Statements & Certificates';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'Tax / TDS Certificate', 'DOCUMENT', c."id", 4, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Statements & Certificates';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'Interest Certificate', 'DOCUMENT', c."id", 5, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Statements & Certificates';
INSERT INTO "product_categories" ("id", "segment", "name", "sortOrder", "notifySms", "notifyEmail", "notifyPush", "updatedAt") VALUES (gen_random_uuid(), 'BANKING_FINANCIAL', 'Account & Loan Documents', 4, false, false, false, now());
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'Account Opening Kit', 'REGULAR', c."id", 0, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Account & Loan Documents';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'Welcome Kit', 'REGULAR', c."id", 1, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Account & Loan Documents';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'KYC Documents', 'DOCUMENT', c."id", 2, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Account & Loan Documents';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'Loan Documents', 'DOCUMENT', c."id", 3, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Account & Loan Documents';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'Loan Sanction Letter', 'DOCUMENT', c."id", 4, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Account & Loan Documents';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'Mortgage / Property Documents', 'DOCUMENT', c."id", 5, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Account & Loan Documents';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'Financial Agreement', 'DOCUMENT', c."id", 6, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Account & Loan Documents';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'Insurance Policy Documents', 'DOCUMENT', c."id", 7, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Account & Loan Documents';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'Insurance Claim Documents', 'DOCUMENT', c."id", 8, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Account & Loan Documents';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'Legal Notice / Demand Letter', 'DOCUMENT', c."id", 9, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Account & Loan Documents';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'Confidential Documents', 'DOCUMENT', c."id", 10, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Account & Loan Documents';
INSERT INTO "product_categories" ("id", "segment", "name", "sortOrder", "notifySms", "notifyEmail", "notifyPush", "updatedAt") VALUES (gen_random_uuid(), 'BANKING_FINANCIAL', 'Corporate & Trade Documents', 5, false, true, false, now());
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'Corporate Banking Documents', 'DOCUMENT', c."id", 0, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Corporate & Trade Documents';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'LC Documents', 'DOCUMENT', c."id", 1, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Corporate & Trade Documents';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'Trade Finance Documents', 'DOCUMENT', c."id", 2, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Corporate & Trade Documents';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'Export / Import Documents', 'DOCUMENT', c."id", 3, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Corporate & Trade Documents';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'Payroll Documents', 'DOCUMENT', c."id", 4, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Corporate & Trade Documents';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'Tender Documents', 'DOCUMENT', c."id", 5, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Corporate & Trade Documents';
INSERT INTO "product_categories" ("id", "segment", "name", "sortOrder", "notifySms", "notifyEmail", "notifyPush", "updatedAt") VALUES (gen_random_uuid(), 'BANKING_FINANCIAL', 'Banking Devices', 6, true, true, true, now());
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'POS Terminal', 'REGULAR', c."id", 0, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Banking Devices';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'Security Token', 'REGULAR', c."id", 1, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Banking Devices';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'Card Reader', 'REGULAR', c."id", 2, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Banking Devices';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'BANKING_FINANCIAL', 'QR Merchant Kit', 'REGULAR', c."id", 3, now() FROM "product_categories" c WHERE c."segment" = 'BANKING_FINANCIAL' AND c."name" = 'Banking Devices';
INSERT INTO "product_categories" ("id", "segment", "name", "sortOrder", "notifySms", "notifyEmail", "notifyPush", "updatedAt") VALUES (gen_random_uuid(), 'ECOMMERCE', 'Fashion & Clothing', 0, true, true, true, now());
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Saree', 'REGULAR', c."id", 0, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Fashion & Clothing';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Three-Piece / Salwar Kameez', 'REGULAR', c."id", 1, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Fashion & Clothing';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Kurti & Tops', 'REGULAR', c."id", 2, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Fashion & Clothing';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Panjabi', 'REGULAR', c."id", 3, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Fashion & Clothing';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Shirt', 'REGULAR', c."id", 4, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Fashion & Clothing';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'T-Shirt & Polo', 'REGULAR', c."id", 5, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Fashion & Clothing';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Pants & Jeans', 'REGULAR', c."id", 6, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Fashion & Clothing';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Hijab & Borka', 'REGULAR', c."id", 7, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Fashion & Clothing';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Kids Clothing', 'REGULAR', c."id", 8, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Fashion & Clothing';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Lungi & Gamcha', 'REGULAR', c."id", 9, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Fashion & Clothing';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Winter Wear', 'REGULAR', c."id", 10, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Fashion & Clothing';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Innerwear & Nightwear', 'REGULAR', c."id", 11, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Fashion & Clothing';
INSERT INTO "product_categories" ("id", "segment", "name", "sortOrder", "notifySms", "notifyEmail", "notifyPush", "updatedAt") VALUES (gen_random_uuid(), 'ECOMMERCE', 'Shoes, Bags & Accessories', 1, true, true, true, now());
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Men''s Shoes', 'REGULAR', c."id", 0, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Shoes, Bags & Accessories';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Women''s Shoes', 'REGULAR', c."id", 1, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Shoes, Bags & Accessories';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Sandals & Slippers', 'REGULAR', c."id", 2, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Shoes, Bags & Accessories';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Handbag & Purse', 'REGULAR', c."id", 3, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Shoes, Bags & Accessories';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Backpack', 'REGULAR', c."id", 4, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Shoes, Bags & Accessories';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Wallet', 'REGULAR', c."id", 5, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Shoes, Bags & Accessories';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Watch', 'REGULAR', c."id", 6, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Shoes, Bags & Accessories';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Sunglasses', 'REGULAR', c."id", 7, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Shoes, Bags & Accessories';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Belt', 'REGULAR', c."id", 8, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Shoes, Bags & Accessories';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Jewelry & Ornaments', 'REGULAR', c."id", 9, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Shoes, Bags & Accessories';
INSERT INTO "product_categories" ("id", "segment", "name", "sortOrder", "notifySms", "notifyEmail", "notifyPush", "updatedAt") VALUES (gen_random_uuid(), 'ECOMMERCE', 'Beauty & Personal Care', 2, true, true, true, now());
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Skin Care', 'REGULAR', c."id", 0, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Beauty & Personal Care';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Makeup', 'REGULAR', c."id", 1, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Beauty & Personal Care';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Hair Care', 'REGULAR', c."id", 2, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Beauty & Personal Care';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Perfume & Attar', 'REGULAR', c."id", 3, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Beauty & Personal Care';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Men''s Grooming', 'REGULAR', c."id", 4, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Beauty & Personal Care';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Personal Care Appliances', 'REGULAR', c."id", 5, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Beauty & Personal Care';
INSERT INTO "product_categories" ("id", "segment", "name", "sortOrder", "notifySms", "notifyEmail", "notifyPush", "updatedAt") VALUES (gen_random_uuid(), 'ECOMMERCE', 'Electronics & Gadgets', 3, true, true, true, now());
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Mobile Phone', 'REGULAR', c."id", 0, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Electronics & Gadgets';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Mobile Accessories', 'REGULAR', c."id", 1, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Electronics & Gadgets';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Earbuds & Headphones', 'REGULAR', c."id", 2, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Electronics & Gadgets';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Smart Watch', 'REGULAR', c."id", 3, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Electronics & Gadgets';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Power Bank', 'REGULAR', c."id", 4, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Electronics & Gadgets';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Bluetooth Speaker', 'REGULAR', c."id", 5, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Electronics & Gadgets';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Computer Accessories', 'REGULAR', c."id", 6, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Electronics & Gadgets';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Laptop & Tablet', 'REGULAR', c."id", 7, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Electronics & Gadgets';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Camera & Accessories', 'REGULAR', c."id", 8, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Electronics & Gadgets';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Gaming Accessories', 'REGULAR', c."id", 9, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Electronics & Gadgets';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Networking Device', 'REGULAR', c."id", 10, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Electronics & Gadgets';
INSERT INTO "product_categories" ("id", "segment", "name", "sortOrder", "notifySms", "notifyEmail", "notifyPush", "updatedAt") VALUES (gen_random_uuid(), 'ECOMMERCE', 'Home, Kitchen & Appliances', 4, true, true, true, now());
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Kitchenware', 'REGULAR', c."id", 0, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Home, Kitchen & Appliances';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Dinner Set & Crockery', 'REGULAR', c."id", 1, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Home, Kitchen & Appliances';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Small Kitchen Appliances', 'REGULAR', c."id", 2, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Home, Kitchen & Appliances';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Home Appliances', 'REGULAR', c."id", 3, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Home, Kitchen & Appliances';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Home Decor', 'REGULAR', c."id", 4, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Home, Kitchen & Appliances';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Bedding & Curtains', 'REGULAR', c."id", 5, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Home, Kitchen & Appliances';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Lighting', 'REGULAR', c."id", 6, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Home, Kitchen & Appliances';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Cleaning Supplies', 'REGULAR', c."id", 7, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Home, Kitchen & Appliances';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Furniture', 'REGULAR', c."id", 8, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Home, Kitchen & Appliances';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Tools & Hardware', 'REGULAR', c."id", 9, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Home, Kitchen & Appliances';
INSERT INTO "product_categories" ("id", "segment", "name", "sortOrder", "notifySms", "notifyEmail", "notifyPush", "updatedAt") VALUES (gen_random_uuid(), 'ECOMMERCE', 'Food & Grocery', 5, true, true, true, now());
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Grocery', 'REGULAR', c."id", 0, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Food & Grocery';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Rice, Dal & Spices', 'REGULAR', c."id", 1, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Food & Grocery';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Oil & Ghee', 'REGULAR', c."id", 2, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Food & Grocery';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Honey', 'REGULAR', c."id", 3, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Food & Grocery';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Dates & Dry Fruits', 'REGULAR', c."id", 4, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Food & Grocery';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Tea & Coffee', 'REGULAR', c."id", 5, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Food & Grocery';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Snacks & Sweets', 'REGULAR', c."id", 6, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Food & Grocery';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Organic Food', 'REGULAR', c."id", 7, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Food & Grocery';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Seasonal Fruits', 'REGULAR', c."id", 8, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Food & Grocery';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Fish & Meat (Frozen)', 'REGULAR', c."id", 9, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Food & Grocery';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Homemade Food', 'REGULAR', c."id", 10, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Food & Grocery';
INSERT INTO "product_categories" ("id", "segment", "name", "sortOrder", "notifySms", "notifyEmail", "notifyPush", "updatedAt") VALUES (gen_random_uuid(), 'ECOMMERCE', 'Health, Baby & Kids', 6, true, true, true, now());
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Medicine & Health Care', 'REGULAR', c."id", 0, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Health, Baby & Kids';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Medical Devices', 'REGULAR', c."id", 1, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Health, Baby & Kids';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Baby Care', 'REGULAR', c."id", 2, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Health, Baby & Kids';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Diaper & Baby Food', 'REGULAR', c."id", 3, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Health, Baby & Kids';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Toys & Games', 'REGULAR', c."id", 4, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Health, Baby & Kids';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'School Supplies', 'REGULAR', c."id", 5, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Health, Baby & Kids';
INSERT INTO "product_categories" ("id", "segment", "name", "sortOrder", "notifySms", "notifyEmail", "notifyPush", "updatedAt") VALUES (gen_random_uuid(), 'ECOMMERCE', 'Books, Stationery & Documents', 7, true, true, true, now());
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Books', 'BOOKS', c."id", 0, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Books, Stationery & Documents';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Islamic Books', 'BOOKS', c."id", 1, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Books, Stationery & Documents';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Academic & Exam Books', 'BOOKS', c."id", 2, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Books, Stationery & Documents';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Magazines', 'BOOKS', c."id", 3, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Books, Stationery & Documents';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Notebooks & Stationery', 'BOOKS', c."id", 4, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Books, Stationery & Documents';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Office Supplies', 'REGULAR', c."id", 5, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Books, Stationery & Documents';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Papers & Documents', 'DOCUMENT', c."id", 6, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Books, Stationery & Documents';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Invoices', 'DOCUMENT', c."id", 7, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Books, Stationery & Documents';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Contracts & Agreements', 'DOCUMENT', c."id", 8, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Books, Stationery & Documents';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Certificates', 'DOCUMENT', c."id", 9, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Books, Stationery & Documents';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Warranty Documents', 'DOCUMENT', c."id", 10, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Books, Stationery & Documents';
INSERT INTO "product_categories" ("id", "segment", "name", "sortOrder", "notifySms", "notifyEmail", "notifyPush", "updatedAt") VALUES (gen_random_uuid(), 'ECOMMERCE', 'Lifestyle & Others', 8, true, true, true, now());
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Gifts & Crafts', 'REGULAR', c."id", 0, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Lifestyle & Others';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Sports & Fitness', 'REGULAR', c."id", 1, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Lifestyle & Others';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Automotive & Bike Accessories', 'REGULAR', c."id", 2, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Lifestyle & Others';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Pet Supplies', 'REGULAR', c."id", 3, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Lifestyle & Others';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Musical Instruments', 'REGULAR', c."id", 4, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Lifestyle & Others';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Plants & Gardening', 'REGULAR', c."id", 5, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Lifestyle & Others';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Agro Products', 'REGULAR', c."id", 6, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Lifestyle & Others';
INSERT INTO "parcel_products" ("id", "segment", "name", "type", "categoryId", "sortOrder", "updatedAt") SELECT gen_random_uuid(), 'ECOMMERCE', 'Industrial & Business Supplies', 'REGULAR', c."id", 7, now() FROM "product_categories" c WHERE c."segment" = 'ECOMMERCE' AND c."name" = 'Lifestyle & Others';
INSERT INTO "delivery_types" ("id", "code", "name", "segments", "slaLevel", "sortOrder", "updatedAt") VALUES (gen_random_uuid(), 'REGULAR', 'Regular', ARRAY['CUSTOMER', 'ECOMMERCE', 'BANKING_FINANCIAL']::"Segment"[], 'REGULAR', 0, now());
INSERT INTO "delivery_types" ("id", "code", "name", "segments", "slaLevel", "sortOrder", "updatedAt") VALUES (gen_random_uuid(), 'EXPRESS', 'Express', ARRAY['CUSTOMER', 'ECOMMERCE', 'BANKING_FINANCIAL']::"Segment"[], 'EXPRESS', 1, now());
INSERT INTO "delivery_types" ("id", "code", "name", "segments", "slaLevel", "sortOrder", "updatedAt") VALUES (gen_random_uuid(), 'FOUR_HOUR', '4 Hour Delivery', ARRAY['CUSTOMER', 'ECOMMERCE', 'BANKING_FINANCIAL']::"Segment"[], 'EXPRESS', 2, now());
INSERT INTO "delivery_types" ("id", "code", "name", "segments", "slaLevel", "sortOrder", "updatedAt") VALUES (gen_random_uuid(), 'SAME_DAY', 'Same Day Delivery', ARRAY['CUSTOMER', 'ECOMMERCE', 'BANKING_FINANCIAL']::"Segment"[], 'SAME_DAY', 3, now());
INSERT INTO "parcel_priorities" ("id", "segment", "name", "isDefault", "sortOrder", "updatedAt") VALUES (gen_random_uuid(), 'BANKING_FINANCIAL', 'General', true, 0, now());
INSERT INTO "parcel_priorities" ("id", "segment", "name", "isDefault", "sortOrder", "updatedAt") VALUES (gen_random_uuid(), 'BANKING_FINANCIAL', 'Security', false, 1, now());
INSERT INTO "parcel_priorities" ("id", "segment", "name", "isDefault", "sortOrder", "updatedAt") VALUES (gen_random_uuid(), 'ECOMMERCE', 'Online Product', true, 0, now());
INSERT INTO "parcel_priorities" ("id", "segment", "name", "isDefault", "sortOrder", "updatedAt") VALUES (gen_random_uuid(), 'ECOMMERCE', 'Fragile', false, 1, now());

-- Package prices: the delivery type charges (prices.deliveryFees by code) from the old Regular / Express fees;
-- the Banking & Financial On-demand / B2B / Trade / Corporate Urgent services are gone.
UPDATE "service_package_versions"
SET "prices" = "prices" || jsonb_build_object('deliveryFees', jsonb_build_object('REGULAR', COALESCE("prices"->'regularFee', '0'::jsonb), 'EXPRESS', COALESCE("prices"->'expressFee', '0'::jsonb), 'FOUR_HOUR', '0'::jsonb, 'SAME_DAY', '0'::jsonb)),
    "services" = array_remove(array_remove(array_remove(array_remove(array_remove(array_remove("services", 'speed.regular'), 'speed.express'), 'speed.on_demand'), 'handling.b2b'), 'handling.trade'), 'handling.urgent');
