/*
 * Super admin → Shared catalogs & locations → "Delivery address hierarchy": the geography admin.
 *
 *   Districts → zones → areas drill-down, search    GET /geography, GET /geography/counts
 *   Add district / zone (optional serving hub)      POST /geography/districts, /geography/zones
 *   Add areas (one per line, pasted)                POST /geography/areas
 *   Rename / map point / (de)activate               PATCH /geography/{districts,zones,areas}
 *   Delete (only when unused; shows what uses it)   GET /geography/usage, DELETE /geography/…
 *
 * Renames update every record that names the place (parcels, addresses, hubs, riders, delivery
 * zones, SLA policies, import settings) in one transaction. Deactivated places disappear from new
 * bookings, dropdowns and templates; existing records keep them. Every change is audited and
 * announced (live event "catalog.updated"), so open pages refresh their lists.
 */
(() => {
  const DF = window.DF;
  if (!DF) return;
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const toast = message => (typeof showToast === "function" ? showToast(message) : DF.toast?.(message));
  const num = n => Number(n || 0).toLocaleString("en-US");
  const same = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
  const PAGE = "Pricing & catalogs";
  const SEARCH_LIMIT = 120;

  const S = {
    tree: null,
    counts: { districts: null, zones: {}, areas: {} },
    district: null,
    zone: null,
    q: "",
    showInactive: true,
    notice: "",
    hubs: null,
    error: "",
  };
  let current = null;

  // ───────────── data ─────────────
  async function loadTree() {
    try {
      S.tree = await DF.api("/geography");
      S.error = "";
    } catch (error) {
      S.error = DF.describe(error);
    }
    const d = S.tree?.districts.find(x => same(x.name, S.district)) || S.tree?.districts[0];
    S.district = d?.name || null;
    if (!d?.zones.some(z => same(z.name, S.zone))) S.zone = d?.zones[0]?.name || null;
    draw();
    void loadCounts();
  }
  /** Usage counts for the three visible lists (districts, the district's zones, the zone's areas). */
  async function loadCounts(force = false) {
    const jobs = [];
    const get = (params, put) => jobs.push(DF.api(`/geography/counts${params ? `?${new URLSearchParams(params)}` : ""}`).then(r => put(r.counts)).catch(() => undefined));
    if (force || !S.counts.districts) get(null, c => (S.counts.districts = c));
    if (S.district && (force || !S.counts.zones[S.district])) get({ district: S.district }, c => (S.counts.zones[S.district] = c));
    const key = `${S.district}|${S.zone}`;
    if (S.district && S.zone && (force || !S.counts.areas[key])) get({ district: S.district, zone: S.zone }, c => (S.counts.areas[key] = c));
    if (!jobs.length) return;
    await Promise.all(jobs);
    draw();
  }
  const resetCounts = () => (S.counts = { districts: null, zones: {}, areas: {} });
  const district = () => S.tree?.districts.find(d => same(d.name, S.district)) || null;
  const zone = () => district()?.zones.find(z => same(z.name, S.zone)) || null;
  const usageOf = (level, name) => {
    const list = level === "district" ? S.counts.districts : level === "zone" ? S.counts.zones[S.district] : S.counts.areas[`${S.district}|${S.zone}`];
    return list ? list[name] || { total: 0, items: [] } : null;
  };

  // ───────────── rendering ─────────────
  function host() {
    if (current !== PAGE) return null;
    const title = [...document.querySelectorAll("#mainContent .panel-title")].find(t => t.textContent.trim() === "Delivery address hierarchy");
    const panel = title?.closest(".panel");
    if (!panel) return null;
    let root = $("geoAdmin");
    if (!root) {
      [...panel.children].forEach(child => {
        if (!child.classList.contains("panel-heading")) child.remove();
      });
      const subtitle = panel.querySelector(".panel-subtitle");
      if (subtitle) subtitle.textContent = "Districts, zones and areas offered on every booking form, template and import. Renames update every record; places in use can only be deactivated.";
      panel.insertAdjacentHTML("beforeend", `<div id="geoAdmin" style="margin-top:10px"></div>`);
      root = $("geoAdmin");
    }
    return root;
  }

  const pill = active => `<span class="status ${active ? "status-good" : "status-warn"}">${active ? "Active" : "Inactive"}</span>`;
  function usageText(level, name) {
    const u = usageOf(level, name);
    if (!u) return "counting…";
    return u.total ? `used by ${num(u.total)} record${u.total === 1 ? "" : "s"}` : "unused";
  }
  function actions(level, item) {
    return `<div class="row-actions" style="flex-wrap:wrap;margin-top:6px">
      <button type="button" class="button button-sm" data-geo-edit="${level}" data-name="${esc(item.name)}">Edit</button>
      <button type="button" class="button button-sm" data-geo-toggle="${level}" data-name="${esc(item.name)}">${item.active ? "Deactivate" : "Activate"}</button>
      <button type="button" class="button button-sm button-danger" data-geo-delete="${level}" data-name="${esc(item.name)}">Delete</button></div>`;
  }
  function row(level, item, selected, meta) {
    const pick = level === "area" ? "" : ` data-geo-pick="${level}" data-name="${esc(item.name)}" role="button" tabindex="0"`;
    return `<li data-geo-row="${level}" data-name="${esc(item.name)}" style="list-style:none;padding:9px 10px;border:1px solid ${selected ? "#9fb6f0" : "var(--line)"};border-radius:8px;background:${selected ? "#f3f6ff" : "#fff"};${item.active ? "" : "opacity:.78;"}">
      <div${pick} style="display:flex;justify-content:space-between;gap:8px;align-items:center;${pick ? "cursor:pointer;" : ""}"><strong style="font-size:13px">${esc(item.name)}</strong>${pill(item.active)}</div>
      <small class="panel-subtitle" style="display:block;margin-top:3px" data-geo-usage>${esc(meta)}</small>${actions(level, item)}</li>`;
  }
  function column(title, sub, addLabel, addAction, body) {
    return `<div style="display:grid;gap:8px;align-content:start;min-width:0"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><div><strong>${esc(title)}</strong><small class="panel-subtitle" style="display:block">${esc(sub)}</small></div>${addLabel ? `<button type="button" class="button button-sm button-primary" data-geo-add="${addAction}">${esc(addLabel)}</button>` : ""}</div><ul style="display:grid;gap:7px;margin:0;padding:0;max-height:460px;overflow:auto">${body}</ul></div>`;
  }
  const visible = items => (S.showInactive ? items : items.filter(i => i.active));

  function draw() {
    const root = host();
    if (!root) return;
    if (!S.tree) {
      root.innerHTML = `<div class="empty-state">${esc(S.error || "Loading the geography…")}</div>`;
      return;
    }
    const t = S.tree.totals;
    const d = district();
    const z = zone();
    const districts = visible(S.tree.districts)
      .map(x => row("district", x, x === d, `${num(x.zones.length)} zones · ${usageText("district", x.name)}`))
      .join("");
    const zones = d
      ? visible(d.zones)
          .map(x => row("zone", x, x === z, `${num(x.areas.length)} areas · ${x.servedBy.length ? `served by ${x.servedBy.map(h => h.name).join(", ")}` : "no serving hub"} · ${usageText("zone", x.name)}`))
          .join("")
      : "";
    const areas = z ? visible(z.areas).map(x => row("area", x, false, usageText("area", x.name))).join("") : "";
    const results = S.q ? searchResults() : "";
    root.innerHTML = `
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
        <input type="search" class="table-search" id="geoSearch" value="${esc(S.q)}" placeholder="Search districts, zones and areas" aria-label="Search districts, zones and areas" style="flex:1;min-width:200px;max-width:360px">
        <label style="display:flex;gap:6px;align-items:center;font-size:13px"><input type="checkbox" id="geoShowInactive" ${S.showInactive ? "checked" : ""}> Show deactivated</label>
        <span class="panel-subtitle" id="geoTotals">${num(t.districts)} districts · ${num(t.zones)} zones · ${num(t.areas)} areas${t.inactive.districts + t.inactive.zones + t.inactive.areas ? ` · ${num(t.inactive.districts + t.inactive.zones + t.inactive.areas)} deactivated` : ""}</span>
      </div>
      ${S.notice ? `<div class="panel-subtitle" id="geoNotice" role="status" style="margin:0 0 10px;padding:9px 11px;border:1px solid var(--line);border-radius:8px;background:#fafbfd;white-space:pre-line">${esc(S.notice)}</div>` : ""}
      ${results}
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:14px">
        ${column("Districts", "Choose one to see its zones", "Add district", "district", districts || `<li class="empty-state" style="list-style:none">No districts.</li>`)}
        ${column(d ? `Zones of ${d.name}` : "Zones", d ? (d.active ? "Choose one to see its areas" : "District deactivated: its zones are hidden from bookings") : "", d ? "Add zone" : "", "zone", zones || `<li class="empty-state" style="list-style:none">${d ? "No zones yet." : "Choose a district."}</li>`)}
        ${column(z ? `Areas of ${z.name}` : "Areas", z ? "No areas = any address in the zone" : "", z ? "Add areas" : "", "area", areas || `<li class="empty-state" style="list-style:none">${z ? "No areas listed: any address in the zone." : "Choose a zone."}</li>`)}
      </div>`;
  }

  function searchResults() {
    const q = S.q.toLowerCase();
    const hits = [];
    for (const d of S.tree.districts) {
      if (d.name.toLowerCase().includes(q)) hits.push({ level: "district", d, label: d.name, path: "District", active: d.active });
      for (const z of d.zones) {
        if (z.name.toLowerCase().includes(q)) hits.push({ level: "zone", d, z, label: z.name, path: `Zone · ${d.name}`, active: z.active && d.active });
        for (const a of z.areas) if (a.name.toLowerCase().includes(q)) hits.push({ level: "area", d, z, label: a.name, path: `Area · ${z.name}, ${d.name}`, active: a.active && z.active && d.active });
      }
      if (hits.length > SEARCH_LIMIT * 4) break;
    }
    const shown = (S.showInactive ? hits : hits.filter(h => h.active)).slice(0, SEARCH_LIMIT);
    const rows = shown
      .map(h => `<tr><td><strong>${esc(h.label)}</strong></td><td>${esc(h.path)}</td><td>${pill(h.active)}</td><td><button type="button" class="button button-sm" data-geo-goto="${esc(h.d.name)}" data-zone="${esc(h.z?.name || "")}">Show</button></td></tr>`)
      .join("");
    return `<div class="table-scroll" id="geoResults" style="margin-bottom:12px;max-height:280px;overflow:auto"><table><thead><tr><th>NAME</th><th>WHERE</th><th>STATUS</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="4" class="empty-state">Nothing matches “${esc(S.q)}”.</td></tr>`}</tbody></table></div>
      <small class="panel-subtitle" style="display:block;margin:-6px 0 10px">${hits.length > SEARCH_LIMIT ? `Showing the first ${SEARCH_LIMIT} matches; type more to narrow it.` : `${shown.length} match${shown.length === 1 ? "" : "es"}.`}</small>`;
  }

  // ───────────── dialogs (the page's modal) ─────────────
  let submitHandler = null;
  function dialog({ title, description, submit, fields, onSubmit }) {
    modalState = { type: "geoAdmin" }; // eslint-disable-line no-undef -- the page's modal state (01.js)
    $("modalTitle").textContent = title;
    $("modalDescription").textContent = description || "";
    $("modalSubmit").textContent = submit;
    $("modalFields").innerHTML = fields;
    submitHandler = onSubmit;
    $("modalBackdrop").classList.add("open");
    $("modalFields").querySelector("input:not([type=hidden]), textarea, select")?.focus();
  }
  const field = (id, label, control, full = true) => `<div class="field${full ? " full" : ""}"><label for="${id}">${esc(label)}</label>${control}<small class="df-field-error" data-error-for="${id}" role="alert" style="display:block;margin-top:4px;color:#c2410c;font-size:12px"></small></div>`;
  const coordFields = (p = {}) =>
    field("geoLat", "Latitude (optional)", `<input id="geoLat" type="number" step="0.000001" min="20" max="27" value="${p.lat ?? ""}">`, false) +
    field("geoLng", "Longitude (optional)", `<input id="geoLng" type="number" step="0.000001" min="88" max="93" value="${p.lng ?? ""}">`, false);
  function fieldError(id, message) {
    const slot = document.querySelector(`[data-error-for="${id}"]`);
    if (slot) slot.textContent = message || "";
    $(id)?.setAttribute("aria-invalid", message ? "true" : "false");
    return !message;
  }
  const clearErrors = () => document.querySelectorAll("#modalFields [data-error-for]").forEach(el => (el.textContent = ""));
  /** Optional coordinates: both or neither, in Bangladesh. Returns { lat, lng } or null when invalid. */
  function coords() {
    const lat = $("geoLat").value.trim();
    const lng = $("geoLng").value.trim();
    if (!lat && !lng) return { lat: null, lng: null };
    let ok = fieldError("geoLat", !lat ? "Give both latitude and longitude, or neither" : Number(lat) < 20 || Number(lat) > 27 ? "Latitude must be between 20 and 27" : "");
    ok = fieldError("geoLng", !lng ? "Give both latitude and longitude, or neither" : Number(lng) < 88 || Number(lng) > 93 ? "Longitude must be between 88 and 93" : "") && ok;
    return ok ? { lat: Number(lat), lng: Number(lng) } : null;
  }
  function nameProblem(value, what) {
    const v = value.trim();
    if (!v) return `Enter the ${what} name`;
    if (v.length > 80) return "Use at most 80 characters";
    if (v.includes("|")) return 'A name can\'t contain "|"';
    return "";
  }

  window.addEventListener(
    "submit",
    event => {
      if (event.target.id !== "modalForm" || modalState?.type !== "geoAdmin" || !submitHandler) return; // eslint-disable-line no-undef
      event.preventDefault();
      event.stopImmediatePropagation();
      const button = $("modalSubmit");
      if (button.disabled) return;
      clearErrors();
      button.disabled = true;
      Promise.resolve()
        .then(() => submitHandler())
        .catch(error => {
          if (!error) return;
          const fieldName = error.details?.field;
          const target = { name: "geoName", lat: "geoLat", lng: "geoLng", names: "geoAreas", hubId: "geoHub" }[fieldName];
          if (target && $(target)) fieldError(target, error.message);
          else toast(error instanceof DF.ApiError ? DF.describe(error) : error.message);
        })
        .finally(() => (button.disabled = false));
    },
    true,
  );

  async function changed(message, { notice = "" } = {}) {
    if (typeof closeModal === "function") closeModal();
    S.notice = notice;
    resetCounts();
    await loadTree();
    toast(message);
  }
  const placeOf = (level, name) => (level === "district" ? { district: name } : level === "zone" ? { district: S.district, zone: name } : { district: S.district, zone: S.zone, area: name });
  const path = level => `/geography/${level === "district" ? "districts" : level === "zone" ? "zones" : "areas"}`;
  const itemOf = (level, name) => (level === "district" ? S.tree.districts : level === "zone" ? district()?.zones || [] : zone()?.areas || []).find(i => same(i.name, name));

  async function openAdd(level) {
    if (level === "district")
      return dialog({
        title: "Add district",
        description: "A new district for booking forms, templates and imports. Add its zones next.",
        submit: "Add district",
        fields: field("geoName", "District name", `<input id="geoName" maxlength="80" required placeholder="e.g. Bandarban">`) + coordFields(),
        onSubmit: async () => {
          const name = $("geoName").value.trim();
          const p = coords();
          if (!fieldError("geoName", nameProblem(name, "district")) || !p) return;
          const r = await DF.api(path("district"), { method: "POST", body: { name, ...(p.lat != null ? p : {}) } });
          S.district = r.district;
          S.zone = null;
          await changed(`District ${r.district} added.`);
        },
      });
    if (level === "zone") {
      const d = district();
      if (!d) return;
      S.hubs ??= await DF.api("/hubs").catch(() => []);
      return dialog({
        title: `Add zone · ${d.name}`,
        description: "Zone names are unique across the country; add the district in brackets when a name repeats, e.g. “Kaliganj (Gazipur)”.",
        submit: "Add zone",
        fields:
          field("geoName", "Zone name", `<input id="geoName" maxlength="80" required placeholder="e.g. Thanchi">`) +
          field("geoHub", "Serving hub (optional)", `<select id="geoHub"><option value="">No serving hub yet</option>${S.hubs.map(h => `<option value="${esc(h.id)}">${esc(h.name)} · ${esc(h.code)}${h.type === "FRANCHISE" ? " · Franchise" : ""}</option>`).join("")}</select>`) +
          coordFields(),
        onSubmit: async () => {
          const name = $("geoName").value.trim();
          const p = coords();
          if (!fieldError("geoName", nameProblem(name, "zone")) || !p) return;
          const r = await DF.api(path("zone"), { method: "POST", body: { district: d.name, name, ...(p.lat != null ? p : {}), ...($("geoHub").value ? { hubId: $("geoHub").value } : {}) } });
          S.zone = r.zone;
          await changed(`Zone ${r.zone} added to ${r.district}${r.deliveryZone ? ` (delivery zone ${r.deliveryZone.code})` : ""}.`);
        },
      });
    }
    const z = zone();
    if (!z) return;
    dialog({
      title: `Add areas · ${z.name}`,
      description: "One area per line (paste a list). Names already in the zone and invalid lines are skipped and listed.",
      submit: "Add areas",
      fields: field("geoAreas", "Areas", `<textarea id="geoAreas" rows="8" required placeholder="Kaptai Bazar&#10;Chandraghona&#10;Banarupa"></textarea>`),
      onSubmit: async () => {
        const names = $("geoAreas").value.split(/\r?\n/);
        if (!names.some(n => n.trim())) return void fieldError("geoAreas", "Enter at least one area");
        if (names.length > 2000) return void fieldError("geoAreas", "Add at most 2,000 areas at once");
        const r = await DF.api(path("area"), { method: "POST", body: { district: S.district, zone: z.name, names } });
        const skipped = r.skipped.map(s => `Line ${s.line} · ${s.name}: ${s.reason}`).join("\n");
        await changed(`${r.added.length} area${r.added.length === 1 ? "" : "s"} added to ${r.zone}${r.skipped.length ? `; ${r.skipped.length} skipped` : ""}.`, {
          notice: r.skipped.length ? `Skipped when adding areas to ${r.zone}:\n${skipped}` : "",
        });
      },
    });
  }

  function openEdit(level, name) {
    const item = itemOf(level, name);
    if (!item) return;
    const what = level;
    dialog({
      title: `Edit ${what} · ${item.name}`,
      description: "Renaming updates every parcel, address, hub, rider, delivery zone, SLA policy and import setting that names it, in one step, and is recorded in the audit log.",
      submit: "Save",
      fields: field("geoName", `${what[0].toUpperCase()}${what.slice(1)} name`, `<input id="geoName" maxlength="80" required value="${esc(item.name)}">`) + coordFields(item),
      onSubmit: async () => {
        const next = $("geoName").value.trim();
        const p = coords();
        if (!fieldError("geoName", nameProblem(next, what)) || !p) return;
        const body = { ...placeOf(level, item.name) };
        if (next !== item.name) body.name = next;
        if ((p.lat ?? null) !== (item.lat ?? null) || (p.lng ?? null) !== (item.lng ?? null)) Object.assign(body, p);
        if (!body.name && !("lat" in body)) {
          if (typeof closeModal === "function") closeModal();
          return toast("Nothing changed.");
        }
        const r = await DF.api(path(level), { method: "PATCH", body });
        if (level === "district") S.district = r.district;
        if (level === "zone") S.zone = r.zone;
        const refs = Object.values(r.references || {}).reduce((s, n) => s + n, 0);
        await changed(body.name ? `${item.name} renamed to ${body.name}${refs ? `; ${num(refs)} record${refs === 1 ? "" : "s"} updated` : ""}.` : `${item.name} saved.`);
      },
    });
  }

  async function toggle(level, name, button) {
    const item = itemOf(level, name);
    if (!item) return;
    const next = !item.active;
    const effect = next
      ? { title: `Activate ${item.name}?`, message: "It appears again on booking forms, templates and imports.", confirm: "Activate" }
      : { title: `Deactivate ${item.name}?`, message: `It disappears from new bookings, dropdowns, templates and imports${level === "district" ? " (with its zones and areas)" : level === "zone" ? " (with its areas)" : ""}. Existing parcels, addresses and hubs keep it.`, confirm: "Deactivate", danger: true };
    if (!(await DF.confirm(effect))) return;
    button.disabled = true;
    try {
      await DF.api(path(level), { method: "PATCH", body: { ...placeOf(level, item.name), active: next } });
      await changed(`${item.name} ${next ? "activated" : "deactivated"}.`);
    } catch (error) {
      toast(DF.describe(error));
    } finally {
      button.disabled = false;
    }
  }

  const usageList = usage => `<ul style="margin:6px 0 0;padding-left:18px">${usage.items.map(i => `<li>${esc(i.label)}: <strong>${num(i.count)}</strong></li>`).join("")}</ul>`;
  function showInUse(level, item, usage) {
    dialog({
      title: `${item.name} is in use`,
      description: `It can't be deleted while ${num(usage.total)} record${usage.total === 1 ? "" : "s"} use${usage.total === 1 ? "s" : ""} it. Deactivate it instead: it disappears from new bookings and lists, and existing records keep it.`,
      submit: item.active ? "Deactivate instead" : "Close",
      fields: `<div class="field full" id="geoUsage"><label>What uses it</label>${usageList(usage)}</div>`,
      onSubmit: async () => {
        if (!item.active) {
          if (typeof closeModal === "function") closeModal();
          return;
        }
        await DF.api(path(level), { method: "PATCH", body: { ...placeOf(level, item.name), active: false } });
        await changed(`${item.name} deactivated.`);
      },
    });
  }

  async function remove(level, name, button) {
    const item = itemOf(level, name);
    if (!item) return;
    button.disabled = true;
    try {
      const usage = await DF.api(`/geography/usage?${new URLSearchParams(placeOf(level, item.name))}`);
      if (usage.total) return showInUse(level, item, usage);
      const children = level === "district" ? ` and its ${num(item.zones.length)} zones` : level === "zone" ? ` and its ${num(item.areas.length)} areas` : "";
      if (!(await DF.confirm({ title: `Delete ${item.name}${children}?`, message: "Nothing uses it. This can't be undone (you can add it again later).", confirm: "Delete", danger: true }))) return;
      await DF.api(`${path(level)}?${new URLSearchParams(placeOf(level, item.name))}`, { method: "DELETE" });
      if (level === "district") S.district = null;
      if (level !== "area") S.zone = null;
      await changed(`${item.name} deleted.`);
    } catch (error) {
      if (error?.code === "IN_USE" && error.details?.usage) return showInUse(level, item, error.details.usage);
      toast(DF.describe(error));
    } finally {
      button.disabled = false;
    }
  }

  // ───────────── events ─────────────
  const pick = (level, name) => {
    if (level === "district") {
      if (same(S.district, name)) return;
      S.district = name;
      S.zone = district()?.zones[0]?.name || null;
    } else S.zone = name;
    draw();
    void loadCounts();
  };
  window.addEventListener(
    "click",
    event => {
      const t = event.target;
      if (!(t instanceof Element) || !t.closest("#geoAdmin")) return;
      const add = t.closest("[data-geo-add]");
      const edit = t.closest("[data-geo-edit]");
      const tog = t.closest("[data-geo-toggle]");
      const del = t.closest("[data-geo-delete]");
      const go = t.closest("[data-geo-goto]");
      const choose = t.closest("[data-geo-pick]");
      if (!add && !edit && !tog && !del && !go && !choose) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (add) return void openAdd(add.dataset.geoAdd).catch(error => toast(DF.describe(error)));
      if (edit) return openEdit(edit.dataset.geoEdit, edit.dataset.name);
      if (tog) return void toggle(tog.dataset.geoToggle, tog.dataset.name, tog);
      if (del) return void remove(del.dataset.geoDelete, del.dataset.name, del);
      if (go) {
        S.district = go.dataset.geoGoto;
        S.zone = go.dataset.zone || district()?.zones[0]?.name || null;
        S.q = "";
        draw();
        void loadCounts();
        return document.querySelector(`#geoAdmin [data-geo-row="zone"][data-name="${CSS.escape(S.zone || "")}"]`)?.scrollIntoView({ block: "nearest" });
      }
      pick(choose.dataset.geoPick, choose.dataset.name);
    },
    true,
  );
  window.addEventListener(
    "keydown",
    event => {
      const choose = event.target instanceof Element && event.target.closest("#geoAdmin [data-geo-pick]");
      if (choose && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        pick(choose.dataset.geoPick, choose.dataset.name);
      }
    },
    true,
  );
  let searchTimer;
  window.addEventListener(
    "input",
    event => {
      if (event.target.id !== "geoSearch") return;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        S.q = event.target.value.trim();
        const caret = event.target.selectionStart;
        draw();
        const again = $("geoSearch");
        again?.focus();
        try {
          again?.setSelectionRange(caret, caret);
        } catch {}
      }, 200);
    },
    true,
  );
  window.addEventListener(
    "change",
    event => {
      if (event.target.id !== "geoShowInactive") return;
      S.showInactive = event.target.checked;
      draw();
    },
    true,
  );

  // Draw on the catalog page; keep it fresh when someone else changes the geography.
  const baseShowPage = window.showPage;
  window.showPage = showPage = function (page) {
    baseShowPage(page);
    current = page;
    if (page !== PAGE) return;
    if (S.tree) draw();
    void loadTree();
  };
  DF.events.on("catalog.updated", () => {
    S.hubs = null;
    if (current === PAGE) {
      resetCounts();
      void loadTree();
    } else S.tree = null;
  });
})();
