import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import { code128Widths } from "./code128";

/**
 * A thin layer over pdfkit for the documents module: embedded Unicode fonts with Bangla support,
 * mixed-script text with wrapping, Code 128 barcodes, QR codes and simple drawing helpers.
 *
 * Bangla: Noto Sans has no Bengali glyphs and Noto Sans Bengali has no Latin letters, so text is
 * split into runs (Bengali block U+0980–U+09FF, ZWJ/ZWNJ → Bengali font; everything else → Noto
 * Sans) and each run is drawn with its font. fontkit shapes Bengali runs (conjuncts, reph,
 * pre-base vowel signs) through the font's OpenType tables.
 */

const FONT_FILES = {
  latin: "NotoSans-Regular.ttf",
  latinBold: "NotoSans-Bold.ttf",
  beng: "NotoSansBengali-Regular.ttf",
  bengBold: "NotoSansBengali-Bold.ttf",
} as const;
type FontKey = keyof typeof FONT_FILES;

let fontCache: Record<FontKey, Buffer> | null = null;

/** assets/fonts next to the API package: found from src/ (tests, dev) and dist/ (build) alike. */
function fontsDir(): string {
  if (process.env.DOCUMENT_FONTS_DIR) return process.env.DOCUMENT_FONTS_DIR;
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "assets", "fonts");
    if (existsSync(join(candidate, FONT_FILES.latin))) return candidate;
    dir = dirname(dir);
  }
  return join(process.cwd(), "assets", "fonts");
}

export function loadFonts(): Record<FontKey, Buffer> {
  if (fontCache) return fontCache;
  const dir = fontsDir();
  fontCache = Object.fromEntries(Object.entries(FONT_FILES).map(([key, file]) => [key, readFileSync(join(dir, file))])) as Record<FontKey, Buffer>;
  return fontCache;
}

export const MM = 72 / 25.4;
export const A4: [number, number] = [595.28, 841.89];

export const COLOR = {
  ink: "#182230",
  muted: "#5f6b7a",
  faint: "#8a94a3",
  line: "#d5dbe3",
  soft: "#f3f5f8",
  brand: "#d69e00",
  dark: "#111827",
  danger: "#b42318",
  ok: "#067647",
};

export interface TextOpts {
  size?: number;
  bold?: boolean;
  color?: string;
  /** Wrap within this width (no width: one line, no wrapping). */
  width?: number;
  align?: "left" | "center" | "right";
  /** Cut after this many lines with "…". */
  maxLines?: number;
  /** Line height as a multiple of the font size. */
  leading?: number;
}

interface Run {
  text: string;
  beng: boolean;
}
interface Line {
  runs: Run[];
  width: number;
}

const isBengali = (cp: number) => (cp >= 0x0980 && cp <= 0x09ff) || cp === 0x200c || cp === 0x200d || cp === 0x0964 || cp === 0x0965;
const NEUTRAL = new Set([" ", " "]);

/** Removes control characters; keeps everything printable. */
export const clean = (value: unknown): string =>
  value == null
    ? ""
    : String(value)
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f￾￿]/g, "")
        .replace(/\s*\n\s*/g, " ")
        // Symbols the bundled fonts don't have.
        .replace(/[→⟶]/g, "->")
        .replace(/[←]/g, "<-")
        .replace(/[✓✔]/g, "OK")
        .trim();

/** Splits text into Bengali / non-Bengali runs; spaces stay with the run before them. */
export function scriptRuns(text: string): Run[] {
  const runs: Run[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const last = runs[runs.length - 1];
    const beng = NEUTRAL.has(ch) ? (last?.beng ?? false) : isBengali(cp);
    if (last && last.beng === beng) last.text += ch;
    else runs.push({ text: ch, beng });
  }
  return runs;
}

export interface PdfOptions {
  size: [number, number];
  title: string;
  subject?: string;
  author?: string;
  /** Keep pages in memory to write "Page x of y" at the end (tables, invoices). */
  bufferPages?: boolean;
}

export class PdfWriter {
  readonly doc: PDFDocument;
  width: number;
  height: number;
  private current = "";
  private currentSize = 0;

  constructor(opts: PdfOptions) {
    this.doc = new PDFDocument({
      size: opts.size,
      margin: 0,
      bufferPages: !!opts.bufferPages,
      autoFirstPage: false,
      lang: "en-BD",
      displayTitle: true,
      info: { Title: opts.title, Subject: opts.subject ?? opts.title, Author: opts.author ?? "Delivery Fast", Creator: "Delivery Fast", Producer: "Delivery Fast documents" },
    });
    const fonts = loadFonts();
    for (const [key, buf] of Object.entries(fonts)) this.doc.registerFont(key, buf);
    [this.width, this.height] = opts.size;
  }

  /** Starts a page (optionally of another size, e.g. a POS receipt sized to its content). */
  addPage(size?: [number, number]) {
    if (size) {
      this.doc.addPage({ size, margin: 0 });
      [this.width, this.height] = size;
    } else this.doc.addPage();
    this.current = "";
    return this;
  }

  private use(beng: boolean, bold: boolean, size: number) {
    const key = beng ? (bold ? "bengBold" : "beng") : bold ? "latinBold" : "latin";
    if (key !== this.current) this.doc.font(key);
    if (size !== this.currentSize || key !== this.current) this.doc.fontSize(size);
    this.current = key;
    this.currentSize = size;
  }

  private runWidth(run: Run, bold: boolean, size: number) {
    if (!run.text) return 0;
    this.use(run.beng, bold, size);
    return this.doc.widthOfString(run.text);
  }

  /** Width of `text` on one line. */
  measureWidth(text: string, size = 9, bold = false) {
    return scriptRuns(clean(text)).reduce((w, r) => w + this.runWidth(r, bold, size), 0);
  }

  /** Breaks text into lines that fit `width`. */
  private layout(text: string, o: TextOpts): Line[] {
    const size = o.size ?? 9;
    const bold = !!o.bold;
    const value = clean(text);
    if (!value) return [];
    if (!o.width) {
      const runs = scriptRuns(value);
      return [{ runs, width: runs.reduce((w, r) => w + this.runWidth(r, bold, size), 0) }];
    }
    const max = o.width;
    const words = value.split(/ +/);
    const space = this.runWidth({ text: " ", beng: false }, bold, size);
    const lines: Line[] = [];
    let line: Line = { runs: [], width: 0 };
    const push = () => {
      if (line.runs.length) lines.push(line);
      line = { runs: [], width: 0 };
    };
    for (const word of words) {
      let runs = scriptRuns(word);
      let w = runs.reduce((n, r) => n + this.runWidth(r, bold, size), 0);
      if (line.runs.length && line.width + space + w > max) push();
      if (!line.runs.length && w > max) {
        // One word longer than the line: cut it by characters (IDs, URLs, long numbers).
        const chars = [...word];
        let piece = "";
        for (const ch of chars) {
          if (piece && this.measureWidth(piece + ch, size, bold) > max) {
            const pr = scriptRuns(piece);
            lines.push({ runs: pr, width: pr.reduce((n, r) => n + this.runWidth(r, bold, size), 0) });
            piece = "";
          }
          piece += ch;
        }
        runs = scriptRuns(piece);
        w = runs.reduce((n, r) => n + this.runWidth(r, bold, size), 0);
      }
      if (line.runs.length) {
        line.runs.push({ text: " ", beng: line.runs[line.runs.length - 1].beng });
        line.width += space;
      }
      line.runs.push(...runs);
      line.width += w;
    }
    push();
    if (o.maxLines && lines.length > o.maxLines) {
      const kept = lines.slice(0, o.maxLines);
      const last = kept[kept.length - 1];
      const ell = this.runWidth({ text: "…", beng: false }, bold, size);
      // Drop characters until the ellipsis fits.
      let flat = last.runs.map(r => r.text).join("");
      while (flat.length > 1 && this.measureWidth(flat, size, bold) + ell > max) flat = [...flat].slice(0, -1).join("");
      const runs = [...scriptRuns(flat.trimEnd()), { text: "…", beng: false }];
      kept[kept.length - 1] = { runs, width: runs.reduce((n, r) => n + this.runWidth(r, bold, size), 0) };
      return kept;
    }
    return lines;
  }

  lineHeight(o: TextOpts = {}) {
    return (o.size ?? 9) * (o.leading ?? 1.3);
  }

  /** Height the text would take. */
  measure(text: string, o: TextOpts = {}) {
    const lines = this.layout(text, o).length;
    return lines * this.lineHeight(o);
  }

  /** Draws text with its top at y; returns the height used. */
  text(text: unknown, x: number, y: number, o: TextOpts = {}): number {
    const size = o.size ?? 9;
    const bold = !!o.bold;
    const lines = this.layout(clean(text), o);
    const lh = this.lineHeight(o);
    this.doc.fillColor(o.color ?? COLOR.ink);
    lines.forEach((line, i) => {
      const baseline = y + i * lh + (lh - size) / 2 + size * 0.82;
      let cx = x;
      if (o.width && o.align === "right") cx = x + o.width - line.width;
      else if (o.width && o.align === "center") cx = x + (o.width - line.width) / 2;
      for (const run of line.runs) {
        if (!run.text) continue;
        this.use(run.beng, bold, size);
        this.doc.text(run.text, cx, baseline, { lineBreak: false, baseline: "alphabetic" });
        cx += this.doc.widthOfString(run.text);
      }
    });
    return lines.length * lh;
  }

  /** Code 128 barcode filling the box (bars scaled to the width, quiet zones included). */
  barcode(value: string, x: number, y: number, w: number, h: number, color = "#000") {
    const widths = code128Widths(value);
    const modules = widths.reduce((a, b) => a + b, 0) + 20; // 10-module quiet zone each side
    const unit = w / modules;
    let cx = x + 10 * unit;
    this.doc.save().fillColor(color);
    widths.forEach((m, i) => {
      if (i % 2 === 0) this.doc.rect(cx, y, m * unit, h);
      cx += m * unit;
    });
    this.doc.fill();
    this.doc.restore();
  }

  /** QR code (error correction M) as a square of `size` points. */
  qr(text: string, x: number, y: number, size: number) {
    const q = QRCode.create(text, { errorCorrectionLevel: "M" });
    const n = q.modules.size;
    const quiet = 2;
    const cell = size / (n + quiet * 2);
    this.doc.save().fillColor("#000");
    for (let r = 0; r < n; r++) {
      let c = 0;
      while (c < n) {
        if (!q.modules.get(r, c)) {
          c++;
          continue;
        }
        const start = c;
        while (c < n && q.modules.get(r, c)) c++;
        this.doc.rect(x + (quiet + start) * cell, y + (quiet + r) * cell, (c - start) * cell + 0.05, cell + 0.05);
      }
    }
    this.doc.fill();
    this.doc.restore();
  }

  /** The Delivery Fast mark (the panels' logo: parcel on a delivery van), `size` points square. */
  logo(x: number, y: number, size: number) {
    const d = this.doc;
    d.save().translate(x, y).scale(size / 32);
    d.lineWidth(1.8).strokeColor(COLOR.brand).path("M12 3 L16 1 L20 3 V8 L16 10 L12 8 V3 Z").stroke();
    d.lineWidth(1.4).path("M12 3 L16 5 L20 3 M16 5 V10").stroke();
    d.lineWidth(2).strokeColor("#344054").path("M16 10 V12").stroke();
    d.roundedRect(5, 12, 22, 13, 4).stroke();
    d.lineWidth(1.5).strokeColor(COLOR.brand).path("M9 17 H23").stroke();
    d.fillColor(COLOR.brand).circle(12, 20, 1.2).fill().circle(20, 20, 1.2).fill();
    d.lineWidth(2).strokeColor("#344054").path("M11 25 V27 M21 25 V27").stroke();
    d.fillColor("#344054").circle(10, 28, 2).fill().circle(22, 28, 2).fill();
    d.restore();
  }

  line(x1: number, y1: number, x2: number, y2: number, o: { color?: string; width?: number; dash?: number } = {}) {
    const d = this.doc.save().lineWidth(o.width ?? 0.6).strokeColor(o.color ?? COLOR.line);
    if (o.dash) d.dash(o.dash, { space: o.dash });
    d.moveTo(x1, y1).lineTo(x2, y2).stroke();
    d.restore();
  }

  box(x: number, y: number, w: number, h: number, o: { fill?: string; stroke?: string; radius?: number; width?: number } = {}) {
    const d = this.doc.save();
    if (o.radius) d.roundedRect(x, y, w, h, o.radius);
    else d.rect(x, y, w, h);
    if (o.fill && o.stroke) d.lineWidth(o.width ?? 0.8).fillAndStroke(o.fill, o.stroke);
    else if (o.fill) d.fill(o.fill);
    else d.lineWidth(o.width ?? 0.8).stroke(o.stroke ?? COLOR.line);
    d.restore();
  }
}

// ───────────── formatting ─────────────

const DHAKA = "Asia/Dhaka";
const dateFmt = new Intl.DateTimeFormat("en-GB", { timeZone: DHAKA, day: "2-digit", month: "short", year: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: DHAKA, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const amountFmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const wholeFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

export const fmtDate = (d: Date | string | null | undefined) => (d ? dateFmt.format(new Date(d)) : "—");
export const fmtDateTime = (d: Date | string | null | undefined) => (d ? `${dateTimeFmt.format(new Date(d))}` : "—");
/** "1,250.00" */
export const fmtAmount = (v: number | string | { toString(): string } | null | undefined) => amountFmt.format(Number(v ?? 0));
/** "৳ 1,250" (no decimals when whole) */
export const taka = (v: number | string | { toString(): string } | null | undefined) => `৳ ${wholeFmt.format(Number(v ?? 0))}`;
/** Today's Dhaka date as YYYY-MM-DD. */
export const dhakaToday = (now = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: DHAKA }).format(now);
