/*
 * Website › customer area › Payments (#/payments): the customer's COD account (modules/money), limited:
 * cards (COD collected, on its way, ready, paid to you), where payouts go (change it), payouts with their
 * receipts, and the COD parcels. Customers are paid by bKash to the sender's phone unless they choose otherwise.
 */
(() => {
  const DF = window.DF;
  if (!DF) return;
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const tk = n => `৳${Number(n || 0).toLocaleString("en-BD", { maximumFractionDigits: 2 })}`;
  const day = iso => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Dhaka" }) : "—");
  const METHOD = { BKASH: "bKash", NAGAD: "Nagad", ROCKET: "Rocket", BANK: "Bank transfer", CASH: "Cash", OTHER: "Other" };
  const S = { accounts: null, payouts: [], parcels: [], error: "", editing: false };

  document.head.insertAdjacentHTML(
    "beforeend",
    `<style id="cpStyles">
.cp{display:grid;gap:14px}
.cp-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.cp-card{border:1px solid #e6e9ef;border-radius:14px;padding:12px 14px;display:grid;gap:3px;background:#fff}
.cp-card small{color:#667085;font-size:12px;font-weight:600}
.cp-card strong{font-size:20px}
.cp-card.key{border-color:#b8c8ff;background:#f5f8ff}
.cp-card.key strong{color:#2f55c9}
.cp-box{border:1px solid #e6e9ef;border-radius:14px;overflow:hidden;background:#fff}
.cp-box h3{margin:0;padding:12px 14px;border-bottom:1px solid #e6e9ef;font-size:15px}
.cp-row{display:flex;justify-content:space-between;gap:10px;padding:10px 14px;border-bottom:1px solid #f0f2f5;font-size:13px;align-items:center}
.cp-row:last-child{border-bottom:0}
.cp-row small{display:block;color:#667085}
.cp-empty{padding:18px 14px;color:#667085;font-size:13px}
.cp-pill{display:inline-flex;padding:3px 9px;border-radius:999px;font-size:12px;font-weight:600;background:#f2f4f7}
.cp-pill.good{background:#ecfdf3;color:#067647}.cp-pill.blue{background:#eff4ff;color:#2f55c9}.cp-pill.warn{background:#fffaeb;color:#b54708}
.cp-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;padding:12px 14px}
.cp-form label{display:grid;gap:4px;font-size:13px;font-weight:600}
.cp-form input,.cp-form select{height:38px;border:1px solid #d0d5dd;border-radius:9px;padding:0 10px;font:inherit;font-weight:400}
</style>`,
  );

  async function load() {
    try {
      S.accounts = await DF.api("/my-accounts");
      const a = S.accounts.find(x => x.kind === "CUSTOMER");
      if (a) {
        const [payouts, parcels] = await Promise.all([DF.api(`/payouts?accountId=${a.id}`), DF.api(`/accounts/${a.id}/parcels`)]);
        S.payouts = payouts.items;
        S.parcels = parcels.items;
      }
      S.error = "";
    } catch (error) {
      S.error = DF.describe(error);
    }
    paint();
  }

  function paint() {
    const box = $("dfCustomerPayments");
    if (!box) return;
    box.dataset.painted = "1";
    box.classList.remove("route-card");
    if (S.error) return void (box.innerHTML = `<div class="cp-empty">${esc(S.error)}</div>`);
    if (!S.accounts) return void (box.innerHTML = `<div class="cp-empty">Loading your payments…</div>`);
    const a = S.accounts.find(x => x.kind === "CUSTOMER");
    if (!a) return void (box.innerHTML = `<div class="cp-box"><div class="cp-empty">When a parcel you send with cash on delivery is delivered, its COD shows here and is paid to you.</div></div>`);
    const c = a.cod;
    const p = a.payTo;
    box.innerHTML = `<div class="cp">
      <div class="cp-cards">
        <div class="cp-card"><small>COD collected</small><strong>${tk(c.collected)}</strong></div>
        <div class="cp-card"><small>On its way to us</small><strong>${tk(c.withRider + c.atHubs)}</strong></div>
        <div class="cp-card key"><small>Ready to pay you</small><strong>${tk(c.ready)}</strong></div>
        <div class="cp-card"><small>Paid to you</small><strong>${tk(c.settled)}</strong></div>
      </div>
      <div class="cp-box"><h3>Where we pay you</h3>${
        S.editing
          ? `<form class="cp-form" id="cpPayTo"><label>Method<select name="method">${["BKASH", "NAGAD", "ROCKET", "BANK"].map(m => `<option value="${m}"${p?.method === m ? " selected" : ""}>${METHOD[m]}</option>`).join("")}</select></label>
             <label>Account name<input name="accountName" required minlength="2" maxlength="120" value="${esc(p?.accountName || "")}"></label>
             <label>Number<input name="accountNumber" required minlength="5" maxlength="40" value="${esc(p?.accountNumber || "")}"></label>
             <label>Bank (bank transfer)<input name="bankName" maxlength="120" value="${esc(p?.bankName || "")}"></label>
             <div style="display:flex;gap:8px;align-items:end"><button class="button button-primary" type="submit">Save</button><button class="button" type="button" data-cp="cancel">Cancel</button></div></form>`
          : `<div class="cp-row"><span><strong>${esc(METHOD[p?.method] || p?.method || "bKash")}</strong> · ${esc(p?.accountName || "")} · ${esc(p?.accountNumber || "")}</span><button class="button" type="button" data-cp="edit">Change</button></div>`
      }</div>
      <div class="cp-box"><h3>Payments to you</h3>${
        S.payouts.map(x => `<div class="cp-row"><span><strong>${esc(x.number)}</strong> · ${tk(x.amount)}<small>${x.parcels} parcel(s) · ${x.status === "PAID" ? `paid ${day(x.paidAt)} by ${esc(METHOD[x.method] || x.method)}${x.reference ? ` · ${esc(x.reference)}` : ""}` : "being paid"}</small></span><span style="display:flex;gap:6px">${x.receipt ? `<button class="button" type="button" data-cp="file" data-file="${x.receipt.fileId}">Receipt</button>` : ""}<button class="button" type="button" data-cp="pdf" data-id="${x.id}">PDF</button></span></div>`).join("") ||
        `<div class="cp-empty">No payments yet.</div>`
      }</div>
      <div class="cp-box"><h3>COD parcels</h3>${
        S.parcels.map(x => `<div class="cp-row"><span><strong>${esc(x.trackingId)}</strong><small>${esc(x.recipient || "")} · ${esc(x.outcome)} ${day(x.date)} · COD ${tk(x.cod)} − charges ${tk(x.charge + x.returnCharge)}</small></span><span style="text-align:right"><strong>${tk(x.net)}</strong><br>${x.payout?.status === "PAID" ? `<span class="cp-pill good">Paid</span>` : x.payout ? `<span class="cp-pill warn">Being paid</span>` : x.ready ? `<span class="cp-pill blue">Ready</span>` : `<span class="cp-pill">${esc(x.cash?.label || "On its way")}</span>`}</span></div>`).join("") ||
        `<div class="cp-empty">No COD parcels yet.</div>`
      }</div></div>`;
  }

  new MutationObserver(() => {
    const box = $("dfCustomerPayments");
    if (box && !box.dataset.painted) {
      paint();
      void load();
    }
  }).observe(document.body, { childList: true, subtree: true });

  document.addEventListener("click", event => {
    const el = event.target instanceof Element ? event.target.closest("[data-cp]") : null;
    if (!el) return;
    event.preventDefault();
    const d = el.dataset;
    if (d.cp === "edit" || d.cp === "cancel") return (S.editing = d.cp === "edit"), paint();
    if (d.cp === "pdf") return void window.DFPrint?.open(`/documents/payout/${d.id}`, { title: "Preparing the payment…" });
    if (d.cp === "file") {
      const tab = window.open("", "_blank");
      DF.apiRaw(`/files/${encodeURIComponent(d.file)}`)
        .then(r => r.blob())
        .then(blob => (tab ? (tab.location.href = URL.createObjectURL(blob)) : window.open(URL.createObjectURL(blob), "_blank")))
        .catch(error => (tab?.close(), window.showToast?.(DF.describe(error))));
    }
  });
  document.addEventListener("submit", async event => {
    if (event.target?.id !== "cpPayTo") return;
    event.preventDefault();
    const f = event.target.elements;
    const a = S.accounts.find(x => x.kind === "CUSTOMER");
    try {
      await DF.api(`/accounts/${a.id}/pay-to`, { method: "PUT", body: { method: f.method.value, accountName: f.accountName.value.trim(), accountNumber: f.accountNumber.value.trim(), bankName: f.bankName.value.trim() || undefined } });
      S.editing = false;
      window.showToast?.("Saved. Your next payment goes there.");
      void load();
    } catch (error) {
      window.showToast?.(DF.describe(error));
    }
  });
  DF.live?.(["account.updated"], () => $("dfCustomerPayments") && void load());
})();
