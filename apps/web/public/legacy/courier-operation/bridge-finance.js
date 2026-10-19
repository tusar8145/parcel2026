/*
 * Courier Operations on the API: the "COD & finance" page (finance, support and partner-applications area).
 *
 *   Rider cash on hand, cash handovers           GET /cod/riders, /cod/handovers, POST /cod/handovers
 *   Metrics                                      GET /finance/summary
 *   Settlement approvals (maker-checker), pay    /settlements…
 *   Invoices with VAT, Mushak-6.3-style PDF      /invoices…, GET /documents/finance-invoice/:id (settlements: /documents/settlement/:id)
 *   Refunds / claims / weight disputes           /disputes…
 *   Bank / bKash reconciliation                  /finance/reconciliation/…
 *   Ledger trial balance, period close           /finance/ledger/…
 *   Automatic settlement schedule                /finance/settlement-schedules…
 *
 * Moved here from bridge-pages.js; loaded after it (see src/features/courier-operation/scripts.ts).
 */
(() => {
  const DF = window.DF;
  const Ops = window.DFOps;
  if (!DF || !Ops) return;
  const $ = id => document.getElementById(id);
  const q = (selector, root = document) => root.querySelector(selector);
  const qa = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = Ops.esc;
  const setText = (el, text) => el && (el.textContent = text);
  const setMetrics = items => {
    const box = q("#mainContent .metrics");
    if (box) box.innerHTML = items.map(m => metric(m[0], m[1], m[2], m[3], m[4])).join("");
  };
  const registerText = (subtitle, footer) => {
    setText(q("#mainContent .table-panel .panel-heading .panel-subtitle"), subtitle);
    const foot = q("#mainContent .table-panel > div:last-child");
    if (foot && /sample|demo/i.test(foot.textContent)) foot.textContent = footer;
  };

  // ───────────── COD & finance ─────────────

  const SETTLEMENT = { DRAFT: "Review", APPROVED: "Ready", PAID: "Paid" };
  const SETTLEMENT_COLS = ["BATCH", "MERCHANT", "ORDERS", "COD COLLECTED", "REMITTANCE", "CREATED", "STATUS"];
  const HANDOVER_COLS = ["HANDOVER", "RIDER", "COLLECTIONS", "AMOUNT", "HUB", "RECEIVED BY", "RECEIVED"];
  const shortId = id => `HO-${id.slice(-6).toUpperCase()}`;
  const finance = () => Ops.can("financeStaff");
  const cashRiders = () => (Ops.can("receiveCash") ? Ops.lazy("cod-riders", () => DF.api("/cod/riders"), 20000) : null);
  const handovers = () =>
    Ops.can("receiveCash") || finance() ? Ops.lazy("handovers", () => DF.api("/cod/handovers?limit=50"), 20000) : null;

  Ops.prepare["COD & finance"] = () => {
    const cfg = genericPages["COD & finance"];
    if (finance()) {
      const page = Ops.lazy("settlements", () => DF.api("/settlements?limit=50"), 30000);
      cfg.cols = SETTLEMENT_COLS;
      cfg.rows = (page?.items || []).map(s => [s.number, s.merchant.name, String(s.collectionCount), Ops.money(s.codTotal), Ops.money(s.netPayable), new Date(s.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }), SETTLEMENT[s.status] || s.status]);
    } else {
      cfg.cols = HANDOVER_COLS;
      cfg.rows = (handovers()?.items || []).map(h => [shortId(h.id), h.rider.label, String(h.collectionCount), Ops.money(h.amount), h.hub.name, h.receivedBy.name || "—", Ops.when(h.createdAt)]);
    }
  };

  Ops.enhance["COD & finance"] = () => {
    const riders = cashRiders() || [];
    const recent = handovers()?.items || [];
    const todayKey = Ops.dayKey();
    const receivedToday = recent.filter(h => Ops.dayKey(h.createdAt) === todayKey);
    const withRiders = riders.reduce((n, r) => n + r.cashInHand, 0);
    const oldest = riders.map(r => r.oldestCollectedAt).sort()[0];
    if (finance()) {
      const s = Ops.lazy("finance-summary", () => DF.api("/finance/summary"), 30000);
      setMetrics([
        ["COD with riders", s ? Ops.money(s.codWithRiders) : "—", "wallet", riders.length ? `${riders.length} rider${riders.length === 1 ? "" : "s"}` : "riders", "to hand over"],
        ["COD at hubs", s ? Ops.money(s.codAtHubs) : "—", "chart", "received", "ready to settle"],
        ["Payouts pending approval", s ? Ops.money(s.payablePendingApproval) : "—", "clock", s ? `${Ops.money(s.payableAwaitingPayment)} approved` : "", "merchant settlements"],
        ["Settled this month", s ? Ops.money(s.settledThisMonth) : "—", "check", s ? `${Ops.money(s.invoicesOutstanding)} invoiced` : "", "paid out"],
      ]);
      registerText("Merchant settlement batches · maker-checker approval", `Showing ${genericPages["COD & finance"].rows.length} settlement batches`);
    } else if (Ops.can("receiveCash")) {
      setMetrics([
        ["COD with riders", Ops.money(withRiders), "wallet", `${riders.length} rider${riders.length === 1 ? "" : "s"}`, Ops.me?.hubIds ? "your hub" : "network wide"],
        ["Collections in hand", Ops.num(riders.reduce((n, r) => n + r.collections, 0)), "box", oldest ? `oldest ${Ops.ago(oldest)}` : "none waiting", "not handed over"],
        ["Received today", Ops.money(receivedToday.reduce((n, h) => n + h.amount, 0)), "chart", `${receivedToday.length} handover${receivedToday.length === 1 ? "" : "s"}`, "at hubs"],
      ]);
      registerText("Cash received from riders · newest first", `Showing ${recent.length} recent handovers`);
    } else {
      setMetrics([["COD & finance", "—", "wallet", "restricted", "finance, hub and operations staff"]]);
      registerText("COD and finance figures are available to finance, hub and operations staff.", "No records for your role");
    }

    // The register: a message instead of an empty table.
    const register = $("genericBody");
    if (register && !register.children.length) {
      const error = Ops.lazyError(finance() ? "settlements" : "handovers");
      const loading = finance() ? !Ops.cache.settlements?.value : !Ops.cache.handovers?.value;
      register.innerHTML = `<tr><td colspan="${genericPages["COD & finance"].cols.length}" class="empty-state">${esc(error ? DF.describe(error) : loading ? "Loading…" : finance() ? "No settlement batches yet. Draft one from the merchant settlements panel below." : "No cash handovers yet. Receive riders' cash in Rider cash on hand above.")}</td></tr>`;
    }

    if (Ops.can("receiveCash")) {
      const rows =
        riders
          .map(
            r =>
              `<tr><td><strong>${esc(r.code)} · ${esc(r.name)}</strong><span class="subcell">${esc(DF.localPhone(r.phone))}</span></td><td>${esc(r.hub?.name || "—")}</td><td>${r.collections}</td><td>${Ops.money(r.cashInHand)}</td><td>${esc(Ops.ago(r.oldestCollectedAt))}</td><td><button class="button button-sm" data-cod-receive="${esc(r.riderId)}">Receive cash</button></td></tr>`,
          )
          .join("") || `<tr><td colspan="6" class="empty-state">${Ops.lazyError("cod-riders") ? esc(DF.describe(Ops.lazyError("cod-riders"))) : "No rider is holding COD cash."}</td></tr>`;
      $("mainContent").insertAdjacentHTML(
        "beforeend",
        `<section class="panel table-panel" id="codRiderCash"><div class="panel-heading"><div><h2 class="panel-title">Rider cash on hand</h2><p class="panel-subtitle">COD collected from recipients and not yet handed to a hub · receive it against the exact collections.</p></div></div><div class="table-scroll"><table><thead><tr><th>RIDER</th><th>HUB</th><th>COLLECTIONS</th><th>CASH IN HAND</th><th>OLDEST</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></section>`,
      );
    }
    if (finance() && recent.length) {
      $("mainContent").insertAdjacentHTML(
        "beforeend",
        `<section class="panel table-panel"><div class="panel-heading"><div><h2 class="panel-title">Recent cash handovers</h2><p class="panel-subtitle">Rider cash received at hubs</p></div></div><div class="table-scroll"><table><thead><tr>${HANDOVER_COLS.map(c => `<th>${c}</th>`).join("")}</tr></thead><tbody>${recent
          .slice(0, 20)
          .map(h => `<tr><td>${shortId(h.id)}</td><td>${esc(h.rider.label)}</td><td>${h.collectionCount}</td><td>${Ops.money(h.amount)}</td><td>${esc(h.hub.name)}</td><td>${esc(h.receivedBy.name || "—")}</td><td>${esc(Ops.when(h.createdAt))}</td></tr>`)
          .join("")}</tbody></table></div></section>`,
      );
    }
  };

  Ops.modals.codReceive = async riderId => {
    if (!Ops.require("receiveCash", "receive rider cash")) return;
    let data;
    try {
      data = await DF.api(`/cod/riders/${riderId}/collections`);
    } catch (error) {
      return void showToast(DF.describe(error));
    }
    if (!data.collections.length) return void showToast(`${data.rider.code} has no cash to hand over.`);
    const rider = (cashRiders() || []).find(r => r.riderId === riderId);
    const hubs = Ops.myHubs() || DF.state.hubs;
    modalContext = { kind: "codReceive", riderId };
    $("modalTitle").textContent = `Receive cash · ${data.rider.code} · ${data.rider.name}`;
    $("modalSubmit").textContent = "Record handover";
    $("modalFields").innerHTML = `<div class="field"><label for="codHub">Receiving hub</label><select id="codHub" required>${hubs.map(h => `<option value="${h.id}" ${h.id === rider?.hub?.id ? "selected" : ""}>${esc(h.name)}</option>`).join("")}</select></div><div class="field"><label for="codAmount">Cash counted (৳)</label><input id="codAmount" type="number" min="0" step="0.01" inputmode="decimal" required placeholder="Count the cash"></div><div class="field full"><label>Collections handed over</label><div id="codCollections" style="display:grid;gap:6px;max-height:220px;overflow:auto;padding:4px 0">${data.collections
      .map(c => `<label style="display:flex;gap:8px;align-items:center;font-weight:500"><input type="checkbox" value="${c.id}" data-amount="${c.amount}" checked style="padding:0"> ${esc(c.trackingId)} · ${esc(c.recipient)} · ${Ops.money(c.amount)} · ${esc(Ops.ago(c.collectedAt))}</label>`)
      .join("")}</div></div><div class="field full"><label for="codNote">Note (optional)</label><textarea id="codNote" maxlength="500" placeholder="e.g. Counted with the rider at the counter"></textarea></div>`;
    const expected = () => qa("#codCollections input:checked").reduce((n, i) => n + Number(i.dataset.amount), 0);
    const describe = () => ($("modalDescription").textContent = `Count the cash before recording it. Expected for the selected collections: ${Ops.money(expected())}.`);
    $("codCollections").addEventListener("change", describe);
    describe();
    $("modalBackdrop").classList.add("open");
    $("codAmount").focus();
  };

  window.addEventListener(
    "click",
    event => {
      const button = event.target.closest("[data-cod-receive]");
      if (!button) return;
      event.stopImmediatePropagation();
      openModal("codReceive", button.dataset.codReceive);
    },
    true,
  );

  window.addEventListener(
    "submit",
    event => {
      if (event.target.id !== "modalForm" || modalContext.kind !== "codReceive") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const collectionIds = qa("#codCollections input:checked").map(i => i.value);
      if (!collectionIds.length) return void showToast("Select the collections the rider is handing over.");
      const body = { riderId: modalContext.riderId, hubId: $("codHub").value, collectionIds, amountReceived: $("codAmount").value.trim(), note: $("codNote").value.trim() || undefined };
      const button = $("modalSubmit");
      button.disabled = true;
      DF.api("/cod/handovers", { method: "POST", body })
        .then(async h => {
          closeModal();
          Ops.invalidate("cod-riders", "handovers", "finance-summary");
          await Ops.refresh().catch(() => undefined);
          showToast(`${Ops.money(h.amount)} received from ${h.rider.label} at ${h.hub.name}.`);
        })
        .catch(error => showToast(DF.describe(error)))
        .finally(() => (button.disabled = false));
    },
    true,
  );

  // ───────────── finance staff tools (approvals, invoices, ledger, reconciliation, schedules, disputes) ─────────────

  const dateShort = iso => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Dhaka" }) : "—");
  const thisPeriod = (offset = 0) => {
    const d = new Date(Date.now() + 6 * 3600_000);
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 15));
    return m.toISOString().slice(0, 7);
  };
  const STATUS_TEXT = { DRAFT: "Review", APPROVED: "Ready", PAID: "Paid", ISSUED: "Issued", VOID: "Void", OPEN: "Review", UNDER_REVIEW: "Processing", REJECTED: "Rejected" };
  const pill = s => (typeof statusPill === "function" ? statusPill(STATUS_TEXT[s] || s) : esc(s));
  const panel = (id, title, subtitle, body, actions = "") =>
    `<section class="panel table-panel" id="${id}"><div class="panel-heading"><div><h2 class="panel-title">${esc(title)}</h2><p class="panel-subtitle">${esc(subtitle)}</p></div>${actions ? `<div class="heading-actions">${actions}</div>` : ""}</div>${body}</section>`;
  const table = (cols, rows, empty) =>
    `<div class="table-scroll"><table><thead><tr>${cols.map(c => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows.join("") || `<tr><td colspan="${cols.length}" class="empty-state">${esc(empty)}</td></tr>`}</tbody></table></div>`;
  const btn = (label, attrs) => `<button class="button button-sm" ${attrs}>${esc(label)}</button>`;
  const errorText = (key, fallback) => (Ops.lazyError(key) ? DF.describe(Ops.lazyError(key)) : fallback);

  const FIN_KEYS = ["settlements", "finance-summary", "fin-invoices", "fin-trial", "fin-periods", "fin-recon", "fin-statements", "fin-schedules", "fin-disputes"];
  const load = {
    invoices: () => Ops.lazy("fin-invoices", () => DF.api("/invoices?limit=20"), 30000),
    trial: () => Ops.lazy("fin-trial", () => DF.api(`/finance/ledger/trial-balance?period=${thisPeriod()}&nonZeroOnly=true`), 60000),
    periods: () => Ops.lazy("fin-periods", () => DF.api("/finance/ledger/periods"), 120000),
    recon: () => Ops.lazy("fin-recon", () => DF.api("/finance/reconciliation/exceptions"), 60000),
    statements: () => Ops.lazy("fin-statements", () => DF.api("/finance/reconciliation/statements"), 60000),
    schedules: () => Ops.lazy("fin-schedules", () => DF.api("/finance/settlement-schedules"), 60000),
    disputes: () => Ops.lazy("fin-disputes", () => DF.api("/disputes?limit=30"), 30000),
  };

  function financeTools() {
    const main = $("mainContent");
    const html = [];

    // Settlement approvals (maker-checker) and payment.
    const open = (Ops.cache.settlements?.value?.items || []).filter(s => s.status !== "PAID");
    html.push(
      panel(
        "finSettlements",
        "Settlement approvals",
        "Drafts need a second finance user to approve; automatic drafts can be approved by anyone in finance. A shortfall is carried to the next settlement, never paid negative.",
        table(
          ["BATCH", "MERCHANT", "COD", "CHARGES", "ADJUSTMENTS", "NET PAYABLE", "CARRIED FORWARD", "STATUS", ""],
          open.map(
            s =>
              `<tr><td><strong>${esc(s.number)}</strong>${s.autoDrafted ? `<span class="subcell">automatic</span>` : ""}</td><td>${esc(s.merchant.name)}</td><td>${Ops.money(s.codTotal)}</td><td>${Ops.money(s.chargesTotal)}</td><td>${Ops.money(s.adjustmentsTotal)}</td><td><strong>${Ops.money(s.netPayable)}</strong></td><td>${s.carriedForward ? Ops.money(s.carriedForward) : "—"}</td><td>${pill(s.status)}</td><td style="white-space:nowrap">${btn("View", `data-fin-settlement-view="${s.id}"`)} ${
                s.status === "DRAFT" ? `${btn("Approve", `data-fin-settlement-approve="${s.id}" data-number="${esc(s.number)}" data-merchant-name="${esc(s.merchant.name)}" data-net="${s.netPayable}"`)} ${btn("Discard", `data-fin-settlement-delete="${s.id}" data-number="${esc(s.number)}"`)}` : btn("Mark paid", `data-fin-settlement-pay="${s.id}" data-net="${s.netPayable}" data-number="${esc(s.number)}" data-merchant-name="${esc(s.merchant.name)}"`)
              }</td></tr>`,
          ),
          "No settlements waiting for approval or payment.",
        ),
        btn("Draft settlement", "data-fin-settlement-new"),
      ),
    );

    // Invoices with VAT.
    const invoices = load.invoices()?.items || [];
    html.push(
      panel(
        "finInvoices",
        "Delivery-charge invoices · VAT",
        "Prices are VAT-inclusive; each invoice shows taxable value and VAT. Print the Mushak-6.3-style copy for the accountant to review.",
        table(
          ["INVOICE", "MERCHANT", "PERIOD", "TAXABLE", "VAT", "TOTAL", "DUE", "STATUS", ""],
          invoices.map(
            i =>
              `<tr><td><strong>${esc(i.number)}</strong>${i.paymentReference ? `<span class="subcell">ref ${esc(i.paymentReference)}</span>` : ""}</td><td>${esc(i.merchant.name)}</td><td>${dateShort(i.periodStart)} – ${dateShort(i.periodEnd)}</td><td>${Ops.money(i.taxableValue)}</td><td>${Ops.money(i.vatAmount)} <span class="subcell">${i.vatRate}%</span></td><td><strong>${Ops.money(i.total)}</strong></td><td>${dateShort(i.dueAt)}${i.overdue ? `<span class="subcell">overdue</span>` : ""}</td><td>${pill(i.status)}</td><td style="white-space:nowrap">${btn("Print", `data-fin-invoice-print="${i.id}"`)} ${
                i.status === "ISSUED" ? `${btn("Mark paid", `data-fin-invoice-pay="${i.id}" data-number="${esc(i.number)}" data-total="${i.total}" data-merchant-name="${esc(i.merchant.name)}"`)} ${btn("Void", `data-fin-invoice-void="${i.id}" data-number="${esc(i.number)}" data-total="${i.total}"`)}` : ""
              }</td></tr>`,
          ),
          errorText("fin-invoices", "No invoices yet."),
        ),
        btn("Issue invoice", "data-fin-invoice-new"),
      ),
    );

    // Disputes, refunds and claims.
    const disputes = load.disputes()?.items || [];
    html.push(
      panel(
        "finDisputes",
        "Refunds, claims and weight disputes",
        "Raised by customers, merchants or hubs · finance approves money (merchant balance, bank, bKash or cash)",
        table(
          ["CLAIM", "PARCEL", "KIND", "MERCHANT", "CLAIMED", "APPROVED", "STATUS", ""],
          disputes.map(
            d =>
              `<tr><td><strong>${esc(d.number)}</strong><span class="subcell">${esc(Ops.ago(d.createdAt))}</span></td><td>${esc(d.parcel.trackingId)}</td><td>${esc(d.kindLabel)}${
                d.weight ? `<span class="subcell">${d.weight.bookedKg} → ${d.weight.actualKg} kg · ${d.weight.difference >= 0 ? "+" : ""}${Ops.money(d.weight.difference)}</span>` : ""
              }</td><td>${esc(d.merchant?.name || "Customer")}</td><td>${d.claimedAmount == null ? "—" : Ops.money(d.claimedAmount)}</td><td>${d.approvedAmount == null ? "—" : Ops.money(d.approvedAmount)}</td><td>${pill(d.status)}</td><td style="white-space:nowrap">${
                d.status === "OPEN" ? btn("Review", `data-fin-dispute="review" data-number="${esc(d.number)}"`) + " " : ""
              }${d.status === "OPEN" || d.status === "UNDER_REVIEW" ? `${btn("Approve", `data-fin-dispute="approve" data-number="${esc(d.number)}" data-kind="${d.kind}" data-claimed="${d.claimedAmount ?? ""}" data-merchant="${d.merchant ? 1 : ""}" data-merchant-name="${esc(d.merchant?.name || "")}" data-parcel="${esc(d.parcel.trackingId)}"`)} ${btn("Reject", `data-fin-dispute="reject" data-number="${esc(d.number)}"`)}` : esc(d.resolution || "")}</td></tr>`,
          ),
          errorText("fin-disputes", "No disputes."),
        ),
      ),
    );

    // Reconciliation.
    const recon = load.recon();
    const statements = load.statements() || [];
    const candidates = recon?.unreconciledPayments || [];
    const unmatched = recon?.unmatchedLines || [];
    const options = line =>
      candidates
        .filter(c => (line.amount < 0 ? c.amount < 0 : c.amount > 0))
        .map(c => `<option value="${c.kind}:${c.id}">${esc(c.number)} · ${esc(c.party || "")} · ${Ops.money(Math.abs(c.amount))}${Math.abs(c.amount) === Math.abs(line.amount) ? " ✓" : ""}</option>`)
        .join("");
    html.push(
      panel(
        "finRecon",
        "Bank / bKash reconciliation",
        `Upload a statement CSV: lines are matched to settlement payouts, rider payouts and invoice payments by reference, then by exact amount within 3 days. ${statements.length} statements imported · ${candidates.length} payments without a bank line.`,
        `<form id="finReconForm" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;padding:0 0 12px"><div class="field"><label for="finReconSource">Source</label><select id="finReconSource"><option value="BANK">Bank</option><option value="BKASH">bKash</option></select></div><div class="field"><label for="finReconAccount">Account</label><input id="finReconAccount" required maxlength="80" placeholder="e.g. City Bank 1234"></div><div class="field"><label for="finReconFile">Statement (CSV)</label><input id="finReconFile" type="file" accept=".csv,text/csv" required data-file-hint="Bank or bKash statement, CSV (.csv)"></div><button class="button button-primary" type="submit">Upload &amp; match</button></form>` +
          table(
            ["DATE", "DESCRIPTION", "REFERENCE", "AMOUNT", "MATCH WITH", ""],
            unmatched.map(
              l =>
                `<tr><td>${dateShort(l.postedAt)}</td><td>${esc(l.description)}</td><td>${esc(l.reference || "—")}</td><td><strong>${Ops.money(l.amount)}</strong></td><td><select data-fin-recon-target="${l.id}"><option value="">Choose a payment…</option>${options(l)}</select></td><td style="white-space:nowrap">${btn("Match", `data-fin-recon-match="${l.id}"`)} ${btn("Ignore", `data-fin-recon-ignore="${l.id}"`)}</td></tr>`,
            ),
            errorText("fin-recon", "Every imported bank line is matched."),
          ),
      ),
    );

    // Ledger.
    const tb = load.trial();
    const periods = load.periods();
    const prev = thisPeriod(-1);
    const prevClosed = periods?.closed?.some(p => p.period === prev);
    html.push(
      panel(
        "finLedger",
        `Ledger · trial balance ${thisPeriod()}`,
        tb ? (tb.balanced ? `Balanced · debits ${Ops.money(tb.totals.debit)} = credits ${Ops.money(tb.totals.credit)}` : "Not balanced — investigate before closing") : errorText("fin-trial", "Loading…"),
        table(
          ["ACCOUNT", "NAME", "TYPE", "DEBITS", "CREDITS", "BALANCE"],
          (tb?.accounts || []).map(a => `<tr><td>${esc(a.code)}</td><td>${esc(a.name)}</td><td>${esc(a.type.toLowerCase())}</td><td>${Ops.money(a.debit)}</td><td>${Ops.money(a.credit)}</td><td><strong>${Ops.money(a.balance)}</strong></td></tr>`),
          "No postings this month.",
        ),
        `${btn("VAT & BIN settings", "data-fin-config")} ${prevClosed ? `<span class="status status-good">${esc(prev)} closed</span>` : btn(`Close ${prev}`, `data-fin-close="${prev}"`)}`,
      ),
    );

    // Automatic settlement schedules.
    const schedules = load.schedules() || [];
    html.push(
      panel(
        "finSchedules",
        "Automatic settlement schedule",
        "Settlements are drafted automatically (06:00 Dhaka) on each merchant's cycle; approval and payment stay manual.",
        table(
          ["MERCHANT", "CYCLE", "MINIMUM", "NEXT RUN", "LAST RESULT"],
          schedules.map(s => `<tr><td>${esc(s.merchant.code)} · ${esc(s.merchant.name)}</td><td>${esc(s.cycle.toLowerCase())}${s.weekdayLabel ? ` · ${esc(s.weekdayLabel)}` : ""}</td><td>${Ops.money(s.minimumAmount)}</td><td>${esc(Ops.when(s.nextRunAt))}</td><td>${esc(s.lastResult || "—")}</td></tr>`),
          errorText("fin-schedules", "No merchant has an automatic schedule yet."),
        ),
        `${btn("Set schedule", "data-fin-schedule-set")} ${btn("Run due now", "data-fin-schedule-run")}`,
      ),
    );

    main.insertAdjacentHTML("beforeend", html.join(""));
  }

  const baseEnhance = Ops.enhance["COD & finance"];
  Ops.enhance["COD & finance"] = () => {
    baseEnhance();
    if (finance()) financeTools();
  };

  // ───────────── actions ─────────────

  const done = (message, ...keys) => {
    Ops.invalidate(...(keys.length ? keys : FIN_KEYS));
    Ops.rerender(true);
    if (message) showToast(message);
  };
  const fail = error => showToast(DF.describe(error));
  const REF = value => (value && value.length < 3 ? "At least 3 characters" : "");
  const money = v => Ops.money(Number(v || 0));
  const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((label, i) => ({ value: String(i), label }));
  const CYCLES = [
    { value: "MANUAL", label: "Manual (drafted by finance)" },
    { value: "DAILY", label: "Daily" },
    { value: "WEEKLY", label: "Weekly" },
    { value: "BIWEEKLY", label: "Every two weeks" },
  ];
  const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
  /** "2026-10-01" (a Dhaka calendar day) → the instant it starts. */
  const dhakaStart = day => new Date(`${day}T00:00:00+06:00`).toISOString();
  const moneyRule = (value, { required = true, max } = {}) => {
    if (!value) return required ? "Enter an amount" : "";
    if (!/^\d+(\.\d{1,2})?$/.test(value)) return "Use a number with up to 2 decimals";
    if (required && Number(value) <= 0) return "The amount must be more than 0";
    if (max != null && Number(value) > max) return `At most ${money(max)}`;
    return "";
  };
  /** The merchant search-select field for Ops.form (active merchants). */
  async function merchantField(label) {
    const options = await Ops.merchantOptions();
    if (!options.length) {
      showToast("No active merchants.");
      return null;
    }
    return { id: "merchantId", label, type: "search-select", options, required: true, placeholder: "Search by code or name…", emptyLabel: "— Choose a merchant —" };
  }
  const merchantLabel = (field, id) => field.options.find(o => o.value === id)?.label || id;

  const n2 = v => Number(v || 0).toLocaleString("en-BD", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  /** Tax invoice (Mushak-6.3-style draft: VAT breakdown, BIN, payment status) as a PDF in a new tab. */
  const printInvoice = id => Ops.printPdf(`/documents/finance-invoice/${id}`, { title: "Preparing the tax invoice…" });

  /** COD settlement statement as a PDF in a new tab. */
  const viewSettlement = id => Ops.printPdf(`/documents/settlement/${id}`, { title: "Preparing the settlement statement…" });

  const actions = {
    "fin-settlement-new": async () => {
      const field = await merchantField("Merchant");
      if (!field) return;
      Ops.form({
        title: "Draft a settlement",
        description: "Collects the merchant's delivered, unsettled COD less charges. Another finance user approves it.",
        submit: "Draft settlement",
        fields: [field],
        onSubmit: async v => {
          const s = await DF.api("/settlements", { method: "POST", body: { merchantId: v.merchantId } });
          done(null);
          return `${s.number} drafted: net ${Ops.money(s.netPayable)}. Another finance user must approve it.`;
        },
      });
    },
    "fin-settlement-view": b => viewSettlement(b.dataset.finSettlementView),
    "fin-settlement-approve": async b => {
      const { number, merchantName, net } = b.dataset;
      if (!(await Ops.confirm({ title: `Approve ${number}?`, message: `${merchantName} · net payable ${money(net)}.\nOnce approved it can be paid out; the approval is recorded under your name.`, confirm: "Approve settlement" }))) return;
      DF.api(`/settlements/${b.dataset.finSettlementApprove}/approve`, { method: "POST" }).then(s => done(`${s.number} approved.`), fail);
    },
    "fin-settlement-delete": async b => {
      if (!(await Ops.confirm({ title: `Discard ${b.dataset.number || "this draft"}?`, message: "Its collections return to the unsettled pool.", confirm: "Discard draft", danger: true }))) return;
      DF.api(`/settlements/${b.dataset.finSettlementDelete}`, { method: "DELETE" }).then(() => done("Draft discarded."), fail);
    },
    "fin-settlement-pay": b => {
      const { number, merchantName } = b.dataset;
      const net = Number(b.dataset.net);
      const id = b.dataset.finSettlementPay;
      Ops.form({
        title: `Mark ${number} paid`,
        description: net > 0 ? `Record the ${Ops.money(net)} payout to ${merchantName}. The merchant is notified.` : `Nothing is payable to ${merchantName}; closing it carries the balance forward.`,
        submit: net > 0 ? "Review payout" : "Close settlement",
        fields: net > 0
          ? [
              { id: "via", label: "Paid by", type: "select", options: [{ value: "", label: "The merchant's payout account" }, { value: "BANK", label: "Bank transfer" }, { value: "BKASH", label: "bKash" }] },
              { id: "reference", label: "Bank / bKash transaction reference", required: true, maxLength: 120, placeholder: "e.g. TRX9F82K1" },
            ]
          : [{ id: "info", label: "Payout", type: "static", value: "৳0 — no transfer is needed." }],
        validate: { reference: REF },
        review: net > 0 ? v => [["Settlement", number], ["Merchant", merchantName], ["Amount", Ops.money(net)], ["Paid by", v.via ? (v.via === "BANK" ? "Bank transfer" : "bKash") : "Payout account"], ["Reference", v.reference]] : null,
        confirm: "Confirm payout",
        onSubmit: async v => {
          const body = net > 0 ? { reference: v.reference, ...(v.via ? { via: v.via } : {}) } : {};
          const s = await DF.api(`/settlements/${id}/pay`, { method: "POST", body });
          done(null);
          return net > 0 ? `${s.number} paid; the merchant was notified.` : `${s.number} closed with no payout; ${Ops.money(s.carriedForward)} carried forward.`;
        },
      });
    },
    "fin-invoice-new": async () => {
      const field = await merchantField("Merchant");
      if (!field) return;
      Ops.form({
        title: "Issue a tax invoice",
        description: "Invoices the merchant's delivered parcels in the period, with VAT. Days are Dhaka calendar days.",
        submit: "Review invoice",
        fields: [field, { id: "from", label: "Period start", type: "date", value: `${thisPeriod(-1)}-01`, required: true }, { id: "to", label: "Period end (inclusive)", type: "date", value: new Date(Date.parse(`${thisPeriod()}-01T00:00:00Z`) - 86400000).toISOString().slice(0, 10), required: true }],
        validate: {
          from: v => (ISO_DAY.test(v) ? "" : "Choose a date"),
          to: (v, all) => (!ISO_DAY.test(v) ? "Choose a date" : all.from && v < all.from ? "The end can't be before the start" : ""),
        },
        review: v => [["Merchant", merchantLabel(field, v.merchantId)], ["Period", `${dateShort(dhakaStart(v.from))} – ${dateShort(dhakaStart(v.to))}`]],
        reviewNote: "The invoice number is issued and posted to the ledger when you confirm.",
        confirm: "Issue invoice",
        onSubmit: async v => {
          const end = new Date(Date.parse(dhakaStart(v.to)) + 86400000).toISOString();
          const i = await DF.api("/invoices", { method: "POST", body: { merchantId: v.merchantId, periodStart: dhakaStart(v.from), periodEnd: end } });
          done(null);
          return `${i.number} issued: ${Ops.money(i.total)} incl. VAT ${Ops.money(i.vatAmount)}.`;
        },
      });
    },
    "fin-invoice-print": b => printInvoice(b.dataset.finInvoicePrint),
    "fin-invoice-pay": b => {
      const { number, total, merchantName } = b.dataset;
      Ops.form({
        title: `Mark ${number} paid`,
        description: `${merchantName} · ${money(total)}`,
        submit: "Review payment",
        fields: [
          { id: "via", label: "Received by", type: "select", value: "BANK", options: [{ value: "BANK", label: "Bank transfer" }, { value: "BKASH", label: "bKash" }, { value: "CASH", label: "Cash" }], required: true },
          { id: "reference", label: "Payment reference (bank / bKash transaction)", maxLength: 120 },
        ],
        validate: { reference: REF },
        review: v => [["Invoice", number], ["Merchant", merchantName], ["Amount", money(total)], ["Received by", v.via], ["Reference", v.reference || "—"]],
        confirm: "Confirm payment",
        onSubmit: async v => {
          const i = await DF.api(`/invoices/${b.dataset.finInvoicePay}/mark-paid`, { method: "POST", body: { via: v.via, ...(v.reference ? { reference: v.reference } : {}) } });
          done(null);
          return `${i.number} marked paid.`;
        },
      });
    },
    "fin-invoice-void": b => {
      const { number, total } = b.dataset;
      Ops.form({
        title: `Void ${number}`,
        description: `The ${money(total)} invoice is reversed in the ledger. This can't be undone.`,
        submit: "Review",
        fields: [{ id: "reason", label: "Why is this invoice void?", type: "textarea", required: true, maxLength: 300 }],
        validate: { reason: v => (v.length < 3 ? "At least 3 characters" : "") },
        review: v => [["Invoice", number], ["Amount reversed", money(total)], ["Reason", v.reason]],
        confirm: "Void invoice",
        onSubmit: async v => {
          const i = await DF.api(`/invoices/${b.dataset.finInvoiceVoid}/void`, { method: "POST", body: { reason: v.reason } });
          done(null);
          return `${i.number} voided and reversed in the ledger.`;
        },
      });
    },
    "fin-dispute": b => {
      const { number, kind, claimed, merchant, merchantName, parcel } = b.dataset;
      const action = b.dataset.finDispute;
      if (action === "review") return DF.api(`/disputes/${number}/review`, { method: "POST" }).then(() => done(`${number} taken for review.`), fail);
      if (action === "reject")
        return Ops.form({
          title: `Reject ${number}`,
          description: `Parcel ${parcel || ""}. The reason is sent to the ${merchant ? "merchant" : "customer"}.`,
          submit: "Reject claim",
          fields: [{ id: "resolution", label: "Reason for rejecting", type: "textarea", required: true, maxLength: 1000 }],
          validate: { resolution: v => (v.length < 3 ? "Explain the decision (at least 3 characters)" : "") },
          onSubmit: async v => {
            await DF.api(`/disputes/${number}/reject`, { method: "POST", body: { resolution: v.resolution } });
            done(null);
            return `${number} rejected.`;
          },
        });
      const paysMoney = kind !== "WEIGHT_DISCREPANCY";
      const PAYOUTS = [{ value: "BKASH", label: "bKash" }, { value: "BANK", label: "Bank transfer" }, { value: "CASH", label: "Cash" }];
      Ops.form({
        title: `Approve ${number}`,
        description: paysMoney ? (merchant ? `Approved money is added to ${merchantName}'s next settlement.` : "The customer is paid by bKash, bank or cash.") : "Weight disputes adjust the parcel's charge; no payout.",
        submit: paysMoney ? "Review" : "Approve",
        fields: [
          { id: "resolution", label: "Decision note (sent to the customer / merchant)", type: "textarea", required: true, maxLength: 1000 },
          ...(paysMoney ? [{ id: "amount", label: "Approved amount (৳)", type: "number", value: claimed, required: true, min: 0, step: "0.01", hint: claimed ? `Claimed: ${money(claimed)}` : "" }] : []),
          ...(paysMoney && !merchant ? [{ id: "payout", label: "Pay by", type: "select", value: "BKASH", options: PAYOUTS, required: true }, { id: "payoutReference", label: "Payment reference", required: true, maxLength: 120 }] : []),
        ],
        validate: { resolution: v => (v.length < 3 ? "Explain the decision (at least 3 characters)" : ""), amount: v => moneyRule(v), payoutReference: REF },
        review: paysMoney
          ? v => [["Claim", number], ["Parcel", parcel || "—"], ["Claimed", claimed ? money(claimed) : "—"], ["Approved amount", money(v.amount)], ["Paid", merchant ? `${merchantName} balance (next settlement)` : `${PAYOUTS.find(p => p.value === v.payout)?.label} · ref ${v.payoutReference}`], ["Note", v.resolution]]
          : null,
        confirm: "Approve and pay",
        onSubmit: async v => {
          const body = { resolution: v.resolution };
          if (paysMoney) {
            body.approvedAmount = v.amount;
            if (!merchant) Object.assign(body, { payout: v.payout, payoutReference: v.payoutReference });
          }
          const d = await DF.api(`/disputes/${number}/approve`, { method: "POST", body });
          done(null);
          return `${d.number} approved${d.payout === "MERCHANT_BALANCE" ? " · applied to the next settlement" : ""}.`;
        },
      });
    },
    "fin-recon-match": b => {
      const select = q(`[data-fin-recon-target="${b.dataset.finReconMatch}"]`);
      const value = select?.value;
      if (!value) return void showToast("Choose the payment this bank line belongs to.");
      const [kind, id] = value.split(":");
      const body = { [kind === "riderPayout" ? "riderPayoutId" : `${kind}Id`]: id };
      const path = `/finance/reconciliation/lines/${b.dataset.finReconMatch}/match`;
      DF.api(path, { method: "POST", body })
        .catch(async error => {
          if (error.code !== "AMOUNT_MISMATCH") throw error;
          const note = await Ops.prompt({ title: "Amounts don't match", message: `${DF.describe(error)}\nMatch anyway with a note explaining the difference.`, label: "Note explaining the difference", required: true, multiline: true, maxLength: 300, confirm: "Match with note", validate: v => (v.length < 3 ? "At least 3 characters" : "") });
          if (!note) return null;
          return DF.api(path, { method: "POST", body: { ...body, note } });
        })
        .then(r => r && done("Bank line matched."), fail);
    },
    "fin-recon-ignore": async b => {
      const note = await Ops.prompt({ title: "Ignore this bank line", message: "It stays on the statement but needs no payment match.", label: "Why does it need no match? (e.g. bank charge, own-account transfer)", required: true, multiline: true, maxLength: 300, confirm: "Ignore line", validate: v => (v.length < 3 ? "Say why this line needs no match" : "") });
      if (note) DF.api(`/finance/reconciliation/lines/${b.dataset.finReconIgnore}/ignore`, { method: "POST", body: { note } }).then(() => done("Line ignored."), fail);
    },
    "fin-close": async b => {
      const period = b.dataset.finClose;
      if (!(await Ops.confirm({ title: `Close ${period}?`, message: "Postings dated in it will go to the next open month.", confirm: `Close ${period}`, danger: true }))) return;
      DF.api(`/finance/ledger/periods/${period}/close`, { method: "POST", body: {} }).then(() => done(`${period} closed.`), fail);
    },
    "fin-schedule-set": async () => {
      const field = await merchantField("Merchant");
      if (!field) return;
      const weekly = v => v.cycle === "WEEKLY" || v.cycle === "BIWEEKLY";
      Ops.form({
        title: "Settlement schedule",
        description: "Settlements are drafted automatically (06:00 Dhaka) on the merchant's cycle; approval and payment stay manual.",
        submit: "Review schedule",
        fields: [
          field,
          { id: "cycle", label: "Cycle", type: "select", value: "WEEKLY", options: CYCLES, required: true },
          { id: "weekday", label: "Weekday", type: "select", value: "0", options: WEEKDAYS, required: true, show: weekly },
          { id: "minimumAmount", label: "Minimum net payable to draft (৳)", type: "number", value: "0", min: 0, step: "0.01", required: true },
        ],
        validate: { minimumAmount: v => moneyRule(v || "0", { required: false }) },
        review: v => [["Merchant", merchantLabel(field, v.merchantId)], ["Cycle", CYCLES.find(c => c.value === v.cycle)?.label], ...(weekly(v) ? [["Weekday", WEEKDAYS[Number(v.weekday)].label]] : []), ["Minimum net payable", money(v.minimumAmount)]],
        confirm: "Save schedule",
        onSubmit: async v => {
          const body = { cycle: v.cycle, minimumAmount: v.minimumAmount || 0, ...(weekly(v) ? { weekday: Number(v.weekday) } : {}) };
          const s = await DF.api(`/finance/settlement-schedules/${v.merchantId}`, { method: "PUT", body });
          done(null);
          const name = merchantLabel(field, v.merchantId).split(" · ").slice(1).join(" · ");
          return `${name}: ${s.cycle.toLowerCase()} settlements${s.nextRunAt ? `, next ${Ops.when(s.nextRunAt)}` : ""}.`;
        },
      });
    },
    "fin-config": async () => {
      const cfg = await DF.api("/finance/config").catch(fail);
      if (!cfg) return;
      Ops.form({
        title: "VAT & BIN settings",
        description: "Printed on every tax invoice. Changes apply to invoices issued from now on.",
        submit: "Review settings",
        fields: [
          { id: "vatRate", label: "VAT rate (%)", type: "number", value: String(cfg.vatRate), min: 0, max: 50, step: "0.01", required: true },
          { id: "bin", label: "Company BIN", value: cfg.seller.bin || "", maxLength: 14, placeholder: "13 digits, or 9 digits-4 digits", hint: "Printed on invoices." },
          { id: "name", label: "Company name on invoices", value: cfg.seller.name || "", required: true, maxLength: 160, full: true },
          { id: "address", label: "Company address on invoices", type: "textarea", value: cfg.seller.address || "", maxLength: 300 },
        ],
        validate: {
          vatRate: v => (!/^\d+(\.\d{1,2})?$/.test(v) ? "Enter a percentage, e.g. 15" : Number(v) > 50 ? "VAT rate looks too high" : ""),
          bin: v => (!v || /^\d{13}$/.test(v) || /^\d{9}-\d{4}$/.test(v) ? "" : "BIN must be 13 digits (or 9 digits-4 digits)"),
          name: v => (v.length < 2 ? "At least 2 characters" : ""),
        },
        review: v => [["VAT rate", `${v.vatRate}% (was ${cfg.vatRate}%)`], ["BIN", v.bin || "not set"], ["Company name", v.name], ["Address", v.address || "—"]],
        confirm: "Save settings",
        onSubmit: async v => {
          const c = await DF.api("/finance/config", { method: "PUT", body: { vatRate: Number(v.vatRate), seller: { bin: v.bin, name: v.name, address: v.address } } });
          done(null);
          return `Saved: VAT ${c.vatRate}% · BIN ${c.seller.bin || "not set"}.`;
        },
      });
    },
    "fin-schedule-run": () => DF.api("/finance/settlement-schedules/run", { method: "POST", body: {} }).then(r => done(r.length ? r.map(x => `${x.merchantCode}: ${x.result}`).join(" · ") : "No schedule is due."), fail),
  };

  window.addEventListener(
    "click",
    event => {
      if (!finance()) return;
      const button = event.target.closest("[data-fin-settlement-new],[data-fin-settlement-view],[data-fin-settlement-approve],[data-fin-settlement-delete],[data-fin-settlement-pay],[data-fin-invoice-new],[data-fin-invoice-print],[data-fin-invoice-pay],[data-fin-invoice-void],[data-fin-dispute],[data-fin-recon-match],[data-fin-recon-ignore],[data-fin-close],[data-fin-schedule-set],[data-fin-schedule-run],[data-fin-config]");
      if (!button) return;
      event.stopImmediatePropagation();
      const key = Object.keys(actions).find(k => button.hasAttribute(`data-${k}`));
      if (key) void actions[key](button);
    },
    true,
  );

  window.addEventListener(
    "submit",
    event => {
      if (event.target.id !== "finReconForm") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const file = $("finReconFile").files[0];
      const accountLabel = $("finReconAccount").value.trim();
      if (!file || !accountLabel) return void showToast("Choose the account and the statement file.");
      if (file.size > 2_000_000) return void showToast("Statements can be up to 2 MB.");
      const submit = q("#finReconForm button[type=submit]");
      submit.disabled = true;
      file
        .text()
        .then(content => DF.api("/finance/reconciliation/statements", { method: "POST", body: { source: $("finReconSource").value, accountLabel, filename: file.name, content } }))
        .then(st => done(`${st.lineCount} lines imported${st.duplicates ? ` (${st.duplicates} already imported)` : ""} · ${st.autoMatched} matched automatically.`))
        .catch(fail)
        .finally(() => (submit.disabled = false));
    },
    true,
  );

  // Live: other finance users' approvals, payments and disputes.
  DF.live(["settlement.updated", "invoice.updated", "dispute.updated"], () => {
    Ops.invalidate(...FIN_KEYS);
    if (Ops.page() === "COD & finance") Ops.rerender();
  });
})();
