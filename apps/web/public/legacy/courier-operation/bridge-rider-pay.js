/*
 * Courier Operations → Accounts › Rider pay: rider payouts (finance, or rider:manage). Prepare payouts for a period
 * from riders' unpaid earnings (POST /rider-payouts/runs), approve (a different person: maker-checker), and finance
 * marks them paid (the rider gets an SMS). Riders' COD cash goes through handover slips (bridge-accounts.js).
 */
(() => {
  const DF = window.DF;
  const Ops = window.DFOps;
  const $ = id => document.getElementById(id);
  const esc = Ops.esc;
  const PAYOUT = { DRAFT: ["To approve", "status-pending"], APPROVED: ["Ready to pay", "status-transit"], PAID: ["Paid", "status-delivered"], CANCELLED: ["Cancelled", "status-failed"] };
  const METHODS = ["BKASH", "NAGAD", "ROCKET", "BANK_TRANSFER", "CASH"];
  const tag = ([text, cls]) => `<span class="status ${cls}">${esc(text)}</span>`;
  const canPay = () => Ops.can("manageFinance") || Ops.can("manageRiders");

  const payouts = () => (canPay() ? Ops.lazy("rider-payouts", () => DF.api("/rider-payouts?limit=30"), 30000) : null);

  function payoutsPanel() {
    const page = payouts();
    const error = Ops.lazyError("rider-payouts");
    const me = DF.auth.user.id;
    const body =
      (page?.items || [])
        .map(p => {
          const actions = [];
          if (p.status === "DRAFT" && p.createdById !== me) actions.push(`<button class="button button-sm" data-payout-approve="${esc(p.id)}" data-number="${esc(p.number)}" data-rider="${esc(p.rider.code)} · ${esc(p.rider.name)}" data-amount="${esc(String(p.amount))}">Approve</button>`);
          if (p.status === "APPROVED" && Ops.can("manageFinance")) actions.push(`<button class="button button-sm" data-payout-pay="${esc(p.id)}" data-number="${esc(p.number)}" data-rider="${esc(p.rider.code)} · ${esc(p.rider.name)}" data-amount="${esc(String(p.amount))}">Mark paid</button>`);
          if (p.status === "DRAFT" || p.status === "APPROVED") actions.push(`<button class="button button-sm" data-payout-cancel="${esc(p.id)}" data-number="${esc(p.number)}" data-rider="${esc(p.rider.code)} · ${esc(p.rider.name)}" data-amount="${esc(String(p.amount))}">Cancel</button>`);
          return `<tr><td><strong>${esc(p.number)}</strong><span class="subcell">${p.earnings} lines</span></td><td>${esc(p.rider.code)} · ${esc(p.rider.name)}</td><td>${esc(new Date(p.periodStart).toLocaleDateString("en-US", { month: "short", day: "numeric" }))} – ${esc(new Date(new Date(p.periodEnd).getTime() - 1).toLocaleDateString("en-US", { month: "short", day: "numeric" }))}</td><td>${Ops.money(p.amount)}</td><td>${tag(PAYOUT[p.status] || [p.status, "status-pending"])}${p.paymentReference ? `<span class="subcell">${esc(p.paymentMethod)} · ${esc(p.paymentReference)}</span>` : ""}</td><td style="white-space:nowrap">${actions.join(" ") || (p.status === "DRAFT" ? `<span class="subcell">Another person approves</span>` : "")}</td></tr>`;
        })
        .join("") || `<tr><td colspan="6" class="empty-state">${error ? esc(DF.describe(error)) : page ? "No rider payouts yet." : "Loading…"}</td></tr>`;
    return `<section class="panel table-panel" id="riderPayoutsPanel"><div class="panel-heading"><div><h2 class="panel-title">Rider payouts</h2><p class="panel-subtitle">Riders' earnings ledger · prepared, approved by someone else, then paid by finance</p></div><button class="button button-sm" data-payout-run>Prepare payouts</button></div><div class="table-scroll"><table><thead><tr><th>PAYOUT</th><th>RIDER</th><th>PERIOD</th><th>AMOUNT</th><th>STATUS</th><th></th></tr></thead><tbody>${body}</tbody></table></div></section>`;
  }

  // Accounts › Rider pay draws this panel (bridge-accounts.js).
  Ops.riderPayoutsHtml = () => (canPay() ? payoutsPanel() : "");

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
      if (t.closest("[data-payout-run]")) {
        event.stopImmediatePropagation();
        const { start, end } = thisMonth();
        const DAY = /^\d{4}-\d{2}-\d{2}$/;
        return void Ops.form({
          title: "Prepare rider payouts",
          description: "Creates one payout per rider from their unpaid earnings in the period (Dhaka calendar days). Another person approves them.",
          submit: "Review",
          fields: [
            { id: "from", label: "Pay period start", type: "date", value: dateInput(start), required: true },
            { id: "to", label: "Pay period end (inclusive)", type: "date", value: dateInput(new Date(end.getTime() - 1)), required: true, max: dateInput(new Date()) },
          ],
          validate: {
            from: v => (DAY.test(v) ? "" : "Choose a date"),
            to: (v, all) => (!DAY.test(v) ? "Choose a date" : all.from && v < all.from ? "The end can't be before the start" : ""),
          },
          review: v => [["Period", `${v.from} – ${v.to}`], ["Riders", "Everyone with unpaid earnings in the period"]],
          reviewNote: "Payouts are drafted now; money moves only when finance marks each one paid.",
          confirm: "Prepare payouts",
          onSubmit: async v => {
            const from = fromDhakaDate(v.from, false);
            let to = fromDhakaDate(v.to, true);
            if (to > Date.now()) to = new Date();
            const r = await DF.api("/rider-payouts/runs", { method: "POST", body: { periodStart: from.toISOString(), periodEnd: to.toISOString() } });
            Ops.invalidate("rider-payouts");
            Ops.rerender(true);
            return `${r.created.length} payout${r.created.length === 1 ? "" : "s"} prepared (${Ops.money(r.total)})${r.skipped.length ? ` · ${r.skipped.length} rider${r.skipped.length === 1 ? "" : "s"} skipped` : ""}. Another person approves them.`;
          },
        });
      }
      const approve = t.closest("[data-payout-approve]");
      if (approve) {
        event.stopImmediatePropagation();
        const d = approve.dataset;
        return void Ops.confirm({ title: `Approve ${d.number}?`, message: `${d.rider} · ${Ops.money(Number(d.amount))}. Finance can pay it once approved.`, confirm: "Approve payout" }).then(ok => ok && call(() => DF.api(`/rider-payouts/${d.payoutApprove}/approve`, { method: "POST" }), p => `${p.number} approved.`));
      }
      const pay = t.closest("[data-payout-pay]");
      if (pay) {
        event.stopImmediatePropagation();
        const d = pay.dataset;
        const LABELS = { BKASH: "bKash", NAGAD: "Nagad", ROCKET: "Rocket", BANK_TRANSFER: "Bank transfer", CASH: "Cash" };
        return void Ops.form({
          title: `Mark ${d.number} paid`,
          description: `${d.rider} · ${Ops.money(Number(d.amount))}. The rider gets an SMS.`,
          submit: "Review payment",
          fields: [
            { id: "paymentMethod", label: "Payment method", type: "select", value: "BKASH", options: METHODS.map(m => ({ value: m, label: LABELS[m] || m })), required: true },
            { id: "paymentReference", label: "Transaction or reference number", required: true, maxLength: 120 },
          ],
          validate: { paymentReference: v => (v.length < 3 ? "At least 3 characters" : "") },
          review: v => [["Payout", d.number], ["Rider", d.rider], ["Amount", Ops.money(Number(d.amount))], ["Method", LABELS[v.paymentMethod]], ["Reference", v.paymentReference]],
          confirm: "Confirm payment",
          onSubmit: async v => {
            const p = await DF.api(`/rider-payouts/${d.payoutPay}/pay`, { method: "POST", body: { paymentMethod: v.paymentMethod, paymentReference: v.paymentReference } });
            Ops.invalidate("rider-payouts");
            Ops.rerender(true);
            return `${p.number} paid. The rider has been notified.`;
          },
        });
      }
      const cancel = t.closest("[data-payout-cancel]");
      if (cancel) {
        event.stopImmediatePropagation();
        return void Ops.confirm({ title: `Cancel ${cancel.dataset.number}?`, message: "Its earnings become unpaid again.", confirm: "Cancel payout", cancel: "Keep it", danger: true }).then(ok => ok && call(() => DF.api(`/rider-payouts/${cancel.dataset.payoutCancel}/cancel`, { method: "POST", body: {} }), p => `${p.number} cancelled.`));
      }
    },
    true,
  );

  DF.live(["rider.payout"], async () => {
    Ops.invalidate("rider-payouts");
    if (Ops.page() === "Rider pay") Ops.rerender();
  });
})();
