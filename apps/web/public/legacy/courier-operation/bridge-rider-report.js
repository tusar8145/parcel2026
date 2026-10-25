/*
 * Courier Operations › Reports › Rider report (GET /reports/riders, /reports/riders/parcels).
 * Per rider for Dhaka days (default today): pickups assigned / picked up, deliveries assigned, out for
 * delivery, delivered, failed; COD collected, cash handed in at the hub, cash held now; the last position
 * (opens a map). A rider's parcels open under the row; CSV downloads: riders, or riders with their parcels.
 * Hub staff see their own hubs' riders.
 */
(() => {
  const DF = window.DF;
  const Ops = window.DFOps;
  if (!DF || !Ops) return;
  const $ = id => document.getElementById(id);
  const esc = Ops.esc;
  const PAGE = "Rider report";
  const today = () => new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
  const tk = n => `৳${Number(n || 0).toLocaleString("en-BD", { maximumFractionDigits: 2 })}`;
  const time = iso => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Dhaka" }) : "—");
  const ago = iso => {
    if (!iso) return "";
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
  };

  const S = { from: today(), to: today(), hubId: "", data: null, error: "", loading: false, open: null, parcels: {}, all: false };
  /** A rider with anything in the dates (or cash in hand now). */
  const busy = r => r.pickups.assigned || r.pickups.pickedUp || r.deliveries.assigned || r.deliveries.outForDelivery || r.deliveries.delivered || r.deliveries.failed || r.cash.collected || r.cash.handedIn || r.cash.holdingNow;
  const qs = extra => new URLSearchParams({ from: S.from, to: S.to, ...(S.hubId ? { hubId: S.hubId } : {}), ...extra }).toString();

  document.head.insertAdjacentHTML(
    "beforeend",
    `<style id="rrStyles">
.rr{display:grid;gap:18px}
.rr-filters{display:flex;gap:10px;flex-wrap:wrap;align-items:end;padding:14px 16px}
.rr-filters label{display:grid;gap:4px;font-size:12px;font-weight:600;color:#475467}
.rr-filters input,.rr-filters select{height:36px;border:1px solid #e6e9ef;border-radius:9px;padding:0 10px;font:inherit;font-size:13px;background:#fff}
.rr-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
.rr-card{border:1px solid #e6e9ef;border-radius:12px;padding:12px 14px;background:#fff;display:grid;gap:3px}
.rr-card small{color:#667085;font-size:11.5px;font-weight:600}
.rr-card strong{font-size:20px}
.rr-card.key strong{color:#2f55c9}.rr-card.bad strong{color:#b42318}.rr-card.good strong{color:#067647}
.rr table td.num,.rr table th.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.rr .sub{display:block;color:#667085;font-size:12px}
.rr tr.rr-open td{background:#f8faff}
.rr tr.rr-detail > td{padding:0 0 12px;background:#f8faff}
.rr .rr-inner{margin:0 12px;border:1px solid #e6e9ef;border-radius:10px;overflow:auto;max-height:420px;background:#fff}
.rr .rr-inner table{font-size:12.5px}
.rr-pill{display:inline-flex;padding:2px 8px;border-radius:999px;font-size:11.5px;font-weight:700;white-space:nowrap;background:#f2f4f7;color:#344054}
.rr-pill.good{background:#ecfdf3;color:#067647}.rr-pill.bad{background:#fef3f2;color:#b42318}.rr-pill.blue{background:#eff4ff;color:#2f55c9}
.rr-zero{color:#c0c6d0}
.rr table{font-size:13px}
.rr th.rr-group{text-align:center;border-bottom:1px solid #e6e9ef;color:#344054;font-weight:700}
.rr thead tr:last-child th{font-size:11px}
.rr td,.rr th{padding-left:8px;padding-right:8px}
</style>`,
  );

  async function load() {
    S.loading = true;
    S.error = "";
    S.parcels = {};
    paint();
    try {
      S.data = await DF.api(`/reports/riders?${qs({})}`);
    } catch (error) {
      S.error = DF.describe(error);
    }
    S.loading = false;
    paint();
  }
  async function loadParcels(riderId) {
    try {
      S.parcels[riderId] = (await DF.api(`/reports/riders/parcels?${qs({ riderId })}`)).items;
    } catch (error) {
      S.parcels[riderId] = { error: DF.describe(error) };
    }
    paint();
  }

  const num = v => (v ? String(v) : `<span class="rr-zero">0</span>`);
  const outcomePill = o => `<span class="rr-pill ${/^Delivered|^Picked up/.test(o) ? "good" : /^Failed/.test(o) ? "bad" : /^Out for/.test(o) ? "blue" : ""}">${esc(o)}</span>`;

  function parcelsTable(riderId) {
    const list = S.parcels[riderId];
    if (!list) return `<div style="padding:12px;color:#667085">Loading parcels…</div>`;
    if (list.error) return `<div style="padding:12px;color:#b42318">${esc(list.error)}</div>`;
    if (!list.length) return `<div style="padding:12px;color:#667085">No parcels in these dates.</div>`;
    return `<table><thead><tr><th>Parcel</th><th>Leg</th><th>From</th><th>Recipient</th><th>Outcome</th><th>When</th><th class="num">COD collected</th></tr></thead><tbody>${list
      .map(
        p =>
          `<tr><td><strong>${esc(p.trackingId)}</strong></td><td>${esc(p.leg)}</td><td>${esc(p.sender || "")}</td><td>${esc(p.recipient || "")}${p.zone ? `<span class="sub">${esc(p.zone)}</span>` : ""}</td><td>${outcomePill(p.outcome)}</td><td>${esc(time(p.at))}</td><td class="num">${p.cod ? tk(p.cod) : "—"}</td></tr>`,
      )
      .join("")}</tbody></table>`;
  }

  function render() {
    const hubs = Ops.myHubs() || DF.state.hubs || [];
    const d = S.data;
    const t = d?.totals;
    const cards = t
      ? `<div class="rr-cards">
          <div class="rr-card"><small>Riders working</small><strong>${t.active}</strong><span class="sub">of ${t.riders}</span></div>
          <div class="rr-card"><small>Pickups</small><strong>${t.pickedUp}</strong><span class="sub">${t.pickupsAssigned} assigned</span></div>
          <div class="rr-card"><small>Out for delivery</small><strong>${t.outForDelivery}</strong><span class="sub">${t.deliveriesAssigned} assigned</span></div>
          <div class="rr-card good"><small>Delivered</small><strong>${t.delivered}</strong></div>
          <div class="rr-card bad"><small>Failed</small><strong>${t.failed}</strong></div>
          <div class="rr-card key"><small>COD collected</small><strong>${tk(t.collected)}</strong></div>
          <div class="rr-card"><small>Handed in at hubs</small><strong>${tk(t.handedIn)}</strong><span class="sub">still with riders ${tk(t.holdingNow)}</span></div>
        </div>`
      : "";
    const items = [...(d?.items || [])].sort((a, b) => Number(!!busy(b)) - Number(!!busy(a)) || b.deliveries.delivered - a.deliveries.delivered || a.rider.code.localeCompare(b.rider.code));
    const idle = items.filter(r => !busy(r)).length;
    const shown = S.all ? items : items.filter(busy);
    const rows = shown
      .map(r => {
        const open = S.open === r.rider.id;
        const loc = r.location
          ? `<a href="https://www.google.com/maps?q=${r.location.lat},${r.location.lng}" target="_blank" rel="noopener" class="button button-sm" title="Last position ${esc(time(r.location.at))}">📍 Map</a><span class="sub">${esc(ago(r.location.at))}</span>`
          : `<span class="sub">No position</span>`;
        return `<tr class="${open ? "rr-open" : ""}"><td><strong>${esc(r.rider.code)} · ${esc(r.rider.name)}</strong><span class="sub">${esc(r.rider.hub?.name || "")}${r.rider.phone ? ` · ${esc(DF.localPhone?.(r.rider.phone) || r.rider.phone)}` : ""}</span></td>
          <td class="num">${r.pickups.assigned || r.pickups.pickedUp ? `${r.pickups.pickedUp} / ${r.pickups.assigned}` : num(0)}</td>
          <td class="num">${num(r.deliveries.assigned)}</td><td class="num">${num(r.deliveries.outForDelivery)}</td><td class="num">${num(r.deliveries.delivered)}</td><td class="num">${r.deliveries.failed ? `<strong style="color:#b42318">${r.deliveries.failed}</strong>` : num(0)}</td>
          <td class="num">${r.cash.collected ? tk(r.cash.collected) : num(0)}</td><td class="num">${r.cash.handedIn ? tk(r.cash.handedIn) : num(0)}</td><td class="num">${r.cash.holdingNow ? `<strong>${tk(r.cash.holdingNow)}</strong>` : num(0)}</td>
          <td>${loc}</td>
          <td style="white-space:nowrap"><button class="button button-sm" data-rr="parcels" data-id="${r.rider.id}">${open ? "Hide" : "Parcels"}</button> <button class="button button-sm" data-rr="csv-rider" data-id="${r.rider.id}">CSV</button></td></tr>${
            open ? `<tr class="rr-detail"><td colspan="11"><div class="rr-inner">${parcelsTable(r.rider.id)}</div></td></tr>` : ""
          }`;
      })
      .join("");
    return `<div class="page-heading"><div><p class="eyebrow">Network operations · reporting</p><h1>Rider report</h1><p class="subtitle">What each rider did: pickups, deliveries and failures, the COD they collected and handed in, and where they are now.</p></div><div class="heading-actions"><button class="button" data-rr="csv-riders">Riders (CSV)</button><button class="button button-primary" data-rr="csv-all">Download with parcels</button></div></div>
      <div class="rr">
        <section class="panel" style="border-radius:14px"><div class="rr-filters">
          <label>From<input type="date" id="rrFrom" value="${esc(S.from)}"></label>
          <label>To<input type="date" id="rrTo" value="${esc(S.to)}"></label>
          <label>Hub<select id="rrHub">${Ops.myHubs() ? "" : `<option value="">Whole network</option>`}${hubs.map(h => `<option value="${esc(h.id)}"${S.hubId === h.id ? " selected" : ""}>${esc(h.name)}</option>`).join("")}</select></label>
          <button class="button button-sm" data-rr="today">Today</button>
          <span class="sub" style="margin-left:auto">${S.loading ? "Loading…" : d ? `${esc(d.from === d.to ? d.from : `${d.from} to ${d.to}`)} · Dhaka time` : ""}</span>
        </div></section>
        ${S.error ? `<div class="panel" style="padding:14px;color:#b42318">${esc(S.error)}</div>` : cards}
        <section class="panel table-panel" style="border-radius:14px;overflow:hidden">
          <div class="panel-heading" style="padding:12px 16px"><div><h2 class="panel-title">Riders</h2><p class="panel-subtitle">${d ? `${items.length - idle} working${idle ? ` · ${idle} with nothing in these dates` : ""}` : ""}</p></div>${idle ? `<button class="button button-sm" data-rr="all">${S.all ? "Only riders who worked" : `Show all riders (+${idle})`}</button>` : ""}</div>
          <div class="table-scroll"><table><thead>
          <tr><th rowspan="2">Rider</th><th rowspan="2" class="num">Pickups<span class="sub">done / assigned</span></th><th colspan="4" class="rr-group">Deliveries</th><th colspan="3" class="rr-group">Cash</th><th rowspan="2">Location</th><th rowspan="2"></th></tr>
          <tr><th class="num">Assigned</th><th class="num">Out</th><th class="num">Delivered</th><th class="num">Failed</th><th class="num">Collected</th><th class="num">Handed in</th><th class="num">Holding</th></tr>
        </thead><tbody>${rows || `<tr><td colspan="11" class="empty-state">${S.loading || !d ? "Loading…" : "No rider worked in these dates."}</td></tr>`}</tbody></table></div></section>
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
  const PARCEL_HEAD = ["Rider", "Leg", "Tracking ID", "From", "Recipient", "Recipient phone", "Address", "Area", "Outcome", "When", "COD collected", "COD due", "Status"];
  const parcelRow = p => [p.rider, p.leg, p.trackingId, p.sender, p.recipient, p.recipientPhone || "", p.address || "", p.zone || "", p.outcome, time(p.at), p.cod || 0, p.codDue || 0, p.status];
  function ridersCsv() {
    const rows = (S.data?.items || []).map(r => [
      `${r.rider.code} · ${r.rider.name}`,
      r.rider.hub?.name || "",
      r.pickups.assigned,
      r.pickups.pickedUp,
      r.deliveries.assigned,
      r.deliveries.outForDelivery,
      r.deliveries.delivered,
      r.deliveries.failed,
      r.cash.collected,
      r.cash.handedIn,
      r.cash.holdingNow,
      r.location ? `${r.location.lat},${r.location.lng}` : "",
      r.location ? time(r.location.at) : "",
    ]);
    return [["Rider", "Hub", "Pickups assigned", "Picked up", "Deliveries assigned", "Out for delivery", "Delivered", "Failed", "COD collected", "Handed in", "Holding now", "Last position", "Position at"], ...rows];
  }

  window.addEventListener(
    "click",
    async event => {
      const el = event.target instanceof Element ? event.target.closest("[data-rr]") : null;
      if (!el) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const id = el.dataset.id;
      switch (el.dataset.rr) {
        case "all":
          S.all = !S.all;
          return paint();
        case "today":
          S.from = S.to = today();
          return void load();
        case "parcels":
          S.open = S.open === id ? null : id;
          paint();
          if (S.open && !S.parcels[id]) void loadParcels(id);
          return;
        case "csv-rider": {
          const r = S.data?.items.find(x => x.rider.id === id);
          if (!S.parcels[id] || S.parcels[id].error) await loadParcels(id);
          const list = Array.isArray(S.parcels[id]) ? S.parcels[id] : [];
          return save(`rider-${r?.rider.code || "report"}-${range()}.csv`, csv([PARCEL_HEAD, ...list.map(parcelRow)]));
        }
        case "csv-riders":
          return S.data && save(`rider-report-${range()}.csv`, csv(ridersCsv()));
        case "csv-all": {
          if (!S.data) return;
          try {
            const all = (await DF.api(`/reports/riders/parcels?${qs({})}`)).items;
            return save(`rider-report-with-parcels-${range()}.csv`, csv([...ridersCsv(), [], PARCEL_HEAD, ...all.map(parcelRow)]));
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
    if (!(t instanceof HTMLElement) || !["rrFrom", "rrTo", "rrHub"].includes(t.id)) return;
    if (t.id === "rrFrom") S.from = t.value || today();
    if (t.id === "rrTo") S.to = t.value || today();
    if (t.id === "rrHub") S.hubId = t.value;
    if (S.to < S.from) S.to = S.from;
    S.open = null;
    void load();
  });
  // Live: deliveries and cash change the counts.
  DF.live?.(["parcel.updated", "cash.slip"], () => Ops.page() === PAGE && void load(), { debounceMs: 4000, fallbackMs: 120_000 });
})();
