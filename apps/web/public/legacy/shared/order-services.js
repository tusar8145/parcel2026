/*
 * Service package choices on the single-order forms (both merchant panels, Courier Operations
 * New shipment): ONE first-mile select (rider pickup / drop at hub + its hub / on-demand pickup),
 * ONE last-mile select (home delivery / Hub Pickup + an optional hub), the Service, cash on
 * delivery (tick + amount), open box and the messages checklist, drawn from the package view
 * (GET /packages/me or /packages/effective) — only what the package offers appears — plus the
 * product list of the category and the live price breakdown of a quote (lines + total).
 * See docs/architecture-contracts.md.
 *
 *   DFOrderServices.load(path)                 → package view (cached a minute per path)
 *   DFOrderServices.productOptions(view, sel)  → <option>s: "No product (Regular)" + the package's active
 *                                                products as "Name · Type" (the type prices the parcel)
 *   DFOrderServices.block(view, { prefix, hubs, dropHubId, fieldClass, codAmount, codChecked, productSelect })
 *                                              → HTML for the form (ids `${prefix}FirstMile`, `${prefix}DropHub`,
 *                                                `${prefix}LastMile`, `${prefix}CollectHub`, `${prefix}Speed`,
 *                                                `${prefix}Cod`, `${prefix}CodAmount`, `${prefix}OpenBox`,
 *                                                `${prefix}Notifications`)
 *   DFOrderServices.read(view, prefix)         → { firstMile, dropHubId, lastMile, collectHubId, speed, product?,
 *                                                openBox, cod, codAmount?, notifications? }
 *   DFOrderServices.sync(prefix)               → shows / hides the hub selects and the COD amount after a change;
 *                                                disables the messages checklist when the product sends no messages
 *   DFOrderServices.checks(prefix)             → inline checks (DF.validate.field) for the drop-off hub and the COD
 *                                                amount; returns check() → valid (forces the messages)
 *   DFOrderServices.fill(select, values, placeholder, keep)
 *                                              → refills a place select ("Choose district" first, nothing preselected)
 *   DFOrderServices.searchable(select, { label, threshold })
 *                                              → a long select (areas, zones) becomes searchable (DF.searchSelect)
 *   DFOrderServices.breakdown(quote)           → HTML list of the price lines and the total
 *
 * Messages: every message in the package is pre-ticked; the user unticks what shouldn't go and the
 * parcel stores the final list. A product with "Send SMS & email" off sends nothing: the checklist
 * is disabled with "This product doesn't send messages" (the API stores an empty list).
 */
(() => {
  const DF = window.DF;
  if (!DF) return;
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const taka = n => `৳${Number(n || 0).toLocaleString("en-BD")}`;
  const cache = new Map();
  const $ = id => document.getElementById(id);
  /** prefix → { view, productSelect }: which select holds the product (`${prefix}Product` or the form's own). */
  const forms = new Map();
  const productOf = prefix => {
    const f = forms.get(prefix);
    const value = f && $(f.productSelect)?.value;
    if (!value) return null;
    return (f.view.products || []).find(p => p.name === value || p.id === value) || null;
  };
  const silentProduct = prefix => {
    const product = productOf(prefix);
    return product && product.sendMessages === false ? product : null;
  };

  async function load(path) {
    const hit = cache.get(path);
    if (hit && hit.until > Date.now()) return hit.view;
    const view = await DF.api(path);
    cache.set(path, { view, until: Date.now() + 60_000 });
    return view;
  }

  const productLabel = (view, p) => `${p.name} · ${view.labels?.productType?.[p.type] || p.type}`;
  const TYPE_ORDER = { REGULAR: 0, DOCUMENT: 1, BOOKS: 2 };
  function productOptions(view, selected = "") {
    // Regular, then Document, then Books (the spec's order of the types); names A–Z within a type.
    const list = [...(view?.products || [])].sort((a, b) => (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9) || a.name.localeCompare(b.name));
    return `<option value="">No product (Regular)</option>${list.map(p => `<option value="${esc(p.name)}" ${p.name === selected ? "selected" : ""}>${esc(productLabel(view, p))}</option>`).join("")}`;
  }

  function block(view, { prefix, hubs, dropHubId = "", fieldClass = "form-field", codAmount = false, codChecked = true, product = false, productSelect } = {}) {
    if (!view) return "";
    forms.set(prefix, { view, productSelect: productSelect || `${prefix}Product` });
    const o = view.options;
    const L = view.labels;
    const field = (id, label, control, hidden = false, full = false) => `<div class="${fieldClass}${full ? " full" : ""}"${hidden ? " hidden" : ""}><label for="${id}">${esc(label)}</label>${control}</div>`;
    const select = (id, options, selected) => `<select id="${id}">${options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(selected ?? "") ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    const dropHubs = hubs || view.dropHubs || [];
    const collectHubs = view.collectHubs || hubs || [];
    const parts = [];
    if (product && view.products?.length) parts.push(field(`${prefix}Product`, "Product (optional)", `<select id="${prefix}Product">${productOptions(view)}</select>`));
    // First mile: one select (only when the package offers more than one way), the drop-off hub beside it.
    if (o.firstMiles.length > 1) parts.push(field(`${prefix}FirstMile`, "First mile", select(`${prefix}FirstMile`, o.firstMiles.map(f => [f, L.firstMile[f]]), o.defaultFirstMile)));
    if (o.firstMiles.includes("HUB_DROP")) {
      const preferred = dropHubId || (dropHubs.length === 1 ? dropHubs[0].id : "");
      parts.push(field(`${prefix}DropHub`, "Drop-off hub", select(`${prefix}DropHub`, [["", "Choose the hub"], ...dropHubs.map(h => [h.id, h.type === "FRANCHISE" ? `${h.name} · Franchise` : h.name])], preferred), o.defaultFirstMile !== "HUB_DROP"));
    }
    if (o.lastMiles.length > 1) parts.push(field(`${prefix}LastMile`, "Last mile", select(`${prefix}LastMile`, o.lastMiles.map(l => [l, L.lastMile[l]]), o.defaultLastMile)));
    if (o.lastMiles.includes("HUB_COLLECT"))
      parts.push(field(`${prefix}CollectHub`, "Collection hub", select(`${prefix}CollectHub`, [["", "The hub serving the recipient's zone"], ...collectHubs.map(h => [h.id, h.type === "FRANCHISE" ? `${h.name} · Franchise` : h.name])], ""), o.defaultLastMile !== "HUB_COLLECT"));
    if (o.speeds.length > 1) parts.push(field(`${prefix}Speed`, "Service", select(`${prefix}Speed`, o.speeds.map(s => [s, L.speed[s]]), "REGULAR")));
    const checks = [];
    if (o.cod) checks.push(`<label class="df-check" style="display:flex;gap:7px;align-items:center;font-weight:600"><input type="checkbox" id="${prefix}Cod" ${codChecked ? "checked" : ""} style="width:auto;padding:0"> Collect cash on delivery (COD)</label>`);
    if (o.openBox) checks.push(`<label class="df-check" style="display:flex;gap:7px;align-items:center;font-weight:600"><input type="checkbox" id="${prefix}OpenBox" style="width:auto;padding:0"> Open box / check before pay</label>`);
    if (checks.length) parts.push(`<div class="${fieldClass} full df-svc-checks" style="display:flex;flex-direction:row;gap:8px 18px;flex-wrap:wrap">${checks.join("")}</div>`);
    if (o.cod && codAmount)
      parts.push(field(`${prefix}CodAmount`, "COD amount (৳)", `<input id="${prefix}CodAmount" type="number" min="1" max="1000000" step="1" inputmode="numeric" placeholder="Cash to collect from the recipient">`, !codChecked));
    if (view.notifications?.length)
      parts.push(
        `<details class="${fieldClass} full" id="${prefix}Notifications" style="display:block"><summary style="cursor:pointer;font-weight:600">Messages to send (${view.notifications.length} of ${view.notifications.length})</summary><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:5px 12px;margin-top:6px;font-size:13px">${view.notifications
          .map(n => `<label style="display:flex;gap:7px;align-items:center;font-weight:400"><input type="checkbox" data-svc-notify="${esc(n.code)}" checked style="width:auto;padding:0"> ${esc(n.title)}</label>`)
          .join("")}</div><p data-svc-notify-off hidden style="margin:6px 0 0;color:#8792a2;font-size:12px">This product doesn't send messages</p></details>`,
      );
    return parts.join("");
  }

  const fieldOf = el => el?.closest(".form-field, .field");

  /** Shows the drop / collection hub and the COD amount only for those choices; updates the messages count. */
  function sync(prefix) {
    const first = $(`${prefix}FirstMile`)?.value;
    const drop = fieldOf($(`${prefix}DropHub`));
    if (drop && first) drop.hidden = first !== "HUB_DROP";
    const last = $(`${prefix}LastMile`)?.value;
    const collect = fieldOf($(`${prefix}CollectHub`));
    if (collect && last) collect.hidden = last !== "HUB_COLLECT";
    const amount = fieldOf($(`${prefix}CodAmount`));
    if (amount) amount.hidden = !$(`${prefix}Cod`)?.checked;
    const box = $(`${prefix}Notifications`);
    if (box) {
      const all = [...box.querySelectorAll("[data-svc-notify]")];
      const off = !!silentProduct(prefix);
      for (const i of all) i.disabled = off;
      box.querySelector("[data-svc-notify-off]").hidden = !off;
      box.toggleAttribute("data-messages-off", off);
      const on = all.filter(i => i.checked).length;
      box.querySelector("summary").textContent = off ? "Messages to send (none: this product doesn't send messages)" : `Messages to send (${on} of ${all.length})`;
    }
  }

  /** The first mile in force: the select, else the package's only / default way. */
  const firstMileOf = (view, prefix) => $(`${prefix}FirstMile`)?.value || view.options.defaultFirstMile || view.options.firstMiles[0];

  function read(view, prefix) {
    if (!view) return {};
    const o = view.options;
    const firstMile = firstMileOf(view, prefix);
    const lastMile = $(`${prefix}LastMile`)?.value || o.defaultLastMile;
    const boxes = [...document.querySelectorAll(`#${prefix}Notifications [data-svc-notify]`)];
    const ticked = boxes.filter(b => b.checked).map(b => b.dataset.svcNotify);
    const product = $(forms.get(prefix)?.productSelect || `${prefix}Product`)?.value;
    const cod = o.cod ? ($(`${prefix}Cod`) ? $(`${prefix}Cod`).checked : true) : false;
    const amount = $(`${prefix}CodAmount`);
    return {
      firstMile,
      ...(firstMile === "HUB_DROP" && $(`${prefix}DropHub`)?.value ? { dropHubId: $(`${prefix}DropHub`).value } : {}),
      lastMile,
      ...(lastMile === "HUB_COLLECT" && $(`${prefix}CollectHub`)?.value ? { collectHubId: $(`${prefix}CollectHub`).value } : {}),
      speed: $(`${prefix}Speed`)?.value || "REGULAR",
      ...(product ? { product } : {}),
      openBox: !!$(`${prefix}OpenBox`)?.checked,
      cod,
      ...(amount ? { codAmount: cod ? Number(amount.value) || 0 : 0 } : {}),
      // Only a changed checklist is sent (default: every message in the package). A product that sends no
      // messages needs nothing: the API stores an empty list for it.
      ...(boxes.length && ticked.length !== boxes.length && !silentProduct(prefix) ? { notifications: ticked } : {}),
    };
  }

  /** Inline errors for the drop-off hub (drop at hub) and the COD amount (COD ticked). */
  function checks(prefix) {
    const list = [];
    const drop = $(`${prefix}DropHub`);
    if (drop) list.push(DF.validate.field(drop, () => (!fieldOf(drop)?.hidden && !drop.value ? "Choose the hub the sender brings the parcel to" : "")));
    const amount = $(`${prefix}CodAmount`);
    if (amount)
      list.push(
        DF.validate.field(amount, () => {
          if (fieldOf(amount)?.hidden || !$(`${prefix}Cod`)?.checked) return "";
          const n = Number(amount.value);
          if (!String(amount.value).trim()) return "Enter the cash to collect, or untick COD";
          if (!(n >= 1)) return "Enter an amount of at least ৳1";
          if (n > 1_000_000) return "The amount is too large";
          return "";
        }),
      );
    return () => list.map(check => check(true)).every(Boolean);
  }

  /** Refills a place select: a "Choose …" placeholder first and nothing preselected (keeps a still-valid choice). */
  function fill(select, values, placeholder, keep) {
    if (!select) return;
    const current = keep ?? select.value;
    select.innerHTML = `<option value="">${esc(placeholder)}</option>${values.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join("")}`;
    select.value = values.includes(current) ? current : "";
    searchable(select);
  }

  /**
   * A long select (more than `threshold` options) becomes searchable: typing in its list filters it
   * (shared/select-search.js, DF.searchSelect). Call again after refilling the select.
   */
  function searchable(select, { label, threshold = 15 } = {}) {
    if (!select) return;
    // The older search box above the select (from before the shared component) is removed.
    const box = select.previousElementSibling?.dataset?.dfSearch === select.id ? select.previousElementSibling : null;
    box?.remove();
    for (const option of select.options) option.hidden = false;
    if (window.DF?.searchSelect) DF.searchSelect(select, { label, threshold: Math.min(threshold, DF.searchSelect.threshold) });
  }

  function breakdown(quote) {
    if (!quote?.lines) return "";
    const rows = quote.lines.map(l => `<div style="display:flex;justify-content:space-between;gap:12px"><span>${esc(l.label)}</span><span>${l.amount < 0 ? "−" : ""}${taka(Math.abs(l.amount))}</span></div>`).join("");
    return `<div data-price-breakdown style="display:grid;gap:3px">${rows}<div style="display:flex;justify-content:space-between;gap:12px;font-weight:700;border-top:1px solid #e3e8ef;padding-top:4px"><span>Delivery charge${quote.package?.name ? ` · ${esc(quote.package.name)}` : ""}</span><span data-price-total>${taka(quote.totalCharge)}</span></div>${
      quote.returnCharge ? `<div style="color:#8792a2;font-size:12px">If it comes back: return charge ${taka(quote.returnCharge)}</div>` : ""
    }</div>`;
  }

  window.DFOrderServices = { load, block, read, sync, checks, fill, searchable, productOptions, productOf, breakdown };
})();
