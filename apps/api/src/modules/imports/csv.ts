import { AppError } from "../../common/errors";
import type { SheetData } from "./xlsx/xlsx-reader";

/** Text of a CSV file: UTF-8 (with or without BOM) or UTF-16 (Excel's "Unicode text"). */
function decode(buf: Buffer) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  const text = buf.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** The delimiter of the header line: comma, semicolon (European Excel) or tab. */
function delimiterOf(text: string) {
  const line = text.slice(0, text.search(/\r?\n|$/));
  let quoted = false;
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch in counts) counts[ch]++;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ",";
}

/**
 * Parses CSV: quoted cells ("" for a quote, newlines inside quotes), CRLF / LF / CR line ends.
 * Stops with TOO_MANY_ROWS after `maxRows` non-empty data rows.
 */
export function readCsv(buf: Buffer, opts: { maxRows: number }): SheetData {
  const text = decode(buf);
  const delimiter = delimiterOf(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let dataRows = 0;
  const endRow = () => {
    row.push(cell);
    cell = "";
    rows.push(row);
    if (rows.length > 1 && row.some(c => c.trim())) {
      dataRows++;
      if (dataRows > opts.maxRows)
        throw new AppError("TOO_MANY_ROWS", `This file has more than ${opts.maxRows.toLocaleString("en-US")} rows. Split it into smaller files.`, 413, { maxRows: opts.maxRows });
    }
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell.trim() === "") {
      cell = "";
      quoted = true;
    } else if (c === delimiter) {
      row.push(cell);
      cell = "";
    } else if (c === "\r") {
      if (text[i + 1] === "\n") i++;
      endRow();
    } else if (c === "\n") endRow();
    else cell += c;
  }
  if (quoted) throw new AppError("INVALID_FILE", "The CSV file has a quoted value that never ends. Check the quotes and save it again.", 422);
  if (cell !== "" || row.length) endRow();
  return { sheetName: "CSV", rows: rows.map(r => r.map(v => v.trim())) };
}

/** CSV text (UTF-8 with BOM so Excel shows Bangla and ৳ correctly). */
export function writeCsv(rows: (string | number | null | undefined)[][]) {
  const cell = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `﻿${rows.map(r => r.map(cell).join(",")).join("\r\n")}`;
}
