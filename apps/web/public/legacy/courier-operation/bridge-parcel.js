/*
 * Courier Operations: the parcel detail drawer, the "next action" per parcel and the global search.
 * UI only: every button calls an action the console already has (same API calls, permissions and
 * lifecycle rules).
 *
 *   Next action        Ops.nextAction(parcel) → the status-appropriate primary action:
 *                        Pending                → Accept & assign rider   (the assign dialog)
 *                        Awaiting drop-off      → Receive                 (Hub desk › Drop-off receive)
 *                        At hub                 → Assign rider (delivery), or Add to transfer when
 *                                                 another hub serves the delivery zone (Transfers)
 *                        Exception              → Resolve                 (the exception dialog)
 *                        Needs info             → Edit details            (completion form)
 *                        Ready for collection   → Hand over               (Hub desk › Hub Pickup counter)
 *                        Return scheduled       → Add to return run       (Returns › Return a parcel)
 *                      Shipment table rows show it first, then "Details" (the drawer), and the
 *                      row's other buttons under "More".
 *   Parcel drawer      Ops.drawer.open(trackingId): summary, actions, price breakdown, proof of
 *                      delivery (GET /parcels/:id/proof), staff notes and the tracking history,
 *                      beside the page (it stays open while you work).
 *   Global search      the top bar box: tracking ID, CN (pre-printed CNs are the tracking ID) or
 *                      phone, typed or scanned, then Enter → the drawer. Uses the working set, then
 *                      GET /parcels/:id and GET /parcels?q= (the existing search).
 */
(() => {
  const DF = window.DF;
  const Ops = window.DFOps;
  if (!DF || !Ops) return;
  const $ = id => document.getElementById(id);
  const esc = Ops.esc;
  const CLOSED = ["DELIVERED", "PICKUP_CANCELLED", "RETURNED"];
  const PICKUP_STAGE = ["PENDING_CONFIRMATION", "PICKUP_ASSIGNED", "PICKUP_CONFIRMED"];
  const INTAKE_CHANGEABLE = ["PENDING_CONFIRMATION", "PICKUP_ASSIGNED", "PICKUP_CONFIRMED"];

  // ───────────── styles (the console's own colours and components) ─────────────

  document.head.insertAdjacentHTML(
    "beforeend",
    `<style id="dfParcelStyles">
.df-more{position:relative;display:inline-block}
.df-more>summary{list-style:none;cursor:pointer}
.df-more>summary::-webkit-details-marker{display:none}
.df-more-menu{position:fixed;z-index:46;display:grid;gap:6px;min-width:200px;max-width:min(340px,calc(100vw - 24px));max-height:60vh;overflow:auto;padding:8px;border:1px solid var(--line);border-radius:8px;background:#fff;box-shadow:0 12px 30px #1720331f}
.df-more-menu>*{width:100%}
.df-more-menu .button{justify-content:flex-start}
.df-row-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.df-drawer{position:fixed;z-index:45;top:0;right:0;bottom:0;width:min(460px,100vw);display:flex;flex-direction:column;background:#fff;border-left:1px solid var(--line);box-shadow:-18px 0 45px #1720331f}
.df-drawer[hidden]{display:none}
.df-drawer header{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:18px 20px 14px;border-bottom:1px solid var(--line)}
.df-drawer h2{margin:0;font-size:17px;color:var(--ink)}
.df-drawer-body{flex:1;overflow:auto;padding:14px 20px 24px;display:grid;gap:16px;align-content:start}
.df-drawer section h3{margin:0 0 8px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#98a2ae}
.df-kv{display:grid;grid-template-columns:120px 1fr;gap:6px 12px;font-size:13px}
.df-kv dt{color:#98a2ae}.df-kv dd{margin:0;color:#455265}
.df-actions{display:flex;gap:6px;flex-wrap:wrap}
.df-matches{display:grid;gap:6px}
@media(max-width:480px){.df-kv{grid-template-columns:100px 1fr}}
</style>`,
  );

  // ───────────── next action ─────────────

  /** The hub that serves a parcel's delivery zone, when the console knows it (zones, else hubs). */
  function servingHub(p) {
    const zone = p.delivery?.zone;
    const district = p.delivery?.district;
    if (!zone) return null;
    const zones = Ops.cache.zones?.value?.items || [];
    const z = zones.find(z => z.hub && z.name === zone && z.district === district);
    if (z) return z.hub;
    return DF.state.hubs.find(h => h.active !== false && h.zone === zone && h.district === district) || null;
  }
  const needsTransfer = p => {
    const hub = servingHub(p);
    return !!(hub && p.currentHub && hub.id !== p.currentHub.id);
  };

  /** { kind, label, title } of the parcel's next step, or null (nothing for operations to do now). */
  Ops.nextAction = p => {
    if (!p || CLOSED.includes(p.status)) return null;
    if (p.status === "EXCEPTION") return { kind: "resolve", label: "Resolve", title: "Record an operations decision for this exception" };
    if (p.incomplete) return { kind: "edit", label: "Edit details", title: `Complete the missing details: ${(p.missingLabels || []).join(", ")}` };
    if (p.status === "PENDING_CONFIRMATION")
      return Ops.awaitingDropOff?.(p)
        ? { kind: "receive", label: "Receive", title: `Receive it at ${p.dropOffHub?.name || "the hub"} when the sender brings it` }
        : { kind: "accept", label: "Accept & assign rider", title: "Accept the order and assign a pickup rider" };
    if (p.status === "AT_HUB") {
      if (needsTransfer(p)) return { kind: "transfer", label: "Add to transfer", title: `${servingHub(p).name} serves ${p.delivery.zone}: bag it for the transfer` };
      return { kind: "assign", label: "Assign rider", title: "Assign a delivery rider" };
    }
    if (p.status === "READY_FOR_COLLECTION") return { kind: "handover", label: "Hand over", title: "Hand it to the receiver at the Hub Pickup counter" };
    if (p.status === "RETURN_SCHEDULED" && !p.returnInfo?.runId) return { kind: "returnRun", label: "Add to return run", title: "Plan a return run to the merchant" };
    return null;
  };

  /** Waits (briefly) for an element a page draws after loading its data. */
  function whenShown(selector, then, tries = 40) {
    const el = document.querySelector(selector);
    if (el) return void then(el);
    if (tries > 0) setTimeout(() => whenShown(selector, then, tries - 1), 150);
  }

  /** Runs a next action: the existing dialog or handler, or the page where it's done. */
  Ops.runNext = (kind, id) => {
    const p = Ops.apiParcel(id);
    if (!p) return void showToast(`${id} is no longer in the list. Search for it again.`);
    const go = (view, tab) => {
      Ops.drawer.close();
      Ops.navigate?.(view, tab);
    };
    switch (kind) {
      case "accept":
      case "assign":
        return void openModal("assign", id);
      case "resolve":
        return void openModal("exception", id);
      case "edit": {
        // The row's own "Edit details" handler (bridge.js) — reached through a click on a real button.
        const button = document.querySelector(`[data-generated-edit="${CSS.escape(id)}"]`);
        if (button) return void button.click();
        return;
      }
      case "receive":
        go("Hub desk", "Drop-off receive");
        return whenShown("#rdCode", input => {
          if (p.dropOffHub && $("rdHub") && $("rdHub").value !== p.dropOffHub.id && [...$("rdHub").options].some(o => o.value === p.dropOffHub.id)) {
            $("rdHub").value = p.dropOffHub.id;
            $("rdHub").dispatchEvent(new Event("change", { bubbles: true }));
          }
          input.value = id;
          input.focus();
          showToast(`${id}: press Enter to receive it at the hub.`);
        });
      case "transfer": {
        const hub = servingHub(p);
        go("Transfers");
        return whenShown("#lhScanParcel, #lhOpenBag", input => {
          if (input.id === "lhScanParcel") input.value = id;
          input.focus();
          showToast(input.id === "lhScanParcel" ? `${id}: press Enter to scan it into the open bag.` : `Open a bag to ${hub?.name || "the delivery hub"}, then scan ${id} into it.`);
        });
      }
      case "handover":
        go("Hub desk", "Hub Pickup counter");
        return whenShown("#collectCounter", () => {
          const select = $("collectHub");
          if (select && p.currentHub && select.value !== p.currentHub.id && [...select.options].some(o => o.value === p.currentHub.id)) {
            select.value = p.currentHub.id;
            select.dispatchEvent(new Event("change", { bubbles: true }));
          }
          whenShown(`[data-collect-open="${CSS.escape(id)}"]`, button => button.click());
        });
      case "returnRun":
        go("Returns");
        return whenShown("[data-rto-add]", button => {
          button.click();
          whenShown("#rtoAddId", input => {
            input.value = id;
            $("rtoAddReason")?.focus();
          });
        });
    }
  };

  /** The primary button for a parcel (the existing control when there is one), or "". */
  Ops.nextButton = (p, extra = "") => {
    const next = Ops.nextAction(p);
    if (!next || !Ops.can("dispatch")) return "";
    const id = esc(p.trackingId);
    // "Edit details" is the row's own button (bridge.js handles it anywhere on the page).
    const attr = next.kind === "edit" ? `data-generated-edit="${id}"` : `data-next="${esc(next.kind)}" data-next-id="${id}"`;
    return `<button type="button" class="button button-sm button-primary" ${attr} title="${esc(next.title)}" ${extra}>${esc(next.label)}</button>`;
  };

  window.addEventListener(
    "click",
    event => {
      const button = event.target.closest?.("[data-next]");
      if (!button) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      Ops.runNext(button.dataset.next, button.dataset.nextId);
    },
    true,
  );

  // ───────────── shipment rows: next action · Details · More ─────────────

  const moreMenu = (items, label = "More") =>
    `<details class="df-more"><summary class="button button-sm" aria-label="${esc(label)} actions">${esc(label)} ▾</summary><div class="df-more-menu" role="menu">${items}</div></details>`;
  Ops.moreMenu = moreMenu;

  function decorateRow(tr) {
    tr.dataset.na = "1";
    const cell = tr.lastElementChild;
    const s = shipments.find(x => x.id === tr.dataset.shipmentId);
    const p = s?._api;
    if (!cell || !p) return;
    const controls = [...cell.children];
    const next = Ops.can("dispatch") ? Ops.nextAction(p) : null;
    // The existing control for the next action becomes the primary button (same handler).
    let primary = null;
    if (next?.kind === "edit") primary = cell.querySelector("[data-generated-edit]");
    else if (next?.kind === "resolve") primary = cell.querySelector("[data-exception]");
    else if (next?.kind === "accept") primary = cell.querySelector("[data-customer-confirm]");
    if (primary) {
      primary.classList.add("button-primary");
      primary.textContent = next.label;
      primary.title = next.title;
    }
    const wrap = document.createElement("div");
    wrap.className = "df-row-actions";
    if (primary) wrap.append(primary);
    else if (next) wrap.insertAdjacentHTML("beforeend", Ops.nextButton(p));
    wrap.insertAdjacentHTML("beforeend", `<button type="button" class="button button-sm" data-drawer="${esc(p.trackingId)}">Details</button>`);
    const rest = controls.filter(el => el !== primary);
    if (rest.length) {
      wrap.insertAdjacentHTML("beforeend", moreMenu(""));
      const menu = wrap.querySelector(".df-more-menu");
      for (const el of rest) {
        if (el.matches("[data-exception]")) el.textContent = "Resolve";
        menu.append(el);
      }
    }
    cell.replaceChildren(wrap);
  }

  let rowsQueued = false;
  const decorateRows = () => {
    rowsQueued = false;
    document.querySelectorAll("#shipmentBody tr[data-shipment-id]:not([data-na])").forEach(decorateRow);
    // The hub register: a Details button next to History.
    document.querySelectorAll("#hubShipmentRows [data-track]").forEach(track => {
      const box = track.parentElement;
      if (!box || box.querySelector("[data-drawer]")) return;
      track.insertAdjacentHTML("afterend", `<button class="button button-sm" type="button" data-drawer="${esc(track.dataset.track)}">Details</button>`);
    });
  };
  // Rows are redrawn by renders, searches, paging and live updates: decorate whatever is new
  // (after bridge-intake.js has added its "Change to drop-off" buttons in the same turn).
  new MutationObserver(() => {
    if (rowsQueued) return;
    rowsQueued = true;
    queueMicrotask(() => queueMicrotask(decorateRows));
  }).observe($("mainContent") || document.body, { childList: true, subtree: true });

  // "More" menus float above table scroll areas: placed when opened, closed on outside clicks.
  document.addEventListener(
    "toggle",
    event => {
      const details = event.target;
      if (!(details instanceof HTMLDetailsElement) || !details.classList.contains("df-more")) return;
      if (!details.open) return;
      document.querySelectorAll("details.df-more[open]").forEach(d => d !== details && (d.open = false));
      const menu = details.querySelector(".df-more-menu");
      const rect = details.querySelector("summary").getBoundingClientRect();
      menu.style.visibility = "hidden";
      menu.style.top = "0px";
      menu.style.left = "0px";
      requestAnimationFrame(() => {
        const width = menu.offsetWidth;
        const height = menu.offsetHeight;
        const below = rect.bottom + 4 + height <= window.innerHeight - 8;
        menu.style.top = `${Math.max(8, below ? rect.bottom + 4 : rect.top - 4 - height)}px`;
        menu.style.left = `${Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8)}px`;
        menu.style.visibility = "";
      });
    },
    true,
  );
  const closeMenus = except => document.querySelectorAll("details.df-more[open]").forEach(d => d !== except && (d.open = false));
  document.addEventListener("click", event => {
    const inside = event.target.closest?.("details.df-more");
    // A menu item was used: close its menu (the select keeps it open while choosing).
    if (inside && event.target.closest(".df-more-menu") && event.target.closest("button")) return void setTimeout(() => (inside.open = false));
    closeMenus(inside);
  });
  window.addEventListener("scroll", () => closeMenus(), true);
  window.addEventListener("resize", () => closeMenus());
  document.addEventListener("keydown", event => event.key === "Escape" && closeMenus());

  // ───────────── the parcel drawer ─────────────

  const drawer = { id: null, matches: [], proof: new Map() };

  function ensureDrawer() {
    let el = $("parcelDrawer");
    if (el) return el;
    document.body.insertAdjacentHTML(
      "beforeend",
      `<aside id="parcelDrawer" class="df-drawer" role="dialog" aria-modal="false" aria-labelledby="parcelDrawerTitle" hidden><header><div><h2 id="parcelDrawerTitle">Parcel</h2><p id="parcelDrawerSub" style="margin:6px 0 0;color:#778293;font-size:13px"></p></div><button type="button" class="button" id="parcelDrawerClose" aria-label="Close parcel details">×</button></header><div class="df-drawer-body" id="parcelDrawerBody"></div></aside>`,
    );
    el = $("parcelDrawer");
    $("parcelDrawerClose").addEventListener("click", () => Ops.drawer.close());
    return el;
  }

  const kv = rows =>
    `<dl class="df-kv">${rows
      .filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`)
      .join("")}</dl>`;

  function priceMarkup(p) {
    const c = p.charges || {};
    const lines =
      c.lines && c.lines.length
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
    const breakdown = window.DFOrderServices?.breakdown
      ? window.DFOrderServices.breakdown({ lines, totalCharge: c.total })
      : lines.map(l => `<div>${esc(l.label)} · ${esc(Ops.money(l.amount))}</div>`).join("") + `<strong>${esc(Ops.money(c.total))}</strong>`;
    const cod = Number(p.codAmount) ? `<p style="margin:8px 0 0;color:#647184;font-size:13px">Cash on delivery: <strong>${esc(Ops.money(p.codAmount))}</strong>${p.cod ? ` · ${esc(p.cod.state.toLowerCase().replace(/_/g, " "))}` : ""}</p>` : "";
    return `<div style="font-size:13px">${breakdown}</div>${cod}`;
  }

  function proofMarkup(p) {
    if (!p.proof) return `<p class="panel-subtitle" style="margin:0">${p.status === "DELIVERED" ? "No proof of delivery recorded." : "Recorded by the rider at delivery."}</p>`;
    const full = drawer.proof.get(p.trackingId);
    if (full === undefined) {
      drawer.proof.set(p.trackingId, null);
      DF.api(`/parcels/${encodeURIComponent(p.trackingId)}/proof`)
        .then(proof => {
          drawer.proof.set(p.trackingId, proof);
          if (drawer.id === p.trackingId) paintDrawer();
        })
        .catch(error => {
          drawer.proof.set(p.trackingId, { error: DF.describe(error) });
          if (drawer.id === p.trackingId) paintDrawer();
        });
    }
    const METHOD = { OTP: "Delivery code", SIGNATURE: "Signature", PHOTO: "Photo" };
    const rows = [
      ["Method", esc(METHOD[p.proof.method] || p.proof.method)],
      ["Received by", esc(p.proof.receivedBy || "—")],
      ["Recorded", esc(Ops.when(p.proof.recordedAt))],
    ];
    if (full && !full.error) {
      if (full.rider) rows.push(["Rider", esc(`${full.rider.code} · ${full.rider.name}`)]);
      if (full.otpVerified) rows.push(["Code", "Verified"]);
      if (full.location) rows.push(["Location", esc(`${full.location.lat.toFixed(5)}, ${full.location.lng.toFixed(5)}`)]);
      if (full.note) rows.push(["Note", esc(full.note)]);
    }
    const image = full?.image ? `<p style="margin:8px 0 0"><button type="button" class="button button-sm" data-drawer-proof="${esc(full.image.fileId)}">Open ${p.proof.method === "SIGNATURE" ? "signature" : "photo"}</button></p>` : "";
    return kv(rows) + (full?.error ? `<p class="panel-subtitle">${esc(full.error)}</p>` : "") + image;
  }

  function historyMarkup(p) {
    const events = [...(p.events || [])].reverse();
    if (!events.length) return `<p class="panel-subtitle" style="margin:0">No tracking events yet.</p>`;
    return `<ol style="list-style:none;margin:0;padding:0">${events
      .map(
        (e, index) =>
          `<li style="position:relative;margin-left:8px;padding:0 0 16px 22px;border-left:${index === events.length - 1 ? "0" : "1px solid #dfe5ee"}"><span style="position:absolute;left:-6px;top:2px;width:11px;height:11px;border-radius:50%;background:${index === 0 ? "#3766e8" : "#cbd5e1"}"></span><strong style="font-size:13px">${esc(e.title)}${e.internal ? " · internal" : ""}</strong><div style="margin-top:3px;color:#647184;font-size:13px">${esc([e.location, e.description].filter(Boolean).join(" · "))}</div><small style="display:block;margin-top:3px;color:#99a3af">${esc([Ops.when(e.at), e.actor].filter(Boolean).join(" · "))}</small></li>`,
      )
      .join("")}</ol>`;
  }

  /** Staff notes and messages on the parcel's timeline (internal entries). */
  function notesMarkup(p) {
    const notes = [...(p.events || [])].filter(e => e.internal).reverse();
    if (!notes.length) return `<p class="panel-subtitle" style="margin:0">No staff notes yet. Notes added when resolving exceptions or correcting details appear here.</p>`;
    return `<div style="display:grid;gap:8px">${notes
      .map(
        e =>
          `<div style="padding:9px 11px;border:1px solid var(--line);border-radius:8px;font-size:13px"><strong>${esc(e.title)}</strong>${e.description ? `<div style="margin-top:3px;color:#647184">${esc(e.description)}</div>` : ""}<small style="display:block;margin-top:4px;color:#99a3af">${esc([Ops.when(e.at), e.actor].filter(Boolean).join(" · "))}</small></div>`,
      )
      .join("")}</div>`;
  }

  function actionsMarkup(p) {
    const id = esc(p.trackingId);
    const dispatch = Ops.can("dispatch");
    const buttons = [Ops.nextButton(p)];
    const next = Ops.nextAction(p);
    if (dispatch && !CLOSED.includes(p.status)) {
      if (next?.kind !== "edit") buttons.push(`<button type="button" class="button button-sm" data-generated-edit="${id}">Edit details</button>`);
      if (next?.kind !== "accept" && next?.kind !== "assign" && (PICKUP_STAGE.includes(p.status) || p.status === "AT_HUB") && !Ops.awaitingDropOff?.(p))
        buttons.push(`<button type="button" class="button button-sm" data-next="assign" data-next-id="${id}">Assign rider</button>`);
      if (INTAKE_CHANGEABLE.includes(p.status) && (p.intake !== "DROP_OFF" || Ops.inMyHubs(p.dropOffHub?.id)))
        buttons.push(`<button type="button" class="button button-sm" data-intake-change="${id}">${p.intake === "DROP_OFF" ? "Change to rider pickup" : "Change to drop-off"}</button>`);
      if (p.status === "PENDING_CONFIRMATION") buttons.push(`<button type="button" class="button button-sm" data-customer-cancel="${id}">Cancel request</button>`);
    }
    buttons.push(`<button type="button" class="button button-sm" data-drawer-labels="${id}">Print label</button>`);
    buttons.push(`<button type="button" class="button button-sm" data-drawer-history="${id}">Open history</button>`);
    return `<div class="df-actions">${buttons.filter(Boolean).join("")}</div>`;
  }

  function matchesMarkup() {
    if (drawer.matches.length < 2) return "";
    return `<section><h3>${esc(`${drawer.matches.length} matching parcels`)}</h3><div class="df-matches">${drawer.matches
      .map(
        m =>
          `<button type="button" class="button button-sm${m.trackingId === drawer.id ? " button-primary" : ""}" style="justify-content:space-between" data-drawer="${esc(m.trackingId)}" data-drawer-keep><span>${esc(m.trackingId)}</span><span style="font-weight:500">${esc(`${m.recipient.name || "—"} · ${m.statusLabel}`)}</span></button>`,
      )
      .join("")}</div></section>`;
  }

  function paintDrawer() {
    const el = ensureDrawer();
    const p = drawer.id && Ops.apiParcel(drawer.id);
    if (!p) return void Ops.drawer.close();
    const s = shipments.find(x => x.id === p.trackingId);
    $("parcelDrawerTitle").textContent = p.trackingId;
    $("parcelDrawerSub").innerHTML = `${statusPill(esc(p.statusLabel))} ${s?.sla ? statusPill(esc(s.sla)) : ""}`;
    const body = $("parcelDrawerBody");
    const scroll = body.scrollTop;
    body.innerHTML = `${matchesMarkup()}<section><h3>Actions</h3>${actionsMarkup(p)}</section>
      <section><h3>Parcel</h3>${kv([
        ["Merchant / sender", esc(p.merchant?.name || p.sender?.name || "—")],
        ["Recipient", esc([p.recipient?.name, DF.localPhone(p.recipient?.phone)].filter(Boolean).join(" · ") || "—")],
        ["Deliver to", esc(p.delivery?.label || "—")],
        ["Pickup from", esc(p.intake === "DROP_OFF" ? `Drop-off at ${p.dropOffHub?.name || "hub"}` : p.pickup?.label || "—")],
        ["Service", esc([p.serviceLevelLabel, p.type === "DOCUMENT" ? "Document" : "Parcel", p.weightKg != null ? `${p.weightKg} kg` : ""].filter(Boolean).join(" · "))],
        ["Rider", esc(s?.rider || "—")],
        ["Hub", esc(p.currentHub?.name || "—")],
        ["Order ref", esc(p.merchantOrderRef || "")],
        ["Booked", esc(Ops.when(p.createdAt))],
        ["Promised by", p.estimatedDeliveryAt ? esc(Ops.when(p.estimatedDeliveryAt)) : ""],
        ["Missing", p.incomplete ? esc((p.missingLabels || []).join(", ")) : ""],
        ["Return", p.returnInfo ? esc([p.returnInfo.reason, p.returnInfo.runId ? "in a return run" : "awaiting a return run"].filter(Boolean).join(" · ")) : ""],
      ])}</section>
      <section><h3>Price</h3>${priceMarkup(p)}</section>
      <section><h3>Proof of delivery</h3>${proofMarkup(p)}</section>
      <section><h3>Notes & messages</h3>${notesMarkup(p)}</section>
      <section><h3>Tracking history</h3>${historyMarkup(p)}</section>`;
    body.scrollTop = scroll;
    el.hidden = false;
  }

  Ops.drawer = {
    open(trackingId, matches) {
      drawer.id = trackingId;
      if (matches) drawer.matches = matches;
      else if (!drawer.matches.some(m => m.trackingId === trackingId)) drawer.matches = [];
      paintDrawer();
      $("parcelDrawerClose")?.focus({ preventScroll: true });
    },
    close() {
      drawer.id = null;
      drawer.matches = [];
      const el = $("parcelDrawer");
      if (el) el.hidden = true;
    },
    get id() {
      return drawer.id;
    },
  };

  window.addEventListener(
    "click",
    event => {
      const t = event.target;
      if (!(t instanceof Element)) return;
      const open = t.closest("[data-drawer]");
      if (open) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return void Ops.drawer.open(open.dataset.drawer, open.hasAttribute("data-drawer-keep") ? undefined : []);
      }
      const labels = t.closest("[data-drawer-labels]");
      if (labels) return void Ops.labels?.open([labels.dataset.drawerLabels]);
      const history = t.closest("[data-drawer-history]");
      if (history) return void courierTrackingHistory(history.dataset.drawerHistory);
      const proof = t.closest("[data-drawer-proof]");
      if (proof) {
        event.preventDefault();
        return void DF.download(`/files/${encodeURIComponent(proof.dataset.drawerProof)}`, "proof-of-delivery").catch(error => showToast(DF.describe(error)));
      }
    },
    true,
  );
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !drawer.id) return;
    // Dialogs above the drawer close first.
    if ($("modalBackdrop")?.classList.contains("open") || $("courierHistoryBackdrop") || $("rtoDialog") || $("generatedCNDialog")?.open) return;
    Ops.drawer.close();
  });

  // The drawer follows the working set (live updates, actions).
  const baseSet = DF.parcels.set;
  DF.parcels.set = function (items) {
    const changed = baseSet.call(DF.parcels, items);
    if (drawer.id) queueMicrotask(() => drawer.id && paintDrawer());
    return changed;
  };

  // ───────────── global search ─────────────

  /** Puts parcels found on the server into the working set (as the console's search does). */
  function remember(items) {
    if (!items.length) return;
    for (const p of items) {
      Ops.extra.delete(p.trackingId);
      Ops.extra.set(p.trackingId, p);
    }
    const fresh = new Set(items.map(p => p.trackingId));
    DF.parcels.set([...DF.parcels.cache.filter(p => !fresh.has(p.trackingId)), ...items]);
  }

  async function search(raw) {
    const code = DF.scanner?.normalize ? DF.scanner.normalize(raw) : raw.trim().toUpperCase();
    const digits = raw.replace(/\D/g, "");
    const exact = DF.parcels.cache.find(p => p.trackingId.toUpperCase() === code);
    if (exact) return [exact];
    const phone = digits.length >= 6 ? digits.slice(-10) : "";
    if (phone) {
      const local = DF.parcels.cache.filter(p => [p.recipient?.phone, p.sender?.phone].some(n => String(n || "").replace(/\D/g, "").includes(phone)));
      if (local.length) return local.slice(0, 20);
    }
    if (/^[A-Z0-9-]{4,}$/.test(code) && !/^\d+$/.test(code)) {
      try {
        const parcel = await DF.api(`/parcels/${encodeURIComponent(code)}`);
        remember([parcel]);
        return [parcel];
      } catch (error) {
        if (error?.status !== 404) throw error;
      }
    }
    const page = await DF.api(`/parcels?limit=20&q=${encodeURIComponent(raw.trim())}`);
    remember(page.items);
    return page.items;
  }

  window.addEventListener(
    "keydown",
    event => {
      if (event.target?.id !== "globalSearch" || event.key !== "Enter") return;
      // Replaces the original search (which only filtered the shipment register).
      event.preventDefault();
      event.stopImmediatePropagation();
      const input = event.target;
      const raw = input.value.trim();
      if (!raw) return;
      search(raw)
        .then(found => {
          if (!found.length) return void showToast(`No parcel found for “${raw}”.`);
          Ops.drawer.open(found[0].trackingId, found.length > 1 ? found : []);
          input.select();
        })
        .catch(error => showToast(DF.describe(error)));
    },
    true,
  );
})();
