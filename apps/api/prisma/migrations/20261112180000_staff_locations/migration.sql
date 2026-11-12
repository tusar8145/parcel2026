-- CreateTable
CREATE TABLE "staff_locations" (
    "userId" UUID NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "accuracy" DOUBLE PRECISION NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_locations_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "staff_location_points" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "accuracy" DOUBLE PRECISION NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_location_points_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "staff_location_points_at_idx" ON "staff_location_points"("at");

-- CreateIndex
CREATE UNIQUE INDEX "staff_location_points_userId_at_key" ON "staff_location_points"("userId", "at");

-- AddForeignKey
ALTER TABLE "staff_locations" ADD CONSTRAINT "staff_locations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_location_points" ADD CONSTRAINT "staff_location_points_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

