/**
 * Demo accounts of every type on the Bangladesh hub network (run `npm run db:seed:geo` first).
 * Idempotent: accounts are found by email and updated, never duplicated.
 *
 *   npm run db:seed:users -w @delivery-fast/api -- --out <file outside the repo>
 *
 * Passwords: one per role group, taken from DEMO_PASSWORD_<GROUP> (SUPER_ADMIN, OPS, HUB,
 * FINANCE, SUPPORT, RIDER, MERCHANT, CUSTOMER) or generated (18 characters, mixed). Every run
 * sets the accounts' passwords to these values and writes the credentials table to --out; no
 * password is stored in the repository. Refuses to run in production.
 */
import "reflect-metadata";
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { randomInt } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { passwordSchema } from "@delivery-fast/shared";
import { PrismaClient, type Prisma, type Role, type VehicleType } from "../generated/prisma/client";
import { hashPassword } from "../common/crypto";
import { nextCounter } from "../common/counters";
import { merchantCodePrefix } from "@delivery-fast/shared";

type Group = "SUPER_ADMIN" | "OPS" | "HUB" | "FINANCE" | "SUPPORT" | "RIDER" | "MERCHANT" | "CUSTOMER";
const PANEL: Record<Group, string> = {
  SUPER_ADMIN: "/super-admin",
  OPS: "/courier-operation",
  HUB: "/courier-operation",
  FINANCE: "/courier-operation",
  SUPPORT: "/courier-operation",
  RIDER: "/rider",
  MERCHANT: "",
  CUSTOMER: "/ (website: Sign in)",
};

interface Person {
  group: Group;
  label: string;
  name: string;
  email: string;
  phone: string;
}
const STAFF: (Person & { role: Role; hub?: string })[] = [
  { group: "SUPER_ADMIN", label: "Super admin", role: "SUPER_ADMIN", name: "Tanvir Ahmed", email: "superadmin@deliveryfast.example", phone: "+8801711000101" },
  { group: "OPS", label: "Operations manager", role: "OPS_MANAGER", name: "Farhana Akter", email: "ops.manager@deliveryfast.example", phone: "+8801711000102" },
  { group: "HUB", label: "Hub operator · Dhaka Central Sorting Hub", role: "HUB_OPERATOR", hub: "DHK-CSH", name: "Rakibul Hasan", email: "hubop.dhaka.central@deliveryfast.example", phone: "+8801711000103" },
  { group: "HUB", label: "Hub operator · Gulshan", role: "HUB_OPERATOR", hub: "DHK-GUL", name: "Nusrat Jahan", email: "hubop.gulshan@deliveryfast.example", phone: "+8801711000104" },
  { group: "HUB", label: "Hub operator · Chattogram", role: "HUB_OPERATOR", hub: "CTG-CEN", name: "Mahmudul Karim", email: "hubop.chattogram@deliveryfast.example", phone: "+8801711000105" },
  { group: "FINANCE", label: "Finance (maker)", role: "FINANCE", name: "Shahana Parvin", email: "finance.maker@deliveryfast.example", phone: "+8801711000106" },
  { group: "FINANCE", label: "Finance (checker)", role: "FINANCE", name: "Kamrul Islam", email: "finance.checker@deliveryfast.example", phone: "+8801711000107" },
  { group: "SUPPORT", label: "Support agent", role: "SUPPORT_AGENT", name: "Sumaiya Rahman", email: "support.agent@deliveryfast.example", phone: "+8801711000108" },
];
const RIDERS: (Person & { hub: string; vehicle: VehicleType })[] = [
  ["Abdul Karim", "DHK-GUL", "MOTORBIKE"],
  ["Jahid Hasan", "DHK-GUL", "BICYCLE"],
  ["Sohel Rana", "DHK-MIR", "MOTORBIKE"],
  ["Rasel Mia", "DHK-MIR", "MOTORBIKE"],
  ["Imran Hossain", "DHK-UTT", "MOTORBIKE"],
  ["Arif Billah", "DHK-UTT", "BICYCLE"],
  ["Mizanur Rahman", "DHK-DHN", "MOTORBIKE"],
  ["Shakil Ahmed", "DHK-DHN", "MOTORBIKE"],
  ["Nurul Alam", "CTG-CEN", "MOTORBIKE"],
  ["Fahim Chowdhury", "SYL-CTY", "MOTORBIKE"],
].map(([name, hub, vehicle], i) => ({
  group: "RIDER" as const,
  label: `Rider · ${hub}`,
  name,
  hub,
  vehicle: vehicle as VehicleType,
  email: `rider.${name.toLowerCase().replace(/\s+/g, ".")}@deliveryfast.example`,
  phone: `+88018110002${String(i + 1).padStart(2, "0")}`,
}));
const MERCHANTS = [
  {
    type: "ECOMMERCE" as const,
    name: "Shopnil Fashion House",
    plan: "Growth",
    pickup: { address: "House 12, Road 104, Gulshan 2, Dhaka", area: "Gulshan 2", district: "Dhaka North" },
    payout: { method: "BKASH", account: "01911000301" },
    owner: { group: "MERCHANT" as const, label: "E-commerce merchant · owner", name: "Mehedi Hasan", email: "merchant.ecom.owner@deliveryfast.example", phone: "+8801911000301" },
    staff: { group: "MERCHANT" as const, label: "E-commerce merchant · staff", name: "Taslima Begum", email: "merchant.ecom.staff@deliveryfast.example", phone: "+8801911000302" },
  },
  {
    type: "BANKING_FINANCIAL" as const,
    name: "Shapla Corporate Services Ltd",
    plan: "Business",
    pickup: { address: "Level 5, 21 Dilkusha C/A, Motijheel, Dhaka", area: "Dilkusha C/A", district: "Dhaka South" },
    payout: { method: "BANK", account: "0011-0200-334455" },
    owner: { group: "MERCHANT" as const, label: "Banking & Financial merchant · owner", name: "Anisur Rahman", email: "merchant.doc.owner@deliveryfast.example", phone: "+8801911000303" },
    staff: null,
  },
];
const CUSTOMERS: (Person & { address: { street: string; area: string; zone: string; district: string } })[] = [
  { group: "CUSTOMER", label: "Customer", name: "Ayesha Siddiqua", email: "customer.ayesha@deliveryfast.example", phone: "+8801511000401", address: { street: "Flat 4B, House 9, Road 7", area: "Dhanmondi R/A", zone: "Dhanmondi", district: "Dhaka Central" } },
  { group: "CUSTOMER", label: "Customer", name: "Rafiq Uddin", email: "customer.rafiq@deliveryfast.example", phone: "+8801611000402", address: { street: "House 22, Road 3, Sector 7", area: "Uttara Sector 7", zone: "Uttara", district: "Dhaka North" } },
];

/** 18 characters with upper and lower case letters, digits and symbols (no look-alikes). */
function generatePassword() {
  const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!#%+=?@"];
  const all = sets.join("");
  const chars = [...sets.map(s => s[randomInt(s.length)]), ...Array.from({ length: 14 }, () => all[randomInt(all.length)])];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

function outPath() {
  const i = process.argv.indexOf("--out");
  const file = i > 0 ? process.argv[i + 1] : undefined;
  if (!file) throw new Error("Pass --out <file> (outside the repository) for the credentials table");
  const resolved = path.resolve(file);
  const repo = path.resolve(__dirname, "../../../..");
  if (resolved.toLowerCase().startsWith(`${repo.toLowerCase()}${path.sep}`)) throw new Error("Write the credentials outside the repository");
  return resolved;
}

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to create demo accounts in production");
  const out = outPath();
  const passwords = {} as Record<Group, string>;
  for (const group of Object.keys(PANEL) as Group[]) {
    const given = process.env[`DEMO_PASSWORD_${group}`];
    passwords[group] = given ? passwordSchema.parse(given) : generatePassword();
    if (passwords[group].length < 14) throw new Error(`DEMO_PASSWORD_${group}: use at least 14 characters`);
  }
  const hashes = {} as Record<Group, string>;
  for (const group of Object.keys(passwords) as Group[]) hashes[group] = await hashPassword(passwords[group]);

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
  const rows: { role: string; name: string; email: string; phone: string; group: Group; panel: string; note?: string }[] = [];
  try {
    await prisma.$transaction(
      async tx => {
        const hubs = new Map((await tx.hub.findMany()).map(h => [h.code, h]));
        const hub = (code: string) => hubs.get(code) ?? Promise.reject(new Error(`Hub ${code} is missing: run npm run db:seed:geo first`));

        /** The account with this email (or phone), created or updated; returns its id. */
        const account = async (p: Person) => {
          const data = { name: p.name, phone: p.phone, email: p.email, passwordHash: hashes[p.group], status: "ACTIVE" as const, phoneVerifiedAt: new Date(), failedLoginCount: 0, lockedUntil: null };
          const existing = (await tx.user.findUnique({ where: { email: p.email } })) ?? (await tx.user.findUnique({ where: { phone: p.phone } }));
          const user = existing ? await tx.user.update({ where: { id: existing.id }, data }) : await tx.user.create({ data });
          return user.id;
        };
        const grant = async (userId: string, role: Role, scope: { merchantId?: string; hubId?: string } = {}) => {
          const exists = await tx.userRole.findFirst({ where: { userId, role, merchantId: scope.merchantId ?? null, hubId: scope.hubId ?? null, customRoleId: null } });
          if (!exists) await tx.userRole.create({ data: { userId, role, ...scope } });
        };

        for (const s of STAFF) {
          const userId = await account(s);
          const h = s.hub ? await hub(s.hub) : null;
          await grant(userId, s.role, h ? { hubId: h.id } : {});
          rows.push({ role: s.label, name: s.name, email: s.email, phone: s.phone, group: s.group, panel: PANEL[s.group], note: s.role === "SUPER_ADMIN" ? "Sets up two-step verification (authenticator app) at first sign-in" : undefined });
        }

        for (const r of RIDERS) {
          const userId = await account(r);
          await grant(userId, "RIDER");
          const h = await hub(r.hub);
          const existing = await tx.rider.findUnique({ where: { userId } });
          const rider = existing
            ? await tx.rider.update({ where: { id: existing.id }, data: { hubId: h.id, vehicle: r.vehicle, zone: h.zone, active: true } })
            : await tx.rider.create({ data: { userId, code: `R-${await nextCounter(tx, "rider-code", 2100)}`, hubId: h.id, vehicle: r.vehicle, zone: h.zone, active: true } });
          const now = new Date();
          await tx.riderOnboarding.upsert({
            where: { riderId: rider.id },
            create: { riderId: rider.id, status: "APPROVED", submittedAt: now, reviewedAt: now, note: "Demo rider: verified at setup" },
            update: { status: "APPROVED", reviewedAt: now },
          });
          rows.push({ role: `${r.label} (${rider.code})`, name: r.name, email: r.email, phone: r.phone, group: r.group, panel: PANEL.RIDER });
        }

        for (const m of MERCHANTS) {
          const plan = await tx.servicePlan.findFirst({ where: { segment: m.type, name: m.plan, active: true } });
          const data = {
            type: m.type,
            name: m.name,
            status: "ACTIVE" as const,
            contactName: m.owner.name,
            contactPhone: m.owner.phone,
            contactEmail: m.owner.email,
            pickupAddress: m.pickup.address,
            pickupArea: m.pickup.area,
            pickupDistrict: m.pickup.district,
            planId: plan?.id ?? null,
            payoutAccount: m.payout as Prisma.InputJsonValue,
            kycStatus: "APPROVED" as const,
            kycSubmittedAt: new Date(),
            kycReviewedAt: new Date(),
          };
          const existing = await tx.merchant.findFirst({ where: { contactEmail: m.owner.email } });
          let merchant = existing ? await tx.merchant.update({ where: { id: existing.id }, data }) : null;
          if (!merchant) {
            let code = "";
            for (let i = 0; i < 100 && !code; i++) {
              const candidate = `${merchantCodePrefix(data.type)}-${await nextCounter(tx, "merchant-code", 1000)}`;
              if (!(await tx.merchant.findUnique({ where: { code: candidate } }))) code = candidate;
            }
            merchant = await tx.merchant.create({ data: { ...data, code } });
          }
          const panel = m.type === "ECOMMERCE" ? "/ecommerce-merchant" : "/banking-merchant";
          const ownerId = await account(m.owner);
          await grant(ownerId, "MERCHANT_OWNER", { merchantId: merchant.id });
          rows.push({ role: `${m.owner.label} · ${merchant.name} (${merchant.code})`, name: m.owner.name, email: m.owner.email, phone: m.owner.phone, group: "MERCHANT", panel });
          if (m.staff) {
            const staffId = await account(m.staff);
            await grant(staffId, "MERCHANT_STAFF", { merchantId: merchant.id });
            rows.push({ role: `${m.staff.label} · ${merchant.name} (${merchant.code})`, name: m.staff.name, email: m.staff.email, phone: m.staff.phone, group: "MERCHANT", panel });
          }
        }

        for (const c of CUSTOMERS) {
          const userId = await account(c);
          await grant(userId, "CUSTOMER");
          if (!(await tx.address.findFirst({ where: { userId } })))
            await tx.address.create({ data: { userId, role: "RECEIVER", category: "HOME", contactName: c.name, phone: c.phone, street: c.address.street, area: c.address.area, zone: c.address.zone, district: c.address.district, isDefault: true } });
          rows.push({ role: c.label, name: c.name, email: c.email, phone: c.phone, group: c.group, panel: PANEL.CUSTOMER });
        }

        await tx.auditLog.create({
          data: { actorType: "SYSTEM", actorLabel: "Demo accounts seed", action: "seed.demo_users", entityType: "user", data: { accounts: rows.map(r => ({ role: r.role, email: r.email })) } },
        });
      },
      { timeout: 120_000 },
    );
  } finally {
    await prisma.$disconnect();
  }

  const table = [
    "| Role | Name | Email | Phone | Password | Panel |",
    "|---|---|---|---|---|---|",
    ...rows.map(r => `| ${r.role} | ${r.name} | ${r.email} | ${r.phone} (or 0${r.phone.slice(4)}) | \`${passwords[r.group]}\` | ${r.panel}${r.note ? ` · ${r.note}` : ""} |`),
  ];
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(
    out,
    `# Delivery Fast demo accounts\n\nGenerated ${new Date().toISOString()} by \`npm run db:seed:users\`. Sign in with the email or the phone number and the password.\nOne password per role group. Running the seed again sets new passwords and rewrites this file.\n\n${table.join("\n")}\n`,
  );
  console.log(`${rows.length} accounts ready. Credentials written to ${out}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
