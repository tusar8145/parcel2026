-- AlterTable
ALTER TABLE "parcel_products" ADD COLUMN "aiCreated" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "product_categories" ADD COLUMN "aiCreated" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "delivery_zones" ADD COLUMN "aiCreated" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ai_import_usage" (
    "id" UUID NOT NULL,
    "importNumber" TEXT,
    "merchantId" UUID,
    "userId" UUID,
    "products" INTEGER NOT NULL DEFAULT 0,
    "places" INTEGER NOT NULL DEFAULT 0,
    "productsMatched" INTEGER NOT NULL DEFAULT 0,
    "productsCreated" INTEGER NOT NULL DEFAULT 0,
    "categoriesCreated" INTEGER NOT NULL DEFAULT 0,
    "placesMatched" INTEGER NOT NULL DEFAULT 0,
    "zonesCreated" INTEGER NOT NULL DEFAULT 0,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "ms" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_import_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_import_aliases" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_import_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_import_usage_createdAt_idx" ON "ai_import_usage"("createdAt");
CREATE UNIQUE INDEX "ai_import_aliases_kind_scope_text_key" ON "ai_import_aliases"("kind", "scope", "text");
