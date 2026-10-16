/*
 * Courier Operations → Riders: rider verification (KYC) review, for people with rider:manage
 * (operations managers, super admins).
 *
 * - A "Rider verification" panel lists riders by KYC status (GET /rider-kyc?status=…; default:
 *   waiting for review), live on rider.kyc events.
 * - "Review" opens the rider's documents (GET /rider-kyc/:riderId; images inline from
 *   GET /rider-kyc/documents/:id/file as JSON). Each document can be approved or rejected with a
 *   reason (POST /rider-kyc/documents/:id/review); the final decision approves the rider or asks
 *   for changes with a note for the rider (POST /rider-kyc/:riderId/decision). The rider gets an
 *   SMS (rider.kyc_status) and sees the status in the rider app.
 */
(() => {
  const DF = window.DF;
  const Ops = window.DFOps;
  const $ = id => document.getElementById(id);
  const esc = Ops.esc;
  const STATUS = {
    UNDER_REVIEW: ["Waiting for review", "status-transit"],
    DOCUMENTS_PENDING: ["Documents needed", "status-pending"],
    REJECTED: ["Needs changes", "status-failed"],
    APPROVED: ["Verified", "status-delivered"],
    NOT_STARTED: ["Not started", "status-pending"],
  };
  const DOC = { PENDING: ["Pending", "status-pending"], APPROVED: ["Approved", "status-delivered"], REJECTED: ["Rejected", "status-failed"] };
  const VEHICLE = { MOTORBIKE: "Motorcycle", BICYCLE: "Bicycle", VAN: "Van", ON_FOOT: "On foot" };
  const tag = ([text, cls]) => `<span class="status ${cls}">${esc(text)}</span>`;
  let filter = "UNDER_REVIEW";
  let detail = null; // the rider under review
  const files = new Map(); // document id → data URL (kept while the dialog is open)

  const canReview = () => Ops.can("manageRiders");
  const queue = () => Ops.lazy(`rider-kyc:${filter}`, () => DF.api(`/rider-kyc?status=${filter}`), 30000);

  function panel() {
    const rows = queue();
    const error = Ops.lazyError(`rider-kyc:${filter}`);
    const body =
      (rows || [])
        .map(
          r =>
            `<tr><td><strong>${esc(r.code)} · ${esc(r.name)}</strong><span class="subcell">${esc(DF.localPhone(r.phone))}</span></td><td>${esc(r.hub?.name || "—")}</td><td>${esc(VEHICLE[r.vehicle] || r.vehicle)}</td><td>${r.documents.total}${r.documents.rejected ? ` · ${r.documents.rejected} rejected` : r.documents.pending ? ` · ${r.documents.pending} to check` : ""}</td><td>${esc(Ops.when(r.submittedAt || r.startedAt))}</td><td>${tag(STATUS[r.status] || [r.status, "status-pending"])}</td><td><button class="button button-sm" data-rider-kyc="${esc(r.riderId)}">Review</button></td></tr>`,
        )
        .join("") || `<tr><td colspan="7" class="empty-state">${error ? esc(DF.describe(error)) : rows ? "No riders in this list." : "Loading…"}</td></tr>`;
    const options = Object.entries(STATUS)
      .filter(([k]) => k !== "NOT_STARTED")
      .map(([k, [label]]) => `<option value="${k}" ${k === filter ? "selected" : ""}>${esc(label)}</option>`)
      .join("");
    return `<section class="panel table-panel" id="riderKycPanel"><div class="panel-heading"><div><h2 class="panel-title">Rider verification</h2><p class="panel-subtitle">KYC documents uploaded by riders · approve or ask for changes</p></div><select id="riderKycFilter" aria-label="Verification status">${options}</select></div><div class="table-scroll"><table><thead><tr><th>RIDER</th><th>HUB</th><th>VEHICLE</th><th>DOCUMENTS</th><th>SUBMITTED</th><th>STATUS</th><th></th></tr></thead><tbody>${body}</tbody></table></div></section>`;
  }

  const baseRiders = Ops.enhance.Riders;
  Ops.enhance.Riders = page => {
    baseRiders?.(page);
    if (!canReview()) return;
    $("riderKycPanel")?.remove();
    $("mainContent").insertAdjacentHTML("beforeend", panel());
  };

  // ───────────── review dialog ─────────────

  async function loadFile(id) {
    if (files.has(id)) return files.get(id);
    const file = await DF.api(`/rider-kyc/documents/${id}/file`, { headers: { accept: "application/json" } });
    files.set(id, file);
    return file;
  }

  function fill() {
    const d = detail;
    if (!d) return;
    $("modalTitle").textContent = `Verification · ${d.rider.code} · ${d.rider.name}`;
    $("modalDescription").textContent = `${tagText(d.status)} · ${VEHICLE[d.rider.vehicle] || d.rider.vehicle} · ${DF.localPhone(d.rider.phone)}${d.missing.length ? ` · missing: ${d.missing.map(t => labelOf(d, t)).join(", ")}` : ""}`;
    const docs =
      d.documents
        .map(doc => {
          const file = files.get(doc.id);
          const preview = !file
            ? `<button type="button" class="button button-sm" data-kyc-preview="${esc(doc.id)}">Show</button>`
            : file.mimeType === "application/pdf"
              ? `<a class="button button-sm" href="${esc(file.dataUrl)}" download="${esc(file.filename)}">Download PDF</a>`
              : `<img src="${esc(file.dataUrl)}" alt="${esc(doc.label)}" style="display:block;max-width:100%;max-height:320px;margin-top:8px;border-radius:8px;border:1px solid #e3e7ed">`;
          return `<div style="padding:10px 0;border-bottom:1px solid #eef1f5"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap"><strong>${esc(doc.label)}${doc.documentNumber ? ` · ${esc(doc.documentNumber)}` : ""}</strong><span style="display:flex;gap:6px;align-items:center">${tag(DOC[doc.status] || [doc.status, "status-pending"])}<button type="button" class="button button-sm" data-kyc-doc="${esc(doc.id)}" data-kyc-decision="APPROVE" ${doc.status === "APPROVED" ? "disabled" : ""}>Approve</button><button type="button" class="button button-sm button-danger" data-kyc-doc="${esc(doc.id)}" data-kyc-decision="REJECT" ${doc.status === "REJECTED" ? "disabled" : ""}>Reject</button></span></div><small style="color:#7a8696">Uploaded ${esc(Ops.when(doc.uploadedAt))}${doc.expiresAt ? ` · expires ${esc(new Date(doc.expiresAt).toLocaleDateString())}` : ""}${doc.rejectionReason ? ` · ${esc(doc.rejectionReason)}` : ""}</small>${preview}</div>`;
        })
        .join("") || `<div class="empty-state">No documents uploaded yet.</div>`;
    $("modalFields").innerHTML = `<div class="field full">${docs}</div><div class="field full"><label for="kycNote">Note for the rider (required to ask for changes)</label><textarea id="kycNote" maxlength="500" placeholder="e.g. Your NID photo is blurred; please retake it in daylight">${esc(d.note || "")}</textarea></div><div class="field full"><button type="button" class="button button-danger" data-kyc-final="REJECT">Ask for changes</button></div>`;
    $("modalSubmit").textContent = "Approve rider";
    $("modalSubmit").disabled = d.status === "APPROVED";
  }
  const tagText = s => (STATUS[s] || [s])[0];
  const labelOf = (d, type) => d.documents.find(x => x.type === type)?.label || type.replace(/_/g, " ").toLowerCase();

  Ops.modals.riderKyc = async riderId => {
    if (!Ops.require("manageRiders", "review rider documents")) return;
    files.clear();
    try {
      detail = await DF.api(`/rider-kyc/${riderId}`);
    } catch (error) {
      return void showToast(DF.describe(error));
    }
    modalContext = { kind: "riderKyc", shipmentId: riderId };
    fill();
    $("modalBackdrop").classList.add("open");
    // Load images in the background (they're small: resized on the phone).
    for (const doc of detail.documents.filter(d => d.file.mimeType !== "application/pdf")) {
      loadFile(doc.id)
        .then(() => modalContext.kind === "riderKyc" && fill())
        .catch(() => undefined);
    }
  };

  async function act(work, message) {
    try {
      detail = await work();
      Ops.invalidate(`rider-kyc:${filter}`);
      if (modalContext.kind === "riderKyc") fill();
      showToast(message);
      return true;
    } catch (error) {
      showToast(DF.describe(error));
      return false;
    }
  }

  window.addEventListener(
    "click",
    event => {
      const t = event.target;
      const open = t.closest("[data-rider-kyc]");
      if (open) {
        event.stopImmediatePropagation();
        return void openModal("riderKyc", open.dataset.riderKyc);
      }
      if (modalContext.kind !== "riderKyc") return;
      const preview = t.closest("[data-kyc-preview]");
      if (preview) {
        event.stopImmediatePropagation();
        preview.disabled = true;
        return void loadFile(preview.dataset.kycPreview)
          .then(fill)
          .catch(error => showToast(DF.describe(error)));
      }
      const doc = t.closest("[data-kyc-doc]");
      if (doc) {
        event.stopImmediatePropagation();
        const decision = doc.dataset.kycDecision;
        const reason = decision === "REJECT" ? prompt("Why is this document rejected? The rider sees this.", "") : undefined;
        if (decision === "REJECT" && !reason?.trim()) return;
        return void act(() => DF.api(`/rider-kyc/documents/${doc.dataset.kycDoc}/review`, { method: "POST", body: { decision, reason: reason?.trim() } }), decision === "APPROVE" ? "Document approved." : "Document rejected.");
      }
      if (t.closest('[data-kyc-final="REJECT"]')) {
        event.stopImmediatePropagation();
        const note = $("kycNote").value.trim();
        if (!note) {
          $("kycNote").focus();
          return void showToast("Tell the rider what to fix before asking for changes.");
        }
        void act(() => DF.api(`/rider-kyc/${detail.rider.id}/decision`, { method: "POST", body: { decision: "REJECT", note } }), `${detail.rider.code} asked to update their documents.`).then(ok => ok && closeModal());
      }
    },
    true,
  );

  window.addEventListener(
    "submit",
    event => {
      if (event.target.id !== "modalForm" || modalContext.kind !== "riderKyc") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const note = $("kycNote").value.trim() || undefined;
      const button = $("modalSubmit");
      button.disabled = true;
      void act(() => DF.api(`/rider-kyc/${detail.rider.id}/decision`, { method: "POST", body: { decision: "APPROVE", note } }), `${detail.rider.code} is verified.`)
        .then(ok => ok && closeModal())
        .finally(() => (button.disabled = false));
    },
    true,
  );

  window.addEventListener(
    "change",
    event => {
      if (event.target.id !== "riderKycFilter") return;
      filter = event.target.value;
      Ops.rerender(true);
    },
    true,
  );

  DF.live(["rider.kyc"], async () => {
    Ops.invalidate(`rider-kyc:${filter}`);
    if (Ops.page() === "Riders") Ops.rerender();
  });
})();
