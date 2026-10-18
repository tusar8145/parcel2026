-- CreateTable
CREATE TABLE "vehicle_shares" (
    "id" UUID NOT NULL,
    "tripId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,
    "lastAt" TIMESTAMP(3),
    "points" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "vehicle_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_locations" (
    "tripId" UUID NOT NULL,
    "shareId" UUID NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "accuracy" DOUBLE PRECISION NOT NULL,
    "heading" DOUBLE PRECISION,
    "speed" DOUBLE PRECISION,
    "at" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_locations_pkey" PRIMARY KEY ("tripId")
);

-- CreateTable
CREATE TABLE "trip_location_points" (
    "id" UUID NOT NULL,
    "tripId" UUID NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "accuracy" DOUBLE PRECISION NOT NULL,
    "heading" DOUBLE PRECISION,
    "speed" DOUBLE PRECISION,
    "at" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_location_points_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vehicle_shares_tripId_endedAt_idx" ON "vehicle_shares"("tripId", "endedAt");

-- CreateIndex
CREATE INDEX "vehicle_shares_userId_endedAt_idx" ON "vehicle_shares"("userId", "endedAt");

-- CreateIndex
CREATE INDEX "trip_location_points_at_idx" ON "trip_location_points"("at");

-- CreateIndex
CREATE UNIQUE INDEX "trip_location_points_tripId_at_key" ON "trip_location_points"("tripId", "at");

-- AddForeignKey
ALTER TABLE "vehicle_shares" ADD CONSTRAINT "vehicle_shares_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "linehaul_trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_locations" ADD CONSTRAINT "trip_locations_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "linehaul_trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_location_points" ADD CONSTRAINT "trip_location_points_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "linehaul_trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

