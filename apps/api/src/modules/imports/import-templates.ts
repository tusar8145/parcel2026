import { columnLetter, sheetRef, STYLE, writeXlsx, type Cell, type DataValidation, type Sheet } from "./xlsx/xlsx-writer";
import type { ColumnDef, ColumnKey, ImportKindKey, ListKey } from "./columns";
import type { EngineContext } from "./import-engine.service";

export const DATA_SHEET: Record<ImportKindKey, string> = { ecommerce: "Orders", document: "Consignments" };
const TITLE: Record<ImportKindKey, string> = { ecommerce: "E-commerce order import", document: "Banking & Financial consignment import" };
const LIST_SHEET = "Lists";
const LIST_TITLES: Record<ListKey, string> = {
  merchants: "Merchants",
  districts: "Districts",
  zones: "Zones",
  areas: "Areas",
  addressTypes: "Address types",
  parcelTypes: "Parcel types",
  products: "Products",
  speeds: "Speed + handling",
  weights: "Weights (kg)",
  yesNo: "Yes / No",
  packaging: "Packaging",
  documentTypes: "Document types",
  documentItems: "Document descriptions",
  relations: "Receiver relationships",
};

export interface TemplateOptions {
  /** Rows covered by the dropdowns (the file limit). */
  maxRows: number;
  maxFileMb: number;
  /** Failed-rows download: data rows (cells by column) and their error text. */
  rows?: { cells: Partial<Record<ColumnKey, string>>; error: string }[];
}

const listName = (key: ListKey) => `L_${key}`;

/** Built from live data: Lists sheet columns with names (L_districts, ZN_<n> zones of district n, AR_<n> areas of zone n). */
function listsSheet(ctx: EngineContext, used: Set<ListKey>) {
  const columns: ListColumn[] = [];
  for (const key of used) if (ctx.lists[key].length) columns.push({ title: LIST_TITLES[key], values: ctx.lists[key], name: listName(key) });
  const dependentZones = used.has("zones") && used.has("districts");
  if (dependentZones)
    ctx.lists.districts.forEach((district, i) => {
      const zones = ctx.catalog.zonesByDistrict[district] ?? [];
      if (zones.length) columns.push({ title: `Zones · ${district}`, values: zones, name: `ZN_${i + 1}` });
    });
  const dependentAreas = used.has("areas") && used.has("zones");
  if (dependentAreas)
    ctx.lists.zones.forEach((zone, i) => {
      const areas = ctx.catalog.areasByZone[zone] ?? [];
      if (areas.length) columns.push({ title: `Areas · ${zone}`, values: areas, name: `AR_${i + 1}` });
    });
  return { ...writeListsSheet(columns), dependentZones, dependentAreas };
}

/** A column of the hidden lists sheet; `name` becomes a workbook name for dropdowns (e.g. L_districts). */
export interface ListColumn {
  title: string;
  values: string[];
  name?: string;
}

/** The hidden "Lists" sheet that dropdowns read, and the workbook names of its columns. */
export function writeListsSheet(columns: ListColumn[], sheetName = LIST_SHEET) {
  const longest = Math.max(1, ...columns.map(c => c.values.length));
  const rows: Cell[][] = [columns.map(c => ({ value: c.title, style: STYLE.bold }))];
  for (let r = 0; r < longest; r++) rows.push(columns.map(c => c.values[r] ?? null));
  // An empty list still gets a (blank) one-cell range, so INDIRECT() of its name is a range.
  const names = columns.flatMap((c, i) => (c.name ? [{ name: c.name, ref: sheetRef(sheetName, i, 2, Math.max(1, c.values.length) + 1) }] : []));
  const sheet: Sheet = { name: sheetName, rows, hidden: true, widths: columns.map(() => 26) };
  return { sheet, names };
}

/**
 * A list that depends on another cell: `IF($B2="",<all>,INDIRECT("<prefix>"&MATCH($B2,<parents>,0)))`.
 * IF, not IFERROR: a list source must evaluate to a range, and Excel's IFERROR returns a value,
 * so IFERROR(INDIRECT(…), …) shows no dropdown at all.
 */
export const dependentListFormula = (parentColumn: string, allName: string, prefix: string, parentsName: string) =>
  `IF($${parentColumn}2="",${allName},INDIRECT("${prefix}"&MATCH($${parentColumn}2,${parentsName},0)))`;

function allowedText(col: ColumnDef, ctx: EngineContext) {
  if (col.key === "recipient_phone") return "Bangladeshi mobile number: 17XXXXXXXX or 017XXXXXXXX (+880 is added)";
  if (col.list && col.strictList) {
    const values = ctx.lists[col.list];
    if (col.key === "zone") return "A zone of the chosen district (the dropdown follows the district)";
    return values.length <= 12 ? values.join(", ") : `One of ${values.length} options (dropdown)`;
  }
  if (col.number) return `Number from ${col.number.min} to ${col.number.max.toLocaleString("en-US")}`;
  if (col.list) return `Free text; suggestions in the dropdown${col.maxLength ? ` (up to ${col.maxLength} characters)` : ""}`;
  return col.maxLength ? `Text, up to ${col.maxLength} characters` : "Text";
}

/**
 * The import template (or a failed-rows file in the same format): the data sheet with required
 * headers in red with "*", dropdowns from live data, a frozen header row; an Instructions sheet;
 * and the hidden Lists sheet the dropdowns read.
 */
export function buildTemplate(ctx: EngineContext, opts: TemplateOptions): Buffer {
  const settings = ctx.settings.templates[ctx.kind];
  const cols = ctx.columns;
  const used = new Set<ListKey>(cols.filter(c => c.list).map(c => c.list!));
  const lists = listsSheet(ctx, used);
  const last = opts.maxRows + 1;
  const letter = (key: ColumnKey) => columnLetter(cols.findIndex(c => c.key === key));
  const validations: DataValidation[] = [];
  cols.forEach((col, i) => {
    const range = `${columnLetter(i)}2:${columnLetter(i)}${last}`;
    const prompt = { promptTitle: col.header, prompt: col.description };
    if (col.list && ctx.lists[col.list].length) {
      // Dependent lists use IF, not IFERROR: a list source must evaluate to a range, and Excel's
      // IFERROR returns a value, so IFERROR(INDIRECT(…), …) shows no dropdown at all.
      let formula = listName(col.list);
      if (col.key === "zone" && lists.dependentZones && cols.some(c => c.key === "district")) formula = dependentListFormula(letter("district"), listName("zones"), "ZN_", listName("districts"));
      if (col.key === "area" && lists.dependentAreas && cols.some(c => c.key === "zone")) formula = dependentListFormula(letter("zone"), listName("areas"), "AR_", listName("zones"));
      validations.push({
        sqref: range,
        type: "list",
        formula1: formula,
        errorStyle: col.strictList ? "stop" : col.number ? "warning" : "information",
        errorTitle: col.header,
        error: col.strictList ? `Choose ${col.header.toLowerCase()} from the list.` : col.number ? `Not one of the usual values. Use a number from ${col.number.min} to ${col.number.max}.` : "Not in the suggestions; it will be imported as typed.",
        ...prompt,
      });
    } else if (col.number)
      validations.push({ sqref: range, type: "decimal", operator: "between", formula1: String(col.number.min), formula2: String(col.number.max), errorTitle: col.header, error: `Enter a number from ${col.number.min} to ${col.number.max}.`, ...prompt });
    else if (col.key === "recipient_phone")
      validations.push({ sqref: range, type: "textLength", operator: "between", formula1: "10", formula2: "14", errorStyle: "warning", errorTitle: col.header, error: "Enter a Bangladeshi mobile number: 17XXXXXXXX or 017XXXXXXXX.", ...prompt });
    else if (col.maxLength)
      validations.push({ sqref: range, type: "textLength", operator: "lessThanOrEqual", formula1: String(col.maxLength), errorTitle: col.header, error: `Use at most ${col.maxLength} characters.`, ...prompt });
  });

  const failed = !!opts.rows;
  const header: Cell[] = cols.map(col => ({ value: settings[col.key]?.required ? `${col.header} *` : col.header, style: settings[col.key]?.required ? STYLE.headerRequired : STYLE.headerOptional }));
  if (failed) header.push({ value: "Error", style: STYLE.headerRequired });
  const dataRows: Cell[][] = (opts.rows ?? []).map(r => [
    ...cols.map(col => ({ value: r.cells[col.key] ?? "", style: col.text ? STYLE.text : STYLE.normal })),
    ...(failed ? [{ value: r.error, style: STYLE.error }] : []),
  ]);
  const data: Sheet = {
    name: DATA_SHEET[ctx.kind],
    rows: [header, ...dataRows],
    widths: [...cols.map(c => c.width), ...(failed ? [60] : [])],
    columnStyles: cols.map(c => (c.text ? STYLE.text : undefined)),
    freezeHeader: true,
    validations,
  };

  const required = cols.filter(c => settings[c.key]?.required).map(c => c.header);
  const destination =
    ctx.settings.defaultDestination.mode === "FIXED" ? `${ctx.settings.defaultDestination.zone}, ${ctx.settings.defaultDestination.district}` : "the merchant's own city (its pickup zone)";
  const intro: string[] = [
    `How to use: one ${ctx.kind === "document" ? "consignment" : "order"} per row on the "${DATA_SHEET[ctx.kind]}" sheet, starting on row 2. Don't rename or reorder the header row.`,
    `Required columns have a red header with * (${required.length ? required.join(", ") : "none"}). Every other column may be left empty; a value you do enter must be valid, or the row is not created.`,
    `Rows missing the recipient name, recipient phone, address, district or zone are created as "Needs info": priced to ${destination} (weight and service use the defaults below) and held before delivery until you complete them.`,
    `Limits: at most ${opts.maxRows.toLocaleString("en-US")} rows and ${opts.maxFileMb} MB per file. Upload the .xlsx (or a CSV with the same headers).`,
    "Each row is booked once: rows already booked (same order ID, or the same details without an order ID) are not booked again.",
  ];
  const instructions: Cell[][] = [
    [{ value: `Delivery Fast · ${TITLE[ctx.kind]}`, style: STYLE.title }],
    // Not wrapped: each line overflows across the empty cells to its right.
    ...intro.map(t => [t]),
    [],
    ["Column", "Required", "Allowed values", "Default when empty", "Example", "Notes"].map(v => ({ value: v, style: STYLE.headerOptional })),
    ...cols.map(col => [
      { value: col.header, style: STYLE.bold },
      { value: settings[col.key]?.required ? "Yes" : col.key === "merchant" ? "Unless chosen for the whole file" : "No", style: STYLE.wrap },
      { value: allowedText(col, ctx), style: STYLE.wrap },
      { value: settings[col.key]?.default ?? (col.key === "district" || col.key === "zone" ? `Priced to ${destination}` : ""), style: STYLE.wrap },
      { value: col.example, style: STYLE.wrap },
      { value: col.description, style: STYLE.wrap },
    ]),
  ];
  return writeXlsx({
    title: `Delivery Fast ${TITLE[ctx.kind]}`,
    sheets: [data, { name: "Instructions", rows: instructions, widths: [24, 16, 40, 24, 22, 60] }, lists.sheet],
    names: lists.names,
  });
}
