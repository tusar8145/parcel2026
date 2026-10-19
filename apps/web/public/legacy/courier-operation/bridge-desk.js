/*
 * Courier Operations: the desk tools around the pages (UI only, existing endpoints).
 *
 *   Top bar          the live chip shows the real event-stream state (DF.events.state); the bell is the shared
 *                    notifications bell (shared/notifications.js: unread count, latest notifications) with an
 *                    "Operations alerts" section: breached SLA alerts (GET /sla/alerts) and the open problem counts
 *                    (GET /ops/stage-counts), opening the parcel drawer / Problems; the company block is a brand label
 *   Zone lookup      typing a zone or area in the top-bar search shows the hub that serves it (catalog
 *                    zones / areas → GET /zones → the zone's hub, else the hub located in that zone)
 *   Shortcuts        "/" focuses the search, F2 the scan box on screen, Esc closes the dialog (then the
 *                    drawer); a Hub desk tab focuses its scan box when it opens. A hint shows on Hub desk.
 *   End of day       Hub desk › End of day: GET /ops/hub-reconciliation (arrivals expected vs received,
 *                    dispatched out, held now, ready for collection; COD collected vs cash handed over vs
 *                    still with riders) and its PDF (GET /documents/hub-reconciliation)
 *   Today            the decorative city select on the map is removed (the map shows the whole network)
 */
(() => {
  const DF = window.DF;
  const Ops = window.DFOps;
  if (!DF || !Ops) return;
  const $ = id => document.getElementById(id);
  const q = (selector, root = document) => root.querySelector(selector);
  const qa = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = Ops.esc;
  const visible = el => !!el && el.getClientRects().length > 0 && !el.disabled;

  document.head.insertAdjacentHTML(
    "beforeend",
    `<style id="dfDeskStyles">
.df-pop{position:fixed;z-index:60;width:min(380px,calc(100vw - 24px));max-height:70vh;overflow:auto;padding:10px;border:1px solid var(--line);border-radius:10px;background:#fff;box-shadow:0 18px 40px #1720332b;font-size:13px}
.df-pop h3{margin:2px 4px 8px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#98a2ae}
.df-pop button.df-pop-row{display:flex;justify-content:space-between;gap:10px;width:100%;padding:8px 9px;border:0;border-radius:7px;background:none;text-align:left;cursor:pointer;font:inherit;color:var(--ink)}
.df-pop button.df-pop-row:hover,.df-pop button.df-pop-row:focus-visible{background:#f3f6fb;outline:none}
.df-pop .df-pop-row small{color:#7b8594}
.df-pop .df-pop-empty{margin:6px 4px;color:#7b8594}
.df-shortcuts{margin:-4px 0 12px;color:#7b8594;font-size:12px}
.df-shortcuts kbd{display:inline-block;min-width:18px;padding:1px 5px;border:1px solid var(--line);border-bottom-width:2px;border-radius:5px;background:#fff;font:600 11px/1.4 inherit;text-align:center;color:#455265}
.live-chip[data-state="connecting"]{background:#fff7e6;color:#a15c07}
.live-chip[data-state="offline"]{background:#fef3f2;color:#b42318}
.live-chip[data-state="connecting"] i{background:#f5a524!important;box-shadow:0 0 0 4px #f5a52426!important}
.live-chip[data-state="offline"] i{background:#d92d20!important;box-shadow:0 0 0 4px #d92d2026!important}
.df-eod-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:11px;margin:0 0 13px}
@media(max-width:1200px){.df-eod-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media(max-width:640px){.df-eod-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style>`,
  );

  // ───────────── top bar: brand label, live chip ─────────────

  // The company block names the console; there is nothing to switch to.
  window.addEventListener(
    "click",
    event => {
      if (event.target.closest?.("#companySwitch")) event.stopImmediatePropagation();
    },
    true,
  );

  const CHIP = { live: "Live", connecting: "Connecting…", offline: "Offline · retrying" };
  function paintChip(state = DF.events?.state || "connecting") {
    const chip = $("liveChip");
    if (!chip) return;
    chip.dataset.state = state;
    const text = $("liveChipText");
    if (text) text.textContent = ` ${CHIP[state] || CHIP.connecting}`;
    chip.title = state === "live" ? "Live updates are on: changes by others appear without reloading" : "Live updates are reconnecting; lists refresh when the connection is back";
  }
  DF.events?.on?.("connection", e => paintChip(e.state));
  paintChip();

  // ───────────── the bell: notifications (shared/notifications.js) plus live operations alerts ─────────────

  /** The dropdown's "Operations alerts" section: breached SLA alerts (GET /sla/alerts) and open problem counts. */
  async function alertsSection() {
    const d = Ops.stageCountsData?.detail || {};
    let breached = [];
    let error = "";
    try {
      breached = (await DF.api("/sla/alerts?level=BREACHED&open=true&limit=6")).items || [];
    } catch (e) {
      error = e?.status === 403 ? "" : DF.describe(e);
    }
    const counts = [
      ["Exceptions to resolve", d.exceptions, "Problems", "Exceptions"],
      ["Late or at risk of being late", d.slaRisk, "Problems", "SLA late-risk"],
      ["Failed deliveries to retry", d.failed, "Problems", "Failed delivery"],
      ["Waiting for a delivery rider", d.deliveryWaiting, "Delivery", ""],
    ].filter(([, n]) => Number(n) > 0);
    const rows = [
      ...breached.map(
        a =>
          `<button type="button" class="dfn-item" style="padding-left:10px" data-drawer="${esc(a.parcel.trackingId)}"><span class="dfn-text"><strong>${esc(a.parcel.trackingId)} · ${esc(a.leg === "PICKUP" ? "pickup" : "delivery")} overdue</strong><small>${esc([a.parcel.zone, a.parcel.hub?.name, a.parcel.rider].filter(Boolean).join(" · "))}</small></span><time>due ${esc(Ops.ago(a.dueAt))}</time></button>`,
      ),
      ...counts.map(([label, n, view, tab]) => `<button type="button" class="dfn-item" style="padding-left:10px" data-alert-open="${esc(view)}" data-alert-tab="${esc(tab)}"><span class="dfn-text"><strong>${esc(label)}</strong></span><time style="font-weight:700;color:#344054">${Ops.num(n)}</time></button>`),
    ];
    if (!rows.length && !error) return "";
    return `<div id="alertsPanel" style="padding:2px 4px 4px"><p class="dfn-empty" style="margin:6px 6px 4px;text-align:left;font-size:11px;letter-spacing:.06em;text-transform:uppercase">Operations alerts${breached.length ? " · SLA breached first" : ""}</p>${rows.join("")}${error ? `<p class="dfn-empty">${esc(error)}</p>` : ""}</div>`;
  }
  window.DFNotify?.addSection(alertsSection);
  function placePop(pop, anchor) {
    const r = anchor.getBoundingClientRect();
    pop.style.top = `${Math.round(r.bottom + 8)}px`;
    pop.style.left = `${Math.max(12, Math.min(window.innerWidth - pop.offsetWidth - 12, r.right - pop.offsetWidth))}px`;
  }
  window.addEventListener(
    "click",
    event => {
      const open = event.target.closest?.("[data-alert-open]");
      if (!open) return;
      event.stopImmediatePropagation();
      window.DFNotify?.close();
      Ops.navigate(open.dataset.alertOpen, open.dataset.alertTab || 0);
    },
    true,
  );

  // ───────────── zone / area → serving hub (top-bar search) ─────────────

  const zoneHubs = new Map(); // "district|zone" → hub | null
  async function servingHubOf(district, zone) {
    const key = `${district}|${zone}`;
    if (zoneHubs.has(key)) return zoneHubs.get(key);
    let hub = null;
    try {
      const page = await DF.api(`/zones?limit=20&district=${encodeURIComponent(district)}&q=${encodeURIComponent(zone)}`);
      hub = (page.items || []).find(z => z.name.toLowerCase() === zone.toLowerCase() && z.hub)?.hub || null;
    } catch {}
    hub ||= DF.state.hubs.find(h => h.active !== false && h.district === district && (h.zone || "").toLowerCase() === zone.toLowerCase()) || null;
    zoneHubs.set(key, hub);
    return hub;
  }
  /** Catalog zones and areas containing the text (zones first), at most 6. */
  function placesMatching(text) {
    const c = Ops.catalog;
    if (!c) return [];
    const t = text.toLowerCase();
    const out = [];
    for (const district of c.districts || [])
      for (const zone of c.zonesByDistrict?.[district] || []) if (zone.toLowerCase().includes(t)) out.push({ district, zone });
    for (const district of c.districts || [])
      for (const zone of c.zonesByDistrict?.[district] || [])
        for (const area of c.areasByZone?.[zone] || []) if (area.toLowerCase().includes(t) && !out.some(p => p.zone === zone && p.district === district && !p.area)) out.push({ district, zone, area });
    return out.slice(0, 6);
  }
  Ops.placesMatching = placesMatching;
  Ops.servingHubOf = servingHubOf;

  let lookupPop = null;
  let lookupSeq = 0;
  const closeLookup = () => {
    lookupPop?.remove();
    lookupPop = null;
  };
  const lookupLater = Ops.ui.debounce(async text => {
    const input = $("globalSearch");
    const seq = ++lookupSeq;
    // Tracking IDs, CNs and phone numbers are parcels (Enter opens the drawer); words are places.
    if (!input || text.length < 3 || /\d/.test(text)) return closeLookup();
    const places = placesMatching(text);
    if (!places.length) return closeLookup();
    const hubs = await Promise.all(places.map(p => servingHubOf(p.district, p.zone)));
    if (seq !== lookupSeq || input.value.trim() !== text) return;
    closeLookup();
    const pop = document.createElement("div");
    pop.className = "df-pop";
    pop.id = "zoneLookup";
    pop.setAttribute("role", "listbox");
    pop.setAttribute("aria-label", "Which hub serves this place");
    pop.innerHTML = `<h3>Which hub serves it</h3>${places
      .map((p, i) => {
        const hub = hubs[i];
        return `<button type="button" class="df-pop-row" role="option" data-zone-lookup="${esc(p.zone)}" data-zone-district="${esc(p.district)}"><span><strong>${esc(p.area ? `${p.area}` : p.zone)}</strong><br><small>${esc(p.area ? `${p.zone}, ${p.district}` : p.district)}</small></span><span data-zone-hub style="text-align:right">${hub ? `${esc(hub.name)}<br><small>serves this zone</small>` : `<small>No hub set for this zone</small>`}</span></button>`;
      })
      .join("")}<p class="df-pop-empty">Enter still searches parcels (tracking ID, CN or phone).</p>`;
    document.body.append(pop);
    lookupPop = pop;
    placePop(pop, input);
  }, 250);
  window.addEventListener("input", event => {
    if (event.target?.id === "globalSearch") lookupLater(event.target.value.trim());
  });
  window.addEventListener(
    "click",
    event => {
      if (!lookupPop) return;
      const row = event.target.closest?.("[data-zone-lookup]");
      if (row && lookupPop.contains(row)) {
        event.stopImmediatePropagation();
        closeLookup();
        // Hubs & zones lists the zone with its hub (and lets managers change it).
        if (Ops.allowedViews?.().has("Hubs & zones")) {
          Ops.navigate("Hubs & zones");
          setTimeout(() => {
            const filter = $("zoneFilterQ");
            if (filter) {
              filter.value = row.dataset.zoneLookup;
              filter.dispatchEvent(new Event("change", { bubbles: true }));
            }
          }, 50);
        }
        return;
      }
      if (!lookupPop.contains(event.target) && event.target.id !== "globalSearch") closeLookup();
    },
    true,
  );

  // ───────────── keyboard shortcuts ─────────────

  /** Scan boxes, in the order a desk uses them; the first one on screen gets F2. */
  const SCAN_BOXES = ["rdCode", "collectScan", "lhScanParcel", "lhReceiveParcel", "lhReceiveBag", "lhLoadBag", "lhOpenBag", "cnCheckInput"];
  const scanBox = () => SCAN_BOXES.map($).find(visible) || null;
  Ops.focusScanBox = () => {
    const box = scanBox();
    if (box) {
      box.focus();
      box.select?.();
    }
    return box;
  };
  const typingIn = el => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

  document.addEventListener(
    "keydown",
    event => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === "Escape") {
        if (document.querySelector(".df-dialog")) return; // the small dialog closes itself
        if (lookupPop) {
          closeLookup();
          return void event.preventDefault();
        }
        if ($("modalBackdrop")?.classList.contains("open") && typeof closeModal === "function") {
          event.preventDefault();
          event.stopImmediatePropagation();
          return void closeModal(); // the drawer (if open) stays: Esc again closes it
        }
        return;
      }
      if (document.querySelector(".df-dialog") || $("modalBackdrop")?.classList.contains("open")) return;
      if (event.key === "F2") {
        event.preventDefault();
        if (!Ops.focusScanBox()) showToast("No scan box on this page.");
        return;
      }
      if (event.key === "/" && !typingIn(event.target)) {
        const search = $("globalSearch");
        if (!search) return;
        event.preventDefault();
        search.focus();
        search.select();
      }
    },
    true,
  );

  const shortcutHint = () =>
    `<p class="df-shortcuts" id="deskShortcuts">Keyboard: <kbd>/</kbd> find a parcel · <kbd>F2</kbd> scan box · <kbd>Esc</kbd> close the dialog or drawer</p>`;

  /** When a Hub desk tab opens (not on redraws), its scan box gets the focus once it is drawn. */
  let focusedEpoch = null;
  function autofocusScan() {
    if (focusedEpoch === Ops.navEpoch) return;
    focusedEpoch = Ops.navEpoch;
    let tries = 20;
    const attempt = () => {
      if (document.querySelector(".df-dialog") || $("modalBackdrop")?.classList.contains("open")) return;
      if (typingIn(document.activeElement) && document.activeElement.id !== "globalSearch") return;
      if (!Ops.focusScanBox() && tries-- > 0) setTimeout(attempt, 150);
    };
    setTimeout(attempt, 60);
  }

  // ───────────── Hub desk › End of day ─────────────

  const dhakaToday = () => new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
  const eod = { hubId: null, date: null, data: null, error: "", loading: false, epoch: null };
  const eodHubs = () => Ops.myHubs() || DF.state.hubs.filter(h => h.active !== false);

  async function loadEod() {
    if (!eod.hubId) return;
    eod.loading = true;
    paintEod();
    const key = `${eod.hubId}|${eod.date}`;
    try {
      const data = await DF.api(`/ops/hub-reconciliation?hubId=${encodeURIComponent(eod.hubId)}&date=${eod.date}`);
      if (`${eod.hubId}|${eod.date}` !== key) return;
      eod.data = data;
      eod.error = "";
    } catch (error) {
      eod.data = null;
      eod.error = DF.describe(error);
    } finally {
      eod.loading = false;
      paintEod();
    }
  }

  const taka = v => `৳${Number(v || 0).toLocaleString("en-BD", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  function eodBody() {
    const r = eod.data;
    if (!r) return { cards: `<p class="panel-subtitle" style="padding:0 16px 16px" data-eod-state>${esc(eod.error || (eod.loading ? "Loading the day's figures…" : "Choose a hub and a day."))}</p>`, cash: "" };
    const p = r.parcels;
    const now = r.isToday ? "now" : "at the time of viewing";
    const cards = [
      ["Arrivals expected", p.expected, "box", `${Ops.num(p.received)} received`, `+ ${Ops.num(p.stillExpected)} still expected`, "expected"],
      ["Received", p.received, "check", "arrived at the hub", r.date, "received"],
      ["Still expected", p.stillExpected, "clock", `${Ops.num(p.expectedParts.inboundBags)} in bags · ${Ops.num(p.expectedParts.dropOffs)} drop-offs`, `${Ops.num(p.expectedParts.pickedUpByRiders)} with pickup riders`, "stillExpected"],
      ["Dispatched out", p.dispatched, "truck", `${Ops.num(p.outForDelivery)} out for delivery`, `${Ops.num(p.transferred)} transferred (${Ops.num(p.transferBags)} bags)`, "dispatched"],
      ["Held at the hub", p.heldNow, "pin", now, `${Ops.num(p.delivered)} delivered today`, "heldNow"],
      ["Ready for collection", p.readyForCollection, "users", now, "waiting on Collect from hub", "readyForCollection"],
    ]
      .map(([label, value, ico, trend, note, key]) => metric(label, `<span data-eod="${key}">${Ops.num(value)}</span>`, ico, esc(trend), esc(note)))
      .join("");
    let cash = "";
    if (r.cash) {
      const c = r.cash;
      const balance = Number(c.collected) - Number(c.handedOver);
      const summary = [
        ["COD collected (riders + counter)", `${Ops.num(c.collections)}`, taka(c.collected), "collected"],
        ["of which at the hub counter", `${Ops.num(c.counterCollections)}`, taka(c.collectedAtCounter), "counter"],
        ["Cash handovers received", `${Ops.num(c.handovers)}`, taka(c.handedOver), "handedOver"],
        ["Collected that day, not handed over", `${Ops.num(c.outstandingFromDayCollections)}`, taka(c.outstandingFromDay), "outstandingFromDay"],
        ["Still with riders (any day)", `${Ops.num(c.outstandingCollections)}`, taka(c.outstanding), "outstanding"],
      ]
        .map(([label, n, amount, key]) => `<tr><td>${esc(label)}</td><td>${esc(n)}</td><td><strong data-eod-cash="${key}">${esc(amount)}</strong></td></tr>`)
        .join("");
      const riders = c.perRider
        .map(x => `<tr><td>${esc(x.rider.code)} · ${esc(x.rider.name)}</td><td>${taka(x.collected)}<span class="subcell">${Ops.num(x.collections)} collection${x.collections === 1 ? "" : "s"}</span></td><td>${taka(x.handedOver)}</td><td${Number(x.withRider) > 0 ? ' style="color:var(--red);font-weight:600"' : ""}>${taka(x.withRider)}</td></tr>`)
        .join("");
      cash = `${Ops.ui.panel(
        "Cash on delivery",
        `${r.date} · ${balance > 0.004 ? `${taka(balance)} more collected than handed over` : balance < -0.004 ? `${taka(-balance)} handed over from earlier days` : "collected and handed over match"}`,
        Ops.ui.table(["Item", "Count", "Amount"], summary, ""),
        "",
        'id="eodCash"',
      )}${Ops.ui.panel("Cash by rider", "Collected and handed over that day; still with the rider from any day", Ops.ui.table(["Rider", "Collected", "Handed over", "Still with rider"], riders, "No rider cash for this hub."), "", 'id="eodRiders"')}`;
    }
    return { cards: `<div class="df-eod-grid" style="padding:0 16px 4px">${cards}</div>`, cash };
  }
  function eodMarkup() {
    const hubs = eodHubs();
    const tools = `${hubs.length > 1 ? `<select class="select-small" id="eodHub" aria-label="Hub">${hubs.map(h => `<option value="${esc(h.id)}"${h.id === eod.hubId ? " selected" : ""}>${esc(h.name)}</option>`).join("")}</select>` : ""}<label class="shipment-date-filter">Day<input class="table-search" type="date" id="eodDate" value="${esc(eod.date)}" max="${dhakaToday()}"></label><button class="button button-sm" type="button" data-eod-action="refresh">↻ Refresh</button><button class="button button-sm" type="button" data-eod-action="print"${eod.hubId ? "" : " disabled"}>Print (PDF)</button>`;
    const hub = hubs.find(h => h.id === eod.hubId);
    return `<section class="panel table-panel" id="eodPanel" style="margin-bottom:14px"><div class="panel-heading"><div><h2 class="panel-title">End of day${hub ? ` · ${esc(hub.name)}` : ""}</h2><p class="panel-subtitle">Arrivals, dispatches and cash for the day (Dhaka time) · held and ready-for-collection counts are as of now</p></div><div class="table-tools">${tools}</div></div><div id="eodBody">${eodBody().cards}</div></section><div id="eodCashWrap">${eodBody().cash}</div>`;
  }
  function paintEod() {
    const body = $("eodBody");
    if (!body) return;
    const parts = eodBody();
    body.innerHTML = parts.cards;
    const cash = $("eodCashWrap");
    if (cash) cash.innerHTML = parts.cash;
  }

  window.addEventListener("change", event => {
    if (event.target.id === "eodHub") {
      eod.hubId = event.target.value;
      eod.data = null;
      const title = q("#eodPanel .panel-title");
      if (title) title.textContent = `End of day · ${eodHubs().find(h => h.id === eod.hubId)?.name || ""}`;
      void loadEod();
    }
    if (event.target.id === "eodDate" && event.target.value) {
      eod.date = event.target.value > dhakaToday() ? dhakaToday() : event.target.value;
      eod.data = null;
      void loadEod();
    }
  });
  window.addEventListener(
    "click",
    event => {
      const action = event.target.closest?.("[data-eod-action]");
      if (!action) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (action.dataset.eodAction === "refresh") return void loadEod();
      if (!eod.hubId) return;
      Ops.printPdf(`/documents/hub-reconciliation?hubId=${encodeURIComponent(eod.hubId)}&date=${eod.date}`, { title: "Preparing the end-of-day reconciliation…" });
    },
    true,
  );
  // The day's figures follow parcel moves and cash handovers while the tab is open.
  let eodTimer = null;
  const eodLive = () => {
    if (!$("eodPanel") || eod.date !== dhakaToday()) return;
    clearTimeout(eodTimer);
    eodTimer = setTimeout(() => void loadEod(), 2500);
  };
  for (const type of ["parcel.updated", "cod.handover_request", "reconnect"]) DF.events?.on?.(type, eodLive);

  const baseHubs = Ops.enhance.Hubs;
  Ops.enhance.Hubs = page => {
    baseHubs?.(page);
    $("eodPanel")?.remove();
    $("eodCashWrap")?.remove();
    $("deskShortcuts")?.remove();
    if (Ops.hubPart === "manage") return;
    q("#mainContent .page-heading")?.insertAdjacentHTML("afterend", shortcutHint());
    if (Ops.hubPart === "eod") {
      if (!eod.hubId || !eodHubs().some(h => h.id === eod.hubId)) eod.hubId = eodHubs()[0]?.id || null;
      eod.date ||= dhakaToday();
      $("mainContent").insertAdjacentHTML("beforeend", eodMarkup());
      if (eod.epoch !== Ops.navEpoch) {
        eod.epoch = Ops.navEpoch;
        void loadEod();
      }
      return;
    }
    autofocusScan();
  };
  // Transfers and CN stock have scan boxes too: the hint, without stealing the focus.
  for (const page of ["Linehaul", "CN stock"]) {
    const base = Ops.enhance[page];
    Ops.enhance[page] = arg => {
      base?.(arg);
      $("deskShortcuts")?.remove();
      q("#mainContent .page-heading")?.insertAdjacentHTML("afterend", shortcutHint());
    };
  }

  // ───────────── Today: no decorative city filter ─────────────

  const baseOverview = Ops.enhance.Overview;
  Ops.enhance.Overview = page => {
    baseOverview?.(page);
    $("mapCity")?.remove();
  };
})();
