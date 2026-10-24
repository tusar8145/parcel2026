/*
 * Courier Operations: returns to merchants (RTO) and merchants' scheduled pickups.
 * - Returns: parcels merchants asked to return (GET /returns?stage=requested), grouped by
 *   merchant → plan a return run (POST /returns/runs: RETURN_SCHEDULED with the return charge),
 *   dispatch it with a rider, complete it (RETURNED; parcels not taken back go to the hub) or
 *   cancel it. Returned parcels awaiting the merchant's confirmation are listed too.
 * - Scheduled pickups: the day's pickup requests from merchants' recurring schedules and
 *   one-off requests (GET /pickup-requests?date=) → assign a rider, mark collected / missed.
 * Pages are added through Ops.pages (bridge.js); live updates through DF.live.
 */
(() => {
  const DF = window.DF;
  const Ops = window.DFOps;
  if (!Ops) return;
  const $ = id => document.getElementById(id);
  const esc = Ops.esc;
  const toast = message => window.showToast(message);
  const fail = error => toast(DF.describe(error));
  const pill = text => statusPill(text); // eslint-disable-line no-undef -- page script global
  const dhakaToday = () => new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
  const time = iso => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Dhaka" });

  const R = { requested: null, returned: null, runs: null, run: null, pickups: null, date: "upcoming", loading: false };
  const RUN_STATUS = { PLANNED: "Planned", OUT_FOR_RETURN: "Out for return", COMPLETED: "Completed", CANCELLED: "Cancelled" };
  const PICKUP_STATUS = { REQUESTED: "Requested", ASSIGNED: "Rider assigned", COMPLETED: "Collected", CANCELLED: "Cancelled", MISSED: "Missed" };

  async function riders() {
    if (!DF.state.riders?.length) DF.state.riders = await DF.api("/riders?active=true").catch(() => []);
    return DF.state.riders || [];
  }
  const riderName = id => {
    const r = (DF.state.riders || []).find(x => x.id === id);
    return r ? `${r.code} · ${r.name || r.user?.name || ""}` : id ? "Assigned rider" : "—";
  };
  const riderOptions = (selected = "") =>
    `<option value="">Choose a rider…</option>${(DF.state.riders || []).map(r => `<option value="${esc(r.id)}"${r.id === selected ? " selected" : ""}>${esc(r.code)} · ${esc(r.name || r.user?.name || "")}</option>`).join("")}`;

  // ───────────── returns ─────────────

  async function loadReturns() {
    const [requested, returned, runs] = await Promise.all([
      DF.api("/returns?stage=requested&limit=200"),
      DF.api("/returns?stage=returned&limit=100"),
      DF.api("/returns/runs?limit=50"),
      riders(),
    ]);
    R.requested = requested.items;
    R.returned = returned.items;
    R.runs = runs.items;
  }

  function returnsPage() {
    if (!R.requested) return `<div class="page-heading"><div><p class="eyebrow">Network operations</p><h1>Returns (RTO)</h1><p class="subtitle">Loading returns…</p></div></div>`;
    const byMerchant = new Map();
    for (const r of R.requested) {
      const g = byMerchant.get(r.merchant.id) || { merchant: r.merchant, items: [] };
      g.items.push(r);
      byMerchant.set(r.merchant.id, g);
    }
    const groups = [...byMerchant.values()]
      .map(
        g => `<section class="panel" style="margin-bottom:14px"><div class="panel-heading"><div><h2 class="panel-title">${esc(g.merchant.name)}</h2><p class="panel-subtitle">${esc(g.merchant.code)} · ${g.items.length} parcel(s) to return</p></div><button class="button button-primary button-sm" data-rto-plan="${esc(g.merchant.id)}">Plan return run</button></div><div class="table-scroll"><table><thead><tr><th><input type="checkbox" data-rto-all="${esc(g.merchant.id)}" checked aria-label="Select all"></th><th>TRACKING</th><th>RECIPIENT</th><th>REASON</th><th>STATUS</th><th>HUB</th><th>REQUESTED</th></tr></thead><tbody>${g.items
          .map(r => `<tr><td><input type="checkbox" data-rto-pick="${esc(g.merchant.id)}" value="${esc(r.trackingId)}" checked></td><td><strong>${esc(r.trackingId)}</strong><div style="color:#8a94a3;font-size:12px">${esc(r.merchantOrderRef || "")}</div></td><td>${esc(r.recipientName)}<div style="color:#8a94a3;font-size:12px">${esc(r.deliveryZone)}, ${esc(r.deliveryDistrict)} · ${r.attemptCount} attempt(s)</div></td><td>${esc(r.reason || "—")}<div style="color:#8a94a3;font-size:12px">${esc(r.requestedBy || "")}</div></td><td>${pill(r.status.replaceAll("_", " ").toLowerCase().replace(/^./, c => c.toUpperCase()))}</td><td>${esc(r.hub?.name || "—")}</td><td>${esc(Ops.when(r.requestedAt))}</td></tr>`)
          .join("")}</tbody></table></div></section>`,
      )
      .join("");
    const runs = (R.runs || [])
      .map(run => {
        const actions =
          run.status === "PLANNED"
            ? `<button class="button button-sm" data-rto-dispatch="${esc(run.id)}">Dispatch</button> <button class="button button-sm" data-rto-cancel="${esc(run.id)}">Cancel</button>`
            : run.status === "OUT_FOR_RETURN"
              ? `<button class="button button-sm button-primary" data-rto-complete="${esc(run.id)}">Complete</button>`
              : "";
        return `<tr><td><strong>${esc(run.number)}</strong></td><td>${esc(run.merchant.name)}<div style="color:#8a94a3;font-size:12px">${esc(run.merchant.pickupAddress || "")}</div></td><td>${run.parcelCount}</td><td>${esc(riderName(run.riderId))}</td><td>${pill(RUN_STATUS[run.status] || run.status)}</td><td>${esc(Ops.when(run.createdAt))}</td><td style="white-space:nowrap"><button class="button button-sm" data-rto-view="${esc(run.id)}">View</button> <button class="button button-sm" data-rto-print="${esc(run.id)}" title="Return run sheet (PDF): parcels, reasons, return charges and signatures">Print</button> ${actions}</td></tr>`;
      })
      .join("");
    const returned = (R.returned || [])
      .map(r => `<tr><td><strong>${esc(r.trackingId)}</strong></td><td>${esc(r.merchant.name)}</td><td>${esc(r.run?.number || "—")}</td><td>${r.returnCharge != null ? Ops.money(r.returnCharge) : "—"}</td><td>${esc(Ops.when(r.updatedAt))}</td></tr>`)
      .join("");
    const metric = (label, value, foot) => `<div class="metric"><div class="metric-top"><span>${esc(label)}</span></div><strong>${esc(value)}</strong><div class="metric-foot"><span>${esc(foot)}</span></div></div>`;
    return `<div class="page-heading"><div><p class="eyebrow">Network operations</p><h1>Returns (RTO)</h1><p class="subtitle">Bring undeliverable parcels back to merchants in planned return runs. The return charge follows each parcel's rate card.</p></div><div class="heading-actions"><button class="button" data-rto-add>Add parcel by tracking ID</button><button class="button" data-rto-refresh>↻ Refresh</button></div></div>
      <div class="metrics">${metric("Return requests", Ops.num(R.requested.length), "waiting for a run")}${metric("Runs in progress", Ops.num((R.runs || []).filter(r => r.status === "PLANNED" || r.status === "OUT_FOR_RETURN").length), "planned or out")}${metric("Returned, unconfirmed", Ops.num(R.returned.length), "awaiting merchant receipt")}</div>
      ${groups || `<section class="panel" style="margin-bottom:14px"><p class="panel-subtitle" style="margin:0">No return requests waiting. Merchants request returns from their panel; you can also add a parcel by tracking ID.</p></section>`}
      <section class="panel table-panel" style="margin-bottom:14px"><div class="panel-heading"><div><h2 class="panel-title">Return runs</h2><p class="panel-subtitle">Latest 50</p></div></div><div class="table-scroll"><table><thead><tr><th>RUN</th><th>MERCHANT</th><th>PARCELS</th><th>RIDER</th><th>STATUS</th><th>CREATED</th><th></th></tr></thead><tbody>${runs || `<tr><td colspan="7" class="empty-state">No return runs yet.</td></tr>`}</tbody></table></div></section>
      <section class="panel table-panel"><div class="panel-heading"><div><h2 class="panel-title">Returned · awaiting merchant confirmation</h2></div></div><div class="table-scroll"><table><thead><tr><th>TRACKING</th><th>MERCHANT</th><th>RUN</th><th>RETURN CHARGE</th><th>RETURNED</th></tr></thead><tbody>${returned || `<tr><td colspan="5" class="empty-state">Nothing awaiting confirmation.</td></tr>`}</tbody></table></div></section>`;
  }

  // Dialogs: the console's standard Ops.form (bridge-network.js); errors stay inside the dialog.
  const riderChoices = () => (DF.state.riders || []).map(r => ({ value: r.id, label: `${r.code} · ${r.name || r.user?.name || ""}` }));
  const problemsError = error => (error?.details?.problems ? new Error(error.details.problems.map(p => `${p.trackingId}: ${p.message}`).join(" · ")) : error);

  function planRun(merchantId) {
    const picked = [...document.querySelectorAll(`[data-rto-pick="${CSS.escape(merchantId)}"]:checked`)].map(b => b.value);
    if (!picked.length) return toast("Choose at least one parcel.");
    if (!Ops.require("dispatch", "plan return runs")) return;
    const merchant = R.requested.find(r => r.merchant.id === merchantId)?.merchant;
    Ops.form({
      title: `Return run · ${merchant?.name || ""}`,
      description: `${picked.length} parcel(s) go to RETURN_SCHEDULED and the merchant is notified.`,
      submit: "Plan return run",
      fields: [
        { id: "parcels", label: "Parcels", type: "static", value: picked.join(", ") },
        { id: "riderId", domId: "rtoRider", label: "Rider (needed to dispatch)", type: "select", options: [{ value: "", label: "Choose a rider…" }, ...riderChoices()] },
        { id: "note", domId: "rtoNote", label: "Note", maxLength: 500 },
      ],
      onSubmit: async v => {
        const run = await DF.api("/returns/runs", { method: "POST", body: { merchantId, trackingIds: picked, riderId: v.riderId || undefined, note: v.note || undefined } }).catch(error => {
          throw problemsError(error);
        });
        await reloadReturns();
        return `${run.number} planned with ${run.parcelCount} parcel(s).`;
      },
    });
  }

  function addParcel() {
    if (!Ops.require("dispatch", "plan return runs")) return;
    Ops.form({
      title: "Return a parcel",
      description: "For parcels operations decide to return (e.g. delivery attempts exhausted). The merchant is notified.",
      submit: "Plan return run",
      fields: [
        { id: "trackingId", domId: "rtoAddId", label: "Tracking ID", required: true, placeholder: "PP-261016-XXXXX", maxLength: 40 },
        { id: "reason", domId: "rtoAddReason", label: "Reason", required: true, maxLength: 300, value: "Delivery attempts exhausted" },
      ],
      validate: { reason: v => (v.length < 3 ? "At least 3 characters" : "") },
      onSubmit: async v => {
        const id = v.trackingId.toUpperCase();
        const parcel = await DF.api(`/parcels/${encodeURIComponent(id)}`);
        if (!parcel.merchant?.id) throw new Error("Only merchant parcels are returned in runs. Use the parcel's status for customer parcels.");
        const run = await DF.api("/returns/runs", { method: "POST", body: { merchantId: parcel.merchant.id, trackingIds: [parcel.trackingId], reason: v.reason } }).catch(error => {
          throw problemsError(error);
        });
        await reloadReturns();
        return `${run.number} planned for ${parcel.trackingId}.`;
      },
    });
  }

  async function viewRun(id) {
    try {
      const run = await DF.api(`/returns/runs/${id}`);
      Ops.form({
        title: `${run.number} · ${run.merchant.name}`,
        description: `${RUN_STATUS[run.status] || run.status} · ${run.parcelCount} parcel(s) · return charges ${Ops.money(run.returnCharges)} · ${DF.addressText(run.merchant.pickupAddress, run.merchant.pickupArea)}`,
        submit: "Close",
        wide: true,
        fields: [
          {
            id: "parcels",
            label: "Parcels",
            type: "static",
            html: `<div class="table-scroll"><table><thead><tr><th>TRACKING</th><th>RECIPIENT</th><th>REASON</th><th>STATUS</th><th>CHARGE</th></tr></thead><tbody>${run.parcels.map(p => `<tr><td>${esc(p.trackingId)}</td><td>${esc(p.recipientName)}</td><td>${esc(p.reason || "")}</td><td>${pill(p.status.replaceAll("_", " ").toLowerCase())}</td><td>${p.returnCharge != null ? Ops.money(p.returnCharge) : "—"}</td></tr>`).join("")}</tbody></table></div>`,
          },
        ],
        onSubmit: async () => "",
      });
    } catch (error) {
      fail(error);
    }
  }

  function dispatchRun(id) {
    if (!Ops.require("dispatch", "update return runs")) return;
    const run = R.runs.find(r => r.id === id);
    Ops.form({
      title: `Dispatch ${run?.number || ""}`,
      description: "The rider takes the parcels back to the merchant.",
      submit: "Dispatch",
      fields: [{ id: "riderId", domId: "rtoDispatchRider", label: "Rider", type: "select", required: true, value: run?.riderId || "", options: [{ value: "", label: "Choose a rider…" }, ...riderChoices()] }],
      onSubmit: async v => {
        const done = await DF.api(`/returns/runs/${id}/dispatch`, { method: "POST", body: { riderId: v.riderId } });
        await reloadReturns();
        return `${done.number} is out for return.`;
      },
    });
  }

  function completeRun(id) {
    if (!Ops.require("dispatch", "update return runs")) return;
    const run = R.runs.find(r => r.id === id);
    Ops.form({
      title: `Complete ${run?.number || ""}`,
      description: "Parcels the merchant took back become RETURNED (the return charge is booked). Tick any that weren't taken back; they go back to the hub.",
      submit: "Complete run",
      fields: [
        { id: "list", domId: "rtoCompleteList", label: "Parcels not taken back", type: "static", html: `<span class="panel-subtitle">Loading…</span>` },
        { id: "note", domId: "rtoCompleteNote", label: "Note", maxLength: 500 },
      ],
      onSubmit: async v => {
        const notReturned = [...document.querySelectorAll('#modalFields input[name="rtoNotReturned"]:checked')].map(b => b.value);
        const done = await DF.api(`/returns/runs/${id}/complete`, { method: "POST", body: { notReturned, note: v.note || undefined } });
        await reloadReturns();
        return `${done.number} completed.`;
      },
    });
    DF.api(`/returns/runs/${id}`)
      .then(full => {
        const list = $("rtoCompleteList");
        if (list) list.innerHTML = full.parcels.map(p => `<label style="display:flex;gap:8px;align-items:center;margin:6px 0"><input type="checkbox" name="rtoNotReturned" value="${esc(p.trackingId)}"> ${esc(p.trackingId)} · ${esc(p.recipientName)} <small>(not taken back)</small></label>`).join("") || "No parcels.";
      })
      .catch(fail);
  }

  async function runAction(path, body, success) {
    if (!Ops.require("dispatch", "update return runs")) return;
    try {
      const run = await DF.api(`/returns/runs/${path}`, { method: "POST", body });
      await reloadReturns();
      toast(success(run));
    } catch (error) {
      fail(error);
    }
  }

  async function reloadReturns() {
    await loadReturns();
    if (Ops.page() === "Returns") render("Returns"); // eslint-disable-line no-undef -- the console's render()
  }

  // ───────────── scheduled pickups ─────────────

  // "upcoming" (the default): today and the next 30 days, so requests merchants make for later days show at once.
  const plusDays = n => new Date(Date.parse(`${dhakaToday()}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const dayLabel = d => (d === dhakaToday() ? "Today" : d === plusDays(1) ? "Tomorrow" : new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }));
  async function loadPickups() {
    const range = R.date === "upcoming" ? `from=${dhakaToday()}&to=${plusDays(30)}` : `date=${R.date}`;
    const [page] = await Promise.all([DF.api(`/pickup-requests?${range}&limit=200`), riders()]);
    R.pickups = page.items.sort((a, b) => Date.parse(a.windowStart) - Date.parse(b.windowStart));
  }

  function pickupsPage() {
    const days = [-1, 0, 1, 2, 3].map(n => new Date(Date.parse(`${dhakaToday()}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10));
    const rows = (R.pickups || [])
      .map(r => {
        const open = r.status === "REQUESTED" || r.status === "ASSIGNED";
        return `<tr><td><strong>${esc(r.number)}</strong><div style="color:#8a94a3;font-size:12px">${esc(r.schedule?.name || "One-off request")}</div></td><td>${esc(r.merchant.name || "")}<div style="color:#8a94a3;font-size:12px">${esc(r.merchant.code || "")}</div></td><td>${R.date === "upcoming" ? `<strong>${esc(dayLabel(r.date))}</strong><div style="color:#8a94a3;font-size:12px">` : ""}${esc(time(r.windowStart))} – ${esc(time(r.windowEnd))}${R.date === "upcoming" ? "</div>" : ""}</td><td>${esc(DF.addressText(r.street, r.area, r.zone, r.district))}<div style="color:#8a94a3;font-size:12px">${esc(r.contactName)} · ${esc(r.contactPhone)}${r.note ? ` · ${esc(r.note)}` : ""}</div></td><td>${r.expectedParcels}</td><td>${open ? `<select data-pu-rider="${esc(r.id)}" aria-label="Rider">${riderOptions(r.riderId || "")}</select>` : esc(riderName(r.riderId))}</td><td>${pill(PICKUP_STATUS[r.status] || r.status)}</td><td style="white-space:nowrap">${open ? `<button class="button button-sm button-primary" data-pu-complete="${esc(r.id)}">Collected</button> <button class="button button-sm" data-pu-missed="${esc(r.id)}">Missed</button>` : ""}</td></tr>`;
      })
      .join("");
    const count = s => (R.pickups || []).filter(r => r.status === s).length;
    return `<div class="page-heading"><div><p class="eyebrow">Network operations</p><h1>Scheduled pickups</h1><p class="subtitle">Merchant pickup visits from recurring schedules and one-off requests. Assign a rider before the window starts.</p></div><div class="heading-actions"><select id="puDate" class="select-small" aria-label="Day"><option value="upcoming"${R.date === "upcoming" ? " selected" : ""}>Today & upcoming</option>${days.map(d => `<option value="${d}"${d === R.date ? " selected" : ""}>${esc(dayLabel(d))}</option>`).join("")}</select><button class="button" data-pu-generate>Generate from schedules</button></div></div>
      <div class="metrics">${[["Requested", count("REQUESTED")], ["Rider assigned", count("ASSIGNED")], ["Collected", count("COMPLETED")]].map(([l, v]) => `<div class="metric"><div class="metric-top"><span>${l}</span></div><strong>${v}</strong><div class="metric-foot"><span>${esc(R.date === "upcoming" ? "Today & upcoming" : dayLabel(R.date))}</span></div></div>`).join("")}</div>
      <section class="panel table-panel"><div class="table-scroll"><table><thead><tr><th>PICKUP</th><th>MERCHANT</th><th>WINDOW</th><th>ADDRESS</th><th>PARCELS</th><th>RIDER</th><th>STATUS</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="8" class="empty-state">${R.pickups ? (R.date === "upcoming" ? "No pickups scheduled from today on." : "No pickups scheduled for this day.") : "Loading…"}</td></tr>`}</tbody></table></div></section>`;
  }

  async function pickupAction(id, path, body, success) {
    if (!Ops.require("dispatch", "update pickups")) return;
    try {
      await DF.api(`/pickup-requests/${id}/${path}`, { method: "POST", body });
      await reloadPickups();
      toast(success);
    } catch (error) {
      fail(error);
      await reloadPickups().catch(() => undefined);
    }
  }

  async function reloadPickups() {
    await loadPickups();
    if (Ops.page() === "Scheduled pickups") render("Scheduled pickups"); // eslint-disable-line no-undef
  }

  // ───────────── wiring ─────────────

  Ops.pages.Returns = { render: returnsPage };
  Ops.pages["Scheduled pickups"] = { render: pickupsPage };
  Ops.enhance.Returns = () => {
    if (!R.requested && !R.loading) {
      R.loading = true;
      void loadReturns()
        .then(() => Ops.page() === "Returns" && render("Returns"), fail) // eslint-disable-line no-undef
        .finally(() => (R.loading = false));
    }
  };
  Ops.enhance["Scheduled pickups"] = () => {
    if (!R.pickups && !R.loading) {
      R.loading = true;
      void loadPickups()
        .then(() => Ops.page() === "Scheduled pickups" && render("Scheduled pickups"), fail) // eslint-disable-line no-undef
        .finally(() => (R.loading = false));
    }
  };

  const stop = event => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  window.addEventListener(
    "click",
    event => {
      const t = event.target;
      if (!(t instanceof Element)) return;
      const hit = sel => t.closest(sel);
      let el;
      if (hit("[data-rto-refresh]")) return stop(event), void reloadReturns().then(() => toast("Returns refreshed."), fail);
      if (hit("[data-rto-add]")) return stop(event), addParcel();
      if ((el = hit("[data-rto-plan]"))) return stop(event), planRun(el.dataset.rtoPlan);
      if ((el = hit("[data-rto-view]"))) return stop(event), void viewRun(el.dataset.rtoView);
      if ((el = hit("[data-rto-print]"))) return stop(event), void Ops.printPdf(`/documents/return-run/${el.dataset.rtoPrint}`, { title: "Preparing the return run sheet…" });
      if ((el = hit("[data-rto-dispatch]"))) return stop(event), dispatchRun(el.dataset.rtoDispatch);
      if ((el = hit("[data-rto-complete]"))) return stop(event), completeRun(el.dataset.rtoComplete);
      if ((el = hit("[data-rto-cancel]"))) {
        stop(event);
        const runId = el.dataset.rtoCancel;
        return void Ops.confirm({ title: "Cancel this return run?", message: "Its parcels go back to the hub and keep their return request.", confirm: "Cancel run", cancel: "Keep it", danger: true }).then(ok => ok && runAction(`${runId}/cancel`, undefined, run => `${run.number} cancelled.`));
      }
      if (hit("[data-pu-generate]")) {
        stop(event);
        return void DF.api("/pickup-requests/generate", { method: "POST", body: R.date === "upcoming" ? {} : { date: R.date } })
          .then(async result => {
            await reloadPickups();
            toast(`${result.created} pickup(s) created from recurring schedules.`);
          })
          .catch(fail);
      }
      if ((el = hit("[data-pu-complete]"))) return stop(event), void pickupAction(el.dataset.puComplete, "complete", undefined, "Pickup marked as collected.");
      if ((el = hit("[data-pu-missed]"))) {
        stop(event);
        const pickupId = el.dataset.puMissed;
        return void Ops.prompt({ title: "Mark the pickup as missed", message: "The merchant is notified.", label: "Why was the pickup missed?", multiline: true, maxLength: 300, confirm: "Mark missed", placeholder: "e.g. Shop closed when the rider arrived" }).then(note => {
          if (note === null) return;
          pickupAction(pickupId, "missed", { note: note || undefined }, "Pickup marked as missed. The merchant was notified.");
        });
      }
    },
    true,
  );

  window.addEventListener(
    "change",
    event => {
      const t = event.target;
      if (t.matches?.("[data-rto-all]")) {
        for (const box of document.querySelectorAll(`[data-rto-pick="${CSS.escape(t.dataset.rtoAll)}"]`)) box.checked = t.checked;
        return;
      }
      if (t.id === "puDate") {
        R.date = t.value;
        R.pickups = null;
        return void reloadPickups().catch(fail);
      }
      if (t.matches?.("[data-pu-rider]") && t.value) {
        event.stopImmediatePropagation();
        return void pickupAction(t.dataset.puRider, "assign", { riderId: t.value }, "Rider assigned to the pickup.");
      }
    },
    true,
  );

  DF.live(["parcel.updated", "return_run.updated", "pickup_request.updated"], async () => {
    const page = Ops.page();
    if (page === "Returns") await reloadReturns();
    else R.requested = null;
    if (page === "Scheduled pickups") await reloadPickups();
    else R.pickups = null;
  });
})();
