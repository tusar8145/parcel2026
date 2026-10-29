/*
 * Printing in every panel: the API generates a PDF (modules/documents) and it opens in a new tab.
 *
 *   DFPrint.open(path, { method, body, title, button })  any /documents/… endpoint
 *   DFPrint.parcels(kind, ids, params)                    labels | invoices | parcel-list for tracking IDs
 *   DFPrint.labels(ids, format)                           shipping labels, format "a4" | "thermal"
 *   DFPrint.invoices(ids, layout, line)                   delivery invoices, layout "a4" | "a4-4" | "a4-8" | "pos"
 *   DFPrint.list(ids, title)                              order / shipment list
 *   DFPrint.LIMITS                                        most parcels per PDF (the API refuses more)
 *
 * The API needs the bearer token, so a plain link can't open the PDF: the tab is opened at once
 * (inside the click, so pop-up blockers allow it) with a "Preparing…" page, the PDF is fetched
 * with the session (DF.apiRaw) and the tab shows it (blob URL in the browser's PDF viewer, with a
 * Download link that keeps the file name). Errors show in the tab and as a toast. The clicked button shows "Preparing PDF…" meanwhile.
 */
(() => {
  // window.DF (shared/api.js) is read when printing, so the load order only needs api.js first.
  const LIMITS = { labels: 2000, invoices: 1000, "parcel-list": 5000 };
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const toast = message => (typeof window.showToast === "function" ? window.showToast(message) : console.info(message));

  // The last button clicked: it shows the busy state when the caller doesn't pass one.
  let lastButton = null;
  let lastAt = 0;
  window.addEventListener(
    "click",
    event => {
      lastButton = event.target.closest?.("button, a.button, [role=button]") || null;
      lastAt = Date.now();
    },
    true,
  );

  const page = (title, body) =>
    `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{margin:0;font:14px/1.5 system-ui,-apple-system,"Segoe UI",Arial,sans-serif;color:#182230;background:#f3f5f8;display:grid;place-items:center;min-height:100vh}main{background:#fff;border:1px solid #d5dbe3;border-radius:12px;padding:28px 32px;max-width:460px;text-align:center;box-shadow:0 8px 30px rgba(16,24,40,.08)}h1{font-size:17px;margin:0 0 6px}p{margin:0;color:#5f6b7a}.spin{width:28px;height:28px;border:3px solid #e4e8ee;border-top-color:#d69e00;border-radius:50%;margin:0 auto 14px;animation:s 0.8s linear infinite}@keyframes s{to{transform:rotate(360deg)}}button{margin-top:16px;font:inherit;padding:7px 14px;border-radius:8px;border:1px solid #c5ccd6;background:#fff;cursor:pointer}</style></head><body><main>${body}</main></body></html>`;

  function busy(button, on) {
    if (!button || !button.isConnected) return;
    if (on) {
      button.dataset.dfPrintLabel = button.textContent;
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      button.textContent = "Preparing PDF…";
    } else {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      if (button.dataset.dfPrintLabel != null) button.textContent = button.dataset.dfPrintLabel;
      delete button.dataset.dfPrintLabel;
    }
  }

  /**
   * The tab shows the browser's PDF viewer (print, zoom, save) under a slim bar with the file name and
   * a Download link that keeps the real file name (a blob: URL alone would save as a random id).
   */
  function show(tab, url, name) {
    try {
      tab.document.open();
      tab.document.write(
        `<!doctype html><html><head><meta charset="utf-8"><title>${esc(name)}</title><style>html,body{margin:0;height:100%;background:#525659;font:13px system-ui,-apple-system,"Segoe UI",Arial,sans-serif}.bar{height:40px;box-sizing:border-box;display:flex;align-items:center;gap:12px;padding:0 14px;background:#182230;color:#fff}.bar strong{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.bar a{color:#182230;background:#f2c94c;border-radius:6px;padding:5px 12px;text-decoration:none;font-weight:600}iframe{display:block;border:0;width:100%;height:calc(100% - 40px)}</style></head><body><div class="bar"><strong>${esc(name)}</strong><a href="${url}" download="${esc(name)}">Download PDF</a></div><iframe id="pdf" src="${url}" title="${esc(name)}"></iframe></body></html>`,
      );
      tab.document.close();
    } catch {
      tab.location.replace(url);
    }
  }

  /** Fetches a PDF from the API and shows it in a new tab. Resolves to { count, missing } or null on error. */
  async function open(path, { method = "GET", body, title = "Preparing your PDF…", button } = {}) {
    const btn = button || (Date.now() - lastAt < 1500 ? lastButton : null);
    const tab = window.open("", "_blank");
    if (tab) {
      try {
        tab.document.write(page(title, `<div class="spin" role="status" aria-label="Loading"></div><h1>${esc(title)}</h1><p>The PDF opens here in a moment.</p>`));
        tab.document.close();
      } catch {
        /* the tab may already be navigating */
      }
    }
    busy(btn, true);
    try {
      const response = await window.DF.apiRaw(path, body ? { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } } : { method });
      const blob = await response.blob();
      const pdf = blob.type === "application/pdf" ? blob : new Blob([blob], { type: "application/pdf" });
      const url = URL.createObjectURL(pdf);
      // Keep the URL alive for a while: the viewer re-reads it to save or print.
      setTimeout(() => URL.revokeObjectURL(url), 15 * 60_000);
      const name = (response.headers.get("content-disposition") || "").match(/filename="?([^";]+)"?/)?.[1] || "paira-express.pdf";
      if (tab && !tab.closed) show(tab, url, name);
      else {
        // Pop-ups blocked: save the file instead.
        const link = document.createElement("a");
        link.href = url;
        link.download = name;
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
      const message = window.DF?.describe ? window.DF.describe(error) : String(error?.message || error);
      if (tab && !tab.closed) {
        try {
          tab.document.open();
          tab.document.write(page("Couldn't create the PDF", `<h1>Couldn't create the PDF</h1><p>${esc(message)}</p><button type="button" onclick="window.close()">Close this tab</button>`));
          tab.document.close();
        } catch {
          tab.close();
        }
      }
      toast(`Couldn't create the PDF: ${message}`);
      return null;
    } finally {
      busy(btn, false);
    }
  }

  /** Parcel documents for tracking IDs: GET for short lists, POST for long ones (URLs have a size limit). */
  function parcels(kind, ids, params = {}, options = {}) {
    const list = [...new Set((ids || []).filter(Boolean))];
    if (!list.length) {
      toast("Select the parcels to print first (tick rows or filter the list).");
      return Promise.resolve(null);
    }
    const max = LIMITS[kind] || 1000;
    if (list.length > max) {
      toast(`At most ${max.toLocaleString("en-US")} parcels per PDF; you selected ${list.length.toLocaleString("en-US")}. Narrow the filter or tick fewer rows.`);
      return Promise.resolve(null);
    }
    const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ""));
    const joined = list.join(",");
    if (joined.length < 1500) {
      query.set("ids", joined);
      return open(`/documents/${kind}?${query}`, options);
    }
    return open(`/documents/${kind}`, { ...options, method: "POST", body: { ...params, ids: list } });
  }

  const LABEL_FORMAT_KEY = "pairaexpress-label-format";
  const labelFormat = () => {
    try {
      return localStorage.getItem(LABEL_FORMAT_KEY) === "thermal" ? "thermal" : "a4";
    } catch {
      return "a4";
    }
  };

  /**
   * The panels' print format selects ("All invoices · A4", "E-commerce invoices · A4", "4 invoices · A4",
   * "Invoice · POS 80mm", "Shipment labels", "Order / shipment list"…) → the matching PDF.
   */
  function format(value, ids, { title } = {}) {
    const invoice = {
      invoice: ["a4", "all"],
      "invoice-ecommerce": ["a4", "ecommerce"],
      "invoice-document": ["a4", "document"],
      "invoice-customer": ["a4", "customer"],
      "invoice-4": ["a4-4", "all"],
      "invoice-8": ["a4-8", "all"],
      pos: ["pos", "all"],
    }[value];
    if (invoice) return window.DFPrint.invoices(ids, invoice[0], invoice[1]);
    if (value === "label" || value === "labels") return window.DFPrint.labels(ids, labelFormat());
    if (value === "label-thermal") return window.DFPrint.labels(ids, "thermal");
    return window.DFPrint.list(ids, title || "Shipment list");
  }

  window.DFPrint = {
    LIMITS,
    open,
    parcels,
    format,
    labelFormat,
    LABEL_FORMAT_KEY,
    labels: (ids, format = "a4", options) => parcels("labels", ids, { format }, { title: "Preparing labels…", ...options }),
    invoices: (ids, layout = "a4", line = "all", options) => parcels("invoices", ids, { layout, line }, { title: "Preparing invoices…", ...options }),
    list: (ids, title, options) => parcels("parcel-list", ids, { title }, { title: "Preparing the list…", ...options }),
  };
})();
