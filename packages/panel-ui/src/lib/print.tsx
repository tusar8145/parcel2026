/**
 * PDFs in every React panel (shared/print.js): the API makes them (modules/documents) and they open in a new tab,
 * first a "Preparing…" page, then the PDF viewer with the file name and Download.
 */
import { apiRaw, describe } from "./api";
import { num } from "./format";
import { openForm } from "../ui/dialogs";
import { toast } from "../ui/toast";

// ── PDFs (shared/print.js): the API makes them; they open in a new tab ──

export const PDF_LIMITS = { labels: 2000, invoices: 1000, "parcel-list": 5000 } as const;
const LABEL_FORMAT_KEY = "deliveryfast-label-format";
const savedLabelFormat = () => {
  try {
    return localStorage.getItem(LABEL_FORMAT_KEY) === "thermal" ? "thermal" : "a4";
  } catch {
    return "a4";
  }
};

const escHtml = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** The new tab's own page while the PDF is made, or when it couldn't be (shared/print.js page()). */
const waitPage = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${escHtml(title)}</title><style>body{margin:0;font:14px/1.5 system-ui,-apple-system,"Segoe UI",Arial,sans-serif;color:#182230;background:#f4f5f7;display:grid;place-items:center;min-height:100vh}main{background:#fff;border:1px solid #d5dbe3;border-radius:12px;padding:28px 32px;max-width:460px;text-align:center;box-shadow:0 8px 30px rgba(16,24,40,.08)}h1{font-size:17px;margin:0 0 6px}p{margin:0;color:#5f6b7a}.spin{width:28px;height:28px;border:3px solid #e4e8ee;border-top-color:#d69e00;border-radius:50%;margin:0 auto 14px;animation:s .8s linear infinite}@keyframes s{to{transform:rotate(360deg)}}button{margin-top:16px;font:inherit;padding:7px 14px;border-radius:8px;border:1px solid #c5ccd6;background:#fff;cursor:pointer}</style></head><body><main>${body}</main></body></html>`;
const writeTab = (tab: Window, html: string) => {
  tab.document.open();
  tab.document.write(html);
  tab.document.close();
};
/** The browser's PDF viewer (print, zoom, save) under a slim bar with the file name and a Download link that keeps it. */
const viewerPage = (url: string, name: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${escHtml(name)}</title><style>html,body{margin:0;height:100%;background:#525659;font:13px system-ui,-apple-system,"Segoe UI",Arial,sans-serif}.bar{height:40px;box-sizing:border-box;display:flex;align-items:center;gap:12px;padding:0 14px;background:#182230;color:#fff}.bar strong{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.bar a{color:#182230;background:#f2c94c;border-radius:6px;padding:5px 12px;text-decoration:none;font-weight:600}iframe{display:block;border:0;width:100%;height:calc(100% - 40px)}</style></head><body><div class="bar"><strong>${escHtml(name)}</strong><a href="${url}" download="${escHtml(name)}">Download PDF</a></div><iframe src="${url}" title="${escHtml(name)}"></iframe></body></html>`;

/**
 * Fetches a PDF from the API and shows it in a tab opened during the click (pop-up blockers allow it): a "Preparing…"
 * page first, then the PDF viewer with the file name and Download; an error shows in the tab and as a toast
 * (shared/print.js DFPrint.open).
 */
export async function openDocument(path: string, { method = "GET", body, title = "Preparing your PDF…" }: { method?: string; body?: unknown; title?: string } = {}) {
  const tab = window.open("", "_blank");
  if (tab) {
    try {
      writeTab(tab, waitPage(title, `<div class="spin" role="status" aria-label="Loading"></div><h1>${escHtml(title)}</h1><p>The PDF opens here in a moment.</p>`));
    } catch {
      /* the tab may already be navigating */
    }
  }
  try {
    const response = await apiRaw(path, body ? { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } } : { method });
    const blob = await response.blob();
    const url = URL.createObjectURL(blob.type === "application/pdf" ? blob : new Blob([blob], { type: "application/pdf" }));
    // Kept a while: the viewer re-reads it to save or print.
    setTimeout(() => URL.revokeObjectURL(url), 15 * 60_000);
    const name = /filename="?([^";]+)"?/.exec(response.headers.get("content-disposition") || "")?.[1] || "delivery-fast.pdf";
    if (tab && !tab.closed) {
      try {
        writeTab(tab, viewerPage(url, name));
      } catch {
        tab.location.replace(url);
      }
    } else {
      const link = Object.assign(document.createElement("a"), { href: url, download: name });
      document.body.append(link);
      link.click();
      link.remove();
      toast("Pop-ups are blocked, so the PDF was downloaded instead.");
    }
    const count = Number(response.headers.get("x-document-count") || 0) || null;
    const missing = Number(response.headers.get("x-missing-count") || 0);
    if (missing) toast(`${missing} parcel${missing === 1 ? " was" : "s were"} not found or ${missing === 1 ? "is" : "are"} outside your access, and left out of the PDF.`);
    return { count, missing, name };
  } catch (error) {
    const message = describe(error);
    if (tab && !tab.closed) {
      try {
        writeTab(tab, waitPage("Couldn't create the PDF", `<h1>Couldn't create the PDF</h1><p>${escHtml(message)}</p><button type="button" onclick="window.close()">Close this tab</button>`));
      } catch {
        tab.close();
      }
    }
    toast(`Couldn't create the PDF: ${message}`, "bad");
    return null;
  }
}

/** Parcel documents for tracking IDs: GET for short lists, POST for long ones. */
export function parcelDocuments(kind: keyof typeof PDF_LIMITS, ids: string[], params: Record<string, string> = {}, title?: string) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return void toast("Select the parcels to print first (tick rows or filter the list).");
  if (list.length > PDF_LIMITS[kind]) return void toast(`At most ${num(PDF_LIMITS[kind])} parcels per PDF; you selected ${num(list.length)}. Narrow the filter or tick fewer rows.`, "bad");
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
  const joined = list.join(",");
  if (joined.length < 1500) {
    query.set("ids", joined);
    return openDocument(`/documents/${kind}?${query}`, { title });
  }
  return openDocument(`/documents/${kind}`, { method: "POST", body: { ...params, ids: list }, title });
}

/** Print labels: asks the format (A4 sheet or thermal), remembered on this computer. */
export async function printLabels(ids: string[]) {
  const unique = [...new Set(ids)];
  if (!unique.length) return toast("Select the parcels whose labels you want to print.");
  if (unique.length > PDF_LIMITS.labels) return toast(`Print at most ${num(PDF_LIMITS.labels)} labels at a time (${num(unique.length)} selected).`, "bad");
  const v = await openForm({
    title: "Print labels",
    description: `${unique.length} parcel${unique.length === 1 ? "" : "s"}. Each label shows the tracking ID as a Code 128 barcode, the COD to collect, the recipient, the hubs and a tracking QR code.`,
    submit: "Open PDF",
    fields: [
      {
        id: "format",
        label: "Label format",
        type: "select",
        required: true,
        value: savedLabelFormat(),
        full: true,
        options: [
          { value: "a4", label: "A4 sheet · 4 labels per page (PDF)" },
          { value: "thermal", label: "Labels · thermal 4 × 6 in (100 × 150 mm) · one per page (PDF)" },
        ],
      },
    ],
  });
  if (!v) return;
  try {
    localStorage.setItem(LABEL_FORMAT_KEY, v.format);
  } catch {
    /* storage blocked */
  }
  const r = await parcelDocuments("labels", unique, { format: v.format }, "Preparing labels…");
  if (r) toast(`${r.count ?? unique.length} label${(r.count ?? unique.length) === 1 ? "" : "s"} opened as a PDF${v.format === "thermal" ? " (100 × 150 mm)" : " (A4, 4 per page)"}.`, "good");
}

/** The Print… menu choices on parcel lists (02.js courierPrintFormat). */
export const PRINT_FORMATS: { value: string; label: string; line?: string }[] = [
  { value: "invoice", label: "All invoices · A4" },
  { value: "invoice-document", label: "Document invoices · A4", line: "BANKING_FINANCIAL" },
  { value: "invoice-ecommerce", label: "E-commerce invoices · A4", line: "ECOMMERCE" },
  { value: "invoice-customer", label: "Customer parcel invoices · A4", line: "CUSTOMER" },
  { value: "invoice-4", label: "4 invoices · A4" },
  { value: "invoice-8", label: "8 invoices · A4" },
  { value: "pos", label: "Invoice · POS 80mm" },
  { value: "label", label: "Shipment labels" },
  { value: "orders", label: "Order / shipment list" },
];
const INVOICE: Record<string, [string, string]> = {
  invoice: ["a4", "all"],
  "invoice-ecommerce": ["a4", "ecommerce"],
  "invoice-document": ["a4", "document"],
  "invoice-customer": ["a4", "customer"],
  "invoice-4": ["a4-4", "all"],
  "invoice-8": ["a4-8", "all"],
  pos: ["pos", "all"],
};
export function printFormat(format: string, ids: string[], title: string) {
  const invoice = INVOICE[format];
  if (invoice) return parcelDocuments("invoices", ids, { layout: invoice[0], line: invoice[1] }, "Preparing invoices…");
  if (format === "label") return parcelDocuments("labels", ids, { format: savedLabelFormat() }, "Preparing labels…");
  return parcelDocuments("parcel-list", ids, { title }, "Preparing the list…");
}

