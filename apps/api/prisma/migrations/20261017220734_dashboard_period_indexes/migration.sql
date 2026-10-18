-- CreateIndex
CREATE INDEX "cod_collections_collectedAt_idx" ON "cod_collections"("collectedAt");

-- CreateIndex
CREATE INDEX "merchant_settlements_status_paidAt_idx" ON "merchant_settlements"("status", "paidAt");

-- CreateIndex
CREATE INDEX "parcels_createdAt_idx" ON "parcels"("createdAt");

-- CreateIndex
CREATE INDEX "parcels_deliveredAt_idx" ON "parcels"("deliveredAt");

-- CreateIndex
CREATE INDEX "parcels_pickedUpAt_idx" ON "parcels"("pickedUpAt");

-- CreateIndex
CREATE INDEX "parcels_merchantId_deliveredAt_idx" ON "parcels"("merchantId", "deliveredAt");

