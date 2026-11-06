/*
 * Merchant panels › Balance (the old Payments / Billing pages): the merchant's account (modules/money).
 *
 *   E-commerce  cards (ready to pay, with riders, at hubs, charges, settled), Parcels (where each parcel's
 *               cash is, its settlement), Settlements (PDF, receipt photo), Statement (PDF).
 *   Financial   cards (due now, not billed, billed unpaid, paid, credit), "I've paid" (pending until Delivery
 *               Fast confirms), Parcels (bill status), Bills (PDF), Payments, Statement (PDF).
 *
 * Owners only (staff see a note). Loaded after shared/merchant-bridge.js: it wraps renderPage and draws the
 * page in place of the old one. Live: account.updated.
 */
(() => {
  const DF = window.DF;
  if (!DF) return;
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const toast = m => (window.showToast ? window.showToast(m) : alert(m));
  const tk = n => `৳${Number(n || 0).toLocaleString("en-BD", { maximumFractionDigits: 2 })}`;
  const day = iso => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Dhaka" }) : "—");
  const when = iso => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Dhaka" }) : "—");
  const today = () => new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
  const monthStart = () => `${today().slice(0, 8)}01`;
  const PAGES = ["Payments", "Billing", "Balance"];
  const METHODS = [
    ["BANK", "Bank transfer"],
    ["BKASH", "bKash"],
    ["NAGAD", "Nagad"],
    ["ROCKET", "Rocket"],
    ["CASH", "Cash"],
    ["OTHER", "Other"],
  ];
  const methodLabel = m => (METHODS.find(x => x[0] === m) || [m, m])[1];
  const isOwner = () => (DF.auth?.user?.roles || []).includes("MERCHANT_OWNER");

  document.head.insertAdjacentHTML(
    "beforeend",
    `<style id="mbStyles">
.mb{display:grid;gap:16px;color:#101828}
.mb-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.mb-card{background:#fff;border:1px solid #e6e9ef;border-radius:14px;padding:14px 16px;display:grid;gap:4px}
.mb-card small{color:#667085;font-size:12px;font-weight:600}
.mb-card strong{font-size:22px;font-weight:700}
.mb-card span{color:#667085;font-size:12px}
.mb-card.key{border-color:#b8c8ff;background:linear-gradient(180deg,#f5f8ff,#fff)}
.mb-card.key strong{color:#2f55c9}
.mb-card.due strong{color:#b42318}
.mb-card.good strong{color:#067647}
.mb-bar{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center}
.mb-seg{display:inline-flex;gap:4px;padding:4px;border-radius:11px;background:#eef1f5}
.mb-seg button{border:0;background:transparent;color:#556274;padding:7px 13px;border-radius:8px;font:inherit;font-size:13px;font-weight:600;cursor:pointer}
.mb-seg button.on{background:#fff;color:#2f55c9;box-shadow:0 1px 2px rgba(16,24,40,.08)}
.mb-box{background:#fff;border:1px solid #e6e9ef;border-radius:14px;overflow:hidden}
.mb-head{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center;padding:14px 16px;border-bottom:1px solid #e6e9ef}
.mb-head h2{margin:0;font-size:15px}
.mb-head p{margin:2px 0 0;color:#667085;font-size:12.5px}
.mb-tools{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.mb-tools input,.mb-tools select{height:34px;border:1px solid #e6e9ef;border-radius:9px;padding:0 10px;font:inherit;font-size:13px;background:#fff}
.mb-scroll{overflow:auto;max-height:560px}
.mb-table{width:100%;border-collapse:collapse;font-size:13px}
.mb-table th{background:#f7f8fa;color:#667085;font-size:11.5px;font-weight:700;text-transform:uppercase;text-align:left;padding:9px 12px;border-bottom:1px solid #e6e9ef;white-space:nowrap}
.mb-table td{padding:10px 12px;border-bottom:1px solid #f0f2f5}
.mb-table .num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.mb-table .sub{display:block;color:#667085;font-size:12px}
.mb-empty{padding:28px 16px;text-align:center;color:#667085;font-size:13px}
.mb-pill{display:inline-flex;padding:3px 9px;border-radius:999px;font-size:12px;font-weight:600;background:#f2f4f7;color:#344054;white-space:nowrap}
.mb-pill.good{background:#ecfdf3;color:#067647}.mb-pill.warn{background:#fffaeb;color:#b54708}.mb-pill.blue{background:#eff4ff;color:#2f55c9}.mb-pill.bad{background:#fef3f2;color:#b42318}
.mb-btn{height:34px;padding:0 13px;border-radius:9px;border:1px solid #e6e9ef;background:#fff;font:inherit;font-size:13px;font-weight:600;color:#344054;cursor:pointer;white-space:nowrap}
.mb-btn.sm{height:28px;padding:0 10px;font-size:12px}
.mb-btn.primary{background:#2f55c9;border-color:#2f55c9;color:#fff}
.mb-note{padding:12px 14px;border-radius:12px;background:#f5f8ff;border:1px solid #d6e0ff;color:#1d3fae;font-size:13px}
.mb-modal{position:fixed;inset:0;z-index:200;background:rgba(16,24,40,.45);display:grid;place-items:center;padding:16px}
.mb-dialog{background:#fff;border-radius:16px;max-width:520px;width:100%;padding:20px;display:grid;gap:12px;max-height:92vh;overflow:auto}
.mb-dialog h3{margin:0;font-size:18px}
.mb-dialog p{margin:0;color:#667085;font-size:13px}
.mb-dialog label{display:grid;gap:5px;font-size:13px;font-weight:600;color:#344054}
.mb-dialog input,.mb-dialog select,.mb-dialog textarea{height:38px;border:1px solid #d0d5dd;border-radius:9px;padding:0 10px;font:inherit;font-size:14px;font-weight:400}
.mb-dialog textarea{height:70px;padding:8px 10px}
.mb-dialog .row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.mb-dialog .acts{display:flex;justify-content:flex-end;gap:8px}
@media(max-width:600px){.mb-dialog .row{grid-template-columns:1fr}}
</style>`,
  );

  const S = { account: null, loaded: false, error: "", sub: "parcels", filter: { from: monthStart(), to: today(), status: "all", q: "" }, stmt: { from: monthStart(), to: today() }, hist: { view: "open", from: monthStart(), to: today() }, data: {} };
  /** Bills / Settlements: open (default) or the paid history for dates; Payments: dates. */
  const docsQuery = a =>
    a.kind === "FINANCIAL"
      ? S.hist.view === "open"
        ? qs({ accountId: a.id, status: "UNPAID" })
        : qs({ accountId: a.id, from: S.hist.from, to: S.hist.to })
      : S.hist.view === "open"
        ? qs({ accountId: a.id, status: "UNPAID" })
        : qs({ accountId: a.id, status: "PAID", from: S.hist.from, to: S.hist.to });
  const qs = o =>
    Object.entries(o)
      .filter(([, v]) => v !== "" && v != null)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");

  async function loadAccount() {
    try {
      const rows = await DF.api("/my-accounts");
      S.account = rows[0] || null;
      S.error = "";
    } catch (error) {
      S.error = DF.describe(error);
    }
    S.loaded = true;
  }
  async function loadSub() {
    const a = S.account;
    if (!a) return;
    const key = subKey();
    try {
      if (S.sub === "parcels") S.data[key] = await DF.api(`/accounts/${a.id}/parcels?${qs(S.filter)}`);
      else if (S.sub === "documents" || S.sub === "history") S.data[key] = a.kind === "FINANCIAL" ? await DF.api(`/bills?${docsQuery(a)}`) : await DF.api(`/payouts?${docsQuery(a)}`);
      else if (S.sub === "payments") S.data[key] = await DF.api(`/payments?${qs({ accountId: a.id, from: S.hist.from, to: S.hist.to })}`);
      else S.data[key] = await DF.api(`/accounts/${a.id}/statement?${qs(S.stmt)}`);
    } catch (error) {
      S.data[key] = { error: DF.describe(error) };
    }
    return key;
  }
  const subKey = () => `${S.sub}:${S.sub === "parcels" ? qs(S.filter) : S.sub === "statement" ? qs(S.stmt) : qs(S.hist)}`;
  const histTools = (openLabel, historyLabel, datesOnly = false) =>
    `<div class="mb-tools">${datesOnly ? "" : `<select id="mbHist" aria-label="Show"><option value="open"${S.hist.view === "open" ? " selected" : ""}>${esc(openLabel)}</option><option value="history"${S.hist.view === "history" ? " selected" : ""}>${esc(historyLabel)}</option></select>`}${
      datesOnly || S.hist.view === "history" ? `<input type="date" id="mbHistFrom" value="${esc(S.hist.from)}" aria-label="From"><input type="date" id="mbHistTo" value="${esc(S.hist.to)}" aria-label="To">` : ""
    }</div>`;

  /** "Due now" = not billed + unpaid bills − adjustment credit − advance credit, spelled out. */
  const dueParts = f =>
    [`not billed ${tk(f.notBilled)}`, f.billedDue ? `+ unpaid bills ${tk(f.billedDue)}` : "", f.openAdjustments ? `${f.openAdjustments > 0 ? "−" : "+"} adjustments ${tk(Math.abs(f.openAdjustments))}` : "", f.credit ? `− credit ${tk(f.credit)}` : ""].filter(Boolean).join(" ");
  const card = (label, value, foot = "", cls = "") => `<div class="mb-card ${cls}"><small>${esc(label)}</small><strong>${value}</strong>${foot ? `<span>${foot}</span>` : ""}</div>`;
  const btn = (label, attrs, cls = "") => `<button type="button" class="mb-btn sm ${cls}" ${attrs}>${esc(label)}</button>`;
  const empty = (cols, text) => `<tr><td colspan="${cols}" class="mb-empty">${esc(text)}</td></tr>`;
  const PAYOUT = { UNPAID: ["Being paid", "warn"], PAID: ["Paid", "good"], CANCELLED: ["Cancelled", ""] };
  const BILL = { ISSUED: ["Unpaid", "warn"], PARTLY_PAID: ["Partly paid", "blue"], PAID: ["Paid", "good"], VOID: ["Void", ""] };
  const PAYMENT = { PENDING: ["Waiting for confirmation", "warn"], CONFIRMED: ["Confirmed", "good"], REJECTED: ["Not confirmed", "bad"] };
  const pill = (map, s) => `<span class="mb-pill ${(map[s] || [])[1] || ""}">${esc((map[s] || [s])[0])}</span>`;

  function markup() {
    if (!isOwner()) return `<div class="mb"><div class="mb-note">Your workspace owner sees the balance, settlements and bills.</div></div>`;
    if (!S.loaded) return `<div class="mb"><div class="mb-box"><div class="mb-empty">Loading your balance…</div></div></div>`;
    if (S.error) return `<div class="mb"><div class="mb-box"><div class="mb-empty">${esc(S.error)}</div></div></div>`;
    const a = S.account;
    if (!a) return `<div class="mb"><div class="mb-note">Your balance appears here after your first delivery.</div></div>`;
    const fin = a.kind === "FINANCIAL";
    const f = a.financial;
    const c = a.cod;
    // Open items only; what's paid is history (Bills / Settlements › Paid, Statement).
    const cards = fin
      ? `${card("Due now", tk(f.due), dueParts(f), f.due > 0 ? "due" : "good")}${card("Not billed yet", tk(f.notBilled), "delivered, waiting for a bill")}${card("Unpaid bills", tk(f.unpaidBills.amount), `${f.unpaidBills.count} bill(s)${f.pending.count ? ` · ${f.pending.count} payment(s) waiting for confirmation` : ""}`)}${card("Last payment", f.lastPayment ? tk(f.lastPayment.amount) : "—", f.lastPayment ? `${esc(day(f.lastPayment.paidOn))} · ${esc(f.lastPayment.number)} · this month ${tk(f.paidThisMonth)}` : "no payment yet")}${f.openAdjustments ? card("Adjustments", `${f.openAdjustments > 0 ? "−" : "+"}${tk(Math.abs(f.openAdjustments))}`, f.openAdjustments > 0 ? "credit, on your next bill" : "extra charge, on your next bill") : ""}`
      : `${card("Ready to pay you", tk(c.ready), "cash at our central hub, less charges", "key")}${card("With riders", tk(c.withRider), "collected from your customers")}${card("At hubs / on the way", tk(c.atHubs), "")}${card("Being paid", tk(c.inSettlement), c.unpaidSettlements ? `${c.unpaidSettlements} settlement(s) on the way` : "nothing waiting")}${card("Last payment to you", c.lastPayout ? tk(c.lastPayout.amount) : "—", c.lastPayout ? `${esc(day(c.lastPayout.paidAt))} · ${esc(c.lastPayout.number)} · this month ${tk(c.paidThisMonth)}` : "nothing paid yet")}`;
    const subs = fin
      ? [
          ["parcels", "Parcels"],
          ["documents", "Bills"],
          ["payments", "Payments"],
          ["statement", "Statement"],
        ]
      : [
          ["parcels", "Parcels"],
          ["documents", "Being paid"],
          ["history", "Paid history"],
          ["statement", "Statement"],
        ];
    if (!subs.some(s => s[0] === S.sub)) S.sub = "parcels";
    const data = S.data[subKey()];
    const body = !data ? `<div class="mb-empty">Loading…</div>` : data.error ? `<div class="mb-empty">${esc(data.error)}</div>` : S.sub === "parcels" ? parcels(a, data) : S.sub === "documents" || S.sub === "history" ? (fin ? bills(data) : payouts(data)) : S.sub === "payments" ? payments(data) : statement(a, data);
    return `<div class="mb">
      ${fin ? "" : `<div class="mb-note">Paid to: ${a.payTo ? `${esc(methodLabel(a.payTo.method))} · ${esc(a.payTo.accountName || "")} · ${esc(a.payTo.accountNumber || "")}` : "no payout account yet: add it in Settings › Payout account"}.</div>`}
      <div class="mb-cards">${cards}</div>
      <div class="mb-bar"><div class="mb-seg">${subs.map(([k, l]) => `<button type="button" class="${S.sub === k ? "on" : ""}" data-mb="sub" data-sub="${k}">${esc(l)}</button>`).join("")}</div>
      <div class="mb-tools">${fin ? btn("I've paid", 'data-mb="paid"', "primary") : ""}${btn("Statement PDF", 'data-mb="statement-pdf"')}</div></div>
      <section class="mb-box">${body}</section>
    </div>`;
  }

  function parcels(a, data) {
    const fin = a.kind === "FINANCIAL";
    const opts = fin
      ? [
          ["all", "All"],
          ["not_billed", "Not billed"],
          ["billed", "Billed, unpaid"],
          ["paid", "Paid"],
        ]
      : [
          ["all", "All"],
          ["open", "Not paid yet"],
          ["ready", "Ready to pay"],
          ["settled", "Paid"],
        ];
    const rows = data.items
      .map(p => {
        const state = fin
          ? p.bill
            ? `${pill(BILL, p.bill.status)}<span class="sub">${esc(p.bill.number)}</span>`
            : `<span class="mb-pill">Not billed</span>`
          : p.payout
            ? `${pill(PAYOUT, p.payout.status === "PAID" ? "PAID" : "UNPAID")}<span class="sub">${esc(p.payout.number)}</span>`
            : p.ready
              ? `<span class="mb-pill blue">Ready to pay</span>`
              : `<span class="mb-pill">${esc(p.cash?.label || "Waiting")}</span>`;
        return fin
          ? `<tr><td><strong>${esc(p.trackingId)}</strong><span class="sub">${esc([p.orderRef, p.recipient].filter(Boolean).join(" · "))}</span></td><td>${esc(p.outcome)}<span class="sub">${day(p.date)}</span></td><td class="num">${tk(p.charge + p.returnCharge)}</td><td>${state}</td></tr>`
          : `<tr><td><strong>${esc(p.trackingId)}</strong><span class="sub">${esc([p.orderRef, p.recipient].filter(Boolean).join(" · "))}</span></td><td>${esc(p.outcome)}<span class="sub">${day(p.date)}</span></td><td class="num">${tk(p.cod)}</td><td class="num">−${tk(p.charge + p.returnCharge)}</td><td class="num"><strong>${tk(p.net)}</strong></td><td>${state}</td></tr>`;
      })
      .join("");
    const head = fin ? `<tr><th>Parcel</th><th>Outcome</th><th class="num">Charge</th><th>Bill</th></tr>` : `<tr><th>Parcel</th><th>Outcome</th><th class="num">COD</th><th class="num">Charges</th><th class="num">Net</th><th>Status</th></tr>`;
    return `<div class="mb-head"><div><h2>Parcels</h2><p>Delivered and returned parcels with their money</p></div><div class="mb-tools"><input type="date" id="mbFrom" value="${esc(S.filter.from)}" aria-label="From"><input type="date" id="mbTo" value="${esc(S.filter.to)}" aria-label="To"><select id="mbStatus" aria-label="Status">${opts.map(([v, l]) => `<option value="${v}"${S.filter.status === v ? " selected" : ""}>${l}</option>`).join("")}</select><input type="search" id="mbQ" placeholder="Tracking ID" value="${esc(S.filter.q)}" aria-label="Search"></div></div>
      <div class="mb-scroll"><table class="mb-table"><thead>${head}</thead><tbody>${rows || empty(fin ? 4 : 6, "No parcels in these dates.")}</tbody></table></div>`;
  }

  function payouts(data) {
    const rows = data.items
      .map(
        p =>
          `<tr><td><strong>${esc(p.number)}</strong><span class="sub">${p.parcels} parcel(s)</span></td><td>${when(p.createdAt)}</td><td class="num">${tk(p.codTotal)}</td><td class="num">−${tk(p.chargesTotal)}</td><td class="num"><strong>${tk(p.amount)}</strong></td><td>${pill(PAYOUT, p.status)}${p.paidAt ? `<span class="sub">${esc(methodLabel(p.method))}${p.reference ? ` · ${esc(p.reference)}` : ""} · ${day(p.paidAt)}</span>` : ""}</td><td>${btn("PDF", `data-mb="payout-pdf" data-id="${p.id}"`)} ${p.receipt ? btn("Receipt photo", `data-mb="file" data-file="${p.receipt.fileId}"`) : ""}</td></tr>`,
      )
      .join("");
    return `<div class="mb-head"><div><h2>${S.hist.view === "open" ? "Being paid" : "Paid history"}</h2><p>${S.hist.view === "open" ? "Settlements on their way to you." : "Paid to you in these dates, with the receipt."}</p></div>${S.hist.view === "open" ? "" : histTools("", "", true)}</div><div class="mb-scroll"><table class="mb-table"><thead><tr><th>Settlement</th><th>Created</th><th class="num">COD</th><th class="num">Charges</th><th class="num">Paid</th><th>Status</th><th></th></tr></thead><tbody>${rows || empty(7, S.hist.view === "open" ? "Nothing being paid right now." : "Nothing paid in these dates.")}</tbody></table></div>`;
  }

  function bills(data) {
    const rows = data.items
      .map(b => `<tr><td><strong>${esc(b.number)}</strong><span class="sub">${b.parcels} parcel(s)</span></td><td>${esc(b.from)} – ${esc(b.to)}<span class="sub">issued ${day(b.issuedAt)}</span></td><td class="num">${tk(b.total)}</td><td class="num">${tk(b.paid)}</td><td class="num"><strong>${tk(b.due)}</strong></td><td>${pill(BILL, b.status)}</td><td>${btn("PDF", `data-mb="bill-pdf" data-id="${b.id}"`)}</td></tr>`)
      .join("");
    return `<div class="mb-head"><div><h2>Bills</h2><p>${S.hist.view === "open" ? "Unpaid and part-paid bills. Paid bills are history: choose All." : "Every bill in these dates."}</p></div>${histTools("Unpaid", "All (history)")}</div><div class="mb-scroll"><table class="mb-table"><thead><tr><th>Bill</th><th>Parcels delivered</th><th class="num">Total</th><th class="num">Paid</th><th class="num">Due</th><th>Status</th><th></th></tr></thead><tbody>${rows || empty(7, S.hist.view === "open" ? "No unpaid bills." : "No bills in these dates.")}</tbody></table></div>`;
  }

  function payments(data) {
    const rows = data.items
      .map(p => `<tr><td><strong>${esc(p.number)}</strong>${p.bills.length ? `<span class="sub">${esc(p.bills.map(b => `${b.number} ${tk(b.amount)}`).join(", "))}</span>` : ""}</td><td>${esc(p.paidOn)}</td><td>${esc(methodLabel(p.method))}${p.reference ? `<span class="sub">${esc(p.reference)}</span>` : ""}</td><td class="num"><strong>${tk(p.amount)}</strong></td><td>${pill(PAYMENT, p.status)}${p.rejectReason ? `<span class="sub">${esc(p.rejectReason)}</span>` : ""}</td><td>${p.receipt ? btn("Receipt", `data-mb="file" data-file="${p.receipt.fileId}"`) : ""}</td></tr>`)
      .join("");
    return `<div class="mb-head"><div><h2>Payments</h2><p>What you paid in these dates. Delivery Fast confirms each one when it arrives.</p></div>${histTools("", "", true)}</div><div class="mb-scroll"><table class="mb-table"><thead><tr><th>Payment</th><th>Paid on</th><th>How</th><th class="num">Amount</th><th>Status</th><th></th></tr></thead><tbody>${rows || empty(6, "No payments in these dates.")}</tbody></table></div>`;
  }

  function statement(a, st) {
    const rows = st.lines.map(l => `<tr><td>${when(l.date)}</td><td>${esc(l.trackingId || "")}</td><td>${esc(l.description)}${l.reference ? `<span class="sub">${esc(l.reference)}</span>` : ""}</td><td class="num" style="color:${l.amount < 0 ? "#b42318" : "#067647"}">${l.amount < 0 ? "−" : "+"}${tk(Math.abs(l.amount))}</td><td class="num"><strong>${tk(l.balance)}</strong></td></tr>`).join("");
    return `<div class="mb-head"><div><h2>Statement</h2><p>${a.kind === "FINANCIAL" ? "Charges minus, payments plus. A minus balance is what you owe." : "COD plus, charges and payments to you minus. The balance is what we still owe you."}</p></div><div class="mb-tools"><input type="date" id="mbStmtFrom" value="${esc(S.stmt.from)}" aria-label="From"><input type="date" id="mbStmtTo" value="${esc(S.stmt.to)}" aria-label="To"></div></div>
      <div class="mb-scroll"><table class="mb-table"><thead><tr><th>Date</th><th>Parcel</th><th>Description</th><th class="num">Amount</th><th class="num">Balance</th></tr></thead><tbody><tr><td colspan="4"><strong>Opening balance</strong></td><td class="num"><strong>${tk(st.opening)}</strong></td></tr>${rows}<tr><td colspan="4"><strong>Closing balance</strong></td><td class="num"><strong>${tk(st.closing)}</strong></td></tr></tbody></table></div>`;
  }

  // ───────────── drawing ─────────────
  const onBalance = () => PAGES.includes(document.getElementById("breadcrumbPage")?.textContent || "");
  function paint() {
    const main = $("mainContent");
    if (!main || !onBalance()) return;
    const crumb = $("breadcrumbPage");
    if (crumb) crumb.textContent = "Balance";
    main.innerHTML = `<div class="page-heading"><div><p class="eyebrow">Money</p><h1>Balance</h1><p class="subtitle">${S.account?.kind === "FINANCIAL" ? "Your delivery charges, bills and payments." : "Your COD: where it is, what's ready and what's been paid to you."}</p></div></div>${markup()}`;
  }
  async function refresh(all = true) {
    if (all) await loadAccount();
    if (S.account) await loadSub();
    paint();
  }
  const base = window.renderPage;
  if (typeof base === "function")
    window.renderPage = function (page) {
      base(page);
      if (PAGES.includes(page)) {
        const crumb = $("breadcrumbPage");
        if (crumb) crumb.textContent = "Balance";
        document.querySelectorAll(".nav-item").forEach(item => item.classList.toggle("active", item.dataset.page === "Payments"));
        paint();
        if (isOwner()) void refresh();
      }
    };

  // ───────────── actions ─────────────
  const openFile = id => {
    const tab = window.open("", "_blank");
    DF.apiRaw(`/files/${encodeURIComponent(id)}`)
      .then(r => r.blob())
      .then(blob => {
        const url = URL.createObjectURL(blob);
        if (tab) tab.location.href = url;
        else window.open(url, "_blank");
      })
      .catch(error => (tab?.close(), toast(DF.describe(error))));
  };
  const shrinkPhoto = file =>
    new Promise((resolve, reject) => {
      if (file.type === "application/pdf") {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("The file couldn't be read."));
        return reader.readAsDataURL(file);
      }
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(img.src);
        resolve(canvas.toDataURL("image/jpeg", 0.8));
      };
      img.onerror = () => reject(new Error("That file isn't a photo or PDF."));
      img.src = URL.createObjectURL(file);
    });

  async function paidDialog() {
    const a = S.account;
    const open = (await DF.api(`/bills?accountId=${a.id}&status=UNPAID`).catch(() => ({ items: [] }))).items;
    $("mbModal")?.remove();
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div class="mb-modal" id="mbModal"><form class="mb-dialog" id="mbPaidForm">
        <h3>I've paid</h3><p>Tell us about your payment. It shows as waiting until Delivery Fast confirms it arrived. Part payments are welcome.</p>
        <div class="row"><label>Amount (৳)<input name="amount" type="number" min="0.01" step="0.01" inputmode="decimal" required value="${a.financial.due > 0 ? esc(String(a.financial.due)) : ""}"></label>
        <label>Paid by<select name="method">${METHODS.filter(m => m[0] !== "CASH").map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label></div>
        <div class="row"><label>Paid on<input name="paidOn" type="date" required value="${today()}"></label><label>Transaction / cheque reference<input name="reference" maxlength="120"></label></div>
        ${open.length ? `<label>For bill<select name="billId"><option value="">Oldest bills first</option>${open.map(b => `<option value="${b.id}">${esc(b.number)} · due ${tk(b.due)}</option>`).join("")}</select></label>` : ""}
        <label>Receipt (photo or PDF, optional)<input name="proof" type="file" accept="image/*,application/pdf" style="height:auto;padding:6px"></label>
        <label>Note (optional)<textarea name="note" maxlength="300"></textarea></label>
        <p id="mbPaidError" role="alert" style="color:#b42318"></p>
        <div class="acts"><button type="button" class="mb-btn" data-mb="close">Cancel</button><button type="submit" class="mb-btn primary">Submit payment</button></div>
      </form></div>`,
    );
  }

  window.addEventListener(
    "click",
    event => {
      const el = event.target instanceof Element ? event.target.closest("[data-mb]") : null;
      if (!el) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const d = el.dataset;
      const a = S.account;
      switch (d.mb) {
        case "sub":
          S.sub = d.sub;
          // Settlements: Being paid / Paid history are their own tabs; Bills keep their Unpaid / All switch.
          S.hist.view = d.sub === "history" ? "history" : "open";
          paint();
          return void refresh(false);
        case "paid":
          return void paidDialog();
        case "close":
          return $("mbModal")?.remove();
        case "statement-pdf":
          return a && window.DFPrint?.open(`/documents/account-statement/${a.id}?${qs(S.stmt)}`, { title: "Preparing your statement…" });
        case "payout-pdf":
          return window.DFPrint?.open(`/documents/payout/${d.id}`, { title: "Preparing the settlement…" });
        case "bill-pdf":
          return window.DFPrint?.open(`/documents/bill/${d.id}`, { title: "Preparing the bill…" });
        case "file":
          return openFile(d.file);
      }
    },
    true,
  );
  window.addEventListener(
    "submit",
    async event => {
      if (event.target?.id !== "mbPaidForm") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const form = event.target;
      const button = form.querySelector('[type="submit"]');
      button.disabled = true;
      try {
        const file = form.elements.proof?.files?.[0];
        const body = {
          amount: Number(form.elements.amount.value),
          method: form.elements.method.value,
          paidOn: form.elements.paidOn.value,
          reference: form.elements.reference.value.trim() || undefined,
          billId: form.elements.billId?.value || undefined,
          note: form.elements.note.value.trim() || undefined,
          proof: file ? await shrinkPhoto(file) : undefined,
        };
        const p = await DF.api(`/accounts/${S.account.id}/payments`, { method: "POST", body });
        $("mbModal")?.remove();
        toast(`${p.number} sent: Delivery Fast confirms it when the money arrives.`);
        S.sub = "payments";
        void refresh();
      } catch (error) {
        $("mbPaidError").textContent = DF.describe(error);
        button.disabled = false;
      }
    },
    true,
  );
  document.addEventListener("change", event => {
    const t = event.target;
    if (!(t instanceof HTMLElement) || !onBalance()) return;
    if (t.id === "mbFrom" || t.id === "mbTo" || t.id === "mbStatus") {
      S.filter[{ mbFrom: "from", mbTo: "to", mbStatus: "status" }[t.id]] = t.value;
      return void refresh(false);
    }
    if (t.id === "mbHist" || t.id === "mbHistFrom" || t.id === "mbHistTo") {
      S.hist[{ mbHist: "view", mbHistFrom: "from", mbHistTo: "to" }[t.id]] = t.value;
      return void refresh(false);
    }
    if (t.id === "mbStmtFrom" || t.id === "mbStmtTo") {
      S.stmt[t.id === "mbStmtFrom" ? "from" : "to"] = t.value;
      return void refresh(false);
    }
  });
  let timer = null;
  document.addEventListener("input", event => {
    if (event.target?.id !== "mbQ") return;
    S.filter.q = event.target.value;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await refresh(false);
      const again = $("mbQ");
      if (again) (again.focus(), again.setSelectionRange(again.value.length, again.value.length));
    }, 350);
  });
  DF.live?.(["account.updated"], () => onBalance() && isOwner() && void refresh());
})();
