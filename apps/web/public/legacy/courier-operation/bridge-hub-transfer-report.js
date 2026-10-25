/*
 * Courier Operations › Reports › Hub transfer report (GET /reports/hub-transfers, /reports/hub-transfers/parcels).
 * Parcels moved hub to hub in Dhaka days (default today): per route (from → to) and per hub, how many were sent,
 * received, are still on the way or went missing, and the average time on the road. A route's parcels open under
 * the row; CSV downloads: the route summary, one route's parcels, or everything with the parcels.
 * Hub staff see transfers into or out of their hubs. Uses the Rider report's styles (.rr…, bridge-rider-report.js).
 */
(() => {
  const DF = window.DF;
  const Ops = window.DFOps;
  if (!DF || !Ops) return;
  const esc = Ops.esc;
  const PAGE = "Hub transfer report";
  const today = () => new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
  const tk = n => `৳${Number(n || 0).toLocaleString("en-BD", { maximumFractionDigits: 2 })}`;
  const time = iso => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Dhaka" }) : "—");
  /** Time on the road: minutes, hours or days. */
  const span = h => (h == null ? "—" : h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h * 10) / 10} h` : `${Math.round((h / 24) * 10) / 10} d`);

  const S = { from: today(), to: today(), fromHubId: "", toHubId: "", view: "routes", data: null, error: "", loading: false, open: null, parcels: {} };
  const qs = extra => new URLSearchParams({ from: S.from, to: S.to, ...(S.fromHubId ? { fromHubId: S.fromHubId } : {}), ...(S.toHubId ? { toHubId: S.toHubId } : {}), ...extra }).toString();
  const routeKey = r => `${r.from.id}>${r.to.id}`;

  async function load() {
    S.loading = true;
    S.error = "";
    S.parcels = {};
    paint();
    try {
      S.data = await DF.api(`/reports/hub-transfers?${qs({})}`);
    } catch (error) {
      S.error = DF.describe(error);
    }
    S.loading = false;
    paint();
  }
  async function loadParcels(route) {
    const key = routeKey(route);
    try {
      S.parcels[key] = (await DF.api(`/reports/hub-transfers/parcels?${qs({ fromHubId: route.from.id, toHubId: route.to.id })}`)).items;
    } catch (error) {
      S.parcels[key] = { error: DF.describe(error) };
    }
    paint();
  }

  const num = v => (v ? String(v) : `<span class="rr-zero">0</span>`);
  const statePill = s => `<span class="rr-pill ${s === "Received" ? "good" : s === "Missing" ? "bad" : "blue"}">${esc(s)}</span>`;
  const findRoute = key => (S.data?.routes || []).find(r => routeKey(r) === key);

  function parcelsTable(key) {
    const list = S.parcels[key];
    if (!list) return `<div style="padding:12px;color:#667085">Loading parcels…</div>`;
    if (list.error) return `<div style="padding:12px;color:#b42318">${esc(list.error)}</div>`;
    if (!list.length) return `<div style="padding:12px;color:#667085">No parcels in these dates.</div>`;
    return `<table><thead><tr><th>Parcel</th><th>From</th><th>Recipient</th><th>Trip / bag</th><th>Sent</th><th>Received</th><th class="num">On the road</th><th>Transfer</th><th>Status now</th></tr></thead><tbody>${list
      .map(
        p =>
          `<tr><td><strong>${esc(p.trackingId)}</strong>${p.cod ? `<span class="sub">COD ${tk(p.cod)}</span>` : ""}</td><td>${esc(p.sender || "")}</td><td>${esc(p.recipient || "")}${p.zone ? `<span class="sub">${esc(p.zone)}</span>` : ""}</td><td>${p.trip || p.bag ? `${esc(p.trip || "")}<span class="sub">${esc(p.bag || "")}</span>` : `<span class="sub">By hand</span>`}</td><td>${esc(time(p.sentAt))}${p.sentBy ? `<span class="sub">${esc(p.sentBy)}</span>` : ""}</td><td>${p.receivedAt ? `${esc(time(p.receivedAt))}${p.receivedBy ? `<span class="sub">${esc(p.receivedBy)}</span>` : ""}` : "—"}</td><td class="num">${esc(span(p.hours))}</td><td>${statePill(p.state)}</td><td>${esc(p.status || "")}</td></tr>`,
      )
      .join("")}</tbody></table>`;
  }

  function routesTable(d) {
    const rows = (d?.routes || [])
      .map(r => {
        const key = routeKey(r);
        const open = S.open === key;
        return `<tr class="${open ? "rr-open" : ""}"><td><strong>${esc(r.from.name)}</strong> <span style="color:#98a2b3">→</span> <strong>${esc(r.to.name)}</strong>${r.lastSentAt ? `<span class="sub">last sent ${esc(time(r.lastSentAt))}</span>` : ""}</td>
          <td class="num"><strong>${num(r.sent)}</strong></td><td class="num">${num(r.received)}</td><td class="num">${r.onTheWay ? `<strong style="color:#2f55c9">${r.onTheWay}</strong>` : num(0)}</td><td class="num">${r.missing ? `<strong style="color:#b42318">${r.missing}</strong>` : num(0)}</td><td class="num">${esc(span(r.avgHours))}</td>
          <td style="white-space:nowrap;text-align:right"><button class="button button-sm" data-hx="parcels" data-id="${esc(key)}">${open ? "Hide" : "Parcels"}</button> <button class="button button-sm" data-hx="csv-route" data-id="${esc(key)}">CSV</button></td></tr>${
            open ? `<tr class="rr-detail"><td colspan="7"><div class="rr-inner">${parcelsTable(key)}</div></td></tr>` : ""
          }`;
      })
      .join("");
    return `<table><thead><tr><th>Route</th><th class="num">Sent</th><th class="num">Received</th><th class="num">On the way</th><th class="num">Missing</th><th class="num">Avg. time</th><th></th></tr></thead><tbody>${
      rows || `<tr><td colspan="7" class="empty-state">${S.loading || !d ? "Loading…" : "No parcels moved between hubs in these dates."}</td></tr>`
    }</tbody></table>`;
  }

  function hubsTable(d) {
    const rows = (d?.hubs || [])
      .map(
        h =>
          `<tr><td><strong>${esc(h.hub.name)}</strong>${h.hub.code ? `<span class="sub">${esc(h.hub.code)}</span>` : ""}</td><td class="num"><strong>${num(h.sentOut)}</strong></td><td class="num"><strong>${num(h.receivedIn)}</strong></td><td class="num">${num(h.onTheWayOut)}</td><td class="num">${num(h.onTheWayIn)}</td><td class="num">${h.missingOut ? `<strong style="color:#b42318">${h.missingOut}</strong>` : num(0)}</td><td style="text-align:right;white-space:nowrap">${
            h.hub.id ? `<button class="button button-sm" data-hx="from-hub" data-id="${esc(h.hub.id)}">Sent from here</button> <button class="button button-sm" data-hx="to-hub" data-id="${esc(h.hub.id)}">Sent to here</button>` : ""
          }</td></tr>`,
      )
      .join("");
    return `<table><thead><tr><th>Hub</th><th class="num">Sent out</th><th class="num">Received in</th><th class="num">On the way out</th><th class="num">On the way in</th><th class="num">Missing (sent)</th><th></th></tr></thead><tbody>${
      rows || `<tr><td colspan="7" class="empty-state">${S.loading || !d ? "Loading…" : "No parcels moved between hubs in these dates."}</td></tr>`
    }</tbody></table>`;
  }

  function render() {
    // Every hub on both sides: hub staff see what their hubs sent anywhere and received from anywhere.
    const hubs = [...(DF.state.hubs || Ops.myHubs() || [])].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const hubSelect = (id, value) => `<select id="${id}"><option value="">Any hub</option>${hubs.map(h => `<option value="${esc(h.id)}"${value === h.id ? " selected" : ""}>${esc(h.name)}</option>`).join("")}</select>`;
    const d = S.data;
    const t = d?.totals;
    const cards = t
      ? `<div class="rr-cards">
          <div class="rr-card key"><small>Sent</small><strong>${t.sent}</strong><span class="sub">${t.routes} route${t.routes === 1 ? "" : "s"}</span></div>
          <div class="rr-card good"><small>Received</small><strong>${t.received}</strong></div>
          <div class="rr-card"><small>Still on the way</small><strong>${t.onTheWay}</strong><span class="sub">of those sent</span></div>
          <div class="rr-card bad"><small>Missing</small><strong>${t.missing}</strong><span class="sub">not in the bag on arrival</span></div>
          <div class="rr-card"><small>Avg. time on the road</small><strong>${esc(span(t.avgHours))}</strong></div>
        </div>`
      : "";
    const tab = (id, label) => `<button class="button button-sm${S.view === id ? " button-primary" : ""}" data-hx="view" data-id="${id}">${label}</button>`;
    return `<div class="page-heading"><div><p class="eyebrow">Network operations · reporting</p><h1>Hub transfer report</h1><p class="subtitle">Parcels moved from hub to hub: how many each hub sent and received, what is still on the way, and what went missing.</p></div><div class="heading-actions"><button class="button" data-hx="csv-summary">Summary (CSV)</button><button class="button button-primary" data-hx="csv-all">Download with parcels</button></div></div>
      <div class="rr">
        <section class="panel" style="border-radius:14px"><div class="rr-filters">
          <label>From<input type="date" id="hxFrom" value="${esc(S.from)}"></label>
          <label>To<input type="date" id="hxTo" value="${esc(S.to)}"></label>
          <label>From hub${hubSelect("hxFromHub", S.fromHubId)}</label>
          <button class="button button-sm" data-hx="swap" title="Swap from and to" style="height:36px">⇄</button>
          <label>To hub${hubSelect("hxToHub", S.toHubId)}</label>
          <button class="button button-sm" data-hx="today">Today</button>${S.fromHubId || S.toHubId ? ` <button class="button button-sm" data-hx="clear-hubs">Clear hubs</button>` : ""}
          <span class="sub" style="margin-left:auto">${S.loading ? "Loading…" : d ? `${esc(d.from === d.to ? d.from : `${d.from} to ${d.to}`)} · Dhaka time` : ""}</span>
        </div></section>
        ${S.error ? `<div class="panel" style="padding:14px;color:#b42318">${esc(S.error)}</div>` : cards}
        <section class="panel table-panel" style="border-radius:14px;overflow:hidden">
          <div class="panel-heading" style="padding:12px 16px"><div><h2 class="panel-title">${S.view === "routes" ? "By route" : "By hub"}</h2><p class="panel-subtitle">Sent = left the hub in these dates · Received = arrived in these dates · On the way / Missing = of those sent</p></div><div style="display:flex;gap:6px">${tab("routes", "By route")}${tab("hubs", "By hub")}</div></div>
          <div class="table-scroll">${S.view === "routes" ? routesTable(d) : hubsTable(d)}</div>
        </section>
      </div>`;
  }
  const paint = () => Ops.page() === PAGE && Ops.rerender(true);

  Ops.pages[PAGE] = { render };
  Ops.enhance[PAGE] = () => {
    // After this render finishes (loading redraws the page; a redraw inside a render would draw the tabs twice).
    if (!S.data && !S.loading && !S.error) setTimeout(() => void load(), 0);
  };

  // ───────────── CSV ─────────────
  const cell = v => {
    if (v == null) return "";
    let t = String(v);
    if (typeof v === "string" && /^[=+\-@]/.test(t)) t = `'${t}`;
    return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const csv = rows => rows.map(r => r.map(cell).join(",")).join("\r\n");
  const save = (name, text) => (typeof courierCsvDownload === "function" ? courierCsvDownload(name, text) : DF.downloadText?.(name, text)); // eslint-disable-line no-undef
  const range = () => (S.from === S.to ? S.from : `${S.from}_to_${S.to}`);
  const PARCEL_HEAD = ["From hub", "To hub", "Tracking ID", "Sender", "Recipient", "Area", "COD", "Trip", "Bag", "Sent at", "Sent by", "Received at", "Received by", "Hours on the road", "Transfer", "Status now"];
  const parcelRow = p => [p.from.name, p.to.name, p.trackingId, p.sender, p.recipient, p.zone, p.cod, p.trip || "", p.bag || "", time(p.sentAt), p.sentBy || "", p.receivedAt ? time(p.receivedAt) : "", p.receivedBy || "", p.hours ?? "", p.state, p.status];
  function summaryCsv() {
    const d = S.data;
    return [
      ["From hub", "To hub", "Sent", "Received", "On the way", "Missing", "Avg. hours on the road"],
      ...(d?.routes || []).map(r => [r.from.name, r.to.name, r.sent, r.received, r.onTheWay, r.missing, r.avgHours ?? ""]),
      [],
      ["Hub", "Sent out", "Received in", "On the way out", "On the way in", "Missing (sent)"],
      ...(d?.hubs || []).map(h => [h.hub.name, h.sentOut, h.receivedIn, h.onTheWayOut, h.onTheWayIn, h.missingOut]),
    ];
  }

  window.addEventListener(
    "click",
    async event => {
      const el = event.target instanceof Element ? event.target.closest("[data-hx]") : null;
      if (!el) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const id = el.dataset.id;
      switch (el.dataset.hx) {
        case "view":
          S.view = id;
          return paint();
        case "from-hub":
        case "to-hub":
          if (el.dataset.hx === "from-hub") [S.fromHubId, S.toHubId] = [id, ""];
          else [S.fromHubId, S.toHubId] = ["", id];
          S.view = "routes";
          S.open = null;
          return void load();
        case "swap":
          [S.fromHubId, S.toHubId] = [S.toHubId, S.fromHubId];
          S.open = null;
          return void load();
        case "clear-hubs":
          S.fromHubId = S.toHubId = "";
          S.open = null;
          return void load();
        case "today":
          S.from = S.to = today();
          return void load();
        case "parcels": {
          S.open = S.open === id ? null : id;
          paint();
          const route = findRoute(id);
          if (S.open && route && !S.parcels[id]) void loadParcels(route);
          return;
        }
        case "csv-route": {
          const route = findRoute(id);
          if (!route) return;
          if (!Array.isArray(S.parcels[id])) await loadParcels(route);
          const list = Array.isArray(S.parcels[id]) ? S.parcels[id] : [];
          const slug = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
          return save(`transfers-${slug(route.from.code || route.from.name)}-to-${slug(route.to.code || route.to.name)}-${range()}.csv`, csv([PARCEL_HEAD, ...list.map(parcelRow)]));
        }
        case "csv-summary":
          return S.data && save(`hub-transfer-report-${range()}.csv`, csv(summaryCsv()));
        case "csv-all": {
          if (!S.data) return;
          try {
            const all = (await DF.api(`/reports/hub-transfers/parcels?${qs({})}`)).items;
            return save(`hub-transfer-report-with-parcels-${range()}.csv`, csv([...summaryCsv(), [], PARCEL_HEAD, ...all.map(parcelRow)]));
          } catch (error) {
            return window.showToast(DF.describe(error));
          }
        }
      }
    },
    true,
  );
  document.addEventListener("change", event => {
    const t = event.target;
    if (!(t instanceof HTMLElement) || !["hxFrom", "hxTo", "hxFromHub", "hxToHub"].includes(t.id)) return;
    if (t.id === "hxFrom") S.from = t.value || today();
    if (t.id === "hxTo") S.to = t.value || today();
    if (t.id === "hxFromHub") S.fromHubId = t.value;
    if (t.id === "hxToHub") S.toHubId = t.value;
    if (S.to < S.from) S.to = S.from;
    S.open = null;
    void load();
  });
  // Live: departures and arrivals change the counts.
  DF.live?.(["parcel.updated"], () => Ops.page() === PAGE && void load(), { debounceMs: 4000, fallbackMs: 120_000 });
})();
