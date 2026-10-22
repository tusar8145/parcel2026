import { columnLetter, sheetRef, STYLE, writeXlsx, type Cell, type DataValidation, type Sheet } from "./xlsx/xlsx-writer";
import { KIND_LABEL, SCAN_HEADER, type ColumnDef, type ColumnKey, type ImportKindKey, type ListKey } from "./columns";
import { packageOwner, type EngineContext } from "./import-engine.service";

export const DATA_SHEET: Record<ImportKindKey, string> = { ecommerce: "Orders", document: "Consignments", customer: "Parcels" };
const TITLE: Record<ImportKindKey, string> = { ecommerce: "E-commerce bulk booking", document: "Banking & Financial bulk booking", customer: "Customer parcel bulk booking" };
const LIST_SHEET = "Lists";
const LIST_TITLES: Record<ListKey, string> = {
  districts: "Districts",
  zones: "Zones",
  areas: "Areas",
  products: "Products",
  speeds: "Service",
  weights: "Weights (kg)",
  yesNo: "Yes / No",
};
/** Dependent lists: a zone list per district (ZN_<n>), an area list per zone (AR_<n>). */
const DEPENDENT: Partial<Record<ListKey, { prefix: string; parents: ListKey }>> = { zones: { prefix: "ZN_", parents: "districts" }, areas: { prefix: "AR_", parents: "zones" } };

export interface TemplateOptions {
  /** Rows covered by the dropdowns (the file limit). */
  maxRows: number;
  maxFileMb: number;
  /** Failed-rows download: data rows (cells by column) and their error text. */
  rows?: { cells: Partial<Record<ColumnKey, string>>; error?: string; scanId?: string }[];
  /** Scan with phone workbook: the rows carry a "Scan ID" column (last) instead of an Error column. */
  scan?: boolean;
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
  if (col.key === "recipient_phone" || col.key === "sender_phone") return "Bangladeshi mobile number: 17XXXXXXXX or 017XXXXXXXX (+880 is added)";
  if (col.list && col.strictList) {
    const values = ctx.lists[col.list];
    if (col.parent && col.list === "zones") return "A zone of the chosen district (the dropdown follows the district)";
    if (col.list === "products") return values.length ? `One of ${values.length} active ${KIND_LABEL[ctx.kind]} products (dropdown, with the product type)` : "No active products: leave empty";
    if (col.list === "speeds") return `${values.join(", ")} (the services in ${packageOwner(ctx)})`;
    return values.length <= 12 ? values.join(", ") : `One of ${values.length} options (dropdown)`;
  }
  if (col.number) return `Number from ${col.number.min} to ${col.number.max.toLocaleString("en-US")}`;
  if (col.list) return `Free text; suggestions in the dropdown${col.maxLength ? ` (up to ${col.maxLength} characters)` : ""}`;
  return col.maxLength ? `Text, up to ${col.maxLength} characters` : "Text";
}

/** Examples from live data: the first active product, a real district / zone / area. */
function examples(ctx: EngineContext): Partial<Record<ColumnKey, string>> {
  const { catalog } = ctx;
  const pickPlace = (preferred: string[]) => {
    const district = preferred.find(d => catalog.districts.includes(d) && (catalog.zonesByDistrict[d] ?? []).length) ?? catalog.districts.find(d => (catalog.zonesByDistrict[d] ?? []).length) ?? "";
    const zone = (catalog.zonesByDistrict[district] ?? [])[0] ?? "";
    return { district, zone, area: (catalog.areasByZone[zone] ?? [])[0] ?? "" };
  };
  const delivery = pickPlace(["Dhaka Central", "Dhaka South"]);
  const pickup = ctx.fileMerchant ? { district: ctx.fileMerchant.pickupDistrict, zone: ctx.fileMerchant.pickupZone, area: ctx.fileMerchant.pickupArea } : pickPlace(["Dhaka North", "Dhaka Central"]);
  return {
    district: delivery.district,
    zone: delivery.zone,
    area: delivery.area,
    pickup_district: pickup.district,
    pickup_zone: pickup.zone,
    pickup_area: pickup.area,
    product_type: ctx.lists.products[0] ?? "",
    service_level: ctx.lists.speeds[0] ?? "Regular",
  };
}

/**
 * The import template (or a failed-rows file in the same format): the data sheet with required
 * headers in red with "*", dropdowns from live data, a frozen header row; an Instructions sheet
 * written for the template's category and package; and the hidden Lists sheet the dropdowns read.
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
    const prompt = { promptTitle: col.header, prompt: col.description.slice(0, 255) };
    if (col.list && ctx.lists[col.list].length) {
      // Dependent lists use IF, not IFERROR: a list source must evaluate to a range, and Excel's
      // IFERROR returns a value, so IFERROR(INDIRECT(…), …) shows no dropdown at all.
      let formula = listName(col.list);
      const dep = DEPENDENT[col.list];
      const dependentReady = col.list === "zones" ? lists.dependentZones : col.list === "areas" ? lists.dependentAreas : false;
      if (dep && col.parent && dependentReady && cols.some(c => c.key === col.parent)) formula = dependentListFormula(letter(col.parent), listName(col.list), dep.prefix, listName(dep.parents));
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
    else if (col.key === "recipient_phone" || col.key === "sender_phone")
      validations.push({ sqref: range, type: "textLength", operator: "between", formula1: "10", formula2: "14", errorStyle: "warning", errorTitle: col.header, error: "Enter a Bangladeshi mobile number: 17XXXXXXXX or 017XXXXXXXX.", ...prompt });
    else if (col.maxLength)
      validations.push({ sqref: range, type: "textLength", operator: "lessThanOrEqual", formula1: String(col.maxLength), errorTitle: col.header, error: `Use at most ${col.maxLength} characters.`, ...prompt });
  });

  const failed = !!opts.rows && !opts.scan;
  const header: Cell[] = cols.map(col => ({ value: settings[col.key]?.required ? `${col.header} *` : col.header, style: settings[col.key]?.required ? STYLE.headerRequired : STYLE.headerOptional }));
  if (failed) header.push({ value: "Error", style: STYLE.headerRequired });
  if (opts.scan) header.push({ value: SCAN_HEADER, style: STYLE.headerOptional });
  const dataRows: Cell[][] = (opts.rows ?? []).map(r => [
    ...cols.map(col => ({ value: r.cells[col.key] ?? "", style: col.text ? STYLE.text : STYLE.normal })),
    ...(failed ? [{ value: r.error ?? "", style: STYLE.error }] : []),
    ...(opts.scan ? [{ value: r.scanId ?? "", style: STYLE.text }] : []),
  ]);
  const data: Sheet = {
    name: DATA_SHEET[ctx.kind],
    rows: [header, ...dataRows],
    widths: [...cols.map(c => c.width), ...(failed ? [60] : opts.scan ? [40] : [])],
    columnStyles: cols.map(c => (c.text ? STYLE.text : undefined)),
    freezeHeader: true,
    validations,
  };

  const banking = ctx.kind === "document";
  const customer = ctx.kind === "customer";
  const required = cols.filter(c => settings[c.key]?.required).map(c => c.header);
  const fixed = ctx.settings.defaultDestination.mode === "FIXED" ? ctx.settings.defaultDestination : null;
  const destination = fixed ? `${fixed.zone}, ${fixed.district}` : customer ? "the sender's own district (its pickup zone)" : "the merchant's own district (its pickup zone)";
  const recipient = cols.find(c => c.key === "recipient_phone")?.header.toLowerCase() ?? "recipient phone";
  const hasExpress = ctx.lists.speeds.includes("Express");
  const sample = examples(ctx);
  const who = customer
    ? `Customer parcels booked by operations (walk-in or website customers): no merchant. Fill in the sender and pickup columns on every row. Prices and services: ${packageOwner(ctx)}.`
    : ctx.fileMerchant
      ? `For ${ctx.fileMerchant.name} (${ctx.fileMerchant.code}): the Service list and the prices follow ${packageOwner(ctx)}.`
      : `No merchant chosen: the Service list shows ${packageOwner(ctx)} (the ${KIND_LABEL[ctx.kind]} default). Choose the merchant before downloading to get its own services.`;
  const intro: string[] = [
    `How to use: one parcel per row on the "${DATA_SHEET[ctx.kind]}" sheet, starting on row 2. Don't rename or reorder the header row.`,
    who,
    `Required columns have a red header with * (${required.length ? required.join(", ") : "none"}). Every other column may be left empty; a value you do enter must be valid, or the row is not created.`,
    `The ${recipient} is required: a row without it (or with an invalid number) is not created.`,
    `Rows missing the recipient name, delivery address, district or zone are created as "Needs info": priced as a delivery to ${destination}${banking ? "" : " with the weight and service defaults below"}, and held before delivery until you complete them.`,
    banking
      ? "Pricing is by district: the route from the pickup district to the delivery district (same district, Dhaka ↔ Sub-urban or different district), plus the service. Banking & Financial parcels have no weight, no cash on delivery and no product-type charge."
      : `Pricing is by district: the route from the pickup district to the delivery district (same district, Dhaka ↔ Sub-urban or different district), plus weight above 0.5 kg, the product type, the service${cols.some(c => c.key === "cod_amount") ? " and the COD fee" : ""}.${hasExpress ? " Express is same-day delivery, only inside the same district." : ""}`,
    "First mile (rider pickup or drop at a hub), the drop-off hub, last mile and the messages to send are chosen on the upload screen for the whole file, not in this sheet.",
    `Limits: at most ${opts.maxRows.toLocaleString("en-US")} rows and ${opts.maxFileMb} MB per file. Upload the .xlsx (or a CSV with the same headers).`,
    "Each row is booked once: rows already booked (same reference, or the same details without one) are not booked again.",
  ];
  const instructions: Cell[][] = [
    [{ value: `Delivery Fast · ${TITLE[ctx.kind]}`, style: STYLE.title }],
    // Not wrapped: each line overflows across the empty cells to its right.
    ...intro.map(t => [t]),
    [],
    ["Column", "Required", "Allowed values", "Default when empty", "Example", "Notes"].map(v => ({ value: v, style: STYLE.headerOptional })),
    ...cols.map(col => [
      { value: col.header, style: STYLE.bold },
      { value: settings[col.key]?.required ? "Yes" : "No", style: STYLE.wrap },
      { value: allowedText(col, ctx), style: STYLE.wrap },
      { value: settings[col.key]?.default ?? (col.key === "district" || col.key === "zone" ? `Priced to ${destination}` : ""), style: STYLE.wrap },
      { value: sample[col.key] ?? col.example, style: STYLE.wrap },
      { value: col.description, style: STYLE.wrap },
    ]),
  ];
  return writeXlsx({
    title: `Delivery Fast ${TITLE[ctx.kind]}`,
    sheets: [data, { name: "Instructions", rows: instructions, widths: [24, 16, 40, 24, 26, 60] }, lists.sheet],
    names: lists.names,
  });
}
