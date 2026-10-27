/*
 * Rider app "Scan" area (Scan parcel page): action sections for working through many parcels by
 * scanning. The rider opens a section, sets its context once (the pickup stop, the hub, the failure
 * reason…), then scans parcels one after another: camera (DF.scanner), a hardware scanner in keyboard
 * mode, or typing. Every scan gets the shared beep / flash (DF.scanner.feedback) and a line in the
 * running list. Actions use the existing rider endpoints through DFOffline.send (Idempotency-Key,
 * queued while offline), so every lifecycle rule stays on the server.
 *
 * Sections
 * - Pickup from merchant   POST /rider/parcels/:id/pickup { outcome: COLLECTED, expectedStop } → PICKED_UP.
 *                          Expected vs scanned per stop, missing list, other stops' parcels refused.
 * - Hand over at hub       POST /rider/parcels/:id/handover { hubId } puts a collected parcel on the hub's
 *                          handover list (no status change); the hub scans it in at its receive desk
 *                          (POST /ops/hub-receive → At hub). Undo: POST …/handover/withdraw until then.
 * - Start deliveries       POST /rider/parcels/:id/start-delivery: out for delivery, and a fresh delivery code goes
 *                          to the recipient by SMS now (assignment sends none).
 * - Deliver                opens the parcel's delivery screen: proof (code / signature / photo) and COD
 *                          are still required; nothing is delivered by a scan alone.
 * - Failed delivery / return to hub   POST /rider/parcels/:id/delivery { outcome: FAILED, reason, nextAction }.
 * - Return to merchant     GET /rider/return-runs (runs assigned to the rider, planned or out for return);
 *                          each scan: POST /rider/parcels/:id/return { runId, receivedBy } → Returned (the
 *                          merchant took it back). A planned run goes out with the first one; the run
 *                          completes with its last parcel.
 * Deep link: /rider?page=Scan%20parcel&scan=pickup|handover|start|deliver|failed|return
 */
(() => {
  const DF = window.DF;
  const Off = window.DFOffline;
  const $ = id => document.getElementById(id);
  const q = (selector, root = document) => root.querySelector(selector);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const money = n => `৳ ${Number(n || 0).toLocaleString("en-BD", { maximumFractionDigits: 2 })}`;
  const page = () => $("breadcrumbPage")?.textContent;
  const normalize = code => (DF.scanner?.normalize ? DF.scanner.normalize(code) : String(code || "").trim().toUpperCase());
  const tasks = () => DF.rider.tasks || { pickups: [], deliveries: [], carrying: [] };
  const pickups = () => tasks().pickups || [];
  const deliveries = () => tasks().deliveries || [];
  const carrying = () => tasks().carrying || [];
  const find = (list, id) => list.find(p => p.trackingId === id);
  const stopOf = p => p.pickupStop || { key: p.merchant ? `M:${p.merchant.id}` : `S:${p.sender?.phone}`, name: p.merchant?.name || p.sender?.name || "Sender", address: p.pickup?.label || "" };
  const hubs = () => DF.state.hubs || [];
  const myHub = () => DF.riderState?.summary?.rider.hub || null;
  const hubName = id => hubs().find(h => h.id === id)?.name || myHub()?.name || "the hub";

  const FAILURE_REASONS = ["Recipient unavailable", "Incorrect address", "Recipient refused", "Unable to contact recipient", "Access / safety issue", "Other"];
  const SECTIONS = [
    {
      key: "pickup",
      title: "Pickup from merchant",
      icon: "box",
      text: "At a merchant: choose the pickup, then scan each parcel they hand you. You see how many are expected, how many you've scanned and which are still missing.",
    },
    {
      key: "handover",
      title: "Hand over at hub",
      icon: "truck",
      text: "At the hub: choose the hub, then scan each parcel you collected as you hand it over. It goes on the hub's handover list; the hub scans it in to confirm.",
    },
    {
      key: "start",
      title: "Start deliveries",
      icon: "route",
      text: "Before you leave: scan each parcel as you load it. It goes out for delivery and the delivery code is sent to the recipient by SMS.",
    },
    {
      key: "deliver",
      title: "Deliver",
      icon: "check",
      text: "At the door: scan the parcel and its delivery screen opens. Collect any COD and the proof (code, signature or photo) to complete it.",
    },
    {
      key: "failed",
      title: "Failed delivery / return to hub",
      icon: "alert",
      text: "Couldn't deliver: choose the reason and what happens next once, then scan each parcel it applies to.",
    },
    {
      key: "return",
      title: "Return to merchant",
      icon: "pin",
      text: "Taking parcels back to a merchant: choose the return run and scan each parcel the merchant takes back. It's marked returned.",
    },
  ];

  /** The open section: { key, ctx, log: [{ id, ok, text, undo }] }. */
  let S = null;
  let returnRuns = null;

  // ───────────── actions (same path as the other rider actions: sent now or queued offline) ─────────────

  const send = (id, op, path, body) => {
    const request = { path: `/rider/parcels/${encodeURIComponent(id)}/${path}`, method: "POST", body, trackingId: id, op };
    return Off ? Off.send(request) : DF.api(request.path, { method: "POST", body }).then(result => ({ queued: false, result }));
  };
  /** Scan compliance (POST /scans), only when online; fire-and-forget. */
  const recordScan = (code, kind, ok, message, source) => {
    if (navigator.onLine === false) return;
    DF.api("/scans", { method: "POST", body: { code, kind, source: source || "KEYBOARD", ok, message: message ? String(message).slice(0, 290) : undefined } }).catch(() => undefined);
  };
  const reload = async () => {
    await DF.rider.reload().catch(() => undefined);
    await DF.riderRefresh?.().catch(() => undefined);
  };

  function log(id, ok, text, extra = {}) {
    if (!S) return;
    S.log.unshift({ id, ok, text, at: Date.now(), ...extra });
    S.log = S.log.slice(0, 200);
  }

  function feedback(ok, message) {
    draw();
    DF.scanner?.feedback?.("dfScanInput", ok, message);
  }

  // ───────────── per-section scan handling ─────────────

  /** Scans are handled one after another in the order they were read (a fast scanner never skips one). */
  let chain = Promise.resolve();
  function onScan(raw, source = "KEYBOARD") {
    const id = normalize(raw);
    if (!id || !S) return chain;
    const section = S;
    chain = chain
      .then(async () => {
        if (S !== section) return;
        const handler = HANDLERS[S.key];
        // A parcel we don't know yet: the task list may be older than a new assignment.
        if (!known(id) && navigator.onLine !== false) await DF.rider.reload().catch(() => undefined);
        await handler?.(id, source);
      })
      .catch(error => console.error("Paira Express: scan failed", error));
    return chain;
  }
  const known = id => !!(find(pickups(), id) || find(deliveries(), id) || find(carrying(), id));
  const notMine = id => `${id} isn't assigned to you. Check the label, or ask dispatch to assign it first.`;

  const HANDLERS = {
    async pickup(id, source) {
      const ctx = S.ctx;
      const scanned = ctx.scanned;
      const carried = find(carrying(), id);
      if (scanned.has(id) || (carried && stopOf(carried).key === ctx.stopKey)) {
        scanned.add(id);
        log(id, true, "Already picked up");
        return feedback(true, `${id} is already picked up.`);
      }
      const parcel = find(pickups(), id);
      if (!parcel) {
        const delivery = find(deliveries(), id);
        const message = carried ? `${id} was picked up at ${stopOf(carried).name}, not this pickup.` : delivery ? `${id} is a delivery, not a pickup.` : notMine(id);
        log(id, false, message);
        recordScan(id, "RIDER_PICKUP", false, message, source);
        return feedback(false, message);
      }
      const stop = stopOf(parcel);
      if (stop.key !== ctx.stopKey) {
        const message = `${id} belongs to ${stop.name}, not ${ctx.name}. Scan it at its own pickup.`;
        log(id, false, message);
        recordScan(id, "RIDER_PICKUP", false, message, source);
        return feedback(false, message);
      }
      try {
        const outcome = await send(id, "pickup", "pickup", { outcome: "COLLECTED", expectedStop: ctx.stopKey });
        scanned.add(id);
        ctx.expected.add(id);
        log(id, true, outcome.queued ? "Picked up · saved on this phone, syncs when online" : "Picked up");
        recordScan(id, "RIDER_PICKUP", true, "Picked up", source);
        feedback(true, `${id} picked up.`);
        void reload().then(draw);
      } catch (error) {
        const message = DF.describe(error);
        log(id, false, message);
        recordScan(id, "RIDER_PICKUP", false, message, source);
        feedback(false, message);
      }
    },

    async handover(id, source) {
      const hubId = S.ctx.hubId;
      const parcel = find(carrying(), id);
      if (!parcel) {
        const message = find(pickups(), id)
          ? `${id} hasn't been picked up yet. Use "Pickup from merchant" first.`
          : find(deliveries(), id)
            ? `${id} is on your delivery run. If you couldn't deliver it, use "Failed delivery / return to hub".`
            : `${id} isn't a parcel you collected. If the hub already scanned it in, it's done.`;
        log(id, false, message);
        return feedback(false, message);
      }
      if (parcel.handover?.hubId === hubId) {
        log(id, true, `Already on the handover list for ${hubName(hubId)}`, { undo: "handover" });
        return feedback(true, `${id} is already on the list.`);
      }
      try {
        const outcome = await send(id, "handover", "handover", { hubId, source });
        parcel.handover = { hubId, hubName: hubName(hubId), at: new Date().toISOString() };
        log(id, true, outcome.queued ? "Handed over · saved on this phone, syncs when online" : `Handed over · waiting for ${hubName(hubId)} to scan it in`, { undo: "handover" });
        feedback(true, `${id} handed over.`);
        void reload().then(draw);
      } catch (error) {
        const message = DF.describe(error);
        log(id, false, message);
        feedback(false, message);
      }
    },

    async start(id, source) {
      const parcel = find(deliveries(), id);
      if (!parcel) {
        const message = find(carrying(), id)
          ? `${id} was collected for the hub. Hand it over at the hub first.`
          : find(pickups(), id)
            ? `${id} is a pickup, not a delivery.`
            : notMine(id);
        log(id, false, message);
        recordScan(id, "RIDER_OUT_FOR_DELIVERY", false, message, source);
        return feedback(false, message);
      }
      if (parcel.status === "OUT_FOR_DELIVERY") {
        log(id, true, "Already out for delivery");
        return feedback(true, `${id} is already out for delivery.`);
      }
      try {
        const outcome = await send(id, "start-delivery", "start-delivery");
        S.ctx.started.add(id);
        log(id, true, outcome.queued ? "Out for delivery · saved on this phone; the code is sent when it syncs" : "Out for delivery · delivery code sent to the recipient");
        recordScan(id, "RIDER_OUT_FOR_DELIVERY", true, "Out for delivery", source);
        feedback(true, outcome.queued ? `${id} is out for delivery (syncs when online).` : `${id} is out for delivery. Delivery code sent to the recipient.`);
        void reload().then(draw);
      } catch (error) {
        const message = DF.describe(error);
        log(id, false, message);
        recordScan(id, "RIDER_OUT_FOR_DELIVERY", false, message, source);
        feedback(false, message);
      }
    },

    async deliver(id, source) {
      const parcel = find(deliveries(), id);
      if (!parcel) {
        const message = find(carrying(), id) ? `${id} was collected for the hub, not for delivery.` : find(pickups(), id) ? `${id} is a pickup, not a delivery.` : notMine(id);
        log(id, false, message);
        recordScan(id, "RIDER_DELIVERY", false, message, source);
        return feedback(false, message);
      }
      recordScan(id, "RIDER_DELIVERY", true, "Delivery screen opened", source);
      S.ctx.opened.add(id);
      log(id, true, `Delivery screen opened${Number(parcel.codAmount) > 0 ? ` · collect ${money(parcel.codAmount)}` : ""}`);
      feedback(true, `${id}: complete the delivery with proof.`);
      openQuickDelivery(id);
    },

    async failed(id, source) {
      const ctx = S.ctx;
      const parcel = find(deliveries(), id);
      if (!parcel) {
        const message = find(carrying(), id) ? `${id} was collected for the hub. Use "Hand over at hub".` : notMine(id);
        log(id, false, message);
        return feedback(false, message);
      }
      try {
        const body = { outcome: "FAILED", reason: ctx.reason, nextAction: ctx.nextAction, note: ctx.note || undefined, ...(ctx.nextAction === "RETURN_TO_HUB" && ctx.hubId ? { hubId: ctx.hubId } : {}) };
        const outcome = await send(id, "delivery", "delivery", body);
        const next = ctx.nextAction === "RETRY" ? "another attempt scheduled" : `back to ${hubName(ctx.hubId)}`;
        log(id, true, `${ctx.reason} · ${next}${outcome.queued ? " · saved on this phone" : ""}`);
        recordScan(id, "RIDER_DELIVERY", true, `Failed: ${ctx.reason}`, source);
        feedback(true, `${id}: failed attempt recorded.`);
        void reload().then(draw);
      } catch (error) {
        const message = DF.describe(error);
        log(id, false, message);
        feedback(false, message);
      }
    },

    async return(id) {
      const run = (returnRuns || []).find(r => r.id === S.ctx.runId);
      if (!run) return feedback(false, "Choose the return run first.");
      const onRun = run.parcels.some(p => p.trackingId === id);
      const other = !onRun && (returnRuns || []).find(r => r.parcels.some(p => p.trackingId === id));
      if (!onRun) {
        const message = other ? `${id} is on ${other.number} (${other.merchant.name}), not this run.` : `${id} isn't on this return run. Keep it for the hub.`;
        log(id, false, message);
        return feedback(false, message);
      }
      // The merchant took it back: Returned (sent now, or queued while offline).
      try {
        const out = await send(id, "return", "return", { runId: run.id, receivedBy: S.ctx.receivedBy?.trim() || undefined, source: S.ctx.source || undefined });
        S.ctx.checked.add(id);
        run.parcels = run.parcels.filter(p => p.trackingId !== id);
        const done = !out.queued && out.result?.runCompleted;
        const text = out.queued ? `${id}: returned (sends when you're back online)` : `${id} returned to ${run.merchant.name}${done ? ` · ${run.number} completed` : ""}`;
        log(id, true, text);
        feedback(true, text);
        if (done) returnRuns = returnRuns.filter(r => r.id !== run.id);
        draw();
      } catch (error) {
        const message = DF.describe(error);
        log(id, false, message);
        feedback(false, message);
      }
    },
  };

  /** Undo where the lifecycle allows it: a handover the hub hasn't scanned in yet. */
  async function undo(id, kind) {
    if (kind !== "handover") return;
    try {
      await send(id, "handover-withdraw", "handover/withdraw");
      const parcel = find(carrying(), id);
      if (parcel) parcel.handover = null;
      S?.log.forEach(l => l.id === id && l.undo && (l.undo = null));
      log(id, true, "Taken off the handover list");
      feedback(true, `${id} taken off the list.`);
      void reload().then(draw);
    } catch (error) {
      feedback(false, DF.describe(error));
    }
  }

  // ───────────── the quick delivery screen ─────────────

  /** The parcel's normal delivery dialog, made quick: big buttons, the recipient's code focused when it's a proof option. */
  function openQuickDelivery(id) {
    openModal("delivery", id);
    $("actionModal")?.classList.add("df-scan-quick");
    const method = $("proofMethod");
    if (method && [...method.options].some(o => (o.value || o.textContent) === "OTP")) {
      method.value = "OTP";
      method.dispatchEvent(new Event("change"));
    }
    setTimeout(() => ($("otpProof") && !$("otpProof").hidden ? $("deliveryOtp") : $("submitAction"))?.focus(), 50);
  }
  const baseClose = closeModal;
  closeModal = function () {
    $("actionModal")?.classList.remove("df-scan-quick");
    baseClose();
    if (S && page() === "Scan parcel") setTimeout(() => $("dfScanInput")?.focus(), 0);
  };
  document.head.insertAdjacentHTML(
    "beforeend",
    `<style id="dfScanStyles">
      #actionModal.df-scan-quick #submitAction{min-height:52px;font-size:16px;width:100%}
      #actionModal.df-scan-quick .modal-actions{flex-wrap:wrap}
      #actionModal.df-scan-quick #deliveryOtp{font-size:22px;letter-spacing:.3em;min-height:52px;text-align:center}
      #actionModal.df-scan-quick select{min-height:44px}
      .df-scan-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px;margin-top:14px}
      .df-scan-card{display:flex;flex-direction:column;gap:6px;text-align:left;padding:14px;border:1px solid var(--line,#e4e8ee);border-radius:12px;background:#fff;cursor:pointer;font:inherit;color:inherit}
      .df-scan-card:hover,.df-scan-card:focus-visible{border-color:var(--blue,#3766e8);box-shadow:0 0 0 3px #3766e81f}
      .df-scan-card strong{display:flex;gap:8px;align-items:center;font-size:15px}
      .df-scan-card strong svg{width:18px;height:18px}
      .df-scan-card span{color:#647184;font-size:13px;line-height:1.45}
      .df-scan-box{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
      .df-scan-box input{flex:1;min-width:180px;min-height:48px;font-size:17px}
      .df-scan-box .button{min-height:48px}
      .df-scan-stats{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}
      .df-scan-stats span{padding:6px 10px;border-radius:999px;background:#f2f4f7;font-size:13px;font-weight:600}
      .df-scan-stats span[data-tone=ok]{background:var(--green-soft,#ecfdf3);color:var(--green,#067647)}
      .df-scan-stats span[data-tone=warn]{background:var(--amber-soft,#fffaeb);color:var(--amber,#b54708)}
      .df-scan-row{display:flex;justify-content:space-between;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid #eef1f5;font-size:13px}
      .df-scan-row small{display:block;color:#8a94a3}
      .df-scan-row[data-ok=false] strong{color:var(--red,#b42318)}
      @media (max-width:640px){.df-scan-box .button{flex:1}}
    </style>`,
  );

  // ───────────── views ─────────────

  function cardsPanel() {
    return `<section class="panel" id="dfScanSections" style="margin-bottom:14px"><div class="panel-heading"><div><h2 class="panel-title">Scan actions</h2><p class="panel-subtitle">Pick what you're doing, set it up once, then scan parcel after parcel: camera, a hardware scanner or typing.</p></div></div><div class="df-scan-cards">${SECTIONS.map(
      s => `<button type="button" class="df-scan-card" data-df-scan-section="${s.key}"><strong>${icon(s.icon)} ${esc(s.title)}</strong><span>${esc(s.text)}</span></button>`,
    ).join("")}</div></section>`;
  }

  /** The context form for a section (choose the stop / hub / reason…). Empty when it needs none. */
  function contextForm(section) {
    if (section === "pickup") {
      const stops = new Map();
      for (const p of pickups()) {
        const s = stopOf(p);
        const entry = stops.get(s.key) || { ...s, count: 0 };
        entry.count++;
        stops.set(s.key, entry);
      }
      if (!stops.size) return `<div class="empty-state" id="dfScanNoContext">No pickups are assigned to you right now. New assignments appear here automatically.</div>`;
      return `<div class="field"><label for="dfScanStop">Pickup (merchant / sender)</label><select id="dfScanStop"><option value="">Choose the pickup you're at</option>${[...stops.values()]
        .map(s => `<option value="${esc(s.key)}">${esc(s.name)} · ${s.count} parcel${s.count === 1 ? "" : "s"}${s.address ? ` · ${esc(s.address)}` : ""}</option>`)
        .join("")}</select></div>`;
    }
    if (section === "handover" || section === "failed") {
      const options = hubs().map(h => `<option value="${esc(h.id)}"${h.id === myHub()?.id ? " selected" : ""}>${esc(h.name)}</option>`).join("");
      if (section === "handover") return `<div class="field"><label for="dfScanHub">Hub you're handing over at</label><select id="dfScanHub">${options}</select></div>`;
      return `<div class="field"><label for="dfScanReason">Why couldn't you deliver?</label><select id="dfScanReason"><option value="">Choose a reason</option>${FAILURE_REASONS.map(r => `<option>${esc(r)}</option>`).join("")}</select></div>
        <div class="field" style="margin-top:10px"><label for="dfScanNext">What happens next?</label><select id="dfScanNext"><option value="RETRY">Try again later (keep it on my run)</option><option value="RETURN_TO_HUB">Return it to the hub</option></select></div>
        <div class="field" id="dfScanHubField" style="margin-top:10px" hidden><label for="dfScanHub">Hub</label><select id="dfScanHub">${options}</select></div>
        <div class="field" style="margin-top:10px"><label for="dfScanNote">Note for dispatch (optional)</label><input id="dfScanNote" maxlength="300" placeholder="e.g. Gate locked, no answer"></div>`;
    }
    if (section === "return") {
      if (!returnRuns) return `<div class="empty-state" id="dfScanNoContext">Loading your return runs…</div>`;
      if (!returnRuns.length) return `<div class="empty-state" id="dfScanNoContext">No returns are assigned to you. The hub assigns them on Scan desk › Return rider assign.</div>`;
      return `<div class="field"><label for="dfScanRun">Return run</label><select id="dfScanRun"><option value="">Choose the return run</option>${returnRuns
        .map(r => `<option value="${esc(r.id)}">${esc(r.number)} · ${esc(r.merchant.name)} · ${r.parcels.length} parcel${r.parcels.length === 1 ? "" : "s"}${r.status === "PLANNED" ? " · assigned" : ""}</option>`)
        .join("")}</select></div><div class="field" style="margin-top:10px"><label for="dfScanReceivedBy">Received by at the merchant (optional)</label><input id="dfScanReceivedBy" maxlength="120" placeholder="Who took the parcels back" value="${esc(S?.ctx?.receivedBy || "")}"></div>`;
    }
    return "";
  }

  const RULE_NOTE = {
    pickup: "Each parcel is marked picked up as you scan it. A pickup can't be undone here: if you scanned something by mistake, tell dispatch.",
    handover: "Nothing is marked “At hub” by your scan: the hub confirms each parcel when it scans it in at its receive desk. You can undo a handover until then.",
    start: "Going out for delivery can't be undone from the app.",
    deliver: "A scan never completes a delivery: the proof (and the COD, if any) is always required.",
    failed: "Each scan records a failed attempt (re-attempts beyond the package's free ones may carry a fee). It can't be undone from the app.",
    return: "Each scan marks the parcel returned to the merchant; it can't be undone from the app. Scan only what the merchant takes back: the rest goes back to the hub.",
  };

  /** Lines under the scan box: what's expected, what's done, what's missing. */
  function progress() {
    const c = S.ctx;
    const row = (p, note, extra = "") =>
      `<div class="df-scan-row" data-missing="${esc(p.trackingId)}"><span><strong>${esc(p.trackingId)}</strong><small>${esc(note)}</small></span>${extra}</div>`;
    if (S.key === "pickup" && c.stopKey) {
      const still = pickups().filter(p => stopOf(p).key === c.stopKey && !c.scanned.has(p.trackingId));
      for (const p of carrying()) if (stopOf(p).key === c.stopKey) (c.expected.add(p.trackingId), c.scanned.add(p.trackingId));
      for (const p of still) c.expected.add(p.trackingId);
      const missing = [...c.expected].filter(id => !c.scanned.has(id));
      const stats = `<div class="df-scan-stats" id="dfScanStats"><span data-tone="ok" data-scanned="${c.scanned.size}">Scanned ${c.scanned.size} of ${c.expected.size} expected</span><span data-tone="${missing.length ? "warn" : "ok"}" data-missing-count="${missing.length}">${missing.length ? `${missing.length} missing` : "All collected"}</span></div>`;
      const list = missing
        .map(id => find(pickups(), id))
        .filter(Boolean)
        .map(p => row(p, [p.recipient?.name, p.delivery?.zone, Number(p.codAmount) > 0 ? `COD ${money(p.codAmount)}` : "", p.merchantOrderRef ? `Ref ${p.merchantOrderRef}` : ""].filter(Boolean).join(" · ")))
        .join("");
      const all = missing.length ? `<button type="button" class="button button-sm" data-df-scan-all style="margin-top:10px">Mark all ${missing.length} remaining as picked up</button><p class="panel-subtitle" style="margin-top:6px">Only when you really have them all: scanning each one is the safer check.</p>` : "";
      return `${stats}${missing.length ? `<h3 class="panel-title" style="font-size:14px;margin-top:6px">Still missing</h3>${list}${all}` : ""}`;
    }
    if (S.key === "handover" && c.hubId) {
      const list = carrying();
      const handed = list.filter(p => p.handover?.hubId === c.hubId);
      const rest = list.filter(p => p.handover?.hubId !== c.hubId);
      const received = S.log.filter(l => l.ok && l.undo === "handover" && !find(list, l.id)).map(l => l.id);
      const stats = `<div class="df-scan-stats" id="dfScanStats"><span data-tone="ok" data-handed="${handed.length}">${handed.length} on the handover list</span><span data-tone="${rest.length ? "warn" : "ok"}" data-missing-count="${rest.length}">${rest.length ? `${rest.length} still with you` : "Nothing left with you"}</span>${received.length ? `<span data-tone="ok">${[...new Set(received)].length} scanned in by the hub</span>` : ""}</div>`;
      const handedRows = handed.map(p => row(p, `${stopOf(p).name} · waiting for ${hubName(c.hubId)} to scan it in`, `<button type="button" class="button button-sm" data-df-scan-undo="${esc(p.trackingId)}">Undo</button>`)).join("");
      const restRows = rest.map(p => row(p, `${stopOf(p).name}${p.handover ? ` · on ${p.handover.hubName}'s list` : ""}`)).join("");
      return `${stats}${handed.length ? `<h3 class="panel-title" style="font-size:14px;margin-top:6px">Handover list for ${esc(hubName(c.hubId))}</h3><p class="panel-subtitle">Show this list at the counter. The hub scans each parcel in.</p>${handedRows}` : ""}${rest.length ? `<h3 class="panel-title" style="font-size:14px;margin-top:12px">Still with you</h3>${restRows}` : ""}`;
    }
    if (S.key === "start") {
      const waiting = deliveries().filter(p => p.status !== "OUT_FOR_DELIVERY");
      const out = deliveries().length - waiting.length;
      return `<div class="df-scan-stats" id="dfScanStats"><span data-tone="ok" data-out="${out}">${out} out for delivery</span><span data-tone="${waiting.length ? "warn" : "ok"}" data-missing-count="${waiting.length}">${waiting.length ? `${waiting.length} not started` : "All started"}</span></div>${waiting.length ? `<h3 class="panel-title" style="font-size:14px;margin-top:6px">Not started yet</h3>${waiting.map(p => row(p, [p.recipient?.name, p.delivery?.zone, p.statusLabel].filter(Boolean).join(" · "))).join("")}` : ""}`;
    }
    if (S.key === "deliver" || S.key === "failed") {
      const left = deliveries();
      return `<div class="df-scan-stats" id="dfScanStats"><span data-tone="${left.length ? "warn" : "ok"}" data-missing-count="${left.length}">${left.length ? `${left.length} deliver${left.length === 1 ? "y" : "ies"} left` : "No deliveries left"}</span></div>${left.map(p => row(p, [p.recipient?.name, p.delivery?.label, Number(p.codAmount) > 0 ? `COD ${money(p.codAmount)}` : "Prepaid", p.statusLabel].filter(Boolean).join(" · "))).join("")}`;
    }
    if (S.key === "return" && c.runId) {
      const run = (returnRuns || []).find(r => r.id === c.runId);
      if (!run) return "";
      const missing = run.parcels.filter(p => !c.checked.has(p.trackingId));
      return `<div class="df-scan-stats" id="dfScanStats"><span data-tone="ok">Returned ${c.checked.size}</span><span data-tone="${missing.length ? "warn" : "ok"}" data-missing-count="${missing.length}">${missing.length ? `${missing.length} to return` : "All returned"}</span></div><p class="panel-subtitle">Return to ${esc(run.merchant.name)} · ${esc(run.merchant.address)}${run.merchant.phone ? ` · ${esc(run.merchant.phone)}` : ""}</p>${missing.map(p => row(p, [p.recipientName, p.returnReason].filter(Boolean).join(" · "))).join("")}`;
    }
    return "";
  }

  function ready() {
    const c = S.ctx;
    return S.key === "pickup" ? !!c.stopKey : S.key === "handover" ? !!c.hubId : S.key === "failed" ? !!c.reason && (c.nextAction === "RETRY" || !!c.hubId) : S.key === "return" ? !!c.runId : true;
  }

  function sessionView() {
    const section = SECTIONS.find(s => s.key === S.key);
    const ok = ready();
    const logRows =
      S.log
        .map(
          l =>
            `<div class="df-scan-row" data-ok="${l.ok}" data-scan-log="${esc(l.id)}"><span><strong>${l.ok ? "✓" : "✗"} ${esc(l.id)}</strong><small>${esc(l.text)} · ${esc(new Date(l.at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }))}</small></span>${
              l.undo && find(carrying(), l.id)?.handover ? `<button type="button" class="button button-sm" data-df-scan-undo="${esc(l.id)}">Undo</button>` : ""
            }</div>`,
        )
        .join("") || `<div class="empty-state">Scanned parcels appear here.</div>`;
    return `<div class="page-heading"><div><p class="eyebrow"><button type="button" class="button button-sm" data-df-scan-back>← All scan actions</button></p><h1 id="dfScanTitle">${esc(section.title)}</h1><p class="subtitle">${esc(section.text)}</p></div></div>
      <div class="layout" id="dfScanSession" data-section="${S.key}"><section class="panel"><div id="dfScanContext">${contextForm(S.key)}</div>
        <form id="dfScanForm" style="margin-top:14px" autocomplete="off"><label for="dfScanInput" style="display:block;font-weight:600;margin-bottom:6px">Scan or type the tracking ID</label><div class="df-scan-box"><input id="dfScanInput" class="table-search" placeholder="${ok ? "Scan the label…" : "Set the options above first"}" ${ok ? "" : "disabled"} autocapitalize="characters" spellcheck="false"><button class="button button-primary" type="submit" ${ok ? "" : "disabled"}>${icon("scan")} Record</button></div></form>
        <p class="panel-subtitle" style="margin-top:8px">${esc(RULE_NOTE[S.key])}</p>
        <div id="dfScanProgress">${ok ? progress() : ""}</div></section>
        <section class="panel"><div class="panel-heading"><div><h2 class="panel-title">This session</h2><p class="panel-subtitle">${S.log.filter(l => l.ok).length} done · ${S.log.filter(l => !l.ok).length} refused</p></div></div><div id="dfScanLog">${logRows}</div></section></div>`;
  }

  /**
   * Redraws the session. The scan box itself is only rebuilt when the section opens (or the page was
   * re-rendered): a scanner typing the next code while the last one is saved must not lose keystrokes.
   */
  function draw() {
    if (!S || page() !== "Scan parcel") return;
    const main = $("mainContent");
    if (!main) return;
    const session = $("dfScanSession");
    if (session && session.dataset.section === S.key) return void update(session);
    const focused = document.activeElement?.id === "dfScanInput" || !document.activeElement || document.activeElement === document.body;
    main.innerHTML = sessionView();
    if ($("dfScanContext")) $("dfScanContext").dataset.html = contextForm(S.key);
    applyContext();
    const input = $("dfScanInput");
    if (input && !input.disabled && focused && !$("actionModal")?.classList.contains("open")) input.focus();
  }

  /** In place: the context form (when it changed and isn't being used), the scan box's state, progress and log. */
  function update(session) {
    const holder = $("dfScanContext");
    const html = contextForm(S.key);
    if (holder && holder.dataset.html !== html && !holder.contains(document.activeElement)) {
      holder.innerHTML = html;
      holder.dataset.html = html;
    }
    applyContext();
    const ok = ready();
    const input = $("dfScanInput");
    const button = q('#dfScanForm button[type="submit"]');
    if (input) {
      input.disabled = !ok;
      input.placeholder = ok ? "Scan the label…" : "Set the options above first";
    }
    if (button) button.disabled = !ok;
    const progressBox = $("dfScanProgress");
    if (progressBox) progressBox.innerHTML = ok ? progress() : "";
    const tmp = document.createElement("div");
    tmp.innerHTML = sessionView();
    for (const id of ["dfScanLog"]) {
      const fresh = tmp.querySelector(`#${id}`);
      if (fresh && $(id)) $(id).innerHTML = fresh.innerHTML;
    }
    const subtitle = session.querySelectorAll(".panel-subtitle");
    const freshSubtitle = tmp.querySelectorAll("#dfScanSession .panel-subtitle");
    if (subtitle.length && freshSubtitle.length) subtitle[subtitle.length - 1].textContent = freshSubtitle[freshSubtitle.length - 1].textContent;
  }

  function applyContext() {
    const c = S.ctx;
    const set = (id, value) => $(id) && value != null && ($(id).value = value);
    set("dfScanStop", c.stopKey);
    set("dfScanHub", c.hubId);
    set("dfScanReason", c.reason);
    set("dfScanNext", c.nextAction);
    set("dfScanNote", c.note);
    set("dfScanRun", c.runId);
    if ($("dfScanHubField")) $("dfScanHubField").hidden = c.nextAction !== "RETURN_TO_HUB";
    const input = $("dfScanInput");
    if (input && !input.disabled) {
      DF.scanner?.attach?.(input, { continuous: true, title: SECTIONS.find(s => s.key === S.key)?.title, label: "Camera", onScan: code => void onScan(code, "CAMERA") });
    }
  }

  async function open(key) {
    if (!SECTIONS.some(s => s.key === key)) return;
    S = { key, ctx: { scanned: new Set(), expected: new Set(), started: new Set(), opened: new Set(), checked: new Set(), hubId: key === "handover" ? myHub()?.id || hubs()[0]?.id : null, nextAction: "RETRY" }, log: [] };
    if (key === "pickup") {
      const stops = [...new Set(pickups().map(p => stopOf(p).key))];
      if (stops.length === 1) chooseStop(stops[0]);
    }
    if (page() !== "Scan parcel") render("Scan parcel");
    else draw();
    if (key === "return") {
      try {
        const load = () => DF.api("/rider/return-runs");
        returnRuns = (Off ? await Off.cached("returnRuns", load) : await load()).items || [];
      } catch (error) {
        returnRuns = [];
        DF.toast?.(DF.describe(error));
      }
      if (S?.key === "return" && returnRuns.length === 1) S.ctx.runId = returnRuns[0].id;
      draw();
    }
  }

  function chooseStop(key) {
    const c = S.ctx;
    c.stopKey = key || null;
    c.scanned = new Set();
    c.expected = new Set();
    const any = [...pickups(), ...carrying()].find(p => stopOf(p).key === key);
    c.name = any ? stopOf(any).name : "";
  }

  // ───────────── wiring ─────────────

  const baseRender = render;
  render = function (name) {
    baseRender(name);
    if (name !== "Scan parcel") return;
    try {
      if (S) draw();
      else q("#mainContent .page-heading")?.insertAdjacentHTML("afterend", cardsPanel());
    } catch (error) {
      console.error("Paira Express: scan actions failed", error);
    }
  };
  // Leaving the page (or tapping "Scan parcel" in the menu again) ends the session.
  window.addEventListener(
    "click",
    event => {
      if (event.target.closest("#navigation [data-page], [data-page-link]")) S = null;
    },
    true,
  );

  window.addEventListener(
    "click",
    event => {
      const card = event.target.closest("[data-df-scan-section]");
      if (card) {
        event.stopImmediatePropagation();
        return void open(card.dataset.dfScanSection);
      }
      if (event.target.closest("[data-df-scan-back]")) {
        event.stopImmediatePropagation();
        S = null;
        return void render("Scan parcel");
      }
      const undoButton = event.target.closest("[data-df-scan-undo]");
      if (undoButton) {
        event.stopImmediatePropagation();
        return void undo(undoButton.dataset.dfScanUndo, "handover");
      }
      if (event.target.closest("[data-df-scan-all]")) {
        event.stopImmediatePropagation();
        return void markAll();
      }
    },
    true,
  );

  async function markAll() {
    if (!S || S.key !== "pickup") return;
    const c = S.ctx;
    const missing = pickups().filter(p => stopOf(p).key === c.stopKey && !c.scanned.has(p.trackingId));
    if (!missing.length) return;
    const ok = await DF.confirm({
      title: `Mark ${missing.length} parcel${missing.length === 1 ? "" : "s"} as picked up?`,
      message: `Only if ${c.name} handed you every one of them: ${missing.map(p => p.trackingId).join(", ")}.`,
      confirm: "Yes, I have them all",
      cancel: "Keep scanning",
    });
    if (!ok) return;
    for (const p of missing) {
      try {
        const outcome = await send(p.trackingId, "pickup", "pickup", { outcome: "COLLECTED", expectedStop: c.stopKey });
        c.scanned.add(p.trackingId);
        log(p.trackingId, true, outcome.queued ? "Picked up (marked without a scan) · saved on this phone" : "Picked up (marked without a scan)");
      } catch (error) {
        log(p.trackingId, false, DF.describe(error));
      }
    }
    await reload();
    draw();
  }

  window.addEventListener(
    "change",
    event => {
      if (!S) return;
      const c = S.ctx;
      const id = event.target.id;
      if (id === "dfScanStop") chooseStop(event.target.value);
      else if (id === "dfScanHub") c.hubId = event.target.value || null;
      else if (id === "dfScanReason") c.reason = event.target.value || null;
      else if (id === "dfScanNext") c.nextAction = event.target.value;
      else if (id === "dfScanNote") c.note = event.target.value.trim();
      else if (id === "dfScanRun") (c.runId = event.target.value || null), (c.checked = new Set());
      else if (id === "dfScanReceivedBy") c.receivedBy = event.target.value;
      else return;
      event.stopImmediatePropagation();
      draw();
      if (ready()) $("dfScanInput")?.focus();
    },
    true,
  );

  window.addEventListener(
    "submit",
    event => {
      if (event.target.id !== "dfScanForm") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const input = $("dfScanInput");
      const code = input?.value;
      if (input) input.value = "";
      void onScan(code, "KEYBOARD");
    },
    true,
  );

  // Fresh task lists (live events, sync) redraw an open session.
  for (const type of ["parcel.updated", "parcel.created"]) DF.events?.on(type, () => S && setTimeout(draw, 600));

  DF.scanSections = { open, get state() { return S; } };

  Promise.resolve(DF.bridgeReady).finally(() => {
    const wanted = new URLSearchParams(location.search).get("scan");
    if (wanted) void open(wanted);
  });
})();
