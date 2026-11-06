import { packagePricesSchema, serviceLabel, type PackagePrices, type PackageSegment } from "@delivery-fast/shared";
import { AppError } from "../../common/errors";
import type { Db } from "../../common/prisma.service";
import { env } from "../../config/env";
import type { MerchantType, Segment } from "../../generated/prisma/client";

/** The package (and its version in force) that applies to a merchant or segment. */
export interface PackageView {
  packageId: string;
  name: string;
  segment: PackageSegment;
  isDefault: boolean;
  status: "ACTIVE" | "ARCHIVED";
  versionId: string;
  version: number;
  effectiveFrom: Date;
  services: string[];
  prices: PackagePrices;
}

export const segmentOfMerchant = (type: MerchantType | string | null | undefined): PackageSegment => (type === "BANKING_FINANCIAL" ? "BANKING_FINANCIAL" : "ECOMMERCE");

/** Short-lived cache (merchant / segment → package view); cleared on every package change on this instance. */
const cache = new Map<string, { until: number; value: PackageView | null }>();
const ttl = () => (env().NODE_ENV === "test" ? 0 : 15_000);
export const invalidatePackageCache = () => cache.clear();
export function cached(key: string): PackageView | null | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.until < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}
export function remember(key: string, value: PackageView | null) {
  const ms = ttl();
  if (ms > 0) cache.set(key, { until: Date.now() + ms, value });
  return value;
}

/** The version of a package in force at `at` (latest effectiveFrom not after it). */
export async function versionInForce(db: Db, packageId: string, at = new Date()): Promise<PackageView | null> {
  const version = await db.servicePackageVersion.findFirst({
    where: { packageId, effectiveFrom: { lte: at } },
    orderBy: [{ effectiveFrom: "desc" }, { version: "desc" }],
    include: { package: true },
  });
  if (!version) return null;
  const parsed = packagePricesSchema.safeParse(version.prices);
  return {
    packageId: version.packageId,
    name: version.package.name,
    segment: version.package.segment as PackageSegment,
    isDefault: version.package.defaultFor === version.package.segment,
    status: version.package.status,
    versionId: version.id,
    version: version.version,
    effectiveFrom: version.effectiveFrom,
    services: version.services,
    prices: parsed.success ? parsed.data : packagePricesSchema.parse({}),
  };
}

/** The segment's Default package in force (null before the first migration). */
export async function defaultPackage(db: Db, segment: Segment): Promise<PackageView | null> {
  const pkg = await db.servicePackage.findUnique({ where: { defaultFor: segment }, select: { id: true } });
  return pkg ? versionInForce(db, pkg.id) : null;
}

/**
 * The package assigned to a merchant now: its latest assignment in force (null package = the
 * default), else the package converted from its old service plan (`planPackageId`), else null
 * (the caller uses the segment default).
 */
export async function assignedPackage(db: Db, merchantId: string, at = new Date()): Promise<{ packageId: string | null; assigned: boolean }> {
  const assignment = await db.packageAssignment.findFirst({
    where: { merchantId, effectiveFrom: { lte: at } },
    orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
    select: { packageId: true },
  });
  return assignment ? { packageId: assignment.packageId, assigned: true } : { packageId: null, assigned: false };
}

/**
 * Whether a merchant's package includes a service, without creating anything (for guards and
 * webhooks): true while packages haven't been set up yet (today's behaviour).
 */
export async function merchantHasService(db: Db, merchantId: string, code: string): Promise<boolean> {
  const key = `has:${merchantId}`;
  let view = cached(key);
  if (view === undefined) {
    const merchant = await db.merchant.findUnique({ where: { id: merchantId }, select: { type: true } });
    if (!merchant) return false;
    const { packageId } = await assignedPackage(db, merchantId);
    let found: PackageView | null = packageId ? await versionInForce(db, packageId) : null;
    if (found && found.segment !== segmentOfMerchant(merchant.type)) found = null;
    view = remember(key, found ?? (await defaultPackage(db, segmentOfMerchant(merchant.type))));
  }
  return view ? view.services.includes(code) : true;
}

/** 403 SERVICE_NOT_IN_PACKAGE: <service> when the merchant's package doesn't include the service. */
export async function assertMerchantService(db: Db, merchantId: string, code: string) {
  if (await merchantHasService(db, merchantId, code)) return;
  const label = serviceLabel(code);
  throw new AppError("SERVICE_NOT_IN_PACKAGE", `SERVICE_NOT_IN_PACKAGE: ${label}. Your service package doesn't include it; contact Delivery Fast to change it.`, 403, { service: code });
}
