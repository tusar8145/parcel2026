/*
 * Courier Operations on the API, part 3: network configuration and shared UI helpers.
 *
 *   Add rider (Riders page)              POST /riders (rider:manage)
 *   Suggest riders (Pickup / Delivery)   GET /routing/suggestions → POST /routing/suggestions/accept
 *   Hubs & zones: network configuration  /zones, /routes, PATCH /hubs/:id (capacity: bridge-hubs.js register)
 *
 * Ops.ui / Ops.dialog / Ops.recordScan / Ops.printPdf are shared with the other bridge-*.js files.
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
  Ops.dialog = (kind, { title, description = "", submit = "Save", fields, wide = false, context = {}, noValidate = false }) => {
    modalContext = { kind, ...context };
    // Ops.form validates inline itself (DF.validate.field); other dialogs keep the browser's checks.
    $("modalForm").noValidate = noValidate;
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
    $("modalForm").noValidate = false;
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

  /** Small confirm / text prompt (shared/api.js DF.confirm / DF.prompt; the same dialog in every panel). */
  Ops.confirm = options => DF.confirm(options);
  Ops.prompt = options => DF.prompt(options);

  /**
   * A form on the console's modal (replaces prompt() chains): labelled fields, inline validation
   * (DF.validate.field), an optional review step (money), and the result or error inside the dialog.
   *
   *   Ops.form({ title, description, submit, wide,
   *     fields: [{ id, label, type: text|number|date|month|select|search-select|textarea|static,
   *                value, options: [{value,label}], required, placeholder, hint, full, min, max, step, maxLength,
   *                show: values => bool }],
   *     validate: { id: (value, values) => message|"" },
   *     review: values => [[label, text], …] | null,   // shown before onSubmit with a "Confirm" button
   *     confirm: "Confirm payout",
   *     onSubmit: async values => "success toast" })   // throw to keep the dialog open with the error
   * Field ids are prefixed `of_` in the DOM (`#of_reference`).
   */
  let formSeq = 0;
  Ops.form = config => {
    const kind = `opsForm${++formSeq}`;
    const fid = id => config.fields.find(f => f.id === id)?.domId || `of_${id}`;
    const fieldHtml = f => {
      const id = fid(f.id);
      const req = f.required ? "required" : "";
      const ph = f.placeholder ? `placeholder="${esc(f.placeholder)}"` : "";
      const common = `id="${id}" name="${esc(f.id)}" ${req} ${ph} ${f.maxLength ? `maxlength="${f.maxLength}"` : ""}`;
      let control;
      if (f.type === "static") control = `<div id="${id}" style="padding:9px 0;color:#344054">${f.html ?? esc(f.value ?? "")}</div>`;
      else if (f.type === "select") control = ui.select(id, f.options || [], f.value, `name="${esc(f.id)}" ${req}`);
      else if (f.type === "search-select")
        control = `<input id="${id}_q" type="search" placeholder="${esc(f.placeholder || "Type to search…")}" autocomplete="off" aria-label="Search ${esc(f.label)}" style="margin-bottom:6px">${ui.select(id, [{ value: "", label: f.emptyLabel || "— Choose —" }, ...(f.options || [])], f.value, `name="${esc(f.id)}" size="6" ${req} style="height:auto"`)}`;
      else if (f.type === "textarea") control = `<textarea ${common} rows="${f.rows || 3}">${esc(f.value ?? "")}</textarea>`;
      else control = `<input ${common} type="${f.type || "text"}" value="${esc(f.value ?? "")}" ${f.min != null ? `min="${f.min}"` : ""} ${f.max != null ? `max="${f.max}"` : ""} ${f.step != null ? `step="${f.step}"` : ""} ${f.type === "number" ? 'inputmode="decimal"' : ""}>`;
      const label = `${f.label}${f.required || f.type === "static" ? "" : " (optional)"}`;
      return `<div class="field${f.full || f.type === "textarea" || f.type === "search-select" || f.type === "static" ? " full" : ""}" data-of-field="${esc(f.id)}"><label for="${id}">${esc(label)}</label>${control}${f.hint ? `<small style="display:block;margin-top:4px;color:#7b8594;font-size:12px">${esc(f.hint)}</small>` : ""}</div>`;
    };
    const errorBox = `<div class="field full" id="opsFormError" role="alert" style="display:none;padding:10px 12px;border-radius:9px;background:#fef3f2;color:#b42318;font-size:13px"></div>`;
    let step = "edit";
    let values = {};
    let checks = [];
    const read = () => {
      const out = {};
      for (const f of config.fields) {
        if (f.type === "static") continue;
        const el = $(fid(f.id));
        out[f.id] = el ? String(el.value ?? "").trim() : "";
      }
      return out;
    };
    const applyShow = () => {
      const now = read();
      for (const f of config.fields)
        if (f.show) {
          const box = q(`[data-of-field="${f.id}"]`);
          if (box) box.style.display = f.show(now) ? "" : "none";
        }
    };
    const showError = message => {
      const box = $("opsFormError");
      if (!box) return void showToast(message);
      box.textContent = message;
      box.style.display = message ? "" : "none";
    };
    const drawEdit = () => {
      step = "edit";
      Ops.dialog(kind, { title: config.title, description: config.description || "", submit: config.review ? config.submit || config.next || "Review" : config.submit || "Save", wide: !!config.wide, noValidate: true, fields: config.fields.map(fieldHtml).join("") + errorBox });
      for (const f of config.fields) {
        if (f.type === "static") continue;
        const el = $(fid(f.id));
        if (!el) continue;
        if (values[f.id] !== undefined && f.type !== "search-select") el.value = values[f.id];
        if (f.type === "search-select") {
          if (values[f.id]) el.value = values[f.id];
          const search = $(`${fid(f.id)}_q`);
          search?.addEventListener("input", () => {
            const term = search.value.trim().toLowerCase();
            let first = null;
            for (const option of el.options) {
              if (!option.value) continue;
              const hit = !term || option.textContent.toLowerCase().includes(term);
              option.hidden = !hit;
              if (hit && !first) first = option;
            }
            if (term && first && (el.selectedOptions[0]?.hidden || !el.value)) el.value = first.value;
            el.dispatchEvent(new Event("input", { bubbles: true }));
          });
        }
        el.addEventListener("change", applyShow);
        el.addEventListener("input", applyShow);
      }
      checks = config.fields
        .filter(f => f.type !== "static" && $(fid(f.id)))
        .map(f => {
          const el = $(fid(f.id));
          if (f.type === "phone") {
            // +880 prefix and its own inline message (shared/api.js DF.phoneInput).
            DF.phoneInput(el);
            return { f, check: () => (el.dispatchEvent(new Event("blur")), !DF.phoneProblem(el.value)) };
          }
          return { f, check: DF.validate.field(el, () => {
            if (f.show && !f.show(read())) return "";
            if (f.required && !el.value.trim()) return f.type === "select" || f.type === "search-select" ? "Choose one" : "This field is required";
            return config.validate?.[f.id]?.(el.value.trim(), read()) || "";
          }) };
        });
      applyShow();
      (config.fields.find(f => f.type === "search-select") ? $(`${fid(config.fields.find(f => f.type === "search-select").id)}_q`) : null)?.focus();
    };
    const drawReview = rows => {
      step = "review";
      $("modalTitle").textContent = config.reviewTitle || `Review · ${config.title}`;
      $("modalDescription").textContent = config.reviewNote || "Check the details before you confirm. This is recorded in the audit log.";
      $("modalSubmit").textContent = config.confirm || "Confirm";
      $("modalFields").innerHTML = `<div class="field full" id="opsFormReview"><table style="width:100%;border-collapse:collapse">${rows
        .map(([label, text]) => `<tr><th style="text-align:left;padding:7px 10px 7px 0;color:#667085;font-weight:600;width:42%;border-bottom:1px solid var(--line,#eef1f4)">${esc(label)}</th><td style="padding:7px 0;border-bottom:1px solid var(--line,#eef1f4);font-weight:600">${esc(text)}</td></tr>`)
        .join("")}</table><button type="button" class="button button-sm" id="opsFormBack" style="margin-top:12px">← Back to edit</button></div>${errorBox}`;
      $("opsFormBack").addEventListener("click", drawEdit);
      $("modalSubmit").focus();
    };
    const run = async () => {
      try {
        const message = await config.onSubmit(values);
        closeModal();
        if (message) showToast(message);
      } catch (error) {
        if (error === null) throw null;
        showError(error instanceof DF.ApiError ? DF.describe(error) : error?.message || "Something went wrong.");
        throw null;
      }
    };
    Ops.submitters[kind] = async () => {
      if (step === "review") return run();
      const results = checks.map(({ check }) => check(true));
      if (!results.every(Boolean)) {
        q("#modalFields [aria-invalid=true]")?.focus();
        throw null;
      }
      values = read();
      for (const f of config.fields) if (f.show && !f.show(values)) delete values[f.id];
      showError("");
      const rows = config.review?.(values);
      if (rows && rows.length) return drawReview(rows);
      return run();
    };
    drawEdit();
  };

  /** Merchant choices for Ops.form search-selects (active merchants, "CODE · Name"). */
  Ops.merchantOptions = async () => {
    const merchants = (await DF.api("/ops/merchants").catch(() => [])).filter(m => m.status === "ACTIVE");
    return merchants.map(m => ({ value: m.id, label: `${m.code} · ${m.name}`, merchant: m }));
  };

  /** Fire-and-forget scan event for scan compliance. */
  Ops.recordScan = (code, kind, hubId, source = "KEYBOARD", ok = true, message) => {
    if (!code || String(code).trim().length < 3) return;
    DF.api("/scans", { method: "POST", body: { code: String(code).trim(), kind, hubId: hubId || undefined, source, ok, message } }).catch(() => undefined);
  };

  /** Printing: the API generates the PDF (GET /documents/…) and it opens in a new tab (shared/print.js). */
  Ops.printPdf = (path, options) => window.DFPrint.open(path, options);


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
    // (The Settings card list has the Two-step verification button, bridge-pages.js.)
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

  // ───────────── Suggest riders (assignment suggestions; the original "Create dispatch") ─────────────

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
    if (!Ops.require("dispatch", "assign riders")) return;
    const hubs = Ops.myHubs() || DF.state.hubs;
    Ops.dialog("dispatch", {
      title: "Suggest riders",
      description: "Suggested riders for every shipment waiting at the hub.",
      submit: "Assign selected",
      wide: true,
      fields:
        ui.field("dispatchHub", "Hub", ui.select("dispatchHub", ui.hubOptions(hubs, Ops.myHubs() ? undefined : "All hubs"), Ops.myHubs()?.[0]?.id)) +
        ui.field("dispatchKind", "Shipments", ui.select("dispatchKind", [{ value: "delivery", label: "Deliveries waiting at the hub" }, { value: "pickup", label: "Pickup requests" }, { value: "all", label: "Deliveries and pickups" }], Ops.tabMode === "pickup" ? "pickup" : "delivery")) +
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
    if (Ops.can("dispatch")) headingButton("dispatch", "Suggest riders", "route", false);
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
    if (Ops.hubPart !== "manage") return; // Hub desk tabs don't show the network configuration
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
    const zones = Ops.cache.zones?.value?.items || [];
    const routes = Ops.cache.routes?.value?.items || [];
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
    return `<div id="networkConfig">${ui.panel("Delivery zones", "Catalog areas → zone → hub · used by assignment suggestions, SLA and maps", zoneFilterBar(zones.length) + ui.table(["Zone", "Areas", "Hub", "Route", "Map centre", "Status", ""], zoneRows, Ops.cache.zones ? "No zones configured yet." : "Loading zones…"), add("zone", "Add zone"))}${ui.panel("Operating routes", "Zones a hub serves together, with a default rider for assignment suggestions", ui.table(["Route", "Hub", "Default rider", "Zones", "Note", "Status", ""], routeRows, Ops.cache.routes ? "No routes configured yet." : "Loading routes…"), add("route", "Add route"))}</div>`;
  }

  const baseHubs = Ops.enhance.Hubs;
  Ops.enhance.Hubs = page => {
    baseHubs?.(page);
    $("networkConfig")?.remove();
    if (Ops.hubPart === "manage") $("mainContent").insertAdjacentHTML("beforeend", configPanels());
  };

  // Zone dialog (add, or edit).
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

  window.addEventListener(
    "click",
    event => {
      const add = event.target.closest("[data-config-add]");
      const zone = event.target.closest("[data-zone-edit]");
      const route = event.target.closest("[data-route-edit]");
      if (!add && !zone && !route) return;
      event.stopImmediatePropagation();
      if (add) return void openModal(add.dataset.configAdd === "zone" ? "zoneConfig" : "routeConfig", "");
      if (zone) return void openZone((Ops.cache.zones?.value?.items || []).find(z => z.id === zone.dataset.zoneEdit));
      openRoute((Ops.cache.routes?.value?.items || []).find(r => r.id === route.dataset.routeEdit));
    },
    true,
  );

  // Live: other people's zone / route changes.
  DF.events.on("network.updated", () => {
    Ops.invalidate("zones", "routes", "hub-capacity");
    if (Ops.page() === "Hubs" && Ops.hubPart === "manage") Ops.rerender();
  });
})();
