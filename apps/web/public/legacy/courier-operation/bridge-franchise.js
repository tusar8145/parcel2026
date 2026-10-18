/*
 * Courier Operations × franchise hubs (docs/architecture-contracts.md "Franchise hubs"):
 * - Hub register: franchise hubs carry a "Franchise" tag.
 * - Assign dialog: franchise riders are labelled (operations managers see them; hub staff don't get them from the
 *   API); a waiting pickup can be handed to a franchise hub (POST /parcels/:id/pickup-hub), which assigns its rider.
 * - COD & finance: franchise deposits to confirm at your hub (GET/POST /franchise-deposits…), and for finance the
 *   franchise commission invoices to approve and pay (maker-checker; /franchise-invoices…).
 */
(() => {
  const DF = window.DF;
  const Ops = window.DFOps;
  if (!DF || !Ops) return;
  const $ = id => document.getElementById(id);
  const esc = Ops.esc;
  const TAG = `<span class="df-franchise-tag" style="display:inline-flex;margin-left:6px;padding:1px 7px;border-radius:999px;background:#fff5df;color:#b87913;font-size:10.5px;font-weight:700;vertical-align:middle">Franchise</span>`;
  const franchiseHubs = () => (DF.state.hubs || []).filter(h => h.type === "FRANCHISE" && h.active);
  const isFranchiseHub = id => (DF.state.hubs || []).some(h => h.id === id && h.type === "FRANCHISE");

  // ───────────── hub register tag ─────────────
  const tagHubs = () => {
    for (const row of document.querySelectorAll("#mainContent tr[data-hub-row]")) {
      if (row.querySelector(".df-franchise-tag") || !isFranchiseHub(row.dataset.hubRow)) continue;
      row.querySelector("td strong")?.insertAdjacentHTML("afterend", TAG);
    }
  };
  const main = $("mainContent");
  if (main) new MutationObserver(tagHubs).observe(main, { childList: true, subtree: true });

  // ───────────── assign dialog ─────────────
  const previousOpenModal = openModal;
  openModal = function (kind, shipmentId) {
    previousOpenModal(kind, shipmentId);
    if (kind === "assign") setTimeout(() => enhanceAssign(shipmentId), 0);
  };

  function labelRiders() {
    const select = $("assignRider");
    if (!select) return;
    for (const option of select.options) {
      const rider = (DF.state.riders || []).find(r => r.id === option.value);
      if (rider?.hub?.type === "FRANCHISE" && !option.dataset.franchise) {
        option.dataset.franchise = "1";
        option.textContent = `${option.textContent} · Franchise (${rider.hub.name})`;
      }
    }
  }

  function enhanceAssign(shipmentId) {
    labelRiders();
    new MutationObserver(labelRiders).observe($("assignRider") || document.body, { childList: true });
    $("dfPickupHub")?.remove();
    const id = shipmentId || $("assignShipment")?.value;
    const parcel = id && Ops.apiParcel(id);
    const hubs = franchiseHubs();
    if (!parcel || parcel.status !== "PENDING_CONFIRMATION" || parcel.intake === "DROP_OFF" || !hubs.length || !Ops.can("dispatch")) return;
    const fields = $("modalFields");
    fields?.insertAdjacentHTML(
      "beforeend",
      `<div class="field full" id="dfPickupHub" style="border-top:1px solid #eef1f5;padding-top:12px;margin-top:4px"><label for="dfPickupHubSelect">Or hand this pickup to a franchise hub</label><div style="display:flex;gap:8px;flex-wrap:wrap"><select id="dfPickupHubSelect" style="flex:1;min-width:200px">${hubs.map(h => `<option value="${esc(h.id)}">${esc(h.name)} · ${esc(h.district)}</option>`).join("")}</select><button type="button" class="button" id="dfPickupHubGo">Hand to franchise</button></div><small style="color:#7b8796">The franchise assigns one of its own riders.</small></div>`,
    );
  }

  window.addEventListener(
    "click",
    event => {
      if (!(event.target instanceof Element) || !event.target.closest("#dfPickupHubGo")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const id = $("assignShipment")?.value;
      const hubId = $("dfPickupHubSelect")?.value;
      const hub = (DF.state.hubs || []).find(h => h.id === hubId);
      if (!id || !hubId) return;
      closeModal();
      void Ops.act(DF.api(`/parcels/${encodeURIComponent(id)}/pickup-hub`, { method: "POST", body: { hubId } }), `${id} handed to ${hub?.name || "the franchise"}; it assigns its rider.`);
    },
    true,
  );

  // ───────────── COD & finance: deposits and invoices ─────────────
  const previousEnhance = Ops.enhance["COD & finance"];
  Ops.enhance["COD & finance"] = (...args) => {
    previousEnhance?.(...args);
    if (Ops.page() !== "COD & finance") return;
    const html = [];
    if (Ops.can("receiveCash") || Ops.can("financeStaff")) {
      const deposits = Ops.lazy("franchise-deposits", () => DF.api("/franchise-deposits?status=PENDING"), 20000) || [];
      html.push(
        `<section class="panel table-panel" id="frDepositsPanel"><div class="panel-heading"><div><h2 class="panel-title">Franchise deposits</h2><p class="panel-subtitle">Cash franchise hubs bring to ${Ops.me?.hubIds ? "your hub" : "Delivery Fast hubs"}: count it and confirm the exact amount.</p></div></div><div class="table-scroll"><table><thead><tr><th>DEPOSIT</th><th>FRANCHISE</th><th>TO HUB</th><th>CASH</th><th>COMMISSION KEPT</th><th>TO RECEIVE</th><th></th></tr></thead><tbody>${
          deposits
            .map(
              d =>
                `<tr data-fr-deposit="${esc(d.number)}"><td><strong>${esc(d.number)}</strong><span class="subcell">${esc(Ops.when(d.requestedAt))}</span></td><td>${esc(d.franchise.name)}${TAG}<span class="subcell">${esc(d.franchise.hub)}</span></td><td>${esc(d.hub.name)}</td><td>${Ops.money(d.gross)}</td><td>${d.commissionDeducted ? Ops.money(d.commissionDeducted) : "—"}</td><td><strong>${Ops.money(d.net)}</strong></td><td><button class="button button-sm button-primary" data-fr-receive="${esc(d.id)}" data-amount="${d.net}">Receive ${Ops.money(d.net)}</button></td></tr>`,
            )
            .join("") || `<tr><td colspan="7" class="empty-state">${Ops.lazyError("franchise-deposits") ? esc(DF.describe(Ops.lazyError("franchise-deposits"))) : "No franchise deposit waiting."}</td></tr>`
        }</tbody></table></div></section>`,
      );
    }
    if (Ops.can("financeStaff")) {
      const invoices = Ops.lazy("franchise-invoices", () => DF.api("/franchise-invoices"), 20000) || [];
      const open = invoices.filter(i => i.status === "ISSUED" || i.status === "APPROVED");
      html.push(
        `<section class="panel table-panel" id="frInvoicesPanel"><div class="panel-heading"><div><h2 class="panel-title">Franchise commission invoices</h2><p class="panel-subtitle">Approve (a second finance user than the maker) and pay franchise commission billed in BILL mode.</p></div><button class="button button-sm" id="frRunBilling">Bill due franchises now</button></div><div class="table-scroll"><table><thead><tr><th>INVOICE</th><th>FRANCHISE</th><th>PERIOD</th><th>AMOUNT</th><th>STATUS</th><th></th></tr></thead><tbody>${
          open
            .map(
              i =>
                `<tr data-fr-invoice="${esc(i.number)}"><td><strong>${esc(i.number)}</strong><span class="subcell">${esc(Ops.when(i.createdAt))}</span></td><td>${esc(i.franchise.name)}${TAG}<span class="subcell">${esc(i.franchise.hub)}</span></td><td>${esc(new Date(i.periodFrom).toLocaleDateString("en-GB"))} – ${esc(new Date(i.periodTo).toLocaleDateString("en-GB"))}</td><td>${Ops.money(i.amount)}</td><td>${esc(i.status === "ISSUED" ? "To approve" : "Approved · to pay")}</td><td style="white-space:nowrap"><button class="button button-sm" data-fr-pdf="${esc(i.id)}">PDF</button> ${i.status === "ISSUED" ? `<button class="button button-sm button-primary" data-fr-approve="${esc(i.id)}">Approve</button>` : `<button class="button button-sm button-primary" data-fr-pay="${esc(i.id)}" data-amount="${i.amount}">Pay</button>`}</td></tr>`,
            )
            .join("") || `<tr><td colspan="6" class="empty-state">${Ops.lazyError("franchise-invoices") ? esc(DF.describe(Ops.lazyError("franchise-invoices"))) : "No franchise invoice to approve or pay."}</td></tr>`
        }</tbody></table></div></section>`,
      );
    }
    if (html.length) $("mainContent").insertAdjacentHTML("beforeend", html.join(""));
  };

  const after = keys => {
    Ops.invalidate(...keys);
    Ops.rerender(true);
  };
  window.addEventListener(
    "click",
    event => {
      const t = event.target instanceof Element ? event.target : null;
      if (!t) return;
      let el;
      if ((el = t.closest("[data-fr-receive]"))) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const amount = Number(el.dataset.amount);
        void DF.confirm({ title: "Receive the franchise deposit?", message: `Confirm you counted ${Ops.money(amount)} in cash.`, confirm: `Received ${Ops.money(amount)}` }).then(
          ok =>
            ok &&
            DF.api(`/franchise-deposits/${el.dataset.frReceive}/receive`, { method: "POST", body: { amountReceived: amount } }).then(
              d => (showToast(`${d.number}: ${Ops.money(d.net)} received from ${d.franchise.name}.`), after(["franchise-deposits", "finance-summary"])),
              error => showToast(DF.describe(error)),
            ),
        );
        return;
      }
      if ((el = t.closest("[data-fr-approve]"))) {
        event.preventDefault();
        event.stopImmediatePropagation();
        void DF.api(`/franchise-invoices/${el.dataset.frApprove}/approve`, { method: "POST" }).then(
          i => (showToast(`${i.number} approved.`), after(["franchise-invoices"])),
          error => showToast(DF.describe(error)),
        );
        return;
      }
      if ((el = t.closest("[data-fr-pay]"))) {
        event.preventDefault();
        event.stopImmediatePropagation();
        void DF.prompt({ title: "Pay the franchise commission", message: `${Ops.money(Number(el.dataset.amount))} by bank transfer. Enter the payment reference.`, label: "Payment reference", required: true, confirm: "Mark as paid" }).then(reference => {
          if (!reference) return;
          void DF.api(`/franchise-invoices/${el.dataset.frPay}/pay`, { method: "POST", body: { method: "BANK", reference } }).then(
            i => (showToast(`${i.number} paid.`), after(["franchise-invoices"])),
            error => showToast(DF.describe(error)),
          );
        });
        return;
      }
      if ((el = t.closest("[data-fr-pdf]"))) {
        event.preventDefault();
        event.stopImmediatePropagation();
        void window.DFPrint?.open(`/franchise-invoices/${el.dataset.frPdf}/pdf`, { title: "Preparing the invoice…" });
        return;
      }
      if (t.closest("#frRunBilling")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        void DF.api("/franchise-invoices/run", { method: "POST" }).then(
          r => (showToast(r.created.length ? `Invoiced: ${r.created.join(", ")}` : "No franchise is due for an invoice (or the settlement mode is Deduct)."), after(["franchise-invoices"])),
          error => showToast(DF.describe(error)),
        );
      }
    },
    true,
  );
  DF.live?.(["franchise.cash"], () => {
    Ops.invalidate("franchise-deposits", "franchise-invoices");
    if (Ops.page() === "COD & finance") Ops.rerender();
  });
})();
