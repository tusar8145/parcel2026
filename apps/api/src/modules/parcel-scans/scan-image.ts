import sharp from "sharp";

/** A photo turned upright by its EXIF orientation (phones store sideways pixels plus a flag). */
export const upright = (image: Buffer) => sharp(image, { failOn: "none" }).rotate().toBuffer();

/**
 * The image as tesseract reads it best: rotated by `angle` degrees (clockwise), grey, scaled so its
 * long side is `size` px (small labels are enlarged: OCR needs ~30 px letters), contrast stretched and
 * sharpened.
 */
export async function prepare(image: Buffer, { angle = 0, size = 2000 }: { angle?: number; size?: number } = {}) {
  const rotated = angle ? await sharp(image, { failOn: "none" }).rotate(angle, { background: "#ffffff" }).toBuffer() : image;
  const meta = await sharp(rotated, { failOn: "none" }).metadata();
  const landscape = (meta.width ?? 0) >= (meta.height ?? 0);
  return sharp(rotated, { failOn: "none" })
    .greyscale()
    .resize(landscape ? { width: size } : { height: size })
    .normalise()
    .sharpen()
    .png()
    .toBuffer();
}

export interface OcrWord {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}
export interface OcrLine {
  text: string;
  words: OcrWord[];
  baseline: { x0: number; y0: number; x1: number; y1: number };
}

/** The text's tilt in degrees (positive: lines run down to the right), from the long lines' baselines; 0 when unclear. */
export function skewOf(lines: OcrLine[]): number {
  const angles = lines
    .filter(l => l.baseline && l.baseline.x1 - l.baseline.x0 > 120 && l.words.length >= 2)
    .map(l => (Math.atan2(l.baseline.y1 - l.baseline.y0, l.baseline.x1 - l.baseline.x0) * 180) / Math.PI)
    .filter(a => Math.abs(a) < 25)
    .sort((a, b) => a - b);
  if (angles.length < 2) return 0;
  const median = angles[Math.floor(angles.length / 2)];
  return Math.abs(median) < 0.8 ? 0 : median;
}

/**
 * The text with side-by-side blocks (sender | receiver stickers) read one after the other: rows that
 * split at the same wide gap are emitted as the left block's lines, then the right block's lines.
 * Other rows stay as they are, in order.
 */
export function layoutText(lines: OcrLine[]): string {
  const rows = lines.map(l => l.words.filter(w => w.text.trim())).filter(ws => ws.length);
  const heights = rows.flatMap(ws => ws.map(w => w.bbox.y1 - w.bbox.y0)).sort((a, b) => a - b);
  const h = heights[Math.floor(heights.length / 2)] || 20;
  const right = Math.max(...rows.flatMap(ws => ws.map(w => w.bbox.x1)), 1);
  const minGap = Math.max(3.5 * h, right * 0.08);
  // Each row's wide gaps (x ranges between two words).
  const gaps = rows.map(ws => ws.slice(1).flatMap((w, i) => (w.bbox.x0 - ws[i].bbox.x1 >= minGap ? [{ from: ws[i].bbox.x1, to: w.bbox.x0 }] : [])));
  // The x most rows split at.
  let split: number | null = null;
  let best = 1;
  for (const g of gaps.flat()) {
    const x = (g.from + g.to) / 2;
    const count = gaps.filter(row => row.some(o => o.from <= x && o.to >= x)).length;
    if (count > best) {
      best = count;
      split = x;
    }
  }
  const join = (ws: OcrWord[]) => ws.map(w => w.text).join(" ");
  if (split === null) return rows.map(join).join("\n");
  const out: string[] = [];
  let left: string[] = [];
  let rightCol: string[] = [];
  const flush = () => {
    out.push(...left, ...rightCol);
    left = [];
    rightCol = [];
  };
  rows.forEach((ws, i) => {
    const splits = gaps[i].some(g => g.from <= split! && g.to >= split!);
    const allLeft = ws.every(w => w.bbox.x1 < split!);
    const allRight = ws.every(w => w.bbox.x0 > split!);
    if (splits) {
      left.push(join(ws.filter(w => w.bbox.x1 < split!)));
      rightCol.push(join(ws.filter(w => w.bbox.x0 > split!)));
    } else if ((left.length || rightCol.length) && (allLeft || allRight)) {
      // A row with text on one side only, inside the two-block part.
      (allLeft ? left : rightCol).push(join(ws));
    } else {
      flush();
      out.push(join(ws));
    }
  });
  flush();
  return out.join("\n");
}
