-- CreateEnum
CREATE TYPE "PackageStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- AlterEnum
ALTER TYPE "ParcelStatus" ADD VALUE 'READY_FOR_COLLECTION';

-- AlterEnum
ALTER TYPE "ProofMethod" ADD VALUE 'COLLECTION_CODE';

-- DropForeignKey
ALTER TABLE "cod_collections" DROP CONSTRAINT "cod_collections_riderId_fkey";

-- AlterTable
ALTER TABLE "cod_collections" ADD COLUMN     "collectedById" UUID,
ADD COLUMN     "hubId" UUID,
ALTER COLUMN "riderId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "hubs" ADD COLUMN     "hubGroupId" UUID;

-- AlterTable
ALTER TABLE "parcels" ADD COLUMN     "collectHubId" UUID,
ADD COLUMN     "collectionCodeEncrypted" TEXT,
ADD COLUMN     "collectionDueAt" TIMESTAMP(3),
ADD COLUMN     "collectionReminderAt" TIMESTAMP(3),
ADD COLUMN     "firstMile" TEXT,
ADD COLUMN     "lastMile" TEXT,
ADD COLUMN     "notifications" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "onDemand" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "openBox" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "packageVersionId" UUID,
ADD COLUMN     "productId" UUID,
ADD COLUMN     "productName" TEXT,
ADD COLUMN     "readyForCollectionAt" TIMESTAMP(3),
ADD COLUMN     "reattemptCharge" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "services" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "speedOption" TEXT;

-- CreateTable
CREATE TABLE "service_packages" (
    "id" UUID NOT NULL,
    "segment" "Segment" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "defaultFor" "Segment",
    "status" "PackageStatus" NOT NULL DEFAULT 'ACTIVE',
    "source" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_package_versions" (
    "id" UUID NOT NULL,
    "packageId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "services" TEXT[],
    "prices" JSONB NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "createdById" UUID,
    "changeRequestId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_package_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "package_assignments" (
    "id" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "packageId" UUID,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "package_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub_groups" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hub_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parcel_products" (
    "id" UUID NOT NULL,
    "segment" "Segment" NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "mutedNotifications" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "parcel_products_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "service_packages_defaultFor_key" ON "service_packages"("defaultFor");

-- CreateIndex
CREATE UNIQUE INDEX "service_packages_source_key" ON "service_packages"("source");

-- CreateIndex
CREATE UNIQUE INDEX "service_packages_segment_name_key" ON "service_packages"("segment", "name");

-- CreateIndex
CREATE INDEX "service_package_versions_packageId_effectiveFrom_idx" ON "service_package_versions"("packageId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "service_package_versions_packageId_version_key" ON "service_package_versions"("packageId", "version");

-- CreateIndex
CREATE INDEX "package_assignments_merchantId_effectiveFrom_idx" ON "package_assignments"("merchantId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "package_assignments_packageId_idx" ON "package_assignments"("packageId");

-- CreateIndex
CREATE UNIQUE INDEX "hub_groups_code_key" ON "hub_groups"("code");

-- CreateIndex
CREATE UNIQUE INDEX "parcel_products_segment_name_key" ON "parcel_products"("segment", "name");

-- CreateIndex
CREATE INDEX "cod_collections_hubId_state_idx" ON "cod_collections"("hubId", "state");

-- CreateIndex
CREATE INDEX "hubs_hubGroupId_idx" ON "hubs"("hubGroupId");

-- CreateIndex
CREATE INDEX "parcels_status_collectionDueAt_idx" ON "parcels"("status", "collectionDueAt");

-- CreateIndex
CREATE INDEX "parcels_collectHubId_status_idx" ON "parcels"("collectHubId", "status");

-- CreateIndex
CREATE INDEX "parcels_packageVersionId_idx" ON "parcels"("packageVersionId");

-- CreateIndex
CREATE INDEX "parcels_productId_idx" ON "parcels"("productId");

-- AddForeignKey
ALTER TABLE "hubs" ADD CONSTRAINT "hubs_hubGroupId_fkey" FOREIGN KEY ("hubGroupId") REFERENCES "hub_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parcels" ADD CONSTRAINT "parcels_packageVersionId_fkey" FOREIGN KEY ("packageVersionId") REFERENCES "service_package_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parcels" ADD CONSTRAINT "parcels_productId_fkey" FOREIGN KEY ("productId") REFERENCES "parcel_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parcels" ADD CONSTRAINT "parcels_collectHubId_fkey" FOREIGN KEY ("collectHubId") REFERENCES "hubs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cod_collections" ADD CONSTRAINT "cod_collections_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "riders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_package_versions" ADD CONSTRAINT "service_package_versions_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "service_packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_assignments" ADD CONSTRAINT "package_assignments_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_assignments" ADD CONSTRAINT "package_assignments_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "service_packages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

