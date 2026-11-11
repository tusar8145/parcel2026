/** Words that don't change what a product is (sizes, colours, packing). */
const NOISE = new Set(["xs", "s", "m", "l", "xl", "xxl", "xxxl", "2xl", "3xl", "free", "size", "pcs", "pc", "piece", "pieces", "set", "pack", "black", "white", "red", "blue", "green", "yellow", "pink", "grey", "gray", "brown", "navy", "new", "original"]);

/**
 * A product's matching key: lower case, "&" = "and", punctuation and spaces dropped, plurals made singular, sizes /
 * colours / quantities left out ("T-Shirts", "t shirt", "Tshirt XL Black" → "tshirt"). Two names with the same key
 * are the same product: the system never creates the second one.
 */
export function productKey(name: string) {
  const words = name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\(.*?\)/g, " ")
    .replace(/\b\d+(\.\d+)?\s*(ml|l|ltr|g|gm|gram|kg|pcs|pc|inch|in|cm|mm)\b/g, " ")
    .split(/[^a-z0-9ঀ-৿]+/)
    .filter(w => w && !NOISE.has(w) && !/^\d+$/.test(w))
    .map(w => (w.length > 4 && w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.length > 4 && /(ches|shes|xes|sses)$/.test(w) ? w.slice(0, -2) : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
  return words.join("");
}

const bigrams = (s: string) => {
  const out = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) out.set(s.slice(i, i + 2), (out.get(s.slice(i, i + 2)) ?? 0) + 1);
  return out;
};

/** How alike two names are (0 … 1): their keys' letter pairs (Dice), or one key inside the other. */
export function nameSimilarity(a: string, b: string) {
  const x = productKey(a);
  const y = productKey(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  // "tshirtmen" contains "tshirt": the shorter one is the product (at least 4 letters).
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  // The longer the listed name inside it, the surer ("tshirt" beats "shirt" in "tshirtmen").
  if (short.length >= 4 && long.includes(short)) return 0.7 + 0.3 * (short.length / long.length);
  const A = bigrams(x);
  const B = bigrams(y);
  let both = 0;
  for (const [g, n] of A) both += Math.min(n, B.get(g) ?? 0);
  const total = Math.max(1, x.length - 1 + (y.length - 1));
  return (2 * both) / total;
}

/** Close enough to be the same product without asking anyone. */
export const SIMILAR_ENOUGH = 0.72;

/** The listed product a name means: the same name, the same key, else the most similar one (when similar enough). */
export function matchProduct<T extends { name: string }>(name: string, products: readonly T[]): { product: T; score: number } | null {
  const plain = name.trim().toLowerCase();
  const exact = products.find(p => p.name.toLowerCase() === plain);
  if (exact) return { product: exact, score: 1 };
  const key = productKey(name);
  const same = key ? products.find(p => productKey(p.name) === key) : undefined;
  if (same) return { product: same, score: 1 };
  let best: { product: T; score: number } | null = null;
  for (const p of products) {
    const score = nameSimilarity(name, p.name);
    if (!best || score > best.score) best = { product: p, score };
  }
  return best && best.score >= SIMILAR_ENOUGH ? best : null;
}
