/*
 * Structured merchant addresses in the panels (window.DFMerchantAddress).
 *
 * The merchant API returns `business` and `pickup` ({ district, zone, area, areaOther, street, lat, lng }),
 * `pickupSameAsBusiness`, `pickupContactName/Phone`, `pickupTime`, `handover`, the derived `pickupHub`
 * and `routeDistrict`, and `addressComplete` (false for older free-text addresses). See
 * apps/api/src/modules/merchants/merchant-address.ts.
 *
 *   DFMerchantAddress.summaryHtml(m)            read-only summary (super admin review, ops)
 *   DFMerchantAddress.placeText(place)          "House 7, Road 4 Gulshan, Gulshan, Dhaka North"
 *   DFMerchantAddress.formHtml(m, catalog)      the editable sections (business address, pickup, contact, time, handover)
 *   DFMerchantAddress.wire(form, m, catalog)    cascades, searchable selects, +880 phone, inline errors, map pins;
 *                                               returns { check(), body() } (body = the PATCH /merchants/me fields)
 * Element ids are prefixed "dfma" (dfmaBizDistrict, dfmaPuZone, dfmaPickupSame, dfmaPickupTime, …).
 */
(() => {
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const $ = id => document.getElementById(id);
  const OTHER = "__other__";
  const TIMES = { MORNING: "Morning (9am–12pm)", MIDDAY: "Midday (12pm–3pm)", AFTERNOON: "Afternoon (3pm–6pm)" };
  const HANDOVER = { RIDER_PICKUP: "Rider pickup", HUB_DROP: "Drop at hub" };
  const phone = p => {
    const m = String(p || "").match(/^\+880(\d{4})(\d{6})$/);
    return m ? `+880 ${m[1]}-${m[2]}` : p || "";
  };
  const norm = v => String(v ?? "").trim().toLowerCase();

  function placeText(p) {
    if (!p) return "";
    const area = p.area && p.area !== p.zone ? p.area : "";
    return [p.street, area, p.zone, p.district].filter(Boolean).join(", ");
  }
  const mapLink = p => (p && p.lat != null && p.lng != null ? `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lng}#map=17/${p.lat}/${p.lng}` : "");

  /** Read-only summary of a merchant's addresses for staff (review dialog, merchant lists). */
  function summaryHtml(m) {
    const row = (label, value) => `<div style="display:grid;grid-template-columns:minmax(110px,150px) 1fr;gap:8px;padding:6px 0;border-bottom:1px solid #eef1f5"><span style="color:#64748b">${esc(label)}</span><span>${value}</span></div>`;
    const pin = p => (mapLink(p) ? ` · <a href="${esc(mapLink(p))}" target="_blank" rel="noopener" data-dfma-map>Map ↗</a>` : "");
    const other = p => (p?.areaOther ? ` <small style="color:#b45309">(area typed: not in the list)</small>` : "");
    const rows = [];
    if (m.businessCategory || m.websiteUrl) rows.push(row("Business", esc([m.businessCategory, m.websiteUrl].filter(Boolean).join(" · ")) || "—"));
    rows.push(row("Business address", m.business ? `${esc(placeText(m.business))}${other(m.business)}${pin(m.business)}` : `<span style="color:#94a3b8">Not given</span>`));
    rows.push(
      row(
        "Pickup address",
        m.pickupSameAsBusiness && m.business
          ? `Same as business address${pin(m.pickup)}`
          : `${esc(placeText(m.pickup))}${other(m.pickup)}${pin(m.pickup)}${m.addressComplete === false ? ` <small style="color:#b45309">(free text: not matched to the area list yet)</small>` : ""}`,
      ),
    );
    rows.push(row("Pickup contact", esc([m.pickupContactName || m.contactName, phone(m.pickupContactPhone || m.contactPhone)].filter(Boolean).join(" · "))));
    rows.push(row("Pickup time", esc(TIMES[m.pickupTime] || "Not set")));
    rows.push(row("Handover", esc(HANDOVER[m.handover] || "Rider pickup")));
    rows.push(row("Serving hub", m.pickupHub ? esc(`${m.pickupHub.name} (${m.pickupHub.code})${m.pickupHub.address ? ` · ${m.pickupHub.address}` : ""}`) : `<span style="color:#b45309">No hub serves this pickup zone yet</span>`));
    rows.push(row("Route district", esc(m.routeDistrict || m.pickupDistrict || "—")));
    return `<div class="dfma-summary" style="font-size:13px;color:#334155">${rows.join("")}</div>`;
  }

  // ───────────── the editor ─────────────

  const option = (value, label = value, selected = false) => `<option value="${esc(value)}"${selected ? " selected" : ""}>${esc(label)}</option>`;
  const field = (id, label, control, full = false, hidden = false) => `<div class="form-field${full ? " full" : ""}"${hidden ? " hidden" : ""} data-dfma-field="${id}"><label for="${id}">${esc(label)}</label>${control}</div>`;

  function placeHtml(key, label, place) {
    const p = place || {};
    const id = s => `dfma${key}${s}`;
    return `${field(id("District"), `${label} district`, `<select id="${id("District")}" data-search required></select>`)}${field(id("Zone"), `${label} thana / upazila`, `<select id="${id("Zone")}" data-search required></select>`)}${field(id("Area"), `${label} area`, `<select id="${id("Area")}" data-search></select>`)}${field(id("OtherArea"), "Area name", `<input id="${id("OtherArea")}" maxlength="80" placeholder="e.g. Shahjadpur Lane 3" value="${esc(p.areaOther ? p.area : "")}">`, false, true)}${field(id("Street"), "Street address (house, road, flat)", `<input id="${id("Street")}" required minlength="5" maxlength="300" value="${esc(p.street || "")}" placeholder="House 12, Road 7, Flat 3B">`, true)}<div class="form-field full" data-dfma-pin="${key}"><label>Map pin (optional)</label><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><span id="${id("PinText")}" style="font-size:13px;color:#64748b"></span><button type="button" class="button button-sm" data-dfma-pin-open="${key}">Set on map</button><button type="button" class="button button-sm" data-dfma-pin-clear="${key}">Remove pin</button></div><div id="${id("Map")}" hidden style="height:220px;margin-top:8px;border:1px solid #e4e8ee;border-radius:10px;overflow:hidden;isolation:isolate"></div></div>`;
  }

  const heading = text => `<h3 class="form-field full" style="font-size:14px;margin:14px 0 0">${esc(text)}</h3>`;

  function formHtml(m) {
    const prompt =
      m.addressComplete === false
        ? `<div class="form-field full" id="dfmaPrompt" style="padding:10px 12px;border-radius:9px;background:#fff7ed;color:#9a3412;font-size:13px"><strong>Complete your address.</strong> We have your pickup address as text: “${esc([m.pickupAddress, m.pickupArea, m.pickupDistrict].filter(Boolean).join(", "))}”. Choose the district, thana and area below so pickups reach the right hub.${m.pickupSuggestion ? " We've preselected the closest match; check it." : ""}</div>`
        : "";
    const same = m.pickupSameAsBusiness || (!m.business && m.addressComplete === false);
    return `${prompt}${heading("Business address")}${placeHtml("Biz", "Business", m.business || { street: m.pickupAddress })}${heading("Pickup location")}<label class="form-field full" style="display:flex;gap:8px;align-items:center;font-size:13px;flex-direction:row"><input type="checkbox" id="dfmaPickupSame" ${same ? "checked" : ""} style="width:auto"> Pickup from the business address</label>${placeHtml("Pu", "Pickup", m.pickupSameAsBusiness ? null : m.pickup)}${field("dfmaPickupContact", "Pickup contact person", `<input id="dfmaPickupContact" required minlength="2" maxlength="120" value="${esc(m.pickupContactName || m.contactName || "")}">`)}${field("dfmaPickupPhone", "Pickup contact phone", `<input id="dfmaPickupPhone" required value="${esc(String(m.pickupContactPhone || m.contactPhone || "").replace(/^\+880/, ""))}">`)}${field("dfmaPickupTime", "Preferred pickup time", `<select id="dfmaPickupTime" required>${option("", "Choose a time")}${Object.entries(TIMES).map(([v, l]) => option(v, l, m.pickupTime === v)).join("")}</select>`)}${field("dfmaHandover", "How you hand over parcels", `<select id="dfmaHandover">${Object.entries(HANDOVER).map(([v, l]) => option(v, l, (m.handover || "RIDER_PICKUP") === v)).join("")}</select>`)}<div class="form-field full" id="dfmaHub" style="font-size:13px;color:#475569"></div>`;
  }

  // Leaflet (shared with the parcel map; loaded on first use).
  let leaflet = null;
  function loadLeaflet() {
    if (window.L) return Promise.resolve(window.L);
    leaflet ??= new Promise((resolve, reject) => {
      if (!document.querySelector('link[href="/vendor/leaflet/leaflet.css"]')) document.head.insertAdjacentHTML("beforeend", '<link rel="stylesheet" href="/vendor/leaflet/leaflet.css">');
      const s = document.createElement("script");
      s.src = "/vendor/leaflet/leaflet.js";
      s.onload = () => resolve(window.L);
      s.onerror = () => ((leaflet = null), reject(new Error("The map could not be loaded")));
      document.head.append(s);
    });
    return leaflet;
  }

  function wire(form, m, catalog) {
    const c = catalog || { districts: [], zonesByDistrict: {}, areasByZone: {} };
    const zonesOf = d => c.zonesByDistrict?.[d] || [];
    const areasOf = z => c.areasByZone?.[z] || [];
    const pins = { Biz: m.business && m.business.lat != null ? { lat: m.business.lat, lng: m.business.lng } : null, Pu: !m.pickupSameAsBusiness && m.pickup?.lat != null ? { lat: m.pickup.lat, lng: m.pickup.lng } : null };
    const same = () => $("dfmaPickupSame").checked;

    const fill = (select, values, placeholder, current) => {
      const list = [...values];
      select.innerHTML = option("", placeholder) + list.map(v => (Array.isArray(v) ? option(v[0], v[1], v[0] === current) : option(v, v, v === current))).join("");
      if (current && ![...select.options].some(o => o.value === current)) select.value = "";
      DF.searchSelect?.(select, { label: select.labels?.[0]?.textContent });
    };
    const initial = key => {
      // Older free-text addresses: the best-effort suggestion (GET /merchants/me pickupSuggestion), else the stored text if it matches.
      if (key === "Biz") {
        if (m.business) return m.business;
        if (m.addressComplete === false && m.pickupSuggestion) return { ...m.pickupSuggestion, street: m.pickupAddress };
        if (m.addressComplete === false) return { district: c.districts.find(d => norm(d) === norm(m.pickupDistrict)) || "", street: m.pickupAddress };
        return m.pickupSameAsBusiness ? m.pickup : null;
      }
      return m.pickupSameAsBusiness ? null : m.addressComplete === false ? null : m.pickup;
    };
    const setPlace = (key, p) => {
      const d = $(`dfma${key}District`);
      const z = $(`dfma${key}Zone`);
      const a = $(`dfma${key}Area`);
      fill(d, c.districts, "Choose district", p?.district || "");
      fill(z, zonesOf(d.value), d.value ? "Choose thana / upazila" : "Choose a district first", p?.zone || "");
      z.disabled = !d.value;
      const areas = areasOf(z.value);
      fill(a, [...areas, [OTHER, "Other (type the area)"]], !z.value ? "Choose the thana first" : areas.length ? "Choose area" : "No areas listed (optional)", p?.areaOther ? OTHER : p?.area && p.area !== p.zone ? p.area : "");
      a.disabled = !z.value;
      $(`dfma${key}OtherArea`).closest("[data-dfma-field]").hidden = a.value !== OTHER;
    };
    const showPin = key => {
      const p = pins[key];
      $(`dfma${key}PinText`).textContent = p ? `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}` : "No pin";
      form.querySelector(`[data-dfma-pin-clear="${key}"]`).hidden = !p;
    };
    const syncSame = () => {
      const hide = same();
      for (const s of ["District", "Zone", "Area", "Street"]) $(`dfmaPu${s}`).closest("[data-dfma-field]").hidden = hide;
      $("dfmaPuOtherArea").closest("[data-dfma-field]").hidden = hide || $("dfmaPuArea").value !== OTHER;
      form.querySelector('[data-dfma-pin="Pu"]').hidden = hide;
      hub();
    };

    let hubSeq = 0;
    async function hub() {
      const box = $("dfmaHub");
      const key = same() ? "Biz" : "Pu";
      const district = $(`dfma${key}District`).value;
      const zone = $(`dfma${key}Zone`).value;
      if (!district || !zone) return void (box.innerHTML = "");
      const mine = ++hubSeq;
      try {
        const r = await DF.api(`/merchants/pickup-hub?district=${encodeURIComponent(district)}&zone=${encodeURIComponent(zone)}`);
        if (mine !== hubSeq) return;
        const drop = $("dfmaHandover").value === "HUB_DROP";
        box.innerHTML = r.hub
          ? `Serving hub: <strong>${esc(r.hub.name)}</strong> (${esc(r.hub.code)}) · ${esc(r.hub.address)}${drop ? " — bring your parcels here." : ""}`
          : `<span style="color:#b45309">No hub serves ${esc(zone)} yet. Operations will assign one.</span>`;
      } catch (error) {
        if (mine === hubSeq) box.textContent = DF.describe(error);
      }
    }

    for (const key of ["Biz", "Pu"]) {
      setPlace(key, initial(key));
      showPin(key);
      $(`dfma${key}District`).addEventListener("change", () => (setPlace(key, { district: $(`dfma${key}District`).value }), hub()));
      $(`dfma${key}Zone`).addEventListener("change", () => (setPlace(key, { district: $(`dfma${key}District`).value, zone: $(`dfma${key}Zone`).value }), hub()));
      $(`dfma${key}Area`).addEventListener("change", () => ($(`dfma${key}OtherArea`).closest("[data-dfma-field]").hidden = $(`dfma${key}Area`).value !== OTHER));
      form.querySelector(`[data-dfma-pin-clear="${key}"]`).addEventListener("click", () => ((pins[key] = null), showPin(key), ($(`dfma${key}Map`).hidden = true)));
      form.querySelector(`[data-dfma-pin-open="${key}"]`).addEventListener("click", async () => {
        const box = $(`dfma${key}Map`);
        box.hidden = false;
        if (box.dataset.ready) return;
        box.dataset.ready = "1";
        try {
          const L = await loadLeaflet();
          const start = pins[key] || { lat: 23.7808, lng: 90.4093 };
          const map = L.map(box, { scrollWheelZoom: false }).setView([start.lat, start.lng], pins[key] ? 16 : 12);
          L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
          const icon = L.icon({ iconUrl: "/vendor/leaflet/images/marker-icon.png", iconRetinaUrl: "/vendor/leaflet/images/marker-icon-2x.png", shadowUrl: "/vendor/leaflet/images/marker-shadow.png", iconSize: [25, 41], iconAnchor: [12, 41] });
          const marker = L.marker([start.lat, start.lng], { draggable: true, icon }).addTo(map);
          const set = ({ lat, lng }) => ((pins[key] = { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 }), showPin(key));
          marker.on("dragend", () => set(marker.getLatLng()));
          map.on("click", e => (marker.setLatLng(e.latlng), set(e.latlng)));
        } catch (error) {
          box.textContent = error.message;
        }
      });
    }
    $("dfmaPickupSame").addEventListener("change", syncSame);
    $("dfmaHandover").addEventListener("change", hub);
    DF.phoneInput($("dfmaPickupPhone"));
    syncSame();

    const placeRules = (key, active) => ({
      [`dfma${key}District`]: v => (active() && !v ? "Choose the district" : ""),
      [`dfma${key}Zone`]: v => (active() && !v ? "Choose the thana / upazila" : ""),
      [`dfma${key}Area`]: v => (active() && $(`dfma${key}Zone`).value && !v && areasOf($(`dfma${key}Zone`).value).length ? 'Choose the area, or "Other" and type it' : ""),
      [`dfma${key}OtherArea`]: v => (active() && $(`dfma${key}Area`).value === OTHER && v.trim().length < 2 ? "Type the area name" : ""),
      [`dfma${key}Street`]: v => (active() && v.trim().length < 5 ? "Enter the house, road and flat (at least 5 characters)" : ""),
    });
    // Hidden fields' native `required` must not block: the rules decide.
    for (const s of ["District", "Zone", "Street"]) $(`dfmaPu${s}`).required = false;
    const check = DF.validate(form, {
      ...placeRules("Biz", () => true),
      ...placeRules("Pu", () => !same()),
      dfmaPickupContact: v => (v.trim().length < 2 ? "Enter the pickup contact's name" : ""),
      dfmaPickupTime: v => (v ? "" : "Choose the preferred pickup time"),
    });

    const placeBody = key => {
      const a = $(`dfma${key}Area`).value;
      return {
        district: $(`dfma${key}District`).value,
        zone: $(`dfma${key}Zone`).value,
        ...(a === OTHER ? { otherArea: $(`dfma${key}OtherArea`).value.trim() } : a ? { area: a } : {}),
        street: $(`dfma${key}Street`).value.trim(),
        ...(pins[key] ? { lat: pins[key].lat, lng: pins[key].lng } : {}),
      };
    };
    const body = () => ({
      business: placeBody("Biz"),
      pickupSameAsBusiness: same(),
      ...(same() ? {} : { pickup: placeBody("Pu") }),
      pickupContactName: $("dfmaPickupContact").value.trim(),
      pickupContactPhone: $("dfmaPickupPhone").value.trim(),
      pickupTime: $("dfmaPickupTime").value,
      handover: $("dfmaHandover").value,
    });
    /** API error paths (business.zone, pickup.area, pickupContactPhone…) → the field's id. */
    const fieldFor = path => {
      const [head, tail] = String(path).split(".");
      const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
      if (head === "business" || head === "pickup") return $(`dfma${head === "business" ? "Biz" : "Pu"}${cap(tail === "lat" || tail === "lng" || !tail ? "district" : tail)}`);
      return { pickupContactName: $("dfmaPickupContact"), pickupContactPhone: $("dfmaPickupPhone"), pickupTime: $("dfmaPickupTime"), handover: $("dfmaHandover") }[head] || null;
    };
    return { check, body, fieldFor };
  }

  window.DFMerchantAddress = { TIMES, HANDOVER, OTHER, placeText, mapLink, summaryHtml, formHtml, wire };
})();
