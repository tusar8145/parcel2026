import { COLOR, fmtDateTime, PdfWriter, type TextOpts } from "./writer";

/** Who issues the document: notification brand settings + finance seller identity + the website. */
export interface Brand {
  appName: string;
  legalName: string;
  address: string;
  bin: string;
  support: string;
  website: string;
  vatRate: number;
}

export interface DocMeta {
  /** e.g. "Linehaul manifest" */
  title: string;
  /** e.g. "LH-261017-004" */
  number?: string;
  /** Printed as "Date": Dhaka time. */
  date?: Date;
  /** One short line under the title (status, period…). */
  subtitle?: string;
  generatedAt: Date;
  generatedBy: string;
}

export const MARGIN = 36;
export const FOOTER_H = 30;

/** Full company header: logo and company block on the left, the document title block on the right. Returns the y below it. */
export function header(pdf: PdfWriter, brand: Brand, meta: DocMeta): number {
  const x = MARGIN;
  const w = pdf.width - MARGIN * 2;
  let y = MARGIN;
  pdf.logo(x, y, 34);
  pdf.text(brand.appName, x + 42, y + 1, { size: 15, bold: true });
  const company: string[] = [];
  if (brand.legalName && brand.legalName !== brand.appName) company.push(brand.legalName);
  if (brand.address) company.push(brand.address);
  let cy = y + 22;
  for (const lineText of company) cy += pdf.text(lineText, x + 42, cy, { size: 7.5, color: COLOR.muted, width: w * 0.5 - 42, maxLines: 2 });
  const contact = [brand.support && `Support: ${brand.support}`, brand.website].filter(Boolean).join("  ·  ");
  if (contact) cy += pdf.text(contact, x + 42, cy, { size: 7.5, color: COLOR.muted, width: w * 0.55 - 42, maxLines: 2 });
  if (brand.bin) cy += pdf.text(`BIN: ${brand.bin}`, x + 42, cy, { size: 7.5, color: COLOR.muted });

  // Title block (right)
  const rw = w * 0.42;
  const rx = x + w - rw;
  let ry = y;
  ry += pdf.text(meta.title, rx, ry, { size: 15, bold: true, width: rw, align: "right", maxLines: 2 });
  if (meta.number) ry += pdf.text(meta.number, rx, ry + 1, { size: 10, bold: true, width: rw, align: "right" }) + 1;
  ry += pdf.text(`Date: ${fmtDateTime(meta.date ?? meta.generatedAt)}`, rx, ry + 1, { size: 8, color: COLOR.muted, width: rw, align: "right" });
  if (meta.subtitle) ry += pdf.text(meta.subtitle, rx, ry + 1, { size: 8, color: COLOR.muted, width: rw, align: "right", maxLines: 2 });

  y = Math.max(cy, ry, y + 38) + 8;
  pdf.box(x, y, w, 2.2, { fill: COLOR.brand });
  return y + 12;
}

/** Slim header on continuation pages. */
export function compactHeader(pdf: PdfWriter, brand: Brand, meta: DocMeta): number {
  const x = MARGIN;
  const w = pdf.width - MARGIN * 2;
  pdf.logo(x, MARGIN - 6, 18);
  pdf.text(brand.appName, x + 24, MARGIN - 3, { size: 10, bold: true });
  pdf.text([meta.title, meta.number].filter(Boolean).join(" · "), x + w * 0.4, MARGIN - 2, { size: 9, bold: true, width: w * 0.6, align: "right" });
  pdf.line(x, MARGIN + 18, x + w, MARGIN + 18, { color: COLOR.brand, width: 1.2 });
  return MARGIN + 28;
}

/** "Page x of y" and the generation note on every buffered page. */
export function footers(pdf: PdfWriter, brand: Brand, meta: DocMeta) {
  const range = pdf.doc.bufferedPageRange();
  const x = MARGIN;
  const w = pdf.width - MARGIN * 2;
  for (let i = 0; i < range.count; i++) {
    pdf.doc.switchToPage(range.start + i);
    const y = pdf.height - FOOTER_H + 6;
    pdf.line(x, y - 4, x + w, y - 4);
    const note = `${brand.appName} · ${[meta.title, meta.number].filter(Boolean).join(" ")} · generated ${fmtDateTime(meta.generatedAt)} (Dhaka) by ${meta.generatedBy}`;
    pdf.text(note, x, y, { size: 6.8, color: COLOR.faint, width: w * 0.78, maxLines: 1 });
    pdf.text(`Page ${i + 1} of ${range.count}`, x + w * 0.78, y, { size: 7.5, bold: true, color: COLOR.muted, width: w * 0.22, align: "right" });
  }
}

export interface Column {
  header: string;
  /** Relative width. */
  width: number;
  align?: "left" | "right" | "center";
  bold?: boolean;
  maxLines?: number;
}
export type Cell = string | number | null | undefined | { text: string; bold?: boolean; color?: string; sub?: string };

export interface TableOptions {
  x?: number;
  y: number;
  width?: number;
  columns: Column[];
  rows: Cell[][];
  size?: number;
  /** Called after a page break; draws the continuation header and returns where the table continues. */
  newPage: () => number;
  /** Rows under the body (totals), bold on a grey band. */
  foot?: Cell[][];
  zebra?: boolean;
  empty?: string;
  /** Minimum body row height (room to write by hand, e.g. run sheets). */
  minRow?: number;
}

const cellText = (c: Cell) => (c == null ? "" : typeof c === "object" ? c.text : String(c));

/** A table with a repeated heading row on every page. Returns the y below it. */
export function table(pdf: PdfWriter, o: TableOptions): number {
  const x = o.x ?? MARGIN;
  const width = o.width ?? pdf.width - MARGIN * 2;
  const size = o.size ?? 8;
  const pad = 4;
  const total = o.columns.reduce((n, c) => n + c.width, 0);
  const widths = o.columns.map(c => (c.width / total) * width);
  const bottom = pdf.height - FOOTER_H - 8;
  let y = o.y;

  const head = () => {
    const h = Math.max(...o.columns.map((c, i) => pdf.measure(c.header.toUpperCase(), { size: size - 1, bold: true, width: widths[i] - pad * 2, maxLines: 2 }))) + pad * 2;
    pdf.box(x, y, width, h, { fill: COLOR.dark });
    let cx = x;
    o.columns.forEach((c, i) => {
      pdf.text(c.header.toUpperCase(), cx + pad, y + pad, { size: size - 1, bold: true, color: "#ffffff", width: widths[i] - pad * 2, align: c.align, maxLines: 2 });
      cx += widths[i];
    });
    y += h;
  };

  const rowHeight = (row: Cell[], bold = false) =>
    Math.max(
      size * 1.3,
      ...row.map((c, i) => {
        const col = o.columns[i];
        const opts: TextOpts = { size, bold: bold || col?.bold || (typeof c === "object" && !!c?.bold), width: widths[i] - pad * 2, maxLines: col?.maxLines ?? 3 };
        const sub = c && typeof c === "object" && c.sub ? pdf.measure(c.sub, { size: size - 1.2, width: widths[i] - pad * 2, maxLines: 2 }) : 0;
        return pdf.measure(cellText(c), opts) + sub;
      }),
    ) +
    pad * 2;

  const drawRow = (row: Cell[], h: number, fill?: string, bold = false) => {
    if (fill) pdf.box(x, y, width, h, { fill });
    let cx = x;
    row.forEach((c, i) => {
      const col = o.columns[i];
      if (!col) return;
      const isObj = c != null && typeof c === "object";
      const used = pdf.text(cellText(c), cx + pad, y + pad, {
        size,
        bold: bold || col.bold || (isObj && !!c.bold),
        color: isObj && c.color ? c.color : COLOR.ink,
        width: widths[i] - pad * 2,
        align: col.align,
        maxLines: col.maxLines ?? 3,
      });
      if (isObj && c.sub) pdf.text(c.sub, cx + pad, y + pad + used, { size: size - 1.2, color: COLOR.muted, width: widths[i] - pad * 2, align: col.align, maxLines: 2 });
      cx += widths[i];
    });
    pdf.line(x, y + h, x + width, y + h);
  };

  head();
  if (!o.rows.length) {
    const h = size * 1.3 + pad * 4;
    pdf.text(o.empty ?? "Nothing to show.", x + pad, y + pad * 2, { size, color: COLOR.muted, width: width - pad * 2 });
    y += h;
    pdf.line(x, y, x + width, y);
  }
  o.rows.forEach((row, n) => {
    const h = Math.max(rowHeight(row), o.minRow ?? 0);
    if (y + h > bottom) {
      pdf.addPage();
      y = o.newPage();
      head();
    }
    drawRow(row, h, o.zebra !== false && n % 2 === 1 ? COLOR.soft : undefined);
    y += h;
  });
  for (const row of o.foot ?? []) {
    const h = rowHeight(row, true);
    if (y + h > bottom) {
      pdf.addPage();
      y = o.newPage();
    }
    drawRow(row, h, "#e9edf2", true);
    y += h;
  }
  return y;
}

/** Ensures `need` points are left on the page; else starts a new one. Returns the y to use. */
export function ensureSpace(pdf: PdfWriter, y: number, need: number, newPage: () => number) {
  if (y + need <= pdf.height - FOOTER_H - 8) return y;
  pdf.addPage();
  return newPage();
}

/** Label/value pairs in `cols` columns. Returns the y below. */
export function keyValues(pdf: PdfWriter, items: [string, string][], x: number, y: number, width: number, cols = 2, size = 8.5): number {
  const colW = width / cols;
  let rowY = y;
  for (let i = 0; i < items.length; i += cols) {
    let h = 0;
    items.slice(i, i + cols).forEach(([label, value], k) => {
      const cx = x + k * colW;
      const lh = pdf.text(label.toUpperCase(), cx, rowY, { size: 6.5, bold: true, color: COLOR.faint, width: colW - 8 });
      const vh = pdf.text(value || "—", cx, rowY + lh, { size, width: colW - 8, maxLines: 3 });
      h = Math.max(h, lh + vh);
    });
    rowY += h + 5;
  }
  return rowY;
}

/** Signature lines with captions, side by side. Returns the y below. */
export function signatures(pdf: PdfWriter, captions: string[], y: number): number {
  const x = MARGIN;
  const w = pdf.width - MARGIN * 2;
  const gap = 24;
  const each = (w - gap * (captions.length - 1)) / captions.length;
  const lineY = y + 34;
  captions.forEach((c, i) => {
    const cx = x + i * (each + gap);
    pdf.line(cx, lineY, cx + each, lineY, { color: COLOR.muted, width: 0.8 });
    pdf.text(c, cx, lineY + 4, { size: 7.5, color: COLOR.muted, width: each });
    pdf.text("Date & time:", cx, lineY + 16, { size: 7, color: COLOR.faint, width: each });
  });
  return lineY + 30;
}

/** A right-aligned totals block. Returns the y below. */
export function totals(pdf: PdfWriter, rows: { label: string; value: string; strong?: boolean }[], y: number, width = 240): number {
  const x = pdf.width - MARGIN - width;
  let cy = y;
  for (const r of rows) {
    const h = (r.strong ? 10 : 8.5) * 1.3 + 6;
    if (r.strong) pdf.box(x, cy, width, h, { fill: COLOR.soft });
    pdf.text(r.label, x + 6, cy + 3, { size: r.strong ? 10 : 8.5, bold: r.strong, width: width * 0.6 - 6 });
    pdf.text(r.value, x + width * 0.6, cy + 3, { size: r.strong ? 10 : 8.5, bold: r.strong, width: width * 0.4 - 6, align: "right" });
    cy += h;
    pdf.line(x, cy, x + width, cy);
  }
  return cy;
}

/** A small rounded status pill. */
export function pill(pdf: PdfWriter, text: string, x: number, y: number, color = COLOR.ink, align: "left" | "right" = "left") {
  const w = pdf.measureWidth(text, 7.5, true) + 12;
  const px = align === "right" ? x - w : x;
  pdf.box(px, y, w, 14, { stroke: color, radius: 7, width: 0.8 });
  pdf.text(text, px + 6, y + 2.2, { size: 7.5, bold: true, color });
  return w;
}
