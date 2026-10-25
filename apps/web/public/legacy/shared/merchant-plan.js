/*
 * "Services & pricing" in both merchant panels (window.DFMerchantPlan, ?page=services-and-pricing):
 * the merchant's service package told in plain words, from GET /merchants/me/plan.
 *
 *   Services   what the package includes (with its price) · what it doesn't
 *              (with "Request" → a prefilled support ticket)
 *   Messages   each parcel message by stage: to whom, when, SMS / email on or off, in the package or not;
 *              support and account messages; products whose messages are switched off
 *   Pricing    route prices, extra charges, COD, failed deliveries & returns, worked examples and a
 *              calculator (POST /merchants/me/quote, the same price the booking uses)
 *
 * Loaded after shared/notifications.js and before the merchant bridge: it adds the menu item (before
 * Settings) and draws the page through the panel's renderPage; the bridge's own wrapper keeps the page
 * state. It reloads on every visit; while open, "merchant.updated" (and a slow poll) refresh it.
 */
(() => {
  const DF = window.DF;
  if (!DF || !DF.auth?.user) return;
  const app = document.body.dataset.app;
  if (app !== "ecommerce-merchant" && app !== "banking-merchant") return;
  const PAGE = "Services & pricing";
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const tk = n => `৳${Math.round(Number(n || 0)).toLocaleString("en-US")}`;
  const signed = n => (n < 0 ? `−${tk(-n)}` : tk(n));
  const dateOnly = iso => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "");
  const merchantQuery = (sep = "?") => window.DFMerchantPanel?.merchantQuery?.(sep) || "";

  const ICON = {
    check: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 10.5l3.2 3.2L15 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    minus: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 10h8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    lock: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="5" y="9" width="10" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M7.5 9V7a2.5 2.5 0 015 0v2" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>',
  };

  document.head.insertAdjacentHTML(
    "beforeend",
    `<style id="dfPlanStyles">
.dfp{display:grid;grid-template-columns:minmax(0,1fr);gap:16px;min-width:0}
.dfp-hero{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:16px;align-items:stretch}
.dfp-card{background:var(--surface,#fff);border:1px solid var(--line,#e9edf2);border-radius:12px;padding:18px}
.dfp-plan{display:flex;flex-direction:column;gap:10px;background:linear-gradient(135deg,var(--green-soft,#e8f7f0),#fff 70%)}
.dfp-plan h2{margin:0;font-size:22px;line-height:1.25}
.dfp-plan p{margin:0;color:var(--muted,#7b8796);font-size:13px}
.dfp-tags{display:flex;flex-wrap:wrap;gap:6px}
.dfp-tag{display:inline-flex;align-items:center;gap:4px;white-space:nowrap;padding:3px 9px;border-radius:999px;font-size:12px;font-weight:600;background:#fff;border:1px solid var(--line,#e9edf2);color:var(--ink,#182230)}
.dfp-tag.green{background:var(--green-soft,#e8f7f0);border-color:transparent;color:var(--green,#16845b)}
.dfp-tag.blue{background:var(--blue-soft,#edf2ff);border-color:transparent;color:var(--blue,#3766e8)}
.dfp-tag.amber{background:var(--amber-soft,#fff5df);border-color:transparent;color:var(--amber,#b87913)}
.dfp-tag.grey{background:#f2f4f7;border-color:transparent;color:#667085}
.dfp-notice{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-radius:10px;background:var(--amber-soft,#fff5df);color:#7a5208;font-size:13px}
.dfp-notice.info{background:var(--blue-soft,#edf2ff);color:#24489c}
.dfp-stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.dfp-stat{border:1px solid var(--line,#e9edf2);border-radius:10px;padding:12px;background:#fff}
.dfp-stat small{display:block;color:var(--muted,#7b8796);font-size:12px}
.dfp-stat strong{display:block;font-size:20px;margin-top:3px}
.dfp-stat span{display:block;color:var(--muted,#7b8796);font-size:12px;margin-top:2px}
.dfp-tabs{display:flex;gap:4px;padding:4px;border-radius:11px;background:#eef1f5;width:max-content;max-width:100%;overflow-x:auto}
.dfp-tab{border:0;background:none;padding:8px 16px;border-radius:8px;font:inherit;font-weight:600;font-size:14px;color:#526071;cursor:pointer;white-space:nowrap}
.dfp-tab[aria-selected="true"]{background:#fff;color:var(--ink,#182230);box-shadow:0 1px 3px #1018281a}
.dfp-section-title{display:flex;justify-content:space-between;align-items:flex-end;gap:10px;flex-wrap:wrap;margin:6px 0 -4px}
.dfp-section-title h3{margin:0;font-size:16px}
.dfp-section-title p{margin:2px 0 0;color:var(--muted,#7b8796);font-size:13px}
.dfp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:12px}
.dfp-ok,.dfp-no{flex:none;display:inline-grid;place-items:center;width:20px;height:20px;border-radius:50%}
.dfp-ok{background:var(--green-soft,#e8f7f0);color:var(--green,#16845b)}
.dfp-no{background:#f2f4f7;color:#98a2b3}
.dfp-ok svg,.dfp-no svg{width:14px;height:14px}
.dfp-svc-head{display:flex;justify-content:space-between;gap:8px;align-items:baseline;margin-bottom:6px}
.dfp-svc-head h4{margin:0;font-size:14px}
.dfp-svc-head small{color:var(--muted,#7b8796);font-size:12px}
.dfp-svc{display:flex;gap:10px;padding:10px 0;border-top:1px solid #f0f2f5}
.dfp-svc:first-of-type{border-top:0}
.dfp-svc.off .dfp-svc-name{color:#667085}
.dfp-svc-body{flex:1;min-width:0}
.dfp-svc-name{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-weight:600;font-size:14px}
.dfp-svc-detail{color:var(--muted,#7b8796);font-size:13px;margin-top:2px;line-height:1.4}
.dfp-svc-price{font-size:13px;margin-top:3px;font-weight:600;color:var(--ink,#182230)}
.dfp-svc.off .dfp-svc-price{color:#98a2b3;font-weight:500}
.dfp-link{border:0;background:none;padding:0;color:var(--blue,#3766e8);font:inherit;font-size:13px;font-weight:600;cursor:pointer}
.dfp-link:hover{text-decoration:underline}
.dfp-filter{display:flex;gap:6px;flex-wrap:wrap}
.dfp-table{width:100%;border-collapse:collapse;font-size:13px}
.dfp-table th{text-align:left;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted,#7b8796);font-weight:700;padding:8px 10px;border-bottom:1px solid var(--line,#e9edf2);white-space:nowrap}
.dfp-table td{padding:10px;border-bottom:1px solid #f0f2f5;vertical-align:top}
.dfp-table tr.off td{color:#98a2b3}
.dfp-table tr.off td strong{color:#667085}
.dfp-table td small{display:block;color:var(--muted,#7b8796);margin-top:2px}
.dfp-ch{display:inline-flex;align-items:center;gap:4px;font-weight:600;white-space:nowrap}
.dfp-ch.on{color:var(--green,#16845b)}
.dfp-ch.off{color:#98a2b3;font-weight:500}
.dfp-ch svg{width:14px;height:14px}
.dfp-scroll{overflow-x:auto}
.dfp-table tr.dfp-sample-row td{background:#fafbfc;padding:14px 10px 16px}
.dfp-table tr.dfp-has-sample td{border-bottom-color:transparent}
.dfp-samples{white-space:normal;display:grid;align-items:stretch;grid-template-columns:repeat(auto-fit,minmax(min(280px,100%),1fr));gap:12px}
.dfp-sample-title{grid-column:1/-1;margin:2px 0 -4px;font-size:12px;font-weight:700;color:#475467}
.dfp-phone,.dfp-mail{border:1px solid var(--line,#e9edf2);border-radius:12px;background:#fff;min-width:0}
.dfp-phone{padding:12px}
.dfp-sample-head{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:var(--muted,#7b8796);margin-bottom:8px}
.dfp-sample-head b{color:var(--ink,#182230);font-weight:700}
.dfp-bubble{background:#eef1f5;border-radius:14px 14px 14px 4px;padding:10px 12px;font-size:13px;line-height:1.5;color:var(--ink,#182230);white-space:pre-wrap;overflow-wrap:anywhere}
.dfp-mail-head{padding:12px 12px 10px;border-bottom:1px solid var(--line,#e9edf2)}
.dfp-mail-head .dfp-sample-head{margin-bottom:4px}
.dfp-mail-subject{font-size:14px;font-weight:700;color:var(--ink,#182230);overflow-wrap:anywhere}
.dfp-mail-body{padding:12px;font-size:13px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere;color:#344054}
.dfp-sample-note{grid-column:1/-1;font-size:12px;color:#7a5208;background:var(--amber-soft,#fff5df);border-radius:8px;padding:6px 10px}
.dfp-sample-toggle{margin-top:4px;font-size:12px}
.dfp-routes{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr));gap:12px}
.dfp-route{border:1px solid var(--line,#e9edf2);border-radius:12px;padding:16px;background:#fff}
.dfp-route small{color:var(--muted,#7b8796);font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.dfp-route strong{display:block;font-size:28px;margin:6px 0 2px}
.dfp-route p{margin:0;font-size:13px;color:var(--muted,#7b8796)}
.dfp-rows{display:grid}
.dfp-row{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid #f0f2f5;font-size:14px}
.dfp-row:first-child{border-top:0}
.dfp-row div small{display:block;color:var(--muted,#7b8796);font-size:12px;margin-top:2px}
.dfp-row b{white-space:nowrap;text-align:right}
.dfp-example{display:flex;flex-direction:column;gap:6px}
.dfp-example h4{margin:0 0 4px;font-size:14px}
.dfp-line{display:flex;justify-content:space-between;gap:10px;font-size:13px;color:#475467}
.dfp-total{display:flex;justify-content:space-between;gap:10px;border-top:1px dashed var(--line,#e9edf2);padding-top:8px;margin-top:4px;font-weight:700;font-size:15px}
.dfp-calc form{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(180px,100%),1fr));gap:12px;align-items:end}
.dfp-calc label{display:grid;gap:5px;font-size:12px;font-weight:600;color:#475467}
.dfp-calc input,.dfp-calc select{height:40px;border:1px solid var(--line,#dfe3e8);border-radius:8px;padding:0 10px;font:inherit;font-size:14px;background:#fff;color:var(--ink,#182230);min-width:0}
.dfp-calc-out{display:grid;gap:5px;margin-top:14px;border-radius:10px;background:var(--canvas,#f5f7fa);padding:14px}
.dfp-muted{color:var(--muted,#7b8796);font-size:13px;margin:0}
.dfp-foot{color:var(--muted,#7b8796);font-size:12px;margin:0}
@media (max-width:860px){.dfp-hero{grid-template-columns:minmax(0,1fr)}}
@media (max-width:560px){.dfp-msg-table thead{display:none}.dfp-msg-table,.dfp-msg-table tbody,.dfp-msg-table tr,.dfp-msg-table td{display:block;width:100%;box-sizing:border-box}.dfp-msg-table tr[data-dfp-message]{padding:10px 0 8px;border-bottom:1px solid #f0f2f5}.dfp-msg-table tr.dfp-has-sample{border-bottom:0}.dfp-msg-table tr[data-dfp-message] td{border:0;padding:2px 0}.dfp-msg-table tr[data-dfp-message] td[data-label]{display:inline-block;width:auto;margin-right:14px;font-size:12px}.dfp-msg-table td[data-label]::before{content:attr(data-label) " ";color:var(--muted,#7b8796);font-weight:600}.dfp-msg-table tr.dfp-sample-row td{padding:10px;border-radius:10px}.dfp-table .dfp-hide-sm{display:none}.dfp-tabs{width:100%}.dfp-tab{flex:1;padding:8px 10px}}
</style>`,
  );

  const state = { data: null, loading: false, error: "", tab: "services", filter: "all", quote: null, quoteError: "", quoting: false, samples: new Set(), allSamples: false };

  // ───────────── the menu item (before Settings) ─────────────

  function addMenuItem() {
    const nav = $("navigation");
    if (!nav || nav.querySelector(`[data-page="${PAGE}"]`)) return;
    const settings = nav.querySelector('[data-page="Settings"]');
    const button = document.createElement("button");
    button.className = "nav-item";
    button.dataset.page = PAGE;
    button.innerHTML = `<svg fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7"><use href="#i-tag"/></svg>${PAGE}`;
    if (settings) settings.before(button, " ");
    else nav.append(button);
  }
  addMenuItem();

  // ───────────── markup ─────────────

  const ok = () => `<span class="dfp-ok">${ICON.check}</span>`;
  const no = () => `<span class="dfp-no">${ICON.minus}</span>`;
  const channel = (c, inPlan) => {
    if (!c.available) return `<span class="dfp-ch off">—</span>`;
    if (!inPlan || !c.on) return `<span class="dfp-ch off">Off</span>`;
    return `<span class="dfp-ch on">${ICON.check} On</span>`;
  };

  function heroMarkup(d) {
    const parcelOn = d.messages.parcel.filter(m => m.included && (m.channels.sms.on || m.channels.email.on)).length;
    const from = Math.min(...d.prices.routes.flatMap(r => (r.types ? r.types.map(t => t.amount) : [r.amount])));
    const scheduled = d.scheduled[0];
    const status = d.merchant.status !== "ACTIVE" ? `<div class="dfp-notice info">Your account is still being reviewed. This is the plan you'll book with once it's approved.</div>` : "";
    return `<div class="dfp-hero">
      <section class="dfp-card dfp-plan" aria-label="Your plan">
        <div class="dfp-tags"><span class="dfp-tag green">${ICON.check} Active plan</span><span class="dfp-tag">${esc(d.segmentLabel)}</span></div>
        <h2 id="dfpPlanName">${esc(d.package.name)}</h2>
        <p>${esc(d.merchant.name)} · ${esc(d.merchant.code)}${d.package.effectiveFrom ? ` · in force since ${esc(dateOnly(d.package.effectiveFrom))}` : ""} · version ${esc(d.package.version)}</p>
        ${scheduled ? `<div class="dfp-notice" id="dfpScheduled">Your plan changes to <b>&nbsp;${esc(scheduled.name)}&nbsp;</b> on ${esc(dateOnly(scheduled.effectiveFrom))}. Parcels booked before then keep today's prices.</div>` : ""}
        ${status}
        <p>Every parcel keeps the price it was booked with, even if your plan changes later.</p>
        <div><button type="button" class="dfp-link" data-dfp-ask>Questions about your plan? Ask us →</button></div>
      </section>
      <section class="dfp-stats" aria-label="At a glance">
        <div class="dfp-stat"><small>Services in your plan</small><strong>${d.summary.included}</strong><span>${d.summary.notIncluded ? `${d.summary.notIncluded} more available on request` : "Everything available"}</span></div>
        <div class="dfp-stat"><small>Parcel messages on</small><strong>${parcelOn}</strong><span>SMS or email, to you or your customer</span></div>
        <div class="dfp-stat"><small>Delivery from</small><strong>${tk(from)}</strong><span>${d.prices.includedWeightKg ? `per parcel, up to ${d.prices.includedWeightKg} kg` : "per parcel"}</span></div>
        <div class="dfp-stat"><small>${d.prices.cod.length ? "COD fee" : "Returns"}</small><strong>${d.prices.cod.length ? esc(d.prices.cod[0].value.replace(" of the cash collected", "")) : esc(d.prices.failed[1].value.replace(" of the delivery charge", ""))}</strong><span>${d.prices.cod.length ? "of the cash collected" : "of the delivery charge"}</span></div>
      </section>
    </div>`;
  }

  function servicesMarkup(d) {
    const show = item => state.filter === "all" || (state.filter === "included" ? item.included : !item.included);
    const sections = d.services
      .map(s => {
        const items = s.items.filter(show);
        if (!items.length) return "";
        const on = s.items.filter(i => i.included).length;
        return `<div class="dfp-card"><div class="dfp-svc-head"><h4>${esc(s.title)}</h4><small>${on} of ${s.items.length} in your plan</small></div><p class="dfp-muted" style="margin:-2px 0 6px">${esc(s.hint)}</p>${items
          .map(
            i => `<div class="dfp-svc${i.included ? "" : " off"}" data-dfp-service="${esc(i.code)}">${i.included ? ok() : no()}<div class="dfp-svc-body"><div class="dfp-svc-name">${esc(i.label)} ${i.always ? `<span class="dfp-tag green">Always included</span>` : i.included ? "" : `<span class="dfp-tag grey">Not in your plan</span>`}</div><div class="dfp-svc-detail">${esc(i.detail)}</div>${i.included && i.price ? `<div class="dfp-svc-price">${esc(i.price)}</div>` : ""}${i.included ? "" : `<div class="dfp-svc-price"><button type="button" class="dfp-link" data-dfp-request="${esc(i.label)}">Request this service</button></div>`}</div></div>`,
          )
          .join("")}</div>`;
      })
      .join("");
    const filter = ["all", "included", "not"].map(f => `<button type="button" class="button button-sm${state.filter === f ? " button-primary" : ""}" data-dfp-filter="${f}" aria-pressed="${state.filter === f}">${{ all: "All services", included: "In your plan", not: "Not in your plan" }[f]}</button>`).join("");
    return `<div class="dfp-section-title"><div><h3>Your plan's services</h3><p>What you can choose when you book. Services that aren't in your plan don't appear in your order form, Excel template or API.</p></div><div class="dfp-filter" role="group" aria-label="Show">${filter}</div></div>
      <div class="dfp-grid">${sections || `<div class="dfp-card"><p class="dfp-muted">Nothing to show for this filter.</p></div>`}</div>`;
  }

  /** The sample SMS (a phone bubble) and email of a message, as the current templates render them. */
  function samplesMarkup(r) {
    const who = r.to === "You" ? "you" : "your customer";
    const status = c => (!c.available ? "" : !r.included ? "not in your plan" : c.on ? "sent" : "switched off");
    const off = !r.included || !(r.channels.sms.on || r.channels.email.on);
    const many = r.samples.length > 1;
    return `<div class="dfp-samples">${off ? `<div class="dfp-sample-note">${r.included ? "This message is switched off at the moment, so it isn't sent." : "Not in your plan, so it isn't sent. This is what it would look like."}</div>` : ""}${r.samples
      .map(
        x => `${many ? `<p class="dfp-sample-title">${esc(x.label)}</p>` : ""}${
          x.sms
            ? `<div class="dfp-phone" data-dfp-sms><div class="dfp-sample-head"><span><b>SMS</b> to ${esc(who)}</span><span>${esc(status(r.channels.sms))}${x.sms.parts > 1 ? ` · ${x.sms.parts} SMS parts` : ""}</span></div><div class="dfp-bubble">${esc(x.sms.text)}</div></div>`
            : ""
        }${
          x.email
            ? `<div class="dfp-mail" data-dfp-email><div class="dfp-mail-head"><div class="dfp-sample-head"><span><b>Email</b> to ${esc(who)}</span><span>${esc(status(r.channels.email))}</span></div><div class="dfp-mail-subject">${esc(x.email.subject)}</div></div><div class="dfp-mail-body">${esc(x.email.text)}</div></div>`
            : ""
        }`,
      )
      .join("")}</div>`;
  }

  function messagesMarkup(d) {
    const m = d.messages;
    const stage = name => {
      const rows = m.parcel.filter(x => x.stage === name);
      if (!rows.length) return "";
      return `<div class="dfp-card"><div class="dfp-svc-head"><h4>${esc(name)}</h4><small>${rows.filter(r => r.included).length} of ${rows.length} in your plan</small></div><div class="dfp-scroll"><table class="dfp-table dfp-msg-table"><thead><tr><th>Message</th><th>Sent to</th><th>SMS</th><th>Email</th></tr></thead><tbody>${rows
        .map(
          r => {
            const open = state.allSamples || state.samples.has(r.code);
            const has = (r.samples || []).some(x => x.sms || x.email);
            return `<tr class="${r.included ? "" : "off"}${has ? " dfp-has-sample" : ""}" data-dfp-message="${esc(r.code)}"><td><strong>${esc(r.label)}</strong><small>${esc(r.when)}</small>${r.included ? "" : `<small>Not in your plan · <button type="button" class="dfp-link" data-dfp-request="${esc(`${r.label} message`)}">Request</button></small>`}${has ? `<button type="button" class="dfp-link dfp-sample-toggle" data-dfp-sample="${esc(r.code)}" aria-expanded="${open}">${open ? "Hide sample" : "See sample message"}</button>` : ""}</td><td data-label="To">${esc(r.to)}</td><td data-label="SMS">${channel(r.channels.sms, r.included)}</td><td data-label="Email">${channel(r.channels.email, r.included)}</td></tr>${
              has ? `<tr class="dfp-sample-row" data-dfp-sample-row="${esc(r.code)}"${open ? "" : " hidden"}><td colspan="4">${samplesMarkup(r)}</td></tr>` : ""
            }`;
          },
        )
        .join("")}</tbody></table></div></div>`;
    };
    const support = m.support.length
      ? `<div class="dfp-card"><div class="dfp-svc-head"><h4>Support tickets</h4><small>To you</small></div><div class="dfp-scroll"><table class="dfp-table"><thead><tr><th>Message</th><th>SMS</th><th>Email</th></tr></thead><tbody>${m.support
          .map(r => `<tr class="${r.included ? "" : "off"}"><td><strong>${esc(r.label)}</strong>${r.included ? "" : "<small>Not in your plan</small>"}</td><td>${channel(r.channels.sms, r.included)}</td><td>${channel(r.channels.email, r.included)}</td></tr>`)
          .join("")}</tbody></table></div></div>`
      : "";
    const account = `<div class="dfp-card"><div class="dfp-svc-head"><h4>Account & payments</h4><small>To you · not part of the plan</small></div><div class="dfp-scroll"><table class="dfp-table"><thead><tr><th>Message</th><th>SMS</th><th>Email</th></tr></thead><tbody>${m.account
      .map(r => `<tr><td><strong>${esc(r.label)}</strong>${r.always ? `<small>${ICON.lock.replace("<svg", '<svg style="width:12px;height:12px;vertical-align:-2px"')} Always sent, for your security</small>` : ""}</td><td>${channel(r.channels.sms, true)}</td><td>${channel(r.channels.email, true)}</td></tr>`)
      .join("")}</tbody></table></div></div>`;
    const quiet = m.productsWithoutMessages.length
      ? `<div class="dfp-notice info" id="dfpQuietProducts"><span>Parcels of these products get <b>no SMS or email</b>: ${esc(m.productsWithoutMessages.join(", "))}.</span></div>`
      : "";
    return `<div class="dfp-section-title"><div><h3>Messages about your parcels</h3><p>A message goes out when it's in your plan and switched on, and still ticked on the order (all are ticked by default; untick any when you book). Open a sample to read the exact text; the tracking number, names and amounts are examples.</p></div><button type="button" class="button button-sm" data-dfp-samples-all aria-pressed="${state.allSamples}">${state.allSamples ? "Hide all samples" : "Show all samples"}</button></div>
      ${quiet}
      <div class="dfp-grid" style="grid-template-columns:minmax(0,1fr)">${m.stages.map(stage).join("")}</div>
      <div class="dfp-section-title"><div><h3>Other messages</h3><p>Email goes to the address on your account; in-app notifications appear in your bell.</p></div></div>
      <div class="dfp-grid">${support}${account}</div>`;
  }

  function pricingMarkup(d) {
    const p = d.prices;
    // E-commerce: route + what is sent, one title per pair with the sum.
    const routes = p.routes
      .map(r =>
        r.types
          ? r.types.map(t => `<div class="dfp-route" data-dfp-tier="${esc(r.tier)}" data-dfp-type="${esc(t.type)}"><small>${esc(t.label)}</small><strong>${tk(t.amount)}</strong><p>${esc(r.example)}</p></div>`).join("")
          : `<div class="dfp-route" data-dfp-tier="${esc(r.tier)}"><small>${esc(r.label)}</small><strong>${tk(r.amount)}</strong><p>${esc(r.example)}</p></div>`,
      )
      .join("");
    const rows = list => `<div class="dfp-rows">${list.map(r => `<div class="dfp-row"><div>${esc(r.label)}${r.note ? `<small>${esc(r.note)}</small>` : ""}</div><b>${esc(r.value)}</b></div>`).join("")}</div>`;
    const examples = d.examples
      .map(
        e => `<div class="dfp-card dfp-example"><h4>${esc(e.title)}</h4>${e.lines.map(l => `<div class="dfp-line"><span>${esc(l.label)}</span><span>${signed(l.amount)}</span></div>`).join("")}<div class="dfp-total"><span>You pay</span><span>${tk(e.total)}</span></div></div>`,
      )
      .join("");
    return `<div class="dfp-section-title"><div><h3>Delivery charge by route</h3><p>The route is set by the pickup and delivery districts${p.includedWeightKg ? `; up to ${p.includedWeightKg} kg is included` : ""}.</p></div></div>
      <div class="dfp-routes">${routes}</div>
      <div class="dfp-grid">
        <div class="dfp-card"><div class="dfp-svc-head"><h4>Added to the route price</h4></div>${rows(p.extras)}</div>
        <div class="dfp-card">${p.cod.length ? `<div class="dfp-svc-head"><h4>Cash on delivery</h4></div>${rows(p.cod)}<div style="height:12px"></div>` : ""}<div class="dfp-svc-head"><h4>Failed deliveries & returns</h4></div>${rows(p.failed)}</div>
      </div>
      <div class="dfp-section-title"><div><h3>Examples</h3><p>Worked out with your plan's prices, exactly as an order is priced.</p></div></div>
      <div class="dfp-grid">${examples}</div>
      ${calculatorMarkup(d)}
      <p class="dfp-foot">All prices in Bangladeshi taka. The price shown when you book is final for that parcel.</p>`;
  }

  function calculatorMarkup(d) {
    const c = d.calculator;
    const opt = (list, value) => list.map(o => `<option value="${esc(o.code)}"${o.code === value ? " selected" : ""}>${esc(o.label)}</option>`).join("");
    const districts = c.districts.map(x => `<option${x === (state.calc?.deliveryDistrict ?? d.merchant.pickupDistrict) ? " selected" : ""}>${esc(x)}</option>`).join("");
    const v = state.calc || {};
    const field = (label, control, hidden) => (hidden ? "" : `<label>${esc(label)}${control}</label>`);
    const q = state.quote;
    const out = state.quoting
      ? `<p class="dfp-muted">Working out the price…</p>`
      : state.quoteError
        ? `<p class="dfp-muted" style="color:var(--red,#c34d4d)">${esc(state.quoteError)}</p>`
        : q
          ? `${q.lines.map(l => `<div class="dfp-line"><span>${esc(l.label)}</span><span>${signed(l.amount)}</span></div>`).join("")}<div class="dfp-total"><span>You pay for this parcel</span><span id="dfpQuoteTotal">${tk(q.totalCharge)}</span></div><p class="dfp-foot" style="margin-top:6px">${esc(q.tierLabel)} · if it can't be delivered and comes back to you: +${tk(q.returnCharge)}</p>`
          : `<p class="dfp-muted">Choose the details and press Calculate.</p>`;
    return `<div class="dfp-card dfp-calc" id="dfpCalculator"><div class="dfp-svc-head"><h4>Price calculator</h4><small>From your pickup district: ${esc(d.merchant.pickupDistrict)}</small></div>
      <form id="dfpCalcForm" novalidate>
        ${field("Delivery district", `<select name="deliveryDistrict">${districts}</select>`)}
        ${field("Weight (kg)", `<input name="weightKg" type="number" min="0.1" max="50" step="0.1" value="${esc(v.weightKg ?? 1)}">`, !c.weight)}
        ${field("Cash to collect (৳)", `<input name="codAmount" type="number" min="0" step="1" value="${esc(v.codAmount ?? 0)}">`, !c.cod)}
        ${field("Service", `<select name="speed">${opt(c.speeds, v.speed)}</select>`, c.speeds.length < 2)}
        ${field("Hand over", `<select name="firstMile">${opt(c.firstMiles, v.firstMile)}</select>`, c.firstMiles.length < 2)}
        ${field("Delivery", `<select name="lastMile">${opt(c.lastMiles, v.lastMile)}</select>`, c.lastMiles.length < 2)}
        ${c.openBox ? `<label style="display:flex;align-items:center;gap:8px;height:40px"><input type="checkbox" name="openBox" style="height:auto"${v.openBox ? " checked" : ""}> Open box</label>` : ""}
        <button type="submit" class="button button-primary" style="height:40px">Calculate</button>
      </form>
      <div class="dfp-calc-out" id="dfpCalcOut" aria-live="polite">${out}</div></div>`;
  }

  function draw() {
    const main = $("mainContent");
    if (!main || $("breadcrumbPage")?.textContent !== PAGE) return;
    const d = state.data;
    const heading = `<div class="page-heading"><div><p class="eyebrow">Merchant workspace</p><h1>${PAGE}</h1><p class="subtitle">What your plan includes, the messages we send and what you pay.</p></div><div class="heading-actions"><button type="button" class="button" data-dfp-ask>Ask about my plan</button></div></div>`;
    if (!d) {
      main.innerHTML = `${heading}<section class="panel dfp-loading"><p class="dfp-muted">${state.error ? esc(state.error) : "Loading your plan…"}</p>${state.error ? `<button type="button" class="button" data-dfp-retry style="margin-top:10px">Try again</button>` : ""}</section>`;
      return;
    }
    const tabs = [
      ["services", "Services"],
      ["messages", "SMS & email"],
      ["pricing", "Pricing"],
    ];
    const body = state.tab === "messages" ? messagesMarkup(d) : state.tab === "pricing" ? pricingMarkup(d) : servicesMarkup(d);
    main.innerHTML = `${heading}<div class="dfp" id="dfpPage">${heroMarkup(d)}
      <div class="dfp-tabs" role="tablist" aria-label="Plan details">${tabs.map(([k, l]) => `<button type="button" role="tab" class="dfp-tab" data-dfp-tab="${k}" aria-selected="${state.tab === k}">${l}</button>`).join("")}</div>
      <div class="dfp" role="tabpanel" id="dfpPanel">${body}</div></div>`;
  }

  // ───────────── data ─────────────

  async function load() {
    state.loading = true;
    state.error = "";
    try {
      state.data = await DF.api(`/merchants/me/plan${merchantQuery()}`);
    } catch (error) {
      state.error = DF.describe(error);
    } finally {
      state.loading = false;
    }
    draw();
  }

  async function calculate(form) {
    const d = state.data;
    const f = new FormData(form);
    const v = {
      deliveryDistrict: String(f.get("deliveryDistrict") || d.merchant.pickupDistrict),
      weightKg: d.calculator.weight ? Number(f.get("weightKg") || 0.5) : 0.5,
      codAmount: d.calculator.cod ? Number(f.get("codAmount") || 0) : 0,
      speed: f.get("speed") || d.calculator.speeds[0]?.code,
      firstMile: f.get("firstMile") || d.calculator.firstMiles[0]?.code,
      lastMile: f.get("lastMile") || d.calculator.lastMiles[0]?.code,
      openBox: f.get("openBox") === "on",
    };
    if (d.calculator.weight && !(v.weightKg > 0 && v.weightKg <= 50)) return void ((state.quoteError = "Enter a weight between 0.1 and 50 kg."), (state.quote = null), draw());
    if (v.codAmount < 0) return void ((state.quoteError = "The cash to collect can't be negative."), (state.quote = null), draw());
    state.calc = v;
    state.quoting = true;
    state.quoteError = "";
    draw();
    try {
      state.quote = await DF.api(`/merchants/me/quote${merchantQuery()}`, {
        method: "POST",
        body: {
          pickupDistrict: d.merchant.pickupDistrict,
          pickupZone: d.merchant.pickupZone || undefined,
          deliveryDistrict: v.deliveryDistrict,
          weightKg: v.weightKg,
          codAmount: v.codAmount,
          speed: v.speed,
          firstMile: v.firstMile,
          lastMile: v.lastMile,
          ...(d.calculator.openBox ? { openBox: v.openBox } : {}),
        },
      });
    } catch (error) {
      state.quote = null;
      state.quoteError = DF.describe(error);
    } finally {
      state.quoting = false;
    }
    draw();
    $("dfpCalculator")?.scrollIntoView({ block: "nearest" });
  }

  function ask(subject, message) {
    if (window.DFSupport?.compose) return window.DFSupport.compose({ subject, category: "Account / API", ...(message ? { message } : {}) });
    window.showToast?.("Open Support from the menu to contact us.");
  }

  // ───────────── page and events ─────────────

  function showPage() {
    const crumb = $("breadcrumbPage");
    if (crumb) crumb.textContent = PAGE;
    document.querySelectorAll(".nav-item").forEach(item => item.classList.toggle("active", item.dataset.page === PAGE));
    $("sidebar")?.classList.remove("open");
    draw();
    if (!state.loading) void load();
  }

  const original = window.renderPage;
  if (typeof original === "function") {
    window.renderPage = function (page, ...rest) {
      if (page === PAGE) return showPage();
      return original.call(this, page, ...rest);
    };
  }

  document.addEventListener(
    "click",
    event => {
      const t = event.target instanceof Element ? event.target : null;
      if (!t || !t.closest("#mainContent")) return;
      let el;
      if ((el = t.closest("[data-dfp-tab]"))) {
        state.tab = el.dataset.dfpTab;
        return draw();
      }
      if ((el = t.closest("[data-dfp-sample]"))) {
        // In place (no redraw): the row below opens or closes.
        const code = el.dataset.dfpSample;
        const row = document.querySelector(`[data-dfp-sample-row="${CSS.escape(code)}"]`);
        const open = !!row?.hidden;
        if (open) state.samples.add(code);
        else state.samples.delete(code);
        if (row) row.hidden = !open;
        el.setAttribute("aria-expanded", String(open));
        el.textContent = open ? "Hide sample" : "See sample message";
        return;
      }
      if (t.closest("[data-dfp-samples-all]")) {
        state.allSamples = !state.allSamples;
        if (!state.allSamples) state.samples.clear();
        return draw();
      }
      if ((el = t.closest("[data-dfp-filter]"))) {
        state.filter = el.dataset.dfpFilter;
        return draw();
      }
      if ((el = t.closest("[data-dfp-request]"))) {
        const name = el.dataset.dfpRequest;
        return ask(`Add "${name}" to my plan`, `Please add "${name}" to our plan (${state.data?.package?.name || "current plan"}) and let us know the price.`);
      }
      if (t.closest("[data-dfp-ask]")) return ask(`Question about my plan${state.data ? ` (${state.data.package.name})` : ""}`);
      if (t.closest("[data-dfp-retry]")) return void load();
    },
    true,
  );
  document.addEventListener(
    "submit",
    event => {
      if (event.target?.id !== "dfpCalcForm") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void calculate(event.target);
    },
    true,
  );

  // The page reloads the plan each time it opens; while it is open, merchant changes (and a slow poll) refresh it.
  DF.live?.(["merchant.updated"], () => ($("breadcrumbPage")?.textContent === PAGE ? load() : Promise.resolve()), { debounceMs: 400, fallbackMs: 300_000 });

  window.DFMerchantPlan = { PAGE, open: () => (DF.nav?.panel ? DF.nav.go(`${location.pathname}?page=services-and-pricing`) : window.renderPage?.(PAGE)), reload: load };
})();
