/*
 * Courier Operations on the API, part 7: SLA engine (Analytics & SLA page, Exceptions page).
 *
 *   Summary / alerts     GET /sla/summary, /sla/alerts, POST /sla/alerts/:id/acknowledge
 *   Report               GET /sla/report?from&to&hubId (CSV export; print: GET /documents/sla-report, PDF)
 *   Policies             GET/POST/PATCH/DELETE /sla/policies (hub managers)
 *   Run the check now    POST /sla/monitor (it also runs every five minutes on the server)
 * New breaches are escalated by the server (ops.sla_breach); "sla.updated" events refresh the views.
 */
(() => {
  const DF = window.DF;
  const Ops = window.DFOps;
  const ui = Ops.ui;
  const $ = id => document.getElementById(id);
  const q = (selector, root = document) => root.querySelector(selector);
  const esc = Ops.esc;
  const LEVEL = { AT_RISK: "At risk", BREACHED: "Breached" };
  const LEG = { PICKUP: "Pickup", DELIVERY: "Delivery" };
  const SERVICE = { REGULAR: "Regular", SAME_DAY: "Same day", EXPRESS: "Express" };
  const minutes = m => (m >= 1440 && m % 1440 === 0 ? `${m / 1440} day${m === 1440 ? "" : "s"}` : m >= 60 && m % 60 === 0 ? `${m / 60} hr` : `${m} min`);
  const pct = v => (v == null ? "—" : `${v}%`);

  const today = () => Ops.dayKey();
  const report = { from: Ops.dayKey(new Date(Date.now() - 29 * 86400000)), to: today(), hubId: "" };
  const alertFilter = { level: "", leg: "", open: "true" };
  let alertsExtra = { items: [], next: null };

  const summary = () => Ops.lazy("sla-summary", () => DF.api("/sla/summary"), 30000);
  const alertsKey = () => `sla-alerts:${alertFilter.level}|${alertFilter.leg}|${alertFilter.open}`;
  const alerts = () => {
    const p = new URLSearchParams({ limit: "25" });
    for (const [k, v] of Object.entries(alertFilter)) if (v) p.set(k, v);
    return Ops.lazy(alertsKey(), () => DF.api(`/sla/alerts?${p}`), 30000);
  };
  const reportKey = () => `sla-report:${report.from}|${report.to}|${report.hubId}`;
  const loadReport = () => Ops.lazy(reportKey(), () => DF.api(`/sla/report?from=${report.from}&to=${report.to}${report.hubId ? `&hubId=${report.hubId}` : ""}`), 60000);
  const policies = () => Ops.lazy("sla-policies", () => DF.api("/sla/policies?limit=200"), 60000);

  function alertsPanel(compact = false) {
    const page = alerts();
    const items = [...(page?.items || []), ...alertsExtra.items];
    const next = alertsExtra.next ?? page?.nextCursor;
    const rows = items
      .map(
        a =>
          `<tr><td><strong>${esc(a.parcel.trackingId)}</strong><span class="subcell">${esc(a.parcel.statusLabel)} · ${esc(a.parcel.serviceLevel)}</span></td><td>${esc(LEG[a.leg])}</td><td>${ui.pill(a.level === "BREACHED" ? "Exception" : "At risk").replace(/>[^<]*</, `>${esc(LEVEL[a.level])}<`)}</td><td>${esc(Ops.when(a.dueAt))}</td><td>${esc(a.parcel.zone)}<span class="subcell">${esc(a.parcel.hub?.name || "No hub")}</span></td><td>${esc(a.parcel.rider || "Unassigned")}</td><td>${
            a.resolvedAt ? `Resolved ${esc(Ops.ago(a.resolvedAt))}` : a.acknowledgedAt ? `${esc(a.acknowledgedBy || "")}<span class="subcell">${esc(a.note || "")}</span>` : Ops.can("dispatch") ? `<button class="button button-sm" data-sla-ack="${a.id}">Acknowledge</button>` : "Open"
          }</td><td><button class="button button-sm" data-exception="${esc(a.parcel.trackingId)}">Review</button></td></tr>`,
      )
      .join("");
    const tools = compact
      ? ""
      : `${ui.select("slaLevel", [{ value: "", label: "All levels" }, { value: "BREACHED", label: "Breached" }, { value: "AT_RISK", label: "At risk" }], alertFilter.level, 'class="select-small" data-sla-filter="level" aria-label="Level"')}${ui.select("slaLeg", [{ value: "", label: "Pickup and delivery" }, { value: "PICKUP", label: "Pickup" }, { value: "DELIVERY", label: "Delivery" }], alertFilter.leg, 'class="select-small" data-sla-filter="leg" aria-label="Leg"')}${ui.select("slaOpen", [{ value: "true", label: "Open" }, { value: "false", label: "Resolved" }, { value: "", label: "All" }], alertFilter.open, 'class="select-small" data-sla-filter="open" aria-label="Open or resolved"')}${Ops.can("manageHubs") ? `<button class="button button-sm" data-sla="run">Check now</button>` : ""}`;
    const error = Ops.lazyError(alertsKey());
    return ui.panel(
      "SLA alerts",
      "Parcels at risk of missing, or past, their pickup / delivery due time · new breaches are escalated to operations",
      ui.table(["Parcel", "Leg", "Level", "Due", "Zone / hub", "Rider", "Acknowledged", ""], rows, error ? DF.describe(error) : page ? "No SLA alerts." : "Loading SLA alerts…") + ui.footer(`Showing ${items.length} alert(s)`, next && !compact ? "data-sla-more" : ""),
      tools,
      'id="slaAlerts"',
    );
  }

  function reportPanel() {
    const r = Ops.cache[reportKey()]?.value || loadReport();
    const hubs = Ops.myHubs() || DF.state.hubs;
    const tools = `<label class="shipment-date-filter">From<input class="table-search" type="date" id="slaFrom" value="${report.from}"></label><label class="shipment-date-filter">To<input class="table-search" type="date" id="slaTo" value="${report.to}"></label>${hubs.length > 1 ? ui.select("slaHub", ui.hubOptions(hubs, "All hubs"), report.hubId, 'class="select-small" aria-label="Hub"') : ""}<button class="button button-sm" data-sla="export">${icon("download")} CSV</button><button class="button button-sm" data-sla="print">Print</button>`;
    if (!r) return ui.panel("SLA report", "Loading…", "", tools, 'id="slaReport"');
    const levelRows = r.byServiceLevel.map(l => `<tr><td>${esc(l.label)}</td><td>${l.total}</td><td>${l.onTime}</td><td>${pct(l.rate)}</td><td>${l.avgLateMinutes == null ? "—" : minutes(l.avgLateMinutes)}</td></tr>`).join("");
    const zoneRows = r.byZone.slice(0, 15).map(z => `<tr><td>${esc(z.zone)}<span class="subcell">${esc(z.district)}</span></td><td>${z.total}</td><td>${z.onTime}</td><td>${z.late}</td><td>${pct(z.rate)}</td></tr>`).join("");
    const body = `<div class="stats-mini" style="padding:0 16px"><div class="mini-card"><span>Pickups on time</span><strong>${pct(r.pickups.rate)}</strong></div><div class="mini-card"><span>Deliveries on time</span><strong>${pct(r.deliveries.rate)}</strong></div><div class="mini-card"><span>Breaches raised</span><strong>${r.alerts.pickupBreached + r.alerts.deliveryBreached}</strong></div></div>${ui.table(["Service level", "Delivered", "On time", "On-time %", "Avg. late by"], levelRows, "No deliveries in this range.")}${ui.table(["Delivery zone", "Delivered", "On time", "Late", "On-time %"], zoneRows, "No deliveries in this range.")}`;
    return ui.panel("SLA report", `${r.deliveries.total} deliveries and ${r.pickups.total} pickups with a due time · ${r.from} to ${r.to}`, body, tools, 'id="slaReport"');
  }

  function policiesPanel() {
    const p = policies();
    const manage = Ops.can("manageHubs");
    const place = (d, z) => (z ? `${z}, ${d}` : d || "Anywhere");
    const rows = (p?.items || [])
      .map(
        x =>
          `<tr><td><strong>${esc(x.name)}</strong></td><td>${esc(SERVICE[x.serviceLevel])}</td><td>${esc(place(x.originDistrict, x.originZone))} → ${esc(place(x.destDistrict, x.destZone))}</td><td>${minutes(x.pickupMinutes)}</td><td>${minutes(x.deliveryMinutes)}</td><td>${minutes(x.atRiskMinutes)} before</td><td>${ui.pill(x.active ? "Active" : "Inactive")}</td><td>${manage ? `<button class="button button-sm" data-sla-policy="${x.id}">Edit</button>` : ""}</td></tr>`,
      )
      .join("");
    const defaults = p?.defaults
      ? Object.entries(p.defaults)
          .map(([level, d]) => `${SERVICE[level]}: pickup ${minutes(d.pickup)}, delivery ${minutes(d.delivery)}${d.deliveryOtherDistrict !== d.delivery ? ` (${minutes(d.deliveryOtherDistrict)} to another district)` : ""}`)
          .join(" · ")
      : "";
    return ui.panel(
      "SLA policies",
      `The most specific active policy for a parcel's service level and zones sets its due times at booking. Defaults: ${defaults}`,
      ui.table(["Policy", "Service", "Route", "Pickup within", "Deliver within", "At risk", "Status", ""], rows, p ? "No policies: the defaults apply." : "Loading…"),
      manage ? `<button class="button button-sm" data-sla="add-policy">${icon("plus")} Add policy</button>` : "",
      'id="slaPolicies"',
    );
  }

  // Reports › Analytics & SLA look: separated sections, the SLA cards across the row, health as badges.
  document.head.insertAdjacentHTML(
    "beforeend",
    `<style id="anStyles">
#mainContent:has(#slaReport) > .panel,#mainContent:has(#slaReport) > section,#mainContent:has(#slaReport) > .metrics{margin-top:18px}
#mainContent:has(#slaReport) > .panel,#mainContent:has(#slaReport) > section{border-radius:14px;overflow:hidden}
#mainContent:has(#slaReport) .panel-heading{border-bottom:1px solid #eef0f4;padding-bottom:12px}
#slaMetrics{grid-template-columns:repeat(3,minmax(0,1fr))!important}
@media(max-width:720px){#slaMetrics{grid-template-columns:1fr!important}}
#mainContent:has(#slaReport) .panel-heading .button{white-space:nowrap}
.an-badge{display:inline-flex;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:700;white-space:nowrap}
.an-badge.good{background:#ecfdf3;color:#067647}.an-badge.warn{background:#fffaeb;color:#b54708}.an-badge.bad{background:#fef3f2;color:#b42318}.an-badge.none{background:#f2f4f7;color:#98a2b3}
</style>`,
  );
  const HEALTH = { Healthy: "good", Monitor: "warn", "At risk": "bad", "No data": "none" };
  /** The Analytics register's Health column as coloured badges (its text unchanged). */
  function healthBadges() {
    const table = document.querySelector("#mainContent .table-panel table");
    if (!table) return;
    for (const row of table.querySelectorAll("tbody tr")) {
      const cell = row.lastElementChild;
      const text = cell?.textContent.trim();
      if (cell && HEALTH[text] && !cell.querySelector(".an-badge")) cell.innerHTML = `<span class="an-badge ${HEALTH[text]}">${text}</span>`;
    }
  }

  const baseAnalytics = Ops.enhance.Analytics;
  Ops.enhance.Analytics = page => {
    baseAnalytics?.(page);
    healthBadges();
    const s = summary();
    const main = $("mainContent");
    const metrics = s
      ? `<div class="metrics" id="slaMetrics">${[
          metric("SLA on track", Ops.num(s.onTrack), "check", "open parcels", "within due time"),
          metric("At risk", Ops.num(s.atRisk), "clock", `${Ops.num(s.openAlerts.atRisk)} unacknowledged`, "due soon"),
          metric("Breached", Ops.num(s.breached), "alert", `${Ops.num(s.openAlerts.breached)} unacknowledged`, "past due"),
        ].join("")}</div>`
      : "";
    main.insertAdjacentHTML("beforeend", metrics + alertsPanel() + reportPanel() + policiesPanel());
  };
  const baseExceptions = Ops.enhance.Exceptions;
  Ops.enhance.Exceptions = page => {
    baseExceptions?.(page);
    // Only the SLA late-risk tab shows (and loads) the alerts; the other Problems tabs don't fetch them.
    const tab = Ops.view?.()?.tab;
    if (tab && tab !== "SLA late-risk") return;
    $("mainContent").insertAdjacentHTML("beforeend", alertsPanel(true));
  };

  // ───────────── policy dialog ─────────────

  function policyDialog(id) {
    if (!Ops.require("manageHubs", "change SLA policies")) return;
    const x = (policies()?.items || []).find(p => p.id === id);
    const c = Ops.catalog || { districts: [], zonesByDistrict: {} };
    const districtSel = (key, value) => ui.select(key, [{ value: "", label: "Any district" }, ...c.districts], value || "", x ? "disabled" : "");
    const zoneSel = (key, district, value) => ui.select(key, [{ value: "", label: "Any zone" }, ...(c.zonesByDistrict[district] || [])], value || "", x ? "disabled" : "");
    Ops.dialog("slaPolicy", {
      title: x ? `Edit policy · ${x.name}` : "Add SLA policy",
      description: "Targets apply to new bookings. A parcel is flagged at risk this long before a target, and breached after it.",
      submit: x ? "Save policy" : "Add policy",
      context: { policyId: x?.id },
      fields:
        ui.field("spName", "Name", ui.input("spName", `required maxlength="120" value="${esc(x?.name || "")}"`), true) +
        ui.field("spLevel", "Service level", ui.select("spLevel", Object.entries(SERVICE).map(([value, label]) => ({ value, label })), x?.serviceLevel || "REGULAR", x ? "disabled" : "")) +
        ui.field("spActive", "Status", ui.select("spActive", [{ value: "true", label: "Active" }, { value: "false", label: "Inactive" }], String(x?.active ?? true))) +
        ui.field("spOriginDistrict", "From district", districtSel("spOriginDistrict", x?.originDistrict)) +
        ui.field("spOriginZone", "From zone", zoneSel("spOriginZone", x?.originDistrict, x?.originZone)) +
        ui.field("spDestDistrict", "To district", districtSel("spDestDistrict", x?.destDistrict)) +
        ui.field("spDestZone", "To zone", zoneSel("spDestZone", x?.destDistrict, x?.destZone)) +
        ui.field("spPickup", "Pickup within (hours)", ui.input("spPickup", `type="number" min="0.25" step="0.25" required value="${x ? x.pickupMinutes / 60 : 4}"`)) +
        ui.field("spDelivery", "Deliver within (hours)", ui.input("spDelivery", `type="number" min="0.25" step="0.25" required value="${x ? x.deliveryMinutes / 60 : 48}"`)) +
        ui.field("spRisk", "At risk (minutes before)", ui.input("spRisk", `type="number" min="5" step="5" required value="${x?.atRiskMinutes ?? 120}"`)),
    });
    for (const [d, z] of [
      ["spOriginDistrict", "spOriginZone"],
      ["spDestDistrict", "spDestZone"],
    ])
      $(d).addEventListener("change", () => ($(z).innerHTML = [`<option value="">Any zone</option>`, ...(c.zonesByDistrict[$(d).value] || []).map(v => `<option>${esc(v)}</option>`)].join("")));
    if (x && Ops.can("manageHubs"))
      $("modalFields").insertAdjacentHTML("beforeend", `<div class="field full"><button class="button" type="button" data-sla-delete="${x.id}">Delete this policy</button></div>`);
  }
  Ops.submitters.slaPolicy = async () => {
    const valid = DF.validate($("modalForm"), {
      spName: v => (v.trim().length < 2 ? "Name the policy" : ""),
      spPickup: v => (Number(v) >= 0.25 ? "" : "At least 15 minutes"),
      spDelivery: v => (Number(v) >= 0.25 ? "" : "At least 15 minutes"),
      spOriginZone: v => (v && !$("spOriginDistrict").value ? "Choose the district too" : ""),
      spDestZone: v => (v && !$("spDestDistrict").value ? "Choose the district too" : ""),
    });
    if (!valid()) return;
    const timing = { pickupMinutes: Math.round(Number($("spPickup").value) * 60), deliveryMinutes: Math.round(Number($("spDelivery").value) * 60), atRiskMinutes: Number($("spRisk").value), active: $("spActive").value === "true" };
    const id = modalContext.policyId;
    const body = id
      ? { name: $("spName").value.trim(), ...timing }
      : {
          name: $("spName").value.trim(),
          serviceLevel: $("spLevel").value,
          originDistrict: $("spOriginDistrict").value || null,
          originZone: $("spOriginZone").value || null,
          destDistrict: $("spDestDistrict").value || null,
          destZone: $("spDestZone").value || null,
          ...timing,
        };
    await DF.api(id ? `/sla/policies/${id}` : "/sla/policies", { method: id ? "PATCH" : "POST", body });
    closeModal();
    Ops.invalidate("sla-policies");
    Ops.rerender(true);
    showToast(`Policy ${id ? "saved" : "added"}. It applies to new bookings.`);
  };

  // ───────────── events ─────────────

  function exportReport() {
    const r = Ops.cache[reportKey()]?.value;
    if (!r) return void showToast("The report is still loading.");
    const rows = [["Section", "Name", "Total", "On time", "On-time %"]];
    rows.push(["Pickups", "All", r.pickups.total, r.pickups.onTime, r.pickups.rate ?? ""], ["Deliveries", "All", r.deliveries.total, r.deliveries.onTime, r.deliveries.rate ?? ""]);
    for (const l of r.byServiceLevel) rows.push(["Service level", l.label, l.total, l.onTime, l.rate ?? ""]);
    for (const z of r.byZone) rows.push(["Zone", `${z.zone}, ${z.district}`, z.total, z.onTime, z.rate ?? ""]);
    for (const h of r.byHub) rows.push(["Hub", h.hub?.name || "No hub", h.total, h.onTime, h.rate ?? ""]);
    for (const d of r.byDay) rows.push(["Day", d.day, d.total, d.onTime, d.rate ?? ""]);
    const csv = "﻿" + rows.map(row => row.map(v => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(",")).join("\r\n");
    courierCsvDownload(`paira-express-sla-${r.from}-to-${r.to}.csv`, csv);
  }
  /** The SLA report as a PDF in a new tab (same dates and hub as on screen). */
  function printReport() {
    return Ops.printPdf(`/documents/sla-report?from=${report.from}&to=${report.to}${report.hubId ? `&hubId=${report.hubId}` : ""}`, { title: "Preparing the SLA report…" });
  }


  window.addEventListener(
    "click",
    async event => {
      const ack = event.target.closest("[data-sla-ack]");
      const action = event.target.closest("[data-sla]");
      const more = event.target.closest("[data-sla-more]");
      const policy = event.target.closest("[data-sla-policy]");
      const del = event.target.closest("[data-sla-delete]");
      if (!ack && !action && !more && !policy && !del) return;
      event.stopImmediatePropagation();
      try {
        if (ack) {
          const note = await Ops.prompt({ title: "Acknowledge this alert", message: "Everyone watching SLA alerts sees that you are on it.", label: "What is being done?", multiline: true, maxLength: 500, confirm: "Acknowledge", placeholder: "e.g. Rider called; delivering before 6 pm" });
          if (note === null) return;
          await DF.api(`/sla/alerts/${ack.dataset.slaAck}/acknowledge`, { method: "POST", body: { note: note || undefined } });
          showToast("Alert acknowledged.");
          Ops.invalidate(alertsKey(), "sla-summary");
          alertsExtra = { items: [], next: null };
          return void Ops.rerender(true);
        }
        if (more) {
          const p = new URLSearchParams({ limit: "25", cursor: alertsExtra.next ?? alerts()?.nextCursor });
          for (const [k, v] of Object.entries(alertFilter)) if (v) p.set(k, v);
          const page = await DF.api(`/sla/alerts?${p}`);
          alertsExtra = { items: [...alertsExtra.items, ...page.items], next: page.nextCursor };
          return void Ops.rerender(true);
        }
        if (policy) return policyDialog(policy.dataset.slaPolicy);
        if (del) {
          if (!(await Ops.confirm({ title: "Delete this SLA policy?", message: "Parcels already booked keep their due times.", confirm: "Delete policy", danger: true }))) return;
          await DF.api(`/sla/policies/${del.dataset.slaDelete}`, { method: "DELETE" });
          closeModal();
          Ops.invalidate("sla-policies");
          return void Ops.rerender(true);
        }
        switch (action.dataset.sla) {
          case "add-policy":
            return policyDialog();
          case "run": {
            const r = await DF.api("/sla/monitor", { method: "POST" });
            showToast(`SLA check: ${r.breached} breached, ${r.atRisk} at risk, ${r.newAlerts} new alert(s), ${r.resolved} resolved.`);
            Ops.invalidate(alertsKey(), "sla-summary");
            return void Ops.rerender(true);
          }
          case "export":
            return exportReport();
          case "print":
            return printReport();
        }
      } catch (error) {
        showToast(DF.describe(error));
      }
    },
    true,
  );
  window.addEventListener("change", event => {
    const filter = event.target.dataset?.slaFilter;
    if (filter) {
      alertFilter[filter] = event.target.value;
      alertsExtra = { items: [], next: null };
      return void Ops.rerender(true);
    }
    if (["slaFrom", "slaTo", "slaHub"].includes(event.target.id)) {
      const from = $("slaFrom")?.value || report.from;
      const to = $("slaTo")?.value || report.to;
      if (from > to) return void showToast("Choose a start date on or before the end date.");
      Object.assign(report, { from, to, hubId: $("slaHub")?.value ?? report.hubId });
      Ops.rerender(true);
    }
  });

  DF.live(["sla.updated"], () => {
    Object.keys(Ops.cache).filter(k => k.startsWith("sla-")).forEach(k => Ops.invalidate(k));
    alertsExtra = { items: [], next: null };
    if (["Analytics", "Exceptions"].includes(Ops.page())) Ops.rerender();
  });
})();
