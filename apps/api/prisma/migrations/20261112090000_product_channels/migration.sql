-- Products carry the message channels (categories are no longer used); each product takes its category's.
ALTER TABLE "parcel_products" ADD COLUMN "notifySms" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "parcel_products" ADD COLUMN "notifyEmail" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "parcel_products" ADD COLUMN "notifyPush" BOOLEAN NOT NULL DEFAULT true;
UPDATE "parcel_products" p SET "notifySms" = c."notifySms", "notifyEmail" = c."notifyEmail", "notifyPush" = c."notifyPush"
  FROM "product_categories" c WHERE p."categoryId" = c."id";

-- The product name as the merchant wrote it (Excel import), shown on prints.
ALTER TABLE "parcels" ADD COLUMN "productLabel" TEXT;
