import { writeZip } from "./zip";

// A small .xlsx writer: several sheets, a fixed set of cell styles, column widths, a frozen
// header row, hidden sheets, defined names and data validation (dropdown lists, decimals).
// Cells are written as inline strings or numbers, so no shared-strings part is needed.

/** Cell styles (index into cellXfs in styles.xml). */
export const STYLE = {
  normal: 0,
  /** Required column header: red fill, white bold text. */
  headerRequired: 1,
  /** Optional column header: light blue fill, dark bold text. */
  headerOptional: 2,
  /** Text format (@): keeps leading zeros in phone numbers and order IDs. */
  text: 3,
  /** Wrapped text, top aligned (instructions). */
  wrap: 4,
  /** Bold (instructions headings). */
  bold: 5,
  /** Title (instructions). */
  title: 6,
  /** Error message cell: red text, wrapped. */
  error: 7,
  /** Read-only data on a protected sheet: grey fill, text format, locked. */
  readonly: 8,
  /** Read-only column header: dark grey fill, white bold text, locked. */
  headerReadonly: 9,
  /** Editable cell on a protected sheet: unlocked. */
  editable: 10,
  /** Editable cell kept as text (phone numbers): unlocked. */
  editableText: 11,
} as const;

export type Cell = string | number | null | undefined | { value: string | number | null | undefined; style: number };

export interface DataValidation {
  /** e.g. "C2:C5001" */
  sqref: string;
  type: "list" | "decimal" | "whole" | "textLength";
  /** list: a formula ("L_Districts", "IF(…,INDIRECT(…))"; it must evaluate to a range) or a literal list (["Yes","No"]). Others: [min, max]. */
  formula1: string | string[];
  formula2?: string;
  operator?: "between" | "greaterThanOrEqual" | "lessThanOrEqual";
  /** stop: refuse other values; warning/information: allow them after a prompt. */
  errorStyle?: "stop" | "warning" | "information";
  allowBlank?: boolean;
  promptTitle?: string;
  prompt?: string;
  errorTitle?: string;
  error?: string;
}

export interface Sheet {
  name: string;
  rows: Cell[][];
  /** Column widths in characters. */
  widths?: number[];
  /** Default style per column (e.g. STYLE.text for phone columns). */
  columnStyles?: (number | undefined)[];
  /** Number of columns to style even where no cell is written. */
  columnCount?: number;
  freezeHeader?: boolean;
  hidden?: boolean;
  validations?: DataValidation[];
  /** Filter buttons on the header row, covering every written row. */
  autoFilter?: boolean;
  /** Columns (0-based) hidden in Excel. */
  hiddenColumns?: number[];
  /**
   * Sheet protection without a password: locked cells (every style except `editable` /
   * `editableText`) can't be changed, while filtering, sorting and resizing stay allowed.
   * Review → Unprotect Sheet lifts it (no password).
   */
  protect?: boolean;
}

export interface Workbook {
  sheets: Sheet[];
  /** Workbook-level names, e.g. { name: "L_Districts", ref: "Lists!$A$2:$A$9" }. */
  names?: { name: string; ref: string }[];
  title?: string;
}

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // XML 1.0 can't hold most control characters.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

/** 0 → "A", 26 → "AA". */
export function columnLetter(index: number) {
  let s = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Excel limits list literals in validations to 255 characters; quote sheet names with spaces. */
export const sheetRef = (sheet: string, col: number, fromRow: number, toRow: number) => {
  const name = /^[A-Za-z_][A-Za-z0-9_]*$/.test(sheet) ? sheet : `'${sheet.replace(/'/g, "''")}'`;
  const c = columnLetter(col);
  return `${name}!$${c}$${fromRow}:$${c}$${Math.max(fromRow, toRow)}`;
};

function cellXml(ref: string, cell: Cell) {
  const { value, style } = typeof cell === "object" && cell !== null ? cell : { value: cell, style: STYLE.normal };
  const s = style ? ` s="${style}"` : "";
  if (value === null || value === undefined || value === "") return style ? `<c r="${ref}"${s}/>` : "";
  if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}"${s}><v>${value}</v></c>`;
  const text = String(value);
  const space = /^\s|\s$|\n/.test(text) ? ' xml:space="preserve"' : "";
  return `<c r="${ref}"${s} t="inlineStr"><is><t${space}>${esc(text)}</t></is></c>`;
}

function validationXml(v: DataValidation) {
  const attrs = [
    `type="${v.type}"`,
    v.errorStyle && v.errorStyle !== "stop" ? `errorStyle="${v.errorStyle}"` : "",
    v.operator ? `operator="${v.operator}"` : "",
    v.allowBlank !== false ? 'allowBlank="1"' : "",
    'showInputMessage="1"',
    'showErrorMessage="1"',
    v.errorTitle ? `errorTitle="${esc(v.errorTitle.slice(0, 32))}"` : "",
    v.error ? `error="${esc(v.error.slice(0, 255))}"` : "",
    v.promptTitle ? `promptTitle="${esc(v.promptTitle.slice(0, 32))}"` : "",
    v.prompt ? `prompt="${esc(v.prompt.slice(0, 255))}"` : "",
    `sqref="${v.sqref}"`,
  ]
    .filter(Boolean)
    .join(" ");
  const f1 = Array.isArray(v.formula1) ? `"${v.formula1.map(x => x.replace(/"/g, '""')).join(",")}"` : v.formula1;
  return `<dataValidation ${attrs}><formula1>${esc(f1)}</formula1>${v.formula2 !== undefined ? `<formula2>${esc(v.formula2)}</formula2>` : ""}</dataValidation>`;
}

function sheetXml(sheet: Sheet, tabSelected: boolean) {
  const columns = Math.max(sheet.columnCount ?? 0, sheet.widths?.length ?? 0, ...sheet.rows.map(r => r.length));
  const hidden = new Set(sheet.hiddenColumns ?? []);
  const cols = Array.from({ length: columns }, (_, i) => {
    const width = sheet.widths?.[i];
    const style = sheet.columnStyles?.[i];
    if (!width && !style && !hidden.has(i)) return "";
    return `<col min="${i + 1}" max="${i + 1}" width="${width ?? 14}"${width ? ' customWidth="1"' : ""}${style ? ` style="${style}"` : ""}${hidden.has(i) ? ' hidden="1"' : ""}/>`;
  }).join("");
  const rows = sheet.rows
    .map((row, r) => {
      const cells = row.map((cell, c) => cellXml(`${columnLetter(c)}${r + 1}`, cell)).join("");
      return cells ? `<row r="${r + 1}">${cells}</row>` : "";
    })
    .join("");
  const pane = sheet.freezeHeader
    ? `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>`
    : "";
  const validations = sheet.validations?.length ? `<dataValidations count="${sheet.validations.length}">${sheet.validations.map(validationXml).join("")}</dataValidations>` : "";
  const filter = sheet.autoFilter && columns ? `<autoFilter ref="A1:${columnLetter(columns - 1)}${Math.max(1, sheet.rows.length)}"/>` : "";
  // No password; "0" = allowed for the listed actions (sort, filter, resize), locked cells stay read-only.
  const protection = sheet.protect
    ? `<sheetProtection sheet="1" objects="1" scenarios="1" formatCells="1" formatColumns="0" formatRows="0" insertRows="1" deleteRows="1" sort="0" autoFilter="0" selectLockedCells="0" selectUnlockedCells="0"/>`
    : "";
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheetViews><sheetView workbookViewId="0"${tabSelected ? ' tabSelected="1"' : ""}>${pane}</sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>` +
    (cols ? `<cols>${cols}</cols>` : "") +
    `<sheetData>${rows}</sheetData>` +
    protection +
    filter +
    validations +
    `<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>` +
    `</worksheet>`
  );
}

const STYLES_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<fonts count="5">` +
  `<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>` +
  `<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>` +
  `<font><b/><sz val="11"/><color rgb="FF1F2A44"/><name val="Calibri"/><family val="2"/></font>` +
  `<font><b/><sz val="14"/><color rgb="FF1F2A44"/><name val="Calibri"/><family val="2"/></font>` +
  `<font><sz val="11"/><color rgb="FFB42318"/><name val="Calibri"/><family val="2"/></font>` +
  `</fonts>` +
  `<fills count="6">` +
  `<fill><patternFill patternType="none"/></fill>` +
  `<fill><patternFill patternType="gray125"/></fill>` +
  `<fill><patternFill patternType="solid"><fgColor rgb="FFC62828"/><bgColor indexed="64"/></patternFill></fill>` +
  `<fill><patternFill patternType="solid"><fgColor rgb="FFDCE6F7"/><bgColor indexed="64"/></patternFill></fill>` +
  `<fill><patternFill patternType="solid"><fgColor rgb="FFF0F2F5"/><bgColor indexed="64"/></patternFill></fill>` +
  `<fill><patternFill patternType="solid"><fgColor rgb="FF667085"/><bgColor indexed="64"/></patternFill></fill>` +
  `</fills>` +
  `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>` +
  `<border><left style="thin"><color rgb="FFB7C3D4"/></left><right style="thin"><color rgb="FFB7C3D4"/></right><top style="thin"><color rgb="FFB7C3D4"/></top><bottom style="thin"><color rgb="FFB7C3D4"/></bottom><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="12">` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="49" fontId="1" fillId="2" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>` +
  `<xf numFmtId="49" fontId="2" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>` +
  `<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
  `<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
  `<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
  `<xf numFmtId="49" fontId="4" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
  `<xf numFmtId="49" fontId="0" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1" applyProtection="1"><protection locked="1"/></xf>` +
  `<xf numFmtId="49" fontId="1" fillId="5" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1" applyProtection="1"><alignment vertical="center" wrapText="1"/><protection locked="1"/></xf>` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyProtection="1"><protection locked="0"/></xf>` +
  `<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyProtection="1"><protection locked="0"/></xf>` +
  `</cellXfs>` +
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
  `</styleSheet>`;

/** Builds the .xlsx file. */
export function writeXlsx(book: Workbook): Buffer {
  const sheets = book.sheets;
  const firstVisible = Math.max(0, sheets.findIndex(s => !s.hidden));
  const names = (book.names ?? []).map(n => `<definedName name="${esc(n.name)}">${esc(n.ref)}</definedName>`).join("");
  const workbookXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<workbookPr/><bookViews><workbookView activeTab="${firstVisible}"/></bookViews>` +
    `<sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : ""} r:id="rId${i + 1}"/>`).join("")}</sheets>` +
    (names ? `<definedNames>${names}</definedNames>` : "") +
    `</workbook>`;
  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
    `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`;
  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
    `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` +
    `</Types>`;
  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
    `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>` +
    `</Relationships>`;
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const core =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title>${esc(book.title ?? "Delivery Fast")}</dc:title><dc:creator>Delivery Fast</dc:creator>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>` +
    `</cp:coreProperties>`;
  const app =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Delivery Fast</Application></Properties>`;
  return writeZip([
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: rootRels },
    { name: "docProps/core.xml", data: core },
    { name: "docProps/app.xml", data: app },
    { name: "xl/workbook.xml", data: workbookXml },
    { name: "xl/_rels/workbook.xml.rels", data: workbookRels },
    { name: "xl/styles.xml", data: STYLES_XML },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s, i === firstVisible) })),
  ]);
}
