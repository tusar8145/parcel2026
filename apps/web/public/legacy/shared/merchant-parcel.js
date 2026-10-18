/*
 * Merchant panels (both): the top search and the parcel side drawer, like Courier Operations'
 * (courier-operation/bridge-parcel.js), on the merchant's own parcels only.
 *
 *   Top search     #globalSearch: tracking ID, CN (pre-printed CNs are the tracking ID), merchant order ref,
 *                  recipient phone (+880 1712-345678 / 01712… / 1712…) or recipient name, typed or scanned,
 *                  then Enter. One exact match opens the drawer; several show a short list to pick from.
 *                  GET /parcels/:id, then GET /parcels?q= (merchant-scoped on the server; another merchant's
 *                  parcel is never found). Nothing found: the page-name shortcut the original search had.
 *                  "/" focuses it.
 *   Parcel drawer  DFMerchantParcel.open(trackingId) (also from the Orders / Shipments rows: "Details" or a
 *                  click on the row). Loads GET /parcels/:id — the merchant view: public tracking events only,
 *                  no staff notes, staff names, attempt riders, rider phone (except the package's "Share rider
 *                  phone" on the delivery day, liveDelivery.rider.phone) or return internals. Sections: actions,
 *                  failed delivery note, live rider location (package rule), "Where is it now" (map, GET
 *                  /parcels/:id/position, shared/parcel-map.js), recipient & address, shipment,
 *                  price breakdown, Hub Pickup, return, proof of delivery (GET /parcels/:id/proof), messages
 *                  (service.messages: names only), support, status timeline. Esc closes.
 *   Actions        the panel's existing ones: Cancel ([data-df-cancel], merchant-bridge.js), Request return /
 *                  Confirm return received ([data-dff-return-request] / [data-dff-return-received],
 *                  merchant-features.js), Complete details ([data-df-complete]), Print label (PDF)
 *                  ([data-df-label]), Download invoice (PDF) (DFPrint.invoices), Open a ticket (DFSupport).
 *   For other code DFMerchantParcel.open(id) · .close() · .search(text) · .id; window event "dfm:parcel"
 *                  { trackingId | null } when the drawer opens / closes (e.g. to keep ?parcel= in the URL).
 *                  ?parcel=<trackingId> in the address opens the drawer once the panel has loaded.
 */
(() => {
  const DF = window.DF;
  const P = () => window.DFMerchantPanel;
  if (!DF || !P()) return;
  const S = () => P().state;
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const toast = message => window.showToast(message);
  const taka = n => `৳ ${(Math.round(Number(n || 0) * 100) / 100).toLocaleString("en-BD")}`;
  const when = iso => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
  const day = iso => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "");
  /** +8801712345678 → +880 1712-345678 */
  const phone = p => {
    const m = String(p || "").match(/^\+880(\d{4})(\d{6})$/);
    return m ? `+880 ${m[1]}-${m[2]}` : p || "";
  };
  const pill = text => (typeof statusPill === "function" ? statusPill(text) : `<span class="status">${esc(text)}</span>`); // eslint-disable-line no-undef -- the page's helper (01.js)

  const TERMINAL = ["DELIVERED", "PICKUP_CANCELLED", "RETURNED"];
  const EDITABLE_INCOMPLETE = ["PENDING_CONFIRMATION", "PICKUP_ASSIGNED", "PICKUP_CONFIRMED"];
  const RETURNABLE = ["PICKED_UP", "AT_HUB", "IN_TRANSIT", "ASSIGNED", "OUT_FOR_DELIVERY", "RETRY_SCHEDULED", "EXCEPTION"];
  const TYPE_LABEL = { ECOMMERCE: "E-commerce parcel", DOCUMENT: "Document", PARCEL: "Parcel", FRAGILE: "Fragile parcel" };
  const PROOF_METHOD = { OTP: "Recipient code", SIGNATURE: "Signature", PHOTO: "Photo" };
  const TRACKING_ID = /^[A-Z]{2,4}-?\d{6}-?[0-9A-Z]{4,8}$/;

  // ───────────── styles (the panel's colours and components) ─────────────

  document.head.insertAdjacentHTML(
    "beforeend",
    `<style id="dfmParcelStyles">
.dfm-drawer{position:fixed;z-index:45;top:0;right:0;bottom:0;width:min(460px,100vw);box-sizing:border-box;display:flex;flex-direction:column;background:#fff;border-left:1px solid var(--line);box-shadow:-18px 0 45px #1720331f}
.dfm-drawer[hidden]{display:none}
.dfm-drawer header{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:18px 20px 14px;border-bottom:1px solid var(--line)}
.dfm-drawer h2{margin:0;font-size:17px;color:var(--ink);overflow-wrap:anywhere}
.dfm-sub{display:flex;flex-wrap:wrap;gap:5px;margin:7px 0 0}
.dfm-body{flex:1;overflow:auto;overflow-x:hidden;padding:14px 20px 24px;display:grid;gap:16px;align-content:start}
.dfm-body section h3{margin:0 0 8px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#98a2ae}
.dfm-kv{display:grid;grid-template-columns:130px minmax(0,1fr);gap:6px 12px;margin:0;font-size:13px}
.dfm-kv dt{color:#98a2ae}.dfm-kv dd{margin:0;color:#455265;overflow-wrap:anywhere}
.dfm-actions{display:flex;gap:6px;flex-wrap:wrap}
.dfm-note{margin:0;padding:9px 11px;border-radius:8px;font-size:13px}
.dfm-note.bad{background:var(--red-soft);color:var(--red)}
.dfm-note.warn{background:var(--amber-soft,#fff7e6);color:var(--amber,#9a6700)}
.dfm-note.live{background:var(--green-soft,#ecfdf3);color:var(--green,#05603a)}
.dfm-matches{display:grid;gap:6px}
.dfm-matches .button{justify-content:space-between;text-align:left;gap:10px}
.dfm-matches .button span:last-child{font-weight:500;color:#778293;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dfm-list{margin:0;padding-left:18px;color:#455265;font-size:13px;line-height:1.7}
.dfm-muted{margin:0;color:#8792a2;font-size:13px}
#tableBody tr[data-dfm-row]{cursor:pointer}
@media(max-width:480px){.dfm-kv{grid-template-columns:105px minmax(0,1fr)}.dfm-body{padding:12px 16px 22px}.dfm-drawer header{padding:14px 16px 12px}}
</style>`,
  );

  // ───────────── state ─────────────

  const D = { id: null, parcel: null, matches: [], query: "", loading: false, error: "", proof: new Map(), opener: null, seq: 0 };
  const ownMerchant = p => !S().merchant || !p.merchant || p.merchant.id === S().merchant.id;

  function ensureDrawer() {
    let el = $("merchantParcelDrawer");
    if (el) return el;
    document.body.insertAdjacentHTML(
      "beforeend",
      `<aside id="merchantParcelDrawer" class="dfm-drawer" role="dialog" aria-modal="false" aria-labelledby="merchantParcelTitle" hidden><header><div style="min-width:0"><h2 id="merchantParcelTitle">Parcel</h2><div class="dfm-sub" id="merchantParcelSub"></div></div><button type="button" class="button" id="merchantParcelClose" aria-label="Close parcel details">×</button></header><div class="dfm-body" id="merchantParcelBody"></div></aside>`,
    );
    el = $("merchantParcelDrawer");
    $("merchantParcelClose").addEventListener("click", () => close());
    return el;
  }

  const kv = rows =>
    `<dl class="dfm-kv">${rows
      .filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`)
      .join("")}</dl>`;

  // ───────────── sections ─────────────

  function actionsMarkup(p) {
    const id = esc(p.trackingId);
    const doc = p.type === "DOCUMENT";
    const info = p.returnInfo;
    const buttons = [];
    if (p.incomplete && EDITABLE_INCOMPLETE.includes(p.status)) buttons.push(`<button type="button" class="button button-sm button-primary" data-df-complete="${id}">Complete details</button>`);
    if (p.canCancel) buttons.push(`<button type="button" class="button button-sm" data-df-cancel="${id}">${doc ? "Cancel request" : "Cancel order"}</button>`);
    if (RETURNABLE.includes(p.status) && !info?.requestedAt) buttons.push(`<button type="button" class="button button-sm" data-dff-return-request="${id}">Request return</button>`);
    if (p.status === "RETURNED" && !info?.receivedAt) buttons.push(`<button type="button" class="button button-sm button-primary" data-dff-return-received="${id}">Confirm return received</button>`);
    if (p.status !== "PICKUP_CANCELLED") {
      buttons.push(`<button type="button" class="button button-sm" data-df-label="${id}">Print label (PDF)</button>`);
      buttons.push(`<button type="button" class="button button-sm" data-dfm-invoice="${id}">Download invoice (PDF)</button>`);
    }
    return `<section id="merchantParcelActions"><h3>Actions</h3><div class="dfm-actions">${buttons.join("")}</div></section>`;
  }

  /** "Delivery failed ×2, back at Gulshan Hub · Last reason: …" (no rider names or attempt list). */
  function failureMarkup(p) {
    if (!(p.failedAttempts > 0) || ["DELIVERED", "PICKUP_CANCELLED"].includes(p.status)) return "";
    const last = p.lastFailedAttempt;
    const where = p.returnedAfterFailure ? `, back at ${p.currentHub?.name || "the hub"}` : p.status === "RETRY_SCHEDULED" ? ", another attempt is scheduled" : "";
    return `<p class="dfm-note bad" data-dfm-failure="${p.failedAttempts}">${esc(`Delivery failed ×${p.failedAttempts}${where}${last?.reason ? ` · Last reason: ${last.reason}${last.at ? ` (${when(last.at)})` : ""}` : ""}`)}</p>`;
  }

  /** Out for delivery with the package's "Live rider location" (and "Share rider phone" on the delivery day). */
  function liveMarkup(p) {
    const live = p.liveDelivery;
    if (!live || p.status !== "OUT_FOR_DELIVERY") return "";
    const name = live.rider?.name || "The rider";
    const loc = live.location;
    const mins = loc ? Math.floor((loc.ageSeconds || 0) / 60) : 0;
    const text = !live.locationStatus
      ? `${name} is out for delivery`
      : loc
        ? `${name} · updated ${mins < 1 ? "just now" : `${mins} min ago`}`
        : live.locationStatus === "STALE"
          ? `${name} · location not updated for over ${live.staleAfterMinutes || 15} minutes`
          : live.locationStatus === "OFF_SHIFT"
            ? `${name} · not sharing a location right now`
            : `${name} · waiting for the rider's location`;
    const map = loc ? ` <a data-dfm-live-map href="https://www.openstreetmap.org/?mlat=${loc.lat}&mlon=${loc.lng}#map=16/${loc.lat}/${loc.lng}" target="_blank" rel="noopener" style="font-weight:600">Open map ↗</a>` : "";
    const call = live.rider?.phone ? `<div style="margin-top:4px">Rider phone (today): <a href="tel:${esc(live.rider.phone)}" data-dfm-rider-phone>${esc(phone(live.rider.phone))}</a></div>` : "";
    return `<section><h3>Live rider location</h3><div class="dfm-note live" data-dfm-live="${esc(live.locationStatus || "PHONE")}"><strong>${esc(text)}</strong>${map}${call}</div></section>`;
  }

  /**
   * "Where is it now": GET /parcels/:id/position on a small map (shared/parcel-map.js). Merchant rules on the
   * server: the rider only out for delivery with "Live rider location" (fresh fix); otherwise the hub (city
   * level); the vehicle's position while the parcel travels between hubs on a trip that shares it.
   */
  function positionMarkup(p) {
    if (!window.DFParcelMap || p.status === "PICKUP_CANCELLED") return "";
    return `<section id="merchantParcelPosition"><h3>Where is it now</h3>${window.DFParcelMap.slot("merchant")}</section>`;
  }

  function recipientMarkup(p) {
    return `<section><h3>Recipient</h3>${kv([
      ["Name", esc(p.recipient?.name || "Not set yet")],
      ["Phone", esc(phone(p.recipient?.phone) || "Not set yet")],
      ["Deliver to", esc(p.delivery?.label || "")],
      ["Relationship", esc(p.receiverRelation || "")],
      ["Instructions", esc(p.instructions || "")],
    ])}</section>`;
  }

  function shipmentMarkup(p) {
    const doc = p.type === "DOCUMENT";
    const sv = p.service;
    const firstMile = sv?.firstMileLabel || (p.intake === "DROP_OFF" ? "Drop at hub" : "Rider pickup");
    return `<section><h3>Shipment</h3>${kv([
      ["Order ref", esc(p.merchantOrderRef || "")],
      [doc ? "Document" : "Product", esc(p.product || p.contents || TYPE_LABEL[p.type] || "")],
      ["Type", esc(TYPE_LABEL[p.type] || p.type || "")],
      ["Weight", !doc && p.weightKg != null ? esc(`${p.weightKg} kg`) : ""],
      ["Packaging", esc(p.packaging || "")],
      ["Service", esc(sv?.speedLabel || p.serviceLevelLabel || "")],
      ["First mile", esc(p.intake === "DROP_OFF" && p.dropOffHub ? `${firstMile} · ${p.dropOffHub.name}` : firstMile)],
      ["Last mile", esc(sv?.lastMileLabel || (p.collect ? "Hub Pickup" : "Home delivery"))],
      ["Open box", p.openBox ? "Allowed" : ""],
      [doc ? "Value" : "COD", doc ? "" : Number(p.codAmount) ? esc(`${taka(p.codAmount)}${p.cod ? ` · ${p.cod.state === "SETTLED" ? "paid to you" : "collected"}` : ""}`) : "No cash to collect"],
      ["Product value", Number(p.declaredValue) ? esc(taka(p.declaredValue)) : ""],
      ["Pickup window", esc(p.pickupWindow?.label || "")],
      ["Current hub", esc(p.currentHub?.name || "")],
      ["Booked", esc(when(p.createdAt))],
      [p.deliveredAt ? "Delivered" : "Estimated delivery", esc(when(p.deliveredAt || p.estimatedDeliveryAt))],
      ["Cancellation reason", esc(p.cancelReason || "")],
    ])}</section>`;
  }

  /** The merchant's charges: the price lines frozen at booking, else the charge fields. */
  function priceMarkup(p) {
    const c = p.charges || {};
    const lines = c.lines?.length
      ? c.lines
      : [
          ["Base charge", c.base],
          ["Weight", c.weight],
          ["Service", c.service],
          ["COD fee", c.codFee],
          ["Re-attempt", c.reattempt],
          ["Discount", c.discount ? -Math.abs(c.discount) : 0],
        ]
          .filter(([, amount]) => Number(amount))
          .map(([label, amount]) => ({ label, amount: Number(amount) }));
    if (Number(c.reattempt) && c.lines?.length && !lines.some(l => /re-?attempt/i.test(l.label))) lines.push({ label: "Re-attempt", amount: Number(c.reattempt) });
    const breakdown = window.DFOrderServices?.breakdown
      ? window.DFOrderServices.breakdown({ lines, totalCharge: c.total })
      : `${lines.map(l => `<div>${esc(l.label)} · ${esc(taka(l.amount))}</div>`).join("")}<strong>${esc(taka(c.total))}</strong>`;
    return `<section><h3>Price</h3><div style="font-size:13px" data-dfm-price>${breakdown}</div></section>`;
  }

  function collectMarkup(p) {
    const c = p.collect;
    if (!c) return "";
    return `<section><h3>Hub Pickup</h3>${kv([
      ["Collect at", esc(c.hub?.name || "The hub serving the recipient's zone")],
      ["Address", esc(c.hub?.address || "")],
      ["Ready since", esc(when(c.readyAt))],
      ["Collect by", esc(day(c.dueAt))],
      ["Status", p.status === "READY_FOR_COLLECTION" ? "Waiting for the recipient" : p.status === "DELIVERED" ? "Collected" : ""],
    ])}</section>`;
  }

  function returnMarkup(p) {
    const r = p.returnInfo;
    if (!r && !["RETURN_SCHEDULED", "RETURNED"].includes(p.status)) return "";
    const stage = r?.receivedAt ? "Received by you" : p.status === "RETURNED" ? "Returned · confirm you received it" : p.status === "RETURN_SCHEDULED" ? (r?.onReturnRun ? "On a return run" : "Return scheduled") : "Return requested";
    return `<section><h3>Return</h3>${kv([
      ["Status", pill(stage)],
      ["Reason", esc(r?.reason || "")],
      ["Requested", esc(when(r?.requestedAt))],
      ["Return charge", r?.charge != null ? esc(taka(r.charge)) : ""],
      ["Received", esc(when(r?.receivedAt))],
    ])}</section>`;
  }

  function proofMarkup(p) {
    if (!p.proof) return p.status === "DELIVERED" ? `<section><h3>Proof of delivery</h3><p class="dfm-muted">No proof of delivery recorded.</p></section>` : "";
    const full = D.proof.get(p.trackingId);
    if (full === undefined) void loadProof(p.trackingId);
    const rows = [
      ["Method", esc(PROOF_METHOD[p.proof.method] || p.proof.method)],
      ["Received by", esc(p.proof.receivedBy || p.recipient?.name || "")],
      ["Recorded", esc(when(full?.capturedAt || p.proof.recordedAt))],
    ];
    if (full?.location) rows.push(["Location", `<a href="https://www.openstreetmap.org/?mlat=${full.location.lat}&mlon=${full.location.lng}#map=17/${full.location.lat}/${full.location.lng}" target="_blank" rel="noopener">Open map ↗</a>`]);
    const image = full?.dataUrl ? `<img src="${esc(full.dataUrl)}" alt="Proof of delivery (${esc(PROOF_METHOD[p.proof.method] || "")})" data-dfm-proof-image style="display:block;max-width:100%;max-height:220px;margin-top:8px;border-radius:8px;border:1px solid var(--line)">` : "";
    return `<section id="merchantParcelProof"><h3>Proof of delivery</h3>${kv(rows)}${image}</section>`;
  }
  async function loadProof(id) {
    D.proof.set(id, null);
    try {
      const proof = await DF.api(`/parcels/${encodeURIComponent(id)}/proof`);
      // Only what the drawer shows: no rider and no rider note.
      const kept = { capturedAt: proof.capturedAt, location: proof.location, dataUrl: "" };
      if (proof.image?.url) {
        const file = await DF.api(proof.image.url.replace(/^\/api\/v1/, ""), { headers: { accept: "application/json" } }).catch(() => null);
        if (file?.dataUrl && /^data:image\//.test(file.dataUrl)) kept.dataUrl = file.dataUrl;
      }
      D.proof.set(id, kept);
    } catch {
      D.proof.set(id, {});
    }
    if (D.id === id) paint();
  }

  /** The messages the parcel was set to send, by name (the stored per-parcel list). */
  function messagesMarkup(p) {
    const sv = p.service;
    const body = !sv
      ? `<p class="dfm-muted">Booked before service packages: the account's standard delivery messages.</p>`
      : sv.messages?.length
        ? `<ul class="dfm-list" data-dfm-messages>${sv.messages.map(m => `<li>${esc(m)}</li>`).join("")}</ul>`
        : `<p class="dfm-muted" data-dfm-messages-none>No SMS or email messages for this parcel.</p>`;
    return `<section><h3>Messages set to send</h3>${body}</section>`;
  }

  function timelineMarkup(p) {
    // The merchant view carries public events only; internal ones are dropped here too.
    const events = (p.events || []).filter(e => !e.internal).reverse();
    if (!events.length) return `<section><h3>Status timeline</h3><p class="dfm-muted">No tracking events yet.</p></section>`;
    return `<section id="merchantParcelTimeline"><h3>Status timeline</h3><ol style="list-style:none;margin:0;padding:0">${events
      .map(
        (e, i) =>
          `<li style="position:relative;margin-left:8px;padding:0 0 16px 22px;border-left:${i === events.length - 1 ? "0" : "1px solid #dfe5ee"}"><span style="position:absolute;left:-6px;top:2px;width:11px;height:11px;border-radius:50%;background:${i === 0 ? "var(--blue)" : "#cbd5e1"}"></span><strong style="font-size:13px">${esc(e.title)}</strong>${e.description || e.location ? `<div style="margin-top:3px;color:#647184;font-size:13px">${esc([e.description, e.location].filter(Boolean).join(" · "))}</div>` : ""}<small style="display:block;margin-top:3px;color:#99a3af">${esc(when(e.at))}</small></li>`,
      )
      .join("")}</ol></section>`;
  }

  function matchesMarkup() {
    if (D.matches.length < 2) return "";
    return `<section id="merchantParcelMatches"><h3>${esc(`${D.matches.length} parcels match “${D.query}”`)}</h3><div class="dfm-matches">${D.matches
      .map(
        m =>
          `<button type="button" class="button button-sm${m.trackingId === D.id ? " button-primary" : ""}" data-dfm-open="${esc(m.trackingId)}" data-dfm-keep><span>${esc(m.trackingId)}</span><span>${esc([m.recipient?.name || "—", m.merchantOrderRef, m.statusLabel].filter(Boolean).join(" · "))}</span></button>`,
      )
      .join("")}</div>${D.matches.length >= 20 ? `<p class="dfm-muted" style="margin-top:6px">Showing the first 20. Type more of the number or reference to narrow it down.</p>` : ""}</section>`;
  }

  function paint() {
    const el = ensureDrawer();
    const p = D.parcel;
    const body = $("merchantParcelBody");
    const scroll = body.scrollTop;
    if (!p) {
      $("merchantParcelTitle").textContent = D.id || (D.matches.length ? "Search results" : "Parcel");
      $("merchantParcelSub").innerHTML = "";
      body.innerHTML = `${matchesMarkup()}${D.loading ? `<p class="dfm-muted">Loading…</p>` : D.error ? `<p class="dfm-note bad">${esc(D.error)}</p>` : D.matches.length ? `<p class="dfm-muted">Choose a parcel to see its details.</p>` : ""}`;
    } else {
      $("merchantParcelTitle").textContent = p.trackingId;
      const failed = p.failedAttempts > 0 && !["DELIVERED", "PICKUP_CANCELLED"].includes(p.status) ? `<span class="status status-failed">${esc(`Failed ×${p.failedAttempts}`)}</span>` : "";
      $("merchantParcelSub").innerHTML = `${pill(p.statusLabel)}${p.incomplete ? `<span class="status status-pending">Needs info</span>` : ""}${failed}`;
      const needs = p.incomplete ? `<p class="dfm-note warn" data-dfm-needs>${esc(`Needs info: missing ${(p.missingLabels || []).join(", ")}. It won't go out for delivery until the recipient's name, phone, address and destination are filled in.`)}</p>` : "";
      body.innerHTML = `${matchesMarkup()}${actionsMarkup(p)}${needs}${failureMarkup(p)}${liveMarkup(p)}${positionMarkup(p)}${recipientMarkup(p)}${shipmentMarkup(p)}${priceMarkup(p)}${collectMarkup(p)}${returnMarkup(p)}${proofMarkup(p)}${messagesMarkup(p)}
        <section><h3>Support</h3><button type="button" class="button button-sm" data-dfm-ticket="${esc(p.trackingId)}">Open a ticket about this parcel</button></section>${timelineMarkup(p)}`;
      // The position map (shared/parcel-map.js) is kept across repaints; the server applies the merchant rules.
      if (window.DFParcelMap && p.status !== "PICKUP_CANCELLED") window.DFParcelMap.attach("merchant", p.trackingId, { status: `${p.status}:${p.updatedAt || ""}`, force: D.freshPosition });
      D.freshPosition = false;
    }
    body.scrollTop = scroll;
    el.hidden = false;
  }

  // ───────────── open / close ─────────────

  /** Loads the parcel into the drawer: "ok", "missing" (not found / error) or "stale" (a newer load replaced it). */
  async function load(id) {
    const seq = ++D.seq;
    try {
      const p = await DF.api(`/parcels/${encodeURIComponent(id)}`);
      if (!ownMerchant(p)) throw Object.assign(new Error("Not found"), { status: 404 });
      if (seq !== D.seq || D.id !== id) return "stale";
      D.parcel = p;
      D.id = p.trackingId;
      D.error = "";
      return "ok";
    } catch (error) {
      if (seq !== D.seq) return "stale";
      // A failed refresh keeps what is shown; a first load shows the problem.
      if (D.parcel?.trackingId === id) return "ok";
      D.parcel = null;
      D.error = error?.status === 404 ? `No parcel ${id} in your account.` : DF.describe(error);
      return "missing";
    } finally {
      if (seq === D.seq) {
        D.loading = false;
        if (D.id) paint();
      }
    }
  }

  /** Opens the drawer on one of the merchant's parcels; resolves true when it was found. */
  async function open(trackingId, { matches, query } = {}) {
    const id = String(trackingId || "").trim().toUpperCase();
    if (!id) return false;
    if (matches) {
      D.matches = matches;
      D.query = query || D.query;
    } else if (!D.matches.some(m => m.trackingId === id)) D.matches = [];
    const same = D.id === id && D.parcel;
    D.freshPosition = true;
    if (!$("merchantParcelDrawer") || $("merchantParcelDrawer").hidden) D.opener = document.activeElement;
    D.id = id;
    if (!same) {
      D.parcel = null;
      D.loading = true;
    }
    paint();
    $("merchantParcelClose")?.focus({ preventScroll: true });
    window.dispatchEvent(new CustomEvent("dfm:parcel", { detail: { trackingId: id } }));
    const result = await load(id);
    if (result === "missing" && !D.matches.length && D.id === id) {
      // Not found: close again (a search result list would stay, showing the problem).
      toast(D.error || `No parcel ${id} in your account.`);
      close();
    }
    return result !== "missing";
  }

  /** Shows a list of search matches (no parcel open yet). */
  function showMatches(matches, query) {
    if (!$("merchantParcelDrawer") || $("merchantParcelDrawer").hidden) D.opener = document.activeElement;
    D.matches = matches;
    D.query = query;
    D.id = null;
    D.parcel = null;
    D.error = "";
    D.loading = false;
    paint();
    $("merchantParcelBody").querySelector("[data-dfm-open]")?.focus({ preventScroll: true });
  }

  function close() {
    const was = D.id || D.matches.length;
    D.id = null;
    D.parcel = null;
    D.matches = [];
    D.seq++;
    const el = $("merchantParcelDrawer");
    if (el) el.hidden = true;
    if (was) window.dispatchEvent(new CustomEvent("dfm:parcel", { detail: { trackingId: null } }));
    const back = D.opener;
    D.opener = null;
    if (back?.isConnected && typeof back.focus === "function") back.focus({ preventScroll: true });
  }

  /** Re-reads the open parcel (live updates and after actions). */
  function reload() {
    if (D.id && D.parcel) void load(D.id);
  }

  // ───────────── search ─────────────

  /** Tracking ID, CN, order ref, phone or name → the merchant's matching parcels (at most 20). */
  async function search(raw) {
    const text = String(raw || "").trim();
    if (!text) return [];
    const code = DF.scanner?.normalize ? DF.scanner.normalize(text) : text.toUpperCase();
    const upper = text.toUpperCase();
    const local = S().parcels.filter(p => p.trackingId === code || p.trackingId === upper || (p.merchantOrderRef && p.merchantOrderRef.toUpperCase() === upper));
    if (local.length === 1) return local;
    if (TRACKING_ID.test(code)) {
      try {
        const p = await DF.api(`/parcels/${encodeURIComponent(code)}`);
        if (ownMerchant(p)) return [p];
      } catch (error) {
        if (error?.status !== 404) throw error;
      }
    }
    const tel = DF.normalizePhone(text);
    const term = tel ? tel.slice(-10) : text;
    const page = await DF.api(`/parcels?limit=20&q=${encodeURIComponent(term)}${P().merchantQuery("&")}`);
    const items = page.items.filter(ownMerchant);
    // Exact tracking ID / order ref first: one exact match is the answer even when others contain the text.
    const exact = items.filter(p => p.trackingId === code || p.trackingId === upper || (p.merchantOrderRef && p.merchantOrderRef.toUpperCase() === upper));
    return exact.length === 1 ? exact : items;
  }

  /** The original search's page shortcut (e.g. "settings", "api"), when no parcel matched. */
  function pageShortcut(query) {
    if (/api|webhook/i.test(query)) return void window.renderPage("API & Webhooks");
    const match = typeof pageData !== "undefined" && Object.keys(pageData).find(page => page.toLowerCase().includes(query.toLowerCase())); // eslint-disable-line no-undef -- the page's data (01.js)
    if (match) window.renderPage(match);
    else toast(`No parcel found for “${query}” in your account.`);
  }

  async function runSearch(input) {
    const query = input.value.trim();
    if (!query) return;
    input.setAttribute("aria-busy", "true");
    try {
      const found = await search(query);
      if (!found.length) return pageShortcut(query);
      if (found.length === 1) await open(found[0].trackingId, { matches: [], query });
      else showMatches(found, query);
      input.select();
    } catch (error) {
      toast(DF.describe(error));
    } finally {
      input.removeAttribute("aria-busy");
    }
  }

  // ───────────── list rows: "Details" and a click on the row ─────────────

  function decorateRows() {
    if (!["Orders", "Shipments"].includes(S().page)) return;
    for (const row of document.querySelectorAll("#tableBody tr[data-merchant-record-id]:not([data-dfm-row])")) {
      row.dataset.dfmRow = "1";
      const id = row.dataset.merchantRecordId;
      const cell = row.querySelector("[data-merchant-history]")?.parentElement || row.lastElementChild;
      cell?.insertAdjacentHTML("afterbegin", `<button type="button" class="button button-sm" data-dfm-open="${esc(id)}" aria-label="Details for ${esc(id)}">Details</button> `);
    }
  }
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() =>
      queueMicrotask(() => {
        queued = false;
        decorateRows();
      }),
    );
  }).observe($("mainContent") || document.body, { childList: true, subtree: true });

  // ───────────── wiring ─────────────

  const search_ = $("globalSearch");
  if (search_) {
    search_.placeholder = "Tracking ID, order ref, phone…";
    search_.setAttribute("aria-label", "Find a parcel by tracking ID, CN, order reference, recipient phone or name");
    search_.setAttribute("autocomplete", "off");
    search_.setAttribute("enterkeyhint", "search");
  }

  window.addEventListener(
    "keydown",
    event => {
      if (event.target?.id === "globalSearch" && event.key === "Enter") {
        // Replaces the original search (page names only) and merchant-bridge.js's.
        event.preventDefault();
        event.stopImmediatePropagation();
        return void runSearch(event.target);
      }
      if (event.key === "Escape" && (D.id || D.matches.length)) {
        // Dialogs above the drawer close first.
        if ($("merchantHistoryBackdrop") || document.querySelector(".df-dialog") || document.querySelector(".modal-backdrop.open")) return;
        if ($("merchantParcelDrawer")?.hidden !== false) return;
        event.preventDefault();
        return void close();
      }
      if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const t = event.target;
        if (t instanceof Element && (t.closest("input, textarea, select, [contenteditable]") || t.isContentEditable)) return;
        const input = $("globalSearch");
        if (!input) return;
        event.preventDefault();
        input.focus();
        input.select();
      }
    },
    true,
  );

  window.addEventListener(
    "click",
    event => {
      const t = event.target;
      if (!(t instanceof Element)) return;
      let el = t.closest("[data-dfm-open]");
      if (el) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return void open(el.dataset.dfmOpen, el.hasAttribute("data-dfm-keep") ? {} : { matches: [] });
      }
      if ((el = t.closest("[data-dfm-invoice]"))) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return void window.DFPrint?.invoices([el.dataset.dfmInvoice], "a4");
      }
      if ((el = t.closest("[data-dfm-ticket]"))) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const id = el.dataset.dfmTicket;
        if (!window.DFSupport?.compose) return toast("Support is loading. Try again in a moment.");
        close();
        return void window.DFSupport.compose({ subject: `Help with ${id}`, category: "Delivery issue", relatedRef: id });
      }
      // A click on an Orders / Shipments row (not on its controls) opens the drawer.
      const row = t.closest("#tableBody tr[data-dfm-row]");
      if (row && !t.closest("button, a, input, select, textarea, label, summary, details")) {
        event.preventDefault();
        return void open(row.dataset.merchantRecordId, { matches: [] });
      }
    },
    true,
  );

  // Live: the open parcel follows changes (and the rider's position while out for delivery).
  DF.events?.on("parcel.updated", data => void (D.parcel && (!data?.id || data.id === D.id) && reload()));
  DF.events?.on("parcel.rider_location", data => void (D.parcel?.status === "OUT_FOR_DELIVERY" && (!data?.id || data.id === D.id) && reload()));
  DF.events?.on("reconnect", () => reload());
  setInterval(() => D.parcel?.status === "OUT_FOR_DELIVERY" && document.visibilityState === "visible" && reload(), 60_000);
  // A parcel travelling between hubs: the vehicle's position (when its trip shares it) every 2 minutes.
  setInterval(() => D.parcel?.status === "IN_TRANSIT" && document.visibilityState === "visible" && window.DFParcelMap?.refresh("merchant"), 120_000);
  // Actions report through the panel's toast ("PP-… cancelled", "Return requested for PP-…"): re-read then.
  const toastEl = $("toast");
  if (toastEl)
    new MutationObserver(() => {
      if (D.id && D.parcel && toastEl.textContent.includes(D.id)) setTimeout(reload, 300);
    }).observe(toastEl, { childList: true, characterData: true, subtree: true });

  window.DFMerchantParcel = {
    open: id => open(id, { matches: [] }),
    close,
    search,
    get id() {
      return D.id;
    },
  };

  // ?parcel=<trackingId> opens the drawer once the panel has its workspace.
  Promise.resolve(DF.bridgeReady)
    .catch(() => undefined)
    .then(() => {
      let wanted = null;
      try {
        wanted = new URLSearchParams(location.search).get("parcel");
      } catch {}
      if (wanted && S().merchant && D.id !== wanted.toUpperCase()) void open(wanted, { matches: [] });
    });
})();
