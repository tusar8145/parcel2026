/*
 * Service package choices on the single-order forms (both merchant panels, Courier Operations
 * booking): first mile (and its drop hub), last mile (Hub Pickup, with an optional hub),
 * speed + handling, cash on delivery, open box and the notifications checklist, drawn from the
 * package view (GET /packages/me or /packages/effective) — only what the package offers appears —
 * plus the live price breakdown of a quote (lines + total). See docs/architecture-contracts.md.
 *
 *   DFOrderServices.load(path)                    → package view (cached a minute per path)
 *   DFOrderServices.block(view, { prefix, hubs, productSelect })  → HTML for the form (ids `${prefix}FirstMile`, …)
 *   DFOrderServices.read(view, prefix)            → { firstMile, dropHubId, lastMile, collectHubId, speed, openBox, cod, notifications? }
 *   DFOrderServices.sync(prefix)                  → shows / hides the hub selects after a change; disables the
 *                                                   messages checklist when the chosen product sends no messages
 *
 * Messages: every message in the package is pre-ticked; the user unticks what shouldn't go and the
 * parcel stores the final list. A product with "Send SMS & email" off sends nothing: the checklist
 * is disabled with "This product doesn't send messages" (the API stores an empty list).
 *   DFOrderServices.breakdown(quote)              → HTML list of the price lines and the total
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
  const silentProduct = prefix => {
    const f = forms.get(prefix);
    const value = f && $(f.productSelect)?.value;
    if (!value) return null;
    const product = (f.view.products || []).find(p => p.name === value || p.id === value);
    return product && product.sendMessages === false ? product : null;
  };

  async function load(path) {
    const hit = cache.get(path);
    if (hit && hit.until > Date.now()) return hit.view;
    const view = await DF.api(path);
    cache.set(path, { view, until: Date.now() + 60_000 });
    return view;
  }

  const field = (id, label, control, extra = "") => `<div class="form-field"${extra}><label for="${id}">${esc(label)}</label>${control}</div>`;
  const select = (id, options, selected) => `<select id="${id}">${options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(selected ?? "") ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;

  /**
   * `firstMile: false` leaves the first mile to the form (Courier Operations has its own intake / drop-off
   * fields): only an "On-demand pickup" choice is added when the package offers it. `product: true` adds
   * the product select (the merchant forms already have one).
   */
  function block(view, { prefix, hubs, firstMile = true, product = false, productSelect } = {}) {
    if (!view) return "";
    forms.set(prefix, { view, productSelect: productSelect || `${prefix}Product` });
    const o = view.options;
    const L = view.labels;
    const hubList = hubs || view.dropHubs || view.collectHubs || [];
    const parts = [];
    if (!firstMile && o.firstMiles.includes("ON_DEMAND_PICKUP"))
      parts.push(field(`${prefix}FirstMile`, "Pickup", select(`${prefix}FirstMile`, [["", "As chosen above"], ["ON_DEMAND_PICKUP", L.firstMile.ON_DEMAND_PICKUP]], "")));
    if (product && view.products?.length)
      parts.push(field(`${prefix}Product`, "Product", select(`${prefix}Product`, [["", "No product (Regular)"], ...view.products.map(p => [p.name, `${p.name} · ${view.labels.productType?.[p.type] || p.type}`])], "")));
    if (firstMile && o.firstMiles.length > 1) parts.push(field(`${prefix}FirstMile`, "First mile", select(`${prefix}FirstMile`, o.firstMiles.map(f => [f, L.firstMile[f]]), o.defaultFirstMile)));
    if (firstMile && o.firstMiles.includes("HUB_DROP"))
      parts.push(field(`${prefix}DropHub`, "Drop-off hub", select(`${prefix}DropHub`, [["", "Choose the hub"], ...hubList.map(h => [h.id, h.name])], ""), o.defaultFirstMile === "HUB_DROP" ? "" : " hidden"));
    if (o.lastMiles.length > 1) parts.push(field(`${prefix}LastMile`, "Last mile", select(`${prefix}LastMile`, o.lastMiles.map(l => [l, L.lastMile[l]]), o.defaultLastMile)));
    if (o.lastMiles.includes("HUB_COLLECT"))
      parts.push(
        field(`${prefix}CollectHub`, "Collection hub", select(`${prefix}CollectHub`, [["", "The hub serving the recipient's zone"], ...(view.collectHubs || hubList).map(h => [h.id, h.name])], ""), o.defaultLastMile === "HUB_COLLECT" ? "" : " hidden"),
      );
    if (o.speeds.length > 1) parts.push(field(`${prefix}Speed`, "Service", select(`${prefix}Speed`, o.speeds.map(s => [s, L.speed[s]]), "REGULAR")));
    const checks = [];
    if (o.cod) checks.push(`<label class="df-check" style="display:flex;gap:7px;align-items:center"><input type="checkbox" id="${prefix}Cod" checked> Collect cash on delivery</label>`);
    if (o.openBox) checks.push(`<label class="df-check" style="display:flex;gap:7px;align-items:center"><input type="checkbox" id="${prefix}OpenBox"> Open box / check before pay</label>`);
    if (checks.length) parts.push(`<div class="form-field full" style="display:flex;gap:16px;flex-wrap:wrap">${checks.join("")}</div>`);
    if (view.notifications?.length)
      parts.push(
        `<details class="form-field full" id="${prefix}Notifications"><summary style="cursor:pointer;font-weight:600">Messages to send (${view.notifications.length} of ${view.notifications.length})</summary><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:5px 12px;margin-top:6px;font-size:13px">${view.notifications
          .map(n => `<label style="display:flex;gap:7px;align-items:center"><input type="checkbox" data-svc-notify="${esc(n.code)}" checked> ${esc(n.title)}</label>`)
          .join("")}</div><p data-svc-notify-off hidden style="margin:6px 0 0;color:#8792a2;font-size:12px">This product doesn't send messages</p></details>`,
      );
    return parts.join("");
  }

  /** Shows the drop / collection hub only for those choices; updates the messages count. */
  function sync(prefix) {
    const first = $(`${prefix}FirstMile`)?.value;
    const drop = $(`${prefix}DropHub`)?.closest(".form-field");
    if (drop && first) drop.hidden = first !== "HUB_DROP";
    const last = $(`${prefix}LastMile`)?.value;
    const collect = $(`${prefix}CollectHub`)?.closest(".form-field");
    if (collect && last) collect.hidden = last !== "HUB_COLLECT";
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

  function read(view, prefix) {
    if (!view) return {};
    const o = view.options;
    const picked = $(`${prefix}FirstMile`);
    // A form without the first-mile select (operations): only an on-demand pickup is sent.
    const firstMile = picked ? picked.value || undefined : $(`${prefix}DropHub`) ? o.defaultFirstMile : undefined;
    const lastMile = $(`${prefix}LastMile`)?.value || o.defaultLastMile;
    const boxes = [...document.querySelectorAll(`#${prefix}Notifications [data-svc-notify]`)];
    const ticked = boxes.filter(b => b.checked).map(b => b.dataset.svcNotify);
    return {
      firstMile,
      ...(firstMile === "HUB_DROP" && $(`${prefix}DropHub`)?.value ? { dropHubId: $(`${prefix}DropHub`).value } : {}),
      lastMile,
      ...(lastMile === "HUB_COLLECT" && $(`${prefix}CollectHub`)?.value ? { collectHubId: $(`${prefix}CollectHub`).value } : {}),
      speed: $(`${prefix}Speed`)?.value || "REGULAR",
      ...($(`${prefix}Product`)?.value ? { product: $(`${prefix}Product`).value } : {}),
      openBox: !!$(`${prefix}OpenBox`)?.checked,
      cod: o.cod ? ($(`${prefix}Cod`) ? $(`${prefix}Cod`).checked : true) : false,
      // Only a changed checklist is sent (default: every message in the package). A product that sends no
      // messages needs nothing: the API stores an empty list for it.
      ...(boxes.length && ticked.length !== boxes.length && !silentProduct(prefix) ? { notifications: ticked } : {}),
    };
  }

  function breakdown(quote) {
    if (!quote?.lines) return "";
    const rows = quote.lines.map(l => `<div style="display:flex;justify-content:space-between;gap:12px"><span>${esc(l.label)}</span><span>${l.amount < 0 ? "−" : ""}${taka(Math.abs(l.amount))}</span></div>`).join("");
    return `<div data-price-breakdown style="display:grid;gap:3px">${rows}<div style="display:flex;justify-content:space-between;gap:12px;font-weight:700;border-top:1px solid #e3e8ef;padding-top:4px"><span>Delivery charge${quote.package?.name ? ` · ${esc(quote.package.name)}` : ""}</span><span data-price-total>${taka(quote.totalCharge)}</span></div>${
      quote.returnCharge ? `<div style="color:#8792a2;font-size:12px">If it comes back: return charge ${taka(quote.returnCharge)}</div>` : ""
    }</div>`;
  }

  window.DFOrderServices = { load, block, read, sync, breakdown };
})();
