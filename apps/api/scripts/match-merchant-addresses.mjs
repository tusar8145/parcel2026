// Best-effort match of older merchants' free-text pickup addresses to the service catalog.
//
//   node scripts/match-merchant-addresses.mjs            dry run: lists what would change
//   node scripts/match-merchant-addresses.mjs --apply    writes the matches
//
// Reads DATABASE_URL (apps/api/.env is loaded when present). Only merchants WITHOUT a structured
// pickup zone are looked at, and only an unambiguous match is written: the district must be a catalog
// district and the free-text area must name exactly one zone of it, or be an area of exactly one zone
// (never "the district's first zone"). It fills pickupZone (plus the catalog spelling of the district
// and area) and the derived serving hub (pickupHubId). The street and every other column stay as they
// are, nothing is deleted, and running it again changes nothing (idempotent). Each written merchant
// gets an audit-log row (action merchant.address_matched, actor SYSTEM). Merchants it can't match keep
// their text; Settings asks them to complete the structured address.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";

const envFile = path.resolve(import.meta.dirname, "../.env");
if (!process.env.DATABASE_URL && fs.existsSync(envFile))
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"]*)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
const url = process.env.DATABASE_URL;
if (!url) throw new Error("Set DATABASE_URL");
const apply = process.argv.includes("--apply");

/** UUIDv7 (time-ordered, like the API's ids, so audit lists stay in order). */
function uuidv7() {
  const b = randomBytes(16);
  const ts = BigInt(Date.now());
  for (let i = 0; i < 6; i++) b[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const norm = v => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const bare = v => norm(v).replace(/\s*\([^)]*\)$/, "");

/** Same rules as matchLegacyPickup (src/modules/merchants/merchant-address.ts). */
function match(catalog, m) {
  const district = catalog.districts.find(d => norm(d) === norm(m.pickupDistrict));
  if (!district) return null;
  const zones = catalog.zonesByDistrict[district] ?? [];
  const text = norm(m.pickupArea);
  if (!text) return null;
  const byName = zones.filter(z => norm(z) === text || bare(z) === text);
  if (byName.length === 1) return { district, zone: byName[0], area: byName[0] };
  const byArea = zones.filter(z => (catalog.areasByZone[z] ?? []).some(a => norm(a) === text));
  if (byArea.length === 1) return { district, zone: byArea[0], area: catalog.areasByZone[byArea[0]].find(a => norm(a) === text) };
  return null;
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const setting = await client.query(`SELECT value FROM settings WHERE key = 'catalog'`);
  const catalog = setting.rows[0]?.value;
  if (!catalog?.districts) throw new Error("No catalog setting found");
  const { rows } = await client.query(`SELECT id, code, name, "pickupDistrict", "pickupArea" FROM merchants WHERE "pickupZone" IS NULL ORDER BY code`);
  let matched = 0;
  for (const m of rows) {
    const hit = match(catalog, m);
    if (!hit) {
      console.log(`  ${m.code} ${m.name}: "${m.pickupArea}, ${m.pickupDistrict}" — no unambiguous match (left as is)`);
      continue;
    }
    matched++;
    const hub = await client.query(
      `SELECT dz."hubId" FROM delivery_zones dz JOIN hubs h ON h.id = dz."hubId" AND h.active
        WHERE dz.active AND lower(dz.district) = lower($1) AND lower(dz.name) = lower($2)
        ORDER BY (lower($3) = ANY (SELECT lower(a) FROM unnest(dz.areas) a)) DESC, (cardinality(dz.areas) = 0) DESC, dz.code LIMIT 1`,
      [hit.district, hit.zone, hit.area],
    );
    const hubId = hub.rows[0]?.hubId ?? null;
    console.log(`${apply ? "✔" : "→"} ${m.code} ${m.name}: ${hit.district} › ${hit.zone}${hit.area !== hit.zone ? ` › ${hit.area}` : ""}${hubId ? " (hub found)" : " (no serving hub)"}`);
    if (!apply) continue;
    await client.query("BEGIN");
    const res = await client.query(
      `UPDATE merchants SET "pickupDistrict" = $2, "pickupZone" = $3, "pickupArea" = $4, "pickupHubId" = $5, "updatedAt" = now() WHERE id = $1 AND "pickupZone" IS NULL`,
      [m.id, hit.district, hit.zone, hit.area, hubId],
    );
    if (res.rowCount)
      await client.query(
        `INSERT INTO audit_logs (id, "actorType", "actorLabel", action, "entityType", "entityId", data, "createdAt") VALUES ($1, 'SYSTEM', 'Address matching script', 'merchant.address_matched', 'merchant', $2, $3, now())`,
        [uuidv7(), m.id, JSON.stringify({ from: { district: m.pickupDistrict, area: m.pickupArea }, to: { ...hit, pickupHubId: hubId }, script: "match-merchant-addresses" })],
      );
    await client.query("COMMIT");
  }
  console.log(`${rows.length} merchant(s) without a structured pickup zone; ${matched} matched${apply ? " and updated" : " (dry run — add --apply to write)"}.`);
} finally {
  await client.end();
}
