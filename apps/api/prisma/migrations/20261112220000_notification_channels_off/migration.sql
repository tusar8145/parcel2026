-- AlterTable
ALTER TABLE "parcels" ADD COLUMN     "notificationChannelsOff" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "service_package_versions" ADD COLUMN     "notificationChannelsOff" TEXT[] DEFAULT ARRAY[]::TEXT[];

