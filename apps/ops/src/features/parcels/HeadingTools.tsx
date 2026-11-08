/** Parcel list heading tools: Print… (formats), Export (Excel), and links to tools still served by the classic console. */
import { Select } from "@panel/ui/Select";
import { chooseClassic } from "@/app/links";
import { useState } from "react";
import { Icon, type IconName } from "@panel/ui/Icon";
import { Button } from "@panel/ui/kit";
import { toast, toastError } from "@panel/ui/toast";
import { num } from "@panel/lib/format";
import { PDF_LIMITS, PRINT_FORMATS, printFormat } from "./actions";
import type { ParcelListState } from "./useParcelList";

/** "Print…": prints the ticked rows, else every parcel the filters match (up to the PDF limit). */
export function PrintMenu({ list, line, title }: { list: ParcelListState; line?: string; title: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <span className="row" style={{ gap: 0 }}>
      <Select
        className="select"
        searchable={false}
        icon="print"
        aria-label="Print: choose what to print"
        title="Prints the ticked rows, else the rows on screen"
        value=""
        disabled={busy}
        style={{ width: 130, fontWeight: 600 }}
        onChange={async e => {
          const format = e.target.value;
          if (!format) return;
          const cap = format === "orders" ? PDF_LIMITS["parcel-list"] : format === "label" ? PDF_LIMITS.labels : PDF_LIMITS.invoices;
          setBusy(true);
          try {
            const picked = await list.printIds(cap);
            if (!picked.ids.length) return toast("No filtered or selected records are available to print.");
            if (picked.capped) toast(`Printing the first ${num(cap)} matching parcels (the most per PDF). Narrow the filter for the rest.`);
            await printFormat(format, picked.ids, title);
          } catch (error) {
            toastError(error);
          } finally {
            setBusy(false);
          }
        }}
      >
        <option value="" hidden>{busy ? "Preparing…" : "Print…"}</option>
        {PRINT_FORMATS.map(f => (
          <option key={f.value} value={f.value} disabled={!!f.line && !!line && f.line !== line}>
            {f.label}
          </option>
        ))}
      </Select>
    </span>
  );
}

export function ExportButton({ list }: { list: ParcelListState }) {
  return (
    <Button icon="download" onClick={() => list.exportExcel()}>
      Export
    </Button>
  );
}

/** A tool still served by the classic console (opens there, same session, same data). */
export function ClassicLink({ page, tab, label, icon, primary }: { page: string; tab?: string; label: string; icon?: IconName; primary?: boolean }) {
  const href = `/courier-operation?classic=1&page=${encodeURIComponent(page)}${tab ? `&tab=${encodeURIComponent(tab)}` : ""}`;
  return (
    <a className={`button ${primary ? "primary" : ""}`} href={href} target="_blank" rel="noopener" title={`${label} (opens the classic console in a new tab)`} onClick={chooseClassic}>
      {icon ? <Icon name={icon} /> : null}
      {label}
      <Icon name="external" size={12} />
    </a>
  );
}
