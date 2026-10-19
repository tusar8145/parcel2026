/*
 * Hub desk tabs for riders' work done at the hub (not every rider uses the phone app), by one operator working a
 * stack of parcels (POST /hub-desk/…). Everything is on the page (no dialogs); each scan does the step at once, and
 * the fields above apply to the scans that follow.
 * - Pickup entry: a pickup rider brings what they collected: picked up for that rider and received at the hub.
 * - Transfer out: a parcel received here goes to another hub (in transit).
 * - Out for delivery entry: parcels leave with their rider; a parcel still at the hub goes to the rider chosen above.
 * - Delivery entry: the rider hands in the signed slip: delivered for that rider. Optional receiver, note and a photo
 *   of the slip (camera, shrunk in the browser) go with the next scan; a delivered parcel scanned again is updated.
 * - Return rider assign: parcels going back join the chosen rider's run for their merchant; runs are sent out here.
 * - Return entry: the sender took a returned parcel back (Returned; the run completes with its last parcel).
 * - Failed delivery entry: the rider reports a failed attempt: reason and next step (try again / back at the hub).
 * Parcels a rider brings back (failed delivery, unfinished return) are received on Receive entry like any arrival.
 */
(() => {
  const DF = window.DF;
  const Ops = window.DFOps;
  if (!DF || !Ops) return;
  const $ = id => document.getElementById(id);
  const esc = Ops.esc;
  const REASONS = ["Recipient unavailable", "Incorrect address", "Recipient refused", "Unable to contact recipient", "Access / safety issue", "Other"];

  /** Hub desk part (bridge-nav.js) → the tab. */
  const TABS = {
    pickup: {
      path: "pickup",
      title: "Pickup entry",
      subtitle: "A pickup rider brings the parcels they collected: scan each one. It's picked up for that rider and received at this hub.",
      done: ["RECEIVED"],
      counter: "received",
      hub: true,
      hint: "Only parcels given to a pickup rider. Drop-offs are received on Receive entry.",
    },
    transfer: {
      path: "transfer",
      title: "Transfer out",
      subtitle: "Parcels received here that another hub delivers: scan each one and it's on its way there (in transit). The destination is the hub serving the delivery area unless you choose one.",
      done: ["IN_TRANSIT"],
      counter: "sent",
      toHub: true,
      hint: "Parcels already packed in a transfer bag travel with the bag (Transfers). The destination hub receives them on its Receive entry.",
    },
    dispatch: {
      path: "dispatch",
      title: "Out for delivery entry",
      subtitle: "Scan the parcels as the rider leaves. Parcels already given to a rider go out with that rider; a parcel still at the hub goes to the rider chosen here.",
      done: ["OUT_FOR_DELIVERY"],
      counter: "sent out",
      rider: true,
      hint: "The recipient gets the delivery code by SMS when the parcel goes out.",
    },
    delivered: {
      path: "deliver",
      title: "Delivery entry",
      subtitle: "The rider handed in a signed delivery slip: scan it and it's delivered for that rider (cash on delivery stays with the rider for the cash handover).",
      done: ["DELIVERED"],
      counter: "entered",
      proof: true,
      hint: "Each scan marks the parcel delivered at once. The receiver, note and photo above go with the next scan and then clear. Scanning a delivered parcel again updates its details (add the photo later the same way).",
    },
    failed: {
      path: "failed",
      title: "Failed delivery entry",
      subtitle: "The rider couldn't deliver: set the reason and the next step, then scan each parcel. They stay set for the next scans.",
      done: ["RETRY_SCHEDULED", "BACK_AT_HUB"],
      counter: "recorded",
      failure: true,
      hub: true,
      hint: "Try again: the parcel stays with the rider for another attempt. Back at the hub: it's received here for another delivery or a return. A parcel the rider brings back later is received on Receive entry. Re-attempt charges apply as usual.",
    },
    returnassign: {
      path: "return-assign",
      title: "Return rider assign",
      subtitle: "Parcels going back to their merchants: choose the rider, then scan. Each parcel joins that rider's return run for its merchant (one run per merchant). Send the runs out below when the rider leaves.",
      done: ["ASSIGNED"],
      counter: "assigned",
      rider: true,
      riderRequired: true,
      returnReason: true,
      hub: true,
      runs: true,
      hint: "The reason is used only for parcels nobody asked to return yet. When the rider is back, enter what the merchants took on Return entry.",
    },
    returns: {
      path: "return",
      title: "Return entry",
      subtitle: "The rider took returns back to the sender: scan each parcel the sender received. It's returned, and the return run completes with its last parcel.",
      done: ["RETURNED"],
      counter: "returned",
      handover: true,
      hint: "Received by and the note stay set for the next scans (one shop usually takes the whole run). A parcel the sender didn't take is received back on Receive entry.",
    },
  };

  const state = {
    hubId: "",
    riderId: "",
    toHubId: "",
    reason: REASONS[0],
    nextAction: "RETRY",
    receivedBy: "",
    note: "",
    failNote: "",
    returnBy: "",
    returnReason: "",
    runs: null,
    returnNote: "",
    photo: null,
    photoKb: 0,
    log: Object.fromEntries(Object.keys(TABS).map(k => [k, []])),
    count: Object.fromEntries(Object.keys(TABS).map(k => [k, 0])),
    queue: Promise.resolve(),
  };

  document.head.insertAdjacentHTML(
    "beforeend",
    `<style id="dfHubDeskStyles">
      .hd-panel{padding:16px}
      .hd-row{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end}
      .hd-row label{display:grid;gap:4px;font-size:12px;font-weight:600;color:#667085;min-width:180px;flex:1}
      .hd-row input,.hd-row select{height:40px}
      .hd-scan{display:grid;gap:4px;font-size:12px;font-weight:600;color:#667085;margin-top:14px}
      .hd-scan input{width:100%;height:48px;font-size:17px;font-weight:650;letter-spacing:.02em}
      .hd-photo{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
      .hd-photo img{width:64px;height:64px;object-fit:cover;border-radius:8px;border:1px solid var(--line,#e5e9f0)}
      .hd-choice{display:flex;gap:6px;flex-wrap:wrap}
      .hd-choice label{display:flex;align-items:center;gap:6px;min-width:0;flex:none;padding:8px 12px;border:1px solid var(--line,#e5e9f0);border-radius:9px;font-size:13px;color:#344054;cursor:pointer}
      .hd-choice input{height:auto}
      .hd-hint{margin:10px 0 0;color:#667085;font-size:12.5px;line-height:1.45}
      .hd-log{list-style:none;margin:14px 0 0;padding:0;display:grid;gap:5px;max-height:320px;overflow:auto}
      .hd-log li{font-size:13px;padding:7px 10px;border-radius:8px;background:#effaf5;color:#0f5c3f}
      .hd-log li.bad{background:#fff3ee;color:#9a3412}
      .hd-log li.info{background:#f2f4f7;color:#344054}
      .hd-log time{color:#8a94a3;margin-right:8px}
      .hd-count{font-size:12px;font-weight:700;color:#475467;background:#eef1f5;border-radius:999px;padding:3px 10px}
    </style>`,
  );

  /** Hub staff with one hub work there; operations managers and staff of several hubs choose it. */
  const ownHub = () => (Ops.myHubs()?.length === 1 ? Ops.myHubs()[0] : null);

  const logMarkup = part =>
    state.log[part].length
      ? `<ul class="hd-log" id="hdLog">${state.log[part].map(e => `<li class="${e.tone}"><time>${esc(e.at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" }))}</time>${esc(e.message)}</li>`).join("")}</ul>`
      : `<p class="hd-hint" id="hdLog">Scanned parcels appear here.</p>`;

  function fieldsMarkup(part) {
    const t = TABS[part];
    const out = [];
    if (t.hub && !ownHub()) {
      const hubs = Ops.myHubs() || (DF.state.hubs || []).filter(h => h.active !== false);
      out.push(`<label>Hub you're working at<select id="hdHub"><option value="">${part === "pickup" ? "The rider's hub" : "The parcel's hub"}</option>${hubs.map(h => `<option value="${esc(h.id)}" ${h.id === state.hubId ? "selected" : ""}>${esc(h.name)}</option>`).join("")}</select></label>`);
    }
    if (t.toHub) {
      const own = ownHub()?.id;
      const hubs = (DF.state.hubs || []).filter(h => h.active !== false && h.id !== own);
      out.push(`<label>Send to<select id="hdToHub"><option value="">The hub serving the delivery area (automatic)</option>${hubs.map(h => `<option value="${esc(h.id)}" ${h.id === state.toHubId ? "selected" : ""}>${esc(h.type === "FRANCHISE" ? `${h.name} · Franchise` : h.name)}</option>`).join("")}</select></label>`);
    }
    if (t.rider) {
      const riders = (DF.state.riders || []).filter(r => r.active !== false);
      out.push(
        `<label>${t.riderRequired ? "Rider taking the returns" : "Rider"}<select id="hdRider"><option value="">${t.riderRequired ? "— Choose the rider —" : "— Only for parcels still at the hub —"}</option>${riders.map(r => `<option value="${esc(r.id)}" ${r.id === state.riderId ? "selected" : ""}>${esc(`${r.label || `${r.code} · ${r.name}`}${r.hub?.name ? ` · ${r.hub.name}` : ""}`)}</option>`).join("")}</select></label>`,
      );
    }
    if (t.failure) {
      out.push(`<label>Reason<select id="hdReason">${REASONS.map(r => `<option ${r === state.reason ? "selected" : ""}>${esc(r)}</option>`).join("")}</select></label>`);
      out.push(
        `<div style="display:grid;gap:4px;font-size:12px;font-weight:600;color:#667085">Next step<div class="hd-choice" role="radiogroup" aria-label="Next step">${[
          ["RETRY", "Try again (stays with the rider)"],
          ["RETURN_TO_HUB", "Back at the hub"],
        ]
          .map(([v, l]) => `<label><input type="radio" name="hdNext" value="${v}" ${state.nextAction === v ? "checked" : ""}> ${esc(l)}</label>`)
          .join("")}</div></div>`,
      );
      out.push(`<label>Note (optional)<input id="hdFailNote" maxlength="500" autocomplete="off" placeholder="What the rider said" value="${esc(state.failNote)}"></label>`);
    }
    if (t.returnReason) {
      out.push(`<label>Return reason (if none yet)<input id="hdReturnReason" maxlength="300" autocomplete="off" list="hdReasons" placeholder="e.g. Recipient refused" value="${esc(state.returnReason)}"><datalist id="hdReasons">${["Recipient refused", "Recipient unreachable", "Wrong or incomplete address", "Recipient asked to cancel", "Damaged in transit", "Merchant cancelled the order", "Delivery attempts exhausted"].map(r => `<option value="${esc(r)}">`).join("")}</datalist></label>`);
    }
    if (t.handover) {
      out.push(`<label>Received by (optional)<input id="hdReturnBy" maxlength="120" autocomplete="off" placeholder="Who took it back at the sender" value="${esc(state.returnBy)}"></label>`);
      out.push(`<label>Note (optional)<input id="hdReturnNote" maxlength="500" autocomplete="off" placeholder="e.g. Checked and signed by the shop" value="${esc(state.returnNote)}"></label>`);
    }
    if (t.proof) {
      out.push(`<label>Received by (optional)<input id="hdReceivedBy" maxlength="120" autocomplete="off" placeholder="Name on the slip; empty = the recipient" value="${esc(state.receivedBy)}"></label>`);
      out.push(`<label>Note (optional)<input id="hdNote" maxlength="500" autocomplete="off" placeholder="e.g. Signed by the guard" value="${esc(state.note)}"></label>`);
      out.push(
        `<div class="hd-photo"><button type="button" class="button" id="hdTakePhoto">${state.photo ? "Retake photo" : "Take photo of the slip"}</button>${
          state.photo ? `<img id="hdPhotoPreview" src="${state.photo}" alt="Slip photo"><span class="subcell" id="hdPhotoSize">${state.photoKb} KB · goes with the next scan</span><button type="button" class="button button-sm" id="hdDropPhoto">Remove</button>` : ""
        }<input type="file" id="hdPhotoInput" accept="image/*" capture="environment" hidden></div>`,
      );
    }
    return out.length ? `<div class="hd-row">${out.join("")}</div>` : "";
  }

  function tabMarkup(part) {
    const t = TABS[part];
    const where = t.hub && ownHub() ? ` · ${ownHub().name}` : "";
    return `<section class="panel hd-panel" id="hdDesk" data-desk="${part}"><div class="panel-heading" style="padding:0 0 12px"><div><h2 class="panel-title">${esc(t.title)}${esc(where)}</h2><p class="panel-subtitle">${esc(t.subtitle)}</p></div><span class="hd-count" id="hdCount">${state.count[part]} ${esc(t.counter)}</span></div>
      ${fieldsMarkup(part)}
      <label class="hd-scan">Scan or type the tracking ID<input id="hdScan" autocomplete="off" spellcheck="false" placeholder="PP-… or CN" aria-label="Scan a parcel"></label>
      <p class="hd-hint">${esc(t.hint)}</p>
      ${logMarkup(part)}${t.runs ? `<div id="hdRuns" style="margin-top:16px">${runsMarkup()}</div>` : ""}</section>`;
  }

  /** Return rider assign: the hub's planned return runs, each sent out with its rider. */
  function runsMarkup() {
    const r = state.runs;
    if (!r) return `<p class="hd-hint">Loading the planned return runs…</p>`;
    if (r.error) return `<p class="hd-hint">${esc(r.error)}</p>`;
    if (!r.items.length) return `<p class="hd-hint">No planned return run. Scanned parcels make one per merchant and rider.</p>`;
    return `<h3 style="margin:0 0 8px;font-size:14px">Planned return runs</h3><div class="table-scroll"><table><thead><tr><th>RUN</th><th>MERCHANT</th><th>RIDER</th><th>PARCELS</th><th></th></tr></thead><tbody>${r.items
      .map(x => `<tr data-run="${esc(x.number)}"><td><strong>${esc(x.number)}</strong></td><td>${esc(x.merchant?.name || "—")}</td><td>${esc(x.rider || "—")}</td><td>${x.parcels}</td><td><button type="button" class="button button-sm button-primary" data-send-run="${esc(x.id)}">Send out</button></td></tr>`)
      .join("")}</tbody></table></div>`;
  }
  async function loadRuns() {
    const hubId = ownHub()?.id || state.hubId;
    try {
      state.runs = await DF.api(`/hub-desk/return-runs${hubId ? `?hubId=${encodeURIComponent(hubId)}` : ""}`);
    } catch (error) {
      state.runs = { error: DF.describe(error), items: [] };
    }
    const box = $("hdRuns");
    if (box) box.innerHTML = runsMarkup();
  }

  // ───────────── drawing (the page is redrawn on live updates; the state survives) ─────────────

  const onDesk = () => Ops.page() === "Hubs" && !!TABS[Ops.hubPart];
  function mount(focus) {
    const part = Ops.hubPart;
    $("hdDesk")?.remove();
    if (!TABS[part]) return;
    $("mainContent").insertAdjacentHTML("beforeend", tabMarkup(part));
    if (TABS[part].runs && (focus || state.runsEpoch !== Ops.navEpoch)) {
      state.runsEpoch = Ops.navEpoch;
      void loadRuns();
    }
    const input = $("hdScan");
    if (input && DF.scanner) DF.scanner.attach(input, { title: "Scan parcels", label: "Camera", continuous: true, onScan: code => ((input.value = ""), scan(part, code, "CAMERA")) });
    if (input && (focus || !document.activeElement?.closest?.("#hdDesk"))) setTimeout(() => input.focus({ preventScroll: true }), 30);
  }
  const baseHubs = Ops.enhance.Hubs;
  Ops.enhance.Hubs = page => {
    baseHubs?.(page);
    mount(false);
  };

  /** Redraws the log and the counter only (the fields being typed in stay). */
  function paintLog(part) {
    if (!onDesk() || Ops.hubPart !== part || !$("hdDesk")) return;
    $("hdLog")?.remove();
    $("hdDesk").insertAdjacentHTML("beforeend", logMarkup(part));
    const count = $("hdCount");
    if (count) count.textContent = `${state.count[part]} ${TABS[part].counter}`;
  }

  // ───────────── scanning ─────────────

  function scan(part, raw, source = "KEYBOARD") {
    const code = DF.scanner?.normalize ? DF.scanner.normalize(raw) : String(raw || "").trim().toUpperCase();
    if (!code) return;
    const t = TABS[part];
    const hubId = t.hub ? ownHub()?.id || state.hubId || undefined : undefined;
    const body = { code, source };
    if (hubId) body.hubId = hubId;
    if (t.riderRequired && !state.riderId) {
      state.log[part].unshift({ tone: "bad", message: "Choose the rider first, then scan.", at: new Date() });
      return void paintLog(part);
    }
    if (t.rider && state.riderId) body.riderId = state.riderId;
    if (t.returnReason && state.returnReason.trim()) body.reason = state.returnReason.trim();
    if (t.toHub && state.toHubId) body.toHubId = state.toHubId;
    if (t.handover) Object.assign(body, { receivedBy: state.returnBy.trim() || undefined, note: state.returnNote.trim() || undefined });
    if (t.failure) Object.assign(body, { reason: state.reason, nextAction: state.nextAction, note: state.failNote.trim() || undefined });
    const proof = t.proof ? { receivedBy: state.receivedBy, note: state.note, photo: state.photo, photoKb: state.photoKb } : null;
    if (proof) {
      Object.assign(body, { receivedBy: proof.receivedBy.trim() || undefined, note: proof.note.trim() || undefined, photo: proof.photo || undefined });
      // They go with this scan only.
      Object.assign(state, { receivedBy: "", note: "", photo: null, photoKb: 0 });
    }
    state.queue = state.queue.then(async () => {
      let r;
      try {
        r = await DF.api(`/hub-desk/${t.path}`, { method: "POST", body });
      } catch (error) {
        r = { ok: false, message: DF.describe(error) };
      }
      DF.scanner?.feedback?.("hdScan", r.ok, r.message);
      const tone = !r.ok ? "bad" : t.done.includes(r.outcome) || r.outcome === "UPDATED" ? "" : "info";
      state.log[part].unshift({ tone, message: r.message, at: new Date() });
      state.log[part] = state.log[part].slice(0, 100);
      if (r.ok && t.done.includes(r.outcome)) state.count[part]++;
      if (t.runs && r.ok) void loadRuns();
      // Not done: the receiver / note / photo come back for another try.
      if (proof && !r.ok) Object.assign(state, { receivedBy: proof.receivedBy, note: proof.note, photo: proof.photo, photoKb: proof.photoKb });
      if (proof && onDesk() && Ops.hubPart === part) {
        if (proof.photo || !r.ok) mount(true);
        else {
          const rb = $("hdReceivedBy");
          const nt = $("hdNote");
          if (rb && document.activeElement !== rb) rb.value = state.receivedBy;
          if (nt && document.activeElement !== nt) nt.value = state.note;
        }
      }
      paintLog(part);
    });
  }

  /** The camera photo, shrunk: longest side 1280 px, JPEG, about 100–250 KB. */
  function shrink(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("The photo couldn't be read"));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error("That file isn't a photo"));
        img.onload = () => {
          const max = 1280;
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
          let quality = 0.6;
          let url = canvas.toDataURL("image/jpeg", quality);
          while (url.length > 1_000_000 && quality > 0.25) url = canvas.toDataURL("image/jpeg", (quality -= 0.1));
          resolve(url);
        };
        img.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    });
  }

  // ───────────── events ─────────────

  document.addEventListener("keydown", event => {
    if (!onDesk() || event.key !== "Enter" || !(event.target instanceof HTMLInputElement) || event.target.id !== "hdScan") return;
    event.preventDefault();
    const value = event.target.value;
    event.target.value = "";
    scan(Ops.hubPart, value);
  });
  document.addEventListener("input", event => {
    if (!onDesk()) return;
    const id = event.target.id;
    if (id === "hdReceivedBy") state.receivedBy = event.target.value;
    if (id === "hdNote") state.note = event.target.value;
    if (id === "hdFailNote") state.failNote = event.target.value;
    if (id === "hdReturnBy") state.returnBy = event.target.value;
    if (id === "hdReturnNote") state.returnNote = event.target.value;
    if (id === "hdReturnReason") state.returnReason = event.target.value;
  });
  document.addEventListener("change", async event => {
    if (!onDesk()) return;
    const t = event.target;
    if (t.id === "hdHub") {
      state.hubId = t.value;
      if (TABS[Ops.hubPart]?.runs) void loadRuns();
    }
    if (t.id === "hdRider") state.riderId = t.value;
    if (t.id === "hdToHub") state.toHubId = t.value;
    if (t.id === "hdReason") state.reason = t.value;
    if (t.name === "hdNext") state.nextAction = t.value;
    if (t.id === "hdPhotoInput" && t.files?.[0]) {
      try {
        const url = await shrink(t.files[0]);
        Object.assign(state, { photo: url, photoKb: Math.round((url.length * 3) / 4 / 1024) });
        mount(true);
      } catch (error) {
        showToast(error.message);
      }
    }
  });
  window.addEventListener(
    "click",
    event => {
      if (!onDesk() || !(event.target instanceof Element)) return;
      if (event.target.closest("#hdTakePhoto")) {
        event.preventDefault();
        return void $("hdPhotoInput")?.click();
      }
      const send = event.target.closest("[data-send-run]");
      if (send) {
        event.preventDefault();
        send.disabled = true;
        const number = send.closest("tr")?.dataset.run || "";
        return void DF.api(`/returns/runs/${encodeURIComponent(send.dataset.sendRun)}/dispatch`, { method: "POST", body: {} }).then(
          () => {
            state.log[Ops.hubPart].unshift({ tone: "", message: `Return run ${number} is out with its rider.`, at: new Date() });
            paintLog(Ops.hubPart);
            void loadRuns();
          },
          error => {
            send.disabled = false;
            showToast(DF.describe(error));
          },
        );
      }
      if (event.target.closest("#hdDropPhoto")) {
        event.preventDefault();
        Object.assign(state, { photo: null, photoKb: 0 });
        mount(true);
      }
    },
    true,
  );
})();
