/*
 * "Account verification": the whole merchant panel while the merchant account isn't active (under review,
 * information requested, not approved, suspended). Both merchant panels; window.DFMerchantVerification.
 *
 *   - No menu, search or bell: the screen is the panel (merchant-bridge.js sends every page here and hides the rest).
 *   - The status, stated plainly ("Your account isn't verified yet"), the steps to activation and what to do next.
 *   - Business verification: each document with its status, Upload / Replace / View, "Submit for review"
 *     (GET/POST /merchants/me/kyc…; owners only).
 *   - Messages from Delivery Fast and the reply form when information was requested (/merchants/me/review…).
 *   - The business profile, read-only (GET /merchants/me); changes are made by Delivery Fast during review.
 *
 * The API refuses everything else for an inactive merchant (MERCHANT_NOT_ACTIVE), see MerchantsService.resolveOwn.
 * Loaded before the merchant bridge: it draws the page through the panel's renderPage.
 */
(() => {
  const DF = window.DF;
  if (!DF || !DF.auth?.user) return;
  const app = document.body.dataset.app;
  if (app !== "ecommerce-merchant" && app !== "banking-merchant") return;
  const PAGE = "Account verification";
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const P = () => window.DFMerchantPanel;
  const q = (sep = "?") => P()?.merchantQuery?.(sep) || "";
  const toast = message => window.showToast?.(message);
  const fail = error => toast(DF.describe(error));
  const dateOnly = iso => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "");
  const dateTime = iso => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "");
  const phone = p => {
    const m = String(p || "").match(/^\+880(\d{4})(\d{6})$/);
    return m ? `+880 ${m[1]}-${m[2]}` : p || "";
  };
  const MAX_MB = 3.5;

  const I = {
    check: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 10.5l3.2 3.2L15 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    clock: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10 6.5V10l2.5 1.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    alert: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.5l7 12.5H3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M10 8.5v3.5M10 14.2v.3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 3v5.5c0 4.4-2.9 8.2-7 9.5-4.1-1.3-7-5.1-7-9.5V6z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M9 12l2.2 2.2L15.5 10" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    lock: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="5" y="9" width="10" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M7.5 9V7a2.5 2.5 0 015 0v2" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>',
    file: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 3h5.5L15 6.5V17H6z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M11 3v4h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  };

  document.head.insertAdjacentHTML(
    "beforeend",
    `<style id="dfVerifyStyles">
body.df-merchant-locked .sidebar,body.df-merchant-locked #mobileMenu,body.df-merchant-locked .top-actions .search-wrap,body.df-merchant-locked #notificationButton{display:none!important}
body.df-merchant-locked .main{margin-left:0!important}
.dfv{max-width:980px;margin:0 auto;display:grid;grid-template-columns:minmax(0,1fr);gap:16px}
.dfv-card{background:var(--surface,#fff);border:1px solid var(--line,#e9edf2);border-radius:12px;padding:20px;min-width:0}
.dfv-card h2{margin:0;font-size:16px}
.dfv-card-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.dfv-card-head p{margin:4px 0 0;color:var(--muted,#7b8796);font-size:13px}
.dfv-hero{display:flex;gap:16px;align-items:flex-start;padding:22px;border-radius:14px;border:1px solid}
.dfv-hero.amber{background:var(--amber-soft,#fff5df);border-color:#f3dfae}
.dfv-hero.blue{background:var(--blue-soft,#edf2ff);border-color:#cfdcfb}
.dfv-hero.red{background:var(--red-soft,#fff0ef);border-color:#f4cdca}
.dfv-hero-icon{flex:none;width:46px;height:46px;border-radius:12px;display:grid;place-items:center;background:#fff}
.dfv-hero.amber .dfv-hero-icon{color:var(--amber,#b87913)}
.dfv-hero.blue .dfv-hero-icon{color:var(--blue,#3766e8)}
.dfv-hero.red .dfv-hero-icon{color:var(--red,#c34d4d)}
.dfv-hero-icon svg{width:26px;height:26px}
.dfv-hero h2{margin:0 0 4px;font-size:20px;line-height:1.3}
.dfv-hero p{margin:0;font-size:14px;line-height:1.55;color:#344054}
.dfv-hero .dfv-meta{margin-top:10px;font-size:12px;color:#667085}
.dfv-badge{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:700;white-space:nowrap}
.dfv-badge svg{width:13px;height:13px}
.dfv-badge.amber{background:#fff;color:var(--amber,#b87913);border:1px solid #f0d9a3}
.dfv-badge.red{background:#fff;color:var(--red,#c34d4d);border:1px solid #f0c5c1}
.dfv-badge.green{background:var(--green-soft,#e8f7f0);color:var(--green,#16845b)}
.dfv-badge.grey{background:#f2f4f7;color:#667085}
.dfv-badge.blue{background:var(--blue-soft,#edf2ff);color:var(--blue,#3766e8)}
.dfv-steps{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.dfv-step{display:flex;gap:10px;align-items:flex-start;padding:12px;border-radius:10px;background:var(--canvas,#f5f7fa)}
.dfv-step-dot{flex:none;width:26px;height:26px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:700;background:#fff;border:2px solid #d0d5dd;color:#667085}
.dfv-step-dot svg{width:15px;height:15px}
.dfv-step.done .dfv-step-dot{background:var(--green,#16845b);border-color:var(--green,#16845b);color:#fff}
.dfv-step.current .dfv-step-dot{border-color:var(--blue,#3766e8);color:var(--blue,#3766e8)}
.dfv-step.failed .dfv-step-dot{border-color:var(--red,#c34d4d);color:var(--red,#c34d4d)}
.dfv-step strong{display:block;font-size:13px}
.dfv-step small{display:block;color:var(--muted,#7b8796);font-size:12px;margin-top:2px}
.dfv-docs{display:grid;gap:10px}
.dfv-doc{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid var(--line,#e9edf2);border-radius:10px}
.dfv-doc-icon{flex:none;width:36px;height:36px;border-radius:9px;display:grid;place-items:center;background:var(--canvas,#f5f7fa);color:#667085}
.dfv-doc-icon svg{width:18px;height:18px}
.dfv-doc.ok .dfv-doc-icon{background:var(--green-soft,#e8f7f0);color:var(--green,#16845b)}
.dfv-doc-body{flex:1;min-width:0}
.dfv-doc-body strong{font-size:14px}
.dfv-doc-body small{display:block;color:var(--muted,#7b8796);font-size:12px;margin-top:2px;overflow-wrap:anywhere}
.dfv-doc-actions{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.dfv-note{font-size:12px;color:var(--muted,#7b8796);margin:12px 0 0;line-height:1.5}
.dfv-alert{display:flex;gap:8px;padding:10px 12px;border-radius:10px;font-size:13px;line-height:1.5;margin-bottom:12px}
.dfv-alert svg{flex:none;width:16px;height:16px;margin-top:2px}
.dfv-alert.red{background:var(--red-soft,#fff0ef);color:#9b2c2c}
.dfv-alert.blue{background:var(--blue-soft,#edf2ff);color:#24489c}
.dfv-submit{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-top:14px;padding-top:14px;border-top:1px solid var(--line,#e9edf2)}
.dfv-submit p{margin:0;font-size:13px;color:#475467}
.dfv-thread{display:grid;gap:10px}
.dfv-msg{padding:12px 14px;border-radius:10px;background:var(--canvas,#f5f7fa);font-size:14px;line-height:1.5}
.dfv-msg.mine{background:var(--blue-soft,#edf2ff)}
.dfv-msg small{display:block;color:var(--muted,#7b8796);font-size:12px;margin-bottom:3px}
.dfv-reply{display:grid;gap:8px;margin-top:12px}
.dfv-reply textarea{width:100%;min-height:90px;border:1px solid var(--line,#dfe3e8);border-radius:10px;padding:10px;font:inherit;font-size:14px;resize:vertical;box-sizing:border-box}
.dfv-reply-actions{display:flex;justify-content:flex-end}
.dfv-profile{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 24px;margin:0}
.dfv-profile div{padding:11px 0;border-bottom:1px solid #f0f2f5;min-width:0}
.dfv-profile dt{font-size:12px;color:var(--muted,#7b8796);margin:0 0 3px}
.dfv-profile dd{margin:0;font-size:14px;color:var(--ink,#182230);overflow-wrap:anywhere}
.dfv-profile .full{grid-column:1/-1}
.dfv-readonly{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;color:#667085;background:#f2f4f7;border-radius:999px;padding:3px 10px;white-space:nowrap}
.dfv-readonly svg{width:13px;height:13px}
.dfv-muted{color:var(--muted,#7b8796);font-size:13px;margin:0}
.dfv .page-heading{margin-bottom:0}
.dfv .button:disabled,.dfv label.is-busy{opacity:.5;cursor:not-allowed;box-shadow:none}
@media (max-width:760px){.dfv-steps{grid-template-columns:minmax(0,1fr)}.dfv-profile{grid-template-columns:minmax(0,1fr)}.dfv-hero{padding:16px;gap:12px}.dfv-hero-icon{width:38px;height:38px}.dfv-doc{flex-wrap:wrap}.dfv-doc-actions{width:100%;justify-content:flex-start;padding-left:48px}.dfv-card{padding:16px}}
</style>`,
  );

  const state = { merchant: null, kyc: null, review: null, loading: false, error: "", busy: "" };
  const isOwner = () => state.merchant?.myRole === "MERCHANT_OWNER";

  // ───────────── what the screen says ─────────────

  /** The headline for the account's state: tone, icon, title, text, badge. */
  function headline() {
    const m = state.merchant;
    const k = state.kyc;
    const missing = k?.missing?.length || 0;
    const sms = phone(m.contactPhone);
    if (m.status === "SUSPENDED")
      return { tone: "red", icon: I.lock, badge: ["red", "Suspended"], title: "Your merchant account is suspended", text: "You can't book parcels or use the panel while the account is suspended. Contact Delivery Fast support to resolve it." };
    if (m.status === "REJECTED")
      return {
        tone: "red",
        icon: I.alert,
        badge: ["red", "Not approved"],
        title: "Your application wasn't approved",
        text: `${m.rejectionReason ? `Reason: ${m.rejectionReason}. ` : ""}Your account isn't verified, so the panel stays closed. You can apply again with corrected details from the website.`,
      };
    if (m.status === "INFO_REQUESTED")
      return { tone: "amber", icon: I.alert, badge: ["amber", "Not verified yet"], title: "Action needed: Delivery Fast needs more information", text: "Your account isn't verified yet. Read the message below, upload anything that's asked for and send your reply. Your application goes back to review straight away." };
    if (k?.status === "REJECTED")
      return { tone: "amber", icon: I.alert, badge: ["amber", "Not verified yet"], title: "Your documents need another look", text: `${k.rejectionReason ? `${k.rejectionReason}. ` : ""}Replace the documents below and submit them again.` };
    if (k?.status === "PENDING")
      return { tone: "blue", icon: I.clock, badge: ["amber", "Not verified yet"], title: "Your account isn't verified yet — review in progress", text: `We're reviewing your business documents. We'll text ${sms} as soon as it's done. Nothing else is needed from you right now.` };
    return {
      tone: "amber",
      icon: I.shield,
      badge: ["amber", "Not verified yet"],
      title: "Your account isn't verified yet",
      text: missing
        ? `Upload your business documents below and submit them for review. The panel — booking, shipments and payments — opens once Delivery Fast verifies your business.`
        : `All required documents are uploaded. Submit them for review to continue.`,
    };
  }

  function steps() {
    const m = state.merchant;
    const k = state.kyc;
    const docsDone = !!k && (k.status === "PENDING" || k.status === "APPROVED");
    const rejected = m.status === "REJECTED" || m.status === "SUSPENDED";
    const list = [
      { title: "Application received", note: dateOnly(m.createdAt), state: "done" },
      {
        title: "Business documents",
        note: docsDone ? `Submitted ${dateOnly(k.submittedAt)}` : k ? `${k.policy.documentTypes.filter(t => t.required).length - k.missing.length} of ${k.policy.documentTypes.filter(t => t.required).length} required uploaded` : "",
        state: docsDone ? "done" : k?.status === "REJECTED" ? "failed" : "current",
      },
      { title: "Review by Delivery Fast", note: m.status === "INFO_REQUESTED" ? "Waiting for your reply" : rejected ? (m.status === "SUSPENDED" ? "Account suspended" : "Not approved") : docsDone ? "In progress" : "After you submit", state: rejected ? "failed" : docsDone && m.status !== "INFO_REQUESTED" ? "current" : "todo" },
      { title: "Account active", note: "Booking, shipments, payments", state: "todo" },
    ];
    return `<ol class="dfv-steps" aria-label="Steps to activation">${list
      .map((s, i) => `<li class="dfv-step ${s.state}"><span class="dfv-step-dot">${s.state === "done" ? I.check : i + 1}</span><div><strong>${esc(s.title)}</strong>${s.note ? `<small>${esc(s.note)}</small>` : ""}</div></li>`)
      .join("")}</ol>`;
  }

  function documentsCard() {
    const k = state.kyc;
    if (!k) return `<section class="dfv-card"><h2>Business verification</h2><p class="dfv-muted" style="margin-top:8px">${esc(state.error || "Loading your documents…")}</p></section>`;
    const owner = isOwner();
    const canUpload = owner && k.canUpload && state.merchant.status !== "SUSPENDED" && state.merchant.status !== "REJECTED";
    const badge = { NOT_SUBMITTED: ["amber", "Not submitted"], PENDING: ["blue", "Under review"], APPROVED: ["green", "Verified"], REJECTED: ["red", "Needs changes"] }[k.status] || ["grey", k.status];
    const rows = k.policy.documentTypes
      .map(t => {
        const d = k.documents.find(x => x.type === t.type);
        const status = d ? `<span class="dfv-badge green">${I.check} Uploaded</span>` : t.required ? `<span class="dfv-badge amber">Required</span>` : `<span class="dfv-badge grey">Optional</span>`;
        const busy = state.busy === t.type;
        return `<div class="dfv-doc${d ? " ok" : ""}" data-dfv-doc="${esc(t.type)}"><span class="dfv-doc-icon">${d ? I.check : I.file}</span><div class="dfv-doc-body"><strong>${esc(t.label)}</strong>${t.required ? "" : " <small style=\"display:inline\">(optional)</small>"}<small>${d ? `${esc(d.filename)} · uploaded ${esc(dateOnly(d.uploadedAt))}` : "Not uploaded yet"}</small></div><div class="dfv-doc-actions">${status}${
          canUpload ? `<label class="button button-sm${busy ? " is-busy" : ""}" style="cursor:pointer">${busy ? "Uploading…" : d ? "Replace" : "Upload"}<input type="file" hidden accept="image/png,image/jpeg,image/webp,application/pdf" data-file-ui="off" data-dfv-upload="${esc(t.type)}"${busy ? " disabled" : ""}></label>` : ""
        }${d && owner ? `<button type="button" class="button button-sm" data-dfv-view="${esc(d.id)}">View</button>` : ""}</div></div>`;
      })
      .join("");
    const submit =
      owner && k.canSubmit && canUpload
        ? `<div class="dfv-submit"><p>All required documents are uploaded. Submit them so Delivery Fast can verify your business.</p><button type="button" class="button button-primary" data-dfv-submit${state.busy === "submit" ? " disabled" : ""}>${state.busy === "submit" ? "Submitting…" : "Submit for review"}</button></div>`
        : k.status === "NOT_SUBMITTED" && k.missing.length && canUpload
          ? `<div class="dfv-submit"><p>Upload ${k.missing.length === 1 ? "the last required document" : `the ${k.missing.length} required documents`} to submit for review.</p><button type="button" class="button button-primary" disabled>Submit for review</button></div>`
          : "";
    return `<section class="dfv-card" id="dfvDocuments"><div class="dfv-card-head"><div><h2>Business verification</h2><p>Documents that prove your business. Only Delivery Fast reviewers can see them.</p></div><span class="dfv-badge ${badge[0]}" id="dfvKycStatus">${esc(badge[1])}</span></div>
      ${k.status === "REJECTED" && k.rejectionReason ? `<div class="dfv-alert red">${I.alert}<span><b>Not approved:</b> ${esc(k.rejectionReason)}. Replace the documents and submit again.</span></div>` : ""}
      ${k.status === "PENDING" ? `<div class="dfv-alert blue">${I.clock}<span>Submitted ${esc(dateTime(k.submittedAt))}. Your documents are being reviewed.</span></div>` : ""}
      <div class="dfv-docs">${rows}</div>${submit}
      <p class="dfv-note">PNG, JPEG, WebP or PDF, up to ${MAX_MB} MB each.${owner ? "" : " Only the account owner can upload documents."}</p></section>`;
  }

  function messagesCard() {
    const r = state.review;
    if (!r || (!r.messages.length && !r.canRespond)) return "";
    const thread = r.messages
      .map(x => `<div class="dfv-msg${x.kind === "APPLICANT_RESPONSE" ? " mine" : ""}"><small>${esc(x.kind === "APPLICANT_RESPONSE" ? "You" : x.author || "Delivery Fast")} · ${esc(dateTime(x.at))}</small>${esc(x.body)}</div>`)
      .join("");
    const reply =
      r.canRespond && isOwner()
        ? `<form class="dfv-reply" id="dfvReplyForm"><label for="dfvReply" style="font-size:13px;font-weight:600">Your reply</label><textarea id="dfvReply" maxlength="2000" placeholder="Answer the question or explain what you uploaded"></textarea><div class="dfv-reply-actions"><button type="submit" class="button button-primary"${state.busy === "reply" ? " disabled" : ""}>${state.busy === "reply" ? "Sending…" : "Send reply"}</button></div></form>`
        : "";
    return `<section class="dfv-card" id="dfvMessages"><div class="dfv-card-head"><div><h2>Messages from Delivery Fast</h2><p>About your application.</p></div>${r.canRespond ? `<span class="dfv-badge amber">Reply needed</span>` : ""}</div><div class="dfv-thread">${thread || `<p class="dfv-muted">No messages yet.</p>`}</div>${reply}</section>`;
  }

  function profileCard() {
    const m = state.merchant;
    const A = window.DFMerchantAddress;
    const place = p => (p ? (A?.placeText ? A.placeText(p) : [p.street, p.area, p.zone, p.district].filter(Boolean).join(", ")) : "");
    const banking = m.type === "BANKING_FINANCIAL";
    const rows = [
      [banking ? "Institution name" : "Business name", m.name],
      ["Merchant ID", m.code],
      ["Account type", banking ? "Banking & Financial merchant" : "E-commerce merchant"],
      ["Business category", m.businessCategory],
      ["Contact person", m.contactName],
      ["Phone", phone(m.contactPhone)],
      ["Email", m.contactEmail],
      ["Website", m.websiteUrl],
      ["Business address", place(m.business), true],
      ["Pickup address", m.pickupSameAsBusiness ? "Same as the business address" : place(m.pickup), true],
      ["Pickup contact", [m.pickupContactName, phone(m.pickupContactPhone)].filter(Boolean).join(" · ")],
      ["Pickup time", A?.TIMES?.[m.pickupTime] || m.pickupTime],
      ["Parcel handover", A?.HANDOVER?.[m.handover] || m.handover],
      ["Serving hub", m.pickupHub ? `${m.pickupHub.name} (${m.pickupHub.code})` : ""],
    ].filter(([, v]) => v);
    return `<section class="dfv-card" id="dfvProfile"><div class="dfv-card-head"><div><h2>Business profile</h2><p>${m.status === "INFO_REQUESTED" ? "Something to correct? Say so in your reply above and Delivery Fast will update it." : m.status === "SUSPENDED" ? "Your business details on file. They can't be changed while the account is suspended." : "Shown as submitted in your application. It can't be changed until your account is verified."}</p></div><span class="dfv-readonly">${I.lock} Read-only</span></div>
      <dl class="dfv-profile">${rows.map(([k, v, full]) => `<div${full ? ' class="full"' : ""}><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl></section>`;
  }

  function draw() {
    const main = $("mainContent");
    if (!main || $("breadcrumbPage")?.textContent !== PAGE) return;
    const heading = `<div class="page-heading"><div><p class="eyebrow">Merchant account</p><h1>${PAGE}</h1><p class="subtitle">${state.merchant ? `${esc(state.merchant.name)} · ${esc(state.merchant.code)}` : "Your merchant account"}</p></div><div class="heading-actions"><button type="button" class="button" data-dfv-signout>Sign out</button></div></div>`;
    if (!state.merchant) {
      main.innerHTML = `<div class="dfv">${heading}<section class="dfv-card"><p class="dfv-muted">${esc(state.error || "Loading your account…")}</p>${state.error ? `<button type="button" class="button" data-dfv-retry style="margin-top:10px">Try again</button>` : ""}</section></div>`;
      return;
    }
    const h = headline();
    const showDocs = state.merchant.status !== "SUSPENDED";
    main.innerHTML = `<div class="dfv" id="dfvPage">${heading}
      <section class="dfv-hero ${h.tone}" id="dfvStatus" role="status"><span class="dfv-hero-icon">${h.icon}</span><div style="min-width:0"><div style="margin-bottom:8px"><span class="dfv-badge ${h.badge[0]}" id="dfvBadge">${h.badge[0] === "red" ? I.lock : I.alert} ${esc(h.badge[1])}</span></div><h2>${esc(h.title)}</h2><p>${esc(h.text)}</p><p class="dfv-meta">${state.merchant.status === "SUSPENDED" ? "While the account is suspended you can't book parcels, see shipments or use payments." : "Until your account is verified you can't book parcels, see shipments or use payments."}</p></div></section>
      ${state.merchant.status === "SUSPENDED" ? "" : `<section class="dfv-card" aria-label="Steps"><div class="dfv-card-head" style="margin-bottom:12px"><div><h2>Steps to activation</h2></div></div>${steps()}</section>`}
      ${messagesCard()}
      ${showDocs ? documentsCard() : ""}
      ${profileCard()}
    </div>`;
  }

  // ───────────── data and actions ─────────────

  async function load() {
    state.loading = true;
    try {
      const [merchant, kyc, review] = await Promise.all([
        DF.api(`/merchants/me${q()}`),
        DF.api(`/merchants/me/kyc${q()}`).catch(() => null),
        DF.api(`/merchants/me/review${q()}`).catch(() => null),
      ]);
      state.merchant = merchant;
      state.kyc = kyc;
      state.review = review;
      state.error = "";
      if (merchant.status === "ACTIVE") {
        // Approved while the screen was open: the full panel.
        toast("Your merchant account is verified. Opening your panel…");
        setTimeout(() => location.reload(), 1000);
      }
    } catch (error) {
      state.error = DF.describe(error);
    } finally {
      state.loading = false;
    }
    draw();
  }

  function upload(input) {
    const type = input.dataset.dfvUpload;
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > MAX_MB * 1024 * 1024) return toast(`That file is larger than ${MAX_MB} MB. Use a smaller scan or photo.`);
    if (!/^(image\/(png|jpeg|webp)|application\/pdf)$/.test(file.type)) return toast("Use a PNG, JPEG, WebP or PDF file.");
    const reader = new FileReader();
    reader.onload = async () => {
      state.busy = type;
      draw();
      try {
        state.kyc = await DF.api(`/merchants/me/kyc/documents${q()}`, { method: "POST", body: { type, filename: file.name.slice(0, 120), file: reader.result } });
        toast(`${file.name} uploaded.`);
      } catch (error) {
        fail(error);
      } finally {
        state.busy = "";
      }
      draw();
    };
    reader.onerror = () => toast("The file couldn't be read.");
    reader.readAsDataURL(file);
  }

  async function submit() {
    state.busy = "submit";
    draw();
    try {
      await DF.api(`/merchants/me/kyc/submit${q()}`, { method: "POST" });
      toast("Thanks — your documents are with Delivery Fast for review.");
    } catch (error) {
      fail(error);
    } finally {
      state.busy = "";
    }
    await load();
  }

  async function view(id) {
    const tab = window.open("", "_blank");
    try {
      const doc = await DF.api(`/merchants/me/kyc/documents/${encodeURIComponent(id)}${q()}`);
      if (!tab) return toast("Allow pop-ups to view the document.");
      tab.document.title = doc.filename || "Document";
      tab.document.body.style.margin = "0";
      tab.document.body.innerHTML = /^data:application\/pdf/.test(doc.dataUrl) ? `<iframe src="${doc.dataUrl}" style="border:0;width:100vw;height:100vh"></iframe>` : `<img src="${doc.dataUrl}" alt="" style="max-width:100%;display:block;margin:auto">`;
    } catch (error) {
      tab?.close();
      fail(error);
    }
  }

  async function reply(form) {
    const message = form.querySelector("#dfvReply")?.value.trim() || "";
    if (message.length < 2) return toast("Write your reply first.");
    state.busy = "reply";
    draw();
    try {
      await DF.api(`/merchants/me/review/respond${q()}`, { method: "POST", body: { message } });
      toast("Thanks — your application is back with Delivery Fast.");
    } catch (error) {
      fail(error);
    } finally {
      state.busy = "";
    }
    await load();
  }

  function showPage() {
    const crumb = $("breadcrumbPage");
    if (crumb) crumb.textContent = PAGE;
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
      if ((el = t.closest("[data-dfv-view]"))) return void view(el.dataset.dfvView);
      if (t.closest("[data-dfv-submit]")) return void submit();
      if (t.closest("[data-dfv-retry]")) return void load();
      if (t.closest("[data-dfv-signout]")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return void DF.confirm({ title: "Sign out?", message: "You can sign in again at any time to follow your verification.", confirm: "Sign out" }).then(ok => ok && DF.auth.logout().then(() => (location.href = "/login")));
      }
    },
    true,
  );
  document.addEventListener("change", event => {
    const input = event.target instanceof HTMLInputElement && event.target.matches("[data-dfv-upload]") ? event.target : null;
    if (input) upload(input);
  });
  document.addEventListener(
    "submit",
    event => {
      if (event.target?.id !== "dfvReplyForm") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void reply(event.target);
    },
    true,
  );

  window.DFMerchantVerification = { PAGE, reload: load };
})();
