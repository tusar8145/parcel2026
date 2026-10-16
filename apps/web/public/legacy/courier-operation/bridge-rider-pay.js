/*
 * Courier Operations → COD & finance: riders' cash handover requests and rider payouts.
 *
 * - Cash handover requests (cod:receive, scoped to the cashier's hubs): riders ask a hub to
 *   receive their COD cash from the rider app. "Receive" counts the cash against exactly the
 *   requested collections (POST /cod/handovers), then links the handover to the request
 *   (POST /cod/handover-requests/:id/complete). "Decline" cancels the request.
 * - Rider payouts (finance, or rider:manage): prepare payouts for a period from riders' unpaid
 *   earnings (POST /rider-payouts/runs), approve (a different person: maker-checker), and
 *   finance marks them paid (ledger RIDER_PAYOUT_PAID, the rider gets an SMS).
 */
(() => {
  const DF = window.DF;
  const Ops = window.DFOps;
  const $ = id => document.getElementById(id);
  const esc = Ops.esc;
  const PAGE = "COD & finance";
  const PAYOUT = { DRAFT: ["To approve", "status-pending"], APPROVED: ["Ready to pay", "status-transit"], PAID: ["Paid", "status-delivered"], CANCELLED: ["Cancelled", "status-failed"] };
  const METHODS = ["BKASH", "NAGAD", "ROCKET", "BANK_TRANSFER", "CASH"];
  const tag = ([text, cls]) => `<span class="status ${cls}">${esc(text)}</span>`;
  const canPay = () => Ops.can("manageFinance") || Ops.can("manageRiders");

  const requests = () => (Ops.can("receiveCash") ? Ops.lazy("handover-requests", () => DF.api("/cod/handover-requests"), 20000) : null);
  const payouts = () => (canPay() ? Ops.lazy("rider-payouts", () => DF.api("/rider-payouts?limit=30"), 30000) : null);

  function requestsPanel() {
    const rows = requests();
    const error = Ops.lazyError("handover-requests");
    const body =
      (rows || [])
        .map(
          r =>
            `<tr><td><strong>${esc(r.rider.code)} · ${esc(r.rider.name)}</strong><span class="subcell">${esc(DF.localPhone(r.rider.phone))}</span></td><td>${esc(r.hub.name)}</td><td>${r.collections}</td><td>${Ops.money(r.amount)}</td><td>${esc(Ops.ago(r.createdAt))}${r.note ? `<span class="subcell">${esc(r.note)}</span>` : ""}</td><td style="white-space:nowrap"><button class="button button-sm" data-handover-request="${esc(r.id)}">Receive</button> <button class="button button-sm" data-handover-decline="${esc(r.id)}">Decline</button></td></tr>`,
        )
        .join("") || `<tr><td colspan="6" class="empty-state">${error ? esc(DF.describe(error)) : rows ? "No riders are waiting to hand over cash." : "Loading…"}</td></tr>`;
    return `<section class="panel table-panel" id="handoverRequestsPanel"><div class="panel-heading"><div><h2 class="panel-title">Cash handover requests</h2><p class="panel-subtitle">Riders on their way to hand over COD cash · receive it against the requested collections</p></div></div><div class="table-scroll"><table><thead><tr><th>RIDER</th><th>HUB</th><th>COLLECTIONS</th><th>AMOUNT</th><th>REQUESTED</th><th></th></tr></thead><tbody>${body}</tbody></table></div></section>`;
  }

  function payoutsPanel() {
    const page = payouts();
    const error = Ops.lazyError("rider-payouts");
    const me = DF.auth.user.id;
    const body =
      (page?.items || [])
        .map(p => {
          const actions = [];
          if (p.status === "DRAFT" && p.createdById !== me) actions.push(`<button class="button button-sm" data-payout-approve="${esc(p.id)}">Approve</button>`);
          if (p.status === "APPROVED" && Ops.can("manageFinance")) actions.push(`<button class="button button-sm" data-payout-pay="${esc(p.id)}">Mark paid</button>`);
          if (p.status === "DRAFT" || p.status === "APPROVED") actions.push(`<button class="button button-sm" data-payout-cancel="${esc(p.id)}">Cancel</button>`);
          return `<tr><td><strong>${esc(p.number)}</strong><span class="subcell">${p.earnings} lines</span></td><td>${esc(p.rider.code)} · ${esc(p.rider.name)}</td><td>${esc(new Date(p.periodStart).toLocaleDateString("en-US", { month: "short", day: "numeric" }))} – ${esc(new Date(new Date(p.periodEnd).getTime() - 1).toLocaleDateString("en-US", { month: "short", day: "numeric" }))}</td><td>${Ops.money(p.amount)}</td><td>${tag(PAYOUT[p.status] || [p.status, "status-pending"])}${p.paymentReference ? `<span class="subcell">${esc(p.paymentMethod)} · ${esc(p.paymentReference)}</span>` : ""}</td><td style="white-space:nowrap">${actions.join(" ") || (p.status === "DRAFT" ? `<span class="subcell">Another person approves</span>` : "")}</td></tr>`;
        })
        .join("") || `<tr><td colspan="6" class="empty-state">${error ? esc(DF.describe(error)) : page ? "No rider payouts yet." : "Loading…"}</td></tr>`;
    return `<section class="panel table-panel" id="riderPayoutsPanel"><div class="panel-heading"><div><h2 class="panel-title">Rider payouts</h2><p class="panel-subtitle">Riders' earnings ledger · prepared, approved by someone else, then paid by finance</p></div><button class="button button-sm" data-payout-run>Prepare payouts</button></div><div class="table-scroll"><table><thead><tr><th>PAYOUT</th><th>RIDER</th><th>PERIOD</th><th>AMOUNT</th><th>STATUS</th><th></th></tr></thead><tbody>${body}</tbody></table></div></section>`;
  }

  const baseEnhance = Ops.enhance[PAGE];
  Ops.enhance[PAGE] = page => {
    baseEnhance?.(page);
    $("handoverRequestsPanel")?.remove();
    $("riderPayoutsPanel")?.remove();
    if (Ops.can("receiveCash")) {
      // Above the "Rider cash on hand" table, when there is one.
      const anchor = $("codRiderCash");
      if (anchor) anchor.insertAdjacentHTML("beforebegin", requestsPanel());
      else $("mainContent").insertAdjacentHTML("beforeend", requestsPanel());
    }
    if (canPay()) $("mainContent").insertAdjacentHTML("beforeend", payoutsPanel());
  };

  // ───────────── receive a requested handover ─────────────

  let current = null;
  Ops.modals.handoverRequest = id => {
    if (!Ops.require("receiveCash", "receive rider cash")) return;
    current = (requests() || []).find(r => r.id === id);
    if (!current) return void showToast("That request is no longer pending.");
    modalContext = { kind: "handoverRequest", shipmentId: id };
    $("modalTitle").textContent = `Receive cash · ${current.rider.code} · ${current.rider.name}`;
    $("modalDescription").textContent = `Requested ${Ops.ago(current.createdAt)} at ${current.hub.name}: ${current.collections} collection${current.collections === 1 ? "" : "s"} totalling ${Ops.money(current.amount)}. Count the cash before recording it.`;
    $("modalSubmit").textContent = "Record handover";
    $("modalFields").innerHTML = `<div class="field"><label for="requestAmount">Cash counted (৳)</label><input id="requestAmount" type="number" min="0" step="0.01" inputmode="decimal" required placeholder="${esc(String(current.amount))}"></div><div class="field"><label>Hub</label><input value="${esc(current.hub.name)}" disabled></div>${
      current.note ? `<div class="field full"><label>Rider's note</label><input value="${esc(current.note)}" disabled></div>` : ""
    }<div class="field full"><label for="requestNote">Note (optional)</label><textarea id="requestNote" maxlength="500" placeholder="e.g. Counted with the rider at the counter"></textarea></div>`;
    $("modalBackdrop").classList.add("open");
    $("requestAmount").focus();
  };

  window.addEventListener(
    "submit",
    event => {
      if (event.target.id !== "modalForm" || modalContext.kind !== "handoverRequest" || !current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const request = current;
      const amountReceived = $("requestAmount").value.trim();
      if (!amountReceived) return void $("requestAmount").focus();
      const button = $("modalSubmit");
      button.disabled = true;
      const body = { riderId: request.rider.id, hubId: request.hub.id, collectionIds: request.collectionIds, amountReceived, note: $("requestNote").value.trim() || undefined };
      DF.api("/cod/handovers", { method: "POST", body })
        .then(h => DF.api(`/cod/handover-requests/${request.id}/complete`, { method: "POST", body: { handoverId: h.id } }).then(() => h))
        .then(async h => {
          closeModal();
          Ops.invalidate("handover-requests", "cod-riders", "handovers", "finance-summary");
          await Ops.refresh().catch(() => undefined);
          showToast(`${Ops.money(h.amount)} received from ${request.rider.code} at ${request.hub.name}.`);
        })
        .catch(error => showToast(DF.describe(error)))
        .finally(() => (button.disabled = false));
    },
    true,
  );

  // ───────────── payouts ─────────────

  /** First day of this month in Dhaka (UTC+6) → now. */
  function thisMonth() {
    const now = new Date();
    const dhaka = new Date(now.getTime() + 6 * 3600_000);
    const start = new Date(Date.UTC(dhaka.getUTCFullYear(), dhaka.getUTCMonth(), 1) - 6 * 3600_000);
    return { start, end: now };
  }
  const dateInput = d => new Date(d.getTime() + 6 * 3600_000).toISOString().slice(0, 10);
  const fromDhakaDate = (text, endOfDay) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text || "")) return null;
    const d = new Date(`${text}T00:00:00+06:00`);
    return Number.isNaN(d.getTime()) ? null : new Date(d.getTime() + (endOfDay ? 86_400_000 : 0));
  };

  async function call(work, message) {
    try {
      const result = await work();
      Ops.invalidate("rider-payouts");
      Ops.rerender(true);
      showToast(typeof message === "function" ? message(result) : message);
    } catch (error) {
      showToast(DF.describe(error));
    }
  }

  window.addEventListener(
    "click",
    event => {
      const t = event.target;
      const receive = t.closest("[data-handover-request]");
      if (receive) {
        event.stopImmediatePropagation();
        return void openModal("handoverRequest", receive.dataset.handoverRequest);
      }
      const decline = t.closest("[data-handover-decline]");
      if (decline) {
        event.stopImmediatePropagation();
        if (!confirm("Decline this handover request? The rider keeps the cash and can ask again.")) return;
        return void DF.api(`/cod/handover-requests/${decline.dataset.handoverDecline}/cancel`, { method: "POST" })
          .then(() => {
            Ops.invalidate("handover-requests");
            Ops.rerender(true);
            showToast("Request declined.");
          })
          .catch(error => showToast(DF.describe(error)));
      }
      if (t.closest("[data-payout-run]")) {
        event.stopImmediatePropagation();
        const { start, end } = thisMonth();
        const from = fromDhakaDate(prompt("Pay period start (YYYY-MM-DD, Dhaka)", dateInput(start)), false);
        if (!from) return;
        const lastDay = prompt("Pay period end, inclusive (YYYY-MM-DD)", dateInput(new Date(end.getTime() - 1)));
        let to = fromDhakaDate(lastDay, true);
        if (!to) return;
        if (to > Date.now()) to = new Date();
        return void call(
          () => DF.api("/rider-payouts/runs", { method: "POST", body: { periodStart: from.toISOString(), periodEnd: to.toISOString() } }),
          r => `${r.created.length} payout${r.created.length === 1 ? "" : "s"} prepared (${Ops.money(r.total)})${r.skipped.length ? ` · ${r.skipped.length} rider${r.skipped.length === 1 ? "" : "s"} skipped` : ""}. Another person approves them.`,
        );
      }
      const approve = t.closest("[data-payout-approve]");
      if (approve) {
        event.stopImmediatePropagation();
        return void call(() => DF.api(`/rider-payouts/${approve.dataset.payoutApprove}/approve`, { method: "POST" }), p => `${p.number} approved.`);
      }
      const pay = t.closest("[data-payout-pay]");
      if (pay) {
        event.stopImmediatePropagation();
        const method = (prompt(`Payment method (${METHODS.join(", ")})`, "BKASH") || "").trim().toUpperCase().replace(/\s+/g, "_");
        if (!method) return;
        if (!METHODS.includes(method)) return void showToast(`Choose one of: ${METHODS.join(", ")}.`);
        const reference = (prompt("Transaction or reference number", "") || "").trim();
        if (!reference) return;
        return void call(() => DF.api(`/rider-payouts/${pay.dataset.payoutPay}/pay`, { method: "POST", body: { paymentMethod: method, paymentReference: reference } }), p => `${p.number} paid. The rider has been notified.`);
      }
      const cancel = t.closest("[data-payout-cancel]");
      if (cancel) {
        event.stopImmediatePropagation();
        if (!confirm("Cancel this payout? Its earnings become unpaid again.")) return;
        return void call(() => DF.api(`/rider-payouts/${cancel.dataset.payoutCancel}/cancel`, { method: "POST", body: {} }), p => `${p.number} cancelled.`);
      }
    },
    true,
  );

  DF.live(["cod.handover_request", "rider.payout"], async () => {
    Ops.invalidate("handover-requests", "rider-payouts", "cod-riders");
    if (Ops.page() === PAGE) Ops.rerender();
  });
})();
