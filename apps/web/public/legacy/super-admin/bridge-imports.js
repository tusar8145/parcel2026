/*
 * Super admin → Service catalog → "Spreadsheet imports": which columns of the e-commerce and the
 * document import templates are required, the value used when a cell is empty, where orders
 * without a destination are priced to, and the file limits (GET/PUT /imports/config, audited).
 * Templates, validation and the instructions sheet follow the settings at once; the template
 * download buttons show the result.
 */
(() => {
  const DF = window.DF;
  if (!DF) return;
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const toast = message => (typeof showToast === "function" ? showToast(message) : DF.toast?.(message));
  const KINDS = { ecommerce: "E-commerce order template", document: "Document consignment template" };
  const LIMITS = [
    ["merchantMaxRows", "Rows per file · merchants", "rows"],
    ["opsMaxRows", "Rows per file · operations", "rows"],
    ["maxFileMb", "File size", "MB"],
    ["perMerchantConcurrent", "Running imports per merchant", "at a time"],
    ["globalConcurrent", "Imports booking at once (platform)", "at a time"],
  ];
  let config = null;
  let catalog = null;
  let tab = "ecommerce";
  let current = null;

  const baseShowPage = window.showPage;
  window.showPage = showPage = function (page) {
    baseShowPage(page);
    current = page;
    if (page === "Service catalog") void load();
  };

  async function load() {
    try {
      [config, catalog] = await Promise.all([DF.api("/imports/config"), catalog ? Promise.resolve(catalog) : DF.api("/catalog")]);
    } catch (error) {
      return toast(DF.describe(error));
    }
    if (current === "Service catalog") draw();
  }

  function columnRows(kind) {
    return config.templates[kind]
      .map(c => {
        const toggle = c.configurable
          ? `<button type="button" class="toggle ${c.required ? "on" : ""}" data-import-required="${esc(c.key)}" aria-pressed="${c.required}" aria-label="${esc(`${c.header} required`)}"></button>`
          : `<span class="panel-subtitle">Per file or per row</span>`;
        const dflt = c.defaultable
          ? `<input data-import-default="${esc(c.key)}" value="${esc(c.default ?? "")}" placeholder="${esc(c.builtInDefault ? `Built-in: ${c.builtInDefault}` : "No default")}" style="width:100%;padding:7px 9px;border:1px solid #e4e8ee;border-radius:6px;font-size:12px">`
          : `<span class="panel-subtitle">${c.key === "district" || c.key === "zone" ? "Default destination below" : "—"}</span>`;
        return `<tr data-import-column="${esc(c.key)}"><td><strong>${esc(c.header)}</strong>${c.opsOnly ? `<span class="subcell" style="display:block;color:#8792a2;font-size:12px">Operations templates only</span>` : ""}</td><td>${toggle}</td><td style="min-width:180px">${dflt}</td><td style="font-size:12px;color:#637083;line-height:1.45">${esc(c.description)}</td></tr>`;
      })
      .join("");
  }

  function draw() {
    const main = document.getElementById("mainContent");
    if (!main || !config) return;
    document.getElementById("importSettings")?.remove();
    const dest = config.defaultDestination;
    const districts = catalog?.districts || [];
    const zones = dest.mode === "FIXED" ? catalog?.zonesByDistrict?.[dest.district] || [] : [];
    const limits = LIMITS.map(
      ([key, label, unit]) =>
        `<div class="field"><label for="importLimit-${key}">${esc(label)}</label><input id="importLimit-${key}" data-import-limit="${key}" type="number" min="${key === "maxFileMb" ? 0.1 : 1}" step="${key === "maxFileMb" ? 0.1 : 1}" max="${key.endsWith("Rows") ? config.ceilings.maxRows : config.ceilings[key]}" value="${esc(config.limits[key])}"><small class="panel-subtitle">${esc(unit)} · at most ${esc(Number(key.endsWith("Rows") ? config.ceilings.maxRows : config.ceilings[key]).toLocaleString("en-US"))}</small></div>`,
    ).join("");
    main.insertAdjacentHTML(
      "beforeend",
      `<section class="panel" id="importSettings" style="margin-top:14px">
        <div class="panel-heading"><div><h2 class="panel-title">Spreadsheet imports</h2><p class="panel-subtitle">Required columns and defaults for the merchant and operations Excel imports. Rows that have every required column and only valid values are created; missing delivery details make them “Needs info”.</p></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="button button-sm" data-import-template="ecommerce">E-commerce template</button><button type="button" class="button button-sm" data-import-template="document">Document template</button></div></div>
        <div style="display:flex;gap:6px;margin:12px 0" role="tablist">${Object.entries(KINDS)
          .map(([k, label]) => `<button type="button" role="tab" class="button button-sm${tab === k ? " button-primary" : ""}" data-import-tab="${k}" aria-selected="${tab === k}">${esc(label)}</button>`)
          .join("")}</div>
        <div class="table-scroll"><table id="importColumns"><thead><tr><th>COLUMN</th><th>REQUIRED</th><th>DEFAULT WHEN EMPTY</th><th>NOTES</th></tr></thead><tbody>${columnRows(tab)}</tbody></table></div>
        <div class="form-grid" style="margin-top:14px">
          <div class="field"><label for="importDestMode">Orders without a destination are priced to</label><select id="importDestMode"><option value="MERCHANT_CITY" ${dest.mode === "MERCHANT_CITY" ? "selected" : ""}>The merchant's own city (pickup zone)</option><option value="FIXED" ${dest.mode === "FIXED" ? "selected" : ""}>A fixed zone</option></select></div>
          <div class="field"><label for="importDestDistrict">District</label><select id="importDestDistrict" ${dest.mode === "FIXED" ? "" : "disabled"}><option value="">Choose</option>${districts.map(d => `<option ${dest.district === d ? "selected" : ""}>${esc(d)}</option>`).join("")}</select></div>
          <div class="field"><label for="importDestZone">Zone</label><select id="importDestZone" ${dest.mode === "FIXED" ? "" : "disabled"}><option value="">Choose</option>${zones.map(z => `<option ${dest.zone === z ? "selected" : ""}>${esc(z)}</option>`).join("")}</select></div>
        </div>
        <div class="form-grid" style="margin-top:12px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr))">${limits}</div>
        <div class="modal-actions"><button type="button" class="button button-primary" data-import-save>Save import settings</button></div>
      </section>`,
    );
  }

  /** The edits on screen for the template shown (only what differs from the saved settings is sent). */
  function collect() {
    const columns = {};
    for (const c of config.templates[tab]) {
      const toggle = document.querySelector(`[data-import-required="${CSS.escape(c.key)}"]`);
      const input = document.querySelector(`[data-import-default="${CSS.escape(c.key)}"]`);
      const change = {};
      if (toggle && toggle.classList.contains("on") !== c.required) change.required = toggle.classList.contains("on");
      if (input && input.value.trim() !== (c.default ?? "")) change.default = input.value.trim() || null;
      if (Object.keys(change).length) columns[c.key] = change;
    }
    const body = { templates: { [tab]: columns } };
    const mode = document.getElementById("importDestMode").value;
    body.defaultDestination = mode === "FIXED" ? { mode, district: document.getElementById("importDestDistrict").value, zone: document.getElementById("importDestZone").value } : { mode };
    body.limits = Object.fromEntries([...document.querySelectorAll("[data-import-limit]")].map(el => [el.dataset.importLimit, Number(el.value)]));
    return body;
  }

  window.addEventListener(
    "click",
    async event => {
      const t = event.target;
      if (!(t instanceof Element) || !t.closest("#importSettings")) return;
      const toggle = t.closest("[data-import-required]");
      if (toggle) {
        event.preventDefault();
        event.stopImmediatePropagation();
        toggle.classList.toggle("on");
        toggle.setAttribute("aria-pressed", toggle.classList.contains("on"));
        return;
      }
      const tabButton = t.closest("[data-import-tab]");
      if (tabButton) {
        event.stopImmediatePropagation();
        tab = tabButton.dataset.importTab;
        return draw();
      }
      const template = t.closest("[data-import-template]");
      if (template) {
        event.stopImmediatePropagation();
        try {
          await DF.download(`/imports/templates/${template.dataset.importTemplate}?for=merchant`);
        } catch (error) {
          toast(DF.describe(error));
        }
        return;
      }
      const save = t.closest("[data-import-save]");
      if (save) {
        event.stopImmediatePropagation();
        save.disabled = true;
        try {
          config = await DF.api("/imports/config", { method: "PUT", body: collect() });
          draw();
          toast("Import settings saved. Templates and validation use them from now on.");
        } catch (error) {
          toast(DF.describe(error));
        } finally {
          save.disabled = false;
        }
      }
    },
    true,
  );
  window.addEventListener(
    "change",
    event => {
      if (event.target.id === "importDestMode") {
        const fixed = event.target.value === "FIXED";
        document.getElementById("importDestDistrict").disabled = !fixed;
        document.getElementById("importDestZone").disabled = !fixed;
      }
      if (event.target.id === "importDestDistrict") {
        const zones = catalog?.zonesByDistrict?.[event.target.value] || [];
        document.getElementById("importDestZone").innerHTML = `<option value="">Choose</option>${zones.map(z => `<option>${esc(z)}</option>`).join("")}`;
      }
    },
    true,
  );
})();
