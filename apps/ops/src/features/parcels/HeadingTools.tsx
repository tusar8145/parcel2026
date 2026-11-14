/** Parcel list heading tools: Printâ€¦ (formats), Export (Excel). */
import { Select } from "@panel/ui/Select";
import { useState } from "react";
import { Button } from "@panel/ui/kit";
import { toast, toastError } from "@panel/ui/toast";
import { num } from "@panel/lib/format";
import { PDF_LIMITS, PRINT_FORMATS, printFormat } from "./actions";
import type { ParcelListState } from "./useParcelList";

/** "Printâ€¦": prints the ticked rows, else every parcel the filters match (up to the PDF limit). */
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
        <option value="" hidden>{busy ? "Preparingâ€¦" : "Printâ€¦"}</option>
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
