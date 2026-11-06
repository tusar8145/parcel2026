/**
 * The settings a new installation needs before its first parcel (run after `npm run db:seed:geo`):
 * merchant service plans, a price card per customer type, and the central hub that receives the hubs' cash.
 * Settings only (no people, parcels or money), so it is safe on a real installation. Idempotent: what
 * already exists is kept. Super admin changes all of it later (Service plans & pricing, Accounts).
 *
 *   npm run db:seed:setup -w @delivery-fast/api
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { DEFAULT_RATE_CARD } from "@delivery-fast/shared";
import { PrismaClient, type Prisma } from "../generated/prisma/client";
import { ACCOUNTS_CONFIG_KEY } from "../modules/money/accounts-config";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });

const PLANS = [
  { segment: "ECOMMERCE", name: "Starter", monthlyFee: 0, discountPct: 0 },
  { segment: "ECOMMERCE", name: "Growth", monthlyFee: 1500, discountPct: 8 },
  { segment: "ECOMMERCE", name: "Business", monthlyFee: 4500, discountPct: 16 },
  { segment: "BANKING_FINANCIAL", name: "Business", monthlyFee: 6000, discountPct: 10 },
  { segment: "BANKING_FINANCIAL", name: "Enterprise", monthlyFee: 15000, discountPct: 18 },
] as const;

const RATE_CARDS = [
  { segment: "CUSTOMER", name: "Customer parcels", config: DEFAULT_RATE_CARD },
  { segment: "ECOMMERCE", name: "E-commerce standard", config: DEFAULT_RATE_CARD },
  { segment: "BANKING_FINANCIAL", name: "Corporate documents", config: { ...DEFAULT_RATE_CARD, sameZone: 60, crossZone: 100 } },
] as const;

/** The hub the other hubs send their cash to (Courier Operations › Accounts). */
const CENTRAL_HUB = "DHK-CSH";

async function main() {
  const done: string[] = [];
  for (const p of PLANS) {
    if (await prisma.servicePlan.findFirst({ where: { segment: p.segment, name: p.name } })) continue;
    await prisma.servicePlan.create({ data: { ...p, features: [] } });
    done.push(`service plan ${p.segment} ${p.name}`);
  }
  for (const c of RATE_CARDS) {
    if (await prisma.rateCard.findFirst({ where: { segment: c.segment } })) continue;
    await prisma.rateCard.create({ data: { segment: c.segment, name: c.name, config: c.config as Prisma.InputJsonValue, effectiveFrom: new Date("2026-01-01T00:00:00Z") } });
    done.push(`price card ${c.segment}`);
  }
  const central = await prisma.hub.findUnique({ where: { code: CENTRAL_HUB } });
  if (!central) throw new Error(`Hub ${CENTRAL_HUB} is missing: run npm run db:seed:geo first`);
  const config = await prisma.setting.findUnique({ where: { key: ACCOUNTS_CONFIG_KEY } });
  if (!(config?.value as { centralHubId?: string } | null)?.centralHubId) {
    await prisma.setting.upsert({
      where: { key: ACCOUNTS_CONFIG_KEY },
      create: { key: ACCOUNTS_CONFIG_KEY, value: { centralHubId: central.id } },
      update: { value: { ...((config?.value as object) ?? {}), centralHubId: central.id } },
    });
    done.push(`central hub ${central.name}`);
  }
  await prisma.auditLog.create({ data: { actorType: "SYSTEM", actorLabel: "Company setup seed", action: "seed.company_setup", entityType: "setting", data: { done } } });
  console.log(done.length ? `Set up: ${done.join(", ")}.` : "Already set up: nothing to do.");
}

main()
  .catch(error => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
