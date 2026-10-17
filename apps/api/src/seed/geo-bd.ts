/**
 * Bangladesh geography and hub network (configuration). Idempotent: run it as often as you like.
 *
 *   npm run db:seed:geo -w @delivery-fast/api
 *
 * 1. Service catalog (Setting "catalog"): every district, zone (upazila / city thana) and area
 *    (union / neighbourhood) from prisma/data/bd-geo.json is merged in. Nothing already in the
 *    catalog is removed or reordered, so existing zones keep pricing exactly as before.
 * 2. Hubs: created when their code is missing; existing hubs only get the fields that are empty
 *    (zone, coordinates, capacity), so edits made in the panels are kept.
 * 3. Delivery zones: one per catalog zone of the dataset, served by a hub (Dhaka city zones by the
 *    hub listed below, every other district by its own hub or the nearest regional hub). Existing
 *    zone rows only get a hub when they have none.
 *
 * Data: nuhil/bangladesh-geocode (MIT) + curated city zones; see scripts/build-geo-bd.mjs.
 * Hub coordinates are approximate city/neighbourhood centres.
 */
import "reflect-metadata";
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "../generated/prisma/client";
import { catalogSchema, DEFAULT_CATALOG, type Catalog } from "../modules/pricing/pricing.service";
import { GEO_META_KEY, lockGeography, normalizeMeta, type GeoMeta } from "../modules/geography/geo-catalog";
import { renameDistrictRecord } from "../modules/geography/geography.service";

interface GeoZone {
  name: string;
  bn: string | null;
  kind: "city" | "upazila";
  areas: { name: string; bn: string | null }[];
}
interface GeoDistrict {
  name: string;
  bn: string | null;
  division: string;
  lat: number | null;
  lng: number | null;
  of?: string;
  zones: GeoZone[];
}
interface GeoData {
  source: string;
  districts: GeoDistrict[];
}

interface HubSeed {
  code: string;
  name: string;
  district: string;
  zone: string;
  address: string;
  lat: number;
  lng: number;
  capacity: number;
  /** "dhaka" hubs serve the city zones listed in DHAKA_ZONES; "regional" hubs serve whole districts. */
  kind: "sorting" | "dhaka" | "regional";
}

/**
 * The Dhaka district outside the city (Savar, Keraniganj, Dhamrai, Dohar, Nawabganj, Ashulia); the
 * city thanas are the districts Dhaka North / Central / South (pricing treats those as one, "Dhaka").
 * Was "Dhaka" until 2026-10-17; `renameDhakaSuburban()` moves existing data over.
 */
export const DHAKA_SUBURBAN = "Dhaka (Sub-urban)";

export const HUBS: HubSeed[] = [
  // Dhaka: central sorting hub and delivery hubs
  { code: "DHK-CSH", name: "Dhaka Central Sorting Hub", district: "Dhaka Central", zone: "Tejgaon Industrial Area", address: "Tejgaon I/A, Dhaka", lat: 23.7645, lng: 90.3995, capacity: 20000, kind: "sorting" },
  { code: "DHK-GUL", name: "Gulshan Sorting Hub", district: "Dhaka North", zone: "Gulshan", address: "Road 11, Gulshan 1, Dhaka", lat: 23.7806, lng: 90.4167, capacity: 4000, kind: "dhaka" },
  { code: "DHK-BAD", name: "Badda Delivery Hub", district: "Dhaka North", zone: "Badda", address: "Merul Badda, Dhaka", lat: 23.7726, lng: 90.4237, capacity: 3000, kind: "dhaka" },
  { code: "DHK-UTT", name: "Uttara Delivery Hub", district: "Dhaka North", zone: "Uttara", address: "Sector 7, Uttara, Dhaka", lat: 23.8728, lng: 90.3984, capacity: 3500, kind: "dhaka" },
  { code: "DHK-MIR", name: "Mirpur Delivery Hub", district: "Dhaka Central", zone: "Mirpur", address: "Mirpur 10, Dhaka", lat: 23.8069, lng: 90.3687, capacity: 3500, kind: "dhaka" },
  { code: "DHK-MOH", name: "Mohammadpur Delivery Hub", district: "Dhaka Central", zone: "Mohammadpur", address: "Asad Gate, Mohammadpur, Dhaka", lat: 23.7612, lng: 90.3654, capacity: 3000, kind: "dhaka" },
  { code: "DHK-DHN", name: "Dhanmondi Hub", district: "Dhaka Central", zone: "Dhanmondi", address: "Road 7, Dhanmondi, Dhaka", lat: 23.7461, lng: 90.3742, capacity: 3000, kind: "dhaka" },
  { code: "DHK-MOT", name: "Motijheel Service Center", district: "Dhaka South", zone: "Motijheel", address: "Dilkusha C/A, Motijheel, Dhaka", lat: 23.733, lng: 90.4172, capacity: 3000, kind: "dhaka" },
  { code: "DHK-JAT", name: "Jatrabari Delivery Hub", district: "Dhaka South", zone: "Jatrabari", address: "Jatrabari, Dhaka", lat: 23.7104, lng: 90.4348, capacity: 3000, kind: "dhaka" },
  // Greater Dhaka
  { code: "DHK-SAV", name: "Savar Hub", district: DHAKA_SUBURBAN, zone: "Savar", address: "Savar Bazar, Savar, Dhaka", lat: 23.8583, lng: 90.2667, capacity: 2500, kind: "regional" },
  { code: "DHK-KER", name: "Keraniganj Hub", district: DHAKA_SUBURBAN, zone: "Keraniganj", address: "Zinzira, Keraniganj, Dhaka", lat: 23.7025, lng: 90.3925, capacity: 2500, kind: "regional" },
  { code: "GAZ-CEN", name: "Gazipur Hub", district: "Gazipur", zone: "Gazipur Sadar", address: "Joydebpur, Gazipur", lat: 23.9999, lng: 90.4203, capacity: 2500, kind: "regional" },
  { code: "NGJ-CEN", name: "Narayanganj Hub", district: "Narayanganj", zone: "Narayanganj Sadar", address: "Chashara, Narayanganj", lat: 23.6238, lng: 90.5, capacity: 2500, kind: "regional" },
  // Division hubs
  { code: "CTG-CEN", name: "Chattogram Central Hub", district: "Chattogram", zone: "Agrabad", address: "Agrabad C/A, Chattogram", lat: 22.329, lng: 91.812, capacity: 8000, kind: "regional" },
  { code: "SYL-CTY", name: "Sylhet City Hub", district: "Sylhet", zone: "Kotwali (Sylhet)", address: "Zindabazar, Sylhet", lat: 24.8949, lng: 91.8687, capacity: 3000, kind: "regional" },
  { code: "RAJ-CEN", name: "Rajshahi Hub", district: "Rajshahi", zone: "Boalia", address: "Shaheb Bazar, Rajshahi", lat: 24.3655, lng: 88.6006, capacity: 3000, kind: "regional" },
  { code: "KHL-CEN", name: "Khulna Hub", district: "Khulna", zone: "Sonadanga", address: "Sonadanga, Khulna", lat: 22.8167, lng: 89.5403, capacity: 3000, kind: "regional" },
  { code: "BSL-CEN", name: "Barishal Hub", district: "Barishal", zone: "Kotwali (Barishal)", address: "Nathullabad, Barishal", lat: 22.701, lng: 90.3535, capacity: 2500, kind: "regional" },
  { code: "RNG-CEN", name: "Rangpur Hub", district: "Rangpur", zone: "Kotwali (Rangpur)", address: "Jahaj Company Mor, Rangpur", lat: 25.7439, lng: 89.2752, capacity: 2500, kind: "regional" },
  { code: "MYM-CEN", name: "Mymensingh Hub", district: "Mymensingh", zone: "Kotwali (Mymensingh)", address: "Ganginarpar, Mymensingh", lat: 24.7471, lng: 90.4203, capacity: 2500, kind: "regional" },
  // Key district hubs
  { code: "CML-CEN", name: "Cumilla Hub", district: "Cumilla", zone: "Kotwali (Cumilla)", address: "Kandirpar, Cumilla", lat: 23.4607, lng: 91.1809, capacity: 2000, kind: "regional" },
  { code: "BOG-CEN", name: "Bogura Hub", district: "Bogura", zone: "Bogura Sadar", address: "Satmatha, Bogura", lat: 24.8465, lng: 89.3773, capacity: 2000, kind: "regional" },
  { code: "COX-CEN", name: "Cox's Bazar Hub", district: "Cox's Bazar", zone: "Cox's Bazar Sadar", address: "Kolatoli Road, Cox's Bazar", lat: 21.4272, lng: 92.0058, capacity: 1500, kind: "regional" },
  { code: "JSR-CEN", name: "Jashore Hub", district: "Jashore", zone: "Jashore Sadar", address: "Monihar, Jashore", lat: 23.1664, lng: 89.2081, capacity: 1500, kind: "regional" },
  { code: "FEN-CEN", name: "Feni Hub", district: "Feni", zone: "Feni Sadar", address: "Trunk Road, Feni", lat: 23.0159, lng: 91.3976, capacity: 1500, kind: "regional" },
  { code: "NOA-CEN", name: "Noakhali Hub", district: "Noakhali", zone: "Noakhali Sadar", address: "Maijdee, Noakhali", lat: 22.8696, lng: 91.0995, capacity: 1500, kind: "regional" },
  { code: "TNG-CEN", name: "Tangail Hub", district: "Tangail", zone: "Tangail Sadar", address: "New Bus Stand, Tangail", lat: 24.2513, lng: 89.9167, capacity: 1500, kind: "regional" },
  { code: "DNJ-CEN", name: "Dinajpur Hub", district: "Dinajpur", zone: "Dinajpur Sadar", address: "Maldahpatti, Dinajpur", lat: 25.6279, lng: 88.6332, capacity: 1500, kind: "regional" },
  { code: "KUS-CEN", name: "Kushtia Hub", district: "Kushtia", zone: "Kushtia Sadar", address: "NS Road, Kushtia", lat: 23.9013, lng: 89.1205, capacity: 1500, kind: "regional" },
  { code: "BBR-CEN", name: "Brahmanbaria Hub", district: "Brahmanbaria", zone: "Brahmanbaria Sadar", address: "Court Road, Brahmanbaria", lat: 23.9571, lng: 91.1119, capacity: 1500, kind: "regional" },
];

/** Dhaka city zones by delivery hub (every city zone is listed exactly once). */
export const DHAKA_ZONES: Record<string, string[]> = {
  "DHK-GUL": ["Gulshan", "Banani", "Vatara", "Cantonment", "Bhashantek"],
  "DHK-BAD": ["Badda", "Rampura"],
  "DHK-UTT": ["Uttara", "Uttarkhan", "Dakshinkhan", "Turag", "Khilkhet", "Bimanbandar"],
  "DHK-MIR": ["Mirpur", "Pallabi", "Kafrul", "Shah Ali", "Rupnagar", "Darus Salam"],
  "DHK-MOH": ["Mohammadpur", "Adabar", "Sher-e-Bangla Nagar", "Hazaribagh", "Kamrangirchar"],
  "DHK-DHN": ["Dhanmondi", "Kalabagan", "New Market", "Shahbagh", "Tejgaon", "Hatirjheel"],
  "DHK-CSH": ["Tejgaon Industrial Area"],
  "DHK-MOT": ["Motijheel", "Paltan", "Ramna", "Shahjahanpur", "Khilgaon", "Sabujbagh", "Mugda", "Kotwali", "Bangshal", "Sutrapur", "Wari", "Chawkbazar", "Lalbagh"],
  "DHK-JAT": ["Jatrabari", "Demra", "Kadamtali", "Shyampur", "Gendaria"],
};
/** Dhaka district (outside the city) by hub. */
const DHAKA_DISTRICT_ZONES: Record<string, string[]> = {
  "DHK-SAV": ["Savar", "Ashulia", "Dhamrai"],
  "DHK-KER": ["Keraniganj", "Nawabganj (Dhaka)", "Dohar"],
};
const CITY_DISTRICTS = ["Dhaka North", "Dhaka Central", "Dhaka South"];

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const union = (a: string[], b: string[]) => [...a, ...b.filter(x => !a.some(y => same(x, y)))];
/** JSON with object keys sorted (jsonb doesn't keep key order). */
const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v);
const km = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};

export function loadGeo(): GeoData {
  const file = path.resolve(__dirname, "../../prisma/data/bd-geo.json");
  return JSON.parse(fs.readFileSync(file, "utf8")) as GeoData;
}

/** The current catalog with every dataset district, zone and area added (nothing removed or reordered). */
export function mergeCatalog(current: Catalog, geo: GeoData): Catalog {
  const next: Catalog = structuredClone(current);
  next.districts = union(next.districts, geo.districts.map(d => d.name));
  for (const d of geo.districts) {
    const key = next.districts.find(x => same(x, d.name))!;
    next.zonesByDistrict[key] = union(next.zonesByDistrict[key] ?? [], d.zones.map(z => z.name));
    for (const z of d.zones) {
      const zoneKey = Object.keys(next.areasByZone).find(x => same(x, z.name)) ?? z.name;
      const areas = union(next.areasByZone[zoneKey] ?? [], z.areas.map(a => a.name));
      if (areas.length) next.areasByZone[zoneKey] = areas;
    }
  }
  return catalogSchema.parse(next);
}

/** Which hub serves each dataset zone: "district|zone" → hub code. Throws when a zone is left without one. */
export function zoneHubs(geo: GeoData): Map<string, string> {
  const result = new Map<string, string>();
  const put = (district: string, zone: string, hub: string) => {
    if (result.has(`${district}|${zone}`)) throw new Error(`${zone} (${district}) is assigned twice`);
    result.set(`${district}|${zone}`, hub);
  };
  for (const d of geo.districts.filter(x => CITY_DISTRICTS.includes(x.name)))
    for (const z of d.zones) {
      const hub = Object.entries(DHAKA_ZONES).find(([, zones]) => zones.includes(z.name))?.[0];
      if (!hub) throw new Error(`Dhaka city zone ${z.name} has no hub`);
      put(d.name, z.name, hub);
    }
  const dhaka = geo.districts.find(d => d.name === DHAKA_SUBURBAN);
  for (const z of dhaka?.zones ?? []) {
    const hub = Object.entries(DHAKA_DISTRICT_ZONES).find(([, zones]) => zones.includes(z.name))?.[0];
    if (!hub) throw new Error(`Dhaka district zone ${z.name} has no hub`);
    put(DHAKA_SUBURBAN, z.name, hub);
  }
  const regional = HUBS.filter(h => h.kind === "regional" && h.district !== DHAKA_SUBURBAN);
  for (const d of geo.districts.filter(x => !CITY_DISTRICTS.includes(x.name) && x.name !== DHAKA_SUBURBAN)) {
    let hub = regional.find(h => h.district === d.name);
    if (!hub) {
      if (d.lat == null || d.lng == null) throw new Error(`${d.name} has no coordinates`);
      const centre = { lat: d.lat, lng: d.lng };
      // Districts next to Dhaka may also go to the Savar / Keraniganj hubs.
      hub = [...regional, ...HUBS.filter(h => h.district === DHAKA_SUBURBAN)].sort((a, b) => km(centre, a) - km(centre, b))[0];
    }
    for (const z of d.zones) put(d.name, z.name, hub.code);
  }
  return result;
}

/** Stable short codes for delivery zones: <district code>-<zone letters>, ≤ 24 characters. */
function zoneCodes(geo: GeoData) {
  const letters = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const districtCode = new Map<string, string>();
  const taken = new Set<string>();
  for (const d of geo.districts) {
    const w = d.name.toUpperCase().replace(/[^A-Z ]/g, "").split(/\s+/).filter(Boolean);
    const candidates = [w.length > 1 ? `${w[0].slice(0, 2)}${w[1][0]}` : w[0].slice(0, 3), `${w[0].slice(0, 2)}${w[0].at(-1)}`, `${w[0][0]}${w[0].slice(2, 4)}`];
    let code = candidates.find(c => !taken.has(c)) ?? `${w[0].slice(0, 3)}${taken.size}`;
    taken.add(code);
    districtCode.set(d.name, code);
  }
  const codes = new Map<string, string>();
  const used = new Set<string>();
  for (const d of geo.districts)
    for (const z of d.zones) {
      const base = `${districtCode.get(d.name)}-${letters(z.name.replace(/\s*\(.*\)$/, "")).slice(0, 10)}`;
      let code = base;
      for (let i = 2; used.has(code); i++) code = `${base}${i}`;
      used.add(code);
      codes.set(`${d.name}|${z.name}`, code);
    }
  return codes;
}

/** Loads the geography, hubs and delivery zones (see the file comment). Run it in a transaction. */
/** The dataset without the places super admins deleted or renamed away (geography admin tombstones). */
export function withoutDeleted(geo: GeoData, deleted: GeoMeta["deleted"]): GeoData {
  const gone = (list: string[], key: string) => list.some(x => same(x, key));
  return {
    ...geo,
    districts: geo.districts
      .filter(d => !gone(deleted.districts, d.name))
      .map(d => ({
        ...d,
        zones: d.zones.filter(z => !gone(deleted.zones, `${d.name}|${z.name}`)).map(z => ({ ...z, areas: z.areas.filter(a => !gone(deleted.areas, `${z.name}|${a.name}`)) })),
      })),
  };
}

/**
 * Data migration (idempotent): the catalog district "Dhaka" holding the sub-urban upazilas (Savar…)
 * becomes "Dhaka (Sub-urban)", with every record that names it (parcels, addresses, hubs, delivery
 * zones, SLA policies, merchant pickup addresses, import settings, price snapshots) in the caller's
 * transaction, audited as a system change. Returns the reference counts, or null when nothing to do.
 */
export async function renameDhakaSuburban(tx: Prisma.TransactionClient) {
  const setting = await tx.setting.findUnique({ where: { key: "catalog" } });
  if (!setting) return null;
  await lockGeography(tx);
  const catalog = structuredClone(setting.value as unknown as Catalog);
  const old = catalog.districts.find(d => same(d, "Dhaka"));
  const isSuburban = old && (catalog.zonesByDistrict[old] ?? []).some(z => same(z, "Savar") || same(z, "Keraniganj"));
  if (!old || !isSuburban || catalog.districts.some(d => same(d, DHAKA_SUBURBAN))) return null;
  const meta = normalizeMeta((await tx.setting.findUnique({ where: { key: GEO_META_KEY } }))?.value);
  const references = await renameDistrictRecord(tx, catalog, meta, old, DHAKA_SUBURBAN);
  const catalogValue = catalogSchema.parse(catalog) as unknown as Prisma.InputJsonObject;
  const metaValue = meta as unknown as Prisma.InputJsonObject;
  await tx.setting.update({ where: { key: "catalog" }, data: { value: catalogValue } });
  await tx.setting.upsert({ where: { key: GEO_META_KEY }, create: { key: GEO_META_KEY, value: metaValue }, update: { value: metaValue } });
  await tx.auditLog.create({
    data: {
      actorType: "SYSTEM",
      actorLabel: "Geography data migration",
      action: "geo.district.update",
      entityType: "geography",
      entityId: DHAKA_SUBURBAN,
      data: { district: old, renamedTo: DHAKA_SUBURBAN, reason: "Dhaka district outside the city renamed (pricing: Dhaka North/Central/South = Dhaka)", references },
    },
  });
  return references;
}

export async function seedGeo(tx: Prisma.TransactionClient, dataset: GeoData = loadGeo()) {
  await renameDhakaSuburban(tx);
  const deleted = normalizeMeta((await tx.setting.findUnique({ where: { key: GEO_META_KEY } }))?.value).deleted;
  const geo = withoutDeleted(dataset, deleted);
  const assignments = zoneHubs(geo);
  const codes = zoneCodes(geo);
  // 1. Catalog
  const setting = await tx.setting.findUnique({ where: { key: "catalog" } });
  const current = setting ? (setting.value as unknown as Catalog) : DEFAULT_CATALOG;
  const catalog = mergeCatalog({ ...DEFAULT_CATALOG, ...current }, geo);
  const catalogChanged = canonical(catalog) !== canonical(setting?.value ?? null);
  if (catalogChanged) await tx.setting.upsert({ where: { key: "catalog" }, create: { key: "catalog", value: catalog }, update: { value: catalog } });

  // 2. Hubs
  const hubIds = new Map<string, string>();
  let hubsCreated = 0;
  let hubsFilled = 0;
  for (const h of HUBS) {
    const existing = await tx.hub.findUnique({ where: { code: h.code } });
    // A hub deleted in the admin stays deleted.
    if (!existing && deleted.hubs.includes(h.code)) continue;
    const zones = catalog.zonesByDistrict[h.district] ?? [];
    if (!existing && !zones.some(z => same(z, h.zone))) throw new Error(`${h.code}: ${h.zone} is not a zone of ${h.district}`);
    if (!existing) {
      const hub = await tx.hub.create({ data: { code: h.code, name: h.name, district: h.district, zone: h.zone, address: h.address, lat: h.lat, lng: h.lng, capacity: h.capacity, active: true } });
      hubIds.set(h.code, hub.id);
      hubsCreated++;
      continue;
    }
    hubIds.set(h.code, existing.id);
    const fill = {
      ...(existing.zone == null && same(existing.district, h.district) && zones.some(z => same(z, h.zone)) ? { zone: h.zone } : {}),
      ...(existing.lat == null && existing.lng == null ? { lat: h.lat, lng: h.lng } : {}),
      ...(existing.capacity == null ? { capacity: h.capacity } : {}),
    };
    if (Object.keys(fill).length) {
      await tx.hub.update({ where: { id: existing.id }, data: fill });
      hubsFilled++;
    }
  }

  // 3. Delivery zones
  const rows = await tx.deliveryZone.findMany({ select: { id: true, code: true, district: true, name: true, hubId: true } });
  const usedCodes = new Set(rows.map(r => r.code));
  const toCreate = [];
  let zonesLinked = 0;
  for (const [key, hubCode] of assignments) {
    const [district, name] = key.split("|");
    const row = rows.find(r => same(r.district, district) && same(r.name, name));
    const hubId = hubIds.get(hubCode);
    if (!hubId) continue; // its hub was deleted in the admin
    if (row) {
      if (!row.hubId) {
        await tx.deliveryZone.update({ where: { id: row.id }, data: { hubId } });
        zonesLinked++;
      }
      continue;
    }
    let code = codes.get(key)!;
    for (let i = 2; usedCodes.has(code); i++) code = `${codes.get(key)!.slice(0, 21)}-${i}`;
    usedCodes.add(code);
    toCreate.push({ code, name, district, areas: [], hubId, active: true });
  }
  if (toCreate.length) await tx.deliveryZone.createMany({ data: toCreate });

  const result = {
    catalog: {
      changed: catalogChanged,
      districts: catalog.districts.length,
      zones: Object.values(catalog.zonesByDistrict).flat().length,
      areas: Object.values(catalog.areasByZone).flat().length,
    },
    hubs: { created: hubsCreated, filled: hubsFilled, total: hubIds.size },
    deliveryZones: { created: toCreate.length, linked: zonesLinked },
  };
  if (catalogChanged || hubsCreated || hubsFilled || toCreate.length || zonesLinked)
    await tx.auditLog.create({
      data: { actorType: "SYSTEM", actorLabel: "Geography seed", action: "seed.geo_bd", entityType: "setting", entityId: "catalog", data: { ...result, source: geo.source } },
    });
  return result;
}

async function main() {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_GEO_SEED !== "true") {
    console.error("Refusing to change production configuration (set ALLOW_GEO_SEED=true).");
    process.exit(1);
  }
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
  try {
    // `--migrate-only`: just the data migrations (e.g. "Dhaka" → "Dhaka (Sub-urban)"), nothing seeded.
    const summary = process.argv.includes("--migrate-only")
      ? { dhakaSuburban: await prisma.$transaction(tx => renameDhakaSuburban(tx), { timeout: 300_000 }) }
      : await prisma.$transaction(tx => seedGeo(tx), { timeout: 300_000 });
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (typeof require !== "undefined" && require.main === module)
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
