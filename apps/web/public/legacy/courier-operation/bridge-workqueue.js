/*
 * Courier Operations → Work queue (GET/POST /work-queue…, apps/api/src/modules/work-queue):
 * every parcel's next step, worked out by the system (pickups to assign, drop-offs and pickups to
 * receive, transfers to dispatch and to receive, deliveries to assign, ready to go out…), each with
 * its count. A step opens into its groups (route "Dhaka Hub → Barishal Hub", area, rider, hub) with
 * counts; a group shows its parcels on the right, exports them to Excel and has a scan box that does
 * the step one parcel at a time (through the same services as everywhere else). Counts follow live
 * parcel events. Parcels missing delivery details have their own count at the top right.
 * Only this menu's page: no other page changes.
 */
(() => {
  const DF = window.DF;
  const Ops = window.DFOps;
  if (!DF || !Ops) return;
  const PAGE = "Work queue";
  const $ = id => document.getElementById(id);
  const esc = Ops.esc;
  const ui = Ops.ui;
  const onPage = () => Ops.page() === PAGE;
  const STAGES = ["Pickup", "Hub", "Transfer", "Delivery", "Problems"];
  const STAGE_LABEL = { Pickup: "Pickup", Hub: "Receive at hub", Transfer: "Between hubs", Delivery: "Delivery", Problems: "Returns & problems" };
  const ASSIGN = new Set(["ASSIGN_PICKUP", "ASSIGN_DELIVERY"]);
  /** Hub staff with one hub always receive at it: no hub to choose. */
  const ownHub = () => (Ops.myHubs()?.length === 1 ? Ops.myHubs()[0] : null);

  const state = {
    hubId: "",
    overview: null,
    error: "",
    open: null, // the expanded step
    groups: {}, // step key → { groups, total, truncated } | { error }
    sel: null, // { task, group } shown on the right
    list: null,
    listError: "",
    riderId: {}, // per step
    receiveHubId: "",
    log: [],
    queue: Promise.resolve(),
  };

  const qs = extra => {
    const p = new URLSearchParams();
    if (state.hubId) p.set("hubId", state.hubId);
    for (const [k, v] of Object.entries(extra || {})) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : "";
  };
  const taskOf = key => (key === state.overview?.missingDetails?.key ? { ...state.overview.missingDetails, stage: "Problems", action: null } : state.overview?.tasks.find(t => t.key === key)) || null;

  // ───────────── loading ─────────────

  async function loadOverview() {
    try {
      state.overview = await DF.api(`/work-queue${qs()}`);
      state.error = "";
    } catch (error) {
      state.error = DF.describe(error);
    }
    paint();
  }
  async function loadGroups(key) {
    try {
      state.groups[key] = await DF.api(`/work-queue/${key}${qs()}`);
    } catch (error) {
      state.groups[key] = { error: DF.describe(error) };
    }
    paint();
  }
  async function loadList() {
    const sel = state.sel;
    if (!sel) return;
    try {
      const list = await DF.api(`/work-queue/${sel.task}/parcels${qs({ group: sel.group })}`);
      if (state.sel === sel) {
        state.list = list;
        state.listError = "";
      }
    } catch (error) {
      if (state.sel === sel) state.listError = DF.describe(error);
    }
    paint();
  }
  /** After a scan or a live event: counts, the open step's groups, the list on screen. */
  const refresh = ui.debounce(() => {
    if (!onPage()) return;
    void loadOverview();
    if (state.open) void loadGroups(state.open);
    if (state.sel && state.sel.task !== state.open) void loadGroups(state.sel.task);
    void loadList();
  }, 700);

  function select(task, group) {
    if (state.sel?.task !== task || state.sel.group !== (group || "")) state.receiveHubId = ""; // each list receives at its own expected hub unless chosen
    state.sel = { task, group: group || "" };
    state.list = null;
    state.listError = "";
    state.log = [];
    if (!state.groups[task]) void loadGroups(task);
    void loadList();
    paint();
    setTimeout(() => $("wqScan")?.focus(), 30);
  }

  // ───────────── scanning ─────────────

  function scan(code, source = "KEYBOARD") {
    const sel = state.sel;
    const task = sel && taskOf(sel.task);
    code = DF.scanner?.normalize ? DF.scanner.normalize(code) : String(code || "").trim().toUpperCase();
    if (!task?.action || !code) return;
    const riderId = state.riderId[task.key] || "";
    if (ASSIGN.has(task.action) && !riderId) {
      state.log.unshift({ ok: false, message: "Choose the rider first, then scan.", at: new Date() });
      paint();
      return;
    }
    state.queue = state.queue.then(async () => {
      let r;
      try {
        r = await DF.api(`/work-queue/${task.key}/scan`, {
          method: "POST",
          body: { code, source, group: sel.group || undefined, riderId: ASSIGN.has(task.action) ? riderId : undefined, hubId: task.action === "RECEIVE" ? ownHub()?.id || state.receiveHubId || undefined : undefined },
        });
      } catch (error) {
        r = { ok: false, message: DF.describe(error) };
      }
      DF.scanner?.feedback?.("wqScan", r.ok, r.message);
      state.log.unshift({ ok: r.ok, message: r.message, at: new Date() });
      state.log = state.log.slice(0, 50);
      if (r.ok && state.list) {
        // Done: it leaves this list at once (the counts follow from the server).
        state.list.items = state.list.items.filter(p => p.trackingId !== r.parcel?.trackingId);
        state.list.total = Math.max(0, state.list.total - 1);
      }
      paint();
      refresh();
    });
  }

  // ───────────── drawing ─────────────

  const STYLE = `<style id="wqStyle">
    .wq-layout{display:grid;grid-template-columns:minmax(280px,380px) minmax(0,1fr);gap:16px;align-items:start}
    .wq-steps{padding:6px 0}
    .wq-stage{padding:12px 16px 4px;color:#98a2ae;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
    .wq-step{display:flex;align-items:center;gap:10px;width:100%;border:0;background:none;padding:10px 16px;text-align:left;cursor:pointer;color:inherit;font:inherit}
    .wq-step:hover{background:#f6f8fb}
    .wq-step[aria-expanded="true"]{background:#f3f6fd}
    .wq-step .wq-name{flex:1;min-width:0}
    .wq-step .wq-name strong{display:block;font-size:13.5px;font-weight:650}
    .wq-step .wq-name small{display:block;color:#8a94a3;font-size:12px;margin-top:2px;line-height:1.35}
    .wq-count{min-width:30px;padding:2px 8px;border-radius:999px;background:#eef1f5;color:#475467;font-size:12px;font-weight:700;text-align:center}
    .wq-count.hot{background:#fff1d6;color:#a8650b}
    .wq-chev{color:#a0a9b6;transition:transform .15s}
    .wq-step[aria-expanded="true"] .wq-chev{transform:rotate(90deg)}
    .wq-groups{padding:2px 12px 10px 28px;display:grid;gap:2px}
    .wq-group{display:flex;align-items:center;gap:8px;width:100%;border:0;background:none;border-radius:8px;padding:7px 10px;text-align:left;cursor:pointer;font:inherit;color:#344054;font-size:13px}
    .wq-group:hover{background:#f1f4f9}
    .wq-group[aria-current="true"]{background:#e8efff;color:#2f59cf;font-weight:650}
    .wq-group span:first-child{flex:1;min-width:0;overflow-wrap:anywhere}
    .wq-muted{color:#8a94a3;font-size:12.5px;padding:6px 10px}
    .wq-missing{display:inline-flex;align-items:center;gap:8px;border:1px solid #f4cdca;background:#fff5f4;color:#b42318;border-radius:10px;padding:7px 12px;font-weight:650;cursor:pointer;font:inherit;font-size:13px}
    .wq-missing b{background:#b42318;color:#fff;border-radius:999px;padding:1px 8px;font-size:12px}
    .wq-missing[aria-current="true"]{outline:2px solid #f4cdca}
    .wq-scan{display:flex;gap:10px;flex-wrap:wrap;align-items:end;padding:12px 16px;border-bottom:1px solid var(--line,#e9edf2);background:#fafbfd}
    .wq-scan label{display:grid;gap:4px;font-size:12px;color:#667085;font-weight:600}
    .wq-scan input,.wq-scan select{height:38px;min-width:200px}
    .wq-scan .wq-code{flex:1;min-width:240px}
    .wq-scan .wq-code input{width:100%;font-size:15px;font-weight:600;letter-spacing:.02em}
    .wq-log{list-style:none;margin:0;padding:8px 16px;display:grid;gap:4px;max-height:160px;overflow:auto;border-bottom:1px solid var(--line,#e9edf2)}
    .wq-log li{font-size:12.5px;padding:5px 9px;border-radius:7px;background:#effaf5;color:#0f5c3f}
    .wq-log li.bad{background:#fff3ee;color:#9a3412}
    .wq-log time{color:#8a94a3;margin-right:6px}
    .wq-empty{padding:40px 20px;text-align:center;color:#8a94a3}
    @media (max-width:980px){.wq-layout{grid-template-columns:minmax(0,1fr)}.wq-scan input,.wq-scan select{min-width:0;width:100%}.wq-scan label{width:100%}}
  </style>`;

  Ops.pages[PAGE] = {
    render: () =>
      `${STYLE}<div class="page-heading"><div><p class="eyebrow">Network operations · next steps</p><h1>Parcel queue</h1><p class="subtitle">Every parcel's next step, worked out by the system. Open a step, choose a group, then scan parcels to do it.</p></div><div class="heading-actions" id="wqActions"></div></div><div class="wq-layout"><section class="panel wq-steps" id="wqSteps" aria-label="Next steps"></section><div id="wqDetail"></div></div>`,
  };
  // Every time the page is drawn (e.g. back from another page, where live events are skipped): reload the
  // counts, the open step and the list, keeping the last ones on screen until the new ones arrive.
  Ops.enhance[PAGE] = () => {
    paint();
    if (!state.overview) void loadOverview();
    else refresh();
  };

  function paint() {
    if (!onPage() || !$("wqSteps")) return;
    // Counts refresh in the background while people scan: keep what is being typed in the scan box.
    const typed = $("wqScan")?.value || "";
    ui.keepFocus(repaint);
    const input = $("wqScan");
    if (input && typed && !input.value) input.value = typed;
  }

  function repaint() {
    const o = state.overview;
    const hubs = Ops.myHubs() || DF.state.hubs || [];
    const missing = o?.missingDetails;
    $("wqActions").innerHTML = `${ui.select("wqHub", ui.hubOptions(hubs, Ops.myHubs() ? (hubs.length > 1 ? "All my hubs" : undefined) : "Whole network"), state.hubId, 'aria-label="Hub" style="height:38px"')}${
      missing ? `<button type="button" class="wq-missing" id="wqMissing" data-wq-select="${esc(missing.key)}" aria-current="${state.sel?.task === missing.key}" title="${esc(missing.hint)}">${esc(missing.label)} <b>${Ops.num(missing.count)}</b></button>` : ""
    }<button type="button" class="button" id="wqRefresh">Refresh</button>`;

    // Left: the steps, by stage, each with its count; the open one lists its groups.
    let steps = "";
    if (state.error) steps = `<p class="wq-muted" style="padding:16px">${esc(state.error)}</p>`;
    else if (!o) steps = `<p class="wq-muted" style="padding:16px">Loading the work queue…</p>`;
    else
      for (const stage of STAGES) {
        const tasks = o.tasks.filter(t => t.stage === stage);
        if (!tasks.length) continue;
        steps += `<div class="wq-stage">${esc(STAGE_LABEL[stage])}</div>`;
        for (const t of tasks) {
          const open = state.open === t.key;
          steps += `<button type="button" class="wq-step" data-wq-task="${esc(t.key)}" aria-expanded="${open}"><svg class="wq-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg><span class="wq-name"><strong>${esc(t.label)}</strong><small>${esc(t.hint)}</small></span><span class="wq-count${t.count ? " hot" : ""}">${Ops.num(t.count)}</span></button>`;
          if (open) steps += `<div class="wq-groups" data-wq-groups="${esc(t.key)}">${groupsMarkup(t)}</div>`;
        }
      }
    $("wqSteps").innerHTML = steps;
    $("wqDetail").innerHTML = detailMarkup();

    const input = $("wqScan");
    if (input && DF.scanner && !input.dataset.dfScanner) DF.scanner.attach(input, { title: "Scan parcels", label: "Camera", continuous: true, onScan: code => ((input.value = ""), scan(code, "CAMERA")) });
  }

  function groupsMarkup(t) {
    const g = state.groups[t.key];
    if (!g) return `<p class="wq-muted">Loading…</p>`;
    if (g.error) return `<p class="wq-muted">${esc(g.error)}</p>`;
    if (!g.groups.length) return `<p class="wq-muted">Nothing waiting.</p>`;
    const current = key => state.sel?.task === t.key && state.sel.group === key;
    return [
      `<button type="button" class="wq-group" data-wq-select="${esc(t.key)}" data-wq-group="" aria-current="${current("")}"><span>All</span><span class="wq-count">${Ops.num(g.total)}</span></button>`,
      ...g.groups.map(x => `<button type="button" class="wq-group" data-wq-select="${esc(t.key)}" data-wq-group="${esc(x.key)}" aria-current="${current(x.key)}"><span>${esc(x.label)}</span><span class="wq-count">${Ops.num(x.count)}</span></button>`),
      g.truncated ? `<p class="wq-muted">Showing the first 10,000 parcels.</p>` : "",
    ].join("");
  }

  function detailMarkup() {
    const sel = state.sel;
    const task = sel && taskOf(sel.task);
    if (!task) return `<section class="panel"><div class="wq-empty"><strong style="display:block;color:#344054;margin-bottom:4px">Choose a step on the left</strong>Open it to see its groups, then choose a group to list, export and scan its parcels.</div></section>`;
    const g = state.groups[task.key];
    const groupOptions = [{ value: "", label: `All (${Ops.num(g?.total ?? task.count ?? 0)})` }, ...(g?.groups || []).map(x => ({ value: x.key, label: `${x.label} (${Ops.num(x.count)})` }))];
    const group = g?.groups?.find(x => x.key === sel.group);
    const l = state.list;
    const title = `${task.label}${group ? ` · ${group.label}` : ""}`;
    const tools = `${ui.select("wqGroup", groupOptions, sel.group, 'aria-label="Group" style="height:32px;max-width:280px"')}<button class="button button-sm" type="button" id="wqExport" ${l?.total ? "" : "disabled"}>Excel</button>`;

    let scanBox = "";
    if (task.action && Ops.can("dispatch")) {
      let extra = "";
      if (ASSIGN.has(task.action)) {
        const riders = (DF.state.riders || []).filter(r => r.active !== false);
        const options = [{ value: "", label: "— Choose the rider —" }, ...riders.map(r => ({ value: r.id, label: `${r.label || `${r.code} · ${r.name}`}${r.hub?.name ? ` · ${r.hub.name}` : ""}` }))];
        extra = `<label>Rider${ui.select("wqRider", options, state.riderId[task.key] || "")}</label>`;
      } else if (task.action === "RECEIVE" && !ownHub()) {
        // Optional: by default each parcel is received at its expected hub (rider's hub, drop-off hub, transfer destination).
        const hubs = Ops.myHubs() || DF.state.hubs || [];
        extra = `<label>Receiving hub (optional)${ui.select("wqReceiveHub", ui.hubOptions(hubs, "Its expected hub"), state.receiveHubId)}</label>`;
      }
      const action = task.action === "RECEIVE" && ownHub() ? `Receive at ${ownHub().name}` : task.actionLabel || "Do this step";
      scanBox = `<div class="wq-scan">${extra}<label class="wq-code">Scan or type a tracking ID · ${esc(action)}<input id="wqScan" type="text" autocomplete="off" spellcheck="false" placeholder="PP-… or CN" aria-label="Scan a parcel"></label></div>${
        state.log.length ? `<ul class="wq-log" id="wqLog">${state.log.map(e => `<li class="${e.ok ? "" : "bad"}"><time>${esc(e.at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" }))}</time>${esc(e.message)}</li>`).join("")}</ul>` : ""
      }`;
    } else if (!task.action) {
      scanBox = `<p class="wq-muted" style="padding:10px 16px;border-bottom:1px solid var(--line,#e9edf2)">${esc(task.hint)}</p>`;
    }

    const transfer = task.key.startsWith("transfer-");
    const cols = ["Tracking ID", "Status", "Merchant / sender", "Recipient", transfer ? "From → to" : "Delivery area", task.key.startsWith("pickup") || task.key.startsWith("delivery") || task.key === "failed-receive" ? "Rider" : "Hub", "Waiting since"];
    const rows = (l?.items || [])
      .map(
        p =>
          `<tr data-wq-parcel="${esc(p.trackingId)}"><td><a href="#" data-wq-open="${esc(p.trackingId)}"><strong>${esc(p.trackingId)}</strong></a></td><td>${ui.pill(p.statusLabel)}</td><td>${esc(p.merchant || "—")}</td><td>${esc(p.recipient || "—")}${p.missing?.length ? `<span class="subcell" style="color:#b42318">Missing: ${esc(p.missing.join(", "))}</span>` : p.recipientPhone ? `<span class="subcell">${esc(DF.localPhone ? DF.localPhone(p.recipientPhone) : p.recipientPhone)}</span>` : ""}</td><td>${esc(transfer ? `${p.fromHub || "—"} → ${p.toHub || "No serving hub"}` : p.destination || "—")}</td><td>${esc((cols[5] === "Rider" ? p.rider : p.currentHub) || "—")}</td><td>${esc(Ops.when(p.waitingSince))}</td></tr>`,
      )
      .join("");
    const empty = state.listError || (l ? "Nothing waiting here." : "Loading…");
    const footer = l && l.total > l.items.length ? ui.footer(`Showing ${Ops.num(l.items.length)} of ${Ops.num(l.total)}. The Excel file has them all.`) : "";
    return `<section class="panel table-panel" id="wqList" data-wq-task="${esc(task.key)}"><div class="panel-heading"><div><h2 class="panel-title">${esc(title)}</h2><p class="panel-subtitle" id="wqTotal">${l ? `${Ops.num(l.total)} parcel${l.total === 1 ? "" : "s"}` : "Loading…"}</p></div><div class="table-tools">${tools}</div></div>${scanBox}${ui.table(cols, rows, empty)}${footer}</section>`;
  }

  // ───────────── events ─────────────

  window.addEventListener(
    "click",
    event => {
      if (!onPage() || !(event.target instanceof Element)) return;
      const t = event.target;
      let el;
      if ((el = t.closest("[data-wq-task]")) && el.classList.contains("wq-step")) {
        const key = el.dataset.wqTask;
        state.open = state.open === key ? null : key;
        if (state.open) void loadGroups(key);
        paint();
        return;
      }
      if ((el = t.closest("[data-wq-select]"))) return select(el.dataset.wqSelect, el.dataset.wqGroup || "");
      if ((el = t.closest("[data-wq-open]"))) {
        event.preventDefault();
        return void Ops.openParcel?.(el.dataset.wqOpen);
      }
      if (t.closest("#wqExport") && state.sel) return void DF.download(`/work-queue/${state.sel.task}/export${qs({ group: state.sel.group })}`, "work-queue.xlsx").catch(error => showToast(DF.describe(error)));
      if (t.closest("#wqRefresh")) {
        state.groups = {};
        if (state.open) void loadGroups(state.open);
        if (state.sel) void loadGroups(state.sel.task);
        void loadOverview();
        void loadList();
      }
    },
    true,
  );
  document.addEventListener("change", event => {
    if (!onPage() || !(event.target instanceof Element)) return;
    const t = event.target;
    if (t.id === "wqHub") {
      state.hubId = t.value;
      state.groups = {};
      state.overview = null;
      void loadOverview();
      if (state.open) void loadGroups(state.open);
      if (state.sel) void loadGroups(state.sel.task), void loadList();
      paint();
    }
    if (t.id === "wqGroup" && state.sel) select(state.sel.task, t.value);
    if (t.id === "wqRider" && state.sel) state.riderId[state.sel.task] = t.value;
    if (t.id === "wqReceiveHub") state.receiveHubId = t.value;
  });
  document.addEventListener("keydown", event => {
    if (!onPage() || event.key !== "Enter" || !(event.target instanceof HTMLInputElement) || event.target.id !== "wqScan") return;
    event.preventDefault();
    const code = event.target.value;
    event.target.value = "";
    scan(code, "KEYBOARD");
  });

  // Menu › Work queue: how many parcels wait in all its steps (your hub; the network for operations managers).
  let navTimer = null;
  async function paintNavCount() {
    const badge = document.querySelector('#navigation [data-stage-count="Work queue"]');
    if (!badge || !Ops.me) return;
    try {
      const overview = await DF.api("/work-queue");
      const total = (overview.tasks || []).reduce((n, t) => n + (t.count || 0), 0);
      badge.textContent = Ops.num(total);
      badge.title = `${total} parcel${total === 1 ? "" : "s"} waiting in the Parcel queue`;
    } catch {
      // No access or offline: leave it as it is.
    }
  }
  const navCountSoon = () => {
    clearTimeout(navTimer);
    navTimer = setTimeout(() => void paintNavCount(), 3000);
  };
  let navTries = 0;
  const navWhenReady = () => (Ops.me ? void paintNavCount() : ++navTries < 60 && setTimeout(navWhenReady, 500));
  navWhenReady();

  // Live: parcel changes anywhere move the counts.
  DF.live?.(["parcel.updated", "parcel.created", "linehaul.updated", "return_run.updated"], () => (refresh(), navCountSoon()), { debounceMs: 1500 });
})();
