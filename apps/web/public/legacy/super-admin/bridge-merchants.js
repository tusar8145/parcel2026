/*
 * Merchant administration in the super admin panel (after bridge.js):
 * - Reject an application with a reason (POST /merchants/:id/reject → merchant.rejected).
 * - Request more information (POST /merchants/:id/request-info → merchant.info_requested); the
 *   applicant answers in their panel and the application returns to review.
 * - Invite a merchant by phone and/or email (POST /merchants/invites → account.invite with a
 *   one-time sign-up link); list and revoke invitations.
 * - KYC: review queue, documents, approve / reject with a reason, and the KYC policy
 *   (what approved KYC is required for).
 * - Internal account notes with author and time (GET/POST /merchants/:id/notes), shown in the
 *   review and account dialogs; the dialogs' note fields are saved as notes.
 */
(() => {
  const DF = window.DF;
  window.DFMerchantAdmin = { version: 1 }; // bridge.js defers reject / invite to this file
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const toast = message => window.showToast(message);
  const fail = error => toast(DF.describe(error));
  const when = iso => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "—");
  const reload = () => window.DFSuperAdminBridge?.reload("merchants", "overview", "audit").catch(fail);
  const canManage = () => !!DF.auth?.user && (DF.auth.user.permissions ? DF.auth.user.permissions.includes("merchant:manage") : true);
  const STATUS_CLASS = { APPROVED: "status-good", PENDING: "status-warn", REJECTED: "status-bad", NOT_SUBMITTED: "status-blue" };
  const KYC_LABEL = { NOT_SUBMITTED: "Not submitted", PENDING: "Awaiting review", APPROVED: "Verified", REJECTED: "Rejected" };
  const pill = (text, cls = "status-blue") => `<span class="status ${cls}">${esc(text)}</span>`;

  /** The API merchant behind a legacy row (registrations and merchants carry it as _api). */
  // eslint-disable-next-line no-undef -- the page script's modal state (a global let).
  const currentModal = () => (typeof modalState !== "undefined" && modalState) || {};
  const apiOf = code => (registrations.find(r => r.id === code) || merchants.find(m => m.id === code))?._api;

  // ───────────── dialog (own overlay; the page's modal stays with its own flows) ─────────────

  function dialog(title, subtitle, body, width = 640) {
    $("dfmDialog")?.remove();
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div id="dfmDialog" role="dialog" aria-modal="true" aria-labelledby="dfmTitle" style="position:fixed;inset:0;z-index:200;background:#0f172a80;display:grid;place-items:center;padding:16px"><section style="width:min(${width}px,100%);max-height:88vh;overflow:auto;background:#fff;border-radius:14px;padding:20px;box-shadow:0 24px 70px #0f172a40"><header style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start"><div><h2 id="dfmTitle" style="margin:0;font-size:18px">${esc(title)}</h2><p style="margin:6px 0 0;color:#64748b;font-size:13px">${subtitle}</p></div><button type="button" class="button button-sm" data-dfm-close aria-label="Close">×</button></header><div id="dfmBody" style="margin-top:14px">${body}</div></section></div>`,
    );
    const el = $("dfmDialog");
    el.addEventListener("click", event => event.target === el && el.remove());
    return el;
  }
  const close = () => $("dfmDialog")?.remove();
  document.addEventListener("keydown", event => event.key === "Escape" && close());

  // ───────────── reject / request information ─────────────

  async function reject(code) {
    const m = apiOf(code);
    if (!m) return;
    const body = dialog(
      `Reject ${m.name}`,
      "The applicant is told by SMS/email with this reason. They can apply again later.",
      `<form id="dfmRejectForm" data-id="${esc(m.id)}"><div class="field full"><label for="dfmRejectReason">Reason (shared with the applicant)</label><textarea id="dfmRejectReason" required minlength="5" maxlength="1000" placeholder="e.g. The trade licence could not be verified"></textarea></div><div class="modal-actions" style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end"><button type="button" class="button" data-dfm-close>Cancel</button><button type="submit" class="button button-danger">Reject application</button></div></form>`,
    );
    DF.validate(body.querySelector("form"), { dfmRejectReason: v => (v.trim().length >= 5 ? "" : "Give a reason of at least 5 characters") });
    $("dfmRejectReason").focus();
  }

  async function requestInfo(code) {
    const m = apiOf(code);
    if (!m) return;
    const body = dialog(
      `Ask ${m.name} for more information`,
      "The applicant gets this message by SMS/email and answers in their merchant panel.",
      `<form id="dfmInfoForm" data-id="${esc(m.id)}"><div class="field full"><label for="dfmInfoMessage">What do you need?</label><textarea id="dfmInfoMessage" required minlength="5" maxlength="2000" placeholder="e.g. Please upload a clearer photo of the trade licence"></textarea></div><div class="modal-actions" style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end"><button type="button" class="button" data-dfm-close>Cancel</button><button type="submit" class="button button-primary">Send request</button></div></form>`,
    );
    DF.validate(body.querySelector("form"), { dfmInfoMessage: v => (v.trim().length >= 5 ? "" : "Write at least 5 characters") });
    $("dfmInfoMessage").focus();
  }

  async function decide(form, path, field, success) {
    const value = $(field).value.trim();
    if (value.length < 5) return toast("Write at least 5 characters.");
    try {
      const key = path === "reject" ? "reason" : "message";
      const m = await DF.api(`/merchants/${form.dataset.id}/${path}`, { method: "POST", body: { [key]: value } });
      close();
      window.closeModal?.();
      await reload();
      toast(success(m));
    } catch (error) {
      fail(error);
    }
  }

  // ───────────── invitations ─────────────

  function enhanceInviteModal() {
    const fields = $("modalFields");
    if (!fields || $("dfmInvitePhone")) return;
    const email = $("inviteEmail");
    if (email) {
      email.required = false;
      email.placeholder = "name@company.example (optional if a mobile number is given)";
    }
    email?.closest(".field")?.insertAdjacentHTML("afterend", `<div class="field"><label for="dfmInvitePhone">Mobile number</label><input id="dfmInvitePhone"></div><div class="field full"><label for="dfmInviteMessage">Personal message (optional)</label><textarea id="dfmInviteMessage" maxlength="500" placeholder="Shown on the invitation"></textarea></div>`);
    // Service plans are retired: the merchant books with its category's default package until one is assigned.
    $("invitePlan")?.closest(".field")?.remove();
    const phone = $("dfmInvitePhone");
    DF.phoneInput(phone);
    phone.required = false;
    $("modalSubmit").textContent = "Send invitation";
    $("modalDescription").textContent = "Sends a one-time sign-up link by SMS and/or email. It expires in 14 days.";
  }

  async function sendInvite() {
    const phone = $("dfmInvitePhone")?.value.trim();
    const email = $("inviteEmail")?.value.trim();
    const name = $("inviteOwner")?.value.trim();
    const businessName = $("inviteBusiness")?.value.trim();
    if (!name || name.length < 2) return toast("Enter the primary contact's name.");
    if (!phone && !email) return toast("Enter a mobile number or an email address.");
    if (phone && DF.phoneProblem(phone)) return toast(DF.phoneProblem(phone));
    const type = /banking|document/i.test($("inviteType")?.value || "") ? "BANKING_FINANCIAL" : "ECOMMERCE";
    try {
      const invite = await DF.api("/merchants/invites", {
        method: "POST",
        body: { name, businessName: businessName || undefined, phone: phone || undefined, email: email || undefined, type, message: $("dfmInviteMessage")?.value.trim() || undefined },
      });
      window.closeModal?.();
      dialog(
        "Invitation sent",
        `${esc(invite.name)}${invite.businessName ? ` · ${esc(invite.businessName)}` : ""} · expires ${esc(when(invite.expiresAt))}`,
        `<p style="font-size:13px;color:#475569">We sent the link by ${[invite.phone && "SMS", invite.email && "email"].filter(Boolean).join(" and ")}. You can also share it yourself; it works once.</p><pre id="dfmInviteLink" style="white-space:pre-wrap;word-break:break-all;background:#f1f5f9;padding:10px;border-radius:8px;font-size:12px">${esc(invite.link)}</pre><div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="button button-sm" data-dfm-copy="#dfmInviteLink">Copy link</button><button type="button" class="button button-primary button-sm" data-dfm-close>Done</button></div>`,
      );
    } catch (error) {
      fail(error);
    }
  }

  async function openInvites() {
    try {
      const page = await DF.api("/merchants/invites?limit=100");
      const cls = { PENDING: "status-warn", ACCEPTED: "status-good", EXPIRED: "status-blue", REVOKED: "status-bad" };
      const rows = page.items
        .map(i => `<tr><td><strong>${esc(i.name)}</strong><div style="color:#64748b;font-size:12px">${esc(i.businessName || "")}</div></td><td>${esc([i.phone, i.email].filter(Boolean).join(" · "))}</td><td>${esc(i.invitedBy)}<div style="color:#64748b;font-size:12px">${esc(when(i.createdAt))}</div></td><td>${esc(when(i.expiresAt))}</td><td>${pill(i.status, cls[i.status])}</td><td>${i.status === "PENDING" && canManage() ? `<button type="button" class="button button-sm" data-dfm-revoke-invite="${esc(i.id)}">Revoke</button>` : ""}</td></tr>`)
        .join("");
      dialog(
        "Merchant invitations",
        "One-time sign-up links sent to prospective merchants.",
        `<div class="table-scroll"><table><thead><tr><th>CONTACT</th><th>SENT TO</th><th>INVITED BY</th><th>EXPIRES</th><th>STATUS</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="6">No invitations yet. Use “Invite merchant”.</td></tr>`}</tbody></table></div>`,
        860,
      );
    } catch (error) {
      fail(error);
    }
  }

  // ───────────── KYC ─────────────

  async function openKycQueue() {
    try {
      const page = await DF.api("/merchants?kycStatus=PENDING&limit=100");
      const rows = page.items
        .map(m => `<tr><td><strong>${esc(m.name)}</strong><div style="color:#64748b;font-size:12px">${esc(m.code)} · ${m.type === "BANKING_FINANCIAL" ? "Banking & Financial merchant" : "E-commerce"}</div></td><td>${esc(when(m.kyc?.submittedAt))}</td><td>${pill(m.status === "ACTIVE" ? "Active" : m.status.replace("_", " ").toLowerCase(), m.status === "ACTIVE" ? "status-good" : "status-warn")}</td><td><button type="button" class="button button-sm button-primary" data-dfm-kyc="${esc(m.id)}">Review documents</button></td></tr>`)
        .join("");
      dialog(
        "KYC reviews",
        "Business documents waiting for a decision.",
        `<div class="table-scroll"><table><thead><tr><th>MERCHANT</th><th>SUBMITTED</th><th>ACCOUNT</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="4">No documents waiting for review.</td></tr>`}</tbody></table></div><div style="display:flex;justify-content:flex-end;margin-top:12px"><button type="button" class="button button-sm" data-dfm-kyc-policy>KYC policy</button></div>`,
        760,
      );
    } catch (error) {
      fail(error);
    }
  }

  async function openKyc(merchantId) {
    try {
      const [k, m] = await Promise.all([DF.api(`/merchants/${merchantId}/kyc`), DF.api(`/merchants/${merchantId}`)]);
      const docs = k.policy.documentTypes
        .map(t => {
          const d = k.documents.find(x => x.type === t.type);
          return `<tr><td><strong>${esc(t.label)}</strong>${t.required ? "" : " <small>(optional)</small>"}</td><td>${d ? `${esc(d.filename)}<div style="color:#64748b;font-size:12px">${esc(when(d.uploadedAt))}</div>` : "—"}</td><td>${d ? `<button type="button" class="button button-sm" data-dfm-doc="${esc(merchantId)}|${esc(d.id)}">View</button>` : pill(t.required ? "Missing" : "Not provided", t.required ? "status-bad" : "status-blue")}</td></tr>`;
        })
        .join("");
      const decision =
        canManage() && (k.status === "PENDING" || k.status === "APPROVED")
          ? `<form id="dfmKycForm" data-id="${esc(merchantId)}" style="margin-top:14px"><div class="field full"><label for="dfmKycReason">Reason if rejecting (shared with the merchant)</label><textarea id="dfmKycReason" maxlength="1000" placeholder="e.g. The NID photo is unreadable"></textarea></div><div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px"><button type="button" class="button button-danger" data-dfm-kyc-decide="REJECT">Reject documents</button>${k.status === "PENDING" ? `<button type="button" class="button button-primary" data-dfm-kyc-decide="APPROVE">Approve KYC</button>` : ""}</div></form>`
          : "";
      dialog(
        `KYC · ${m.name}`,
        `${esc(m.code)} · ${pill(KYC_LABEL[k.status] || k.status, STATUS_CLASS[k.status])}${k.rejectionReason ? ` · ${esc(k.rejectionReason)}` : ""}`,
        `<div class="table-scroll"><table><thead><tr><th>DOCUMENT</th><th>FILE</th><th></th></tr></thead><tbody>${docs}</tbody></table></div>${k.history.length ? `<h3 style="font-size:13px;margin:14px 0 6px">History</h3><ul style="margin:0;padding-left:18px;color:#475569;font-size:12px;line-height:1.7">${k.history.map(h => `<li>${esc(when(h.at))} · ${esc(h.body)}${h.by ? ` — ${esc(h.by)}` : ""}</li>`).join("")}</ul>` : ""}${decision}`,
        720,
      );
    } catch (error) {
      fail(error);
    }
  }

  async function decideKyc(merchantId, decision) {
    const reason = $("dfmKycReason")?.value.trim() || "";
    if (decision === "REJECT" && reason.length < 5) return toast("Give the merchant a reason (at least 5 characters).");
    if (decision === "APPROVE" && !(await DF.confirm({ title: "Approve these business documents?", message: "The merchant is notified.", confirm: "Approve documents" }))) return;
    try {
      await DF.api(`/merchants/${merchantId}/kyc/review`, { method: "POST", body: decision === "APPROVE" ? { decision } : { decision, reason } });
      await openKyc(merchantId);
      await reload();
      toast(decision === "APPROVE" ? "KYC approved. The merchant was notified." : "KYC rejected. The merchant was notified with the reason.");
    } catch (error) {
      fail(error);
    }
  }

  async function viewDocument(merchantId, documentId) {
    try {
      const d = await DF.api(`/merchants/${merchantId}/kyc/documents/${documentId}`);
      const w = window.open("", "_blank");
      if (!w) return toast("Allow pop-ups to view the document.");
      w.document.write(d.mimeType === "application/pdf" ? `<title>${esc(d.filename)}</title><iframe src="${esc(d.dataUrl)}" style="border:0;width:100%;height:100vh"></iframe>` : `<title>${esc(d.filename)}</title><img src="${esc(d.dataUrl)}" style="max-width:100%">`);
      w.document.close();
    } catch (error) {
      fail(error);
    }
  }

  async function openPolicy() {
    try {
      const p = await DF.api("/merchants/kyc-policy");
      const box = (id, label, checked) => `<label style="display:flex;gap:8px;align-items:center;margin:8px 0;font-size:13px"><input type="checkbox" id="${id}" ${checked ? "checked" : ""} ${canManage() ? "" : "disabled"}> ${esc(label)}</label>`;
      dialog(
        "KYC policy",
        "What merchants need verified business documents for.",
        `<form id="dfmPolicyForm">${box("dfmPolicyKeys", "Creating API keys", p.requireForApiKeys)}${box("dfmPolicyPayouts", "Receiving COD payouts", p.requireForCodPayouts)}${box("dfmPolicyActivation", "Approving an application (activation)", p.requireForActivation)}<h3 style="font-size:13px;margin:14px 0 6px">Required documents</h3>${p.documentTypes.map(t => `<label style="display:flex;gap:8px;align-items:center;margin:6px 0;font-size:13px"><input type="checkbox" name="dfmPolicyDoc" value="${t.type}" ${t.required ? "checked" : ""} ${canManage() ? "" : "disabled"}> ${esc(t.label)}</label>`).join("")}<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px"><button type="button" class="button" data-dfm-close>Cancel</button>${canManage() ? `<button type="submit" class="button button-primary">Save policy</button>` : ""}</div></form>`,
        520,
      );
    } catch (error) {
      fail(error);
    }
  }

  async function savePolicy(form) {
    const requiredDocuments = [...form.querySelectorAll('input[name="dfmPolicyDoc"]:checked')].map(i => i.value);
    if (!requiredDocuments.length) return toast("Require at least one document.");
    try {
      await DF.api("/merchants/kyc-policy", { method: "PUT", body: { requireForApiKeys: $("dfmPolicyKeys").checked, requireForCodPayouts: $("dfmPolicyPayouts").checked, requireForActivation: $("dfmPolicyActivation").checked, requiredDocuments } });
      close();
      toast("KYC policy saved.");
    } catch (error) {
      fail(error);
    }
  }

  // ───────────── notes and verification in the review / account dialogs ─────────────

  async function enhanceMerchantModal(type, code) {
    const m = apiOf(code);
    const fields = $("modalFields");
    if (!m || !fields) return;
    // The page's status options don't include the review states; keep them read-only there.
    fields.insertAdjacentHTML(
      "beforeend",
      `<div class="field full" id="dfmPanel"><label>Verification and account history</label><div id="dfmPanelBody" style="font-size:13px;color:#475569">Loading…</div></div>`,
    );
    try {
      const [k, notes] = await Promise.all([DF.api(`/merchants/${m.id}/kyc`), DF.api(`/merchants/${m.id}/notes?limit=20`)]);
      const target = $("dfmPanelBody");
      if (!target) return;
      const items = notes.items
        .map(n => `<li style="margin:6px 0"><strong>${esc(n.author)}</strong> <span style="color:#94a3b8">${esc(when(n.at))} · ${esc({ NOTE: "Internal note", INFO_REQUEST: "Information requested", APPLICANT_RESPONSE: "Applicant replied", STATUS_CHANGE: "Status", KYC: "KYC" }[n.kind] || n.kind)}</span><div>${esc(n.body)}</div></li>`)
        .join("");
      target.innerHTML = `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">KYC ${pill(KYC_LABEL[k.status] || k.status, STATUS_CLASS[k.status])} <button type="button" class="button button-sm" data-dfm-kyc="${esc(m.id)}">Documents (${k.documents.length})</button>${m.status === "REJECTED" && m.rejectionReason ? ` · Rejected: ${esc(m.rejectionReason)}` : ""}${m.status === "INFO_REQUESTED" ? ` ${pill("Waiting for the applicant", "status-warn")}` : ""}</div>${items ? `<ul style="list-style:none;margin:10px 0 0;padding:0;max-height:220px;overflow:auto">${items}</ul>` : `<p style="margin:8px 0 0">No notes yet.</p>`}`;
    } catch (error) {
      const target = $("dfmPanelBody");
      if (target) target.textContent = DF.describe(error);
    }
  }

  /** Saves the dialog's review / account note as an internal note when the dialog is submitted. */
  async function saveDialogNote() {
    const type = currentModal().type;
    const code = currentModal().id;
    const field = type === "registration" ? $("reviewNote") : type === "merchant" ? $("merchantNote") : null;
    const body = field?.value.trim();
    const m = code && apiOf(code);
    if (!body || !m) return;
    try {
      await DF.api(`/merchants/${m.id}/notes`, { method: "POST", body: { body } });
    } catch (error) {
      fail(error);
    }
  }

  // ───────────── wiring ─────────────

  function stop(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  window.addEventListener(
    "click",
    event => {
      const t = event.target;
      if (!(t instanceof Element)) return;
      const hit = sel => t.closest(sel);
      let el;
      if ((el = hit("[data-modal-reject]"))) return stop(event), void reject(el.dataset.modalReject);
      if ((el = hit("[data-modal-info]"))) return stop(event), void requestInfo(el.dataset.modalInfo);
      if (hit("[data-dfm-close]")) return stop(event), close();
      if (hit("#dfmInvites")) return stop(event), void openInvites();
      if (hit("#dfmKycQueue")) return stop(event), void openKycQueue();
      if (hit("[data-dfm-kyc-policy]")) return stop(event), void openPolicy();
      if ((el = hit("[data-dfm-kyc]"))) return stop(event), void openKyc(el.dataset.dfmKyc);
      if ((el = hit("[data-dfm-kyc-decide]"))) return stop(event), void decideKyc(el.closest("form").dataset.id, el.dataset.dfmKycDecide);
      if ((el = hit("[data-dfm-doc]"))) {
        stop(event);
        const [merchantId, documentId] = el.dataset.dfmDoc.split("|");
        return void viewDocument(merchantId, documentId);
      }
      if ((el = hit("[data-dfm-revoke-invite]"))) {
        stop(event);
        const inviteId = el.dataset.dfmRevokeInvite;
        return void DF.confirm({ title: "Revoke this invitation?", message: "The link stops working.", confirm: "Revoke", danger: true }).then(ok => ok && DF.api(`/merchants/invites/${inviteId}`, { method: "DELETE" }).then(openInvites, fail));
      }
      if ((el = hit("[data-dfm-copy]"))) {
        stop(event);
        const text = document.querySelector(el.dataset.dfmCopy)?.textContent || "";
        return void navigator.clipboard?.writeText(text).then(() => toast("Link copied."), () => toast("Select the link and copy it."));
      }
      // The review / account dialog's note is saved when the dialog is submitted (click comes before submit).
      if (hit("#modalSubmit")) void saveDialogNote();
    },
    true,
  );

  window.addEventListener(
    "submit",
    event => {
      const form = event.target;
      if (form.id === "dfmRejectForm") return stop(event), void decide(form, "reject", "dfmRejectReason", m => `${m.name}: application rejected. The applicant was told why.`);
      if (form.id === "dfmInfoForm") return stop(event), void decide(form, "request-info", "dfmInfoMessage", m => `${m.name}: information requested. The application waits for their answer.`);
      if (form.id === "dfmPolicyForm") return stop(event), void savePolicy(form);
      if (form.id === "modalForm" && currentModal().type === "inviteMerchant") return stop(event), void sendInvite();
    },
    true,
  );

  // Extra fields in the page's own dialogs.
  const baseOpenModal = window.openModal;
  window.openModal = openModal = function (type, id) {
    baseOpenModal(type, id);
    if (type === "inviteMerchant") enhanceInviteModal();
    if (type === "registration" || type === "merchant") void enhanceMerchantModal(type, id);
  };

  // Heading buttons: invitations and the KYC queue on the merchant pages.
  const baseShowPage = window.showPage;
  window.showPage = showPage = function (page) {
    baseShowPage(page);
    if (!["Registrations", "Approvals", "Merchants", "E-commerce merchants", "Banking & Financial merchants"].includes(page)) return;
    const actions = document.querySelector("#mainContent .page-heading .heading-actions");
    if (actions && !$("dfmKycQueue")) actions.insertAdjacentHTML("afterbegin", `<button class="button" id="dfmKycQueue">KYC reviews</button><button class="button" id="dfmInvites">Invitations</button>`);
  };

  DF.live(["merchant.updated"], () => window.DFSuperAdminBridge?.reload("merchants"));
})();
