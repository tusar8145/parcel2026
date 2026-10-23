/*
 * Super admin → "Franchises" (franchise hubs, docs/architecture-contracts.md "Franchise hubs"):
 * the franchises (each one a hub tagged Franchise, with one account), create one from an approved franchise
 * application or directly, commission rates (percent of the delivery charge with a minimum, for pickup, delivery
 * and return), suspend / reactivate, and the global settlement settings (DEDUCT or BILL, billing period).
 * API: /franchises, /franchises/config, /franchises/applications.
 */
(() => {
  const DF = window.DF;
  if (!DF) return;
  const PAGE = "Franchises";
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const toast = message => (typeof showToast === "function" ? showToast(message) : console.info(message));
  const fail = error => toast(DF.describe(error));
  const tk = n => `৳${(Math.round(Number(n || 0) * 100) / 100).toLocaleString("en-US")}`;
  const $ = id => document.getElementById(id);
  const S = { franchises: [], config: null, applications: [], catalog: null, loaded: false, form: null };
  let active = false;

  // The base renderer (01.js) draws unknown pages from its `generic` table: give it an empty entry.
  try {
    if (typeof generic === "object" && !generic[PAGE]) generic[PAGE] = { desc: "Franchise hubs", cols: [], rows: [] };
  } catch {}

  // Menu item under Merchant management (after Banking & Financial merchants).
  const nav = $("navigation");
  if (nav && !nav.querySelector(`[data-page="${PAGE}"]`)) {
    const after = nav.querySelector('[data-page="Banking & Financial merchants"]') || nav.querySelector('[data-page="E-commerce merchants"]');
    const button = document.createElement("button");
    button.className = "nav-item";
    button.dataset.page = PAGE;
    button.innerHTML = `<svg fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7"><use href="#i-building"/></svg>Franchises`;
    if (after) after.after(button, " ");
    else nav.append(button);
  }

  async function load() {
    const [franchises, config, applications, catalog] = await Promise.all([
      DF.api("/franchises"),
      DF.api("/franchises/config"),
      DF.api("/franchises/applications").catch(() => []),
      S.catalog ? Promise.resolve(S.catalog) : DF.api("/catalog").catch(() => null),
    ]);
    Object.assign(S, { franchises, config, applications, catalog, loaded: true });
  }

  const rateText = (p, m) => `${p}%${m ? ` · min ${tk(m)}` : ""}`;
  const pill = (text, tone) => `<span class="status ${tone}">${esc(text)}</span>`;

  function render() {
    if (!active) return;
    const main = $("mainContent");
    const c = S.config || { settlementMode: "DEDUCT", billingPeriodDays: 30 };
    const rows = S.franchises
      .map(
        f => `<tr data-franchise="${esc(f.code)}"><td class="primary-cell">${esc(f.name)}<span class="subcell">${esc(f.code)} · ${esc(f.hub.name)} (${esc(f.hub.code)}) · ${esc(f.hub.district)}</span></td>
        <td>${esc(f.contactName)}<span class="subcell">${esc(DF.localPhone ? DF.localPhone(f.contactPhone) : f.contactPhone)}</span></td>
        <td>${esc(rateText(f.rates.pickupPercent, f.rates.pickupMin))}<span class="subcell">Delivery ${esc(rateText(f.rates.deliveryPercent, f.rates.deliveryMin))} · Return ${esc(rateText(f.rates.returnPercent, f.rates.returnMin))}</span></td>
        <td>${f.riders}</td><td>${tk(f.unsettledCommission)}</td>
        <td>${f.status === "ACTIVE" ? pill("Active", "status-good") : pill("Suspended", "status-bad")}</td>
        <td style="white-space:nowrap"><button class="mini-button" data-fr-edit="${esc(f.id)}">Rates</button> <button class="mini-button" data-fr-status="${esc(f.id)}">${f.status === "ACTIVE" ? "Suspend" : "Reactivate"}</button></td></tr>`,
      )
      .join("");
    const apps = S.applications
      .map(a => `<tr data-application="${esc(a.number)}"><td class="primary-cell">${esc(a.applicant?.name || "Applicant")}<span class="subcell">${esc(a.number)} · ${esc(a.applicant?.phone || "")}</span></td><td>${esc(a.details?.location || "—")}</td><td>${esc(a.details?.territory || "—")}</td><td><button class="button button-sm button-primary" data-fr-from="${esc(a.id)}">Create franchise</button></td></tr>`)
      .join("");
    main.innerHTML = `<div class="page-heading"><div><p class="eyebrow">Merchant management · Franchise hubs</p><h1>Franchises</h1><p class="subtitle">Partner-run hubs: each is a hub of the network (tagged Franchise) with its own riders and one account. Commission is a percent of the delivery charge, with a minimum.</p></div><button class="button button-primary" id="frNew">Add franchise</button></div>
      <div class="metrics">${metric("Franchises", String(S.franchises.length), "building", `${S.franchises.filter(f => f.status === "ACTIVE").length} active`, "partner hubs")}${metric("Franchise riders", String(S.franchises.reduce((a, f) => a + f.riders, 0)), "users", "own riders", "work only for their hub")}${metric("Commission not settled", tk(S.franchises.reduce((a, f) => a + f.unsettledCommission, 0)), "wallet", c.settlementMode === "DEDUCT" ? "kept from deposits" : "billed by finance", "all franchises")}</div>
      <section class="panel" style="margin-bottom:14px"><div class="panel-heading"><div><h2 class="panel-title">Settlement</h2><p class="panel-subtitle">How franchises get their commission.</p></div></div>
        <form id="frConfigForm" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;align-items:end">
          <label class="config-check" style="display:flex;gap:8px;align-items:flex-start"><input type="radio" name="frMode" value="DEDUCT" ${c.settlementMode === "DEDUCT" ? "checked" : ""}><span><b>Deduct when depositing</b><br><small class="panel-subtitle">A franchise keeps its commission from the cash it deposits at a hub.</small></span></label>
          <label class="config-check" style="display:flex;gap:8px;align-items:flex-start"><input type="radio" name="frMode" value="BILL" ${c.settlementMode === "BILL" ? "checked" : ""}><span><b>Bill and pay</b><br><small class="panel-subtitle">Franchises deposit everything; finance invoices the commission and pays it.</small></span></label>
          <div class="field"><label for="frPeriod">Billing period (days)</label><input id="frPeriod" type="number" min="1" max="92" value="${esc(c.billingPeriodDays)}"></div>
          <div><button type="submit" class="button button-primary">Save settlement</button></div>
        </form></section>
      ${apps ? `<section class="panel" style="margin-bottom:14px" id="frApplications"><div class="panel-heading"><div><h2 class="panel-title">Approved applications</h2><p class="panel-subtitle">Franchise applications approved in Support: create their franchise (the applicant's account becomes the franchise account).</p></div></div><div class="table-scroll"><table><thead><tr><th>APPLICANT</th><th>LOCATION</th><th>TERRITORY</th><th></th></tr></thead><tbody>${apps}</tbody></table></div></section>` : ""}
      <section class="panel table-panel"><div class="panel-heading"><div><h2 class="panel-title">Franchise hubs</h2><p class="panel-subtitle">${S.franchises.length} franchise${S.franchises.length === 1 ? "" : "s"}</p></div></div><div class="table-scroll"><table id="frTable"><thead><tr><th>FRANCHISE / HUB</th><th>CONTACT</th><th>COMMISSION (PICKUP)</th><th>RIDERS</th><th>NOT SETTLED</th><th>STATUS</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="7" class="empty-state">No franchises yet. Add one, or create one from an approved application.</td></tr>`}</tbody></table></div></section>`;
  }

  // ───────────── dialog ─────────────
  function dialog(title, subtitle, body) {
    $("frDialog")?.remove();
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div id="frDialog" role="dialog" aria-modal="true" aria-labelledby="frDialogTitle" style="position:fixed;inset:0;z-index:100;background:#14203380;display:grid;place-items:center;padding:18px"><section style="width:min(640px,100%);max-height:88vh;overflow:auto;background:#fff;border-radius:12px;padding:20px;box-shadow:0 24px 70px #10182840"><h2 id="frDialogTitle" style="margin:0;font-size:18px">${esc(title)}</h2><p style="margin:6px 0 14px;color:#778293">${esc(subtitle)}</p>${body}</section></div>`,
    );
    $("frDialog").addEventListener("click", e => (e.target.id === "frDialog" || e.target.closest("[data-fr-close]")) && $("frDialog").remove());
  }
  const field = (id, label, value = "", attrs = "") => `<div class="field"><label for="${id}">${esc(label)}</label><input id="${id}" value="${esc(value)}" ${attrs}></div>`;
  const rateFields = (r = {}) =>
    `<h3 class="panel-title" style="margin:14px 0 6px;grid-column:1/-1">Commission on the delivery charge</h3>${[
      ["pickup", "Pickup"],
      ["delivery", "Delivery"],
      ["return", "Return"],
    ]
      .map(([k, l]) => field(`fr-${k}Percent`, `${l} %`, r[`${k}Percent`] ?? 0, 'type="number" min="0" max="100" step="0.1"') + field(`fr-${k}Min`, `${l} minimum (৳)`, r[`${k}Min`] ?? 0, 'type="number" min="0" step="1"'))
      .join("")}`;
  const readRates = () => Object.fromEntries(["pickup", "delivery", "return"].flatMap(k => [[`${k}Percent`, Number($(`fr-${k}Percent`).value) || 0], [`${k}Min`, Number($(`fr-${k}Min`).value) || 0]]));
  const grid = inner => `<form id="frForm" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px 12px">${inner}<div class="modal-actions" style="grid-column:1/-1;display:flex;justify-content:flex-end;gap:8px;margin-top:8px"><button type="button" class="button" data-fr-close>Cancel</button><button type="submit" class="button button-primary">Save</button></div></form>`;

  function openCreate(application) {
    S.form = { mode: "create", applicationId: application?.id || null };
    const districts = S.catalog?.districts || [];
    const d = application?.details || {};
    dialog(
      application ? `Create franchise · ${application.number}` : "Add franchise",
      application ? `${application.applicant?.name || "The applicant"}'s account becomes the franchise account; they sign in as before and land in the franchise panel.` : "Creates the franchise hub and its account. The account holder gets an SMS to sign in.",
      grid(
        `${field("frName", "Franchise name", application ? `${application.applicant?.name || ""} franchise` : "", "required maxlength=120")}${field("frContact", "Contact person", application?.applicant?.name || "", "required maxlength=120")}${application ? "" : field("frPhone", "Account mobile", "", 'required inputmode="tel" placeholder="01XXXXXXXXX"')}${field("frEmail", "Email (optional)", application?.applicant?.email || "", 'type="email"')}
        <h3 class="panel-title" style="margin:14px 0 6px;grid-column:1/-1">The hub</h3>${field("frHubName", "Hub name", d.location ? `${d.location} Franchise` : "", "required maxlength=120")}
        <div class="field"><label for="frDistrict">District</label><select id="frDistrict" required><option value="">Choose</option>${districts.map(x => `<option>${esc(x)}</option>`).join("")}</select></div>
        <div class="field"><label for="frZone">Area (thana)</label><select id="frZone"><option value="">Choose</option></select></div>
        ${field("frAddress", "Address", d.location || "", "required maxlength=300")}${rateFields()}`,
      ),
    );
    $("frDistrict").addEventListener("change", () => {
      const zones = S.catalog?.zonesByDistrict?.[$("frDistrict").value] || [];
      $("frZone").innerHTML = `<option value="">Choose</option>${zones.map(z => `<option>${esc(z)}</option>`).join("")}`;
    });
  }

  function openEdit(f) {
    S.form = { mode: "edit", id: f.id };
    dialog(`Commission · ${f.name}`, `${f.hub.name} (${f.code}). New rates apply to parcel events from now on.`, grid(`${field("frName", "Franchise name", f.name, "required maxlength=120")}${field("frContact", "Contact person", f.contactName, "required maxlength=120")}${rateFields(f.rates)}`));
  }

  async function submitForm() {
    const form = S.form;
    const button = $("frForm").querySelector('[type="submit"]');
    button.disabled = true;
    try {
      if (form.mode === "create") {
        const body = {
          applicationId: form.applicationId || undefined,
          name: $("frName").value.trim(),
          contactName: $("frContact").value.trim(),
          phone: $("frPhone")?.value.trim() || undefined,
          email: $("frEmail").value.trim() || undefined,
          hub: { name: $("frHubName").value.trim(), district: $("frDistrict").value, zone: $("frZone").value || undefined, address: $("frAddress").value.trim() },
          rates: readRates(),
        };
        const f = await DF.api("/franchises", { method: "POST", body });
        toast(`${f.name} (${f.code}) created with hub ${f.hub.name}.`);
      } else {
        await DF.api(`/franchises/${form.id}`, { method: "PATCH", body: { name: $("frName").value.trim(), contactName: $("frContact").value.trim(), rates: readRates() } });
        toast("Commission saved.");
      }
      $("frDialog")?.remove();
      await load();
      render();
    } catch (error) {
      fail(error);
    } finally {
      button.disabled = false;
    }
  }

  async function toggleStatus(f) {
    const suspend = f.status === "ACTIVE";
    const ok = await DF.confirm({
      title: suspend ? `Suspend ${f.name}?` : `Reactivate ${f.name}?`,
      message: suspend ? "The franchise panel closes, its riders are signed out and can't sign in, and the hub takes no new work." : "The franchise and its riders can sign in again and the hub takes work again.",
      confirm: suspend ? "Suspend" : "Reactivate",
      danger: suspend,
    });
    if (!ok) return;
    try {
      await DF.api(`/franchises/${f.id}/status`, { method: "POST", body: { status: suspend ? "SUSPENDED" : "ACTIVE" } });
      toast(suspend ? `${f.name} is suspended.` : `${f.name} is active again.`);
      await load();
      render();
    } catch (error) {
      fail(error);
    }
  }

  // ───────────── wiring ─────────────
  const baseShowPage = window.showPage;
  window.showPage = showPage = function (page) {
    baseShowPage(page);
    active = page === PAGE;
    if (!active) return;
    $("mainContent").innerHTML = `<div class="page-heading"><div><p class="eyebrow">Merchant management · Franchise hubs</p><h1>Franchises</h1><p class="subtitle">Loading…</p></div></div>`;
    void load().then(render, fail);
  };

  window.addEventListener(
    "click",
    event => {
      const t = event.target instanceof Element ? event.target : null;
      if (!t || !active) return;
      let el;
      if (t.closest("#frNew")) return openCreate(null);
      if ((el = t.closest("[data-fr-from]"))) return openCreate(S.applications.find(a => a.id === el.dataset.frFrom));
      if ((el = t.closest("[data-fr-edit]"))) return openEdit(S.franchises.find(f => f.id === el.dataset.frEdit));
      if ((el = t.closest("[data-fr-status]"))) return void toggleStatus(S.franchises.find(f => f.id === el.dataset.frStatus));
    },
    true,
  );
  window.addEventListener(
    "submit",
    event => {
      if (!active) return;
      if (event.target.id === "frForm") {
        event.preventDefault();
        event.stopImmediatePropagation();
        return void submitForm();
      }
      if (event.target.id === "frConfigForm") {
        event.preventDefault();
        event.stopImmediatePropagation();
        const mode = document.querySelector('input[name="frMode"]:checked')?.value || "DEDUCT";
        void DF.api("/franchises/config", { method: "PUT", body: { settlementMode: mode, billingPeriodDays: Number($("frPeriod").value) || 30 } }).then(c => {
          S.config = c;
          toast(mode === "DEDUCT" ? "Franchises now keep their commission when they deposit." : `Finance now bills franchise commission every ${c.billingPeriodDays} days.`);
          render();
        }, fail);
      }
    },
    true,
  );

  // The address holds the full address: its district / zone / area are picked from it (shared/api.js DF.autoPlace).
  window.DF?.autoPlace?.({ street: "frAddress", district: "frDistrict", zone: "frZone" });
})();
