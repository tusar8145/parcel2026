import { createHash } from "node:crypto";
import { Prisma } from "../../generated/prisma/client";

/** One parsed statement row. Amount is signed: money in (+), money out (−). */
export interface ParsedLine {
  lineNo: number;
  postedAt: Date;
  description: string;
  reference: string | null;
  amount: Prisma.Decimal;
}

export interface ParseResult {
  lines: ParsedLine[];
  errors: { lineNo: number; message: string }[];
}

/** RFC 4180-ish CSV (quoted fields, doubled quotes, CRLF), also ; or tab separated. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const sep = [",", ";", "\t"].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === sep) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.map(r => r.map(c => c.trim())).filter(r => r.some(c => c !== ""));
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** Dates as banks and bKash print them, read as Bangladesh time: 2026-10-15, 15/10/2026, 15-Oct-2026, with optional hh:mm[:ss] [AM|PM]. */
export function parseStatementDate(raw: string): Date | null {
  const s = raw.trim();
  let y: number, mo: number, d: number;
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) [y, mo, d] = [+m[1], +m[2], +m[3]];
  else if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/))) [d, mo, y] = [+m[1], +m[2], +m[3] < 100 ? 2000 + +m[3] : +m[3]];
  else if ((m = s.match(/^(\d{1,2})[-\s/]([A-Za-z]{3})[A-Za-z]*[-\s/,]+(\d{2,4})/))) {
    const month = MONTHS[m[2].toLowerCase()];
    if (!month) return null;
    [d, mo, y] = [+m[1], month, +m[3] < 100 ? 2000 + +m[3] : +m[3]];
  } else return null;
  const t = s.slice(m[0].length).match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i);
  let hh = t ? +t[1] : 0;
  if (t?.[4]) hh = (hh % 12) + (t[4].toUpperCase() === "PM" ? 12 : 0);
  const mm = t ? +t[2] : 0;
  const ss = t?.[3] ? +t[3] : 0;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mm > 59) return null;
  const date = new Date(Date.UTC(y, mo - 1, d, hh, mm, ss) - 6 * 3600_000);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "1,500.00", "(250.00)", "Tk 300", "৳ 1,000 Dr", "-75.5" → signed Decimal, or null. */
export function parseAmount(raw: string): Prisma.Decimal | null {
  let s = raw.trim();
  if (!s) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1);
  }
  if (/\bdr\.?$/i.test(s)) {
    sign = -1;
    s = s.replace(/\bdr\.?$/i, "");
  } else s = s.replace(/\bcr\.?$/i, "");
  s = s.replace(/(tk\.?|bdt|৳|,|\s)/gi, "");
  if (s.startsWith("-")) {
    sign *= -1;
    s = s.slice(1);
  } else if (s.startsWith("+")) s = s.slice(1);
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const d = new Prisma.Decimal(s).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  return sign < 0 ? d.negated() : d;
}

const find = (header: string[], ...patterns: RegExp[]) => {
  for (const p of patterns) {
    const i = header.findIndex(h => p.test(h));
    if (i >= 0) return i;
  }
  return -1;
};

/**
 * Detects the header row and columns (date; description/particulars/narration; reference /
 * transaction id; either a signed amount or separate debit/withdrawal and credit/deposit
 * columns) and parses each row. Unparseable rows are reported, not imported.
 */
export function parseStatement(text: string): ParseResult {
  const rows = parseCsv(text);
  const headerIndex = rows.findIndex(r => r.some(c => /date/i.test(c)) && r.some(c => /amount|debit|credit|withdraw|deposit/i.test(c)));
  if (headerIndex < 0) return { lines: [], errors: [{ lineNo: 1, message: "No header row with a date and an amount (or debit/credit) column was found" }] };
  const header = rows[headerIndex].map(h => h.toLowerCase());
  const col = {
    date: find(header, /^(txn|transaction|posting|value)?\s*date/, /date/),
    description: find(header, /description|particular|narration|details|remark/, /^type$/),
    reference: find(header, /^(trx|txn|transaction)\s*id/, /reference|ref\.?\s*no|^ref$|cheque|chq/),
    amount: find(header, /^amount/, /amount/),
    debit: find(header, /withdraw|debit|^dr\b|money out|paid out/),
    credit: find(header, /deposit|credit|^cr\b|money in|paid in/),
  };
  const lines: ParsedLine[] = [];
  const errors: ParseResult["errors"] = [];
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const r = rows[i];
    const lineNo = i + 1;
    const postedAt = col.date >= 0 ? parseStatementDate(r[col.date] ?? "") : null;
    if (!postedAt) {
      // Footer rows ("Closing balance", totals) have no date: skip them quietly.
      if (r.filter(Boolean).length > 1 && /\d/.test(r[col.date] ?? "")) errors.push({ lineNo, message: `Unreadable date "${r[col.date] ?? ""}"` });
      continue;
    }
    let amount: Prisma.Decimal | null = null;
    if (col.debit >= 0 || col.credit >= 0) {
      const dr = col.debit >= 0 ? parseAmount(r[col.debit] ?? "") : null;
      const cr = col.credit >= 0 ? parseAmount(r[col.credit] ?? "") : null;
      if (dr && !dr.isZero()) amount = dr.abs().negated();
      else if (cr && !cr.isZero()) amount = cr.abs();
    }
    if (!amount && col.amount >= 0) amount = parseAmount(r[col.amount] ?? "");
    if (!amount || amount.isZero()) {
      errors.push({ lineNo, message: "No amount" });
      continue;
    }
    const description = (col.description >= 0 ? r[col.description] : r.filter((_, j) => j !== col.date && j !== col.amount && j !== col.debit && j !== col.credit).join(" ")) || "";
    const reference = col.reference >= 0 && r[col.reference] ? r[col.reference] : null;
    lines.push({ lineNo, postedAt, description: description.slice(0, 500), reference: reference?.slice(0, 120) ?? null, amount });
  }
  return { lines, errors };
}

/** Same bank line → same fingerprint, so re-uploading a statement never imports it twice. `occurrence` separates identical rows in one file. */
export function fingerprint(source: string, accountLabel: string, l: ParsedLine, occurrence: number) {
  return createHash("sha256")
    .update([source, accountLabel.toLowerCase(), l.postedAt.toISOString(), l.amount.toFixed(2), (l.reference ?? "").toUpperCase(), l.description.toUpperCase(), occurrence].join("|"))
    .digest("hex");
}

/** Letters and digits only, upper case: "bkash-tx 1" ~ "BKASHTX1". */
export const normRef = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
