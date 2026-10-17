/*
 * Courier Operations on the API, part 3: network configuration and shared UI helpers.
 *
 *   Add rider (Riders page)              POST /riders (rider:manage)
 *   Create dispatch (Dispatch page)      GET /routing/suggestions → POST /routing/suggestions/accept
 *   Hubs & zones: network configuration  /zones, /routes, /hubs/capacity, PATCH /hubs/:id
 *   Hub console scans                    DF.scanner camera button + POST /scans (scan compliance)
 *
 * Ops.ui / Ops.dialog / Ops.recordScan / Ops.printPage are shared with the other bridge-*.js files.
 */
(() => {
  const DF = window.DF;
  const Ops = window.DFOps;
  const $ = id => document.getElementById(id);
  const q = (selector, root = document) => root.querySelector(selector);
  const qa = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = Ops.esc;

  // ───────────── shared UI helpers ─────────────

  const ui = (Ops.ui = {
    field: (id, label, control, full = false) => `<div class="field${full ? " full" : ""}"><label for="${id}">${esc(label)}</label>${control}</div>`,
    input: (id, attrs = "") => `<input id="${id}" ${attrs}>`,
    select: (id, options, selected, attrs = "") =>
      `<select id="${id}" ${attrs}>${options.map(o => (typeof o === "string" ? { value: o, label: o } : o)).map(o => `<option value="${esc(o.value)}" ${String(o.value) === String(selected ?? "") ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select>`,
    hubOptions: (hubs = Ops.myHubs() || DF.state.hubs, empty) => [...(empty ? [{ value: "", label: empty }] : []), ...hubs.map(h => ({ value: h.id, label: h.name }))],
    panel: (title, subtitle, body, tools = "", attrs = "") =>
      `<section class="panel table-panel" ${attrs}><div class="panel-heading"><div><h2 class="panel-title">${esc(title)}</h2>${subtitle ? `<p class="panel-subtitle">${esc(subtitle)}</p>` : ""}</div>${tools ? `<div class="table-tools">${tools}</div>` : ""}</div>${body}</section>`,
    table: (cols, rows, empty, span = cols.length) =>
      `<div class="table-scroll"><table><thead><tr>${cols.map(c => `<th>${esc(c.toUpperCase())}</th>`).join("")}</tr></thead><tbody>${rows || `<tr><td colspan="${span}" class="empty-state">${esc(empty)}</td></tr>`}</tbody></table></div>`,
    footer: (text, more) =>
      `<div class="table-footer" style="padding:11px 16px;border-top:1px solid var(--line);color:#98a2ae;font-size:12px">${esc(text)}${more ? ` <button class="button button-sm" type="button" ${more}>Load more</button>` : ""}</div>`,
    pill: text => statusPill(esc(text)),
    date: iso => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—"),
    /** Runs a repaint and gives the focus (and caret) back to the field that had it. */
    keepFocus: fn => {
      const active = document.activeElement;
      const id = active?.id;
      const pos = active?.selectionStart;
      fn();
      const again = id && document.getElementById(id);
      if (again && again !== active) {
        again.focus();
        try {
          again.setSelectionRange(pos, pos);
        } catch {}
      }
    },
    debounce: (fn, ms = 350) => {
      let t;
      return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
      };
    },
  });

  /** Opens the console's shared dialog. Ops.submitters[kind](button) handles the submit (async; throw to keep it open). */
  Ops.submitters = {};
  Ops.dialog = (kind, { title, description = "", submit = "Save", fields, wide = false, context = {} }) => {
    modalContext = { kind, ...context };
    $("modalTitle").textContent = title;
    $("modalDescription").textContent = description;
    $("modalSubmit").textContent = submit;
    $("modalFields").innerHTML = fields;
    const modal = q("#modalBackdrop .modal");
    if (modal) modal.style.maxWidth = wide ? "min(880px, calc(100vw - 32px))" : "";
    $("modalBackdrop").classList.add("open");
    q("#modalFields input:not([type=hidden]), #modalFields select")?.focus();
  };
  const baseClose = closeModal;
  closeModal = function () {
    const modal = q("#modalBackdrop .modal");
    if (modal) modal.style.maxWidth = "";
    baseClose();
  };
  window.addEventListener(
    "submit",
    event => {
      if (event.target.id !== "modalForm") return;
      const handler = Ops.submitters[modalContext.kind];
      if (!handler) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const button = $("modalSubmit");
      if (button.disabled) return;
      button.disabled = true;
      Promise.resolve()
        .then(() => handler(button))
        .catch(error => error && showToast(error instanceof DF.ApiError ? DF.describe(error) : error.message))
        .finally(() => (button.disabled = false));
    },
    true,
  );

  /** Fire-and-forget scan event for scan compliance. */
  Ops.recordScan = (code, kind, hubId, source = "KEYBOARD", ok = true, message) => {
    if (!code || String(code).trim().length < 3) return;
    DF.api("/scans", { method: "POST", body: { code: String(code).trim(), kind, hubId: hubId || undefined, source, ok, message } }).catch(() => undefined);
  };

  /** A printable page in a popup (A4), printed on load. */
  Ops.printPage = (title, body, { landscape = false, autoPrint = true } = {}) => {
    const popup = window.open("", "_blank");
    if (!popup) return void showToast("Allow pop-ups to print.");
    popup.document.write(
      `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>@page{size:A4${landscape ? " landscape" : ""};margin:12mm}body{font:12px Arial,sans-serif;color:#182230}h1{margin:0 0 4px;font-size:20px}h2{margin:18px 0 6px;font-size:14px}p{color:#647184;margin:3px 0}table{border-collapse:collapse;width:100%;margin-top:8px}th,td{border-bottom:1px solid #dfe4eb;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f5f7fa;font-size:10px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:12px 0}.grid div{border:1px solid #dfe4eb;border-radius:6px;padding:8px}.grid strong{display:block;font-size:15px}.sign{display:flex;justify-content:space-between;gap:24px;margin-top:42px}.sign span{flex:1;border-top:1px solid #687384;padding-top:6px}.barcode svg{height:46px;max-width:100%}@media print{body{print-color-adjust:exact;-webkit-print-color-adjust:exact}}</style></head><body>${body}${autoPrint ? `<script>window.onload=()=>window.print()<\/script>` : ""}</body></html>`,
    );
    popup.document.close();
  };

  /** Barcode SVG (Code 39) for a code, from the page script. */
  Ops.barcode = code => (typeof courierBarcode === "function" ? courierBarcode(code) : esc(code));

  const lazyLoad = (key, path, maxAge = 60000) => Ops.lazy(key, () => DF.api(path), maxAge);

  // ───────────── Add rider ─────────────

  const VEHICLES = [
    { value: "MOTORBIKE", label: "Motorcycle" },
    { value: "BICYCLE", label: "Bicycle" },
    { value: "VAN", label: "Van" },
    { value: "ON_FOOT", label: "On foot" },
  ];

  Ops.modals.rider = () => {
    if (!Ops.require("manageRiders", "add riders")) return;
    const zones = (Ops.cache.zones?.value?.items || []).map(z => z.name);
    const catalogZones = Ops.catalog ? Object.values(Ops.catalog.zonesByDistrict).flat() : [];
    Ops.dialog("rider", {
      title: "Add rider",
      description: "Creates the rider's account. They sign in to the rider app with this phone number (SMS code).",
      submit: "Add rider",
      fields:
        ui.field("riderName", "Rider name", ui.input("riderName", 'required maxlength="120" placeholder="Full name" autocomplete="off"')) +
        ui.field("riderPhone", "Phone number", ui.input("riderPhone", 'required inputmode="tel" autocomplete="off"')) +
        ui.field("riderEmail", "Email (optional)", ui.input("riderEmail", 'type="email" maxlength="120"')) +
        ui.field("riderHub", "Hub", ui.select("riderHub", ui.hubOptions(DF.state.hubs, "No hub yet"), Ops.myHubs()?.[0]?.id)) +
        ui.field("riderVehicle", "Vehicle", ui.select("riderVehicle", VEHICLES, "MOTORBIKE")) +
        ui.field("riderZone", "Service zone", `<input id="riderZone" list="riderZoneList" maxlength="80" placeholder="e.g. Gulshan"><datalist id="riderZoneList">${[...new Set([...zones, ...catalogZones])].map(z => `<option value="${esc(z)}">`).join("")}</datalist>`) +
        ui.field("riderCapacity", "Daily capacity (stops, optional)", ui.input("riderCapacity", 'type="number" min="1" max="500" step="1" placeholder="Network default: 40"')),
    });
    DF.phoneInput($("riderPhone"));
  };
  Ops.submitters.rider = async () => {
    const valid = DF.validate($("modalForm"), {
      riderName: v => (v.trim().length < 2 ? "Enter the rider's full name" : ""),
      riderPhone: v => DF.phoneProblem(v),
      riderEmail: v => (v && !/^\S+@\S+\.\S+$/.test(v.trim()) ? "Enter a valid email or leave it empty" : ""),
      riderCapacity: v => (v && (Number(v) < 1 || Number(v) > 500 || !Number.isInteger(Number(v))) ? "Use a whole number from 1 to 500" : ""),
    });
    if (!valid()) return;
    const body = {
      name: $("riderName").value.trim(),
      phone: $("riderPhone").value,
      email: $("riderEmail").value.trim() || undefined,
      hubId: $("riderHub").value || undefined,
      vehicle: $("riderVehicle").value,
      zone: $("riderZone").value.trim() || undefined,
      dailyCapacity: $("riderCapacity").value ? Number($("riderCapacity").value) : undefined,
    };
    const rider = await DF.api("/riders", { method: "POST", body });
    closeModal();
    DF.state.riders = await DF.api("/riders?active=true").catch(() => DF.state.riders);
    Object.keys(Ops.cache).filter(k => k.startsWith("riders:") || k === "dispatch" || k.startsWith("shifts")).forEach(k => Ops.invalidate(k));
    Ops.rerender(true);
    showToast(`${rider.label} added${rider.hub ? ` at ${rider.hub.name}` : ""}. They can sign in to the rider app with ${DF.localPhone(rider.phone)}.`);
  };

  function headingButton(action, label, iconName = "plus", primary = true) {
    const heading = q("#mainContent .page-heading");
    if (!heading || q(`[data-action="${action}"]`, heading)) return;
    let actions = q(".heading-actions", heading);
    if (!actions) {
      actions = document.createElement("div");
      actions.className = "heading-actions";
      heading.append(actions);
    }
    actions.insertAdjacentHTML("beforeend", `<button class="button${primary ? " button-primary" : ""}" data-action="${action}">${icon(iconName)} ${esc(label)}</button>`);
  }

  const baseRiders = Ops.enhance.Riders;
  Ops.enhance.Riders = page => {
    baseRiders?.(page);
    if (Ops.can("manageRiders")) headingButton("rider", "Add rider");
  };

  // ───────────── Two-step verification (shared/mfa.js) ─────────────

  const baseSettings = Ops.enhance.Settings;
  Ops.enhance.Settings = page => {
    baseSettings?.(page);
    if (DF.mfa?.manage) headingButton("mfa", "Two-step verification", "settings", false);
  };
  window.addEventListener(
    "click",
    event => {
      if (!event.target.closest('[data-action="mfa"]')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      DF.mfa?.manage();
    },
    true,
  );

  // ───────────── Create dispatch (assignment suggestions) ─────────────

  let suggestionState = { items: [], unmatched: [] };

  function suggestionRows() {
    const { items, unmatched } = suggestionState;
    const rows = items
      .map(
        (s, i) =>
          `<tr><td><input type="checkbox" data-suggestion="${i}" checked aria-label="Assign ${esc(s.trackingId)}"></td><td><strong>${esc(s.trackingId)}</strong><span class="subcell">${esc(s.kind === "pickup" ? "Pickup" : "Delivery")} · ${esc(s.zone)}${s.dueAt ? ` · due ${esc(Ops.when(s.dueAt))}` : ""}</span></td><td>${esc(s.rider.label)}<span class="subcell">${esc(s.reasons.join(" · "))}</span></td><td>${s.score}</td></tr>`,
      )
      .join("");
    const missing = unmatched.length ? `<p class="panel-subtitle" style="margin:8px 0 0">${unmatched.length} not matched: ${esc(unmatched.slice(0, 5).map(u => `${u.trackingId} (${u.reason})`).join(", "))}${unmatched.length > 5 ? "…" : ""}</p>` : "";
    return `<div class="table-scroll" style="max-height:340px;overflow:auto">${ui.table(["", "Shipment", "Suggested rider", "Score"], rows, "No shipments are waiting for a rider here.").replace(/^<div class="table-scroll">|<\/div>$/g, "")}</div>${missing}`;
  }

  async function loadSuggestions() {
    const hubId = $("dispatchHub")?.value;
    const kind = $("dispatchKind")?.value || "all";
    $("dispatchSuggestions").innerHTML = `<div class="empty-state">Finding riders…</div>`;
    try {
      const result = await DF.api(`/routing/suggestions?kind=${kind}&limit=100${hubId ? `&hubId=${hubId}` : ""}`);
      suggestionState = { items: result.suggestions, unmatched: result.unmatched };
      $("dispatchSuggestions").innerHTML = suggestionRows();
      $("modalDescription").textContent = `${result.suggestions.length} suggestion${result.suggestions.length === 1 ? "" : "s"} by zone, rider load and distance. Untick any you want to assign by hand.`;
    } catch (error) {
      $("dispatchSuggestions").innerHTML = `<div class="empty-state">${esc(DF.describe(error))}</div>`;
    }
  }

  Ops.modals.dispatch = () => {
    if (!Ops.require("dispatch", "create dispatches")) return;
    const hubs = Ops.myHubs() || DF.state.hubs;
    Ops.dialog("dispatch", {
      title: "Create dispatch",
      description: "Suggested riders for every shipment waiting at the hub.",
      submit: "Assign selected",
      wide: true,
      fields:
        ui.field("dispatchHub", "Hub", ui.select("dispatchHub", ui.hubOptions(hubs, Ops.myHubs() ? undefined : "All hubs"), Ops.myHubs()?.[0]?.id)) +
        ui.field("dispatchKind", "Shipments", ui.select("dispatchKind", [{ value: "delivery", label: "Deliveries waiting at the hub" }, { value: "pickup", label: "Pickup requests" }, { value: "all", label: "Deliveries and pickups" }], "delivery")) +
        `<div class="field full" id="dispatchSuggestions"></div>`,
    });
    $("dispatchHub").addEventListener("change", loadSuggestions);
    $("dispatchKind").addEventListener("change", loadSuggestions);
    void loadSuggestions();
  };
  Ops.submitters.dispatch = async () => {
    const chosen = qa("#dispatchSuggestions [data-suggestion]:checked").map(i => suggestionState.items[Number(i.dataset.suggestion)]);
    if (!chosen.length) throw new Error("Select at least one suggestion to assign.");
    const result = await DF.api("/routing/suggestions/accept", { method: "POST", body: { items: chosen.map(s => ({ trackingId: s.trackingId, riderId: s.rider.id })) } });
    closeModal();
    Ops.invalidate("dispatch");
    await Ops.refresh().catch(() => undefined);
    showToast(`${result.assigned.length} shipment${result.assigned.length === 1 ? "" : "s"} assigned${result.failed.length ? `; ${result.failed.length} not assigned (${result.failed[0].trackingId}: ${result.failed[0].message})` : ""}.`);
  };

  const baseDispatch = Ops.enhance.Dispatch;
  Ops.enhance.Dispatch = page => {
    baseDispatch?.(page);
    if (Ops.can("dispatch")) headingButton("dispatch", "Create dispatch", "route", false);
  };

  // The original page script maps data-action="dispatch" / "rider" to its own sample dialogs; route them here.
  window.addEventListener(
    "click",
    event => {
      const action = event.target.closest('[data-action="dispatch"],[data-action="rider"]');
      if (!action) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      openModal(action.dataset.action);
    },
    true,
  );

  // ───────────── Hubs & zones: network configuration ─────────────

  // Zones table filter (the country has hundreds of zones): district and/or name search.
  const zoneFilter = { district: "", q: "" };
  const loadZones = () => {
    const params = new URLSearchParams({ limit: "200" });
    if (zoneFilter.district) params.set("district", zoneFilter.district);
    if (zoneFilter.q) params.set("q", zoneFilter.q);
    return lazyLoad("zones", `/zones?${params}`);
  };
  const zoneFilterBar = count => {
    const districts = Ops.catalog?.districts || [];
    const total = Ops.catalog ? Object.values(Ops.catalog.zonesByDistrict).flat().length : 0;
    return `<div class="filter-row" style="display:flex;gap:10px;flex-wrap:wrap;align-items:end;margin:0 0 10px">
      <label style="display:grid;gap:4px">District<select id="zoneFilterDistrict"><option value="">All districts</option>${districts.map(d => `<option value="${esc(d)}"${d === zoneFilter.district ? " selected" : ""}>${esc(d)}</option>`).join("")}</select></label>
      <label style="display:grid;gap:4px">Zone<input id="zoneFilterQ" type="search" value="${esc(zoneFilter.q)}" placeholder="Search zones, press Enter"></label>
      <span class="subcell">${count >= 200 ? "Showing the first 200 matching zones: choose a district or search to narrow." : `${count} zone${count === 1 ? "" : "s"} shown`}${total ? ` · ${total} catalog zones in ${districts.length} districts` : ""}</span></div>`;
  };
  const setZoneFilter = (key, value) => {
    if (zoneFilter[key] === value) return;
    zoneFilter[key] = value;
    Ops.invalidate("zones");
    Ops.rerender(true);
  };
  window.addEventListener("change", event => {
    if (event.target.id === "zoneFilterDistrict") setZoneFilter("district", event.target.value);
    if (event.target.id === "zoneFilterQ") setZoneFilter("q", event.target.value.trim());
  });
  const loadRoutes = () => lazyLoad("routes", "/routes?limit=200");
  const loadCapacity = () => lazyLoad("hub-capacity", "/hubs/capacity", 30000);

  const basePrepareHubs = Ops.prepare.Hubs;
  Ops.prepare.Hubs = page => {
    basePrepareHubs?.(page);
    const zones = loadZones()?.items;
    const routes = loadRoutes()?.items;
    const active = zones?.filter(z => z.active) || [];
    if (active.length > 20 || zoneFilter.district || zoneFilter.q) {
      // A summary instead of hundreds of names; the Delivery zones table below lists them.
      const total = Ops.catalog ? Object.values(Ops.catalog.zonesByDistrict).flat().length : active.length;
      zoneList.splice(0, zoneList.length, `${total} zones in ${Ops.catalog?.districts.length ?? "all"} districts (Delivery zones below)`);
    } else if (active.length) zoneList.splice(0, zoneList.length, ...active.map(z => `${z.name} (${z.district}${z.hub ? ` → ${z.hub.name}` : ""})`));
    if (routes?.length) routeList.splice(0, routeList.length, ...routes.filter(r => r.active).map(r => `${r.code} · ${r.name}`));
    loadCapacity();
  };

  function configPanels() {
    const manage = Ops.can("manageHubs");
    const capacity = Ops.cache["hub-capacity"]?.value || [];
    const zones = Ops.cache.zones?.value?.items || [];
    const routes = Ops.cache.routes?.value?.items || [];
    const capRows = capacity
      .map(
        c =>
          `<tr><td><strong>${esc(c.hub.name)}</strong><span class="subcell">${esc(c.hub.code)} · ${esc(c.hub.zone ? `${c.hub.zone}, ${c.hub.district}` : `${c.hub.district} · no zone set`)}${c.hub.lat != null ? ` · ${c.hub.lat.toFixed(4)}, ${c.hub.lng.toFixed(4)}` : " · no map location"}</span></td><td>${c.capacity ?? "—"}</td><td>${c.load}</td><td>${c.inbound}</td><td>${c.utilisation == null ? "—" : `${c.utilisation}%`}</td><td>${ui.pill(c.state === "OK" ? "Healthy" : c.state === "Near capacity" ? "Monitor" : c.state === "Over capacity" ? "At capacity" : c.state)}</td><td>${c.zones} zones · ${c.routes} routes</td><td>${manage ? `<button class="button button-sm" data-hub-capacity="${c.hub.id}">Edit</button>` : ""}</td></tr>`,
      )
      .join("");
    const zoneRows = zones
      .map(
        z =>
          `<tr><td><strong>${esc(z.code)}</strong><span class="subcell">${esc(z.name)}, ${esc(z.district)}</span></td><td>${esc(z.areas.length ? z.areas.join(", ") : "All areas")}</td><td>${esc(z.hub?.name || "—")}</td><td>${esc(z.route ? `${z.route.code} · ${z.route.name}` : "—")}</td><td>${z.lat != null ? `${z.lat.toFixed(4)}, ${z.lng.toFixed(4)}` : "—"}</td><td>${ui.pill(z.active ? "Active" : "Inactive")}</td><td>${manage ? `<button class="button button-sm" data-zone-edit="${z.id}">Edit</button>` : ""}</td></tr>`,
      )
      .join("");
    const routeRows = routes
      .map(
        r =>
          `<tr><td><strong>${esc(r.code)}</strong><span class="subcell">${esc(r.name)}</span></td><td>${esc(r.hub.name)}</td><td>${esc(r.defaultRider?.label || "—")}</td><td>${r.zones}</td><td>${esc(r.note || "")}</td><td>${ui.pill(r.active ? "Active" : "Inactive")}</td><td>${manage ? `<button class="button button-sm" data-route-edit="${r.id}">Edit</button>` : ""}</td></tr>`,
      )
      .join("");
    const add = (kind, label) => (manage ? `<button class="button button-sm" type="button" data-config-add="${kind}">${icon("plus")} ${label}</button>` : "");
    return `<div id="networkConfig">${ui.panel("Hub capacity", "Parcels held at each hub against its capacity, plus parcels on the way in", ui.table(["Hub", "Capacity", "Held now", "Inbound", "Utilisation", "State", "Coverage", ""], capRows, Ops.lazyError("hub-capacity") ? DF.describe(Ops.lazyError("hub-capacity")) : "Loading hub capacity…"))}${ui.panel("Delivery zones", "Catalog areas → zone → hub · used by assignment suggestions, SLA and maps", zoneFilterBar(zones.length) + ui.table(["Zone", "Areas", "Hub", "Route", "Map centre", "Status", ""], zoneRows, Ops.cache.zones ? "No zones configured yet." : "Loading zones…"), add("zone", "Add zone"))}${ui.panel("Operating routes", "Zones a hub serves together, with a default rider for assignment suggestions", ui.table(["Route", "Hub", "Default rider", "Zones", "Note", "Status", ""], routeRows, Ops.cache.routes ? "No routes configured yet." : "Loading routes…"), add("route", "Add route"))}</div>`;
  }

  const baseHubs = Ops.enhance.Hubs;
  Ops.enhance.Hubs = page => {
    baseHubs?.(page);
    $("networkConfig")?.remove();
    const register = q("#hubShipmentRows")?.closest(".table-panel");
    if (register) register.insertAdjacentHTML("beforebegin", configPanels());
    else $("mainContent").insertAdjacentHTML("beforeend", configPanels());
    attachHubScanner();
  };

  // Zone dialog (add from the Network setup form's name, or edit).
  Ops.modals.zoneConfig = name => openZone(null, name);
  function openZone(zone, typedName) {
    if (!Ops.require("manageHubs", "configure zones")) return;
    const c = Ops.catalog || { districts: [], zonesByDistrict: {}, areasByZone: {} };
    const district = zone?.district || c.districts.find(d => (c.zonesByDistrict[d] || []).some(z => z.toLowerCase() === String(typedName || "").toLowerCase())) || c.districts[0];
    const routes = Ops.cache.routes?.value?.items || [];
    Ops.dialog("zoneConfig", {
      title: zone ? `Edit zone · ${zone.code}` : "Add delivery zone",
      description: "A zone groups catalog areas and is served by one hub. Its map centre is used when an address can't be found on the map.",
      submit: zone ? "Save zone" : "Add zone",
      context: { zoneId: zone?.id },
      fields:
        ui.field("zoneDistrict", "District", ui.select("zoneDistrict", c.districts, district, zone ? "disabled" : "")) +
        ui.field("zoneName", "Catalog zone", ui.select("zoneName", c.zonesByDistrict[district] || [], zone?.name || typedName, zone ? "disabled" : "")) +
        ui.field("zoneCode", "Zone code", ui.input("zoneCode", `required maxlength="24" value="${esc(zone?.code || "")}" placeholder="e.g. DHN-GUL"`)) +
        ui.field("zoneHub", "Serving hub", ui.select("zoneHub", ui.hubOptions(DF.state.hubs, "No hub"), zone?.hub?.id)) +
        ui.field("zoneRoute", "Route", ui.select("zoneRoute", [{ value: "", label: "No route" }, ...routes.map(r => ({ value: r.id, label: `${r.code} · ${r.name}` }))], zone?.route?.id)) +
        ui.field("zoneActive", "Status", ui.select("zoneActive", [{ value: "true", label: "Active" }, { value: "false", label: "Inactive" }], String(zone?.active ?? true))) +
        ui.field("zoneLat", "Centre latitude (optional)", ui.input("zoneLat", `type="number" step="0.000001" min="20" max="27" value="${zone?.lat ?? ""}"`)) +
        ui.field("zoneLng", "Centre longitude (optional)", ui.input("zoneLng", `type="number" step="0.000001" min="88" max="93" value="${zone?.lng ?? ""}"`)) +
        `<div class="field full"><label>Areas (none ticked = the whole zone)</label><div id="zoneAreas" style="display:flex;flex-wrap:wrap;gap:6px 14px"></div></div>`,
    });
    const fillAreas = () => {
      const areas = c.areasByZone[$("zoneName").value] || [];
      $("zoneAreas").innerHTML = areas.length
        ? areas.map(a => `<label style="display:flex;gap:6px;align-items:center;font-weight:500"><input type="checkbox" value="${esc(a)}" ${zone?.areas.includes(a) ? "checked" : ""} style="padding:0"> ${esc(a)}</label>`).join("")
        : `<span class="subcell">The catalog lists no areas for this zone.</span>`;
    };
    $("zoneDistrict").addEventListener("change", () => {
      $("zoneName").innerHTML = (c.zonesByDistrict[$("zoneDistrict").value] || []).map(z => `<option>${esc(z)}</option>`).join("");
      fillAreas();
    });
    $("zoneName").addEventListener("change", fillAreas);
    fillAreas();
  }
  Ops.submitters.zoneConfig = async () => {
    const valid = DF.validate($("modalForm"), {
      zoneCode: v => (/^[A-Za-z0-9-]{2,24}$/.test(v.trim()) ? "" : "Use 2–24 letters, digits or dashes"),
      zoneLat: v => (!!v !== !!$("zoneLng").value ? "Give both latitude and longitude, or neither" : ""),
    });
    if (!valid()) return;
    const num = id => ($(id).value === "" ? null : Number($(id).value));
    const body = {
      code: $("zoneCode").value.trim(),
      hubId: $("zoneHub").value || null,
      routeId: $("zoneRoute").value || null,
      lat: num("zoneLat"),
      lng: num("zoneLng"),
      active: $("zoneActive").value === "true",
      areas: qa("#zoneAreas input:checked").map(i => i.value),
    };
    const id = modalContext.zoneId;
    const zone = id
      ? await DF.api(`/zones/${id}`, { method: "PATCH", body })
      : await DF.api("/zones", { method: "POST", body: { ...body, name: $("zoneName").value, district: $("zoneDistrict").value } });
    closeModal();
    Ops.invalidate("zones", "hub-capacity");
    Ops.rerender(true);
    showToast(`Zone ${zone.code} ${id ? "saved" : "added"}.`);
  };

  Ops.modals.routeConfig = name => openRoute(null, name);
  function openRoute(route, typedName) {
    if (!Ops.require("manageHubs", "configure routes")) return;
    const riders = DF.state.riders || [];
    Ops.dialog("routeConfig", {
      title: route ? `Edit route · ${route.code}` : "Add operating route",
      description: "A route is a set of zones one hub serves together. Its default rider is suggested first for those zones.",
      submit: route ? "Save route" : "Add route",
      context: { routeId: route?.id },
      fields:
        ui.field("routeName", "Route name", ui.input("routeName", `required maxlength="120" value="${esc(route?.name || typedName || "")}"`)) +
        ui.field("routeCode", "Route code", ui.input("routeCode", `required maxlength="24" value="${esc(route?.code || "")}" placeholder="e.g. GUL-R1"`)) +
        ui.field("routeHub", "Hub", ui.select("routeHub", ui.hubOptions(DF.state.hubs), route?.hub?.id)) +
        ui.field("routeRider", "Default rider", ui.select("routeRider", [{ value: "", label: "None" }, ...riders.map(r => ({ value: r.id, label: `${r.code} · ${r.name}` }))], route?.defaultRider?.id)) +
        ui.field("routeActive", "Status", ui.select("routeActive", [{ value: "true", label: "Active" }, { value: "false", label: "Inactive" }], String(route?.active ?? true))) +
        ui.field("routeNote", "Note (optional)", `<textarea id="routeNote" maxlength="500">${esc(route?.note || "")}</textarea>`, true),
    });
  }
  Ops.submitters.routeConfig = async () => {
    const valid = DF.validate($("modalForm"), {
      routeName: v => (v.trim().length < 2 ? "Enter a route name" : ""),
      routeCode: v => (/^[A-Za-z0-9-]{2,24}$/.test(v.trim()) ? "" : "Use 2–24 letters, digits or dashes"),
    });
    if (!valid()) return;
    const body = {
      name: $("routeName").value.trim(),
      code: $("routeCode").value.trim(),
      hubId: $("routeHub").value,
      defaultRiderId: $("routeRider").value || null,
      active: $("routeActive").value === "true",
      note: $("routeNote").value.trim() || (modalContext.routeId ? null : undefined),
    };
    const id = modalContext.routeId;
    const route = await DF.api(id ? `/routes/${id}` : "/routes", { method: id ? "PATCH" : "POST", body });
    closeModal();
    Ops.invalidate("routes", "zones", "hub-capacity");
    Ops.rerender(true);
    showToast(`Route ${route.code} ${id ? "saved" : "added"}.`);
  };

  // Hub zone: the catalog zone (of the hub's district) the hub stands in; drop-offs are priced from it.
  const hubZoneOptions = (district, current) => {
    const zones = Ops.catalog?.zonesByDistrict?.[district] || [];
    return [{ value: "", label: zones.length ? "Choose the hub's zone" : "No zones in the catalog for this district" }, ...zones, ...(current && !zones.includes(current) ? [current] : [])];
  };
  const fillHubZones = (district, keep) => {
    $("hubZone").innerHTML = hubZoneOptions(district, keep)
      .map(o => (typeof o === "string" ? `<option>${esc(o)}</option>` : `<option value="${esc(o.value)}">${esc(o.label)}</option>`))
      .join("");
    if (keep) $("hubZone").value = keep;
  };

  // New hub (Network setup → Add, kind "hub"): district → zone, street address.
  Ops.modals.hubCreate = name => {
    if (!Ops.require("manageHubs", "add hubs")) return;
    const districts = Ops.catalog?.districts || [...new Set(DF.state.hubs.map(h => h.district))];
    Ops.dialog("hubCreate", {
      title: "Add hub",
      description: "The hub's district and zone are where drop-offs there are priced from; the address is shown to senders.",
      submit: "Add hub",
      fields:
        ui.field("hubName", "Hub name", ui.input("hubName", `required maxlength="120" value="${esc(name || "")}"`), true) +
        ui.field("hubDistrict", "District", ui.select("hubDistrict", districts, districts[0])) +
        ui.field("hubZone", "Zone", ui.select("hubZone", hubZoneOptions(districts[0]), "")) +
        ui.field("hubAddress", "Street address", ui.input("hubAddress", `required maxlength="300" placeholder="Road, area"`), true),
    });
    $("hubDistrict").addEventListener("change", () => fillHubZones($("hubDistrict").value));
  };
  Ops.submitters.hubCreate = async () => {
    const valid = DF.validate($("modalForm"), {
      hubName: v => (v.trim().length < 2 ? "Enter the hub's name" : DF.state.hubs.some(h => h.name.toLowerCase() === v.trim().toLowerCase()) ? "A hub with this name exists" : ""),
      hubZone: v => (v ? "" : "Choose the zone the hub is in"),
      hubAddress: v => (v.trim().length < 2 ? "Enter the hub's street address" : ""),
    });
    if (!valid()) return;
    const name = $("hubName").value.trim();
    const district = $("hubDistrict").value;
    const letters = s => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const base = `${letters(district).slice(0, 3)}-${letters(name).slice(0, 3)}`;
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = attempt ? `${base}${attempt + 1}` : base;
      try {
        const hub = await DF.api("/hubs", { method: "POST", body: { code, name, district, zone: $("hubZone").value, address: $("hubAddress").value.trim() } });
        closeModal();
        DF.state.hubs = await DF.api("/hubs");
        await Ops.loadOverview?.().catch(() => undefined);
        Ops.invalidate("hub-capacity", "map");
        Ops.rerender(true);
        showToast(`Hub “${hub.name}” (${hub.code}) added to the network.`);
        return;
      } catch (error) {
        if (error.code !== "HUB_CODE_TAKEN") throw error;
      }
    }
    showToast("Couldn't find a free hub code. Try a more specific name.");
  };

  Ops.modals.hubCapacity = hubId => {
    if (!Ops.require("manageHubs", "change hub capacity")) return;
    const hub = Ops.hubById(hubId);
    if (!hub) return;
    Ops.dialog("hubCapacity", {
      title: `Hub settings · ${hub.name}`,
      description: "The zone is where drop-offs at this hub are priced from. Capacity drives the hub load warnings; the location places the hub on maps and starts route plans.",
      submit: "Save hub",
      context: { hubId },
      fields:
        ui.field("hubZone", `Zone · ${hub.district}`, ui.select("hubZone", hubZoneOptions(hub.district, hub.zone), hub.zone || ""), true) +
        ui.field("hubCap", "Capacity (parcels held at once)", ui.input("hubCap", `type="number" min="1" step="1" value="${hub.capacity ?? ""}" placeholder="Not set"`), true) +
        ui.field("hubLat", "Latitude", ui.input("hubLat", `type="number" step="0.000001" min="20" max="27" value="${hub.lat ?? ""}"`)) +
        ui.field("hubLng", "Longitude", ui.input("hubLng", `type="number" step="0.000001" min="88" max="93" value="${hub.lng ?? ""}"`)),
    });
  };
  Ops.submitters.hubCapacity = async () => {
    const valid = DF.validate($("modalForm"), { hubLat: v => (!!v !== !!$("hubLng").value ? "Give both latitude and longitude, or neither" : "") });
    if (!valid()) return;
    const num = id => ($(id).value === "" ? null : Number($(id).value));
    const hub = await DF.api(`/hubs/${modalContext.hubId}`, { method: "PATCH", body: { zone: $("hubZone").value || null, capacity: num("hubCap"), lat: num("hubLat"), lng: num("hubLng") } });
    closeModal();
    DF.state.hubs = await DF.api("/hubs").catch(() => DF.state.hubs);
    Ops.invalidate("hub-capacity", "map");
    Ops.rerender(true);
    showToast(`${hub.name} saved.`);
  };

  window.addEventListener(
    "click",
    event => {
      const add = event.target.closest("[data-config-add]");
      const zone = event.target.closest("[data-zone-edit]");
      const route = event.target.closest("[data-route-edit]");
      const cap = event.target.closest("[data-hub-capacity]");
      if (!add && !zone && !route && !cap) return;
      event.stopImmediatePropagation();
      if (add) return void openModal(add.dataset.configAdd === "zone" ? "zoneConfig" : "routeConfig", "");
      if (zone) return void openZone((Ops.cache.zones?.value?.items || []).find(z => z.id === zone.dataset.zoneEdit));
      if (route) return void openRoute((Ops.cache.routes?.value?.items || []).find(r => r.id === route.dataset.routeEdit));
      openModal("hubCapacity", cap.dataset.hubCapacity);
    },
    true,
  );

  // ───────────── hub console: camera scanning + scan events ─────────────

  /** Where the code in the hub scan box came from (camera vs. keyboard / USB scanner). */
  Ops.scanSource = "KEYBOARD";
  function attachHubScanner() {
    const input = $("hubScanId");
    if (!input || !DF.scanner) return;
    DF.scanner.attach(input, {
      title: "Scan parcels at the hub",
      label: "Camera",
      continuous: true,
      onScan: () => {
        Ops.scanSource = "CAMERA";
        $("hubScanForm")?.requestSubmit();
      },
    });
    input.addEventListener("keydown", () => (Ops.scanSource = "KEYBOARD"));
    for (const name of ["tracking"]) {
      for (const form of ["hubReceiveForm", "hubTransferForm"]) {
        const field = q(`#${form} input[name="${name}"]`);
        if (field) DF.scanner.attach(field, { title: "Scan the parcel label", label: "Camera" });
      }
    }
  }

  // Live: other people's zone / route changes.
  DF.events.on("network.updated", () => {
    Ops.invalidate("zones", "routes", "hub-capacity");
    if (Ops.page() === "Hubs") Ops.rerender();
  });
})();
