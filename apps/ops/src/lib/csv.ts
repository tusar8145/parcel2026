/** CSV files for Excel (BOM, CRLF, formula-safe cells), saved in the browser. */
export function csvText(rows: unknown[][]) {
  const cell = (v: unknown) => {
    if (v == null) return "";
    let t = String(v);
    if (typeof v === "string" && /^[=+\-@]/.test(t)) t = `'${t}`;
    return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return "﻿" + rows.map(r => r.map(cell).join(",")).join("\r\n");
}
export function saveText(name: string, text: string, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
export const saveCsv = (name: string, rows: unknown[][]) => saveText(name, csvText(rows));
