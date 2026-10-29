/*
 * Courier Operations on the API, part 8: rider shifts and attendance (Riders & fleet page).
 *
 *   Today's roster         GET /shifts/today (scheduled, on shift, late, absent)
 *   Shift schedules        GET/POST/PATCH/DELETE /shifts/schedules (rider managers)
 *   Attendance             GET /shifts/attendance, PATCH /shifts/attendance/:id (corrections)
 *   Attendance report      GET /shifts/report?from&to (CSV export)
 * Riders check in / out from the rider app (POST /rider/shift/check-in | check-out); those
 * arrive here as "rider.shift" events.
 */
(() => {
  const DF = window.DF;
  const Ops = window.DFOps;
  const ui = Ops.ui;
  const $ = id => document.getElementById(id);
  const qa = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = Ops.esc;
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const time = iso => (iso ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "—");
  const range = { from: Ops.dayKey(new Date(Date.now() - 6 * 86400000)), to: Ops.dayKey() };

  const today = () => Ops.lazy("shifts-today", () => DF.api("/shifts/today"), 30000);
  const schedules = () => Ops.lazy("shifts-schedules", () => DF.api("/shifts/schedules?limit=200&active=true"), 60000);
  const reportKey = () => `shifts-report:${range.from}|${range.to}`;
  const report = () => Ops.lazy(reportKey(), () => DF.api(`/shifts/report?from=${range.from}&to=${range.to}`), 60000);
  const attendance = () => Ops.lazy("shifts-attendance", () => DF.api(`/shifts/attendance?limit=30`), 30000);

  function panels() {
    if (!Ops.can("readRiders")) return "";
    const manage = Ops.can("manageRiders");
    const t = today();
    const rosterRows = (t || [])
      .filter(r => r.schedule || r.checkInAt)
      .map(
        r =>
          `<tr><td><strong>${esc(r.rider.label)}</strong><span class="subcell">${esc(r.rider.hub?.name || "No hub")}</span></td><td>${r.schedule ? `${esc(r.schedule.startTime)}–${esc(r.schedule.endTime)}` : "Unscheduled"}</td><td>${time(r.checkInAt)}</td><td>${time(r.checkOutAt)}</td><td>${r.late ? `${r.late} min` : "—"}</td><td>${ui.pill(r.state === "On shift" ? "Active" : r.state === "Late" ? "At risk" : r.state === "Absent" ? "Exception" : r.state).replace(/>[^<]*</, `>${esc(r.state)}<`)}</td></tr>`,
      )
      .join("");
    const s = schedules();
    const scheduleRows = (s?.items || [])
      .map(
        x =>
          `<tr><td><strong>${esc(x.rider.label)}</strong><span class="subcell">${esc(x.rider.hub?.name || "No hub")}</span></td><td>${x.weekdays.map(d => DAYS[d]).join(", ")}</td><td>${esc(x.startTime)}–${esc(x.endTime)}</td><td>${esc(ui.date(x.validFrom))}${x.validTo ? ` to ${esc(ui.date(x.validTo))}` : " onwards"}</td><td>${esc(x.note || "")}</td><td>${manage ? `<button class="button button-sm" data-shift-edit="${x.id}">Edit</button>` : ""}</td></tr>`,
      )
      .join("");
    const r = report();
    const reportRows = (r?.riders || [])
      .map(x => `<tr><td>${esc(x.rider.label)}</td><td>${x.scheduled}</td><td>${x.present}</td><td>${x.late}${x.avgLateMinutes ? `<span class="subcell">avg ${x.avgLateMinutes} min</span>` : ""}</td><td>${x.absent}</td><td>${x.attendanceRate == null ? "—" : `${x.attendanceRate}%`}</td><td>${x.hoursWorked}</td></tr>`)
      .join("");
    const a = attendance();
    const attendanceRows = (a?.items || [])
      .map(
        x =>
          `<tr><td>${esc(x.rider.label)}</td><td>${esc(x.workDate)}</td><td>${time(x.checkInAt)}${x.late ? `<span class="subcell">${x.late} min late</span>` : ""}</td><td>${x.checkOutAt ? time(x.checkOutAt) : "On shift"}</td><td>${x.minutes == null ? "—" : `${Math.floor(x.minutes / 60)}h ${x.minutes % 60}m`}</td><td>${esc(x.source === "OPERATIONS" ? "Corrected" : "Rider app")}<span class="subcell">${esc(x.note || "")}</span></td><td>${manage ? `<button class="button button-sm" data-attendance-fix="${x.id}">Correct</button>` : ""}</td></tr>`,
      )
      .join("");
    return `<div id="shiftPanels">${ui.panel("Today's shift roster", "Who is scheduled, on shift, late or absent today", ui.table(["Rider", "Shift", "Checked in", "Checked out", "Late", "State"], rosterRows, t ? "Nobody is scheduled or checked in today." : "Loading…"))}${ui.panel(
      "Shift schedules",
      "Recurring shifts per rider (Dhaka time)",
      ui.table(["Rider", "Days", "Hours", "Valid", "Note", ""], scheduleRows, s ? "No shift schedules yet." : "Loading…"),
      manage ? `<button class="button button-sm" data-shift-add>${icon("plus")} Add shift</button>` : "",
    )}${ui.panel(
      "Attendance report",
      r ? `Late = checked in more than ${r.lateAfterMinutes} minutes after the shift start` : "Loading…",
      ui.table(["Rider", "Scheduled", "Present", "Late", "Absent", "Attendance", "Hours"], reportRows, r ? "No riders." : "Loading…"),
      `<label class="shipment-date-filter">From<input class="table-search" type="date" id="shiftFrom" value="${range.from}"></label><label class="shipment-date-filter">To<input class="table-search" type="date" id="shiftTo" value="${range.to}"></label><button class="button button-sm" data-shift-export>${icon("download")} CSV</button>`,
    )}${ui.panel("Recent check-ins", "Check-ins and check-outs from the rider app; corrections are recorded with a reason", ui.table(["Rider", "Day", "In", "Out", "Worked", "Source", ""], attendanceRows, a ? "No check-ins yet." : "Loading…"))}</div>`;
  }

  const baseRiders = Ops.enhance.Riders;
  Ops.enhance.Riders = page => {
    baseRiders?.(page);
    $("shiftPanels")?.remove();
    $("mainContent").insertAdjacentHTML("beforeend", panels());
  };

  // ───────────── dialogs ─────────────

  function scheduleDialog(id) {
    if (!Ops.require("manageRiders", "plan shifts")) return;
    const x = (schedules()?.items || []).find(s => s.id === id);
    const riders = DF.state.riders || [];
    const days = x?.weekdays || [0, 1, 2, 3, 4, 6];
    Ops.dialog("shiftSchedule", {
      title: x ? `Edit shift · ${x.rider.label}` : "Add shift",
      description: "A recurring shift. Riders check in and out from the rider app; attendance is measured against it.",
      submit: x ? "Save shift" : "Add shift",
      context: { scheduleId: x?.id },
      fields:
        (x ? "" : ui.field("shRider", "Rider", ui.select("shRider", riders.map(r => ({ value: r.id, label: `${r.code} · ${r.name}` }))), true)) +
        `<div class="field full"><label>Days</label><div id="shDays" style="display:flex;flex-wrap:wrap;gap:6px 14px">${DAYS.map((d, i) => `<label style="display:flex;gap:6px;align-items:center;font-weight:500"><input type="checkbox" value="${i}" ${days.includes(i) ? "checked" : ""} style="padding:0"> ${d}</label>`).join("")}</div></div>` +
        ui.field("shStart", "Starts", ui.input("shStart", `type="time" required value="${x?.startTime || "08:00"}"`)) +
        ui.field("shEnd", "Ends", ui.input("shEnd", `type="time" required value="${x?.endTime || "17:00"}"`)) +
        (x ? "" : ui.field("shFrom", "From", ui.input("shFrom", `type="date" required value="${Ops.dayKey()}"`))) +
        ui.field("shTo", "Until (optional)", ui.input("shTo", `type="date" value="${x?.validTo ? String(x.validTo).slice(0, 10) : ""}"`)) +
        ui.field("shNote", "Note (optional)", ui.input("shNote", `maxlength="300" value="${esc(x?.note || "")}"`), true) +
        (x ? `<div class="field full"><button class="button" type="button" data-shift-end="${x.id}">End this shift schedule</button></div>` : ""),
    });
  }
  Ops.submitters.shiftSchedule = async () => {
    const weekdays = qa("#shDays input:checked").map(i => Number(i.value));
    const valid = DF.validate($("modalForm"), { shStart: v => (v && v === $("shEnd").value ? "The shift must end at a different time" : !v ? "Choose a start time" : "") });
    if (!valid()) return;
    if (!weekdays.length) throw new Error("Choose at least one day.");
    const id = modalContext.scheduleId;
    const body = id
      ? { weekdays, startTime: $("shStart").value, endTime: $("shEnd").value, validTo: $("shTo").value || null, note: $("shNote").value.trim() || null }
      : { riderId: $("shRider").value, weekdays, startTime: $("shStart").value, endTime: $("shEnd").value, validFrom: $("shFrom").value, validTo: $("shTo").value || undefined, note: $("shNote").value.trim() || undefined };
    await DF.api(id ? `/shifts/schedules/${id}` : "/shifts/schedules", { method: id ? "PATCH" : "POST", body });
    closeModal();
    invalidate();
    showToast(`Shift ${id ? "saved" : "added"}.`);
  };

  function correctDialog(id) {
    if (!Ops.require("manageRiders", "correct attendance")) return;
    const x = (attendance()?.items || []).find(a => a.id === id);
    if (!x) return;
    const local = iso => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "");
    Ops.dialog("attendanceFix", {
      title: `Correct attendance · ${x.rider.label}`,
      description: `${x.workDate}. The change is recorded with your name and reason.`,
      submit: "Save correction",
      context: { attendanceId: id },
      fields:
        ui.field("afIn", "Checked in", ui.input("afIn", `type="datetime-local" required value="${local(x.checkInAt)}"`)) +
        ui.field("afOut", "Checked out", ui.input("afOut", `type="datetime-local" value="${local(x.checkOutAt)}"`)) +
        ui.field("afNote", "Reason", ui.input("afNote", 'required maxlength="300" placeholder="e.g. Phone battery died; confirmed with the hub"'), true),
    });
  }
  Ops.submitters.attendanceFix = async () => {
    const valid = DF.validate($("modalForm"), {
      afNote: v => (v.trim().length < 3 ? "Give the reason for the correction" : ""),
      afOut: v => (v && v <= $("afIn").value ? "Check-out must be after check-in" : ""),
    });
    if (!valid()) return;
    await DF.api(`/shifts/attendance/${modalContext.attendanceId}`, {
      method: "PATCH",
      body: { checkInAt: new Date($("afIn").value).toISOString(), checkOutAt: $("afOut").value ? new Date($("afOut").value).toISOString() : null, note: $("afNote").value.trim() },
    });
    closeModal();
    invalidate();
    showToast("Attendance corrected.");
  };

  function invalidate() {
    Object.keys(Ops.cache).filter(k => k.startsWith("shifts")).forEach(k => Ops.invalidate(k));
    if (Ops.page() === "Riders") Ops.rerender(true);
  }

  window.addEventListener(
    "click",
    event => {
      const add = event.target.closest("[data-shift-add]");
      const edit = event.target.closest("[data-shift-edit]");
      const end = event.target.closest("[data-shift-end]");
      const fix = event.target.closest("[data-attendance-fix]");
      const exp = event.target.closest("[data-shift-export]");
      if (!add && !edit && !end && !fix && !exp) return;
      event.stopImmediatePropagation();
      if (add) return scheduleDialog();
      if (edit) return scheduleDialog(edit.dataset.shiftEdit);
      if (fix) return correctDialog(fix.dataset.attendanceFix);
      if (end) {
        return void Ops.confirm({ title: "End this shift schedule?", message: "It ends from today. Past attendance is kept.", confirm: "End schedule", danger: true }).then(ok => {
          if (!ok) return;
          DF.api(`/shifts/schedules/${end.dataset.shiftEnd}`, { method: "PATCH", body: { active: false } })
            .then(() => (closeModal(), invalidate(), showToast("Shift schedule ended.")))
            .catch(error => showToast(DF.describe(error)));
        });
      }
      const r = Ops.cache[reportKey()]?.value;
      if (!r) return void showToast("The report is still loading.");
      const rows = [["Rider", "Hub", "Scheduled", "Present", "Late", "Absent", "Attendance %", "Hours"], ...r.riders.map(x => [x.rider.label, x.rider.hub?.name || "", x.scheduled, x.present, x.late, x.absent, x.attendanceRate ?? "", x.hoursWorked])];
      courierCsvDownload(`paira-express-attendance-${range.from}-to-${range.to}.csv`, "﻿" + rows.map(row => row.map(v => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(",")).join("\r\n"));
    },
    true,
  );
  window.addEventListener("change", event => {
    if (!["shiftFrom", "shiftTo"].includes(event.target.id)) return;
    const from = $("shiftFrom").value;
    const to = $("shiftTo").value;
    if (!from || !to || from > to) return void showToast("Choose a start date on or before the end date.");
    Object.assign(range, { from, to });
    Ops.rerender(true);
  });

  DF.live(["rider.shift"], () => {
    Object.keys(Ops.cache).filter(k => k.startsWith("shifts")).forEach(k => Ops.invalidate(k));
    if (Ops.page() === "Riders") Ops.rerender();
  });
})();
