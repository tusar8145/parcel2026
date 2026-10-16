import { AppError } from "../../../common/errors";
import { readZip } from "./zip";

/** A worksheet as text: rows[i] is spreadsheet row i + 1 (empty rows are empty arrays). */
export interface SheetData {
  sheetName: string;
  rows: string[][];
}

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export const decodeXml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENTITY[e.toLowerCase()] ?? _),
  );
/** Excel escapes control characters as _xHHHH_ in text. */
const decodeExcel = (s: string) => decodeXml(s).replace(/_x([0-9a-f]{4})_/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

/** Text of <t> elements, skipping phonetic runs (<rPh>). */
function textOf(xml: string) {
  const clean = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let out = "";
  for (const m of clean.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g)) out += m[1] ?? "";
  return decodeExcel(out);
}

function columnIndex(ref: string) {
  let index = 0;
  for (const ch of ref) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) break;
    index = index * 26 + code - 64;
  }
  return index - 1;
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
function isDateFormat(code: string) {
  const plain = code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, "");
  return /[dmyhs]/i.test(plain) && !/^[#0.,%\s]*$/.test(plain);
}

/** Which cell styles (index into cellXfs) display a date. */
function dateStyles(stylesXml: string | undefined) {
  const result = new Set<number>();
  if (!stylesXml) return result;
  const custom = new Map<number, string>();
  for (const m of stylesXml.matchAll(/<numFmt\b[^>]*\/?>/g)) {
    const id = Number(attr(m[0], "numFmtId"));
    const code = attr(m[0], "formatCode");
    if (Number.isFinite(id) && code) custom.set(id, decodeXml(code));
  }
  const xfs = stylesXml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? "";
  let index = 0;
  for (const m of xfs.matchAll(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)) {
    const id = Number(attr(m[0], "numFmtId") ?? 0);
    if (BUILTIN_DATE_FORMATS.has(id) || (custom.has(id) && isDateFormat(custom.get(id)!))) result.add(index);
    index++;
  }
  return result;
}

/** Excel serial date → "YYYY-MM-DD" (or with " HH:MM" when it has a time). */
function serialToText(serial: number, date1904: boolean) {
  const ms = Math.round((serial - (date1904 ? 24107 : 25569)) * 86_400_000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(serial);
  const iso = d.toISOString();
  return serial % 1 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
}

/** 0.1+0.2 style artefacts and integers as Excel shows them ("1712345678", "2.5"). */
function numberText(v: string) {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return BigInt(n).toString();
  return String(Number(n.toPrecision(15)));
}

/**
 * Reads the data sheet of an .xlsx workbook: shared strings, inline strings, numbers, booleans
 * and dates (by the cell's number format). The sheet is the one named in `prefer`, else the
 * first visible sheet that isn't an instructions or lists sheet. Stops with TOO_MANY_ROWS once
 * more than `maxRows` non-empty rows (after the header) were found.
 */
export function readXlsx(buf: Buffer, opts: { maxRows: number; prefer?: string[] }): SheetData {
  const files = readZip(buf, {
    maxBytes: 200 * 1024 * 1024,
    wanted: name => name === "xl/workbook.xml" || name === "xl/_rels/workbook.xml.rels" || name === "xl/sharedStrings.xml" || name === "xl/styles.xml" || /^xl\/worksheets\/[^/]+\.xml$/.test(name),
  });
  const workbook = files.get("xl/workbook.xml")?.toString("utf8");
  if (!workbook) throw new AppError("INVALID_FILE", "This file is not an Excel workbook (.xlsx).", 422);
  const rels = files.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";
  const targets = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const id = attr(m[0], "Id");
    const target = attr(m[0], "Target");
    if (id && target) targets.set(id, target.replace(/^\/?xl\//, "").replace(/^\//, ""));
  }
  const sheets = [...workbook.matchAll(/<sheet\b[^>]*\/?>/g)].map(m => ({
    name: decodeXml(attr(m[0], "name") ?? ""),
    hidden: /state="(hidden|veryHidden)"/.test(m[0]),
    path: `xl/${targets.get(attr(m[0], "r:id") ?? "") ?? ""}`,
  }));
  const lower = (s: string) => s.trim().toLowerCase();
  const sheet =
    sheets.find(s => opts.prefer?.some(p => lower(p) === lower(s.name)) && files.has(s.path)) ??
    sheets.find(s => !s.hidden && !["instructions", "lists", "help", "readme"].includes(lower(s.name)) && files.has(s.path)) ??
    sheets.find(s => files.has(s.path));
  if (!sheet) throw new AppError("INVALID_FILE", "The workbook has no readable worksheet.", 422);
  const date1904 = /<workbookPr\b[^>]*date1904="(1|true)"/.test(workbook);
  const sharedXml = files.get("xl/sharedStrings.xml")?.toString("utf8");
  const shared = sharedXml ? [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)].map(m => (m[1] ? textOf(m[1]) : "")) : [];
  const dates = dateStyles(files.get("xl/styles.xml")?.toString("utf8"));
  const xml = files.get(sheet.path)!.toString("utf8");

  const rows: string[][] = [];
  let dataRows = 0;
  let nextRow = 1;
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowNumber = Number(attr(rm[1], "r") ?? nextRow);
    nextRow = rowNumber + 1;
    const cells: string[] = [];
    let nextCol = 0;
    for (const cm of (rm[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = cm[1];
      const ref = attr(a, "r");
      const col = ref ? columnIndex(ref) : nextCol;
      nextCol = col + 1;
      const type = attr(a, "t");
      const body = cm[2] ?? "";
      const raw = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1];
      let value = "";
      if (type === "s") value = shared[Number(raw)] ?? "";
      else if (type === "inlineStr") value = textOf(body.match(/<is\b[^>]*>([\s\S]*?)<\/is>/)?.[1] ?? "");
      else if (type === "b") value = raw === "1" ? "TRUE" : raw === "0" ? "FALSE" : "";
      else if (type === "e") value = "";
      else if (type === "str") value = raw != null ? decodeExcel(raw) : "";
      else if (raw != null) {
        const style = Number(attr(a, "s") ?? 0);
        value = dates.has(style) && Number.isFinite(Number(raw)) ? serialToText(Number(raw), date1904) : numberText(decodeXml(raw));
      }
      cells[col] = value;
    }
    for (let i = 0; i < cells.length; i++) cells[i] ??= "";
    while (rows.length < rowNumber - 1) rows.push([]);
    rows[rowNumber - 1] = cells;
    if (rowNumber > 1 && cells.some(c => c.trim())) {
      dataRows++;
      if (dataRows > opts.maxRows)
        throw new AppError("TOO_MANY_ROWS", `This file has more than ${opts.maxRows.toLocaleString("en-US")} rows. Split it into smaller files.`, 413, { maxRows: opts.maxRows });
    }
  }
  return { sheetName: sheet.name, rows };
}
