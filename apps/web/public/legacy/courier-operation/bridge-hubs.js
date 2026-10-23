/*
 * Courier Operations → Hubs & zones → "Hub register": every hub (deactivated ones too, for people
 * who manage hubs) with its capacity and load, and create / edit / deactivate / delete.
 *
 *   List                     GET /hubs?includeInactive=true (hub:manage), else the active hubs
 *   Capacity columns         GET /hubs/capacity (held now, inbound, utilisation, load state, zones / routes)
 *   Add / edit               POST /hubs, PATCH /hubs/:id (district → zone from the catalog)
 *   Deactivate / activate    PATCH /hubs/:id { active }
 *   Delete (only unused)     GET /hubs/:id/usage → DELETE /hubs/:id (409 IN_USE lists what uses it)
 *   Hub group                GET /hub-groups; PUT /hubs/:id/hub-group (config:manage) — shown when
 *                            the hub-groups API is available (docs/architecture-contracts.md)
 */
(() => {
  const DF = window.DF;
  const Ops = window.DFOps;
  if (!DF || !Ops?.ui) return;
  const $ = id => document.getElementById(id);
  const esc = Ops.esc;
  const ui = Ops.ui;
  const num = n => Number(n || 0).toLocaleString("en-US");

  const manage = () => Ops.can("manageHubs");
  /**
   * The register's own data (every hub for managers, the hub groups), loaded in the background.
   * Arrivals repaint only this panel, never the whole page (scans may be in progress below).
   */
  const reg = { hubs: null, groups: null, error: null, at: 0, loading: false };
  function loadRegister(force = false) {
    if (reg.loading || (!force && Date.now() - reg.at < 30000)) return;
    reg.loading = true;
    const groupsOrNull = DF.api("/hub-groups").catch(error => (error?.status === 404 || error?.status === 403 ? null : Promise.reject(error)));
    Promise.all([manage() ? DF.api("/hubs?includeInactive=true") : Promise.resolve(DF.state.hubs), groupsOrNull.catch(() => null)])
      .then(([hubs, groups]) => Object.assign(reg, { hubs, groups: Array.isArray(groups) ? groups : null, error: null }))
      .catch(error => (reg.error = error))
      .finally(() => {
        Object.assign(reg, { loading: false, at: Date.now() });
        const panel = $("hubRegister");
        if (panel) panel.outerHTML = registerPanel();
      });
  }
  const groups = () => reg.groups;
  const groupOf = hub => {
    const list = groups();
    if (!list) return null;
    return list.find(g => (hub.hubGroupId && g.id === hub.hubGroupId) || (g.hubs || []).some(h => h.id === hub.id)) || null;
  };

  function registerPanel() {
    loadRegister();
    const hubs = reg.hubs || DF.state.hubs;
    const showGroups = !!groups();
    // Load against capacity (the former "Hub capacity" panel), per hub.
    const loadOf = new Map((Ops.cache["hub-capacity"]?.value || []).map(c => [c.hub.id, c]));
    const STATE = { OK: "Healthy", "Near capacity": "Monitor", "Over capacity": "At capacity" };
    const rows = (hubs || [])
      .map(h => {
        const g = groupOf(h);
        const c = loadOf.get(h.id);
        const actions = manage()
          ? `<div class="row-actions"><button class="button button-sm" type="button" data-hub-edit="${h.id}">Edit</button><button class="button button-sm" type="button" data-hub-toggle="${h.id}">${h.active ? "Deactivate" : "Activate"}</button><button class="button button-sm" type="button" data-hub-delete="${h.id}">Delete</button></div>`
          : "";
        const coverage = c ? ` · ${c.zones} zone${c.zones === 1 ? "" : "s"} · ${c.routes} route${c.routes === 1 ? "" : "s"}` : "";
        return `<tr data-hub-row="${h.id}"><td><strong>${esc(h.name)}</strong><span class="subcell">${esc(h.code + coverage)}</span></td><td>${esc(h.zone ? `${h.zone}, ${h.district}` : `${h.district} · no zone set`)}<span class="subcell" title="${esc(h.address)}">${esc(h.address)}</span></td>${showGroups ? `<td>${esc(g ? g.name : "—")}</td>` : ""}<td>${h.capacity ?? "—"}</td><td data-hub-load>${c ? num(c.load) : "—"}</td><td>${c ? num(c.inbound) : "—"}</td><td>${c?.utilisation == null ? "—" : `${c.utilisation}%`}</td><td>${c ? ui.pill(STATE[c.state] || c.state) : "—"}</td><td>${ui.pill(h.active ? "Active" : "Inactive")}</td><td>${actions}</td></tr>`;
      })
      .join("");
    const cols = ["Hub", "District · zone · address", ...(showGroups ? ["Hub group"] : []), "Capacity", "Held now", "Inbound", "Utilisation", "Load", "Status", ""];
    const add = manage() ? `<button class="button button-sm" type="button" data-hub-add>${typeof icon === "function" ? icon("plus") : ""} Add hub</button>` : "";
    const count = (hubs || []).length;
    const inactive = (hubs || []).filter(h => !h.active).length;
    return `<div id="hubRegister">${ui.panel(
      "Hub register",
      `${num(count)} hub${count === 1 ? "" : "s"}${inactive ? ` · ${num(inactive)} deactivated (kept for existing parcels, hidden from new bookings)` : ""} · parcels held against capacity, plus parcels on the way in`,
      ui.table(cols, rows, reg.error ? DF.describe(reg.error) : "Loading hubs…"),
      add,
    )}</div>`;
  }

  const baseHubs = Ops.enhance.Hubs;
  Ops.enhance.Hubs = page => {
    baseHubs?.(page);
    $("hubRegister")?.remove();
    if (Ops.hubPart !== "manage") return; // the register is on Hubs & zones only
    const anchor = $("networkConfig");
    if (anchor) anchor.insertAdjacentHTML("beforebegin", registerPanel());
    else $("mainContent").insertAdjacentHTML("beforeend", registerPanel());
  };

  // ───────────── editor ─────────────
  const hubOf = id => (reg.hubs || DF.state.hubs).find(h => h.id === id);
  const districtsFor = current => {
    const list = Ops.catalog?.districts || [...new Set(DF.state.hubs.map(h => h.district))];
    return current && !list.includes(current) ? [...list, current] : list;
  };
  const zonesFor = (district, current) => {
    const zones = Ops.catalog?.zonesByDistrict?.[district] || [];
    return [{ value: "", label: zones.length ? "Choose the hub's zone" : "No zones in the catalog for this district" }, ...zones, ...(current && !zones.includes(current) ? [current] : [])];
  };

  let checks = [];
  function openEditor(hub) {
    if (!Ops.require("manageHubs", hub ? "edit hubs" : "add hubs")) return;
    const districts = districtsFor(hub?.district);
    const district = hub?.district || districts[0];
    const list = groups();
    const g = hub ? groupOf(hub) : null;
    const groupField = list
      ? Ops.can("manageConfig")
        ? ui.field("hubGroup", "Hub group (pricing: same city)", ui.select("hubGroup", [{ value: "", label: "No group" }, ...list.filter(x => x.active !== false || x.id === g?.id).map(x => ({ value: x.id, label: x.name }))], g?.id || ""))
        : ui.field("hubGroupView", "Hub group", ui.input("hubGroupView", `value="${esc(g?.name || "No group")}" disabled`))
      : "";
    Ops.dialog("hubEdit", {
      title: hub ? `Edit hub · ${hub.name}` : "Add hub",
      description: "The district and zone are where drop-offs at the hub are priced from; the address is shown to senders. A deactivated hub disappears from new bookings and lists; its parcels and history stay.",
      submit: hub ? "Save hub" : "Add hub",
      wide: true,
      context: { hubId: hub?.id, groupId: g?.id || "" },
      fields:
        ui.field("hubName", "Hub name", ui.input("hubName", `required maxlength="120" value="${esc(hub?.name || "")}"`)) +
        ui.field("hubCode", "Hub code", ui.input("hubCode", `required maxlength="20" value="${esc(hub?.code || "")}" placeholder="e.g. DHK-GUL"`)) +
        ui.field("hubDistrict", "District", ui.select("hubDistrict", districts, district)) +
        ui.field("hubZone", "Zone", ui.select("hubZone", zonesFor(district, hub?.zone), hub?.zone || "")) +
        ui.field("hubAddress", "Street address", ui.input("hubAddress", `required maxlength="300" value="${esc(hub?.address || "")}" placeholder="Road, area"`), true) +
        ui.field("hubCapacity", "Capacity (parcels held at once, optional)", ui.input("hubCapacity", `type="number" min="1" step="1" value="${hub?.capacity ?? ""}"`)) +
        ui.field("hubStatus", "Status", ui.select("hubStatus", [{ value: "true", label: "Active" }, { value: "false", label: "Inactive" }], String(hub?.active ?? true))) +
        ui.field("hubLat", "Latitude (optional)", ui.input("hubLat", `type="number" step="0.000001" min="20" max="27" value="${hub?.lat ?? ""}"`)) +
        ui.field("hubLng", "Longitude (optional)", ui.input("hubLng", `type="number" step="0.000001" min="88" max="93" value="${hub?.lng ?? ""}"`)) +
        groupField,
    });
    // Inline rules on the dialog's own fields (not on the shared form, which other dialogs reuse).
    const others = reg.hubs || DF.state.hubs;
    checks = Object.entries({
      hubName: v => (v.trim().length < 2 ? "Enter the hub's name" : others.some(h => h.id !== hub?.id && h.name.toLowerCase() === v.trim().toLowerCase()) ? "Another hub has this name" : ""),
      hubCode: v => (/^[A-Za-z0-9-]{2,20}$/.test(v.trim()) ? "" : "Use 2–20 letters, digits or dashes"),
      hubZone: v => (v ? "" : "Choose the zone the hub is in"),
      hubAddress: v => (v.trim().length < 2 ? "Enter the hub's street address" : ""),
      hubLat: v => (!!v !== !!$("hubLng").value ? "Give both latitude and longitude, or neither" : ""),
    }).map(([fieldId, rule]) => DF.validate.field($(fieldId), () => rule($(fieldId).value)));
    $("hubDistrict").addEventListener("change", () => {
      $("hubZone").innerHTML = zonesFor($("hubDistrict").value)
        .map(o => (typeof o === "string" ? `<option>${esc(o)}</option>` : `<option value="${esc(o.value)}">${esc(o.label)}</option>`))
        .join("");
    });
    if (!hub) {
      // Suggest a code from the district and name until the user types one.
      let typed = false;
      $("hubCode").addEventListener("input", () => (typed = true));
      const suggest = () => {
        if (typed) return;
        const letters = s => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
        $("hubCode").value = $("hubName").value.trim() ? `${letters($("hubDistrict").value).slice(0, 3)}-${letters($("hubName").value).slice(0, 3)}` : "";
      };
      $("hubName").addEventListener("input", suggest);
      $("hubDistrict").addEventListener("change", suggest);
    }
  }

  Ops.submitters.hubEdit = async () => {
    const id = modalContext.hubId;
    if (!checks.map(check => check(true)).every(Boolean)) return void $("modalFields").querySelector("[aria-invalid=true]")?.focus();
    const numOrNull = el => ($(el).value === "" ? null : Number($(el).value));
    const body = {
      name: $("hubName").value.trim(),
      code: $("hubCode").value.trim().toUpperCase(),
      district: $("hubDistrict").value,
      zone: $("hubZone").value || null,
      address: $("hubAddress").value.trim(),
      capacity: numOrNull("hubCapacity"),
      active: $("hubStatus").value === "true",
      lat: numOrNull("hubLat"),
      lng: numOrNull("hubLng"),
    };
    let hub;
    try {
      hub = await DF.api(id ? `/hubs/${id}` : "/hubs", { method: id ? "PATCH" : "POST", body });
    } catch (error) {
      const target = { name: "hubName", district: "hubDistrict", zone: "hubZone" }[error?.details?.field] || (error?.code === "HUB_CODE_TAKEN" ? "hubCode" : null);
      if (target && $(target)) {
        $(target).setAttribute("aria-invalid", "true");
        $(target).closest(".field")?.querySelector(".df-field-error")?.replaceChildren(document.createTextNode(error.message));
        $(target).focus();
        return;
      }
      throw error;
    }
    const group = $("hubGroup");
    if (group && group.value !== (modalContext.groupId || "")) {
      try {
        await DF.api(`/hubs/${hub.id}/hub-group`, { method: "PUT", body: { hubGroupId: group.value || null } });
      } catch (error) {
        showToast(`${hub.name} saved, but its hub group wasn't changed: ${DF.describe(error)}`);
      }
    }
    closeModal();
    await refreshHubs();
    showToast(id ? `${hub.name} saved.` : `Hub “${hub.name}” (${hub.code}) added to the network.`);
  };

  async function refreshHubs() {
    DF.state.hubs = await DF.api("/hubs").catch(() => DF.state.hubs);
    reg.at = 0;
    Ops.invalidate("hub-capacity", "map", "zones");
    await Ops.loadOverview?.().catch(() => undefined);
    Ops.rerender(true);
  }

  async function toggle(hub, button) {
    if (!Ops.require("manageHubs", "change hubs")) return;
    const next = !hub.active;
    const ok = await Ops.confirm(
      next
        ? { title: `Activate ${hub.name}?`, message: "It appears again in hub lists and for new bookings.", confirm: "Activate hub" }
        : { title: `Deactivate ${hub.name}?`, message: "It disappears from hub lists and new bookings (drop-offs, transfers, riders' hand-overs). Its parcels, riders and history stay.", confirm: "Deactivate hub", danger: true },
    );
    if (!ok) return;
    button.disabled = true;
    try {
      await DF.api(`/hubs/${hub.id}`, { method: "PATCH", body: { active: next } });
      await refreshHubs();
      showToast(`${hub.name} ${next ? "activated" : "deactivated"}.`);
    } catch (error) {
      showToast(DF.describe(error));
    } finally {
      button.disabled = false;
    }
  }

  function showUsage(hub, usage) {
    Ops.dialog("hubInUse", {
      title: `${hub.name} is in use`,
      description: `It can't be deleted while ${num(usage.total)} record${usage.total === 1 ? "" : "s"} refer${usage.total === 1 ? "s" : ""} to it. Deactivate it instead: it disappears from lists and new bookings, and its history stays.`,
      submit: hub.active ? "Deactivate instead" : "Close",
      context: { hubId: hub.id },
      fields: `<div class="field full" id="hubUsage"><label>What uses it</label><ul style="margin:6px 0 0;padding-left:18px">${usage.items.map(i => `<li>${esc(i.label)}: <strong>${num(i.count)}</strong></li>`).join("")}</ul></div>`,
    });
  }
  Ops.submitters.hubInUse = async () => {
    const hub = hubOf(modalContext.hubId);
    if (hub?.active) await DF.api(`/hubs/${hub.id}`, { method: "PATCH", body: { active: false } });
    closeModal();
    if (hub?.active) {
      await refreshHubs();
      showToast(`${hub.name} deactivated.`);
    }
  };

  async function remove(hub, button) {
    if (!Ops.require("manageHubs", "delete hubs")) return;
    button.disabled = true;
    try {
      const usage = await DF.api(`/hubs/${hub.id}/usage`);
      if (usage.total) return showUsage(hub, usage);
      if (!(await Ops.confirm({ title: `Delete ${hub.name} (${hub.code})?`, message: "Nothing uses it. This can't be undone.", confirm: "Delete hub", danger: true }))) return;
      await DF.api(`/hubs/${hub.id}`, { method: "DELETE" });
      await refreshHubs();
      showToast(`${hub.name} deleted.`);
    } catch (error) {
      if (error?.code === "IN_USE" && error.details?.usage) return showUsage(hub, error.details.usage);
      showToast(DF.describe(error));
    } finally {
      button.disabled = false;
    }
  }

  window.addEventListener(
    "click",
    event => {
      const t = event.target;
      if (!(t instanceof Element) || !t.closest("#hubRegister")) return;
      const add = t.closest("[data-hub-add]");
      const edit = t.closest("[data-hub-edit]");
      const tog = t.closest("[data-hub-toggle]");
      const del = t.closest("[data-hub-delete]");
      if (!add && !edit && !tog && !del) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (add) return openEditor(null);
      const hub = hubOf((edit || tog || del).dataset.hubEdit || (edit || tog || del).dataset.hubToggle || (edit || tog || del).dataset.hubDelete);
      if (!hub) return;
      if (edit) return openEditor(hub);
      if (tog) return void toggle(hub, tog);
      void remove(hub, del);
    },
    true,
  );

  // Other people's hub changes (and geography renames) show up live.
  const refreshed = () => {
    reg.at = 0;
    if ($("hubRegister")) loadRegister(true);
  };
  DF.events.on("network.updated", refreshed);
  DF.events.on("catalog.updated", refreshed);

  // The address holds the full address: its district / zone / area are picked from it (shared/api.js DF.autoPlace).
  window.DF?.autoPlace?.({ street: "hubAddress", district: "hubDistrict", zone: "hubZone" });
})();
