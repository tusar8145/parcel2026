import type { Db } from "../../common/prisma.service";
import type { Catalog } from "../pricing/pricing.service";
import { norm, same } from "./geo-catalog";

/**
 * Where a district, zone or area is referenced. Places are stored by name (the catalog spelling)
 * on every record, so usage is counted per column, case-insensitively.
 */
export type GeoLevel = "district" | "zone" | "area";
export interface UsageItem {
  key: string;
  label: string;
  count: number;
}
export interface Usage {
  total: number;
  items: UsageItem[];
}

interface Source {
  key: string;
  label: string;
  table: string;
  district: string | null;
  zone: string | null;
  /** Column holding the area, or "areas[]" for a text[] column. */
  area: string | null;
  /** The area is matched within the district only (merchant pickup areas are free text). */
  areaInDistrict?: boolean;
  /** Merchants: the free-text pickup area naming a zone counts as using it. */
  zoneIsText?: boolean;
  /** Not counted per district (another source already counts the same rows' district). */
  noDistrictLevel?: boolean;
}

const SOURCES: Source[] = [
  { key: "parcels.pickup", label: "Parcels (pickup address)", table: "parcels", district: "pickupDistrict", zone: "pickupZone", area: "pickupArea" },
  { key: "parcels.delivery", label: "Parcels (delivery address)", table: "parcels", district: "deliveryDistrict", zone: "deliveryZone", area: "deliveryArea" },
  { key: "addresses", label: "Saved addresses (address books)", table: "addresses", district: "district", zone: "zone", area: "area" },
  { key: "merchants", label: "Merchant pickup addresses", table: "merchants", district: "pickupDistrict", zone: "pickupArea", area: "pickupArea", areaInDistrict: true, zoneIsText: true },
  { key: "merchants.pickup_zone", label: "Merchant pickup addresses (structured zone)", table: "merchants", district: "pickupDistrict", zone: "pickupZone", area: null, noDistrictLevel: true },
  { key: "merchants.business", label: "Merchant business addresses", table: "merchants", district: "businessDistrict", zone: "businessZone", area: "businessArea" },
  { key: "pickup_schedules", label: "Merchant pickup schedules", table: "pickup_schedules", district: "district", zone: "zone", area: "area" },
  { key: "pickup_requests", label: "Pickup requests", table: "pickup_requests", district: "district", zone: "zone", area: "area" },
  { key: "hubs", label: "Hubs", table: "hubs", district: "district", zone: "zone", area: null },
  { key: "riders", label: "Riders (service zone)", table: "riders", district: null, zone: "zone", area: null },
  { key: "delivery_zones", label: "Delivery zones (hub serving)", table: "delivery_zones", district: "district", zone: "name", area: "areas[]" },
  { key: "sla.origin", label: "SLA policies (origin)", table: "sla_policies", district: "originDistrict", zone: "originZone", area: null },
  { key: "sla.destination", label: "SLA policies (destination)", table: "sla_policies", district: "destDistrict", zone: "destZone", area: null },
];

const col = (c: string) => `lower("${c}")`;

/** One grouped count per source: key = lower(name of the child) → count. */
async function grouped(db: Db, source: Source, level: GeoLevel, parent: { district?: string; zone?: string }): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  let sql: string | null = null;
  let params: string[] = [];
  const t = `"${source.table}"`;
  if (level === "district" && source.noDistrictLevel) return out;
  if (level === "district") {
    // Riders name a zone only: grouped by zone and mapped to districts by the caller.
    sql = source.district ? `SELECT ${col(source.district)} AS k, count(*)::int AS n FROM ${t} WHERE "${source.district}" IS NOT NULL GROUP BY 1` : `SELECT ${col(source.zone!)} AS k, count(*)::int AS n FROM ${t} WHERE "${source.zone}" IS NOT NULL GROUP BY 1`;
  } else if (level === "zone") {
    if (!source.zone) return out;
    sql = source.district
      ? `SELECT ${col(source.zone)} AS k, count(*)::int AS n FROM ${t} WHERE ${col(source.district)} = lower($1) GROUP BY 1`
      : `SELECT ${col(source.zone)} AS k, count(*)::int AS n FROM ${t} WHERE "${source.zone}" IS NOT NULL GROUP BY 1`;
    if (source.district) params = [parent.district!];
  } else {
    if (!source.area || !source.district) return out;
    if (source.area === "areas[]")
      sql = `SELECT lower(a) AS k, count(*)::int AS n FROM ${t}, unnest("areas") AS a WHERE ${col(source.district)} = lower($1) AND ${col(source.zone!)} = lower($2) GROUP BY 1`;
    else if (source.areaInDistrict) sql = `SELECT ${col(source.area)} AS k, count(*)::int AS n FROM ${t} WHERE ${col(source.district)} = lower($1) GROUP BY 1`;
    else sql = `SELECT ${col(source.area)} AS k, count(*)::int AS n FROM ${t} WHERE ${col(source.district)} = lower($1) AND ${col(source.zone!)} = lower($2) AND "${source.area}" IS NOT NULL GROUP BY 1`;
    params = source.areaInDistrict ? [parent.district!] : [parent.district!, parent.zone!];
  }
  const rows = await db.$queryRawUnsafe<{ k: string | null; n: number }[]>(sql, ...params);
  for (const r of rows) if (r.k != null) out.set(norm(r.k), (out.get(norm(r.k)) ?? 0) + Number(r.n));
  return out;
}

/** The import settings' fixed default destination, if any. */
async function importDestination(db: Db): Promise<{ district: string; zone: string } | null> {
  const row = await db.setting.findUnique({ where: { key: "import-config" } });
  const dest = (row?.value as { defaultDestination?: { mode?: string; district?: string; zone?: string } } | null)?.defaultDestination;
  return dest?.mode === "FIXED" && dest.district && dest.zone ? { district: dest.district, zone: dest.zone } : null;
}

/**
 * Usage of every child of `parent`: the districts (no parent), the zones of a district or the
 * areas of a zone. Keyed by the lower-cased name. `catalog` is the full catalog (inactive places
 * included), used to map riders' zones to districts.
 */
export async function childUsage(db: Db, catalog: Catalog, level: GeoLevel, parent: { district?: string; zone?: string } = {}): Promise<Map<string, Usage>> {
  const result = new Map<string, Usage>();
  const add = (name: string, item: Omit<UsageItem, "count">, count: number) => {
    if (!count) return;
    const k = norm(name);
    const u = result.get(k) ?? { total: 0, items: [] };
    const existing = u.items.find(i => i.key === item.key);
    if (existing) existing.count += count;
    else u.items.push({ key: item.key, label: item.label, count });
    u.total += count;
    result.set(k, u);
  };
  const districtOfZone = new Map<string, string>();
  if (level === "district") for (const [d, zones] of Object.entries(catalog.zonesByDistrict)) for (const z of zones) districtOfZone.set(norm(z), d);
  const districtZones = level === "zone" ? new Set((Object.entries(catalog.zonesByDistrict).find(([d]) => same(d, parent.district))?.[1] ?? []).map(norm)) : null;

  const counts = await Promise.all(SOURCES.map(s => grouped(db, s, level, parent)));
  SOURCES.forEach((s, i) => {
    for (const [k, n] of counts[i]) {
      if (level === "district" && !s.district) {
        const d = districtOfZone.get(k);
        if (d) add(d, s, n);
      } else if (level === "zone" && (!s.district || s.zoneIsText)) {
        // Riders (zone only) and merchants (free-text area) count for the district's zones only.
        if (districtZones?.has(k)) add(k, s, n);
      } else add(k, s, n);
    }
  });

  const dest = await importDestination(db);
  const destItem = { key: "import_config", label: "Spreadsheet import default destination" };
  if (dest) {
    if (level === "district") add(dest.district, destItem, 1);
    if (level === "zone" && same(dest.district, parent.district)) add(dest.zone, destItem, 1);
  }
  return result;
}

/** Usage of one place (its own and every child's references). */
export async function placeUsage(db: Db, catalog: Catalog, target: { district: string; zone?: string; area?: string }): Promise<Usage> {
  const level: GeoLevel = target.area != null ? "area" : target.zone != null ? "zone" : "district";
  const name = target.area ?? target.zone ?? target.district;
  const all = await childUsage(db, catalog, level, { district: target.district, zone: target.zone });
  return all.get(norm(name)) ?? { total: 0, items: [] };
}

/** "12 parcels (delivery address), 1 hub" for error messages. */
export const describeUsage = (usage: Usage) => usage.items.map(i => `${i.label}: ${i.count.toLocaleString("en-US")}`).join("; ");

// ── hubs ──

const HUB_LABELS: Record<string, string> = {
  "parcels.currentHubId": "Parcels at or bound for this hub",
  "parcels.dropOffHubId": "Hub drop-off parcels",
  "riders.hubId": "Riders",
  "user_roles.hubId": "Staff assigned (hub operators)",
  "delivery_zones.hubId": "Delivery zones it serves",
  "delivery_routes.hubId": "Operating routes",
  "cash_handovers.hubId": "COD cash handovers",
  "cash_handover_requests.hubId": "Cash handover requests",
  "linehaul_trips.originHubId": "Linehaul trips (origin)",
  "linehaul_trips.destHubId": "Linehaul trips (destination)",
  "linehaul_bags.originHubId": "Linehaul bags (origin)",
  "linehaul_bags.destHubId": "Linehaul bags (destination)",
  "cn_batches.hubId": "CN stock batches",
  "booking_batches.hubId": "Booking batches",
  "scan_events.hubId": "Scan events",
};
const humanize = (table: string, column: string) => `${table.replace(/_/g, " ").replace(/^./, c => c.toUpperCase())} (${column.replace(/Id$/, "").replace(/([A-Z])/g, " $1").toLowerCase()})`;

/**
 * Every row that references a hub: all foreign keys to `hubs` plus uuid columns named *hubId /
 * *HubId without one (ledger lines, scans, …) and uuid[] columns named *hubIds. New tables are
 * covered automatically.
 */
export async function hubUsage(db: Db, hubId: string): Promise<Usage> {
  const columns = await db.$queryRawUnsafe<{ tbl: string; col: string; arr: boolean }[]>(`
    SELECT DISTINCT tbl, col, arr FROM (
      SELECT cl.relname AS tbl, a.attname AS col, false AS arr
        FROM pg_constraint c
        JOIN pg_class cl ON cl.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = current_schema()
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
       WHERE c.contype = 'f' AND c.confrelid = 'hubs'::regclass
      UNION
      SELECT table_name, column_name, data_type = 'ARRAY'
        FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name <> 'hubs'
         AND ((data_type = 'uuid' AND column_name ~* 'hubid$') OR (data_type = 'ARRAY' AND udt_name = '_uuid' AND column_name ~* 'hubids$'))
    ) x ORDER BY 1, 2`);
  const items: UsageItem[] = [];
  for (const c of columns) {
    const where = c.arr ? `$1::uuid = ANY ("${c.col}")` : `"${c.col}" = $1::uuid`;
    const [row] = await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${c.tbl}" WHERE ${where}`, hubId);
    if (row?.n) items.push({ key: `${c.tbl}.${c.col}`, label: HUB_LABELS[`${c.tbl}.${c.col}`] ?? humanize(c.tbl, c.col), count: Number(row.n) });
  }
  return { total: items.reduce((s, i) => s + i.count, 0), items };
}
