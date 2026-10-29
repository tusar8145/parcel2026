/*
 * Courier Operations on the API, part 9: Reports (sidebar "Reports").
 *
 *   Run a report        POST /reports/run { kind, from, to, hubId } → table, CSV (Excel), PDF (GET /documents/report/:runId)
 *   Recent runs         GET /reports/runs, GET /reports/runs/:id (CSV kept on the server)
 *   Scheduled reports   GET/POST/PATCH/DELETE /reports/schedules, POST /reports/schedules/:id/run
 *                       (emailed daily / weekly through ops.scheduled_report with a link here)
 *   Scan compliance     GET /scans/compliance?from&to (expected vs actual scans per hub / rider)
 * The emailed link opens /courier-operation?report=<run id>, which shows that run.
 */
(() => {
  const DF = window.DF;
  const Ops = window.DFOps;
  const ui = Ops.ui;
  const $ = id => document.getElementById(id);
  const esc = Ops.esc;
  const PAGE = "Reports";
  const onPage = () => Ops.page() === PAGE;
  const KINDS = { DELIVERIES: "Delivery summary", SLA: "SLA attainment by zone", COD: "COD by rider", RIDERS: "Rider performance" };
  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  const state = {
    form: { kind: "DELIVERIES", from: Ops.dayKey(new Date(Date.now() - 6 * 86400000)), to: Ops.dayKey(), hubId: Ops.myHubs()?.[0]?.id || "" },
    result: null, // { run, table }
    runs: null,
    schedules: null,
    compliance: null,
    allHubs: false, // Scan compliance: every hub, or only hubs with arrivals (default)
    loading: false,
  };

  // Separated sections, summary cards, compliance badges (the page's look; ids, actions and data unchanged).
  document.head.insertAdjacentHTML(
    "beforeend",
    `<style id="rpStyles">
.rp{display:grid;gap:18px}
.rp > section.panel{margin:0;border-radius:14px;overflow:hidden}
.rp > section.panel .panel-heading{padding-bottom:12px;border-bottom:1px solid #eef0f4;margin-bottom:0}
#rpForm{background:linear-gradient(180deg,#f8faff,#fff)}
#rpForm .workflow-form{padding-top:14px;gap:12px}
#rpForm .workflow-form label{font-size:12px;font-weight:600;color:#475467}
.rp-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;padding:14px 16px 4px}
.rp-card{border:1px solid #e6e9ef;border-radius:12px;padding:12px 14px;background:#fff;display:grid;gap:3px}
.rp-card small{color:#667085;font-size:11.5px;font-weight:600;letter-spacing:.02em}
.rp-card strong{font-size:20px;line-height:1.2}
.rp-sub{display:flex;justify-content:space-between;align-items:center;gap:10px;margin:16px 16px 6px}
.rp-sub h3{margin:0;font-size:13px;font-weight:700;color:#344054}
.rp-sub span{font-size:12px;color:#667085}
.rp-badge{display:inline-flex;min-width:52px;justify-content:center;padding:3px 9px;border-radius:999px;font-size:12px;font-weight:700}
.rp-badge.good{background:#ecfdf3;color:#067647}.rp-badge.warn{background:#fffaeb;color:#b54708}.rp-badge.bad{background:#fef3f2;color:#b42318}.rp-badge.none{background:#f2f4f7;color:#98a2b3}
</style>`,
  );
  /** Compliance as a coloured badge: ≥95% good, ≥80% watch, below that a problem. */
  const badge = v => (v == null ? `<span class="rp-badge none">—</span>` : `<span class="rp-badge ${v >= 95 ? "good" : v >= 80 ? "warn" : "bad"}">${v}%</span>`);

  const csvText = (header, rows) =>
    "﻿" +
    [header, ...rows]
      .map(r =>
        r
          .map(v => {
            if (v == null) return "";
            let t = String(v);
            if (typeof v === "string" && /^[=+\-@]/.test(t)) t = `'${t}`;
            return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
          })
          .join(","),
      )
      .join("\r\n");

  async function loadSide() {
    const [runs, schedules, compliance] = await Promise.allSettled([
      DF.api("/reports/runs?limit=20"),
      DF.api("/reports/schedules?limit=100"),
      DF.api(`/scans/compliance?from=${state.form.from}&to=${state.form.to}${state.form.hubId ? `&hubId=${state.form.hubId}` : ""}`),
    ]);
    state.runs = runs.status === "fulfilled" ? runs.value : { items: [], error: DF.describe(runs.reason) };
    state.schedules = schedules.status === "fulfilled" ? schedules.value : { items: [], error: DF.describe(schedules.reason) };
    state.compliance = compliance.status === "fulfilled" ? compliance.value : { error: DF.describe(compliance.reason) };
    paint();
  }

  Ops.pages[PAGE] = {
    render: () =>
      `<div class="page-heading"><div><p class="eyebrow">Network operations · reporting</p><h1>Reports</h1><p class="subtitle">Delivery, SLA, COD and rider reports as Excel-compatible CSV or printable PDF, emailed on a schedule.</p></div><div class="heading-actions">${Ops.can("manageHubs") ? `<button class="button button-primary" data-rp="add-schedule">${icon("plus")} Schedule a report</button>` : ""}</div></div><div class="rp"><section class="panel" id="rpForm"></section><section class="panel table-panel" id="rpResult" hidden></section><section class="panel table-panel" id="rpCompliance"></section><section class="panel table-panel" id="rpSchedules"></section><section class="panel table-panel" id="rpRuns"></section></div>`,
  };
  Ops.enhance[PAGE] = () => {
    paint();
    if (!state.runs) void loadSide();
  };

  function paint() {
    if (onPage()) ui.keepFocus(repaint);
  }
  function repaint() {
    const f = state.form;
    const hubs = Ops.myHubs() || DF.state.hubs;
    $("rpForm").innerHTML = `<div class="panel-heading"><div><h2 class="panel-title">Run a report</h2><p class="panel-subtitle">Dhaka calendar days, up to 92 days at a time.</p></div></div><form class="workflow-form" id="rpRunForm" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr))"><label>Report${ui.select("rpKind", Object.entries(KINDS).map(([value, label]) => ({ value, label })), f.kind)}</label><label>From<input type="date" id="rpFrom" value="${f.from}" required></label><label>To<input type="date" id="rpTo" value="${f.to}" required></label><label>Hub${ui.select("rpHub", ui.hubOptions(hubs, Ops.myHubs() ? undefined : "Whole network"), f.hubId)}</label><div class="form-actions" style="align-self:end"><button class="button button-primary" type="submit" ${state.loading ? "disabled" : ""}>${state.loading ? "Running…" : "Run report"}</button></div></form>`;

    const r = state.result;
    const result = $("rpResult");
    result.hidden = !r;
    if (r) {
      const t = r.table;
      const rows = t.rows.map(row => `<tr>${row.map(v => `<td>${esc(v ?? "—")}</td>`).join("")}</tr>`).join("");
      result.innerHTML = `<div class="panel-heading"><div><h2 class="panel-title">${esc(t.title)}</h2><p class="panel-subtitle">${esc(t.from)} to ${esc(t.to)} · ${esc(t.hub?.name || "Whole network")} · ${t.rows.length} row(s)</p></div><div class="table-tools"><button class="button button-sm" data-rp="csv">${icon("download")} Excel (CSV)</button><button class="button button-sm" data-rp="print">Print / PDF</button><button class="button button-sm" data-rp="close">Close</button></div></div><div class="table-scroll"><table><thead><tr>${t.header.map(h => `<th>${esc(h.toUpperCase())}</th>`).join("")}</tr></thead><tbody>${rows || `<tr><td colspan="${t.header.length}" class="empty-state">No data in this range.</td></tr>`}</tbody></table></div>`;
    }

    const c = state.compliance;
    // Hubs with arrivals first (busiest first); hubs with none only on "Show all hubs".
    const allHubs = [...(c?.hubs || [])].sort((a, b) => b.expected - a.expected || a.hub.name.localeCompare(b.hub.name));
    const active = allHubs.filter(h => h.expected > 0 || h.scanned > 0);
    const shown = state.allHubs ? allHubs : active;
    const idle = allHubs.length - active.length;
    const hubRows = shown.map(h => `<tr><td><strong>${esc(h.hub.name)}</strong></td><td>${h.expected}</td><td>${h.scanned}</td><td>${h.missed ? `<strong style="color:#b42318">${h.missed}</strong>` : 0}</td><td>${h.camera}</td><td>${badge(h.compliance)}</td></tr>`).join("");
    const riderRows = (c?.riders || []).slice(0, 30).map(x => `<tr><td><strong>${esc(x.rider.label)}</strong></td><td>${x.pickups.scanned}/${x.pickups.expected}</td><td>${x.deliveries.scanned}/${x.deliveries.expected}</td><td>${badge(x.compliance)}</td></tr>`).join("");
    const t = c?.totals;
    const cards = t
      ? `<div class="rp-cards"><div class="rp-card"><small>SCANS</small><strong>${Ops.num(t.scans)}</strong></div><div class="rp-card"><small>BY CAMERA</small><strong>${Ops.num(t.camera)}</strong></div><div class="rp-card"><small>REFUSED</small><strong>${Ops.num(t.refused)}</strong></div><div class="rp-card"><small>HUB COMPLIANCE</small><strong>${badge(t.hubCompliance)}</strong></div><div class="rp-card"><small>RIDER COMPLIANCE</small><strong>${badge(t.riderCompliance)}</strong></div></div>`
      : "";
    const hubToggle = idle ? `<button class="button button-sm" data-rp="all-hubs">${state.allHubs ? "Only hubs with arrivals" : `Show all hubs (+${idle} with none)`}</button>` : "";
    $("rpCompliance").outerHTML = ui.panel(
      "Scan compliance",
      t ? `${state.form.from} to ${state.form.to} · expected scans against the scans made` : c?.error || "Loading…",
      `${cards}<div class="rp-sub"><h3>By hub · arrivals scanned</h3><span>${active.length} hub(s) with arrivals</span></div>${ui.table(["Hub", "Arrivals", "Scanned", "Missed", "By camera", "Compliance"], hubRows, c ? "No arrivals in this range." : "Loading…")}<div class="rp-sub"><h3>By rider · pickups and deliveries scanned</h3><span>${(c?.riders || []).length} rider(s)</span></div>${ui.table(["Rider", "Pickups scanned", "Deliveries scanned", "Compliance"], riderRows, c ? "No rider pickups or deliveries in this range." : "Loading…")}`,
      hubToggle,
      'id="rpCompliance"',
    );

    const s = state.schedules;
    const manage = Ops.can("manageHubs");
    const sRows = (s?.items || [])
      .map(
        x =>
          `<tr><td><strong>${esc(x.name)}</strong><span class="subcell">${esc(KINDS[x.kind])}</span></td><td>${esc(x.frequency === "DAILY" ? `Daily at ${x.hour}:00` : `${DAYS[x.weekday]}s at ${x.hour}:00`)}</td><td>${esc(x.recipients.join(", "))}</td><td>${esc(Ops.hubById(x.hubId)?.name || "Whole network")}</td><td>${esc(x.lastRunAt ? Ops.when(x.lastRunAt) : "Not yet")}<span class="subcell">next ${esc(Ops.when(x.nextRunAt))}</span></td><td>${ui.pill(x.active ? "Active" : "Inactive")}</td><td>${manage ? `<div style="display:flex;gap:6px;flex-wrap:wrap"><button class="button button-sm" data-rp="run-schedule" data-id="${x.id}">Send now</button><button class="button button-sm" data-rp="edit-schedule" data-id="${x.id}">Edit</button></div>` : ""}</td></tr>`,
      )
      .join("");
    $("rpSchedules").outerHTML = ui.panel("Scheduled reports", "Emailed with a link to the report; daily reports cover yesterday, weekly ones the previous seven days", ui.table(["Report", "When (Dhaka)", "Recipients", "Hub", "Last sent", "Status", ""], sRows, s?.error || (s ? "No scheduled reports." : "Loading…")), "", 'id="rpSchedules"');

    const runs = state.runs;
    const runRows = (runs?.items || [])
      .map(x => `<tr><td>${esc(KINDS[x.kind])}<span class="subcell">${esc(x.schedule?.name || "On demand")}</span></td><td>${esc(Ops.dayKey(x.periodStart))} to ${esc(Ops.dayKey(new Date(new Date(x.periodEnd).getTime() - 1)))}</td><td>${x.rowCount}</td><td>${ui.pill(x.status === "OK" ? "Ready" : "Exception")}</td><td>${esc(Ops.when(x.createdAt))}</td><td>${x.status === "OK" ? `<button class="button button-sm" data-rp="download" data-id="${x.id}">${icon("download")} CSV</button>` : esc(x.error || "")}</td></tr>`)
      .join("");
    $("rpRuns").outerHTML = ui.panel("Recent reports", "Kept on the server · download again as CSV", ui.table(["Report", "Period", "Rows", "Status", "Created", ""], runRows, runs?.error || (runs ? "No reports yet." : "Loading…")), "", 'id="rpRuns"');
  }

  // ───────────── actions ─────────────

  async function run() {
    const f = state.form;
    if (f.from > f.to) return void showToast("Choose a start date on or before the end date.");
    state.loading = true;
    paint();
    try {
      state.result = await DF.api("/reports/run", { method: "POST", body: { kind: f.kind, from: f.from, to: f.to, hubId: f.hubId || undefined } });
      void loadSide();
    } catch (error) {
      showToast(DF.describe(error));
    } finally {
      state.loading = false;
      paint();
    }
  }

  async function downloadRun(id) {
    try {
      const r = await DF.api(`/reports/runs/${id}`);
      courierCsvDownload(`paira-express-${r.kind.toLowerCase()}-${Ops.dayKey(r.periodStart)}.csv`, r.csv.replace(/^﻿/, "﻿"));
    } catch (error) {
      showToast(DF.describe(error));
    }
  }

  function scheduleDialog(id) {
    if (!Ops.require("manageHubs", "schedule reports")) return;
    const x = (state.schedules?.items || []).find(s => s.id === id);
    Ops.dialog("rpSchedule", {
      title: x ? `Edit · ${x.name}` : "Schedule a report",
      description: "Recipients get an email with a link to the report (they sign in to open it).",
      submit: x ? "Save" : "Schedule",
      context: { scheduleId: x?.id },
      fields:
        ui.field("rsName", "Name", ui.input("rsName", `required maxlength="120" value="${esc(x?.name || "")}" placeholder="e.g. Daily delivery summary"`), true) +
        ui.field("rsKind", "Report", ui.select("rsKind", Object.entries(KINDS).map(([value, label]) => ({ value, label })), x?.kind || "DELIVERIES", x ? "disabled" : "")) +
        ui.field("rsFreq", "Frequency", ui.select("rsFreq", [{ value: "DAILY", label: "Daily" }, { value: "WEEKLY", label: "Weekly" }], x?.frequency || "DAILY")) +
        ui.field("rsDay", "Day (weekly)", ui.select("rsDay", DAYS.map((d, i) => ({ value: String(i), label: d })), String(x?.weekday ?? 0))) +
        ui.field("rsHour", "Hour (Dhaka, 0–23)", ui.input("rsHour", `type="number" min="0" max="23" required value="${x?.hour ?? 8}"`)) +
        ui.field("rsHub", "Hub", ui.select("rsHub", ui.hubOptions(DF.state.hubs, "Whole network"), x?.hubId || "")) +
        ui.field("rsActive", "Status", ui.select("rsActive", [{ value: "true", label: "Active" }, { value: "false", label: "Paused" }], String(x?.active ?? true))) +
        ui.field("rsTo", "Recipients (emails, comma separated)", ui.input("rsTo", `required value="${esc(x?.recipients.join(", ") || "")}"`), true) +
        (x ? `<div class="field full"><button class="button" type="button" data-rp="delete-schedule" data-id="${x.id}">Delete this schedule</button></div>` : ""),
    });
  }
  Ops.submitters.rpSchedule = async () => {
    const emails = $("rsTo").value.split(/[,;\s]+/).map(e => e.trim()).filter(Boolean);
    const valid = DF.validate($("modalForm"), {
      rsName: v => (v.trim().length < 2 ? "Name the report" : ""),
      rsTo: () => (!emails.length ? "Add at least one email" : emails.some(e => !/^\S+@\S+\.\S+$/.test(e)) ? "Check the email addresses" : ""),
      rsHour: v => (Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 23 ? "" : "Use an hour from 0 to 23"),
    });
    if (!valid()) return;
    const id = modalContext.scheduleId;
    const weekly = $("rsFreq").value === "WEEKLY";
    const body = {
      name: $("rsName").value.trim(),
      frequency: $("rsFreq").value,
      weekday: weekly ? Number($("rsDay").value) : id ? null : undefined,
      hour: Number($("rsHour").value),
      recipients: emails,
      hubId: $("rsHub").value || (id ? null : undefined),
      active: $("rsActive").value === "true",
      ...(id ? {} : { kind: $("rsKind").value }),
    };
    await DF.api(id ? `/reports/schedules/${id}` : "/reports/schedules", { method: id ? "PATCH" : "POST", body });
    closeModal();
    showToast(`Report ${id ? "saved" : "scheduled"}.`);
    void loadSide();
  };

  window.addEventListener(
    "click",
    event => {
      const el = event.target.closest("[data-rp]");
      if (!el || !onPage()) return;
      event.stopImmediatePropagation();
      const id = el.dataset.id;
      switch (el.dataset.rp) {
        case "all-hubs":
          state.allHubs = !state.allHubs;
          return paint();
        case "csv": {
          const t = state.result.table;
          return courierCsvDownload(`paira-express-${t.kind.toLowerCase()}-${t.from}-to-${t.to}.csv`, csvText(t.header, t.rows));
        }
        case "print":
          // The stored run as a PDF table (GET /documents/report/:runId) in a new tab.
          return void Ops.printPdf(`/documents/report/${state.result.run.id}`, { title: "Preparing the report…" });
        case "close":
          state.result = null;
          return paint();
        case "download":
          return void downloadRun(id);
        case "add-schedule":
          return scheduleDialog();
        case "edit-schedule":
          return scheduleDialog(id);
        case "run-schedule":
          return void DF.api(`/reports/schedules/${id}/run`, { method: "POST" })
            .then(r => (showToast(r.status === "OK" ? "Report sent to its recipients." : `The report failed: ${r.error}`), loadSide()))
            .catch(error => showToast(DF.describe(error)));
        case "delete-schedule":
          return void Ops.confirm({ title: "Delete this scheduled report?", message: "Its recipients stop receiving it.", confirm: "Delete schedule", danger: true }).then(ok => {
            if (!ok) return;
            DF.api(`/reports/schedules/${id}`, { method: "DELETE" })
              .then(() => (closeModal(), loadSide(), showToast("Scheduled report deleted.")))
              .catch(error => showToast(DF.describe(error)));
          });
      }
    },
    true,
  );
  window.addEventListener(
    "submit",
    event => {
      if (!onPage() || event.target.id !== "rpRunForm") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void run();
    },
    true,
  );
  window.addEventListener("change", event => {
    if (!onPage()) return;
    const map = { rpKind: "kind", rpFrom: "from", rpTo: "to", rpHub: "hubId" };
    const key = map[event.target.id];
    if (!key) return;
    state.form[key] = event.target.value;
    if (key !== "kind") void loadSide(); // compliance follows the dates / hub
  });

  // The scheduled-report email links to /courier-operation?report=<run id>.
  const linked = new URLSearchParams(location.search).get("report");
  if (linked)
    (DF.bridgeReady || Promise.resolve()).then(async () => {
      render(PAGE);
      await downloadRun(linked);
      history.replaceState(null, "", location.pathname);
    });
})();
