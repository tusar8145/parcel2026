-- CreateEnum
CREATE TYPE "RouteEngine" AS ENUM ('OSRM', 'NEAREST_NEIGHBOUR');

-- CreateEnum
CREATE TYPE "LinehaulTripStatus" AS ENUM ('PLANNED', 'DEPARTED', 'ARRIVED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LinehaulBagStatus" AS ENUM ('OPEN', 'SEALED', 'IN_TRANSIT', 'RECEIVED');

-- CreateEnum
CREATE TYPE "LinehaulItemState" AS ENUM ('LOADED', 'RECEIVED', 'MISSING');

-- CreateEnum
CREATE TYPE "LinehaulDiscrepancyKind" AS ENUM ('MISSING', 'EXTRA', 'SEAL_MISMATCH', 'DAMAGED');

-- CreateEnum
CREATE TYPE "CnStatus" AS ENUM ('AVAILABLE', 'USED', 'VOID');

-- CreateEnum
CREATE TYPE "SlaState" AS ENUM ('ON_TRACK', 'AT_RISK', 'BREACHED');

-- CreateEnum
CREATE TYPE "SlaLeg" AS ENUM ('PICKUP', 'DELIVERY');

-- CreateEnum
CREATE TYPE "SlaLevel" AS ENUM ('AT_RISK', 'BREACHED');

-- CreateEnum
CREATE TYPE "ScanSource" AS ENUM ('CAMERA', 'KEYBOARD', 'MANUAL', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ReportKind" AS ENUM ('DELIVERIES', 'SLA', 'COD', 'RIDERS');

-- CreateEnum
CREATE TYPE "ReportFrequency" AS ENUM ('DAILY', 'WEEKLY');

-- AlterTable
ALTER TABLE "hubs" ADD COLUMN     "capacity" INTEGER,
ADD COLUMN     "lat" DOUBLE PRECISION,
ADD COLUMN     "lng" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "parcels" ADD COLUMN     "deliveryDueAt" TIMESTAMP(3),
ADD COLUMN     "geocodeStatus" TEXT,
ADD COLUMN     "geocodedAt" TIMESTAMP(3),
ADD COLUMN     "pickupDueAt" TIMESTAMP(3),
ADD COLUMN     "slaState" "SlaState" NOT NULL DEFAULT 'ON_TRACK';

-- AlterTable
ALTER TABLE "riders" ADD COLUMN     "dailyCapacity" INTEGER;

-- CreateTable
CREATE TABLE "delivery_zones" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "district" TEXT NOT NULL,
    "areas" TEXT[],
    "hubId" UUID,
    "routeId" UUID,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_routes" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hubId" UUID NOT NULL,
    "defaultRiderId" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_plans" (
    "id" UUID NOT NULL,
    "riderId" UUID NOT NULL,
    "hubId" UUID,
    "workDate" DATE NOT NULL,
    "engine" "RouteEngine" NOT NULL,
    "stops" JSONB NOT NULL,
    "geometry" JSONB,
    "distanceMeters" INTEGER NOT NULL,
    "durationSeconds" INTEGER NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "route_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "linehaul_vehicles" (
    "id" UUID NOT NULL,
    "regNo" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "capacityKg" INTEGER,
    "ownerName" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "linehaul_vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "linehaul_trips" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "originHubId" UUID NOT NULL,
    "destHubId" UUID NOT NULL,
    "vehicleId" UUID,
    "vehicleRegNo" TEXT NOT NULL,
    "driverName" TEXT NOT NULL,
    "driverPhone" TEXT NOT NULL,
    "status" "LinehaulTripStatus" NOT NULL DEFAULT 'PLANNED',
    "plannedDepartureAt" TIMESTAMP(3),
    "departedAt" TIMESTAMP(3),
    "arrivedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "linehaul_trips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "linehaul_bags" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "originHubId" UUID NOT NULL,
    "destHubId" UUID NOT NULL,
    "tripId" UUID,
    "status" "LinehaulBagStatus" NOT NULL DEFAULT 'OPEN',
    "sealNo" TEXT,
    "sealedAt" TIMESTAMP(3),
    "sealedById" UUID,
    "receivedAt" TIMESTAMP(3),
    "receivedById" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "linehaul_bags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "linehaul_bag_items" (
    "id" UUID NOT NULL,
    "bagId" UUID NOT NULL,
    "parcelId" UUID NOT NULL,
    "state" "LinehaulItemState" NOT NULL DEFAULT 'LOADED',
    "addedById" UUID,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedAt" TIMESTAMP(3),

    CONSTRAINT "linehaul_bag_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "linehaul_discrepancies" (
    "id" UUID NOT NULL,
    "tripId" UUID,
    "bagId" UUID,
    "parcelId" UUID,
    "trackingId" TEXT,
    "hubId" UUID NOT NULL,
    "kind" "LinehaulDiscrepancyKind" NOT NULL,
    "note" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" UUID,
    "resolution" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "linehaul_discrepancies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cn_batches" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "hubId" UUID,
    "merchantId" UUID,
    "note" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cn_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cn_stock" (
    "id" UUID NOT NULL,
    "cn" TEXT NOT NULL,
    "batchId" UUID NOT NULL,
    "status" "CnStatus" NOT NULL DEFAULT 'AVAILABLE',
    "parcelId" UUID,
    "usedAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "voidedById" UUID,
    "voidReason" TEXT,
    "printCount" INTEGER NOT NULL DEFAULT 0,
    "lastPrintAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cn_stock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sla_policies" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "serviceLevel" "ServiceLevel" NOT NULL,
    "originDistrict" TEXT,
    "originZone" TEXT,
    "destDistrict" TEXT,
    "destZone" TEXT,
    "pickupMinutes" INTEGER NOT NULL,
    "deliveryMinutes" INTEGER NOT NULL,
    "atRiskMinutes" INTEGER NOT NULL DEFAULT 120,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sla_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sla_alerts" (
    "id" UUID NOT NULL,
    "parcelId" UUID NOT NULL,
    "leg" "SlaLeg" NOT NULL,
    "level" "SlaLevel" NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "hubId" UUID,
    "raisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedById" UUID,
    "acknowledgedBy" TEXT,
    "note" TEXT,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "sla_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scan_events" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "trackingId" TEXT,
    "parcelId" UUID,
    "kind" TEXT NOT NULL,
    "hubId" UUID,
    "riderId" UUID,
    "userId" UUID,
    "source" "ScanSource" NOT NULL,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scan_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rider_shift_schedules" (
    "id" UUID NOT NULL,
    "riderId" UUID NOT NULL,
    "hubId" UUID,
    "weekdays" INTEGER[],
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "validFrom" DATE NOT NULL,
    "validTo" DATE,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rider_shift_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rider_attendance" (
    "id" UUID NOT NULL,
    "riderId" UUID NOT NULL,
    "scheduleId" UUID,
    "hubId" UUID,
    "workDate" DATE NOT NULL,
    "checkInAt" TIMESTAMP(3) NOT NULL,
    "checkOutAt" TIMESTAMP(3),
    "checkInLat" DOUBLE PRECISION,
    "checkInLng" DOUBLE PRECISION,
    "checkOutLat" DOUBLE PRECISION,
    "checkOutLng" DOUBLE PRECISION,
    "source" TEXT NOT NULL DEFAULT 'RIDER_APP',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rider_attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_schedules" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ReportKind" NOT NULL,
    "frequency" "ReportFrequency" NOT NULL,
    "weekday" INTEGER,
    "hour" INTEGER NOT NULL DEFAULT 8,
    "recipients" TEXT[],
    "hubId" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_runs" (
    "id" UUID NOT NULL,
    "scheduleId" UUID,
    "kind" "ReportKind" NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "hubId" UUID,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "csv" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OK',
    "error" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "delivery_zones_code_key" ON "delivery_zones"("code");

-- CreateIndex
CREATE INDEX "delivery_zones_hubId_idx" ON "delivery_zones"("hubId");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_zones_district_name_key" ON "delivery_zones"("district", "name");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_routes_code_key" ON "delivery_routes"("code");

-- CreateIndex
CREATE INDEX "delivery_routes_hubId_idx" ON "delivery_routes"("hubId");

-- CreateIndex
CREATE INDEX "route_plans_riderId_createdAt_idx" ON "route_plans"("riderId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "linehaul_vehicles_regNo_key" ON "linehaul_vehicles"("regNo");

-- CreateIndex
CREATE UNIQUE INDEX "linehaul_trips_number_key" ON "linehaul_trips"("number");

-- CreateIndex
CREATE INDEX "linehaul_trips_originHubId_status_idx" ON "linehaul_trips"("originHubId", "status");

-- CreateIndex
CREATE INDEX "linehaul_trips_destHubId_status_idx" ON "linehaul_trips"("destHubId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "linehaul_bags_number_key" ON "linehaul_bags"("number");

-- CreateIndex
CREATE INDEX "linehaul_bags_originHubId_status_idx" ON "linehaul_bags"("originHubId", "status");

-- CreateIndex
CREATE INDEX "linehaul_bags_destHubId_status_idx" ON "linehaul_bags"("destHubId", "status");

-- CreateIndex
CREATE INDEX "linehaul_bags_tripId_idx" ON "linehaul_bags"("tripId");

-- CreateIndex
CREATE INDEX "linehaul_bag_items_parcelId_idx" ON "linehaul_bag_items"("parcelId");

-- CreateIndex
CREATE UNIQUE INDEX "linehaul_bag_items_bagId_parcelId_key" ON "linehaul_bag_items"("bagId", "parcelId");

-- CreateIndex
CREATE INDEX "linehaul_discrepancies_tripId_idx" ON "linehaul_discrepancies"("tripId");

-- CreateIndex
CREATE INDEX "linehaul_discrepancies_hubId_resolvedAt_idx" ON "linehaul_discrepancies"("hubId", "resolvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "cn_batches_number_key" ON "cn_batches"("number");

-- CreateIndex
CREATE INDEX "cn_batches_hubId_idx" ON "cn_batches"("hubId");

-- CreateIndex
CREATE INDEX "cn_batches_merchantId_idx" ON "cn_batches"("merchantId");

-- CreateIndex
CREATE UNIQUE INDEX "cn_stock_cn_key" ON "cn_stock"("cn");

-- CreateIndex
CREATE UNIQUE INDEX "cn_stock_parcelId_key" ON "cn_stock"("parcelId");

-- CreateIndex
CREATE INDEX "cn_stock_batchId_status_idx" ON "cn_stock"("batchId", "status");

-- CreateIndex
CREATE INDEX "cn_stock_status_idx" ON "cn_stock"("status");

-- CreateIndex
CREATE INDEX "sla_policies_serviceLevel_active_idx" ON "sla_policies"("serviceLevel", "active");

-- CreateIndex
CREATE INDEX "sla_alerts_resolvedAt_raisedAt_idx" ON "sla_alerts"("resolvedAt", "raisedAt");

-- CreateIndex
CREATE INDEX "sla_alerts_hubId_resolvedAt_idx" ON "sla_alerts"("hubId", "resolvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "sla_alerts_parcelId_leg_level_key" ON "sla_alerts"("parcelId", "leg", "level");

-- CreateIndex
CREATE INDEX "scan_events_parcelId_createdAt_idx" ON "scan_events"("parcelId", "createdAt");

-- CreateIndex
CREATE INDEX "scan_events_hubId_createdAt_idx" ON "scan_events"("hubId", "createdAt");

-- CreateIndex
CREATE INDEX "scan_events_riderId_createdAt_idx" ON "scan_events"("riderId", "createdAt");

-- CreateIndex
CREATE INDEX "scan_events_createdAt_idx" ON "scan_events"("createdAt");

-- CreateIndex
CREATE INDEX "rider_shift_schedules_riderId_active_idx" ON "rider_shift_schedules"("riderId", "active");

-- CreateIndex
CREATE INDEX "rider_attendance_riderId_checkInAt_idx" ON "rider_attendance"("riderId", "checkInAt");

-- CreateIndex
CREATE INDEX "rider_attendance_workDate_idx" ON "rider_attendance"("workDate");

-- CreateIndex
CREATE INDEX "report_schedules_active_nextRunAt_idx" ON "report_schedules"("active", "nextRunAt");

-- CreateIndex
CREATE INDEX "report_runs_scheduleId_createdAt_idx" ON "report_runs"("scheduleId", "createdAt");

-- CreateIndex
CREATE INDEX "report_runs_createdAt_idx" ON "report_runs"("createdAt");

-- CreateIndex
CREATE INDEX "parcels_currentHubId_status_idx" ON "parcels"("currentHubId", "status");

-- CreateIndex
CREATE INDEX "parcels_status_deliveryDueAt_idx" ON "parcels"("status", "deliveryDueAt");

-- CreateIndex
CREATE INDEX "parcels_status_pickupDueAt_idx" ON "parcels"("status", "pickupDueAt");

-- CreateIndex
CREATE INDEX "parcels_updatedAt_idx" ON "parcels"("updatedAt");

-- AddForeignKey
ALTER TABLE "delivery_zones" ADD CONSTRAINT "delivery_zones_hubId_fkey" FOREIGN KEY ("hubId") REFERENCES "hubs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_zones" ADD CONSTRAINT "delivery_zones_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "delivery_routes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_routes" ADD CONSTRAINT "delivery_routes_hubId_fkey" FOREIGN KEY ("hubId") REFERENCES "hubs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_routes" ADD CONSTRAINT "delivery_routes_defaultRiderId_fkey" FOREIGN KEY ("defaultRiderId") REFERENCES "riders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_plans" ADD CONSTRAINT "route_plans_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "riders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "linehaul_trips" ADD CONSTRAINT "linehaul_trips_originHubId_fkey" FOREIGN KEY ("originHubId") REFERENCES "hubs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "linehaul_trips" ADD CONSTRAINT "linehaul_trips_destHubId_fkey" FOREIGN KEY ("destHubId") REFERENCES "hubs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "linehaul_trips" ADD CONSTRAINT "linehaul_trips_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "linehaul_vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "linehaul_bags" ADD CONSTRAINT "linehaul_bags_originHubId_fkey" FOREIGN KEY ("originHubId") REFERENCES "hubs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "linehaul_bags" ADD CONSTRAINT "linehaul_bags_destHubId_fkey" FOREIGN KEY ("destHubId") REFERENCES "hubs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "linehaul_bags" ADD CONSTRAINT "linehaul_bags_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "linehaul_trips"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "linehaul_bag_items" ADD CONSTRAINT "linehaul_bag_items_bagId_fkey" FOREIGN KEY ("bagId") REFERENCES "linehaul_bags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "linehaul_bag_items" ADD CONSTRAINT "linehaul_bag_items_parcelId_fkey" FOREIGN KEY ("parcelId") REFERENCES "parcels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "linehaul_discrepancies" ADD CONSTRAINT "linehaul_discrepancies_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "linehaul_trips"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "linehaul_discrepancies" ADD CONSTRAINT "linehaul_discrepancies_bagId_fkey" FOREIGN KEY ("bagId") REFERENCES "linehaul_bags"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cn_batches" ADD CONSTRAINT "cn_batches_hubId_fkey" FOREIGN KEY ("hubId") REFERENCES "hubs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cn_batches" ADD CONSTRAINT "cn_batches_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cn_stock" ADD CONSTRAINT "cn_stock_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "cn_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cn_stock" ADD CONSTRAINT "cn_stock_parcelId_fkey" FOREIGN KEY ("parcelId") REFERENCES "parcels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sla_alerts" ADD CONSTRAINT "sla_alerts_parcelId_fkey" FOREIGN KEY ("parcelId") REFERENCES "parcels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rider_shift_schedules" ADD CONSTRAINT "rider_shift_schedules_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "riders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rider_attendance" ADD CONSTRAINT "rider_attendance_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "riders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rider_attendance" ADD CONSTRAINT "rider_attendance_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "rider_shift_schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "report_schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

