/*
 * Courier Operations → Hub desk → "Collect from hub" (service packages): parcels waiting at the hub for
 * their receivers (GET /ops/collections), handed over against the collection code — or a photo of
 * the receiver's ID when the code is lost — with the COD taken into the hub's cash
 * (POST /parcels/:trackingId/collect), and a new code sent again (POST /parcels/:id/collection-code).
 */
(() => {
  const DF = window.DF;
  const Ops = window.DFOps;
  if (!DF || !Ops) return;
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const taka = n => `৳${Number(n || 0).toLocaleString("en-BD")}`;
  const day = iso => (iso ? new Date(iso).toLocaleDateString("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short" }) : "—");
  const state = { hubId: null, items: [], handing: null, message: "" };

  const hubs = () => Ops.myHubs?.() || DF.state.hubs.filter(h => h.active !== false);

  async function load() {
    if (!state.hubId) return;
    state.loadedFor = state.hubId;
    try {
      state.items = (await DF.api(`/ops/collections?hubId=${encodeURIComponent(state.hubId)}`)).items;
    } catch (error) {
      state.items = [];
      state.message = DF.describe(error);
    }
    paint();
  }

  function markup() {
    const rows = state.items
      .map(p => {
        const handing = state.handing === p.trackingId;
        const overdue = p.collect?.dueAt && new Date(p.collect.dueAt) < new Date(Date.now() + 86_400_000);
        return `<tr data-collect-row="${esc(p.trackingId)}"><td class="tracking">${esc(p.trackingId)}</td><td>${esc(p.recipient?.name || "—")}<span class="subcell">${esc(p.recipient?.phone || "")}</span></td><td>${p.codAmount ? taka(p.codAmount) : "Prepaid"}</td><td${overdue ? ' style="color:var(--red);font-weight:600"' : ""}>${esc(day(p.collect?.dueAt))}</td>
          <td><div style="display:flex;gap:6px;flex-wrap:wrap"><button type="button" class="button button-sm button-primary" data-collect-open="${esc(p.trackingId)}">Hand over</button><button type="button" class="button button-sm" data-collect-resend="${esc(p.trackingId)}">Resend code</button></div></td></tr>${
            handing
              ? `<tr><td colspan="5"><form id="collectForm" class="workflow-form" data-tracking="${esc(p.trackingId)}" autocomplete="off">
                <label>Collection code<input id="collectCode" inputmode="numeric" maxlength="8" placeholder="6-digit code from the receiver"></label>
                <label>Collected by<input id="collectBy" maxlength="120" value="${esc(p.recipient?.name || "")}" required></label>
                <label>Cash received (৳)<input id="collectCod" type="number" min="0" value="${esc(p.codAmount || 0)}"></label>
                <label>No code? Photo of the receiver's ID<input id="collectPhoto" type="file" accept="image/*" capture="environment" data-file-button="Take or choose photo"></label>
                <div class="form-actions"><button class="button button-primary" type="submit">Confirm hand-over</button><button class="button" type="button" data-collect-cancel>Cancel</button></div>
              </form></td></tr>`
              : ""
          }`;
      })
      .join("");
    return `<section class="panel table-panel" id="collectCounter" style="margin-bottom:14px"><div class="panel-heading"><div><h2 class="panel-title">Collect from hub</h2><p class="panel-subtitle">Parcels waiting for their receivers. Hand them over against the collection code; cash on delivery goes into this hub's cash.</p></div>
      <div class="table-tools"><label class="subcell" style="display:flex;gap:6px;align-items:center">Hub <select class="select-small" id="collectHub">${hubs().map(h => `<option value="${esc(h.id)}" ${h.id === state.hubId ? "selected" : ""}>${esc(h.name)}</option>`).join("")}</select></label><span class="status status-blue" id="collectCount">${state.items.length} waiting</span></div></div>
      <form class="workflow-form" id="collectScanForm" autocomplete="off" style="padding:0 16px"><label>Find a waiting parcel<input id="collectScan" placeholder="Scan the label or type the tracking ID, then Enter" autocomplete="off"></label></form>
      <p class="panel-subtitle" id="collectMessage" aria-live="polite">${esc(state.message)}</p>
      <div class="table-scroll"><table><thead><tr><th>TRACKING ID</th><th>RECEIVER</th><th>COD</th><th>COLLECT BY</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="5" class="empty-state">No parcels are waiting for collection at this hub.</td></tr>`}</tbody></table></div></section>`;
  }

  function paint() {
    const existing = $("collectCounter");
    if (!existing) return;
    existing.outerHTML = markup();
    const scan = $("collectScan");
    if (scan) DF.scanner?.attach(scan, { title: "Scan the parcel label", onScan: () => $("collectScanForm")?.requestSubmit() });
  }

  /** The counter's scan box: a waiting parcel opens its hand-over form (shared scan feedback either way). */
  function findWaiting(raw) {
    const code = DF.scanner?.normalize ? DF.scanner.normalize(raw) : String(raw || "").trim().toUpperCase();
    if (!code) return;
    Ops.recordScan?.(code, "HUB_LOOKUP", state.hubId);
    const hit = state.items.find(p => p.trackingId.toUpperCase() === code);
    if (!hit) {
      state.message = `${code} isn't waiting for collection at this hub.`;
      paint();
      DF.scanner?.feedback?.("collectScan", false);
      return void $("collectScan")?.focus();
    }
    state.handing = hit.trackingId;
    state.message = `${hit.trackingId} · ${hit.recipient?.name || "receiver"}: check the collection code, then confirm the hand-over.`;
    paint();
    DF.scanner?.feedback?.("collectScan", true);
    $("collectCode")?.focus();
  }
  window.addEventListener(
    "submit",
    event => {
      if (event.target.id !== "collectScanForm") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      findWaiting($("collectScan").value);
    },
    true,
  );

  // Only on its own Hub desk tab (Ops.hubPart, bridge-nav.js). Loaded once when the tab opens, then
  // after live parcel changes; redraws of the page reuse what was loaded.
  const baseHubs = Ops.enhance.Hubs;
  Ops.enhance.Hubs = page => {
    baseHubs?.(page);
    $("collectCounter")?.remove();
    if (Ops.hubPart !== "collect") return;
    if (!state.hubId || !hubs().some(h => h.id === state.hubId)) state.hubId = hubs()[0]?.id || null;
    $("mainContent").insertAdjacentHTML("beforeend", markup());
    const scan = $("collectScan");
    if (scan) DF.scanner?.attach(scan, { title: "Scan the parcel label", onScan: () => $("collectScanForm")?.requestSubmit() });
    if (state.epoch !== Ops.navEpoch || state.loadedFor !== state.hubId) {
      state.epoch = Ops.navEpoch;
      void load();
    }
  };
  let liveTimer = null;
  DF.events?.on?.("parcel.updated", () => {
    if (!$("collectCounter")) return;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => void load(), 800);
  });

  const photo = file =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

  window.addEventListener(
    "click",
    async event => {
      const t = event.target;
      if (!(t instanceof Element) || !t.closest("#collectCounter")) return;
      const open = t.closest("[data-collect-open]");
      if (open) {
        event.preventDefault();
        state.handing = open.dataset.collectOpen;
        state.message = "";
        return paint();
      }
      if (t.closest("[data-collect-cancel]")) {
        state.handing = null;
        return paint();
      }
      const resend = t.closest("[data-collect-resend]");
      if (resend) {
        resend.disabled = true;
        try {
          await DF.api(`/parcels/${encodeURIComponent(resend.dataset.collectResend)}/collection-code`, { method: "POST" });
          state.message = `A new collection code was sent to the receiver of ${resend.dataset.collectResend}.`;
        } catch (error) {
          state.message = DF.describe(error);
        }
        paint();
      }
    },
    true,
  );
  window.addEventListener("change", event => {
    if (event.target.id !== "collectHub") return;
    state.hubId = event.target.value;
    state.handing = null;
    void load();
  });
  window.addEventListener(
    "submit",
    async event => {
      if (event.target.id !== "collectForm") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const form = event.target;
      const id = form.dataset.tracking;
      const code = $("collectCode").value.trim();
      const file = $("collectPhoto").files?.[0];
      if (!code && !file) return void ((state.message = "Enter the collection code, or take a photo of the receiver's ID."), paint());
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        await DF.api(`/parcels/${encodeURIComponent(id)}/collect`, {
          method: "POST",
          body: { receivedBy: $("collectBy").value.trim(), codCollected: Number($("collectCod").value) || 0, ...(code ? { code } : { proof: { method: "PHOTO", image: await photo(file) } }) },
        });
        state.handing = null;
        state.message = `${id} handed over.`;
        await load();
      } catch (error) {
        state.message = DF.describe(error);
        paint();
      }
    },
    true,
  );
})();
