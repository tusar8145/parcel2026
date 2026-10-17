import { columnLetter, STYLE, writeXlsx, type Cell, type DataValidation, type Sheet } from "../imports/xlsx/xlsx-writer";
import { dependentListFormula, writeListsSheet, type ListColumn } from "../imports/import-templates";
import { ACTION_HELP, ACTION_LABEL, BULK_ACTIONS, BULK_COLUMNS, PRIORITIES, SERVICES, SHEET_NAME, settableStatusLabels, type BulkColumnKey, type BulkListKey } from "./bulk-columns";

export type BulkCells = Partial<Record<BulkColumnKey, string | number>>;

export interface BulkLists {
  hubs: { label: string; riders: string[] }[];
  /** Every rider the caller may assign ("code · name · hub"). */
  riders: string[];
  districts: string[];
  zonesByDistrict: Record<string, string[]>;
  areasByZone: Record<string, string[]>;
}

export interface BulkWorkbookOptions {
  rows: { cells: BulkCells; error?: string }[];
  lists: BulkLists;
  maxRows: number;
  maxFileMb: number;
  /** Export: what was filtered, and how many matched (to say when the file was cut at the limit). */
  filterText?: string;
  matched?: number;
  /** Failed-rows download: adds the Error column. */
  failed?: boolean;
}

const LIST_NAME: Record<BulkListKey, string> = {
  actions: "L_actions",
  riders: "L_riders",
  statuses: "L_statuses",
  hubs: "L_hubs",
  priorities: "L_priorities",
  districts: "L_districts",
  zones: "L_zones",
  areas: "L_areas",
  services: "L_services",
};

const unique = (values: string[]) => [...new Set(values.filter(Boolean))];

/**
 * The bulk update workbook: the "Parcels" sheet (read-only data greyed and locked, editable action
 * columns with dropdowns from live data, a hidden version column; protected without a password so
 * filters still work), an Instructions sheet and the hidden Lists sheet the dropdowns read.
 */
export function buildBulkWorkbook(opts: BulkWorkbookOptions): Buffer {
  const cols = BULK_COLUMNS;
  const { lists } = opts;
  const zones = unique(lists.districts.flatMap(d => lists.zonesByDistrict[d] ?? []));
  const listColumns: ListColumn[] = [
    { title: "Actions", values: BULK_ACTIONS.map(a => ACTION_LABEL[a]), name: LIST_NAME.actions },
    { title: "Riders", values: lists.riders, name: LIST_NAME.riders },
    { title: "New status", values: settableStatusLabels(), name: LIST_NAME.statuses },
    { title: "Hubs", values: lists.hubs.map(h => h.label), name: LIST_NAME.hubs },
    { title: "Priority", values: [...PRIORITIES], name: LIST_NAME.priorities },
    { title: "Services", values: [...SERVICES], name: LIST_NAME.services },
    { title: "Districts", values: lists.districts, name: LIST_NAME.districts },
    { title: "Zones", values: zones, name: LIST_NAME.zones },
    { title: "Areas", values: unique(zones.flatMap(z => lists.areasByZone[z] ?? [])), name: LIST_NAME.areas },
    // Riders of each hub (RD_<n> = the n-th hub of L_hubs): the Rider list follows the Hub column.
    ...lists.hubs.map((h, i) => ({ title: `Riders · ${h.label}`, values: h.riders, name: `RD_${i + 1}` })),
    ...lists.districts.map((d, i) => ({ title: `Zones · ${d}`, values: lists.zonesByDistrict[d] ?? [], name: `ZN_${i + 1}` })),
    ...zones.map((z, i) => ({ title: `Areas · ${z}`, values: lists.areasByZone[z] ?? [], name: `AR_${i + 1}` })),
  ];
  const listsSheet = writeListsSheet(listColumns);

  const letter = (key: BulkColumnKey) => columnLetter(cols.findIndex(c => c.key === key));
  const last = Math.max(2, opts.rows.length + 1);
  const validations: DataValidation[] = [];
  cols.forEach((col, i) => {
    if (!col.editable) return;
    const range = `${columnLetter(i)}2:${columnLetter(i)}${last}`;
    const prompt = { promptTitle: col.header, prompt: col.description };
    if (col.list) {
      let formula = LIST_NAME[col.list];
      if (col.key === "rider" && lists.hubs.length) formula = dependentListFormula(letter("hub"), LIST_NAME.riders, "RD_", LIST_NAME.hubs);
      if (col.key === "set_zone") formula = dependentListFormula(letter("set_district"), LIST_NAME.zones, "ZN_", LIST_NAME.districts);
      if (col.key === "set_area") formula = dependentListFormula(letter("set_zone"), LIST_NAME.areas, "AR_", LIST_NAME.zones);
      validations.push({
        sqref: range,
        type: "list",
        formula1: formula,
        errorStyle: col.strict ? "stop" : "warning",
        errorTitle: col.header,
        error: col.strict ? `Choose ${col.header.toLowerCase()} from the list.` : "Not in the list. It is checked when you upload the file.",
        ...prompt,
      });
    } else if (col.number)
      validations.push({ sqref: range, type: "decimal", operator: "between", formula1: String(col.number.min), formula2: String(col.number.max), errorTitle: col.header, error: `Enter a number from ${col.number.min} to ${col.number.max}.`, ...prompt });
    else if (col.key === "set_recipient_phone")
      validations.push({ sqref: range, type: "textLength", operator: "between", formula1: "10", formula2: "14", errorStyle: "warning", errorTitle: col.header, error: "Enter a Bangladeshi mobile number: 17XXXXXXXX or 017XXXXXXXX.", ...prompt });
    else if (col.maxLength) validations.push({ sqref: range, type: "textLength", operator: "lessThanOrEqual", formula1: String(col.maxLength), errorTitle: col.header, error: `Use at most ${col.maxLength} characters.`, ...prompt });
  });

  const header: Cell[] = cols.map(c => ({ value: c.header, style: c.editable ? STYLE.headerOptional : STYLE.headerReadonly }));
  if (opts.failed) header.push({ value: "Error", style: STYLE.headerRequired });
  const cellStyle = (key: BulkColumnKey) => {
    const col = cols.find(c => c.key === key)!;
    return col.editable ? (col.text ? STYLE.editableText : STYLE.editable) : STYLE.readonly;
  };
  const dataRows: Cell[][] = opts.rows.map(r => [
    ...cols.map(c => ({ value: r.cells[c.key] ?? "", style: cellStyle(c.key) })),
    ...(opts.failed ? [{ value: r.error ?? "", style: STYLE.error }] : []),
  ]);
  const data: Sheet = {
    name: SHEET_NAME,
    rows: [header, ...dataRows],
    widths: [...cols.map(c => c.width), ...(opts.failed ? [60] : [])],
    columnStyles: [...cols.map(c => cellStyle(c.key)), ...(opts.failed ? [STYLE.editable] : [])],
    hiddenColumns: cols.flatMap((c, i) => (c.hidden ? [i] : [])),
    freezeHeader: true,
    autoFilter: true,
    protect: true,
    validations,
  };

  const cut = opts.matched !== undefined && opts.matched > opts.rows.length;
  const intro: string[] = [
    `How to use: on the "${SHEET_NAME}" sheet choose an Action for each parcel you want to change and fill the columns it needs (blue headers). Rows with an empty Action are ignored.`,
    "Grey columns are the parcel's data when you downloaded it and are locked. The sheet is protected without a password so nothing is typed over by mistake: filtering works as usual; to sort or edit grey cells use Review → Unprotect Sheet (no password).",
    "Upload the file in Courier Operations (Bulk update by Excel → Upload). Every row is checked first and shown in a preview (will apply / warnings / errors); nothing changes until you press Apply.",
    "Each row is applied on its own through the normal parcel workflow: lifecycle rules, hub scope, rider checks, notifications, webhooks and the audit log are the same as for a single action. One failed row doesn't stop the others.",
    "A parcel changed by someone else after you downloaded the file is refused (\"changed since you downloaded it\"): download a fresh file for it. Uploading the same file again doesn't apply a row twice; rows already done are reported as \"already done\".",
    `Limits: at most ${opts.maxRows.toLocaleString("en-US")} rows and ${opts.maxFileMb} MB per file; one parcel per row (a parcel listed twice is refused).${cut ? ` This file holds the first ${opts.rows.length.toLocaleString("en-US")} of ${opts.matched!.toLocaleString("en-US")} matching parcels: narrow the filters to get the rest.` : ""}`,
    ...(opts.filterText ? [`Downloaded: ${opts.filterText}.`] : []),
  ];
  const instructions: Cell[][] = [
    [{ value: "Delivery Fast · Bulk operations by Excel", style: STYLE.title }],
    ...intro.map(t => [t]),
    [],
    ["Action", "Columns it needs", "What it does"].map(v => ({ value: v, style: STYLE.headerOptional })),
    ...BULK_ACTIONS.map(a => [
      { value: ACTION_LABEL[a], style: STYLE.bold },
      { value: ACTION_HELP[a].needs, style: STYLE.wrap },
      { value: ACTION_HELP[a].does, style: STYLE.wrap },
    ]),
    [],
    ["Column", "Editable", "Notes"].map(v => ({ value: v, style: STYLE.headerOptional })),
    ...cols.filter(c => !c.hidden).map(c => [{ value: c.header, style: STYLE.bold }, { value: c.editable ? "Yes" : "No (locked)", style: STYLE.wrap }, { value: c.description, style: STYLE.wrap }]),
    [],
    [{ value: "Rules", style: STYLE.bold }],
    ["Riders must be active; hub operators can choose only their own hubs' riders. A rider who is off shift, on break or over capacity gives a warning (the row still applies)."],
    ["A delivery rider can only be assigned when the recipient name, phone, address, district and zone are known: complete a \"Needs info\" order first (or in the same row)."],
    ["Change status follows the parcel lifecycle; Delivered is never set here (only the rider, with proof and COD)."],
    ["Leave Rider empty on an \"Accept & assign pickup rider\" or \"Assign delivery rider\" row to accept the Suggested rider."],
  ];

  return writeXlsx({
    title: "Delivery Fast bulk update",
    sheets: [data, { name: "Instructions", rows: instructions, widths: [30, 50, 90] }, listsSheet.sheet],
    names: listsSheet.names,
  });
}
