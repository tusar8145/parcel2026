import { columnLetter, STYLE, writeXlsx, type Cell, type DataValidation, type Sheet } from "../imports/xlsx/xlsx-writer";
import { dependentListFormula, writeListsSheet, type ListColumn } from "../imports/import-templates";
import { PRIORITIES, SERVICES, type BulkColumnKey, type BulkListKey } from "./bulk-columns";
import { ACTIONS, columnsOf, templateValue, type BulkActionId } from "./bulk-actions";
import { jobTitle, KINDS, statusLabels, type BulkKind } from "./bulk-kinds";

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
  /** The page the file is for. */
  kind: BulkKind;
  /** The action template: its columns, title and instructions. */
  action: BulkActionId;
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

/** The sheet tabs of every action template (the upload reads whichever is there). */
export const DATA_SHEETS = [...new Set(Object.values(ACTIONS).map(a => a.sheet)), "Parcels"];

/**
 * The bulk update workbook of one action: the data sheet named after the action (read-only data
 * greyed and locked, only the columns the action needs editable, with dropdowns from live data; hidden
 * version and template columns; protected without a password so filters still work), an Instructions
 * sheet for the action and the hidden Lists sheet the dropdowns read. No Action column: the file is
 * the action.
 */
export function buildBulkWorkbook(opts: BulkWorkbookOptions): Buffer {
  const def = KINDS[opts.kind];
  const t = ACTIONS[opts.action];
  const cols = columnsOf(t);
  const has = (key: BulkColumnKey) => cols.some(c => c.key === key);
  const { lists } = opts;
  const zones = unique(lists.districts.flatMap(d => lists.zonesByDistrict[d] ?? []));
  const withDetails = has("set_district");
  const listColumns: ListColumn[] = [
    ...(has("rider") ? [{ title: "Riders", values: lists.riders, name: LIST_NAME.riders }] : []),
    ...(has("new_status") ? [{ title: "New status", values: statusLabels(t.statuses ?? []), name: LIST_NAME.statuses }] : []),
    ...(has("hub") ? [{ title: "Hubs", values: lists.hubs.map(h => h.label), name: LIST_NAME.hubs }] : []),
    ...(has("priority") ? [{ title: "Priority", values: [...PRIORITIES], name: LIST_NAME.priorities }] : []),
    ...(withDetails
      ? [
          { title: "Services", values: [...SERVICES], name: LIST_NAME.services },
          { title: "Districts", values: lists.districts, name: LIST_NAME.districts },
          { title: "Zones", values: zones, name: LIST_NAME.zones },
          { title: "Areas", values: unique(zones.flatMap(z => lists.areasByZone[z] ?? [])), name: LIST_NAME.areas },
        ]
      : []),
    // Riders of each hub (RD_<n> = the n-th hub of L_hubs): the Rider list follows the Hub column.
    ...(has("rider") && has("hub") ? lists.hubs.map((h, i) => ({ title: `Riders · ${h.label}`, values: h.riders, name: `RD_${i + 1}` })) : []),
    ...(withDetails ? lists.districts.map((d, i) => ({ title: `Zones · ${d}`, values: lists.zonesByDistrict[d] ?? [], name: `ZN_${i + 1}` })) : []),
    ...(withDetails ? zones.map((z, i) => ({ title: `Areas · ${z}`, values: lists.areasByZone[z] ?? [], name: `AR_${i + 1}` })) : []),
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
      if (col.key === "rider" && lists.hubs.length && has("hub")) formula = dependentListFormula(letter("hub"), LIST_NAME.riders, "RD_", LIST_NAME.hubs);
      if (col.key === "set_zone") formula = dependentListFormula(letter("set_district"), LIST_NAME.zones, "ZN_", LIST_NAME.districts);
      if (col.key === "set_area") formula = dependentListFormula(letter("set_zone"), LIST_NAME.areas, "AR_", LIST_NAME.zones);
      validations.push({
        sqref: range,
        type: "list",
        formula1: formula,
        errorStyle: col.strict ? "stop" : "warning",
        errorTitle: col.header,
        error: col.strict ? `Choose ${col.header.replace(/\s*\*$/, "").toLowerCase()} from the list.` : "Not in the list. It is checked when you upload the file.",
        ...prompt,
      });
    } else if (col.number)
      validations.push({ sqref: range, type: "decimal", operator: "between", formula1: String(col.number.min), formula2: String(col.number.max), errorTitle: col.header, error: `Enter a number from ${col.number.min} to ${col.number.max}.`, ...prompt });
    else if (col.key === "set_recipient_phone")
      validations.push({ sqref: range, type: "textLength", operator: "between", formula1: "10", formula2: "14", errorStyle: "warning", errorTitle: col.header, error: "Enter a Bangladeshi mobile number: 17XXXXXXXX or 017XXXXXXXX.", ...prompt });
    else if (col.maxLength) validations.push({ sqref: range, type: "textLength", operator: "lessThanOrEqual", formula1: String(col.maxLength), errorTitle: col.header, error: `Use at most ${col.maxLength} characters.`, ...prompt });
  });

  const header: Cell[] = cols.map(c => ({ value: c.header, style: c.editable ? (c.required ? STYLE.headerRequired : STYLE.headerOptional) : STYLE.headerReadonly }));
  if (opts.failed) header.push({ value: "Error", style: STYLE.headerRequired });
  const cellStyle = (key: BulkColumnKey) => {
    const col = cols.find(c => c.key === key)!;
    return col.editable ? (col.text ? STYLE.editableText : STYLE.editable) : STYLE.readonly;
  };
  const template = templateValue(opts.kind, opts.action);
  const dataRows: Cell[][] = opts.rows.map(r => [
    ...cols.map(c => ({ value: c.key === "template" ? template : (r.cells[c.key] ?? ""), style: cellStyle(c.key) })),
    ...(opts.failed ? [{ value: r.error ?? "", style: STYLE.error }] : []),
  ]);
  const data: Sheet = {
    name: t.sheet,
    rows: [header, ...dataRows],
    widths: [...cols.map(c => c.width), ...(opts.failed ? [60] : [])],
    columnStyles: [...cols.map(c => cellStyle(c.key)), ...(opts.failed ? [STYLE.editable] : [])],
    hiddenColumns: cols.flatMap((c, i) => (c.hidden ? [i] : [])),
    freezeHeader: true,
    autoFilter: true,
    protect: true,
    validations,
  };

  const title = jobTitle(opts.kind, opts.action);
  const cut = opts.matched !== undefined && opts.matched > opts.rows.length;
  const fill = cols.filter(c => c.editable).map(c => c.header);
  const intro: string[] = [
    `${t.label}: ${t.howTo}`,
    `What it does: ${t.does}`,
    `This file lists ${t.parcels}${opts.kind === "all" ? "" : ` on the ${def.page} page (${def.scope})`}. Only the parcels that can take this action now are in it.`,
    `Columns to fill in (blue headers; * = required in every row you keep): ${fill.join(", ")}. Grey columns are the parcel's data when you downloaded it and are locked. The sheet is protected without a password so nothing is typed over by mistake: filtering works as usual; to sort or edit grey cells use Review → Unprotect Sheet (no password).`,
    `Upload it in Courier Operations on the ${def.page} page: Bulk update ${def.page} by Excel → choose "${t.label}" → Upload${opts.kind === "all" ? "" : ` (or on All parcels with the same action)`}. A file of another action${opts.kind === "all" ? "" : " or page"} is refused. Every row is checked first and shown in a preview (will apply / warnings / errors); nothing changes until you press Apply.`,
    "Each row is applied on its own through the normal parcel workflow: lifecycle rules, hub scope, rider checks, notifications, webhooks and the audit log are the same as for a single action. One failed row doesn't stop the others.",
    "A parcel changed by someone else after you downloaded the file is refused (\"changed since you downloaded it\"): download a fresh file for it. Uploading the same file again doesn't apply a row twice; rows already done are reported as \"already done\".",
    `Limits: at most ${opts.maxRows.toLocaleString("en-US")} rows and ${opts.maxFileMb} MB per file; one parcel per row (a parcel listed twice is refused).${cut ? ` This file holds the first ${opts.rows.length.toLocaleString("en-US")} of ${opts.matched!.toLocaleString("en-US")} matching parcels: narrow the filters to get the rest.` : ""}`,
    ...(opts.filterText ? [`Downloaded: ${opts.filterText}.`] : []),
  ];
  const instructions: Cell[][] = [
    [{ value: `Delivery Fast · ${title}`, style: STYLE.title }],
    ...intro.map(text => [text]),
    [],
    ["Column", "Editable", "Notes"].map(v => ({ value: v, style: STYLE.headerOptional })),
    ...cols
      .filter(c => !c.hidden)
      .map(c => [{ value: c.header, style: STYLE.bold }, { value: c.editable ? (c.required ? "Yes (required)" : "Yes") : "No (locked)", style: STYLE.wrap }, { value: c.description, style: STYLE.wrap }]),
    [],
    [{ value: "Rules", style: STYLE.bold }],
    ...rules(opts.action, has),
  ];

  return writeXlsx({
    title: `Delivery Fast ${title}`,
    sheets: [data, { name: "Instructions", rows: instructions, widths: [30, 50, 90] }, listsSheet.sheet],
    names: listsSheet.names,
  });
}

/** The Instructions sheet's rules that apply to the action. */
function rules(id: BulkActionId, has: (key: BulkColumnKey) => boolean): string[][] {
  const t = ACTIONS[id];
  const out: string[] = [];
  out.push(t.skipBlank ? "Rows whose input columns are all empty are skipped." : "Every row in the file is applied: delete the rows you don't want to change.");
  if (has("rider")) out.push("Riders must be active; hub operators can choose only their own hubs' riders. A rider who is off shift, on break or over capacity gives a warning (the row still applies).");
  if (has("suggested_rider")) out.push("Leave Rider empty to use the Suggested rider.");
  if (has("priority")) out.push("Rows with Priority High are applied first (they get riders before the others).");
  if (t.action === "ASSIGN_DELIVERY") out.push('A delivery rider can only be assigned when the recipient name, phone, address, district and zone are known: fill the Set … columns of a "Needs info" order in the same row.');
  if (t.action === "SET_STATUS") out.push("Status changes follow the parcel lifecycle; Delivered is never set here (only the rider, with proof and COD).");
  if (has("set_district")) out.push("Set zone follows Set district and Set area follows Set zone. The order is re-priced with the tariff frozen at booking; the preview shows the new price.");
  out.push("Hub operators work only on their own hubs' parcels.");
  return out.map(text => [text]);
}
