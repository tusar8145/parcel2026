import fs from "node:fs";
import path from "node:path";
import type { Catalog } from "../pricing/pricing.service";

type Places = Pick<Catalog, "districts" | "zonesByDistrict" | "areasByZone">;
interface Entry {
  name: string;
  kind: "district" | "zone" | "area";
  tokens: string[];
  /** zone → its district; area → its zone. */
  parent?: string;
}
export interface Place {
  district?: string;
  zone?: string;
  area?: string;
}

/** Dhaka city zones and common places written in Bangla (the geography file has no Bangla for the city zones). */
const CITY_BN: Record<string, string> = {
  ধানমন্ডি: "Dhanmondi",
  ধানমণ্ডি: "Dhanmondi",
  মিরপুর: "Mirpur",
  পল্লবী: "Pallabi",
  কাফরুল: "Kafrul",
  "শাহ আলী": "Shah Ali",
  রূপনগর: "Rupnagar",
  "দারুস সালাম": "Darus Salam",
  মোহাম্মদপুর: "Mohammadpur",
  আদাবর: "Adabar",
  "শেরেবাংলা নগর": "Sher-e-Bangla Nagar",
  গুলশান: "Gulshan",
  বনানী: "Banani",
  উত্তরা: "Uttara",
  বাড্ডা: "Badda",
  ভাটারা: "Vatara",
  রামপুরা: "Rampura",
  উত্তরখান: "Uttarkhan",
  দক্ষিণখান: "Dakshinkhan",
  তুরাগ: "Turag",
  খিলক্ষেত: "Khilkhet",
  বিমানবন্দর: "Bimanbandar",
  ক্যান্টনমেন্ট: "Cantonment",
  ভাষানটেক: "Bhashantek",
  তেজগাঁও: "Tejgaon",
  মতিঝিল: "Motijheel",
  যাত্রাবাড়ী: "Jatrabari",
  যাত্রাবাড়ি: "Jatrabari",
  খিলগাঁও: "Khilgaon",
  সবুজবাগ: "Sabujbagh",
  লালবাগ: "Lalbagh",
  কোতোয়ালী: "Kotwali",
  ওয়ারী: "Wari",
  শ্যামপুর: "Shyampur",
  ডেমরা: "Demra",
  কদমতলী: "Kadamtali",
  পল্টন: "Paltan",
  রমনা: "Ramna",
  শাহবাগ: "Shahbagh",
  নিউমার্কেট: "New Market",
  হাজারীবাগ: "Hazaribagh",
  কলাবাগান: "Kalabagan",
  বংশাল: "Bangshal",
  চকবাজার: "Chawkbazar",
  সূত্রাপুর: "Sutrapur",
  গেন্ডারিয়া: "Gendaria",
  বসুন্ধরা: "Bashundhara",
  মালিবাগ: "Malibagh",
  মগবাজার: "Moghbazar",
  ফার্মগেট: "Farmgate",
  শ্যামলী: "Shyamoli",
  মহাখালী: "Mohakhali",
  ঢাকা: "Dhaka",
  চট্টগ্রাম: "Chattogram",
};

/** Words too common on addresses to be matched loosely (a place named exactly so still matches exactly). */
const GENERIC = new Set(["house", "road", "block", "sector", "flat", "floor", "lane", "para", "bazar", "market", "village", "union", "ward", "word", "colony", "nagar", "town", "city", "station", "school", "college", "mosque", "office", "bank", "north", "south", "east", "west", "middle", "sadar", "dhaka"]);

export const normPlace = (s: string) =>
  s
    .toLowerCase()
    .replace(/[-_.,;:()/\\|'"’`]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function distance(a: string, b: string, max: number) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Bangla place names of the geography data file (prisma/data/bd-geo.json) → English names. */
let bnNames: [string, string][] | null = null;
function bangla(): [string, string][] {
  if (bnNames) return bnNames;
  const map = new Map<string, string>(Object.entries(CITY_BN).map(([bn, en]) => [bn.normalize("NFC"), en]));
  for (const file of [path.resolve(process.cwd(), "prisma/data/bd-geo.json"), path.resolve(__dirname, "../../../prisma/data/bd-geo.json")]) {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8")) as { districts: { name: string; bn: string | null; zones: { name: string; bn: string | null; areas: { name: string; bn: string | null }[] }[] }[] };
      for (const d of data.districts) {
        if (d.bn && !map.has(d.bn.normalize("NFC"))) map.set(d.bn.normalize("NFC"), d.name);
        for (const z of d.zones) {
          if (z.bn && !map.has(z.bn.normalize("NFC"))) map.set(z.bn.normalize("NFC"), z.name);
          for (const a of z.areas) if (a.bn && !map.has(a.bn.normalize("NFC"))) map.set(a.bn.normalize("NFC"), a.name);
        }
      }
      break;
    } catch {
      // Not deployed next to the API: the city names above still work.
    }
  }
  // Longest first, so "শাহ আলী" wins over a shorter name inside it.
  bnNames = [...map].sort((a, b) => b[0].length - a[0].length);
  return bnNames;
}

/**
 * Bangla place names in the text written in English (as the catalog has them): whole words only (the
 * name "রুমানা" is not the upazila "রুমা"), after Unicode normalisation (য় is stored two ways).
 */
export function englishPlaces(text: string) {
  if (!/[ঀ-৿]/.test(text)) return text;
  let out = text.normalize("NFC");
  for (const [bn, en] of bangla()) {
    if (!out.includes(bn)) continue;
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{M}])${bn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{M}])`, "gu"), ` ${en} `);
  }
  return out;
}

const indexes = new WeakMap<object, Entry[]>();
function indexOf(places: Places): Entry[] {
  const cached = indexes.get(places);
  if (cached) return cached;
  const entries: Entry[] = [];
  const add = (name: string, kind: Entry["kind"], parent?: string) => entries.push({ name, kind, parent, tokens: normPlace(name).split(" ").filter(Boolean) });
  for (const d of places.districts) add(d, "district");
  for (const [d, zones] of Object.entries(places.zonesByDistrict)) for (const z of zones) add(z, "zone", d);
  for (const [z, areas] of Object.entries(places.areasByZone)) for (const a of areas) add(a, "area", z);
  indexes.set(places, entries);
  return entries;
}

interface Hit {
  entry: Entry;
  /** 0 exact, 1–2 letters different. */
  cost: number;
  /** Position in the text (later = nearer the end of the address, where the district usually is). */
  at: number;
}

/** Catalog places written in the text, exactly or with an OCR slip of a letter or two in longer names. */
function hits(text: string, places: Places): Hit[] {
  const tokens = normPlace(englishPlaces(text)).split(" ").filter(Boolean);
  const out: Hit[] = [];
  for (const entry of indexOf(places)) {
    const n = entry.tokens.length;
    if (!n || n > tokens.length) continue;
    const name = entry.tokens.join(" ");
    const loose = name.length >= 5 && !(n === 1 && GENERIC.has(name));
    const max = name.length >= 8 ? 2 : 1;
    for (let i = 0; i + n <= tokens.length; i++) {
      const window = tokens.slice(i, i + n).join(" ");
      if (window === name) {
        out.push({ entry, cost: 0, at: i });
        break;
      }
      if (loose && window[0] === name[0]) {
        const cost = distance(window, name, max);
        if (cost <= max) {
          out.push({ entry, cost, at: i });
          break;
        }
      }
    }
  }
  return out;
}

const better = (a: Hit, b: Hit) => a.cost - b.cost || b.entry.tokens.join(" ").length - a.entry.tokens.join(" ").length || b.at - a.at;

/**
 * District, zone and area of the catalog named in `text` (English or Bangla; OCR slips of a letter or
 * two in longer names are forgiven). A zone or area found without its district brings its district
 * (zone names are unique); a district named on its own is kept only when no zone is found.
 */
export function placeIn(text: string, places: Places): Place {
  if (!text.trim()) return {};
  const found = hits(text, places);
  const districts = found.filter(h => h.entry.kind === "district").sort(better);
  const districtSet = new Set(districts.map(h => h.entry.name));
  const dhaka = /\bdhaka\b/i.test(englishPlaces(text));
  const fits = (district?: string) => !!district && (districtSet.has(district) || (dhaka && district.startsWith("Dhaka")));
  // Zones: exact before fuzzy, then ones whose district is also named.
  const zones = found
    .filter(h => h.entry.kind === "zone")
    .sort((a, b) => Number(fits(b.entry.parent)) - Number(fits(a.entry.parent)) || better(a, b));
  let zone = zones[0];
  // An area named on its own (e.g. "Mirpur 10") gives its zone.
  const areas = found.filter(h => h.entry.kind === "area").sort(better);
  if (!zone) {
    const area = areas.find(h => h.cost === 0) ?? areas[0];
    const owner = area && found.length && zones.length === 0 ? indexOf(places).find(e => e.kind === "zone" && e.name === area.entry.parent) : undefined;
    if (owner) zone = { entry: owner, cost: area.cost, at: area.at };
  }
  if (zone) {
    const district = zone.entry.parent;
    const area = areas.filter(h => h.entry.parent === zone!.entry.name).sort(better)[0];
    return { district, zone: zone.entry.name, ...(area ? { area: area.entry.name } : {}) };
  }
  return districts[0] ? { district: districts[0].entry.name } : {};
}
