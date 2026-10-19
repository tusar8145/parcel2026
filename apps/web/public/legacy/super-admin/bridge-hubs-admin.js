/*
 * Super admin → "Hubs & zones" (network setup, moved here from Courier Operations):
 *   Hubs            the hub register: add, edit (place, address, capacity, map pin), deactivate / reactivate,
 *                   delete when unused (GET /hubs?includeInactive=true, POST /hubs, PATCH /hubs/:id,
 *                   GET /hubs/:id/usage, DELETE /hubs/:id)
 *   Delivery zones  which hub serves each zone (merchants and parcels follow it), its route, zones on / off
 *                   (GET /zones, PATCH /zones/:id); new zones are added in Pricing & catalogs (geography)
 *   Routes          delivery routes of a hub with a default rider (GET/POST/PATCH /routes)
 */
(() => {
  const DF = window.DF;
  if (!DF) return;
  const PAGE = "Hubs & zones";
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const toast = message => (typeof showToast === "function" ? showToast(message) : console.info(message));
  const fail = error => toast(DF.describe(error));
  const num = n => Number(n || 0).toLocaleString("en-US");
  const S = { tab: "hubs", hubs: [], catalog: null, riders: [], zones: { items: [], next: null, loading: false, q: "", district: "", hubId: "" }, routes: [], form: null, loaded: false };
  let active = false;
  // Courier Operations' search links a zone here: /super-admin?page=Hubs+%26+zones&zone=<name> (read before the address is tidied).
  const linkedZone = new URLSearchParams(location.search).get("zone");
  if (linkedZone) Object.assign(S, { tab: "zones" }), (S.zones.q = linkedZone);

  // The base renderer draws unknown pages from its `generic` table: give it an empty entry.
  try {
    if (typeof generic === "object" && !generic[PAGE]) generic[PAGE] = { desc: "Hubs, delivery zones and routes", cols: [], rows: [] };
  } catch {}

  // Menu item under Platform control, after Shared catalogs & locations.
  const nav = $("navigation");
  if (nav && !nav.querySelector(`[data-page="${PAGE}"]`)) {
    const after = nav.querySelector('[data-page="Pricing & catalogs"]');
    const button = document.createElement("button");
    button.className = "nav-item";
    button.dataset.page = PAGE;
    button.innerHTML = `<svg fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7"><use href="#i-building"/></svg>Hubs & zones`;
    if (after) after.after(button, " ");
    else nav.append(button);
  }

  async function load() {
    const [hubs, catalog, routes, riders] = await Promise.all([
      DF.api("/hubs?includeInactive=true"),
      S.catalog ? Promise.resolve(S.catalog) : DF.api("/catalog").catch(() => null),
      DF.api("/routes?limit=200").catch(() => ({ items: [] })),
      DF.api("/riders?active=true").catch(() => []),
    ]);
    Object.assign(S, { hubs, catalog, routes: routes.items || routes || [], riders, loaded: true });
    if (!S.zones.items.length) await loadZones(true);
  }
  async function loadZones(reset) {
    const z = S.zones;
    if (z.loading) return;
    z.loading = true;
    const p = new URLSearchParams({ limit: "200" });
    if (z.q) p.set("q", z.q);
    if (z.district) p.set("district", z.district);
    if (z.hubId) p.set("hubId", z.hubId);
    if (!reset && z.next) p.set("cursor", z.next);
    try {
      const page = await DF.api(`/zones?${p}`);
      z.items = reset ? page.items : [...z.items, ...page.items];
      z.next = page.nextCursor;
    } catch (error) {
      fail(error);
    } finally {
      z.loading = false;
    }
  }

  const pill = (text, good) => `<span class="status ${good ? "status-good" : "status-bad"}">${esc(text)}</span>`;
  const hubOptions = (selected, empty) => `${empty ? `<option value="">${esc(empty)}</option>` : ""}${S.hubs.filter(h => h.active || h.id === selected).map(h => `<option value="${esc(h.id)}" ${h.id === selected ? "selected" : ""}>${esc(h.name)}${h.type === "FRANCHISE" ? " · Franchise" : ""}</option>`).join("")}`;

  function hubsMarkup() {
    const rows = S.hubs
      .map(
        h => `<tr data-hub-row="${esc(h.id)}"><td class="primary-cell">${esc(h.name)}${h.type === "FRANCHISE" ? ` <span class="status status-blue" data-hub-tag>Franchise</span>` : ""}<span class="subcell">${esc(h.code)}</span></td>
          <td>${esc([h.zone, h.district].filter(Boolean).join(", "))}<span class="subcell">${esc(h.address)}</span></td>
          <td>${h.capacity ? num(h.capacity) : "—"}</td>
          <td>${pill(h.active ? "Active" : "Inactive", h.active)}</td>
          <td style="white-space:nowrap"><button class="mini-button" data-hz-edit="${esc(h.id)}">Edit</button> <button class="mini-button" data-hz-toggle="${esc(h.id)}">${h.active ? "Deactivate" : "Activate"}</button> <button class="mini-button" data-hz-delete="${esc(h.id)}">Delete</button></td></tr>`,
      )
      .join("");
    return `<section class="panel table-panel"><div class="panel-heading"><div><h2 class="panel-title">Hubs</h2><p class="panel-subtitle">${S.hubs.filter(h => h.active).length} active of ${S.hubs.length}. A hub's place sets where drop-offs are priced from; its capacity is used for planning.</p></div><div class="table-tools"><button class="button button-primary" id="hzNewHub">Add hub</button></div></div><div class="table-scroll"><table><thead><tr><th>HUB</th><th>PLACE</th><th>CAPACITY</th><th>STATUS</th><th></th></tr></thead><tbody id="hzHubs">${rows || `<tr><td colspan="5" class="empty-state">No hubs yet.</td></tr>`}</tbody></table></div></section>`;
  }

  function zonesMarkup() {
    const z = S.zones;
    const districts = S.catalog?.districts || [];
    const rows = z.items
      .map(
        x => `<tr data-zone="${esc(x.id)}"><td class="primary-cell">${esc(x.name)}<span class="subcell">${esc(x.code)}</span></td><td>${esc(x.district)}</td>
          <td><select class="select-small" data-hz-zone-hub="${esc(x.id)}" aria-label="Serving hub of ${esc(x.name)}">${hubOptions(x.hub?.id || "", "No hub")}</select></td>
          <td><select class="select-small" data-hz-zone-route="${esc(x.id)}" aria-label="Route of ${esc(x.name)}"><option value="">No route</option>${S.routes.filter(r => (r.hub?.id || r.hubId) === x.hub?.id && (r.active || r.id === x.route?.id)).map(r => `<option value="${esc(r.id)}" ${r.id === x.route?.id ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</select></td><td>${x.areas?.length ? num(x.areas.length) : "All"}</td>
          <td>${pill(x.active ? "Active" : "Off", x.active)} <button class="mini-button" data-hz-zone-toggle="${esc(x.id)}">${x.active ? "Turn off" : "Turn on"}</button></td></tr>`,
      )
      .join("");
    return `<section class="panel table-panel"><div class="panel-heading"><div><h2 class="panel-title">Delivery zones</h2><p class="panel-subtitle">The serving hub of a zone receives its deliveries and Hub Pickup parcels; merchants picking up there belong to it. New zones are added in Shared catalogs & locations.</p></div><div class="table-tools"><input class="table-search" id="hzZoneSearch" placeholder="Search zones…" value="${esc(z.q)}" aria-label="Search zones"><select class="select-small" id="hzZoneDistrict" aria-label="District"><option value="">All districts</option>${districts.map(d => `<option ${d === z.district ? "selected" : ""}>${esc(d)}</option>`).join("")}</select><select class="select-small" id="hzZoneHub" aria-label="Hub">${hubOptions(z.hubId, "All hubs")}</select></div></div><div class="table-scroll"><table><thead><tr><th>ZONE</th><th>DISTRICT</th><th>SERVING HUB</th><th>ROUTE</th><th>AREAS</th><th>STATUS</th></tr></thead><tbody id="hzZones">${rows || `<tr><td colspan="6" class="empty-state">${z.loading ? "Loading…" : "No zones match."}</td></tr>`}</tbody></table></div>${
      z.next ? `<div class="table-footer" style="padding:11px 16px"><button class="button button-sm" id="hzZonesMore">Load more</button></div>` : ""
    }</section>`;
  }

  function routesMarkup() {
    const rows = S.routes
      .map(
        r => `<tr data-route="${esc(r.code)}"><td class="primary-cell">${esc(r.name)}<span class="subcell">${esc(r.code)}</span></td><td>${esc(r.hub?.name || "—")}</td><td>${esc(r.defaultRider?.label || "—")}</td><td>${num(r.zones)}</td><td>${pill(r.active ? "Active" : "Off", r.active)}</td><td><button class="mini-button" data-hz-route="${esc(r.id)}">Edit</button></td></tr>`,
      )
      .join("");
    return `<section class="panel table-panel"><div class="panel-heading"><div><h2 class="panel-title">Routes</h2><p class="panel-subtitle">Zones a hub serves together, with the rider who usually takes them.</p></div><div class="table-tools"><button class="button button-primary" id="hzNewRoute">Add route</button></div></div><div class="table-scroll"><table><thead><tr><th>ROUTE</th><th>HUB</th><th>DEFAULT RIDER</th><th>ZONES</th><th>STATUS</th><th></th></tr></thead><tbody id="hzRoutes">${rows || `<tr><td colspan="6" class="empty-state">No routes yet.</td></tr>`}</tbody></table></div></section>`;
  }

  function render() {
    if (!active) return;
    const tabs = [
      ["hubs", "Hubs"],
      ["zones", "Delivery zones"],
      ["routes", "Routes"],
    ];
    $("mainContent").innerHTML = `<div class="page-heading"><div><p class="eyebrow">Platform control · network setup</p><h1>Hubs & zones</h1><p class="subtitle">The hub register, which hub serves each delivery zone, and delivery routes.</p></div></div>
      <div class="hz-tabs" role="tablist" style="display:flex;gap:6px;flex-wrap:wrap;margin:0 0 14px">${tabs.map(([k, l]) => `<button type="button" role="tab" class="button button-sm${S.tab === k ? " button-primary" : ""}" data-hz-tab="${k}" aria-selected="${S.tab === k}">${esc(l)}</button>`).join("")}</div>
      <div id="hzBody">${S.tab === "hubs" ? hubsMarkup() : S.tab === "zones" ? zonesMarkup() : routesMarkup()}</div>`;
  }

  // ───────────── dialogs ─────────────
  function dialog(title, subtitle, inner) {
    $("hzDialog")?.remove();
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div id="hzDialog" role="dialog" aria-modal="true" aria-labelledby="hzDialogTitle" style="position:fixed;inset:0;z-index:100;background:#14203380;display:grid;place-items:center;padding:18px"><section style="width:min(620px,100%);max-height:88vh;overflow:auto;background:#fff;border-radius:14px;padding:20px"><h2 id="hzDialogTitle" style="margin:0;font-size:18px">${esc(title)}</h2><p class="panel-subtitle" style="margin:4px 0 12px">${esc(subtitle)}</p><form id="hzForm" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px 12px">${inner}<p id="hzError" role="alert" style="grid-column:1/-1;margin:0;color:#b42318;font-size:13px"></p><div style="grid-column:1/-1;display:flex;justify-content:flex-end;gap:8px"><button type="button" class="button" data-hz-close>Cancel</button><button type="submit" class="button button-primary">Save</button></div></form></section></div>`,
    );
    $("hzDialog").addEventListener("click", e => (e.target.id === "hzDialog" || e.target.closest("[data-hz-close]")) && $("hzDialog").remove());
  }
  const field = (id, label, value = "", attrs = "") => `<div class="field"><label for="${id}">${esc(label)}</label><input id="${id}" value="${esc(value ?? "")}" ${attrs}></div>`;

  function openHub(h) {
    S.form = { kind: "hub", id: h?.id || null };
    const districts = S.catalog?.districts || [];
    const zones = h ? S.catalog?.zonesByDistrict?.[h.district] || [] : [];
    dialog(
      h ? `Edit ${h.name}` : "Add hub",
      h ? `${h.code}${h.type === "FRANCHISE" ? " · franchise hub (its franchise is managed in Franchises)" : ""}` : "A company hub of the network. Franchise hubs are created in Franchises.",
      `${h ? "" : field("hzCode", "Code", "", 'required maxlength="20" placeholder="DHK-MOT"')}${field("hzName", "Name", h?.name, 'required maxlength="120"')}
       <div class="field"><label for="hzDistrict">District</label><select id="hzDistrict" required><option value="">Choose</option>${districts.map(d => `<option ${d === h?.district ? "selected" : ""}>${esc(d)}</option>`).join("")}</select></div>
       <div class="field"><label for="hzZone">Zone (thana / upazila)</label><select id="hzZone" required><option value="">Choose</option>${zones.map(z => `<option ${z === h?.zone ? "selected" : ""}>${esc(z)}</option>`).join("")}</select></div>
       <div style="grid-column:1/-1">${field("hzAddress", "Address", h?.address, 'required maxlength="300"')}</div>
       ${field("hzCapacity", "Capacity (parcels at once)", h?.capacity ?? "", 'type="number" min="1" step="1"')}${field("hzLat", "Latitude (optional)", h?.lat ?? "", 'type="number" step="any" min="20" max="27"')}${field("hzLng", "Longitude (optional)", h?.lng ?? "", 'type="number" step="any" min="88" max="93"')}`,
    );
    $("hzDistrict").addEventListener("change", () => {
      const list = S.catalog?.zonesByDistrict?.[$("hzDistrict").value] || [];
      $("hzZone").innerHTML = `<option value="">Choose</option>${list.map(z => `<option>${esc(z)}</option>`).join("")}`;
    });
  }

  function openRoute(r) {
    S.form = { kind: "route", id: r?.id || null };
    const riderOptions = hubId => `<option value="">No default rider</option>${S.riders.filter(x => !hubId || x.hub?.id === hubId).map(x => `<option value="${esc(x.id)}" ${x.id === r?.defaultRider?.id ? "selected" : ""}>${esc(x.label || `${x.code} · ${x.name}`)}</option>`).join("")}`;
    dialog(
      r ? `Edit ${r.name}` : "Add route",
      "Choose a zone's route in Delivery zones (routes of its serving hub); the default rider is suggested for them.",
      `${field("hzRouteCode", "Code", r?.code, `required maxlength="20" ${r ? "" : 'placeholder="GUL-R1"'}`)}${field("hzRouteName", "Name", r?.name, 'required maxlength="120"')}
       <div class="field"><label for="hzRouteHub">Hub</label><select id="hzRouteHub" required>${hubOptions(r?.hub?.id || "", "Choose")}</select></div>
       <div class="field"><label for="hzRouteRider">Default rider</label><select id="hzRouteRider">${riderOptions(r?.hub?.id)}</select></div>
       <div style="grid-column:1/-1">${field("hzRouteNote", "Note (optional)", r?.note ?? "", 'maxlength="500"')}</div>
       <label style="display:flex;gap:8px;align-items:center;font-size:13px"><input type="checkbox" id="hzRouteActive" ${r ? (r.active ? "checked" : "") : "checked"}> Active</label>`,
    );
    $("hzRouteHub").addEventListener("change", () => ($("hzRouteRider").innerHTML = riderOptions($("hzRouteHub").value)));
  }

  async function submit() {
    const f = S.form;
    const button = $("hzForm").querySelector('[type="submit"]');
    const optNum = id => ($(id).value === "" ? null : Number($(id).value));
    button.disabled = true;
    $("hzError").textContent = "";
    try {
      if (f.kind === "hub") {
        const body = { name: $("hzName").value.trim(), district: $("hzDistrict").value, zone: $("hzZone").value || null, address: $("hzAddress").value.trim(), capacity: optNum("hzCapacity"), lat: optNum("hzLat"), lng: optNum("hzLng") };
        if (f.id) await DF.api(`/hubs/${f.id}`, { method: "PATCH", body });
        else await DF.api("/hubs", { method: "POST", body: { ...body, code: $("hzCode").value.trim() } });
        toast(f.id ? `${body.name} saved.` : `${body.name} added.`);
      } else {
        const body = { code: $("hzRouteCode").value.trim(), name: $("hzRouteName").value.trim(), hubId: $("hzRouteHub").value, defaultRiderId: $("hzRouteRider").value || null, note: $("hzRouteNote").value.trim() || (f.id ? null : undefined), active: $("hzRouteActive").checked };
        if (f.id) await DF.api(`/routes/${f.id}`, { method: "PATCH", body });
        else await DF.api("/routes", { method: "POST", body });
        toast(`Route ${body.name} saved.`);
      }
      $("hzDialog")?.remove();
      await load();
      render();
    } catch (error) {
      $("hzError").textContent = DF.describe(error);
      button.disabled = false;
    }
  }

  async function toggleHub(h) {
    const off = h.active;
    const ok = await DF.confirm({
      title: off ? `Deactivate ${h.name}?` : `Activate ${h.name}?`,
      message: off ? "It takes no new parcels and leaves booking forms. Zones it serves keep it until you change their serving hub; merchants of those zones move to “No hub”." : "It takes parcels again; merchants of the zones it serves come back to it.",
      confirm: off ? "Deactivate" : "Activate",
      danger: off,
    });
    if (!ok) return;
    try {
      await DF.api(`/hubs/${h.id}`, { method: "PATCH", body: { active: !off } });
      toast(off ? `${h.name} is deactivated.` : `${h.name} is active again.`);
      await load();
      render();
    } catch (error) {
      fail(error);
    }
  }

  async function removeHub(h) {
    try {
      const usage = await DF.api(`/hubs/${h.id}/usage`);
      if (usage.total) {
        const list = usage.items.filter(i => i.count).map(i => `${i.label}: ${num(i.count)}`).join(" · ");
        if (!h.active) return void DF.confirm({ title: `${h.name} is in use`, message: `${list}. It is deactivated already; existing records keep it.`, confirm: "OK", cancel: "Close" });
        const off = await DF.confirm({ title: `${h.name} is in use`, message: `${list}. Deactivate it instead: it leaves new bookings and lists, existing records keep it.`, confirm: "Deactivate", danger: true });
        if (!off) return;
        await DF.api(`/hubs/${h.id}`, { method: "PATCH", body: { active: false } });
        toast(`${h.name} is deactivated.`);
      } else {
        if (!(await DF.confirm({ title: `Delete ${h.name}?`, message: "Nothing uses this hub. It is removed for good.", confirm: "Delete", danger: true }))) return;
        await DF.api(`/hubs/${h.id}`, { method: "DELETE" });
        toast(`${h.name} deleted.`);
      }
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
    $("mainContent").innerHTML = `<div class="page-heading"><div><p class="eyebrow">Platform control · network setup</p><h1>Hubs & zones</h1><p class="subtitle">Loading…</p></div></div>`;
    void load().then(render, fail);
  };

  window.addEventListener(
    "click",
    event => {
      const t = event.target instanceof Element ? event.target : null;
      if (!t || !active) return;
      let el;
      if ((el = t.closest("[data-hz-tab]"))) return void ((S.tab = el.dataset.hzTab), render());
      if (t.closest("#hzNewHub")) return openHub(null);
      if ((el = t.closest("[data-hz-edit]"))) return openHub(S.hubs.find(h => h.id === el.dataset.hzEdit));
      if ((el = t.closest("[data-hz-toggle]"))) return void toggleHub(S.hubs.find(h => h.id === el.dataset.hzToggle));
      if ((el = t.closest("[data-hz-delete]"))) return void removeHub(S.hubs.find(h => h.id === el.dataset.hzDelete));
      if (t.closest("#hzNewRoute")) return openRoute(null);
      if ((el = t.closest("[data-hz-route]"))) return openRoute(S.routes.find(r => r.id === el.dataset.hzRoute));
      if (t.closest("#hzZonesMore")) return void loadZones(false).then(render);
      if ((el = t.closest("[data-hz-zone-toggle]"))) {
        const zone = S.zones.items.find(z => z.id === el.dataset.hzZoneToggle);
        return void DF.api(`/zones/${zone.id}`, { method: "PATCH", body: { active: !zone.active } }).then(
          updated => (Object.assign(zone, updated), toast(`${zone.name} is ${updated.active ? "on" : "off"}.`), render()),
          fail,
        );
      }
    },
    true,
  );
  document.addEventListener("change", event => {
    if (!active) return;
    const t = event.target;
    if (t.dataset?.hzZoneHub) {
      const zone = S.zones.items.find(z => z.id === t.dataset.hzZoneHub);
      t.disabled = true;
      return void DF.api(`/zones/${zone.id}`, { method: "PATCH", body: { hubId: t.value || null, ...(zone.route && S.routes.find(r => r.id === zone.route.id)?.hub?.id !== t.value ? { routeId: null } : {}) } }).then(
        updated => {
          Object.assign(zone, updated);
          toast(`${zone.name}: ${updated.hub ? `served by ${updated.hub.name}` : "no serving hub"}. Its merchants follow.`);
          render();
        },
        error => ((t.disabled = false), fail(error)),
      );
    }
    if (t.dataset?.hzZoneRoute) {
      const zone = S.zones.items.find(z => z.id === t.dataset.hzZoneRoute);
      t.disabled = true;
      return void DF.api(`/zones/${zone.id}`, { method: "PATCH", body: { routeId: t.value || null } }).then(
        updated => (Object.assign(zone, updated), toast(`${zone.name}: ${updated.route ? `on route ${updated.route.name}` : "no route"}.`), render()),
        error => ((t.disabled = false), fail(error)),
      );
    }
    if (t.id === "hzZoneDistrict" || t.id === "hzZoneHub") {
      S.zones[t.id === "hzZoneDistrict" ? "district" : "hubId"] = t.value;
      return void loadZones(true).then(render);
    }
  });
  let searchTimer = null;
  document.addEventListener("input", event => {
    if (!active || event.target.id !== "hzZoneSearch") return;
    clearTimeout(searchTimer);
    const value = event.target.value.trim();
    searchTimer = setTimeout(() => {
      S.zones.q = value;
      void loadZones(true).then(() => {
        render();
        const input = $("hzZoneSearch");
        input?.focus();
        input?.setSelectionRange(input.value.length, input.value.length);
      });
    }, 350);
  });
  window.addEventListener(
    "submit",
    event => {
      if (!active || event.target.id !== "hzForm") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void submit();
    },
    true,
  );
})();
