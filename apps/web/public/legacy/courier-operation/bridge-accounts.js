/*
 * Courier Operations › Accounts (menu "Accounts"; replaces COD & settlement). Its own design (acc-*).
 *
 *   Overview       where the cash is, unpaid settlements, payments to confirm (GET /accounts/overview)
 *   E-commerce     merchants: ready to pay → Settle (ST-, PDF, Mark paid with receipt photo)
 *   Financial      merchants: not billed / due → Generate bill (INV-), Record / confirm payments (PAY-)
 *   Customer       senders of COD parcels: like E-commerce
 *   Rider cash     scan a rider's slip (HS-) and receive the cash; slips waiting; dues
 *   Hub transfers  cash on hand per hub → Send to central hub (HT-); in transit → Receive
 *   Rider pay      rider payouts (bridge-rider-pay.js); Franchise: deposits and commission invoices (bridge-franchise.js)
 *
 * An account opens in place: cards, actions, and Parcels · Settlements / Bills · Payments · Statement.
 * API: modules/money (accounts, payouts, bills, payments, cash). Live: account.updated, cash.slip, cash.transfer.
 */
(() => {
  const DF = window.DF;
  const Ops = window.DFOps;
  if (!DF || !Ops) return;
  const $ = id => document.getElementById(id);
  const esc = Ops.esc;
  const toast = message => window.showToast(message);
  const fail = error => toast(DF.describe(error));
  const tk = n => `৳${Number(n || 0).toLocaleString("en-BD", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
  const day = iso => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Dhaka" }) : "—");
  const when = iso => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Dhaka" }) : "—");
  const today = () => new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
  const monthStart = () => `${today().slice(0, 8)}01`;
  const METHODS = [
    ["BKASH", "bKash"],
    ["NAGAD", "Nagad"],
    ["ROCKET", "Rocket"],
    ["BANK", "Bank transfer"],
    ["CASH", "Cash"],
    ["OTHER", "Other"],
  ];

  // ───────────── look ─────────────
  document.head.insertAdjacentHTML(
    "beforeend",
    `<style id="accStyles">
.acc{--a-line:#e6e9ef;--a-ink:#101828;--a-mute:#667085;--a-soft:#f7f8fa;--a-blue:#2f55c9;--a-green:#067647;--a-red:#b42318;--a-amber:#b54708;display:grid;gap:16px;color:var(--a-ink)}
.acc-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.acc-card{background:#fff;border:1px solid var(--a-line);border-radius:14px;padding:14px 16px;display:grid;gap:4px;min-height:84px}
.acc-card small{color:var(--a-mute);font-size:12px;font-weight:600;letter-spacing:.02em}
.acc-card strong{font-size:22px;font-weight:700;line-height:1.2}
.acc-card span{color:var(--a-mute);font-size:12px}
.acc-card.is-key{border-color:#b8c8ff;background:linear-gradient(180deg,#f5f8ff,#fff)}
.acc-card.is-key strong{color:var(--a-blue)}
.acc-card.is-due strong{color:var(--a-red)}
.acc-card.is-good strong{color:var(--a-green)}
.acc-box{background:#fff;border:1px solid var(--a-line);border-radius:14px;overflow:hidden}
.acc-box-head{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;padding:14px 16px;border-bottom:1px solid var(--a-line)}
.acc-box-head h2{margin:0;font-size:15px;font-weight:700}
.acc-box-head p{margin:2px 0 0;color:var(--a-mute);font-size:12.5px}
.acc-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.acc-tools input,.acc-tools select{height:34px;border:1px solid var(--a-line);border-radius:9px;padding:0 10px;font:inherit;font-size:13px;background:#fff}
.acc-table{width:100%;border-collapse:collapse;font-size:13px}
.acc-table th{background:var(--a-soft);color:var(--a-mute);font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;text-align:left;padding:9px 12px;border-bottom:1px solid var(--a-line);white-space:nowrap}
.acc-table td{padding:10px 12px;border-bottom:1px solid #f0f2f5;vertical-align:middle}
.acc-table tr:last-child td{border-bottom:0}
.acc-table td.num,.acc-table th.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.acc-table tr.is-link{cursor:pointer}
.acc-table tr.is-link:hover td{background:#f8faff}
.acc-table .sub{display:block;color:var(--a-mute);font-size:12px;margin-top:2px}
.acc-scroll{overflow:auto;max-height:560px}
.acc-empty{padding:28px 16px;text-align:center;color:var(--a-mute);font-size:13px}
.acc-pill{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;font-size:12px;font-weight:600;background:#f2f4f7;color:#344054;white-space:nowrap}
.acc-pill.good{background:#ecfdf3;color:var(--a-green)}
.acc-pill.warn{background:#fffaeb;color:var(--a-amber)}
.acc-pill.bad{background:#fef3f2;color:var(--a-red)}
.acc-pill.blue{background:#eff4ff;color:var(--a-blue)}
.acc-btn{height:34px;padding:0 13px;border-radius:9px;border:1px solid var(--a-line);background:#fff;font:inherit;font-size:13px;font-weight:600;color:#344054;cursor:pointer;white-space:nowrap}
.acc-btn:hover{background:#f9fafb}
.acc-btn.primary{background:var(--a-blue);border-color:var(--a-blue);color:#fff}
.acc-btn.primary:hover{background:#2747ad}
.acc-btn.sm{height:28px;padding:0 10px;font-size:12px;border-radius:8px}
.acc-btn.danger{color:var(--a-red)}
.acc-actions{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.acc-head{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap}
.acc-head h2{margin:2px 0 4px;font-size:20px}
.acc-head p{margin:0;color:var(--a-mute);font-size:13px}
.acc-back{justify-self:start;border:0;background:none;color:var(--a-blue);font:inherit;font-size:13px;font-weight:600;cursor:pointer;padding:0}
.acc-seg{display:inline-flex;gap:4px;padding:4px;border-radius:11px;background:#eef1f5}
.acc-seg button{border:0;background:transparent;color:#556274;padding:7px 13px;border-radius:8px;font:inherit;font-size:13px;font-weight:600;cursor:pointer}
.acc-seg button.on{background:#fff;color:var(--a-blue);box-shadow:0 1px 2px rgba(16,24,40,.08)}
.acc-note{padding:12px 14px;border-radius:12px;background:#fffaeb;border:1px solid #fedf89;color:#7a2e0e;font-size:13px}
.acc-scan{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:16px}
.acc-scan input{flex:1;min-width:220px;height:44px;border:1.5px solid #c7d2fe;border-radius:11px;padding:0 14px;font:inherit;font-size:16px;letter-spacing:.04em}
.acc-slip{display:grid;grid-template-columns:1fr auto;gap:14px;padding:16px;border-top:1px solid var(--a-line);background:#fcfcfd}
.acc-slip .big{font-size:28px;font-weight:800}
.acc-kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px 16px;font-size:13px}
.acc-kv small{display:block;color:var(--a-mute);font-size:11.5px;font-weight:600}
.acc-pick{border:1px solid var(--a-line);border-radius:10px;max-height:320px;overflow:auto}
.acc-sum{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-top:10px;font-size:13px}
.acc-sum small{color:var(--a-mute);display:block;font-size:11.5px}
.acc-hubs{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;padding:14px}
.acc-hub{border:1px solid var(--a-line);border-radius:12px;padding:14px;display:grid;gap:8px}
.acc-hub strong.big{font-size:22px}
@media(max-width:720px){.acc-slip{grid-template-columns:1fr}.acc-table{font-size:12px}}
</style>`,
  );

  // ───────────── who may do what ─────────────
  const config = () => Ops.lazy("acc-config", () => DF.api("/accounts/config"), 120000);
  const central = () => config()?.centralHub || null;
  /** Finance, operations managers, super admins, and the central hub's staff. */
  const moneyStaff = () => {
    if (Ops.can("manageFinance") && Ops.can("financeStaff")) return true;
    const c = central();
    if (!c || !Ops.can("receiveCash")) return false;
    const scope = Ops.me?.hubIds;
    return !scope || scope.includes(c.id);
  };
  const cashStaff = () => Ops.can("receiveCash");

  // ───────────── state ─────────────
  const S = {
    open: { ECOMMERCE: null, FINANCIAL: null, CUSTOMER: null }, // account id shown in place of the list
    sub: "parcels", // parcels | documents | payments | statement
    q: { ECOMMERCE: "", FINANCIAL: "", CUSTOMER: "" },
    filter: { from: monthStart(), to: today(), q: "", status: "all" },
    stmt: { from: monthStart(), to: today() },
    // Bills / Settlements: open (default) or the paid history for dates; Payments: dates.
    hist: { view: "open", from: monthStart(), to: today() },
    slip: null, // the scanned slip
    slipError: "",
    transferScan: "",
  };
  const KIND_PAGE = { ECOMMERCE: "Accounts E-commerce", FINANCIAL: "Accounts Financial", CUSTOMER: "Accounts Customer" };
  const KIND_LABEL = { ECOMMERCE: "E-commerce", FINANCIAL: "Financial", CUSTOMER: "Customer" };
  const pageKind = () => Object.keys(KIND_PAGE).find(k => KIND_PAGE[k] === Ops.page());
  const rerender = () => Ops.rerender(true);
  const after = (...keys) => {
    // List keys carry their query (acc-bills-<id>-…): invalidate every key that starts with one given.
    Ops.invalidate(...Object.keys(Ops.cache).filter(k => keys.some(p => k === p || k.startsWith(`${p}-`))));
    rerender();
  };
  const qs = o =>
    Object.entries(o)
      .filter(([, v]) => v !== "" && v != null)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");

  // ───────────── small parts ─────────────
  const card = (label, value, foot = "", cls = "") => `<div class="acc-card ${cls}"><small>${esc(label)}</small><strong>${value}</strong>${foot ? `<span>${foot}</span>` : ""}</div>`;
  const btn = (label, attrs, cls = "") => `<button type="button" class="acc-btn sm ${cls}" ${attrs}>${esc(label)}</button>`;
  const empty = (cols, text) => `<tr><td colspan="${cols}" class="acc-empty">${esc(text)}</td></tr>`;
  const loading = (key, text) => (Ops.lazyError(key) ? DF.describe(Ops.lazyError(key)) : text);
  const heading = (title, subtitle, actions = "") =>
    `<div class="page-heading"><div><p class="eyebrow">Money</p><h1>${esc(title)}</h1><p class="subtitle">${esc(subtitle)}</p></div><div class="heading-actions">${actions}</div></div>`;
  const box = (title, sub, tools, body) => `<section class="acc-box"><div class="acc-box-head"><div><h2>${esc(title)}</h2>${sub ? `<p>${esc(sub)}</p>` : ""}</div>${tools ? `<div class="acc-tools">${tools}</div>` : ""}</div>${body}</section>`;
  const PAYOUT_PILL = { UNPAID: ["To pay", "warn"], PAID: ["Paid", "good"], CANCELLED: ["Cancelled", ""] };
  const BILL_PILL = { ISSUED: ["Unpaid", "warn"], PARTLY_PAID: ["Partly paid", "blue"], PAID: ["Paid", "good"], VOID: ["Void", ""] };
  const PAYMENT_PILL = { PENDING: ["To confirm", "warn"], CONFIRMED: ["Confirmed", "good"], REJECTED: ["Rejected", "bad"] };
  const pill = (map, s) => {
    const [text, cls] = map[s] || [s, ""];
    return `<span class="acc-pill ${cls}">${esc(text)}</span>`;
  };
  const methodLabel = m => (METHODS.find(x => x[0] === m) || [m, m])[1];
  const payToText = p => (p ? `${methodLabel(p.method)} · ${p.accountName || ""} · ${p.accountNumber || ""}${p.bankName ? ` · ${p.bankName}` : ""}` : "No payout account on file");
  /** "Due now" = not billed + unpaid bills − adjustment credit − advance credit, spelled out. */
  const dueParts = f =>
    [`not billed ${tk(f.notBilled)}`, f.billedDue ? `+ unpaid bills ${tk(f.billedDue)}` : "", f.openAdjustments ? `${f.openAdjustments > 0 ? "−" : "+"} adjustments ${tk(Math.abs(f.openAdjustments))}` : "", f.credit ? `− credit ${tk(f.credit)}` : ""].filter(Boolean).join(" ");
  const noCentral = () =>
    config() && !central() ? `<div class="acc-note"><strong>No central hub yet.</strong> A super admin chooses it in Super admin › Global notifications › Accounts. Until then cash can be received at hubs but not sent on or settled.</div>` : "";

  // ───────────── Overview ─────────────
  function overviewPage() {
    if (!moneyStaff()) return heading("Accounts", "Rider cash and hub transfers.") + `<div class="acc"><div class="acc-note">Open Rider cash or Hub transfers.</div></div>`;
    const o = Ops.lazy("acc-overview", () => DF.api("/accounts/overview"), 20000);
    const unpaid = Ops.lazy("acc-unpaid", () => DF.api("/payouts?status=UNPAID"), 20000)?.items || [];
    const pending = Ops.lazy("acc-pending", () => DF.api("/payments?status=PENDING"), 20000)?.items || [];
    const c = o?.cash || {};
    const v = s => (c[s] ? tk(c[s].amount) : "—");
    const n = s => (c[s] ? `${c[s].count} parcel${c[s].count === 1 ? "" : "s"}` : "");
    const actions = Ops.can("financeSettings") ? `<button type="button" class="acc-btn" data-acc="settings">Invoice settings</button>` : "";
    return (
      heading("Accounts", `Where the money is now. Central hub: ${central()?.name || "not set"}.`, actions) +
      `<div class="acc">${noCentral()}
      <div class="acc-cards">
        ${card("With riders", v("WITH_RIDER"), n("WITH_RIDER"))}
        ${card("At hubs", v("AT_HUB"), `${n("AT_HUB")} · to send on`)}
        ${card("In transit", v("IN_TRANSIT"), n("IN_TRANSIT"))}
        ${card("At central hub", v("AT_CENTRAL"), `${n("AT_CENTRAL")} · ready to settle`, "is-key")}
        ${card("Settlements to pay", o ? tk(o.unpaidPayouts.amount) : "—", o ? `${o.unpaidPayouts.count} settlement(s)` : "", o?.unpaidPayouts.count ? "is-due" : "")}
        ${card("Financial merchants owe", o ? tk(o.financialDue) : "—", "billed and not billed")}
      </div>
      ${box(
        "Settlements to pay",
        "Created and waiting for the money to be sent. Mark paid with the reference and a receipt photo.",
        "",
        `<div class="acc-scroll"><table class="acc-table"><thead><tr><th>Settlement</th><th>Account</th><th class="num">Net</th><th>Pay to</th><th>Created</th><th></th></tr></thead><tbody>${
          unpaid.map(p => `<tr><td><strong>${esc(p.number)}</strong><span class="sub">${p.parcels} parcel(s)</span></td><td>${esc(p.account.name)}<span class="sub">${esc(KIND_LABEL[p.account.kind] || "")}</span></td><td class="num"><strong>${tk(p.amount)}</strong></td><td>${esc(payToText(p.payTo))}</td><td>${when(p.createdAt)}</td><td><div class="acc-actions">${btn("PDF", `data-acc="payout-pdf" data-id="${p.id}"`)}${btn("Mark paid", `data-acc="payout-pay" data-id="${p.id}"`, "primary")}</div></td></tr>`).join("") ||
          empty(6, loading("acc-unpaid", "Nothing waiting to be paid."))
        }</tbody></table></div>`,
      )}
      ${box(
        "Payments to confirm",
        "Financial merchants said they paid. Check your bank / wallet, then confirm or reject.",
        "",
        `<div class="acc-scroll"><table class="acc-table"><thead><tr><th>Payment</th><th>Merchant</th><th class="num">Amount</th><th>How</th><th>Paid on</th><th></th></tr></thead><tbody>${
          pending.map(p => paymentRow(p, true)).join("") || empty(6, loading("acc-pending", "No payments to confirm."))
        }</tbody></table></div>`,
      )}</div>`
    );
  }

  // ───────────── account lists ─────────────
  function listPage(kind) {
    if (S.open[kind]) return accountPage(kind, S.open[kind]);
    const subtitle = {
      ECOMMERCE: "Merchants' COD less charges. Open a merchant to settle what's ready (cash at the central hub).",
      FINANCIAL: "Banking & financial merchants: their delivery and return charges. Open one to bill parcels and record payments.",
      CUSTOMER: "Senders of COD parcels from the website. Open one to settle what's ready.",
    }[kind];
    if (!moneyStaff()) return heading(`${KIND_LABEL[kind]} accounts`, subtitle) + `<div class="acc"><div class="acc-note">Only finance, operations managers and central hub staff see merchants' accounts.</div></div>`;
    const key = `acc-list-${kind}`;
    const page = Ops.lazy(key, () => DF.api(`/accounts?${qs({ kind })}`), 20000);
    const q = S.q[kind].toLowerCase();
    const items = (page?.items || []).filter(a => !q || `${a.name} ${a.code || ""} ${a.phone || ""}`.toLowerCase().includes(q));
    const fin = kind === "FINANCIAL";
    const totals = page?.totals;
    const cards = fin
      ? `${card("Merchants owe", totals ? tk(totals.due) : "—", `${totals?.accounts ?? "—"} merchant(s)`, "is-due")}${card("Not billed yet", tk(items.reduce((t, a) => t + a.notBilled, 0)), "charges waiting for a bill")}`
      : `${card("Ready to pay", totals ? tk(totals.ready) : "—", `${items.filter(a => a.ready > 0).length} account(s) ready`, "is-key")}${card("Accounts", String(totals?.accounts ?? "—"), "with parcels")}`;
    const rows = items
      .map(a =>
        fin
          ? `<tr class="is-link" data-acc="open" data-id="${a.id}" data-kind="${kind}"><td><strong>${esc(a.name)}</strong><span class="sub">${esc(a.code || "")}</span></td><td class="num">${tk(a.notBilled)}</td><td class="num"><strong style="color:${a.due > 0 ? "#b42318" : "inherit"}">${tk(a.due)}</strong></td><td class="num">${a.parcels}</td><td>${when(a.lastActivity)}</td></tr>`
          : `<tr class="is-link" data-acc="open" data-id="${a.id}" data-kind="${kind}"><td><strong>${esc(a.name)}</strong><span class="sub">${esc(a.code || DF.localPhone?.(a.phone) || a.phone || "")}</span></td><td class="num"><strong style="color:${a.ready > 0 ? "#2f55c9" : "inherit"}">${tk(a.ready)}</strong></td><td class="num">${tk(a.balance)}</td><td class="num">${a.parcels}</td><td>${when(a.lastActivity)}</td></tr>`,
      )
      .join("");
    const head = fin
      ? `<tr><th>Merchant</th><th class="num">Not billed</th><th class="num">Due</th><th class="num">Parcels</th><th>Last activity</th></tr>`
      : `<tr><th>${kind === "CUSTOMER" ? "Customer" : "Merchant"}</th><th class="num">Ready to pay</th><th class="num">Owed in all</th><th class="num">Parcels</th><th>Last activity</th></tr>`;
    return (
      heading(`${KIND_LABEL[kind]} accounts`, subtitle) +
      `<div class="acc">${noCentral()}<div class="acc-cards">${cards}</div>${box(
        `${KIND_LABEL[kind]} accounts`,
        fin ? "Largest due first. Click a merchant to open it." : "Largest ready amount first. \"Owed in all\" includes cash still with riders or on its way.",
        `<input type="search" id="accListQ" data-kind="${kind}" placeholder="Search name, code or phone" value="${esc(S.q[kind])}" aria-label="Search accounts">`,
        `<div class="acc-scroll"><table class="acc-table"><thead>${head}</thead><tbody>${rows || empty(5, loading(key, page ? "No accounts yet: they appear when parcels are delivered." : "Loading…"))}</tbody></table></div>`,
      )}</div>`
    );
  }

  // ───────────── one account ─────────────
  function accountPage(kind, id) {
    const key = `acc-${id}`;
    const a = Ops.lazy(key, () => DF.api(`/accounts/${id}`), 15000);
    const fin = kind === "FINANCIAL";
    const staff = moneyStaff();
    const back = `<button type="button" class="acc-back" data-acc="back" data-kind="${kind}">← All ${esc(KIND_LABEL[kind])} accounts</button>`;
    if (!a) return heading(`${KIND_LABEL[kind]} account`, "") + `<div class="acc">${back}<div class="acc-box"><div class="acc-empty">${esc(loading(key, "Loading…"))}</div></div></div>`;
    const actions = staff
      ? fin
        ? `${btn("Generate bill", `data-acc="bill-new"`, "primary")}${btn("Record payment", `data-acc="payment-new"`)}${btn("Adjustment", `data-acc="adjust"`)}`
        : `${btn("Settle", `data-acc="settle"`, "primary")}${btn("Adjustment", `data-acc="adjust"`)}`
      : "";
    const f = a.financial;
    const c = a.cod;
    // Open items only; what's paid is history (Bills / Settlements tab › Paid, Statement).
    const cards = fin
      ? `${card("Due now", tk(f.due), dueParts(f), f.due > 0 ? "is-due" : "is-good")}${card("Not billed", tk(f.notBilled), "charges waiting for a bill")}${card("Unpaid bills", tk(f.unpaidBills.amount), `${f.unpaidBills.count} bill(s)${f.pending.count ? ` · ${f.pending.count} payment(s) to confirm` : ""}`)}${card("Last payment", f.lastPayment ? tk(f.lastPayment.amount) : "—", f.lastPayment ? `${esc(day(f.lastPayment.paidOn))} · ${esc(f.lastPayment.number)} · this month ${tk(f.paidThisMonth)}` : "no payment yet")}${f.openAdjustments ? card("Adjustments", `${f.openAdjustments > 0 ? "−" : "+"}${tk(Math.abs(f.openAdjustments))}`, f.openAdjustments > 0 ? "credit, on the next bill" : "extra charge, on the next bill") : ""}`
      : `${card("Ready to pay", tk(c.ready), "cash at the central hub, less charges", "is-key")}${card("With riders", tk(c.withRider), "collected, not handed over")}${card("At hubs / on the way", tk(c.atHubs), "")}${card("To pay", tk(c.inSettlement), c.unpaidSettlements ? `${c.unpaidSettlements} settlement(s) created, not paid` : "nothing waiting")}${card("Last settlement", c.lastPayout ? tk(c.lastPayout.amount) : "—", c.lastPayout ? `${esc(day(c.lastPayout.paidAt))} · ${esc(c.lastPayout.number)} · this month ${tk(c.paidThisMonth)}` : "nothing paid yet")}`;
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
    return (
      heading(`${KIND_LABEL[kind]} account`, `${a.name}${a.code ? ` · ${a.code}` : a.phone ? ` · ${DF.localPhone?.(a.phone) || a.phone}` : ""}`) +
      `<div class="acc" data-acc-account="${id}">${back}
      <div class="acc-head"><div><h2>${esc(a.name)}</h2><p>${fin ? "Financial merchant · billed for delivery and return charges" : `Pays to: ${esc(payToText(a.payTo))}`}</p></div><div class="acc-actions">${actions}${btn("Statement PDF", `data-acc="statement-pdf"`)}</div></div>
      <div class="acc-cards">${cards}</div>
      <div><div class="acc-seg" role="tablist">${subs.map(([k, l]) => `<button type="button" class="${S.sub === k ? "on" : ""}" data-acc="sub" data-sub="${k}">${esc(l)}</button>`).join("")}</div></div>
      ${S.sub === "parcels" ? parcelsBox(a) : S.sub === "documents" ? (fin ? billsBox(a) : payoutsBox(a, "open")) : S.sub === "history" ? payoutsBox(a, "history") : S.sub === "payments" ? paymentsBox(a) : statementBox(a)}
      </div>`
    );
  }

  function parcelsBox(a) {
    const fin = a.kind === "FINANCIAL";
    const fl = S.filter;
    const key = `acc-parcels-${a.id}-${qs(fl)}`;
    const page = Ops.lazy(key, () => DF.api(`/accounts/${a.id}/parcels?${qs(fl)}`), 15000);
    const items = page?.items || [];
    const statusOptions = fin
      ? [
          ["all", "All"],
          ["not_billed", "Not billed"],
          ["billed", "Billed, unpaid"],
          ["paid", "Paid"],
        ]
      : [
          ["all", "All"],
          ["ready", "Ready to pay"],
          ["open", "Not settled"],
          ["settled", "Settled"],
        ];
    const tools = `<input type="date" id="accFrom" value="${esc(fl.from)}" aria-label="From"><input type="date" id="accTo" value="${esc(fl.to)}" aria-label="To"><select id="accStatus" aria-label="Status">${statusOptions.map(([v, l]) => `<option value="${v}"${fl.status === v ? " selected" : ""}>${l}</option>`).join("")}</select><input type="search" id="accParcelQ" placeholder="Tracking ID" value="${esc(fl.q)}" aria-label="Search tracking ID">`;
    const rows = items
      .map(p => {
        const state = fin
          ? p.bill
            ? `${pill(BILL_PILL, p.bill.status)}<span class="sub">${esc(p.bill.number)}</span>`
            : `<span class="acc-pill">Not billed</span>`
          : p.payout
            ? `${pill(PAYOUT_PILL, p.payout.status === "PAID" ? "PAID" : "UNPAID")}<span class="sub">${esc(p.payout.number)}</span>`
            : p.ready
              ? `<span class="acc-pill blue">Ready</span>`
              : `<span class="acc-pill">${esc(p.cash?.label || "Waiting")}</span>`;
        return fin
          ? `<tr><td><strong>${esc(p.trackingId)}</strong><span class="sub">${esc([p.orderRef, p.recipient].filter(Boolean).join(" · "))}</span></td><td>${esc(p.outcome)}<span class="sub">${day(p.date)}</span></td><td>${esc(p.destination)}</td><td class="num">${tk(p.charge + p.returnCharge)}</td><td>${state}</td></tr>`
          : `<tr><td><strong>${esc(p.trackingId)}</strong><span class="sub">${esc([p.orderRef, p.recipient].filter(Boolean).join(" · "))}</span></td><td>${esc(p.outcome)}<span class="sub">${day(p.date)}</span></td><td class="num">${tk(p.cod)}</td><td class="num">−${tk(p.charge + p.returnCharge)}</td><td class="num"><strong>${tk(p.net)}</strong></td><td>${state}</td></tr>`;
      })
      .join("");
    const head = fin
      ? `<tr><th>Parcel</th><th>Outcome</th><th>Destination</th><th class="num">Charge</th><th>Bill</th></tr>`
      : `<tr><th>Parcel</th><th>Outcome</th><th class="num">COD</th><th class="num">Charges</th><th class="num">Net</th><th>Where / settlement</th></tr>`;
    const sumNet = items.reduce((t, p) => t + (fin ? p.charge + p.returnCharge : p.net), 0);
    return box(
      "Parcels",
      `${items.length} parcel(s) delivered or returned in these dates · ${fin ? "charges" : "net"} ${tk(sumNet)}${page?.truncated ? " · showing the first 2000: narrow the dates" : ""}`,
      tools,
      `<div class="acc-scroll"><table class="acc-table"><thead>${head}</thead><tbody>${rows || empty(fin ? 5 : 6, loading(key, page ? "No parcels in these dates." : "Loading…"))}</tbody></table></div>`,
    );
  }

  /** Open / Paid history switch with the history's dates (Bills, Settlements); dates only (Payments). */
  const histTools = (openLabel, historyLabel, datesOnly = false) =>
    `${datesOnly ? "" : `<select id="accHist" aria-label="Show"><option value="open"${S.hist.view === "open" ? " selected" : ""}>${esc(openLabel)}</option><option value="history"${S.hist.view === "history" ? " selected" : ""}>${esc(historyLabel)}</option></select>`}${
      datesOnly || S.hist.view === "history" ? `<input type="date" id="accHistFrom" value="${esc(S.hist.from)}" aria-label="From"><input type="date" id="accHistTo" value="${esc(S.hist.to)}" aria-label="To">` : ""
    }`;
  const histQuery = (open, history) => (S.hist.view === "open" ? qs(open) : qs({ ...history, from: S.hist.from, to: S.hist.to }));

  /** Being paid (created, not paid yet) or Paid history (paid in the chosen dates): their own tabs. */
  function payoutsBox(a, view) {
    S.hist.view = view;
    const query = histQuery({ accountId: a.id, status: "UNPAID" }, { accountId: a.id, status: "PAID" });
    const key = `acc-payouts-${a.id}-${query}`;
    const items = Ops.lazy(key, () => DF.api(`/payouts?${query}`), 15000)?.items || [];
    const staff = moneyStaff();
    const rows = items
      .map(
        p =>
          `<tr><td><strong>${esc(p.number)}</strong><span class="sub">${p.parcels} parcel(s)</span></td><td>${when(p.createdAt)}</td><td class="num">${tk(p.codTotal)}</td><td class="num">−${tk(p.chargesTotal)}</td><td class="num"><strong>${tk(p.amount)}</strong></td><td>${pill(PAYOUT_PILL, p.status)}${p.paidAt ? `<span class="sub">${esc(methodLabel(p.method))}${p.reference ? ` · ${esc(p.reference)}` : ""} · ${day(p.paidAt)}</span>` : ""}</td><td><div class="acc-actions">${btn("PDF", `data-acc="payout-pdf" data-id="${p.id}"`)}${p.receipt ? btn("Receipt", `data-acc="file" data-file="${p.receipt.fileId}"`) : ""}${
            staff && p.status === "UNPAID" ? btn("Cancel", `data-acc="payout-cancel" data-id="${p.id}" data-number="${esc(p.number)}"`, "danger") + btn("Mark paid", `data-acc="payout-pay" data-id="${p.id}"`, "primary") : ""
          }</div></td></tr>`,
      )
      .join("");
    return box(
      view === "open" ? "Being paid" : "Paid history",
      view === "open" ? "Settlements created and waiting for the money to be sent. Mark paid with the reference and a receipt photo." : "Settlements paid in these dates, with their receipts.",
      view === "open" ? "" : histTools("", "", true),
      `<div class="acc-scroll"><table class="acc-table"><thead><tr><th>Settlement</th><th>Created</th><th class="num">COD</th><th class="num">Charges</th><th class="num">Net</th><th>Status</th><th></th></tr></thead><tbody>${rows || empty(7, loading(key, S.hist.view === "open" ? "Nothing waiting to be paid." : "No settlements paid in these dates."))}</tbody></table></div>`,
    );
  }

  function billsBox(a) {
    const query = histQuery({ accountId: a.id, status: "UNPAID" }, { accountId: a.id });
    const key = `acc-bills-${a.id}-${query}`;
    const items = Ops.lazy(key, () => DF.api(`/bills?${query}`), 15000)?.items || [];
    const staff = moneyStaff();
    const rows = items
      .map(
        b =>
          `<tr><td><strong>${esc(b.number)}</strong><span class="sub">${b.parcels} parcel(s)</span></td><td>${esc(b.from)} – ${esc(b.to)}<span class="sub">issued ${day(b.issuedAt)}</span></td><td class="num">${tk(b.total)}</td><td class="num">${tk(b.paid)}</td><td class="num"><strong>${tk(b.due)}</strong></td><td>${pill(BILL_PILL, b.status)}${b.voidReason ? `<span class="sub">${esc(b.voidReason)}</span>` : ""}</td><td><div class="acc-actions">${btn("PDF", `data-acc="bill-pdf" data-id="${b.id}"`)}${
            staff && b.status !== "VOID" && b.status !== "PAID" ? btn("Void", `data-acc="bill-void" data-id="${b.id}" data-number="${esc(b.number)}"`, "danger") : ""
          }</div></td></tr>`,
      )
      .join("");
    return box("Bills", S.hist.view === "open" ? "Unpaid and part-paid bills. Paid bills are history: choose All." : "Every bill issued in these dates.", histTools("Unpaid", "All (history)"), `<div class="acc-scroll"><table class="acc-table"><thead><tr><th>Bill</th><th>Parcels delivered</th><th class="num">Total</th><th class="num">Paid</th><th class="num">Due</th><th>Status</th><th></th></tr></thead><tbody>${rows || empty(7, loading(key, S.hist.view === "open" ? "No unpaid bills." : "No bills in these dates."))}</tbody></table></div>`);
  }

  function paymentRow(p, withAccount = false) {
    const staff = moneyStaff();
    return `<tr><td><strong>${esc(p.number)}</strong>${p.bills.length ? `<span class="sub">${esc(p.bills.map(b => `${b.number} ${tk(b.amount)}`).join(", "))}</span>` : ""}</td>${withAccount ? `<td>${esc(p.account.name)}</td>` : ""}<td class="num"><strong>${tk(p.amount)}</strong>${p.credit > 0 ? `<span class="sub">credit ${tk(p.credit)}</span>` : ""}</td><td>${esc(methodLabel(p.method))}${p.reference ? `<span class="sub">${esc(p.reference)}</span>` : ""}</td><td>${esc(p.paidOn)}</td>${withAccount ? "" : `<td>${pill(PAYMENT_PILL, p.status)}${p.rejectReason ? `<span class="sub">${esc(p.rejectReason)}</span>` : ""}</td>`}<td><div class="acc-actions">${p.receipt ? btn("Receipt", `data-acc="file" data-file="${p.receipt.fileId}"`) : ""}${
      staff && p.status === "PENDING" ? btn("Reject", `data-acc="payment-reject" data-id="${p.id}" data-number="${esc(p.number)}"`, "danger") + btn("Confirm", `data-acc="payment-confirm" data-id="${p.id}" data-number="${esc(p.number)}"`, "primary") : ""
    }</div></td></tr>`;
  }

  function paymentsBox(a) {
    const query = qs({ accountId: a.id, from: S.hist.from, to: S.hist.to });
    const key = `acc-payments-${a.id}-${query}`;
    const items = Ops.lazy(key, () => DF.api(`/payments?${query}`), 15000)?.items || [];
    return box("Payments", "Money received from the merchant in these dates. Confirmed payments pay bills; what's left is advance credit.", histTools("", "", true), `<div class="acc-scroll"><table class="acc-table"><thead><tr><th>Payment</th><th class="num">Amount</th><th>How</th><th>Paid on</th><th>Status</th><th></th></tr></thead><tbody>${items.map(p => paymentRow(p)).join("") || empty(6, loading(key, "No payments in these dates."))}</tbody></table></div>`);
  }

  function statementBox(a) {
    const key = `acc-stmt-${a.id}-${qs(S.stmt)}`;
    const st = Ops.lazy(key, () => DF.api(`/accounts/${a.id}/statement?${qs(S.stmt)}`), 15000);
    const rows = (st?.lines || [])
      .map(l => `<tr><td>${when(l.date)}</td><td>${esc(l.trackingId || "")}</td><td>${esc(l.description)}${l.reference ? `<span class="sub">${esc(l.reference)}</span>` : ""}</td><td class="num" style="color:${l.amount < 0 ? "#b42318" : "#067647"}">${l.amount < 0 ? "−" : "+"}${tk(Math.abs(l.amount))}</td><td class="num"><strong>${tk(l.balance)}</strong></td></tr>`)
      .join("");
    return box(
      "Statement",
      a.kind === "FINANCIAL" ? "Charges are minus, payments plus. A minus balance is what the merchant owes." : "COD is plus, charges and payouts minus. The balance is what is still owed to the account.",
      `<input type="date" id="accStmtFrom" value="${esc(S.stmt.from)}" aria-label="From"><input type="date" id="accStmtTo" value="${esc(S.stmt.to)}" aria-label="To">${btn("PDF", `data-acc="statement-pdf"`)}`,
      `<div class="acc-scroll"><table class="acc-table"><thead><tr><th>Date</th><th>Parcel</th><th>Description</th><th class="num">Amount</th><th class="num">Balance</th></tr></thead><tbody>${
        st ? `<tr><td colspan="4"><strong>Opening balance</strong></td><td class="num"><strong>${tk(st.opening)}</strong></td></tr>${rows}<tr><td colspan="4"><strong>Closing balance</strong></td><td class="num"><strong>${tk(st.closing)}</strong></td></tr>` : empty(5, loading(key, "Loading…"))
      }</tbody></table></div>`,
    );
  }

  // ───────────── Rider cash ─────────────
  function riderCashPage() {
    const open = Ops.lazy("acc-slips-open", () => DF.api("/cash/slips?status=OPEN"), 15000)?.items || [];
    const recent = Ops.lazy("acc-slips-received", () => DF.api("/cash/slips?status=RECEIVED"), 30000)?.items || [];
    const dues = Ops.lazy("acc-dues", () => DF.api("/cash/dues"), 30000)?.items || [];
    const holders = Ops.lazy("acc-cash-riders", () => DF.api("/cash/riders"), 15000)?.items || [];
    const s = S.slip;
    const slipPanel = s
      ? `<div class="acc-slip"><div><div class="acc-kv">
          <div><small>Slip</small><strong>${esc(s.number)}</strong></div>
          <div><small>Rider</small>${esc(s.rider?.code || "")} · ${esc(s.rider?.name || "")}</div>
          <div><small>Parcels</small>${s.parcels?.length ?? s.parcels}</div>
          <div><small>COD</small>${tk(s.cod)}${s.due ? ` + earlier due ${tk(s.due)}` : ""}</div>
          <div><small>Status</small>${s.status === "OPEN" ? `<span class="acc-pill warn">To receive</span>` : s.status === "RECEIVED" ? `<span class="acc-pill good">Received ${tk(s.received)}${s.short ? ` · short ${tk(s.short)}` : ""}</span>` : `<span class="acc-pill">Cancelled</span>`}</div>
        </div>${Array.isArray(s.parcels) && s.parcels.length ? `<details style="margin-top:10px"><summary style="cursor:pointer;font-size:13px;color:#2f55c9">Parcels on the slip</summary><table class="acc-table" style="margin-top:6px"><tbody>${s.parcels.map(p => `<tr><td>${esc(p.trackingId)}</td><td>${esc(p.recipient || "")}</td><td class="num">${tk(p.amount)}</td></tr>`).join("")}</tbody></table></details>` : ""}</div>
        <div style="display:grid;gap:8px;align-content:start;min-width:220px"><small style="color:#667085;font-weight:600">To receive</small><div class="big">${tk(s.expected)}</div>${
          s.status === "OPEN"
            ? `${btn("Print slip", `data-acc="slip-pdf" data-number="${esc(s.number)}"`)}<label style="font-size:12px;color:#667085">Cash counted<input id="accReceived" type="number" inputmode="decimal" min="0" step="0.01" value="${esc(String(s.expected))}" style="display:block;width:100%;height:38px;margin-top:4px;border:1px solid #e6e9ef;border-radius:9px;padding:0 10px;font:inherit;font-size:15px"></label><button type="button" class="acc-btn primary" data-acc="slip-receive" data-id="${s.id}">Receive cash</button><small style="color:#667085">Less than the slip? The difference is recorded as the rider's due.</small>`
            : ""
        }</div></div>`
      : S.slipError
        ? `<div class="acc-slip" style="grid-template-columns:1fr"><span class="acc-pill bad">${esc(S.slipError)}</span></div>`
        : "";
    return (
      heading("Rider cash", "Riders make a handover slip in their app with all the cash they hold. Scan it, count the cash, receive it.") +
      `<div class="acc">${noCentral()}
      ${box("Receive a slip", "Scan the slip's barcode (or the rider's screen), or type its number.", "", `<div class="acc-scan"><input id="accSlipScan" placeholder="HS-… slip number" autocomplete="off" aria-label="Slip number" value="${esc(s?.number || "")}"><button type="button" class="acc-btn primary" data-acc="slip-find">Open slip</button></div>${slipPanel}`)}
      ${box(
        "Rider without a phone",
        "Choose the rider: the slip of all the cash they hold is made here, then count and receive it above (print it for the rider to sign).",
        "",
        `<div class="acc-scan"><select id="accRiderPick" aria-label="Rider" style="flex:1;min-width:220px;height:44px;border:1px solid #e6e9ef;border-radius:11px;padding:0 12px;font:inherit;font-size:14px"><option value="">${holders.length ? "— Choose the rider —" : esc(loading("acc-cash-riders", "No rider of your hubs holds cash"))}</option>${holders
          .map(r => `<option value="${esc(r.id)}">${esc(r.code)} · ${esc(r.name)} · ${tk(r.total)} (${r.parcels} parcel${r.parcels === 1 ? "" : "s"}${r.due ? `, owes ${tk(r.due)}` : ""})</option>`)
          .join("")}</select><button type="button" class="acc-btn primary" data-acc="rider-slip">Make slip</button></div>`,
      )}
      ${box(
        "Waiting to hand over",
        "Slips riders made that no hub has received yet.",
        "",
        `<div class="acc-scroll"><table class="acc-table"><thead><tr><th>Slip</th><th>Rider</th><th>Hub</th><th class="num">Parcels</th><th class="num">Amount</th><th>Made</th><th></th></tr></thead><tbody>${
          open.map(x => `<tr><td><strong>${esc(x.number)}</strong></td><td>${esc(x.rider?.code || "")} · ${esc(x.rider?.name || "")}<span class="sub">${esc(DF.localPhone?.(x.rider?.phone) || "")}</span></td><td>${esc(x.hub?.name || "")}</td><td class="num">${x.parcels}</td><td class="num"><strong>${tk(x.expected)}</strong></td><td>${when(x.createdAt)}</td><td><div class="acc-actions">${btn("Receive", `data-acc="slip-open" data-number="${esc(x.number)}"`, "primary")}</div></td></tr>`).join("") ||
          empty(7, loading("acc-slips-open", "No rider is waiting to hand over."))
        }</tbody></table></div>`,
      )}
      ${box(
        "Received",
        "Recent slips received at your hubs. Hubs other than the central hub send this cash on in Hub transfers.",
        "",
        `<div class="acc-scroll"><table class="acc-table"><thead><tr><th>Slip</th><th>Rider</th><th>Hub</th><th class="num">Received</th><th>When</th><th>Sent on</th><th></th></tr></thead><tbody>${
          recent.slice(0, 40).map(x => `<tr><td><strong>${esc(x.number)}</strong></td><td>${esc(x.rider?.code || "")} · ${esc(x.rider?.name || "")}</td><td>${esc(x.hub?.name || "")}</td><td class="num">${tk(x.received)}${x.short ? `<span class="sub" style="color:#b42318">short ${tk(x.short)}</span>` : ""}</td><td>${when(x.receivedAt)}<span class="sub">${esc(x.receivedBy || "")}</span></td><td>${x.transfer ? `${esc(x.transfer.number)}` : "—"}</td><td><div class="acc-actions">${btn("PDF", `data-acc="slip-pdf" data-number="${esc(x.number)}"`)}</div></td></tr>`).join("") ||
          empty(7, loading("acc-slips-received", "Nothing received yet."))
        }</tbody></table></div>`,
      )}
      ${
        dues.length
          ? box("Dues", "Short cash a rider or hub still owes. Their next slip / transfer collects it.", "", `<table class="acc-table"><thead><tr><th>Who</th><th class="num">Amount</th><th>From</th><th>Since</th></tr></thead><tbody>${dues.map(d => `<tr><td>${esc(d.who)}<span class="sub">${d.kind === "rider" ? "Rider" : "Hub"}</span></td><td class="num"><strong>${tk(d.amount)}</strong></td><td>${esc(d.source)}</td><td>${day(d.createdAt)}</td></tr>`).join("")}</tbody></table>`)
          : ""
      }</div>`
    );
  }

  // ───────────── Hub transfers ─────────────
  function transfersPage() {
    const onHand = Ops.lazy("acc-onhand", () => DF.api("/cash/on-hand"), 15000);
    const transit = Ops.lazy("acc-transit", () => DF.api("/cash/transfers?status=IN_TRANSIT"), 15000)?.items || [];
    const done = Ops.lazy("acc-transfers-done", () => DF.api("/cash/transfers?status=RECEIVED"), 30000)?.items || [];
    const staff = moneyStaff();
    const hubs = (onHand?.items || []).filter(h => !h.central);
    const hubCards = hubs
      .map(
        h => `<div class="acc-hub"><div style="display:flex;justify-content:space-between;gap:8px"><strong>${esc(h.hub.name)}</strong><span class="acc-pill">${esc(h.hub.code || "")}</span></div>
        <strong class="big">${tk(h.toSend)}</strong>
        <span style="color:#667085;font-size:12.5px">${h.slips.length} slip(s)${h.counter.count ? ` · counter ${tk(h.counter.amount)}` : ""}${h.due ? ` · due ${tk(h.due)}` : ""}${h.inTransit.length ? ` · ${h.inTransit.length} in transit` : ""}</span>
        <div>${h.toSend > 0 ? btn("Send to central hub", `data-acc="transfer-new" data-hub="${h.hub.id}"`, "primary") : `<span class="acc-pill good">Nothing to send</span>`}</div></div>`,
      )
      .join("");
    return (
      heading("Hub transfers", `Hubs send the cash they received to the central hub (${central()?.name || "not set"}) by bank or mobile banking, whole slips at a time.`) +
      `<div class="acc">${noCentral()}
      ${box("Cash on hand", "Received slips and counter cash not sent yet.", "", hubCards ? `<div class="acc-hubs">${hubCards}</div>` : `<div class="acc-empty">${esc(loading("acc-onhand", onHand ? "No cash waiting at your hubs." : "Loading…"))}</div>`)}
      ${box(
        "In transit",
        staff ? "Check the money arrived, then receive it: it's then ready to settle." : "Sent and waiting for the central hub to receive.",
        staff ? `<input id="accTransferScan" placeholder="HT-… transfer number" autocomplete="off" aria-label="Transfer number" style="min-width:200px"><button type="button" class="acc-btn sm" data-acc="transfer-find">Find</button>` : "",
        `<div class="acc-scroll"><table class="acc-table"><thead><tr><th>Transfer</th><th>From</th><th class="num">Amount</th><th>How</th><th>Sent</th><th></th></tr></thead><tbody>${
          transit.map(t => `<tr${S.transferScan === t.number ? ' style="background:#f5f8ff"' : ""}><td><strong>${esc(t.number)}</strong><span class="sub">${t.slips} slip(s)</span></td><td>${esc(t.from.name)}</td><td class="num"><strong>${tk(t.amount)}</strong></td><td>${esc(methodLabel(t.method))}${t.reference ? `<span class="sub">${esc(t.reference)}</span>` : ""}</td><td>${when(t.sentAt)}<span class="sub">${esc(t.sentBy || "")}</span></td><td><div class="acc-actions">${btn("PDF", `data-acc="transfer-pdf" data-number="${esc(t.number)}"`)}${t.proof ? btn("Proof", `data-acc="file" data-file="${t.proof.fileId}"`) : ""}${btn("Cancel", `data-acc="transfer-cancel" data-id="${t.id}" data-number="${esc(t.number)}"`, "danger")}${staff ? btn("Receive", `data-acc="transfer-receive" data-id="${t.id}" data-number="${esc(t.number)}" data-amount="${t.amount}"`, "primary") : ""}</div></td></tr>`).join("") ||
          empty(6, loading("acc-transit", "Nothing in transit."))
        }</tbody></table></div>`,
      )}
      ${box(
        "Received",
        "",
        "",
        `<div class="acc-scroll"><table class="acc-table"><thead><tr><th>Transfer</th><th>From</th><th class="num">Received</th><th>When</th><th></th></tr></thead><tbody>${
          done.slice(0, 40).map(t => `<tr><td><strong>${esc(t.number)}</strong></td><td>${esc(t.from.name)}</td><td class="num">${tk(t.received)}${t.short ? `<span class="sub" style="color:#b42318">short ${tk(t.short)}</span>` : ""}</td><td>${when(t.receivedAt)}<span class="sub">${esc(t.receivedBy || "")}</span></td><td><div class="acc-actions">${btn("PDF", `data-acc="transfer-pdf" data-number="${esc(t.number)}"`)}</div></td></tr>`).join("") ||
          empty(5, loading("acc-transfers-done", "Nothing received yet."))
        }</tbody></table></div>`,
      )}</div>`
    );
  }

  // ───────────── Rider pay, Franchise (existing panels in this design's frame) ─────────────
  const riderPayPage = () => heading("Rider pay", "Riders' earnings: prepare payouts, approve, pay.") + `<div class="acc" id="accRiderPay">${Ops.riderPayoutsHtml?.() || ""}</div>`;
  const franchisePage = () => heading("Franchise", "Franchise hubs' cash deposits and commission invoices.") + `<div class="acc" id="accFranchise">${Ops.franchiseMoneyHtml?.() || `<div class="acc-note">Nothing here for you.</div>`}</div>`;

  // ───────────── register ─────────────
  Ops.pages["Accounts overview"] = { render: overviewPage };
  for (const kind of Object.keys(KIND_PAGE)) Ops.pages[KIND_PAGE[kind]] = { render: () => listPage(kind) };
  Ops.pages["Rider cash"] = { render: riderCashPage };
  Ops.pages["Hub transfers"] = { render: transfersPage };
  Ops.pages["Rider pay"] = { render: riderPayPage };
  Ops.pages["Franchise money"] = { render: franchisePage };
  Ops.enhance["Rider cash"] = () => {
    const input = $("accSlipScan");
    if (input && window.DF.scanner) DF.scanner.attach(input, { title: "Scan the handover slip", onScan: code => void findSlip(code) });
  };
  Ops.enhance["Hub transfers"] = () => {
    const input = $("accTransferScan");
    if (input && window.DF.scanner) DF.scanner.attach(input, { title: "Scan the transfer", onScan: code => findTransfer(code) });
  };
  /** Which Accounts tabs this person sees (bridge-nav.js tab `show`). */
  Ops.accountsTab = name => {
    if (["Overview", "E-commerce", "Financial", "Customer"].includes(name)) return moneyStaff();
    if (name === "Rider cash" || name === "Hub transfers") return cashStaff() || moneyStaff();
    if (name === "Rider pay") return Ops.can("manageFinance") || Ops.can("manageRiders");
    if (name === "Franchise") return Ops.can("receiveCash") || Ops.can("financeStaff");
    return true;
  };

  // ───────────── actions ─────────────
  async function findSlip(raw) {
    const number = String(raw || "").trim().toUpperCase();
    if (!number) return;
    try {
      S.slip = await DF.api(`/cash/slips/${encodeURIComponent(number)}`);
      S.slipError = "";
      DF.scanner?.feedback("accSlipScan", S.slip.status === "OPEN", S.slip.status === "OPEN" ? `${S.slip.number}: ${tk(S.slip.expected)} to receive` : `${S.slip.number} is ${S.slip.status.toLowerCase()}`);
    } catch (error) {
      S.slip = null;
      S.slipError = DF.describe(error);
      DF.scanner?.feedback("accSlipScan", false, S.slipError);
    }
    rerender();
    setTimeout(() => $("accReceived")?.focus(), 30);
  }
  function findTransfer(raw) {
    S.transferScan = String(raw || "").trim().toUpperCase();
    const t = (Ops.cache["acc-transit"]?.value?.items || []).find(x => x.number === S.transferScan);
    DF.scanner?.feedback("accTransferScan", !!t, t ? `${t.number}: ${tk(t.amount)} from ${t.from.name}` : `${S.transferScan} isn't in transit`);
    rerender();
    if (t && moneyStaff()) receiveTransfer(t.id, t.number, t.amount);
  }

  async function receiveSlip(id) {
    const received = Number($("accReceived")?.value);
    if (!Number.isFinite(received) || received < 0) return toast("Enter the cash counted.");
    try {
      S.slip = await DF.api(`/cash/slips/${id}/receive`, { method: "POST", body: { received } });
      toast(S.slip.short ? `${S.slip.number} received: ${tk(received)}, short ${tk(S.slip.short)} (rider's due).` : `${S.slip.number} received: ${tk(received)}.`);
      after("acc-slips-open", "acc-slips-received", "acc-onhand", "acc-dues", "acc-overview", "acc-cash-riders");
    } catch (error) {
      fail(error);
    }
  }

  function receiveTransfer(id, number, amount) {
    Ops.form({
      title: `Receive ${number}`,
      description: `Check the ${tk(amount)} arrived in the central hub's bank / wallet. Less than sent? Enter what arrived: the difference is the sending hub's due.`,
      submit: "Receive",
      fields: [{ id: "received", label: "Amount received (৳)", type: "number", value: String(amount), min: 0, step: "0.01", required: true }],
      onSubmit: async v => {
        const t = await DF.api(`/cash/transfers/${id}/receive`, { method: "POST", body: { received: Number(v.received) } });
        after("acc-transit", "acc-transfers-done", "acc-overview", "acc-onhand");
        return t.short ? `${t.number} received: ${tk(t.received)}, short ${tk(t.short)}.` : `${t.number} received: ${tk(t.received)}. The cash is ready to settle.`;
      },
    });
  }

  function newTransfer(hubId) {
    const hub = (Ops.cache["acc-onhand"]?.value?.items || []).find(h => h.hub.id === hubId);
    if (!hub) return;
    const slipRows = hub.slips
      .map(s => `<label style="display:flex;gap:8px;align-items:center;padding:6px 10px;border-bottom:1px solid #f0f2f5;font-size:13px"><input type="checkbox" data-acc-tslip="${s.id}" checked> <strong>${esc(s.number)}</strong> ${esc(s.rider?.code || "")} · ${esc(s.rider?.name || "")} <span style="margin-left:auto">${tk(s.cash)}</span></label>`)
      .join("");
    resetReceipt(`Transfer proof · ${hub.hub.name}`);
    Ops.form({
      title: `Send ${hub.hub.name}'s cash to the central hub`,
      description: `Whole slips only. Counter cash${hub.due ? " and the hub's earlier due" : ""} always go with them. Total now: ${tk(hub.toSend)}.`,
      submit: "Send",
      wide: true,
      fields: [
        ...(hub.slips.length ? [{ id: "slips", label: "Slips", type: "static", html: `<div class="acc-pick">${slipRows}</div>`, full: true }] : []),
        { id: "method", label: "Sent by", type: "select", options: METHODS.filter(m => m[0] !== "CASH").map(([value, label]) => ({ value, label })), value: "BANK", required: true },
        { id: "reference", label: "Transaction / deposit reference", maxLength: 120, placeholder: "e.g. TXN 7H3K…" },
        { id: "proof", label: "Deposit slip / screenshot", type: "static", html: `<div id="accReceipt"></div>`, full: true },
      ],
      onSubmit: async v => {
        const slipIds = [...document.querySelectorAll("[data-acc-tslip]:checked")].map(el => el.dataset.accTslip);
        if (hub.slips.length && !slipIds.length && !hub.counter.count && !hub.due) throw new Error("Choose at least one slip.");
        const t = await DF.api("/cash/transfers", { method: "POST", body: { fromHubId: hubId, ...(hub.slips.length ? { slipIds } : {}), method: v.method, reference: v.reference || undefined, proof: receipt.dataUrl || undefined } });
        closeReceiptLink();
        after("acc-onhand", "acc-transit", "acc-overview", "acc-slips-received");
        return `${t.number} sent: ${tk(t.amount)}. The central hub receives it when the money arrives.`;
      },
    });
  }

  /** Settle: ready parcels ticked (select all), returns and adjustments always included. */
  async function settle(account) {
    let rows;
    try {
      rows = (await DF.api(`/accounts/${account.id}/parcels?status=ready`)).items;
    } catch (error) {
      return fail(error);
    }
    const delivered = rows.filter(r => r.cod > 0 || r.outcome !== "Returned");
    const other = Math.round((account.cod.ready - delivered.reduce((t, r) => t + r.net, 0)) * 100) / 100;
    const pick = { chosen: new Set(delivered.map(r => r.parcelId)) };
    const paint = () => {
      const boxEl = $("accSettlePick");
      if (!boxEl) return;
      const chosen = delivered.filter(r => pick.chosen.has(r.parcelId));
      const net = Math.round((chosen.reduce((t, r) => t + r.net, 0) + other) * 100) / 100;
      boxEl.innerHTML = delivered.length
        ? `<label style="display:inline-flex;gap:8px;align-items:center;font-weight:600;font-size:13px;margin-bottom:8px"><input type="checkbox" data-acc-pick-all ${chosen.length === delivered.length ? "checked" : ""}> Select all (${delivered.length})</label>
        <div class="acc-pick"><table class="acc-table"><thead><tr><th></th><th>Parcel</th><th class="num">COD</th><th class="num">Charges</th><th class="num">Net</th></tr></thead><tbody>${delivered
          .map(r => `<tr><td><input type="checkbox" data-acc-pick="${r.parcelId}" ${pick.chosen.has(r.parcelId) ? "checked" : ""} aria-label="Settle ${esc(r.trackingId)}"></td><td><strong>${esc(r.trackingId)}</strong><span class="sub">${day(r.date)}</span></td><td class="num">${tk(r.cod)}</td><td class="num">−${tk(r.charge + r.returnCharge)}</td><td class="num">${tk(r.net)}</td></tr>`)
          .join("")}</tbody></table></div>
        <div class="acc-sum"><div><small>Chosen parcels</small><strong>${tk(chosen.reduce((t, r) => t + r.net, 0))}</strong></div><div><small>Returns & adjustments (always)</small><strong>${tk(other)}</strong></div><div><small>Net to pay</small><strong style="color:${net > 0 ? "#067647" : "#b42318"}">${tk(net)}</strong></div></div>`
        : `<p style="margin:0;color:#667085">No delivered parcel is ready (their cash hasn't reached the central hub). Returns & adjustments: ${tk(other)}.</p>`;
    };
    pick.paint = paint;
    S.pick = pick;
    Ops.form({
      title: `Settle ${account.name}`,
      description: `Pays to: ${payToText(account.payTo)}. After creating it, send the money and mark it paid.`,
      submit: "Create settlement",
      wide: true,
      fields: [{ id: "parcels", label: "Ready parcels", type: "static", html: `<div id="accSettlePick"></div>`, full: true }],
      onSubmit: async () => {
        if (delivered.length && !pick.chosen.size && other <= 0) throw new Error("Choose at least one parcel.");
        const body = delivered.length && pick.chosen.size !== delivered.length ? { parcelIds: [...pick.chosen] } : {};
        const p = await DF.api(`/accounts/${account.id}/payouts`, { method: "POST", body });
        after(`acc-${account.id}`, `acc-payouts-${account.id}`, `acc-list-${account.kind}`, "acc-unpaid", "acc-overview");
        S.sub = "documents";
        setTimeout(() => payPayout(p.id), 300);
        return `${p.number} created: ${tk(p.amount)} to pay.`;
      },
    });
    setTimeout(paint, 0);
  }

  async function payPayout(id) {
    let p;
    try {
      p = await DF.api(`/payouts/${id}`);
    } catch (error) {
      return fail(error);
    }
    resetReceipt(`Payment receipt · ${p.number}`);
    Ops.form({
      title: `Mark ${p.number} paid`,
      description: `${tk(p.amount)} to ${p.account.name} · ${payToText(p.payTo)}`,
      submit: "Mark paid",
      wide: true,
      fields: [
        { id: "method", label: "Paid by", type: "select", options: METHODS.map(([value, label]) => ({ value, label })), value: p.payTo?.method === "BANK" ? "BANK" : p.payTo?.method || "BKASH", required: true },
        { id: "reference", label: "Transaction ID / reference", maxLength: 120, placeholder: "e.g. 9KX2…" },
        { id: "proof", label: "Receipt photo", type: "static", html: `<div id="accReceipt"></div>`, full: true },
      ],
      onSubmit: async v => {
        const done = await DF.api(`/payouts/${id}/pay`, { method: "POST", body: { method: v.method, reference: v.reference || undefined, proof: receipt.dataUrl || undefined } });
        closeReceiptLink();
        after(`acc-${done.account.id}`, `acc-payouts-${done.account.id}`, `acc-list-${done.account.kind}`, "acc-unpaid", "acc-overview");
        return `${done.number} paid. The ${done.account.kind === "CUSTOMER" ? "customer" : "merchant"} sees it with the receipt.`;
      },
    });
  }

  async function newBill(account) {
    const bill = { from: monthStart(), to: today(), rows: null, chosen: new Set(), error: "" };
    const load = async () => {
      bill.rows = null;
      paint();
      try {
        bill.rows = (await DF.api(`/accounts/${account.id}/parcels?${qs({ status: "not_billed", from: bill.from, to: bill.to })}`)).items;
        bill.chosen = new Set(bill.rows.map(r => r.parcelId));
        bill.error = "";
      } catch (error) {
        bill.error = DF.describe(error);
      }
      paint();
    };
    const paint = () => {
      const boxEl = $("accBillPick");
      if (!boxEl) return;
      if (bill.error) return void (boxEl.innerHTML = `<p role="alert" style="margin:0;color:#b42318">${esc(bill.error)}</p>`);
      if (!bill.rows) return void (boxEl.innerHTML = `<p style="margin:0;color:#667085">Loading…</p>`);
      if (!bill.rows.length) return void (boxEl.innerHTML = `<p style="margin:0;color:#667085">No parcels waiting for a bill in these dates.</p>`);
      const chosen = bill.rows.filter(r => bill.chosen.has(r.parcelId));
      const total = chosen.reduce((t, r) => t + r.charge + r.returnCharge, 0);
      boxEl.innerHTML = `<label style="display:inline-flex;gap:8px;align-items:center;font-weight:600;font-size:13px;margin-bottom:8px"><input type="checkbox" data-acc-bill-all ${chosen.length === bill.rows.length ? "checked" : ""}> Select all (${bill.rows.length})</label>
        <div class="acc-pick"><table class="acc-table"><thead><tr><th></th><th>Parcel</th><th>Outcome</th><th>Destination</th><th class="num">Charge</th></tr></thead><tbody>${bill.rows
          .map(r => `<tr><td><input type="checkbox" data-acc-bill="${r.parcelId}" ${bill.chosen.has(r.parcelId) ? "checked" : ""} aria-label="Bill ${esc(r.trackingId)}"></td><td><strong>${esc(r.trackingId)}</strong><span class="sub">${esc([r.orderRef, r.recipient].filter(Boolean).join(" · "))}</span></td><td>${esc(r.outcome)}<span class="sub">${day(r.date)}</span></td><td>${esc(r.destination)}</td><td class="num">${tk(r.charge + r.returnCharge)}</td></tr>`)
          .join("")}</tbody></table></div>
        <div class="acc-sum"><div><small>Chosen</small><strong>${chosen.length} of ${bill.rows.length}</strong></div><div><small>Bill total</small><strong style="color:#2f55c9">${tk(total)}</strong></div><div><small>Open adjustments</small><strong>added to the bill</strong></div></div>`;
    };
    S.bill = { state: bill, paint, load };
    Ops.form({
      title: `Generate bill · ${account.name}`,
      description: "Choose the delivery dates, tick the parcels. The bill is a PDF the merchant sees in their panel; part payments are welcome.",
      submit: "Generate bill",
      wide: true,
      fields: [
        { id: "from", label: "Delivered from", type: "date", value: bill.from, required: true, domId: "accBillFrom" },
        { id: "to", label: "Delivered to (inclusive)", type: "date", value: bill.to, required: true, domId: "accBillTo" },
        { id: "parcels", label: "Parcels to bill", type: "static", html: `<div id="accBillPick"></div>`, full: true },
      ],
      onSubmit: async () => {
        if (!bill.chosen.size) throw new Error("Tick at least one parcel.");
        const b = await DF.api(`/accounts/${account.id}/bills`, { method: "POST", body: { from: bill.from, to: bill.to, parcelIds: [...bill.chosen] } });
        after(`acc-${account.id}`, `acc-bills-${account.id}`, `acc-list-FINANCIAL`, "acc-overview");
        S.sub = "documents";
        Ops.printPdf(`/documents/bill/${b.id}`, { title: "Preparing the bill…" });
        return `${b.number} issued: ${tk(b.total)}${b.paid ? `, ${tk(b.paid)} already paid from credit` : ""}.`;
      },
    });
    setTimeout(load, 0);
  }

  async function newPayment(account) {
    const open = (await DF.api(`/bills?accountId=${account.id}&status=UNPAID`).catch(() => ({ items: [] }))).items;
    resetReceipt(`Payment · ${account.name}`);
    Ops.form({
      title: `Record payment · ${account.name}`,
      description: `Due now ${tk(account.financial.due)}. Part payments are fine: it pays the oldest bill first (or the bill you choose); anything extra stays as advance credit.`,
      submit: "Record payment",
      wide: true,
      fields: [
        { id: "amount", label: "Amount received (৳)", type: "number", min: 0.01, step: "0.01", required: true, value: account.financial.due > 0 ? String(account.financial.due) : "" },
        { id: "method", label: "Received by", type: "select", options: METHODS.map(([value, label]) => ({ value, label })), value: "BANK", required: true },
        { id: "reference", label: "Transaction / cheque reference", maxLength: 120 },
        { id: "paidOn", label: "Paid on", type: "date", value: today(), required: true },
        { id: "billId", label: "Pay this bill first", type: "select", options: [{ value: "", label: "Oldest bills first" }, ...open.map(b => ({ value: b.id, label: `${b.number} · due ${tk(b.due)}` }))], value: "" },
        { id: "note", label: "Note", maxLength: 300 },
        { id: "proof", label: "Receipt", type: "static", html: `<div id="accReceipt"></div>`, full: true },
      ],
      onSubmit: async v => {
        const p = await DF.api(`/accounts/${account.id}/payments`, { method: "POST", body: { amount: Number(v.amount), method: v.method, reference: v.reference || undefined, paidOn: v.paidOn, billId: v.billId || undefined, note: v.note || undefined, proof: receipt.dataUrl || undefined } });
        closeReceiptLink();
        after(`acc-${account.id}`, `acc-bills-${account.id}`, `acc-payments-${account.id}`, "acc-list-FINANCIAL", "acc-overview");
        return `${p.number} recorded: ${tk(p.amount)}${p.bills.length ? ` → ${p.bills.map(b => b.number).join(", ")}` : ""}${p.credit ? `, ${tk(p.credit)} advance credit` : ""}.`;
      },
    });
  }

  function adjust(account) {
    Ops.form({
      title: `Adjustment · ${account.name}`,
      description: "A correction with a reason. It shows on the statement and goes into the next settlement / bill.",
      submit: "Add adjustment",
      fields: [
        {
          id: "direction",
          label: "Type",
          type: "select",
          required: true,
          value: "charge",
          options: [
            { value: "charge", label: account.kind === "FINANCIAL" ? "Charge the merchant more (they owe more)" : "Deduct (we pay less)" },
            { value: "credit", label: account.kind === "FINANCIAL" ? "Give credit (they owe less)" : "Add (we pay more)" },
          ],
        },
        { id: "amount", label: "Amount (৳)", type: "number", min: 0.01, step: "0.01", required: true },
        { id: "reason", label: "Reason", type: "textarea", required: true, maxLength: 300 },
        { id: "trackingId", label: "Parcel tracking ID", maxLength: 40 },
      ],
      onSubmit: async v => {
        const amount = Number(v.amount) * (v.direction === "credit" ? 1 : -1);
        await DF.api(`/accounts/${account.id}/adjustments`, { method: "POST", body: { amount, reason: v.reason, trackingId: v.trackingId || undefined } });
        after(`acc-${account.id}`, `acc-list-${account.kind}`);
        return `Adjustment of ${tk(Math.abs(amount))} added.`;
      },
    });
  }

  async function invoiceSettings() {
    const cfg = await DF.api("/finance/config").catch(fail);
    if (!cfg) return;
    Ops.form({
      title: "Invoice settings",
      description: "The company printed on bills, and VAT. With VAT off, charges already include everything and no VAT or BIN is shown anywhere.",
      submit: "Save settings",
      fields: [
        { id: "vatEnabled", label: "VAT", type: "select", value: cfg.vatEnabled ? "on" : "off", options: [{ value: "off", label: "Off: no VAT shown" }, { value: "on", label: "On: show VAT at the rate below" }], required: true, full: true },
        { id: "vatRate", label: "VAT rate (%)", type: "number", value: String(cfg.vatRate), min: 0, max: 50, step: "0.01", required: true, hint: "Used only while VAT is on." },
        { id: "bin", label: "Company BIN", value: cfg.seller.bin || "", maxLength: 14, hint: "Printed while VAT is on." },
        { id: "name", label: "Company name on bills", value: cfg.seller.name || "", required: true, maxLength: 160, full: true },
        { id: "address", label: "Company address on bills", type: "textarea", value: cfg.seller.address || "", maxLength: 300 },
      ],
      onSubmit: async v => {
        const c = await DF.api("/finance/config", { method: "PUT", body: { vatEnabled: v.vatEnabled === "on", vatRate: Number(v.vatRate), seller: { bin: v.bin, name: v.name, address: v.address } } });
        return c.vatEnabled ? `Saved: VAT on at ${c.vatRate}%.` : "Saved: VAT off.";
      },
    });
  }

  const currentAccount = () => {
    const kind = pageKind();
    const id = kind && S.open[kind];
    return id ? Ops.cache[`acc-${id}`]?.value : null;
  };

  const openFile = id => {
    const tab = window.open("", "_blank");
    DF.apiRaw(`/files/${encodeURIComponent(id)}`)
      .then(r => r.blob())
      .then(blob => {
        const url = URL.createObjectURL(blob);
        if (tab) tab.location.href = url;
        else window.open(url, "_blank");
      })
      .catch(error => (tab?.close(), fail(error)));
  };

  window.addEventListener(
    "click",
    event => {
      const el = event.target instanceof Element ? event.target.closest("[data-acc]") : null;
      if (!el) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const d = el.dataset;
      const a = currentAccount();
      switch (d.acc) {
        case "open":
          S.open[d.kind] = d.id;
          S.sub = "parcels";
          S.filter = { from: monthStart(), to: today(), q: "", status: "all" };
          S.hist = { view: "open", from: monthStart(), to: today() };
          return rerender();
        case "back":
          S.open[d.kind] = null;
          return rerender();
        case "sub":
          S.sub = d.sub;
          S.hist.view = "open";
          return rerender();
        case "settle":
          return a && void settle(a);
        case "bill-new":
          return a && void newBill(a);
        case "payment-new":
          return a && void newPayment(a);
        case "adjust":
          return a && adjust(a);
        case "statement-pdf":
          return a && Ops.printPdf(`/documents/account-statement/${a.id}?${qs(S.stmt)}`, { title: "Preparing the statement…" });
        case "payout-pdf":
          return Ops.printPdf(`/documents/payout/${d.id}`, { title: "Preparing the settlement…" });
        case "payout-pay":
          return void payPayout(d.id);
        case "payout-cancel":
          return void Ops.confirm({ title: `Cancel ${d.number}?`, message: "Its parcels are ready to settle again.", confirm: "Cancel settlement", cancel: "Keep it", danger: true }).then(
            ok =>
              ok &&
              DF.api(`/payouts/${d.id}/cancel`, { method: "POST" }).then(
                p => (toast(`${p.number} cancelled.`), after(`acc-${p.account.id}`, `acc-payouts-${p.account.id}`, `acc-list-${p.account.kind}`, "acc-unpaid", "acc-overview")),
                fail,
              ),
          );
        case "bill-pdf":
          return Ops.printPdf(`/documents/bill/${d.id}`, { title: "Preparing the bill…" });
        case "bill-void":
          return void Ops.prompt({ title: `Void ${d.number}?`, message: "Its parcels can be billed again; payments on it go back to credit.", label: "Why?", required: true, multiline: true, maxLength: 300, confirm: "Void bill" }).then(
            reason =>
              reason &&
              DF.api(`/bills/${d.id}/void`, { method: "POST", body: { reason } }).then(
                b => (toast(`${b.number} voided.`), after(`acc-${b.account.id}`, `acc-bills-${b.account.id}`, `acc-payments-${b.account.id}`, "acc-list-FINANCIAL")),
                fail,
              ),
          );
        case "payment-confirm":
          return void DF.api(`/payments/${d.id}/confirm`, { method: "POST" }).then(
            p => (toast(`${p.number} confirmed: ${tk(p.amount)}.`), after(`acc-${p.account.id}`, `acc-payments-${p.account.id}`, `acc-bills-${p.account.id}`, "acc-pending", "acc-list-FINANCIAL", "acc-overview")),
            fail,
          );
        case "payment-reject":
          return void Ops.prompt({ title: `Reject ${d.number}?`, message: "The merchant is told why.", label: "Reason", required: true, multiline: true, maxLength: 300, confirm: "Reject" }).then(
            reason =>
              reason &&
              DF.api(`/payments/${d.id}/reject`, { method: "POST", body: { reason } }).then(
                p => (toast(`${p.number} rejected.`), after(`acc-payments-${p.account.id}`, "acc-pending", "acc-overview")),
                fail,
              ),
          );
        case "file":
          return openFile(d.file);
        case "slip-find":
          return void findSlip($("accSlipScan")?.value);
        case "slip-open":
          return void findSlip(d.number);
        case "slip-receive":
          return void receiveSlip(d.id);
        case "rider-slip": {
          const riderId = $("accRiderPick")?.value;
          if (!riderId) return toast("Choose the rider first.");
          return void DF.api(`/cash/riders/${riderId}/slip`, { method: "POST" }).then(
            slip => (Ops.invalidate("acc-cash-riders", "acc-slips-open"), void findSlip(slip.number)),
            fail,
          );
        }
        case "slip-pdf":
          return Ops.printPdf(`/documents/cash-slip/${encodeURIComponent(d.number)}`, { title: "Preparing the slip…" });
        case "transfer-new":
          return newTransfer(d.hub);
        case "transfer-find":
          return findTransfer($("accTransferScan")?.value);
        case "transfer-receive":
          return receiveTransfer(d.id, d.number, Number(d.amount));
        case "transfer-cancel":
          return void Ops.confirm({ title: `Cancel ${d.number}?`, message: "The cash counts as on hand at the hub again.", confirm: "Cancel transfer", cancel: "Keep it", danger: true }).then(
            ok => ok && DF.api(`/cash/transfers/${d.id}/cancel`, { method: "POST" }).then(t => (toast(`${t.number} cancelled.`), after("acc-onhand", "acc-transit", "acc-overview")), fail),
          );
        case "transfer-pdf":
          return Ops.printPdf(`/documents/hub-transfer/${encodeURIComponent(d.number)}`, { title: "Preparing the transfer…" });
        case "settings":
          return void invoiceSettings();
      }
    },
    true,
  );

  // Filters, pickers, scan boxes.
  document.addEventListener("change", event => {
    const t = event.target;
    if (!(t instanceof HTMLElement)) return;
    if (t.id === "accFrom" || t.id === "accTo" || t.id === "accStatus") {
      S.filter[{ accFrom: "from", accTo: "to", accStatus: "status" }[t.id]] = t.value;
      return rerender();
    }
    if (t.id === "accHist" || t.id === "accHistFrom" || t.id === "accHistTo") {
      S.hist[{ accHist: "view", accHistFrom: "from", accHistTo: "to" }[t.id]] = t.value;
      return rerender();
    }
    if (t.id === "accStmtFrom" || t.id === "accStmtTo") {
      S.stmt[t.id === "accStmtFrom" ? "from" : "to"] = t.value;
      return rerender();
    }
    if (t.matches("[data-acc-pick-all]") && S.pick) {
      S.pick.chosen = t.checked ? new Set([...document.querySelectorAll("[data-acc-pick]")].map(x => x.dataset.accPick)) : new Set();
      return S.pick.paint();
    }
    if (t.matches("[data-acc-pick]") && S.pick) {
      if (t.checked) S.pick.chosen.add(t.dataset.accPick);
      else S.pick.chosen.delete(t.dataset.accPick);
      return S.pick.paint();
    }
    if ((t.id === "accBillFrom" || t.id === "accBillTo") && S.bill) {
      S.bill.state[t.id === "accBillFrom" ? "from" : "to"] = t.value;
      return void S.bill.load();
    }
    if (t.matches("[data-acc-bill-all]") && S.bill) {
      S.bill.state.chosen = t.checked ? new Set(S.bill.state.rows.map(r => r.parcelId)) : new Set();
      return S.bill.paint();
    }
    if (t.matches("[data-acc-bill]") && S.bill) {
      if (t.checked) S.bill.state.chosen.add(t.dataset.accBill);
      else S.bill.state.chosen.delete(t.dataset.accBill);
      return S.bill.paint();
    }
  });
  let searchTimer = null;
  document.addEventListener("input", event => {
    const t = event.target;
    if (!(t instanceof HTMLElement)) return;
    if (t.id === "accListQ") {
      S.q[t.dataset.kind] = t.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        rerender();
        const again = $("accListQ");
        if (again) (again.focus(), again.setSelectionRange(again.value.length, again.value.length));
      }, 250);
    }
    if (t.id === "accParcelQ") {
      S.filter.q = t.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        rerender();
        const again = $("accParcelQ");
        if (again) (again.focus(), again.setSelectionRange(again.value.length, again.value.length));
      }, 350);
    }
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Enter") return;
    if (event.target?.id === "accSlipScan") (event.preventDefault(), void findSlip(event.target.value));
    else if (event.target?.id === "accTransferScan") (event.preventDefault(), findTransfer(event.target.value));
    else if (event.target?.id === "accReceived") (event.preventDefault(), S.slip && void receiveSlip(S.slip.id));
  });

  // ───────────── receipt photo (upload, or "Use phone": a one-photo QR link) ─────────────
  const receipt = { title: "", dataUrl: null, link: null, timer: null, error: "" };
  function resetReceipt(title) {
    closeReceiptLink();
    Object.assign(receipt, { title, dataUrl: null, error: "" });
  }
  function closeReceiptLink() {
    clearInterval(receipt.timer);
    receipt.timer = null;
    if (receipt.link) DF.api(`/photo-links/${encodeURIComponent(receipt.link.id)}`, { method: "DELETE" }).catch(() => undefined);
    receipt.link = null;
  }
  function paintReceipt() {
    const el = $("accReceipt");
    if (!el) return;
    el.dataset.painted = "1";
    if (receipt.dataUrl)
      el.innerHTML = `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><img src="${receipt.dataUrl}" alt="Receipt" style="width:96px;height:96px;object-fit:cover;border-radius:8px;border:1px solid #e6e9ef"><span class="acc-pill good">Attached</span><button type="button" class="acc-btn sm" data-acc-receipt="remove">Remove</button></div>`;
    else if (receipt.link)
      el.innerHTML = `<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><div style="width:150px;height:150px">${receipt.link.qrSvg}</div><div style="display:grid;gap:6px;max-width:300px;font-size:13px"><strong>Scan with the phone</strong><span style="color:#647184">Take the photo and tap Done. It appears here; the link then stops working.</span><button type="button" class="acc-btn sm" data-acc-receipt="cancel">Cancel</button></div></div>`;
    else el.innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="acc-btn sm" data-acc-receipt="upload">Upload photo</button><button type="button" class="acc-btn sm" data-acc-receipt="phone">Use phone</button><input type="file" id="accReceiptFile" accept="image/*" hidden></div><small style="display:block;margin-top:4px;color:#7b8594">Optional: a photo of the bank slip or wallet screen.</small>`;
    const svg = el.querySelector("svg");
    if (svg) svg.setAttribute("style", "width:100%;height:100%");
    if (receipt.error) el.insertAdjacentHTML("beforeend", `<p role="alert" style="margin:6px 0 0;color:#b42318;font-size:13px">${esc(receipt.error)}</p>`);
  }
  new MutationObserver(() => {
    const el = $("accReceipt");
    if (el && !el.dataset.painted) paintReceipt();
    const pickEl = $("accSettlePick");
    if (pickEl && !pickEl.dataset.painted && S.pick) (pickEl.dataset.painted = "1"), S.pick.paint();
    const billEl = $("accBillPick");
    if (billEl && !billEl.dataset.painted && S.bill) (billEl.dataset.painted = "1"), S.bill.paint();
  }).observe(document.body, { childList: true, subtree: true });
  const shrinkPhoto = file =>
    new Promise((resolve, reject) => {
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
      img.onerror = () => reject(new Error("That file isn't a photo."));
      img.src = URL.createObjectURL(file);
    });
  async function checkReceiptLink() {
    if (!receipt.link) return;
    if (!$("accReceipt")) return closeReceiptLink();
    try {
      const r = await DF.api(`/photo-links/${encodeURIComponent(receipt.link.id)}`);
      if (r.status !== "done" || !receipt.link) return;
      clearInterval(receipt.timer);
      Object.assign(receipt, { dataUrl: r.dataUrl, link: null, timer: null, error: "" });
      paintReceipt();
    } catch (error) {
      if (error?.status === 404) {
        clearInterval(receipt.timer);
        Object.assign(receipt, { link: null, timer: null, error: "The phone link expired. Try again." });
        paintReceipt();
      }
    }
  }
  DF.events.on("photo_link.done", e => receipt.link && e.linkId === receipt.link.id && void checkReceiptLink());
  document.addEventListener("click", async event => {
    const el = event.target instanceof Element ? event.target.closest("[data-acc-receipt]") : null;
    if (!el) return;
    event.preventDefault();
    const action = el.dataset.accReceipt;
    receipt.error = "";
    if (action === "upload") return void $("accReceiptFile")?.click();
    if (action === "remove") receipt.dataUrl = null;
    if (action === "cancel") closeReceiptLink();
    if (action === "phone") {
      try {
        receipt.link = await DF.api("/photo-links", { method: "POST", body: { title: receipt.title } });
        clearInterval(receipt.timer);
        receipt.timer = setInterval(() => void checkReceiptLink(), 3000);
      } catch (error) {
        receipt.error = DF.describe(error);
      }
    }
    paintReceipt();
  });
  document.addEventListener("change", async event => {
    if (event.target?.id !== "accReceiptFile" || !event.target.files?.[0]) return;
    try {
      receipt.dataUrl = await shrinkPhoto(event.target.files[0]);
    } catch (error) {
      receipt.error = error.message;
    }
    paintReceipt();
  });

  // ───────────── live updates and the menu count ─────────────
  const ACC_PAGES = ["Accounts overview", ...Object.values(KIND_PAGE), "Rider cash", "Hub transfers"];
  DF.live?.(["account.updated", "cash.slip", "cash.transfer"], () => {
    for (const key of Object.keys(Ops.cache)) if (key.startsWith("acc-") && key !== "acc-config") Ops.invalidate(key);
    if (ACC_PAGES.includes(Ops.page())) Ops.rerender();
    void updateCount();
  });
  /** Menu badge: slips waiting at your hubs, plus (money staff) transfers to receive and payments to confirm. */
  async function updateCount() {
    const badge = document.querySelector('[data-stage-count="Accounts"]');
    if (!badge || !Ops.me) return;
    if (!cashStaff() && !moneyStaff()) return void (badge.hidden = true);
    try {
      const [slips, transit, pending] = await Promise.all([
        cashStaff() ? DF.api("/cash/slips?status=OPEN") : { items: [] },
        moneyStaff() ? DF.api("/cash/transfers?status=IN_TRANSIT") : { items: [] },
        moneyStaff() ? DF.api("/payments?status=PENDING") : { items: [] },
      ]);
      const n = slips.items.length + transit.items.length + pending.items.length;
      badge.textContent = String(n);
      badge.hidden = !n;
    } catch {
      badge.hidden = true;
    }
  }
  const whenReady = () => (Ops.me ? void updateCount() : setTimeout(whenReady, 1000));
  whenReady();
})();
