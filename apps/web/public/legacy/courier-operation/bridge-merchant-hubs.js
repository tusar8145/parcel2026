/*
 * Courier Operations → Merchants: every merchant belongs to the hub serving its pickup address (derived, never
 * set by hand; change the address and the hub follows).
 * - HUB column (the hub serving the merchant's pickup address) and a hub filter (All hubs / a hub / No hub).
 * - The table's cells are shown as text (merchant names and addresses can't inject markup).
 * - "Address changes to approve": active merchants' own address changes (GET /merchant-address-requests),
 *   approve or reject with a reason (POST …/:id/approve | reject).
 * - "Change address" per merchant (PATCH /merchants/:id/address): district → zone → area → street.
 * Approving and changing need merchant:address (operations managers, super admins: Ops.can("merchantAddress")).
 */
(() => {
  const DF = window.DF;
  const Ops = window.DFOps;
  if (!DF || !Ops || typeof genericPages !== "object" || !genericPages.Merchants) return;
  const PAGE = "Merchants";
  const $ = id => document.getElementById(id);
  const esc = Ops.esc;
  const state = { hub: "", shown: [] };
  /** The page draws cells as HTML: names and addresses typed by merchants are shown as text (the CSV keeps "&"). */
  const asText = cell => String(cell ?? "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const can = () => Ops.can("merchantAddress");
  const pickupText = m => (m ? `${m.pickupZone || m.pickupArea}, ${m.pickupDistrict}${m.pickupZone ? "" : " (address not completed)"}${m.handover === "HUB_DROP" ? " · drops at hub" : ""}` : "");
  const loadRequests = () => (can() ? Ops.lazy("address-requests", () => DF.api("/merchant-address-requests"), 20000) : null);

  // Rows: PICKUP and HUB as their own columns, filtered by hub.
  const basePrepare = Ops.prepare[PAGE];
  Ops.prepare[PAGE] = (...args) => {
    basePrepare?.(...args);
    const cfg = genericPages[PAGE];
    const all = Ops.cache.merchants?.value || [];
    const i = cfg.cols.indexOf("PICKUP & HUB");
    if (i < 0) return void (cfg.rows = cfg.rows.map(row => row.map(asText)));
    cfg.cols.splice(i, 1, "PICKUP", "HUB");
    let pairs = cfg.rows.map((row, k) => ({ m: all[k], row: [...row.slice(0, i), pickupText(all[k]), all[k]?.pickupHub?.name || "No hub", ...row.slice(i + 1)].map(asText) }));
    if (state.hub) pairs = pairs.filter(p => (state.hub === "none" ? !p.m?.pickupHub : p.m?.pickupHub?.id === state.hub));
    cfg.rows = pairs.map(p => p.row);
    state.shown = pairs.map(p => p.m);
    loadRequests();
  };

  const baseEnhance = Ops.enhance[PAGE];
  Ops.enhance[PAGE] = (...args) => {
    baseEnhance?.(...args);
    if (Ops.page() !== PAGE) return;
    const panel = document.querySelector("#mainContent .table-panel");
    if (!panel) return;
    // Hub filter beside the search.
    const tools = panel.querySelector(".table-tools") || panel.querySelector(".panel-heading");
    if (tools && !$("merchantHubFilter")) {
      const hubs = DF.state.hubs || [];
      tools.insertAdjacentHTML(
        "beforeend",
        `<select class="select-small" id="merchantHubFilter" aria-label="Filter by hub"><option value="">All hubs</option>${hubs.map(h => `<option value="${esc(h.id)}" ${state.hub === h.id ? "selected" : ""}>${esc(h.name)}</option>`).join("")}<option value="none" ${state.hub === "none" ? "selected" : ""}>No hub</option></select>`,
      );
    }
    // Change address, per row (the rows are in the order of state.shown).
    if (can())
      panel.querySelectorAll("tbody tr").forEach((tr, k) => {
        const m = state.shown[k];
        if (!m || tr.querySelector("[data-merchant-address]")) return;
        tr.dataset.merchantId = m.id;
        tr.lastElementChild?.insertAdjacentHTML("beforeend", ` <button type="button" class="mini-button" data-merchant-address="${esc(m.id)}" title="The merchant's hub follows its pickup address">Change address</button>`);
      });
    // Address changes waiting for approval.
    const requests = loadRequests();
    $("addressRequestsPanel")?.remove();
    if (can() && requests?.items?.length) {
      const rows = requests.items
        .map(
          r =>
            `<tr data-address-request="${esc(r.id)}"><td><strong>${esc(r.merchant?.name || "—")}</strong><span class="subcell">${esc(r.merchant?.code || "")}</span></td><td>${esc(r.previous?.pickup || "—")}</td><td><strong>${esc(r.proposed?.pickup || "—")}</strong></td><td>${
              r.hubChanges ? `${esc(r.previousHub?.name || "No hub")} → <strong>${esc(r.proposedHub?.name || "No hub")}</strong>` : esc(r.previousHub?.name || "No hub")
            }</td><td>${esc(Ops.when(r.createdAt))}<span class="subcell">${esc(r.requestedBy)}</span></td><td style="white-space:nowrap"><button class="button button-sm button-primary" data-address-approve="${esc(r.id)}">Approve</button> <button class="button button-sm" data-address-reject="${esc(r.id)}">Reject</button></td></tr>`,
        )
        .join("");
      panel.insertAdjacentHTML(
        "beforebegin",
        `<section class="panel table-panel" id="addressRequestsPanel"><div class="panel-heading"><div><h2 class="panel-title">Address changes to approve (${requests.items.length})</h2><p class="panel-subtitle">Merchants asked to change their address. Approved, the new address applies and the merchant moves to the hub serving it.</p></div></div><div class="table-scroll"><table><thead><tr><th>MERCHANT</th><th>CURRENT PICKUP</th><th>NEW PICKUP</th><th>HUB</th><th>ASKED</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></section>`,
      );
    }
  };

  const refresh = () => {
    Ops.invalidate("merchants", "address-requests");
    if (Ops.page() === PAGE) Ops.rerender(true);
  };

  // ───────────── change address dialog ─────────────

  let catalog = null;
  async function openAddress(merchantId) {
    const m = (Ops.cache.merchants?.value || []).find(x => x.id === merchantId);
    if (!m) return;
    catalog ??= await DF.api("/catalog").catch(() => null);
    if (!catalog) return showToast("The district list couldn't be loaded. Try again.");
    document.getElementById("dfMerchantAddress")?.remove();
    const options = (list, selected, placeholder) => `<option value="">${esc(placeholder)}</option>${list.map(v => `<option ${v === selected ? "selected" : ""}>${esc(v)}</option>`).join("")}`;
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div class="modal-backdrop open" id="dfMerchantAddress" style="position:fixed;inset:0;background:rgba(15,23,42,.45);display:grid;place-items:center;z-index:1200;padding:16px"><form class="modal" style="background:#fff;border-radius:14px;max-width:560px;width:100%;padding:20px;display:grid;gap:12px" novalidate>
        <div><h2 style="margin:0;font-size:18px">Change pickup address</h2><p style="margin:4px 0 0;color:#64748b;font-size:13px">${esc(m.name)} · ${esc(m.code)}. The merchant's hub follows the new address.</p></div>
        <label style="display:grid;gap:4px;font-size:12.5px;font-weight:600">District *<select id="maDistrict" required>${options(catalog.districts || [], m.pickupDistrict, "Choose the district")}</select></label>
        <label style="display:grid;gap:4px;font-size:12.5px;font-weight:600">Zone (thana / upazila) *<select id="maZone" required>${options(catalog.zonesByDistrict?.[m.pickupDistrict] || [], m.pickupZone, "Choose the zone")}</select></label>
        <label style="display:grid;gap:4px;font-size:12.5px;font-weight:600"><span id="maAreaLabel">Area</span><select id="maArea">${options(catalog.areasByZone?.[m.pickupZone] || [], m.pickupArea, "—")}</select></label>
        <label style="display:grid;gap:4px;font-size:12.5px;font-weight:600">Street address *<input id="maStreet" value="${esc(m.pickupAddress || "")}" placeholder="House, road, building" required minlength="5"></label>
        <p id="maHub" style="margin:0;font-size:13px;color:#344054"></p><p id="maError" role="alert" style="margin:0;color:#b42318;font-size:13px"></p>
        <div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="button" data-ma-close>Cancel</button><button type="submit" class="button button-primary" id="maSave">Save address</button></div>
      </form></div>`,
    );
    const box = $("dfMerchantAddress");
    const fill = (select, list, placeholder) => (select.innerHTML = options(list, "", placeholder));
    // A zone that lists areas needs one (the merchant address rule); otherwise there's nothing to choose.
    const areasOf = () => catalog.areasByZone?.[$("maZone").value] || [];
    const markArea = () => ($("maAreaLabel").textContent = areasOf().length ? "Area *" : "Area (none listed)");
    const showHub = async () => {
      const d = $("maDistrict").value;
      const z = $("maZone").value;
      if (!d || !z) return void ($("maHub").textContent = "");
      const r = await DF.api(`/merchants/pickup-hub?district=${encodeURIComponent(d)}&zone=${encodeURIComponent(z)}`).catch(() => null);
      $("maHub").innerHTML = r?.hub ? `Hub: <strong>${esc(r.hub.name)}</strong>` : "No hub serves this zone yet.";
    };
    box.addEventListener("change", e => {
      if (e.target.id === "maDistrict") (fill($("maZone"), catalog.zonesByDistrict?.[e.target.value] || [], "Choose the zone"), fill($("maArea"), [], "—"));
      if (e.target.id === "maZone") fill($("maArea"), catalog.areasByZone?.[e.target.value] || [], "Choose the area");
      if (e.target.id === "maDistrict" || e.target.id === "maZone") markArea();
      if (e.target.id === "maDistrict" || e.target.id === "maZone") void showHub();
    });
    box.addEventListener("click", e => e.target.closest("[data-ma-close]") && box.remove());
    box.querySelector("form").addEventListener("submit", async e => {
      e.preventDefault();
      const district = $("maDistrict").value;
      const zone = $("maZone").value;
      const street = $("maStreet").value.trim();
      $("maError").textContent = !district ? "Choose the district." : !zone ? "Choose the zone." : areasOf().length && !$("maArea").value ? "Choose the area." : street.length < 5 ? "Enter the street address (at least 5 characters)." : "";
      if ($("maError").textContent) return;
      $("maSave").disabled = true;
      try {
        const saved = await DF.api(`/merchants/${encodeURIComponent(m.id)}/address`, { method: "PATCH", body: { pickupSameAsBusiness: false, pickup: { district, zone, area: $("maArea").value || undefined, street } } });
        box.remove();
        showToast(`${m.name}: address saved.${saved.pickupHub ? ` Hub: ${saved.pickupHub.name}.` : " No hub serves the new zone yet."}`);
        refresh();
      } catch (error) {
        $("maError").textContent = DF.describe(error);
        $("maSave").disabled = false;
      }
    });
    markArea();
    void showHub();
  }

  // ───────────── events ─────────────

  window.addEventListener(
    "click",
    event => {
      if (Ops.page() !== PAGE || !(event.target instanceof Element)) return;
      let el;
      if ((el = event.target.closest("[data-merchant-address]"))) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return void openAddress(el.dataset.merchantAddress);
      }
      if ((el = event.target.closest("[data-address-approve]"))) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const id = el.dataset.addressApprove;
        el.disabled = true;
        return void DF.api(`/merchant-address-requests/${id}/approve`, { method: "POST" }).then(
          r => (showToast(`${r.merchant?.name || "Merchant"}: address change approved.${r.hubChanges ? ` Hub: ${r.proposedHub?.name || "none yet"}.` : ""}`), refresh()),
          error => ((el.disabled = false), showToast(DF.describe(error))),
        );
      }
      if ((el = event.target.closest("[data-address-reject]"))) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const id = el.dataset.addressReject;
        return void DF.prompt({ title: "Reject the address change?", message: "The merchant gets this reason by SMS and email.", label: "Reason", required: true, multiline: true, confirm: "Reject" }).then(note => {
          if (!note) return;
          void DF.api(`/merchant-address-requests/${id}/reject`, { method: "POST", body: { note } }).then(
            r => (showToast(`${r.merchant?.name || "Merchant"}: address change rejected.`), refresh()),
            error => showToast(DF.describe(error)),
          );
        });
      }
    },
    true,
  );
  document.addEventListener("change", event => {
    if (Ops.page() !== PAGE || event.target?.id !== "merchantHubFilter") return;
    state.hub = event.target.value;
    Ops.rerender(true);
  });
  // Menu › Merchants: how many address changes wait for approval (an amber badge; none = hidden).
  async function paintBadge() {
    const item = document.querySelector('#navigation [data-nav="Merchants"]');
    if (!item || !can()) return;
    let n = 0;
    try {
      n = (await DF.api("/merchant-address-requests")).items?.length || 0;
    } catch {
      return;
    }
    let badge = document.getElementById("navAddressCount");
    if (!badge) {
      item.insertAdjacentHTML("beforeend", `<span class="nav-count" id="navAddressCount" style="background:#fff5df;color:#b87913" title="Address changes to approve"></span>`);
      badge = document.getElementById("navAddressCount");
    }
    badge.textContent = String(n);
    badge.hidden = !n;
    badge.setAttribute("aria-label", `${n} address change${n === 1 ? "" : "s"} to approve`);
  }
  // After the panel knows who is signed in (Ops.me, from /ops/overview).
  let tries = 0;
  const whenReady = () => (Ops.me ? void paintBadge() : ++tries < 60 && setTimeout(whenReady, 500));
  whenReady();

  DF.live?.(["merchant.address_request", "merchant.updated"], () => {
    Ops.invalidate("merchants", "address-requests");
    if (Ops.page() === PAGE) Ops.rerender();
    void paintBadge();
  });

  // The address holds the full address: its district / zone / area are picked from it (shared/api.js DF.autoPlace).
  window.DF?.autoPlace?.({ street: "maStreet", district: "maDistrict", zone: "maZone", area: "maArea" });
})();
