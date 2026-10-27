/**
 * Development seed: the hubs, riders and merchants the web panels show, plus one account
 * per role. Idempotent (safe to run again). Refuses to run in production.
 *
 *   npm run db:seed                       (development)
 *   node dist/seed/demo.js                (built image; set ALLOW_DEMO_SEED=true when NODE_ENV=production)
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { hash } from "@node-rs/argon2";
import { DEFAULT_RATE_CARD } from "@delivery-fast/shared";
import { PrismaClient, type Role } from "../generated/prisma/client";

if (process.env.NODE_ENV === "production" && process.env.ALLOW_DEMO_SEED !== "true") {
  console.error("Refusing to seed demo data in production (set ALLOW_DEMO_SEED=true for a demo deployment).");
  process.exit(1);
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
export const DEMO_PASSWORD = "DeliveryFast2026";

const HUBS = [
  { code: "DHK-GUL", name: "Gulshan Sorting Hub", district: "Dhaka North", address: "Road 11, Gulshan 1, Dhaka" },
  { code: "DHK-MOT", name: "Motijheel Service Center", district: "Dhaka South", address: "Dilkusha C/A, Motijheel, Dhaka" },
  { code: "DHK-DHN", name: "Dhanmondi Hub", district: "Dhaka Central", address: "Road 7, Dhanmondi, Dhaka" },
  { code: "CTG-CEN", name: "Chattogram Central Hub", district: "Chattogram", address: "Agrabad C/A, Chattogram" },
  { code: "SYL-CTY", name: "Sylhet City Hub", district: "Sylhet", address: "Zindabazar, Sylhet" },
];

const RIDERS = [
  { code: "R-2048", name: "Jordan Rivera", phone: "+8801710002048", hub: "DHK-GUL", zone: "Dhaka North", vehicle: "MOTORBIKE" },
  { code: "R-2029", name: "Ayesha Noor", phone: "+8801710002029", hub: "DHK-GUL", zone: "Dhaka North", vehicle: "MOTORBIKE" },
  { code: "R-2030", name: "Tanvir Alam", phone: "+8801710002030", hub: "DHK-DHN", zone: "Dhaka Central", vehicle: "BICYCLE" },
  { code: "R-2041", name: "Nabila Sultana", phone: "+8801710002041", hub: "DHK-GUL", zone: "Dhaka North", vehicle: "MOTORBIKE" },
  { code: "R-2016", name: "Samira Khan", phone: "+8801710002016", hub: "DHK-MOT", zone: "Dhaka South", vehicle: "MOTORBIKE" },
  { code: "R-2051", name: "Imran Hasan", phone: "+8801710002051", hub: "CTG-CEN", zone: "Chattogram", vehicle: "VAN" },
] as const;

const STAFF: { name: string; phone: string; email: string; role: Role; hub?: string }[] = [
  { name: "Super Admin", phone: "+8801700000001", email: "admin@pairaexpress.example", role: "SUPER_ADMIN" },
  { name: "Arif Mahmud", phone: "+8801700000002", email: "ops@pairaexpress.example", role: "OPS_MANAGER" },
  { name: "Hub Operator Gulshan", phone: "+8801700000003", email: "hub.gulshan@pairaexpress.example", role: "HUB_OPERATOR", hub: "DHK-GUL" },
  { name: "Finance Desk", phone: "+8801700000004", email: "finance@pairaexpress.example", role: "FINANCE" },
  { name: "Support Desk", phone: "+8801700000005", email: "support@pairaexpress.example", role: "SUPPORT_AGENT" },
];

const MERCHANTS = [
  {
    code: "MR-1001",
    type: "ECOMMERCE",
    name: "Northstar Store",
    owner: { name: "Nadia Rahman", phone: "+8801800001001", email: "owner@northstar.example" },
    pickup: { address: "House 12, Road 5, Banani", area: "Banani Block C", district: "Dhaka North" },
    plan: "Growth",
  },
  {
    code: "MR-1002",
    type: "BANKING_FINANCIAL",
    name: "Meridian Bank PLC",
    owner: { name: "Kamal Hossain", phone: "+8801800001002", email: "ops@meridianbank.example" },
    pickup: { address: "Meridian Tower, Dilkusha", area: "Motijheel", district: "Dhaka South" },
    plan: "Business",
  },
] as const;

const PLANS = [
  { segment: "ECOMMERCE", name: "Starter", monthlyFee: 0, discountPct: 0 },
  { segment: "ECOMMERCE", name: "Growth", monthlyFee: 1500, discountPct: 8 },
  { segment: "ECOMMERCE", name: "Business", monthlyFee: 4500, discountPct: 16 },
  { segment: "BANKING_FINANCIAL", name: "Business", monthlyFee: 6000, discountPct: 10 },
  { segment: "BANKING_FINANCIAL", name: "Enterprise", monthlyFee: 15000, discountPct: 18 },
] as const;

async function user(input: { name: string; phone: string; email?: string }, passwordHash: string) {
  return prisma.user.upsert({
    where: { phone: input.phone },
    update: {},
    create: { ...input, passwordHash, phoneVerifiedAt: new Date() },
  });
}

async function grant(userId: string, role: Role, scope: { merchantId?: string; hubId?: string } = {}) {
  const existing = await prisma.userRole.findFirst({ where: { userId, role, merchantId: scope.merchantId ?? null, hubId: scope.hubId ?? null } });
  if (!existing) await prisma.userRole.create({ data: { userId, role, ...scope } });
}

async function main() {
  const passwordHash = await hash(DEMO_PASSWORD, { memoryCost: 19456, timeCost: 2, parallelism: 1 });

  const hubs = new Map<string, string>();
  for (const h of HUBS) hubs.set(h.code, (await prisma.hub.upsert({ where: { code: h.code }, update: {}, create: h })).id);

  for (const r of RIDERS) {
    const u = await user({ name: r.name, phone: r.phone }, passwordHash);
    await grant(u.id, "RIDER");
    await prisma.rider.upsert({ where: { code: r.code }, update: {}, create: { userId: u.id, code: r.code, hubId: hubs.get(r.hub), zone: r.zone, vehicle: r.vehicle } });
  }

  for (const s of STAFF) {
    const u = await user({ name: s.name, phone: s.phone, email: s.email }, passwordHash);
    await grant(u.id, s.role, s.hub ? { hubId: hubs.get(s.hub) } : {});
  }

  for (const p of PLANS) {
    const existing = await prisma.servicePlan.findFirst({ where: { segment: p.segment, name: p.name } });
    if (!existing) await prisma.servicePlan.create({ data: { ...p, features: [] } });
  }

  for (const m of MERCHANTS) {
    const plan = await prisma.servicePlan.findFirst({ where: { segment: m.type, name: m.plan } });
    const merchant = await prisma.merchant.upsert({
      where: { code: m.code },
      update: {},
      create: {
        code: m.code,
        type: m.type,
        name: m.name,
        status: "ACTIVE",
        // Demo workspaces are verified (API keys need approved KYC by default).
        kycStatus: "APPROVED",
        kycSubmittedAt: new Date(),
        kycReviewedAt: new Date(),
        contactName: m.owner.name,
        contactPhone: m.owner.phone,
        contactEmail: m.owner.email,
        pickupAddress: m.pickup.address,
        pickupArea: m.pickup.area,
        pickupDistrict: m.pickup.district,
        planId: plan?.id,
      },
    });
    const owner = await user(m.owner, passwordHash);
    await grant(owner.id, "MERCHANT_OWNER", { merchantId: merchant.id });
  }

  const customer = await user({ name: "Rahim Uddin", phone: "+8801711000000", email: "customer@pairaexpress.example" }, passwordHash);
  await grant(customer.id, "CUSTOMER");

  for (const [segment, name] of [
    ["CUSTOMER", "Customer parcels 2026"],
    ["ECOMMERCE", "E-commerce standard 2026"],
    ["BANKING_FINANCIAL", "Corporate documents 2026"],
  ] as const) {
    if (!(await prisma.rateCard.findFirst({ where: { segment } }))) {
      const config = segment === "BANKING_FINANCIAL" ? { ...DEFAULT_RATE_CARD, sameZone: 60, crossZone: 100 } : DEFAULT_RATE_CARD;
      await prisma.rateCard.create({ data: { segment, name, config, effectiveFrom: new Date("2026-01-01T00:00:00Z") } });
    }
  }

  console.log(`Seeded. Every demo account uses the password "${DEMO_PASSWORD}":`);
  console.table([
    ...STAFF.map(s => ({ role: s.role, login: s.email, phone: s.phone })),
    ...MERCHANTS.map(m => ({ role: `MERCHANT_OWNER (${m.name})`, login: m.owner.email, phone: m.owner.phone })),
    ...RIDERS.map(r => ({ role: `RIDER ${r.code}`, login: r.phone.replace("+88", ""), phone: r.phone })),
    { role: "CUSTOMER", login: "customer@pairaexpress.example", phone: "+8801711000000" },
  ]);
}

main()
  .catch(error => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
