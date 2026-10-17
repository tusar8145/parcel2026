// Builds prisma/data/bd-geo.json (Bangladesh divisions, districts, zones, areas) from the
// nuhil/bangladesh-geocode dataset (MIT) plus the curated city zones in prisma/data/bd-geo-metro.json.
//
//   node scripts/build-geo-bd.mjs <dir with divisions.json districts.json upazilas.json unions.json>
//
// The source files are read strictly as JSON data. Download them into their own empty directory:
//   https://raw.githubusercontent.com/nuhil/bangladesh-geocode/master/{divisions/divisions,districts/districts,upazilas/upazilas,unions/unions}.json
// Then seed with `npm run db:seed:geo` (src/seed/geo-bd.ts).
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const srcDir = process.argv[2];
if (!srcDir) throw new Error("usage: node scripts/build-geo-bd.mjs <source dir>");

const table = file => {
  const rows = JSON.parse(fs.readFileSync(path.join(srcDir, file), "utf8"));
  const t = Array.isArray(rows) ? rows.find(r => r && r.type === "table") : null;
  if (!t || !Array.isArray(t.data)) throw new Error(`${file}: no table data`);
  return t.data;
};
const text = (v, max = 80) => {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  if (!s || s.length > max || /[<>{}]/.test(s)) throw new Error(`Unexpected name: ${JSON.stringify(v)}`);
  return s;
};
const num = v => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 1e6) / 1e6);

// Current official English spellings (2018 renaming) and obvious typos in the source.
const DIVISION_NAMES = { Chattagram: "Chattogram", Barisal: "Barishal" };
const DISTRICT_NAMES = { Comilla: "Cumilla", Coxsbazar: "Cox's Bazar", Barisal: "Barishal", Bogra: "Bogura", Jessore: "Jashore" };
const UPAZILA_NAMES = {
  "Comilla Sadar": "Cumilla Adarsha Sadar",
  Sadarsouth: "Cumilla Sadar Dakshin",
  "Coxsbazar Sadar": "Cox's Bazar Sadar",
  "Bogra Sadar": "Bogura Sadar",
  "Jessore Sadar": "Jashore Sadar",
  "Barisal Sadar": "Barishal Sadar",
  "Borhan Sddin": "Borhanuddin",
  Charfesson: "Char Fasson",
  Senbug: "Senbagh",
  Sonaimori: "Sonaimuri",
  Charrajibpur: "Char Rajibpur",
  Charbhadrasan: "Char Bhadrasan",
  Louhajanj: "Louhajang",
  Kamolganj: "Kamalganj",
  Paikgasa: "Paikgachha",
  Fultola: "Phultala",
  Digholia: "Dighalia",
  Botiaghata: "Batiaghata",
  Syedpur: "Saidpur",
  Birol: "Biral",
  Mohadevpur: "Mahadebpur",
  Moheshkhali: "Maheshkhali",
  Nondigram: "Nandigram",
  Gomostapur: "Gomastapur",
  Mohonpur: "Mohanpur",
  Shibaloy: "Shivalaya",
  Doulatpur: "Daulatpur",
  Doulatkhan: "Daulatkhan",
  Dakshinsurma: "Dakshin Surma",
  Zajira: "Zanjira",
  Nokla: "Nakla",
  Sreebordi: "Sreebardi",
  Mithamoin: "Mithamain",
  Atghoria: "Atgharia",
  Moheshpur: "Maheshpur",
};
const fixUpazila = n => (UPAZILA_NAMES[n] ?? n).replace(/gonj\b/g, "ganj");

const divisions = table("divisions.json");
const districts = table("districts.json");
const upazilas = table("upazilas.json");
const unions = table("unions.json");
const metro = JSON.parse(fs.readFileSync(path.join(root, "prisma", "data", "bd-geo-metro.json"), "utf8"));

const divisionById = new Map(divisions.map(d => [String(d.id), { name: DIVISION_NAMES[d.name] ?? text(d.name), bn: text(d.bn_name) }]));
/** Catalog districts: name → { division, bn, lat, lng, of?, zones: [{ name, bn?, kind, areas: [{ name, bn? }] }] } */
const out = new Map();
const districtById = new Map();
for (const d of districts) {
  const name = DISTRICT_NAMES[d.name] ?? text(d.name);
  const division = divisionById.get(String(d.division_id));
  if (!division) throw new Error(`District ${name}: unknown division`);
  districtById.set(String(d.id), name);
  out.set(name, { name, bn: text(d.bn_name), division: division.name, lat: num(d.lat), lng: num(d.lon), zones: [] });
}
const unionsByUpazila = new Map();
for (const u of unions) {
  const key = String(u.upazilla_id ?? u.upazila_id);
  if (!unionsByUpazila.has(key)) unionsByUpazila.set(key, []);
  unionsByUpazila.get(key).push({ name: text(u.name), bn: text(u.bn_name) });
}
const upazilaZones = new Map(); // district → zones from the dataset
for (const u of upazilas) {
  const district = districtById.get(String(u.district_id));
  if (!district) throw new Error(`Upazila ${u.name}: unknown district`);
  const list = upazilaZones.get(district) ?? [];
  list.push({ name: fixUpazila(text(u.name)), bn: text(u.bn_name), kind: "upazila", areas: unionsByUpazila.get(String(u.id)) ?? [] });
  upazilaZones.set(district, list);
}

// Curated city districts (Dhaka North/Central/South) come first, then the 64 districts.
const ordered = new Map();
for (const m of metro.districts)
  if (!out.has(m.name)) {
    const parent = out.get(m.of);
    if (!parent) throw new Error(`${m.name}: unknown parent district ${m.of}`);
    ordered.set(m.name, { name: m.name, bn: null, division: m.division ?? parent.division, lat: parent.lat, lng: parent.lng, of: m.of, zones: [] });
  }
for (const name of [...out.keys()].sort((a, b) => a.localeCompare(b))) ordered.set(name, out.get(name));
for (const m of metro.districts) {
  const d = ordered.get(m.name);
  for (const [zone, areas] of Object.entries(m.zones)) d.zones.push({ name: text(zone), bn: null, kind: "city", areas: areas.map(a => ({ name: text(a), bn: null })) });
}
for (const [district, zones] of upazilaZones) ordered.get(district).zones.push(...zones.sort((a, b) => a.name.localeCompare(b.name)));
for (const [key, areas] of Object.entries(metro.extraAreas ?? {})) {
  const [district, zone] = key.split("|");
  const z = ordered.get(district)?.zones.find(x => x.name === zone);
  if (!z) throw new Error(`extraAreas: unknown zone ${key}`);
  z.areas.unshift(...areas.map(a => ({ name: text(a), bn: null })));
}

// Zone names must be unique across the country (the catalog lists areas per zone name): a name
// used in several districts gets " (District)", except in the Dhaka city districts.
const dhakaCity = new Set(metro.districts.filter(m => m.of === "Dhaka").map(m => m.name));
const uses = new Map();
for (const d of ordered.values()) for (const z of d.zones) uses.set(z.name.toLowerCase(), [...(uses.get(z.name.toLowerCase()) ?? []), d.name]);
for (const d of ordered.values()) {
  for (const z of d.zones) {
    const where = uses.get(z.name.toLowerCase());
    if (where.length > 1 && !dhakaCity.has(d.name)) z.name = `${z.name} (${d.name})`;
  }
  // Areas: unique per zone (case-insensitive), first spelling wins.
  for (const z of d.zones) {
    const seen = new Set();
    z.areas = z.areas.filter(a => !seen.has(a.name.toLowerCase()) && seen.add(a.name.toLowerCase()));
  }
}
// The Dhaka district outside the city (Savar, Keraniganj, Dhamrai, Dohar, Nawabganj, Ashulia) is
// "Dhaka (Sub-urban)": the city thanas are the districts Dhaka North / Central / South, which pricing
// treats as one district, Dhaka. Renamed after the zone suffixes, so "Nawabganj (Dhaka)" keeps its name.
const SUBURBAN = "Dhaka (Sub-urban)";
if (ordered.has("Dhaka")) ordered.get("Dhaka").name = SUBURBAN;
const allZones = [...ordered.values()].flatMap(d => d.zones.map(z => z.name.toLowerCase()));
if (new Set(allZones).size !== allZones.length) throw new Error("Zone names are not unique");

const result = {
  source: "nuhil/bangladesh-geocode (https://github.com/nuhil/bangladesh-geocode), MIT License, Copyright (c) 2014 Nuhil Mehdy; city zones and neighbourhoods curated in bd-geo-metro.json",
  builtAt: new Date().toISOString().slice(0, 10),
  counts: {
    divisions: divisions.length,
    districts: districts.length,
    catalogDistricts: ordered.size,
    upazilas: upazilas.length,
    cityZones: [...ordered.values()].flatMap(d => d.zones).filter(z => z.kind === "city").length,
    zones: allZones.length,
    unions: unions.length,
    areas: [...ordered.values()].flatMap(d => d.zones.flatMap(z => z.areas)).length,
  },
  divisions: [...divisionById.values()],
  districts: [...ordered.values()],
};
const file = path.join(root, "prisma", "data", "bd-geo.json");
fs.writeFileSync(file, `${JSON.stringify(result)}\n`);
console.log(`Wrote ${path.relative(root, file)}`, result.counts);
