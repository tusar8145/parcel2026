/*
 * Super admin › Invoice settings (GET / PUT /finance/config): what parcel invoices and bills print — the delivery
 * charge on delivery invoices (off when the charge is taken out of the COD), VAT on / off and its rate, and the company
 * (name, BIN, address) on bills. Only super admins change them; finance reads them.
 */
(() => {
  const DF = window.DF;
  if (!DF) return;
  const PAGE = "Invoice settings";
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const toast = message => (typeof showToast === "function" ? showToast(message) : DF.toast?.(message)); // eslint-disable-line no-undef -- the page's own toast (01.js)
  // cfg: as saved; draft: what is typed and not saved yet (the page may be redrawn while it is filled in).
  const S = { cfg: null, draft: null, open: false, error: "", saving: false };

  try {
    if (typeof generic === "object" && !generic[PAGE]) generic[PAGE] = { desc: PAGE, cols: [], rows: [] }; // eslint-disable-line no-undef
  } catch {}

  const field = (id, label, value, opts = {}) =>
    `<label${opts.full ? ' style="grid-column:1/-1"' : ""}>${esc(label)}${
      opts.area
        ? `<textarea id="${id}" rows="3" maxlength="${opts.max || 300}">${esc(value)}</textarea>`
        : `<input id="${id}" type="${opts.type || "text"}" value="${esc(value)}" ${opts.attrs || ""}>`
    }${opts.hint ? `<small style="color:#8a94a3;font-size:12px">${esc(opts.hint)}</small>` : ""}</label>`;
  const select = (id, label, value, options, hint) =>
    `<label style="grid-column:1/-1">${esc(label)}<select id="${id}">${options.map(([v, text]) => `<option value="${v}" ${v === value ? "selected" : ""}>${esc(text)}</option>`).join("")}</select>${
      hint ? `<small style="color:#8a94a3;font-size:12px">${esc(hint)}</small>` : ""
    }</label>`;

  function values() {
    return {
      showDeliveryCharge: $("invCharge").value !== "off",
      vatEnabled: $("invVat").value === "on",
      vatRate: Number($("invVatRate").value),
      seller: { name: $("invName").value.trim(), bin: $("invBin").value.trim(), address: $("invAddress").value.trim() },
    };
  }

  function markup() {
    if (!S.cfg) return `<p class="panel-subtitle" style="margin-top:12px">${esc(S.error || "Loading…")}</p>`;
    const c = S.draft ? { ...S.cfg, ...S.draft, seller: { ...S.cfg.seller, ...S.draft.seller } } : S.cfg;
    return `<form id="invForm" class="config-form" novalidate>
      <div class="config-layout" style="margin:0">
        <section class="panel"><div class="panel-heading"><div><h2 class="panel-title">Delivery invoices</h2><p class="panel-subtitle">The invoices printed for parcels (A4, 4 or 8 per page, POS receipt)</p></div></div>
          <div class="form-grid" style="margin-top:12px">
            ${select(
              "invCharge",
              "Show delivery charge on invoice",
              c.showDeliveryCharge === false ? "off" : "on",
              [
                ["on", "Show: price lines, VAT and the delivery charge"],
                ["off", "Hide: only the COD to collect"],
              ],
              "Hide it when the delivery charge is taken out of the COD in practice, so the recipient sees only the cash to pay.",
            )}
          </div></section>
        <section class="panel"><div class="panel-heading"><div><h2 class="panel-title">VAT</h2><p class="panel-subtitle">With VAT off, charges already include everything and no VAT or BIN is shown anywhere</p></div></div>
          <div class="form-grid" style="margin-top:12px">
            ${select("invVat", "VAT", c.vatEnabled ? "on" : "off", [
              ["off", "Off: no VAT shown"],
              ["on", "On: show VAT at the rate below"],
            ])}
            ${field("invVatRate", "VAT rate (%)", String(c.vatRate), { type: "number", attrs: 'min="0" max="50" step="0.01" required', hint: "Used only while VAT is on." })}
            ${field("invBin", "Company BIN", c.seller.bin || "", { attrs: 'maxlength="14"', hint: "Printed while VAT is on. 13 digits (or 9 digits-4 digits)." })}
          </div></section>
        <section class="panel"><div class="panel-heading"><div><h2 class="panel-title">Company on bills</h2><p class="panel-subtitle">Printed on bills, statements and invoices</p></div></div>
          <div class="form-grid" style="margin-top:12px">
            ${field("invName", "Company name on bills", c.seller.name || "", { attrs: 'maxlength="160" required', full: true })}
            ${field("invAddress", "Company address on bills", c.seller.address || "", { area: true, full: true })}
          </div></section>
      </div>
      ${S.error ? `<p role="alert" style="color:#b42318;font-weight:600;margin:12px 0 0">${esc(S.error)}</p>` : ""}
      <div style="display:flex;gap:8px;margin-top:16px"><button class="button button-primary" type="submit" ${S.saving ? "disabled" : ""}>${S.saving ? "Saving…" : "Save settings"}</button></div>
    </form>`;
  }

  function paint() {
    const host = $("invHost");
    if (!host || !S.open) return;
    host.innerHTML = markup();
    const form = $("invForm");
    if (!form) return;
    form.addEventListener("input", () => (S.draft = values()));
    form.addEventListener("change", () => (S.draft = values()));
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const body = values();
      if (!body.seller.name) return toast("Enter the company name on bills.");
      if (!(body.vatRate >= 0 && body.vatRate <= 50)) return toast("The VAT rate must be between 0 and 50.");
      S.saving = true;
      S.error = "";
      paint();
      try {
        S.cfg = await DF.api("/finance/config", { method: "PUT", body });
        S.draft = null;
        toast(`Invoice settings saved: delivery charge ${S.cfg.showDeliveryCharge ? "shown" : "hidden"} on invoices, VAT ${S.cfg.vatEnabled ? `on at ${S.cfg.vatRate}%` : "off"}.`);
      } catch (error) {
        S.draft = body;
        S.error = DF.describe(error);
      }
      S.saving = false;
      paint();
    });
  }

  // The page can be opened twice in a row (navigation): only the latest load draws.
  let loads = 0;
  async function load() {
    const mine = ++loads;
    let cfg = null;
    let error = "";
    try {
      cfg = await DF.api("/finance/config");
    } catch (e) {
      error = DF.describe(e);
    }
    if (mine !== loads) return;
    if (cfg) S.cfg = cfg;
    S.error = error;
    paint();
  }

  const baseShowPage = window.showPage;
  window.showPage = showPage = function (page) { // eslint-disable-line no-global-assign, no-undef -- the page's own showPage (01.js)
    baseShowPage(page);
    const wasOpen = S.open;
    S.open = page === PAGE;
    if (page !== PAGE) return;
    // Opened again from another page: start from what is saved (a redraw of the open page keeps the draft).
    if (!wasOpen) S.draft = null;
    $("mainContent").innerHTML = `<div class="page-heading"><div><p class="eyebrow">Platform control · money</p><h1>Invoice settings</h1><p class="subtitle">What parcel invoices and bills print: the delivery charge, VAT and the company on bills.</p></div></div><div id="invHost"></div>`;
    paint();
    void load();
  };
})();
