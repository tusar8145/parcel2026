/*
 * Rider app Settings: verification (KYC) documents and notification settings.
 *
 * - KYC: GET /rider/kyc (status, required documents, what's uploaded), POST /rider/kyc/documents
 *   (photo or PDF of the NID front/back, driving licence, rider photo, vehicle papers),
 *   POST /rider/kyc/submit. Operations review them in Courier Operations → Riders. The profile's
 *   "Verification" pill and an Overview reminder follow the status (live: rider.kyc events).
 * - Notifications: GET/PUT /me/notification-preferences, one switch per event and channel;
 *   security messages are locked on. Until that API exists the panel says so.
 */
(() => {
  const DF = window.DF;
  const $ = id => document.getElementById(id);
  const q = (selector, root = document) => root.querySelector(selector);
  const qa = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const page = () => $("breadcrumbPage")?.textContent;
  const when = iso => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
  const read = (name, path) => (window.DFOffline ? window.DFOffline.cached(name, () => DF.api(path)) : DF.api(path));

  const state = { kyc: null, kycError: null, prefs: null, prefsError: null, saving: false, uploading: null };

  const KYC_STATUS = {
    NOT_STARTED: ["Not submitted", "status-pending"],
    DOCUMENTS_PENDING: ["Documents needed", "status-pending"],
    UNDER_REVIEW: ["Under review", "status-assigned"],
    APPROVED: ["Verified", "status-delivered"],
    REJECTED: ["Needs changes", "status-failed"],
  };
  const DOC_STATUS = { PENDING: ["Waiting for review", "status-assigned"], APPROVED: ["Approved", "status-delivered"], REJECTED: ["Rejected", "status-failed"] };
  const LABEL = { NID_FRONT: "National ID · front", NID_BACK: "National ID · back", DRIVING_LICENSE: "Driving licence", PHOTO: "Your photo", VEHICLE_PAPERS: "Vehicle registration papers" };
  const NUMBER_PROMPT = { NID_FRONT: "NID number (optional)", DRIVING_LICENSE: "Driving licence number (optional)", VEHICLE_PAPERS: "Vehicle registration number (optional)" };
  const tag = ([text, cls]) => `<span class="status ${cls}">${esc(text)}</span>`;

  async function loadKyc() {
    try {
      state.kyc = await read("kyc", "/rider/kyc");
      state.kycError = null;
    } catch (error) {
      state.kycError = error;
    }
  }
  async function loadPrefs() {
    try {
      state.prefs = await DF.api("/me/notification-preferences");
      state.prefsError = null;
    } catch (error) {
      state.prefsError = error;
    }
  }

  // ───────────── KYC ─────────────

  function kycPanel() {
    const k = state.kyc;
    if (!k)
      return `<section class="panel" id="dfKycPanel" style="margin-top:14px"><div class="panel-heading"><div><h2 class="panel-title">Verification documents</h2><p class="panel-subtitle">${esc(state.kycError ? DF.describe(state.kycError) : "Loading…")}</p></div></div></section>`;
    const docs = new Map(k.documents.map(d => [d.type, d]));
    const editable = k.status !== "UNDER_REVIEW";
    const rows = [...k.required, ...k.optional]
      .map(type => {
        const d = docs.get(type);
        const required = k.required.includes(type);
        const status = d ? tag(DOC_STATUS[d.status] || [d.status, "status-pending"]) : `<span class="status ${required ? "status-issue" : "status-pending"}">${required ? "Required" : "Optional"}</span>`;
        const detail = d
          ? `Uploaded ${esc(when(d.uploadedAt))}${d.documentNumber ? ` · No. ${esc(d.documentNumber)}` : ""}${d.status === "REJECTED" && d.rejectionReason ? `<span style="display:block;color:var(--red)">${esc(d.rejectionReason)}</span>` : ""}`
          : "Not uploaded yet";
        const busy = state.uploading === type;
        const action = editable || d?.status === "REJECTED" ? `<button type="button" class="button button-sm" data-df-kyc-upload="${type}" ${busy ? "disabled" : ""}>${busy ? "Uploading…" : d ? "Replace" : "Upload"}</button>` : "";
        const view = d ? `<button type="button" class="button button-sm" data-df-kyc-view="${esc(d.id)}">View</button>` : "";
        return `<div class="earnings-row" style="align-items:flex-start;gap:10px"><span>${esc(LABEL[type] || type)}<small style="display:block;color:#8a94a3;font-weight:500">${detail}</small></span><span style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end">${status}${view}${action}</span></div>`;
      })
      .join("");
    const canSubmit = (k.status === "DOCUMENTS_PENDING" || k.status === "REJECTED" || k.status === "NOT_STARTED") && !k.missing.length;
    const explain =
      k.status === "APPROVED"
        ? "Your documents are approved. Uploading a new one sends it for review again."
        : k.status === "UNDER_REVIEW"
          ? `Sent for review ${esc(when(k.submittedAt))}. Operations will check them shortly; you'll get an SMS with the result.`
          : k.status === "REJECTED"
            ? `Operations asked for changes${k.note ? `: “${esc(k.note)}”` : "."} Replace the rejected documents and send them again.`
            : k.missing.length
              ? `Upload ${esc(k.missing.map(t => LABEL[t] || t).join(", "))}, then send them for review.`
              : "Everything is uploaded. Send your documents for review.";
    return `<section class="panel" id="dfKycPanel" style="margin-top:14px"><div class="panel-heading"><div><h2 class="panel-title">Verification documents</h2><p class="panel-subtitle">${explain}</p></div>${tag(KYC_STATUS[k.status] || [k.status, "status-pending"])}</div><div style="margin-top:12px">${rows}</div><p class="panel-subtitle" style="margin-top:10px">Photos (JPEG, PNG, WebP) or PDF, up to 3.5 MB. Make sure every corner and all text is readable.</p>${
      canSubmit ? `<button type="button" class="button button-primary" style="width:100%;margin-top:12px" data-df-kyc-submit>Send documents for review</button>` : ""
    }<input type="file" id="dfKycFile" accept="image/jpeg,image/png,image/webp,application/pdf" hidden></section>`;
  }

  /** Images are resized (longest side 1600 px) and sent as JPEG; PDFs as they are. */
  function fileToDataUrl(file) {
    if (file.type === "application/pdf") {
      if (file.size > 3.5 * 1024 * 1024) return Promise.reject(new Error("That PDF is larger than 3.5 MB. Scan it at a lower resolution."));
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("That file couldn't be read."));
        reader.readAsDataURL(file);
      });
    }
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return Promise.reject(new Error("Upload a photo (JPEG, PNG or WebP) or a PDF."));
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(image.src);
        resolve(canvas.toDataURL("image/jpeg", 0.88));
      };
      image.onerror = () => reject(new Error("That photo couldn't be read. Try another image."));
      image.src = URL.createObjectURL(file);
    });
  }

  let uploadType = null;
  async function upload(file) {
    const type = uploadType;
    if (!file || !type) return;
    let documentNumber;
    if (NUMBER_PROMPT[type]) {
      const answer = await DF.prompt({ title: LABEL[type] || "Document number", message: "Add the number printed on the document, if you have it.", label: NUMBER_PROMPT[type].replace(/ \(optional\)$/, ""), maxLength: 40, confirm: "Upload" });
      if (answer === null) return;
      documentNumber = answer || undefined;
    }
    state.uploading = type;
    renderPanels();
    try {
      const dataUrl = await fileToDataUrl(file);
      state.kyc = await DF.api("/rider/kyc/documents", { method: "POST", body: { type, file: dataUrl, documentNumber } });
      void window.DFOffline?.save("kyc", state.kyc);
      DF.toast(`${LABEL[type]} uploaded.`);
    } catch (error) {
      DF.toast(error instanceof DF.ApiError ? DF.describe(error) : error.message || DF.describe(error));
    } finally {
      state.uploading = null;
      renderPanels();
    }
  }

  async function viewDocument(id) {
    activeAction = { type: "df-kyc-view", id };
    $("modalTitle").textContent = "Your document";
    $("modalDescription").textContent = "Loading…";
    $("modalFields").innerHTML = "";
    $("submitAction").textContent = "Close";
    $("actionModal").classList.add("open");
    try {
      const file = await DF.api(`/rider-kyc/documents/${encodeURIComponent(id)}/file`, { headers: { accept: "application/json" } });
      if (activeAction?.id !== id) return;
      $("modalDescription").textContent = file.filename;
      $("modalFields").innerHTML = file.mimeType === "application/pdf"
        ? `<div class="field full"><a class="button" href="${esc(file.dataUrl)}" download="${esc(file.filename)}">Download PDF</a></div>`
        : `<div class="field full"><img class="proof-preview" src="${esc(file.dataUrl)}" alt="${esc(file.filename)}" style="display:block;max-width:100%;border-radius:8px"></div>`;
    } catch (error) {
      if (activeAction?.id === id) $("modalDescription").textContent = DF.describe(error);
    }
  }

  // ───────────── notifications ─────────────

  function prefsPanel() {
    const p = state.prefs;
    let body;
    if (!p) {
      const missing = state.prefsError?.status === 404;
      body = `<p class="panel-subtitle" style="margin-top:12px">${state.prefsError ? (missing ? "Notification settings will be available here soon. You'll keep getting delivery and payout messages meanwhile." : esc(DF.describe(state.prefsError))) : "Loading…"}</p>`;
    } else {
      const button = (event, channel, c) => {
        const name = channel === "sms" ? "SMS" : "Email";
        if (!c.available) return `<button type="button" class="button button-sm" disabled title="Switched off for everyone by Paira Express">${name} · off</button>`;
        if (c.locked) return `<button type="button" class="button button-sm" disabled title="Security messages can't be switched off">${name} · always</button>`;
        return `<button type="button" class="button button-sm${c.enabled ? " button-primary" : ""}" data-df-pref-event="${esc(event)}" data-df-pref-channel="${channel}" aria-pressed="${c.enabled}" ${state.saving ? "disabled" : ""}>${name} · ${c.enabled ? "on" : "off"}</button>`;
      };
      // Security messages (codes, alerts) are always sent: listed once instead of as switches.
      const locked = p.events.filter(e => Object.values(e.channels).every(c => c.locked || !c.available));
      body =
        p.events
          .filter(e => !locked.includes(e))
          .map(
            e =>
              `<div class="earnings-row" style="gap:10px"><span>${esc(e.label)}<small style="display:block;color:#8a94a3;font-weight:500">${esc(e.group || "")}</small></span><span style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">${Object.entries(e.channels)
                .map(([channel, c]) => button(e.event, channel, c))
                .join("")}</span></div>`,
          )
          .join("") || `<p class="panel-subtitle" style="margin-top:12px">There are no notifications to set up for your account.</p>`;
      if (locked.length) body += `<p class="panel-subtitle" style="margin-top:10px">Always sent: ${esc(locked.map(e => e.label).join(", "))}.</p>`;
    }
    return `<section class="panel" id="dfPrefsPanel" style="margin-top:14px"><div class="panel-heading"><div><h2 class="panel-title">Notification settings</h2><p class="panel-subtitle">Choose which messages Paira Express sends you</p></div></div><div style="margin-top:8px">${body}</div></section>`;
  }

  async function togglePref(event, channel) {
    const entry = state.prefs?.events.find(e => e.event === event);
    const c = entry?.channels[channel];
    if (!c || c.locked) return;
    state.saving = true;
    c.enabled = !c.enabled;
    renderPanels();
    try {
      const saved = await DF.api("/me/notification-preferences", { method: "PUT", body: { preferences: [{ event, channel, enabled: c.enabled }] } });
      if (saved?.events) state.prefs = saved;
      DF.toast(`${entry.label}: ${channel === "sms" ? "SMS" : "email"} ${c.enabled ? "on" : "off"}.`);
    } catch (error) {
      c.enabled = !c.enabled;
      DF.toast(DF.describe(error));
    } finally {
      state.saving = false;
      renderPanels();
    }
  }

  // ───────────── rendering ─────────────

  function renderPanels() {
    if (page() !== "Settings") return;
    const main = $("mainContent");
    for (const [id, html] of [
      ["dfKycPanel", kycPanel()],
      ["dfPrefsPanel", prefsPanel()],
    ]) {
      const existing = $(id);
      if (existing) existing.outerHTML = html;
      else main.insertAdjacentHTML("beforeend", html);
    }
    // Profile: verification pill follows the KYC status.
    const k = state.kyc;
    for (const row of qa("#mainContent .earnings-row")) {
      const label = q("span", row)?.textContent;
      if (label === "Verification" && k) {
        const pill = q(".status", row);
        if (pill) pill.outerHTML = tag(KYC_STATUS[k.status] || [k.status, "status-pending"]);
      }
      if (label === "Delivery notifications") {
        const button = q("button", row);
        if (button && state.prefs) {
          const all = state.prefs.events.flatMap(e => Object.values(e.channels)).filter(c => c.available);
          button.textContent = `${all.filter(c => c.enabled).length} of ${all.length} on`;
        }
      }
    }
  }

  function overviewReminder() {
    const k = state.kyc;
    if (page() !== "Overview" || !k || !["DOCUMENTS_PENDING", "REJECTED"].includes(k.status) || $("dfKycReminder")) return;
    const heading = q("#mainContent .page-heading");
    heading?.insertAdjacentHTML(
      "afterend",
      `<div class="next-stop" id="dfKycReminder" style="margin-bottom:14px"><div class="next-label">${k.status === "REJECTED" ? "VERIFICATION NEEDS CHANGES" : "FINISH YOUR VERIFICATION"}</div><div class="next-address">${
        k.status === "REJECTED" ? "Replace the rejected documents" : k.missing.length ? `Upload ${esc(k.missing.length)} more document${k.missing.length === 1 ? "" : "s"}` : "Send your documents for review"
      }</div><div class="next-meta">${esc(k.note || "Operations need your NID, photo and vehicle documents to verify you.")}</div><div class="next-actions"><button class="button button-primary button-sm" data-page-link="Settings">Open verification</button></div></div>`,
    );
  }

  const baseRender = render;
  render = function (name) {
    baseRender(name);
    try {
      if (name === "Settings") renderPanels();
      if (name === "Overview") overviewReminder();
    } catch (error) {
      console.error("Paira Express: settings extras failed", error);
    }
  };

  window.addEventListener(
    "click",
    event => {
      const t = event.target;
      const up = t.closest("[data-df-kyc-upload]");
      if (up) {
        event.stopImmediatePropagation();
        uploadType = up.dataset.dfKycUpload;
        const input = $("dfKycFile");
        input.value = "";
        input.click();
        return;
      }
      const view = t.closest("[data-df-kyc-view]");
      if (view) {
        event.stopImmediatePropagation();
        return void viewDocument(view.dataset.dfKycView);
      }
      if (t.closest("[data-df-kyc-submit]")) {
        event.stopImmediatePropagation();
        const button = t.closest("[data-df-kyc-submit]");
        button.disabled = true;
        DF.api("/rider/kyc/submit", { method: "POST" })
          .then(k => {
            state.kyc = k;
            DF.toast("Documents sent for review. You'll get an SMS with the result.");
          })
          .catch(error => DF.toast(DF.describe(error)))
          .finally(renderPanels);
        return;
      }
      const pref = t.closest("[data-df-pref-event]");
      if (pref) {
        event.stopImmediatePropagation();
        return void togglePref(pref.dataset.dfPrefEvent, pref.dataset.dfPrefChannel);
      }
      if (t.closest('[data-action="toggle-notifications"]')) {
        event.stopImmediatePropagation();
        $("dfPrefsPanel")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    },
    true,
  );
  window.addEventListener(
    "change",
    event => {
      if (event.target.id === "dfKycFile") void upload(event.target.files[0]);
    },
    true,
  );
  window.addEventListener(
    "submit",
    event => {
      if (event.target.id !== "actionForm" || activeAction?.type !== "df-kyc-view") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeModal();
    },
    true,
  );

  DF.events.on("rider.kyc", () =>
    loadKyc().then(() => {
      renderPanels();
      overviewReminder();
    }),
  );

  void Promise.all([loadKyc(), loadPrefs()]).then(() => {
    renderPanels();
    overviewReminder();
  });
})();
