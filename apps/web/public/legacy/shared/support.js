/*
 * Support tickets on every page: website customers, riders and merchants see their own tickets;
 * support staff (support:manage — operations managers, support agents, super admins) work the
 * inbox in Courier Operations. Data comes from the API (/support/tickets); the page markup and
 * styles are the original demo's.
 *
 * - Lists reload on live ticket.updated events (DF.live, with a slow safety poll); a re-render
 *   never discards a reply or ticket that is being written.
 * - Staff: SLA state per ticket (first response / resolution targets, breaches), canned
 *   responses inserted into replies (and saved from a reply), partner-application review on
 *   application tickets. Requesters: a 1–5 satisfaction rating once a ticket is resolved.
 * - Attachments are fetched with the access token (GET /files/:id as JSON) and saved from a blob URL,
 *   because the token lives in memory, not in a cookie.
 * - Rider: the "Request a dispatch callback" dialog (rider/02.js) creates real tickets, and the
 *   "My support requests" list on Help & safety shows the rider's tickets.
 */
(() => {
  const DF = window.DF;
  // The website's route as "#/support/…" (real paths since the History API switch; see DF.route).
  const routeHash = () => (DF.route ? DF.route.hash() : location.hash);
  const statuses = ["Open", "In progress", "Waiting for requester", "Resolved", "Closed"];
  const categories = ["Delivery issue", "Pickup or collection", "COD / payment", "Account / API", "Rider or safety", "Other"];
  const priorities = [["LOW", "Low"], ["NORMAL", "Normal"], ["HIGH", "High"], ["URGENT", "Urgent"]];
  // packages/shared/src/roles.ts: support:manage and support:create.
  const STAFF_ROLES = ["SUPER_ADMIN", "OPS_MANAGER", "SUPPORT_AGENT"];
  const REQUESTER_ROLES = ["CUSTOMER", "MERCHANT_OWNER", "MERCHANT_STAFF", "RIDER", "HUB_OPERATOR", ...STAFF_ROLES];
  const maxAttachmentBytes = 5 * 1024 * 1024;
  // What support attachments may be (the API checks each file's content matches its extension).
  const attachmentExtensions = ["png", "jpg", "jpeg", "webp", "gif", "heic", "heif", "pdf", "doc", "docx", "xls", "xlsx", "csv", "ppt", "pptx", "txt"];
  const maxAttachments = 5;
  const POLL_MS = 15000;
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char]));
  const app = document.body.dataset.app;
  /** Which page this is (layout, renderer, navigation). */
  const role = app === "website" ? "customer"
    : app === "rider" ? "rider"
      : app === "courier-operation" ? "operations"
        : "merchant";
  const me = () => DF?.auth.user || null;
  const canUseSupport = () => !!me() && DF.auth.hasRole(...REQUESTER_ROLES);
  /** The operations inbox (every ticket) instead of "my tickets". */
  const inbox = () => role === "operations" && DF.auth.hasRole(...STAFF_ROLES);
  const when = iso => (iso ? new Date(iso).toLocaleString() : "");
  let selectedTicketId = "";
  let composerOpen = role === "customer";
  let prefilled = {};
  let handledHash = "";
  /** A ticket asked for by a link (?ticket=, a notification) until the tickets have loaded. */
  let wantedTicket = "";

  // ───────────── data ─────────────

  const store = { userId: null, loaded: false, loading: null, error: "", json: "", tickets: [], details: new Map(), assignees: null, canned: null, applications: new Map() };

  function resetStore(userId = null) {
    Object.assign(store, { userId, loaded: false, loading: null, error: "", json: "", tickets: [], details: new Map(), assignees: null, canned: null, applications: new Map() });
    selectedTicketId = "";
  }

  /** API ticket -> what the original markup renders. */
  function toView(t) {
    return {
      id: t.number,
      status: t.statusLabel,
      statusCode: t.status,
      priority: t.priority,
      subject: t.subject,
      category: t.category,
      relatedRef: t.relatedRef || "",
      requesterId: t.requester.id,
      requesterName: t.requester.name,
      requesterPhone: DF.localPhone(t.requester.phone || ""),
      assignee: t.assignee,
      preview: t.lastMessage?.preview || "",
      messageCount: t.messageCount,
      createdAtIso: t.createdAt,
      updatedAtIso: t.updatedAt,
      updatedAt: when(t.updatedAt),
      updatedAtMs: Date.parse(t.updatedAt) || 0,
      sla: t.sla || null,
      survey: t.survey || null,
    };
  }

  async function fetchTickets() {
    const all = [];
    let cursor = null;
    do {
      const page = await DF.api(`/support/tickets?limit=200${cursor ? `&cursor=${cursor}` : ""}`);
      all.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor && all.length < 1000);
    return all;
  }

  /** Reloads the visible tickets; resolves to true if anything changed. */
  async function reload() {
    const user = me();
    if (!user || !canUseSupport()) {
      if (store.userId) resetStore();
      return false;
    }
    if (store.userId !== user.id) resetStore(user.id);
    const items = await fetchTickets();
    if (me()?.id !== user.id) return false; // signed out meanwhile
    // Staff see every ticket from the API; outside the inbox they see only their own.
    const visible = inbox() ? items : items.filter(t => t.requester.id === user.id);
    const json = JSON.stringify(visible);
    const changed = json !== store.json || !!store.error;
    store.json = json;
    store.tickets = visible.map(toView);
    store.loaded = true;
    store.error = "";
    for (const t of store.tickets) {
      const detail = store.details.get(t.id);
      if (detail && detail.updatedAt !== t.updatedAtIso) store.details.delete(t.id);
    }
    return changed;
  }

  /** Loads the tickets once per signed-in user; resolves to true when the page should re-render. */
  function ensureLoaded() {
    const user = me();
    if (!user || !canUseSupport()) return Promise.resolve(false);
    if (store.loaded && store.userId === user.id) return Promise.resolve(false);
    store.loading ??= reload()
      .then(() => true)
      .catch(error => {
        console.error("Support tickets could not be loaded.", error);
        store.userId = user.id;
        store.loaded = true;
        store.error = DF.describe(error);
        return true;
      })
      .finally(() => (store.loading = null));
    return store.loading;
  }

  const loadingDetails = new Set();
  /** Fetches a conversation and re-renders when it arrives. */
  function ensureDetail(number) {
    if (!number || store.details.has(number) || loadingDetails.has(number)) return;
    loadingDetails.add(number);
    DF.api(`/support/tickets/${encodeURIComponent(number)}`)
      .then(detail => {
        store.details.set(number, detail);
        if (selectedTicketId === number) renderIfIdle();
      })
      .catch(error => {
        console.error("Support conversation could not be loaded.", error);
        toast(DF.describe(error));
      })
      .finally(() => loadingDetails.delete(number));
  }

  function loadAssignees() {
    loadCanned();
    if (store.assignees || !inbox()) return;
    store.assignees = [];
    DF.api("/support/assignees")
      .then(rows => {
        store.assignees = rows;
        renderIfIdle();
      })
      .catch(error => {
        store.assignees = null;
        console.error("Support assignees could not be loaded.", error);
      });
  }

  function loadCanned() {
    if (store.canned || !inbox()) return;
    store.canned = [];
    DF.api("/support/canned-responses")
      .then(rows => {
        store.canned = rows;
        renderIfIdle();
      })
      .catch(error => {
        store.canned = null;
        console.error("Canned responses could not be loaded.", error);
      });
  }

  const APPLICATION_CATEGORIES = ["Rider application", "Franchise application"];
  /** The partner application behind an application ticket (staff). */
  function ensureApplication(number) {
    if (store.applications.has(number)) return store.applications.get(number);
    store.applications.set(number, null);
    DF.api(`/applications/${encodeURIComponent(number)}`)
      .then(app => {
        store.applications.set(number, app);
        if (selectedTicketId === number) renderIfIdle();
      })
      .catch(() => undefined);
    return null;
  }

  function toast(message) {
    if (typeof window.showToast === "function") window.showToast(message);
    else console.info(message);
  }

  function visibleTickets() {
    return store.tickets;
  }

  function statusClass(status) {
    return status === "Resolved" || status === "Closed" ? "done"
      : status === "In progress" ? "active" : status === "Waiting for requester" ? "waiting" : "open";
  }

  // ───────────── markup ─────────────

  function attachmentMarkup(attachments = []) {
    return attachments.map(file => `<a class="st-attachment" href="/api/v1/files/${escapeHtml(file.id)}" data-support-file="${escapeHtml(file.id)}" data-file-name="${escapeHtml(file.filename)}" download="${escapeHtml(file.filename)}">${escapeHtml(file.filename)}</a>`).join("");
  }

  /** Staff: SLA state of a ticket. */
  function slaBadge(ticket) {
    const sla = ticket.sla;
    if (!sla || sla.state === "done" || sla.state === "on_track") return "";
    return sla.state === "breached" ? `<span class="st-badge st-sla-breach">SLA breached</span> ` : `<span class="st-badge waiting">SLA paused</span> `;
  }

  function slaLine(ticket) {
    const sla = ticket.sla;
    if (!sla) return "";
    const parts = [];
    parts.push(sla.firstResponseAt ? `First response ${escapeHtml(when(sla.firstResponseAt))}${sla.firstResponseBreached ? " (late)" : ""}` : `First response due ${escapeHtml(when(sla.firstResponseDueAt))}`);
    if (!["Resolved", "Closed"].includes(ticket.status)) parts.push(sla.paused ? "Resolution clock paused (waiting for requester)" : `Resolve by ${escapeHtml(when(sla.resolutionDueAt))}`);
    if (sla.escalationLevel) parts.push(`Escalated ×${sla.escalationLevel}`);
    return `<p class="st-sla ${sla.state === "breached" ? "breach" : ""}">${parts.join(" · ")}</p>`;
  }

  /** Requester: rate a resolved ticket once. */
  function csatMarkup(ticket) {
    if (inbox() || !["Resolved", "Closed"].includes(ticket.status)) return "";
    const survey = ticket.survey;
    if (survey?.rating) return `<div class="st-csat"><strong>Thanks for your feedback</strong><span>You rated this conversation ${"★".repeat(survey.rating)}${"☆".repeat(5 - survey.rating)}</span></div>`;
    return `<form class="st-csat" data-support-csat="${escapeHtml(ticket.id)}"><strong>How did we do?</strong><span class="st-stars">${[1, 2, 3, 4, 5].map(n => `<label><input type="radio" name="rating" value="${n}" required> ${n}★</label>`).join("")}</span><input name="comment" maxlength="1000" placeholder="Anything we could do better? (optional)"><button class="button button-sm" type="submit">Send rating</button></form>`;
  }

  /** Staff: application status and decisions on application tickets. */
  function applicationMarkup(ticket) {
    if (!inbox() || !APPLICATION_CATEGORIES.includes(ticket.category)) return "";
    const app = ensureApplication(ticket.id);
    if (!app) return `<p class="st-note">Loading application…</p>`;
    const labels = { UNDER_REVIEW: "Start review", INFO_REQUESTED: "Request information", APPROVED: app.kind === "RIDER" ? "Approve & create rider" : "Approve", REJECTED: "Reject" };
    const details = Object.entries(app.details || {})
      .map(([k, v]) => `<span><em>${escapeHtml(k)}</em> ${escapeHtml(v)}</span>`)
      .join("");
    return `<div class="st-application"><strong>${app.kind === "RIDER" ? "Rider" : "Franchise"} application · ${escapeHtml(app.statusLabel)}</strong><div class="st-app-details">${details}</div>${app.decisionNote ? `<p class="st-note">${escapeHtml(app.decisionNote)}</p>` : ""}<div class="st-app-actions">${(app.allowedNext || [])
      .map(s => `<button type="button" class="button button-sm" data-application-status="${s}" data-application-number="${escapeHtml(app.number)}">${labels[s] || s}</button>`)
      .join("")}</div></div>`;
  }

  function cannedPicker() {
    if (!inbox()) return "";
    const rows = store.canned || [];
    return `<select data-support-canned aria-label="Insert a canned response"><option value="">Insert canned response…</option>${rows.map(r => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.title)}${r.shortcut ? ` (/${escapeHtml(r.shortcut)})` : ""}</option>`).join("")}</select><button type="button" class="button button-sm" data-support-save-canned>Save as canned</button>`;
  }

  function ticketCard(ticket) {
    return `<button type="button" class="st-ticket ${selectedTicketId === ticket.id ? "selected" : ""}" data-support-open="${escapeHtml(ticket.id)}">
      <span class="st-ticket-top"><strong>${escapeHtml(ticket.id)}</strong><span>${slaBadge(ticket)}<span class="st-badge ${statusClass(ticket.status)}">${escapeHtml(ticket.status)}</span></span></span>
      <strong class="st-ticket-subject">${escapeHtml(ticket.subject)}</strong>
      <span class="st-ticket-meta">${escapeHtml(ticket.requesterName)} · ${escapeHtml(ticket.category)}${ticket.relatedRef ? ` · ${escapeHtml(ticket.relatedRef)}` : ""}</span>
      <span class="st-ticket-meta">${escapeHtml(ticket.preview)}</span>
      <small>${escapeHtml(ticket.updatedAt)} · ${ticket.messageCount} message${ticket.messageCount === 1 ? "" : "s"}</small>
    </button>`;
  }

  function composerMarkup() {
    if (!composerOpen) return "";
    const customerProfile = window.deliveryFastCustomerSession || {};
    const customerFields = role === "customer" ? `<label>Your name<input name="requesterName" required maxlength="80" value="${escapeHtml(prefilled.requesterName || customerProfile.name || "")}" autocomplete="name"></label>
      <label>Phone number<input name="requesterPhone" required maxlength="32" value="${escapeHtml(prefilled.requesterPhone || customerProfile.phone || "")}" autocomplete="tel"></label>` : "";
    return `<form class="st-composer" data-support-ticket-form>
      <div class="st-form-grid">
        ${customerFields}
        <label class="st-span">Subject<input name="subject" required minlength="3" maxlength="120" value="${escapeHtml(prefilled.subject || "")}" placeholder="Briefly describe the issue"></label>
        <label>Category<select name="category" required>${categories.map(category => `<option ${prefilled.category === category ? "selected" : ""}>${category}</option>`).join("")}</select></label>
        <label>Priority<select name="priority"><option>Normal</option><option ${prefilled.priority === "High" ? "selected" : ""}>High</option><option>Low</option></select></label>
        <label class="st-span">Tracking or reference number <span class="st-optional">(optional)</span><input name="relatedRef" maxlength="40" value="${escapeHtml(prefilled.relatedRef || "")}" placeholder="e.g. PP-28491"></label>
        <label class="st-span">Message<textarea name="message" required maxlength="3000" rows="4" placeholder="Tell us what happened and how we can help"></textarea></label>
        <label class="st-span">Attachments <span class="st-optional">(optional)</span><input name="attachments" type="file" accept="image/*,.heic,.heif,.pdf,.doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx,.txt" multiple data-file-drop data-file-hint="Photos, PDF, Word, Excel, PowerPoint, CSV or text · up to 5 files, 5 MB each"></label>
      </div>
      <div class="st-actions"><span class="st-note">Courier operations replies in this conversation.</span><button class="button button-primary" type="submit">Create support ticket</button></div>
    </form>`;
  }

  function messageMarkup(message, viewerId) {
    const system = message.author.kind === "system";
    const name = system ? "Paira Express support" : message.author.label;
    return `<article class="st-message ${message.author.id && message.author.id === viewerId ? "mine" : ""} ${message.internal ? "internal" : ""}">
      <div class="st-message-head"><strong>${escapeHtml(name)}${message.internal ? ` <em class="st-internal-tag">Internal note</em>` : ""}</strong><span>${escapeHtml(when(message.createdAt))}</span></div>
      <p>${escapeHtml(message.body)}</p><div class="st-files">${attachmentMarkup(message.attachments)}</div>
    </article>`;
  }

  function staffControls(ticket) {
    const statusControl = `<label class="st-status-control">Ticket status<select data-support-status="${escapeHtml(ticket.id)}">${statuses.map(status => `<option ${ticket.status === status ? "selected" : ""}>${status}</option>`).join("")}</select></label>`;
    const priorityControl = `<label class="st-status-control">Priority<select data-support-priority="${escapeHtml(ticket.id)}">${priorities.map(([value, label]) => `<option value="${value}" ${ticket.priority === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>`;
    const people = [...(store.assignees || [])];
    if (ticket.assignee && !people.some(person => person.id === ticket.assignee.id)) people.unshift(ticket.assignee);
    const self = me();
    if (self && !people.some(person => person.id === self.id)) people.unshift({ id: self.id, name: self.name });
    const assigneeControl = `<label class="st-status-control">Assigned to<select data-support-assignee="${escapeHtml(ticket.id)}"><option value="">Unassigned</option>${people.map(person => `<option value="${escapeHtml(person.id)}" ${ticket.assignee?.id === person.id ? "selected" : ""}>${escapeHtml(person.id === self?.id ? `${person.name} (me)` : person.name)}</option>`).join("")}</select></label>`;
    return `<div class="st-controls">${statusControl}${priorityControl}${assigneeControl}</div>`;
  }

  function threadMarkup(ticket) {
    if (!ticket) return `<div class="st-empty"><strong>Select a support ticket</strong><p>Choose a ticket from the list to view its conversation and reply.</p></div>`;
    const detail = store.details.get(ticket.id);
    const viewerId = me()?.id;
    const messages = detail ? detail.messages.map(message => messageMarkup(message, viewerId)).join("") : `<p class="st-note">Loading conversation…</p>`;
    const staff = inbox();
    const requesterPhone = staff && ticket.requesterPhone ? ` · ${escapeHtml(ticket.requesterPhone)}` : "";
    const operationControls = staff ? staffControls(ticket) : "";
    const locked = ticket.status === "Closed";
    const internalToggle = staff ? `<label class="st-internal-toggle"><input name="internal" type="checkbox"> Internal note (staff only)</label>` : "";
    return `<div class="st-thread-head"><div><span class="st-badge ${statusClass(ticket.status)}">${escapeHtml(ticket.status)}</span>
      <h2>${escapeHtml(ticket.subject)}</h2><p>${escapeHtml(ticket.id)} · ${escapeHtml(ticket.requesterName)}${requesterPhone} · ${escapeHtml(ticket.category)}${ticket.relatedRef ? ` · ${escapeHtml(ticket.relatedRef)}` : ""}</p>${staff ? slaLine(ticket) : ""}</div>${operationControls}</div>
      ${applicationMarkup(ticket)}
      <div class="st-messages">${messages}</div>
      ${csatMarkup(ticket)}
      ${locked ? `<div class="st-locked">This ticket is closed. Operations can reopen it by changing the status.</div>` : `<form class="st-reply" data-support-reply="${escapeHtml(ticket.id)}">
        <label class="st-sr-only" for="supportReply">Write a reply</label><textarea id="supportReply" name="message" required maxlength="3000" rows="3" placeholder="Write a reply to this conversation"></textarea>
        <div class="st-reply-file"><input name="attachments" type="file" accept="image/*,.heic,.heif,.pdf,.doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx,.txt" multiple aria-label="Attach files" data-file-button="Attach files" data-file-hint="Photos, PDF, Office, CSV or text · up to 5 files, 5 MB each"></div>
        <div class="st-reply-bottom">${cannedPicker()}${internalToggle}<button class="button button-primary" type="submit">Send reply</button></div>
      </form>`}`;
  }

  function headingMarkup(subtitle) {
    const staff = inbox();
    const title = staff ? "Support inbox" : role === "customer" ? "Customer support" : "My support tickets";
    const description = subtitle || (staff ? "Respond to merchant, rider, and website customer requests. Requesters see your replies and status changes on their own support page." : "Create a ticket, attach screenshots or documents, and continue the conversation with courier operations.");
    return `<div class="st-page-heading"><div><p class="eyebrow">${staff ? "Service desk" : "Help & support"}</p><h1>${title}</h1><p class="subtitle">${escapeHtml(description)}</p></div>
      ${!staff ? `<button type="button" class="button button-primary" data-support-new>${composerOpen ? "Hide ticket form" : "New support ticket"}</button>` : ""}</div>`;
  }

  function supportPage() {
    const staff = inbox();
    if (!canUseSupport()) {
      return `${headingMarkup("Support tickets aren't available for your role.")}<section class="panel"><p class="st-error">Your account can't open support tickets. Contact your operations manager.</p></section>`;
    }
    if (store.error && !store.tickets.length) {
      return `${headingMarkup("Ticket data could not be loaded.")}<section class="panel"><p class="st-error">${escapeHtml(store.error)} We'll try again shortly.</p></section>`;
    }
    const loading = !store.loaded;
    const tickets = [...visibleTickets()].sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    if (wantedTicket) {
      selectedTicketId = wantedTicket;
      if (!loading) wantedTicket = "";
    }
    if (!loading && !tickets.some(ticket => ticket.id === selectedTicketId)) selectedTicketId = tickets[0]?.id || "";
    const selected = tickets.find(ticket => ticket.id === selectedTicketId);
    const openCount = tickets.filter(ticket => !["Resolved", "Closed"].includes(ticket.status)).length;
    const list = loading
      ? `<div class="st-empty"><strong>Loading support tickets…</strong></div>`
      : tickets.length ? `<div class="st-ticket-list">${tickets.map(ticketCard).join("")}</div>` : `<div class="st-empty"><strong>No support tickets yet</strong><p>${staff ? "New tickets from merchants, riders, and customers will appear here." : "Create a ticket and your conversation with operations will appear here."}</p></div>`;
    return `${headingMarkup()}
      <div class="st-summary"><div><strong>${loading ? "–" : tickets.length}</strong><span>Total tickets</span></div><div><strong>${loading ? "–" : openCount}</strong><span>Needs attention</span></div><div><strong>${loading ? "–" : tickets.filter(ticket => ticket.status === "Waiting for requester").length}</strong><span>Waiting for requester</span></div></div>
      ${composerMarkup()}
      <div class="st-layout"><section class="st-list panel"><div class="panel-heading"><div><h2 class="panel-title">Tickets</h2><p class="panel-subtitle">${staff ? "All support requests" : "Your support conversations"}</p></div></div>
      ${list}</section>
      <section class="st-thread panel" aria-label="Support conversation">${threadMarkup(selected)}</section></div>
      <p class="st-demo-note">${staff ? "Replies go to the requester's support page. Internal notes are visible to support staff only." : "Replies from Paira Express support appear in this conversation."}</p>`;
  }

  // ───────────── rendering ─────────────

  const isSupportVisible = () =>
    role === "customer" ? routeHash().startsWith("#/support") : document.getElementById("breadcrumbPage")?.textContent === "Support";

  /** True while someone is writing a ticket or reply, so a background refresh doesn't wipe it. */
  function isEditing() {
    const forms = document.querySelectorAll(".st-composer, .st-reply");
    for (const form of forms) {
      if (form.contains(document.activeElement)) return true;
      for (const field of form.querySelectorAll("textarea, input")) {
        if (field.type === "file" ? field.files?.length : field.type !== "checkbox" && field.name !== "requesterName" && field.name !== "requesterPhone" && field.value.trim() && field.value !== field.defaultValue) return true;
      }
    }
    return false;
  }

  function renderIfIdle() {
    if (isSupportVisible() && !isEditing()) refreshSupportPage();
  }

  /** After the page is in the DOM: load what it still needs. */
  function afterRender() {
    ensureLoaded().then(changed => changed && isSupportVisible() && refreshSupportPage());
    if (store.loaded && selectedTicketId) ensureDetail(selectedTicketId);
    loadAssignees();
  }

  function refreshSupportPage() {
    if (role === "customer") {
      if (routeHash().startsWith("#/support")) renderCustomerSupport();
    } else if (document.getElementById("breadcrumbPage")?.textContent === "Support") {
      renderPageForRole("Support");
    }
  }

  function renderPageForRole(page) {
    const root = document.getElementById("mainContent");
    const breadcrumb = document.getElementById("breadcrumbPage");
    if (!root || !breadcrumb) return;
    breadcrumb.textContent = page;
    root.innerHTML = supportPage();
    document.querySelectorAll(".nav-item").forEach(item => item.classList.toggle("active", item.dataset.page === page));
    document.getElementById("sidebar")?.classList.remove("open");
    afterRender();
  }

  function addNavigation() {
    if (role === "customer" || !canUseSupport()) return;
    const navigation = document.getElementById("navigation");
    if (!navigation || navigation.querySelector('[data-page="Support"]')) return;
    const group = document.createElement("div");
    group.className = "nav-group";
    group.innerHTML = `<div class="nav-label">${inbox() ? "Service desk" : role === "rider" ? "Help & safety" : "Support"}</div><button class="nav-item" data-page="Support"><svg fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4V5Z"/><path d="M8 9h8M8 12h5"/></svg>${inbox() ? "Support tickets" : "Support"}<span class="nav-count" data-support-count>0</span></button>`;
    navigation.append(group);
  }

  function readFile(file) {
    if (file.size > maxAttachmentBytes) throw new Error(`${file.name} is larger than 5 MB.`);
    const ext = (file.name.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
    if (!attachmentExtensions.includes(ext)) throw new Error(`${file.name}: attach photos (JPG, PNG, WebP, GIF, HEIC), PDF, Word, Excel, PowerPoint, CSV or text files.`);
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ filename: file.name.slice(0, 120), dataUrl: reader.result });
      reader.onerror = () => reject(new Error(`${file.name} could not be read.`));
      reader.readAsDataURL(file);
    });
  }

  async function readAttachments(input) {
    const files = [...(input?.files || [])];
    if (files.length > maxAttachments) throw new Error(`Choose no more than ${maxAttachments} attachments.`);
    return Promise.all(files.map(readFile));
  }

  /** Saves a ticket attachment: fetched with the access token, handed to the browser as a blob URL. */
  async function downloadAttachment(link) {
    const file = await DF.api(`/files/${encodeURIComponent(link.dataset.supportFile)}`, { headers: { accept: "application/json" } });
    const base64 = file.dataUrl.slice(file.dataUrl.indexOf(",") + 1);
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: file.mimeType }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = file.filename;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // ───────────── actions ─────────────

  /** After a change: keep the returned conversation, reload the list and show it. */
  async function afterChange(detail) {
    if (detail) store.details.set(detail.number, detail);
    await reload().catch(error => console.error("Support tickets could not be refreshed.", error));
    if (detail) {
      store.details.set(detail.number, detail);
      selectedTicketId = detail.number;
    }
    updateCount();
    refreshSupportPage();
  }

  async function createTicket(form) {
    const data = new FormData(form);
    const subject = String(data.get("subject") || "").trim();
    let message = String(data.get("message") || "").trim();
    if (!subject || !message) throw new Error("Add a subject and message before submitting.");
    const attachments = await readAttachments(form.elements.attachments);
    if (role === "customer") {
      // The ticket is filed under the signed-in account; mention other contact details in the message.
      const name = String(data.get("requesterName") || "").trim();
      const phone = String(data.get("requesterPhone") || "").trim();
      const user = me();
      const samePhone = phone.replace(/\D/g, "").slice(-10) === (user?.phone || "").replace(/\D/g, "").slice(-10);
      if ((name && name !== user?.name) || (phone && !samePhone)) message += `\n\nContact: ${[name, phone].filter(Boolean).join(" · ")}`;
    }
    const relatedRef = String(data.get("relatedRef") || "").trim().toUpperCase();
    const ticket = await DF.api("/support/tickets", {
      method: "POST",
      body: { subject, category: String(data.get("category")), priority: String(data.get("priority") || "Normal"), message, attachments, ...(relatedRef ? { relatedRef } : {}) },
    });
    composerOpen = false;
    prefilled = {};
    if (role === "customer" && routeHash().startsWith("#/support/")) {
      // Point the address at the new ticket rather than the parcel it is about.
      DF.route.replace(`support/${encodeURIComponent(ticket.number)}`);
      handledHash = routeHash();
    }
    await afterChange(ticket);
    toast(`${ticket.number} created. Courier operations can now respond.`);
  }

  async function replyToTicket(form) {
    const data = new FormData(form);
    const body = String(data.get("message") || "").trim();
    if (!body) throw new Error("Write a message before sending your reply.");
    const attachments = await readAttachments(form.elements.attachments);
    const number = form.dataset.supportReply;
    const ticket = store.tickets.find(record => record.id === number);
    if (!ticket) throw new Error("This support ticket is no longer available.");
    if (ticket.status === "Closed") throw new Error("This ticket is closed. Operations must reopen it before replying.");
    const internal = inbox() && data.get("internal") === "on";
    const detail = await DF.api(`/support/tickets/${encodeURIComponent(number)}/messages`, { method: "POST", body: { body, attachments, internal } });
    form.reset();
    await afterChange(detail);
    toast(internal ? "Internal note added." : "Reply added to the support conversation.");
  }

  async function updateTicket(select, field) {
    const number = select.dataset[field === "status" ? "supportStatus" : field === "priority" ? "supportPriority" : "supportAssignee"];
    const ticket = store.tickets.find(record => record.id === number);
    if (!ticket) return;
    const body = field === "status" ? { status: select.value } : field === "priority" ? { priority: select.value } : { assigneeId: select.value || null };
    if (field === "status" && (!statuses.includes(select.value) || ticket.status === select.value)) return;
    select.disabled = true;
    try {
      const detail = await DF.api(`/support/tickets/${encodeURIComponent(number)}`, { method: "PATCH", body });
      await afterChange(detail);
      toast(field === "status" ? `${number} status updated to ${detail.statusLabel}.` : field === "priority" ? `${number} priority set to ${select.selectedOptions[0]?.textContent || select.value}.` : detail.assignee ? `${number} assigned to ${detail.assignee.name}.` : `${number} is now unassigned.`);
    } catch (error) {
      toast(DF.describe(error));
      refreshSupportPage(); // put the control back
    }
  }

  function renderCustomerSupport() {
    if (role !== "customer" || !routeHash().startsWith("#/support")) return;
    if (!window.deliveryFastCustomerSession) {
      window.requireCustomerLogin?.(routeHash().slice(2));
      return;
    }
    const path = routeHash().slice(2).split("/");
    // #/support/<ticket number> opens that ticket; #/support/<tracking ID> starts a ticket about the parcel.
    // Once per navigation, so background refreshes don't reopen the form.
    if (path[1] && store.loaded && handledHash !== routeHash()) {
      handledHash = routeHash();
      const reference = decodeURIComponent(path[1]).toUpperCase();
      const ticketExists = store.tickets.some(ticket => ticket.id === reference);
      if (ticketExists) selectedTicketId = reference;
      else {
        selectedTicketId = "";
        composerOpen = true;
        prefilled = { ...prefilled, subject: `Help with ${reference}`, category: "Delivery issue", relatedRef: reference };
      }
    }
    document.title = "Paira Express — Customer support";
    document.getElementById("navLinks")?.classList.remove("open");
    document.getElementById("menuButton")?.setAttribute("aria-expanded", "false");
    document.querySelectorAll("main > :not(#pageView)").forEach(node => node.remove());
    const pageView = document.getElementById("pageView");
    if (!pageView) return;
    pageView.hidden = false;
    pageView.innerHTML = window.deliveryFastCustomerSession && typeof window.customerAreaShell === "function"
      ? window.customerAreaShell(supportPage(), "support")
      : `<div class="route-shell"><button class="route-back" type="button" data-route="home">Back to Paira Express</button>${supportPage()}</div>`;
    afterRender();
  }

  function initializeNavigation() {
    addNavigation();
    if (role === "customer") {
      if (window.routeInfo) window.routeInfo.support = ["Customer support", "Customer support", "Ask about a delivery or pickup request and continue the conversation with courier operations."];
      window.addEventListener("hashchange", () => {
        handledHash = "";
        if (routeHash().startsWith("#/support")) {
          renderCustomerSupport();
          window.scrollTo({ top: 0, behavior: "smooth" });
        }
      });
      const originalNavigate = window.navigate;
      if (typeof originalNavigate === "function") {
        window.navigate = route => {
          if (String(route).startsWith("support")) {
            DF.route.go(route); // the route-change listener above renders it
          } else originalNavigate(route);
        };
      }
      if (routeHash().startsWith("#/support")) renderCustomerSupport();
      else if (routeHash().startsWith("#/tracking/")) {
        const code = decodeURIComponent(routeHash().split("/")[2] || "");
        window.track?.(code);
      }
      return;
    }
    if (!canUseSupport()) return;
    const rendererName = role === "merchant" ? "renderPage" : "render";
    const originalRender = window[rendererName];
    if (typeof originalRender === "function") {
      window[rendererName] = page => page === "Support" ? renderPageForRole("Support") : originalRender(page);
    }
    document.querySelectorAll(".nav-item").forEach(item => {
      if (item.dataset.page === "Support") item.addEventListener("click", () => window[rendererName]("Support"));
    });
  }

  function showComposer(prefill = {}) {
    prefilled = prefill;
    composerOpen = true;
    if (role === "customer") renderCustomerSupport();
    else window[role === "merchant" ? "renderPage" : "render"]("Support");
    document.querySelector(".st-composer input[name='subject']")?.focus();
  }

  function handleRoleSupportShortcuts(event) {
    if (role === "customer" || !canUseSupport()) return;
    const button = event.target.closest("button");
    if (!button) return;
    const issue = button.matches('[data-action="issue"]');
    const contactCard = button.closest(".help-card,.support-card");
    const messageSupport = button.textContent.toLowerCase().includes("message support");
    if (!issue && !contactCard && !messageSupport) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (issue) {
      const type = document.getElementById("issueType")?.value || "Delivery issue";
      showComposer({ subject: `${type} report`, category: type === "Safety concern" ? "Rider or safety" : "Delivery issue" });
    } else if (messageSupport || contactCard) showComposer();
  }

  function updateCount() {
    const count = document.querySelector("[data-support-count]");
    if (count) count.textContent = String(visibleTickets().filter(ticket => !["Resolved", "Closed"].includes(ticket.status)).length);
    if (role === "rider") syncRiderRequests();
  }

  document.addEventListener("click", event => {
    const decision = inbox() && event.target.closest("[data-application-status]");
    if (decision) {
      event.preventDefault();
      const status = decision.dataset.applicationStatus;
      const number = decision.dataset.applicationNumber;
      const needsMessage = status === "INFO_REQUESTED" || status === "REJECTED";
      const titles = { INFO_REQUESTED: "Ask the applicant for information", REJECTED: "Reject the application", APPROVED: "Approve the application" };
      void DF.prompt({ title: titles[status] || `${number}: update status`, message: "The applicant receives this message.", label: "Message to the applicant", required: needsMessage, multiline: true, maxLength: 1000, confirm: status === "REJECTED" ? "Reject" : "Send", danger: status === "REJECTED" }).then(message => {
      if (message === null || (needsMessage && !message)) return;
      decision.disabled = true;
      DF.api(`/applications/${encodeURIComponent(number)}/status`, { method: "POST", body: { status, ...(message ? { message } : {}) } })
        .then(async app => {
          store.applications.set(number, app);
          store.details.delete(number);
          await afterChange(null);
          ensureDetail(number);
          toast(`${number}: ${app.statusLabel}.`);
        })
        .catch(error => toast(DF.describe(error)))
        .finally(() => decision.isConnected && (decision.disabled = false));
      });
      return;
    }
    if (inbox() && event.target.closest("[data-support-save-canned]")) {
      event.preventDefault();
      const body = (document.getElementById("supportReply")?.value || "").trim();
      if (!body) return void toast("Write the reply you want to save first.");
      void DF.prompt({ title: "Save as a canned response", label: "Title", value: body.slice(0, 40), required: true, maxLength: 80, confirm: "Save" }).then(title => {
      if (!title) return;
      DF.api("/support/canned-responses", { method: "POST", body: { title, body } })
        .then(row => {
          store.canned = [...(store.canned || []), row];
          toast(`Saved "${row.title}".`);
          renderIfIdle();
        })
        .catch(error => toast(DF.describe(error)));
      });
      return;
    }
    const file = event.target.closest("[data-support-file]");
    if (file) {
      event.preventDefault();
      downloadAttachment(file).catch(error => toast(DF.describe(error)));
      return;
    }
    if (event.target.closest("#accountLogout")) {
      resetStore(); // the website signs out; nothing stays in memory
      composerOpen = role === "customer";
      prefilled = {};
      return;
    }
    const supportAnchor = role === "customer" && event.target.closest('a[href^="mailto:support@"]');
    if (supportAnchor) {
      event.preventDefault();
      const ref = routeHash().startsWith("#/tracking/") ? decodeURIComponent(routeHash().split("/")[2] || "") : "";
      const route = `support${ref ? `/${encodeURIComponent(ref)}` : ""}`;
      const title = supportAnchor.closest(".track-help")?.textContent;
      if (ref) {
        selectedTicketId = "";
        composerOpen = true;
        prefilled = { subject: `Help with ${ref}`, category: "Delivery issue", relatedRef: ref.toUpperCase() };
      }
      if (!window.deliveryFastCustomerSession) {
        window.requireCustomerLogin?.(route);
        return;
      }
      window.navigate(route);
      if (title) renderCustomerSupport();
      return;
    }
    if (role === "customer") {
      const opened = event.target.closest("[data-support-open]");
      if (opened) {
        selectedTicketId = opened.dataset.supportOpen;
        renderCustomerSupport();
        return;
      }
      if (event.target.closest("[data-support-new]")) {
        composerOpen = !composerOpen;
        prefilled = {};
        renderCustomerSupport();
        return;
      }
    } else {
      const opened = event.target.closest("[data-support-open]");
      if (opened) {
        selectedTicketId = opened.dataset.supportOpen;
        renderPageForRole("Support");
        return;
      }
      if (event.target.closest("[data-support-new]")) {
        composerOpen = !composerOpen;
        prefilled = {};
        renderPageForRole("Support");
      }
    }
    if (event.target.closest("[data-route='home']") && role === "customer" && routeHash().startsWith("#/support")) {
      event.preventDefault();
      window.navigate("home");
    }
  }, true);

  document.addEventListener("submit", async event => {
    const csatForm = event.target.closest("[data-support-csat]");
    if (csatForm) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const data = new FormData(csatForm);
      const comment = String(data.get("comment") || "").trim();
      try {
        const detail = await DF.api(`/support/tickets/${encodeURIComponent(csatForm.dataset.supportCsat)}/csat`, { method: "POST", body: { rating: Number(data.get("rating")), ...(comment ? { comment } : {}) } });
        await afterChange(detail);
        toast("Thank you for rating our support.");
      } catch (error) {
        toast(DF.describe(error));
      }
      return;
    }
    const ticketForm = event.target.closest("[data-support-ticket-form]");
    const replyForm = event.target.closest("[data-support-reply]");
    if (!ticketForm && !replyForm) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const form = ticketForm || replyForm;
    if (form.dataset.busy) return;
    form.dataset.busy = "1";
    const submit = event.submitter || form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    try {
      if (ticketForm) await createTicket(ticketForm);
      else await replyToTicket(replyForm);
    } catch (error) {
      console.error("Support ticket action failed.", error);
      toast(error instanceof DF.ApiError ? DF.describe(error) : error.message || "The support ticket action failed.");
    } finally {
      delete form.dataset.busy;
      if (submit?.isConnected) submit.disabled = false;
    }
  }, true);

  document.addEventListener("change", event => {
    if (!inbox()) return;
    if (event.target.matches("[data-support-canned]")) {
      const row = (store.canned || []).find(r => r.id === event.target.value);
      const box = document.getElementById("supportReply");
      if (row && box) {
        box.value = box.value ? `${box.value.trimEnd()}\n\n${row.body}` : row.body;
        box.focus();
      }
      event.target.value = "";
      return;
    }
    if (event.target.matches("[data-support-status]")) updateTicket(event.target, "status");
    else if (event.target.matches("[data-support-priority]")) updateTicket(event.target, "priority");
    else if (event.target.matches("[data-support-assignee]")) updateTicket(event.target, "assignee");
  }, true);

  // Other people's replies and status changes (live events, slow safety poll).
  DF.live(["ticket.updated", "application.updated"], async () => {
    if (!canUseSupport() || !store.loaded) return;
    store.applications.clear();
    const changed = await reload();
    updateCount();
    if (changed) renderIfIdle();
  }, { fallbackMs: POLL_MS * 8 });

  // ───────────── rider: dispatch callback requests ─────────────

  /** rider/02.js topics -> ticket categories. */
  const RIDER_TOPICS = { "Delivery issue": "Delivery issue", "Rider safety": "Rider or safety", "COD or payment": "COD / payment", "App or device": "Account / API", Other: "Other" };
  const CALLBACK_SUBJECT = "Dispatch callback request";
  const MESSAGE_SUBJECT = "Message to rider support";

  /** Fills the "My support requests" list on Help & safety (rider/01.js) with the rider's tickets. */
  function syncRiderRequests() {
    if (typeof riderSupportRequests === "undefined" || !Array.isArray(riderSupportRequests)) return;
    const rows = [...store.tickets].sort((a, b) => b.updatedAtMs - a.updatedAtMs).map(ticket => ({
      id: ticket.id,
      category: ticket.category,
      trackingId: ticket.relatedRef,
      message: ticket.preview,
      channel: ticket.subject.startsWith(CALLBACK_SUBJECT) ? "Phone callback" : ticket.subject.startsWith(MESSAGE_SUBJECT) ? "In-app message" : "Support ticket",
      status: ticket.status,
      createdAt: when(ticket.createdAtIso),
    }));
    const changed = JSON.stringify(rows) !== JSON.stringify(riderSupportRequests);
    riderSupportRequests.splice(0, riderSupportRequests.length, ...rows);
    if (changed && document.getElementById("breadcrumbPage")?.textContent === "Help & safety" && !document.getElementById("actionModal")?.classList.contains("open")) window.render?.("Help & safety");
  }

  function setupRiderRequests() {
    // Truthful copy for the dialog and the list (the originals describe a browser-only demo).
    if (typeof customContent === "function") {
      const originalContent = customContent;
      customContent = function (page) {
        return originalContent(page).replace("Demo tickets submitted during this rider session", "Your requests to dispatch and rider support");
      };
    }
    const originalOpenModal = window.openModal;
    if (typeof originalOpenModal === "function") {
      window.openModal = function (type, id) {
        originalOpenModal(type, id);
        if (type !== "support") return;
        const callback = id === "call";
        const description = document.getElementById("modalDescription");
        if (description) description.textContent = callback ? "Share what happened and dispatch will call you back." : "Send a delivery, safety, COD, or app issue to rider support.";
        const note = document.querySelector("#modalFields p.panel-subtitle");
        if (note) note.textContent = "This creates a support ticket. Replies appear under Support.";
      };
    }

    // Runs before rider/02.js's own handler on the form (window, capture phase).
    window.addEventListener("submit", event => {
      if (event.target?.id !== "actionForm" || typeof activeAction === "undefined" || activeAction?.type !== "support") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const form = event.target;
      if (!form.checkValidity()) return void form.reportValidity();
      if (form.dataset.busy) return;
      const callback = document.getElementById("supportContact")?.value === "Phone call";
      const topic = document.getElementById("supportTopic")?.value || "Other";
      const trackingId = (document.getElementById("supportTracking")?.value || "").trim().toUpperCase();
      const details = (document.getElementById("supportMessage")?.value || "").trim();
      const button = document.getElementById("submitAction");
      form.dataset.busy = "1";
      if (button) button.disabled = true;
      const body = {
        category: RIDER_TOPICS[topic] || "Other",
        subject: `${callback ? CALLBACK_SUBJECT : MESSAGE_SUBJECT} · ${topic}`,
        priority: topic === "Rider safety" || callback ? "High" : "Normal",
        message: `${details}\n\nFollow-up: ${callback ? `phone call to ${me()?.phone || "my number"}` : "in-app reply"}`,
        ...(trackingId ? { relatedRef: trackingId } : {}),
      };
      DF.api("/support/tickets", { method: "POST", body })
        .then(async ticket => {
          closeModal();
          await afterChange(ticket);
          toast(`${ticket.number} created · ${callback ? "Callback requested" : "Sent to dispatch"}.`);
        })
        .catch(error => toast(DF.describe(error)))
        .finally(() => {
          delete form.dataset.busy;
          if (button) button.disabled = false;
        });
    }, true);
  }

  const style = document.createElement("style");
  style.textContent = `
    .st-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:14px}
    .st-summary>div{display:grid;gap:3px;padding:14px 16px;background:var(--surface,#fff);border:1px solid var(--line);border-radius:9px}
    .st-summary strong{font-size:21px}.st-summary span,.st-note,.st-demo-note,.st-optional{color:var(--muted,#7b8796);font-size:12px}
    .st-layout{display:grid;grid-template-columns:minmax(260px,.82fr) minmax(0,1.5fr);gap:13px;align-items:start}
    .st-list,.st-thread{min-width:0;padding:15px;background:var(--surface,#fff);border:1px solid var(--line);border-radius:9px}.st-ticket-list{display:grid;gap:8px;margin-top:13px}
    .st-ticket{display:grid;gap:7px;width:100%;padding:12px;text-align:left;color:inherit;background:#fff;border:1px solid var(--line);border-radius:8px}
    .st-ticket:hover,.st-ticket.selected{border-color:#9db4ff;background:#f8faff}.st-ticket-top{display:flex;justify-content:space-between;gap:8px;align-items:center}
    .st-ticket-subject{font-size:13px}.st-ticket-meta{overflow:hidden;color:var(--muted,#7b8796);font-size:12px;text-overflow:ellipsis;white-space:nowrap}
    .st-ticket small{color:#98a2af;font-size:11px}.st-badge{display:inline-block;padding:4px 8px;border-radius:20px;background:#fff4dc;color:#a76a0d;font-size:11px;font-weight:650;white-space:nowrap}
    .st-badge.active{background:#edf2ff;color:#4266ce}.st-badge.waiting{background:#fff4dc;color:#a76a0d}.st-badge.done{background:#e8f7f0;color:#16845b}.st-badge.st-sla-breach{background:#fdeceb;color:#b53b3b;margin-right:4px}.st-sla{margin:4px 0 0;font-size:12px;color:#647184}.st-sla.breach{color:#b53b3b;font-weight:600}.st-csat{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:10px 0;padding:10px;border:1px solid #e3e8ef;border-radius:8px;background:#fafbfc}.st-csat input[name=comment]{flex:1;min-width:180px}.st-stars{display:flex;gap:8px}.st-stars label{display:flex;gap:3px;align-items:center;font-weight:500}.st-application{margin:8px 0;padding:10px;border:1px solid #e3e8ef;border-radius:8px;background:#f7f9ff}.st-app-details{display:flex;flex-wrap:wrap;gap:6px 14px;margin:6px 0;font-size:13px}.st-app-details em{color:#647184;font-style:normal;margin-right:3px}.st-app-actions{display:flex;flex-wrap:wrap;gap:6px}[data-support-canned]{max-width:220px}
    .st-thread-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding-bottom:13px;border-bottom:1px solid var(--line)}
    .st-thread-head h2{margin:8px 0 4px;font-size:17px}.st-thread-head p{margin:0;color:var(--muted,#7b8796);font-size:12px;line-height:1.5}
    .st-controls{display:grid;gap:8px}
    .st-status-control{display:grid;gap:5px;min-width:155px;color:var(--muted,#7b8796);font-size:12px;font-weight:600}
    .st-status-control select,.st-composer input,.st-composer select,.st-composer textarea,.st-reply textarea{width:100%;padding:9px 10px;border:1px solid var(--line);border-radius:6px;color:var(--ink,#182230);background:#fff;font:inherit}
    .st-messages{display:grid;gap:10px;max-height:440px;overflow:auto;padding:14px 2px}
    .st-message{padding:11px 12px;border:1px solid var(--line);border-radius:8px;background:#fafbfd}
    .st-message.mine{border-color:#d9e3ff;background:#f5f7ff}.st-message.internal{border-color:#f1dfb5;background:#fffaf0}.st-message-head{display:flex;justify-content:space-between;gap:10px;font-size:12px}
    .st-internal-tag{margin-left:6px;color:#a76a0d;font-size:11px;font-style:normal;font-weight:650}
    .st-message-head span{color:#98a2af;font-size:11px}.st-message p{margin:8px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.55}
    .st-files{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.st-attachment{padding:5px 8px;border:1px solid var(--line);border-radius:6px;background:#fff;color:#4266ce;font-size:11px;text-decoration:none}
    .st-reply{border-top:1px solid var(--line);padding-top:12px}.st-reply textarea{resize:vertical}.st-reply-bottom,.st-actions{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:9px}
    .st-file-label{position:relative;color:#4266ce;font-size:12px;font-weight:600;cursor:pointer}.st-file-label input{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
    .st-internal-toggle{display:flex;align-items:center;gap:5px;color:#a76a0d;font-size:12px;font-weight:600;cursor:pointer}
    .st-composer{margin-bottom:14px;padding:16px;background:#fff;border:1px solid var(--line);border-radius:9px}
    .st-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:11px}.st-form-grid label{display:grid;gap:5px;color:#637083;font-size:12px;font-weight:600}.st-form-grid .st-span{grid-column:1/-1}
    .st-composer textarea{resize:vertical}.st-composer input[type=file]{font-size:12px}.st-reply-file{margin-top:8px}
    .st-empty{padding:34px 18px;text-align:center;color:var(--muted,#7b8796)}.st-empty strong{color:var(--ink,#182230)}.st-empty p{font-size:13px;line-height:1.5}
    .st-demo-note{margin:11px 0}.st-error{color:#b5473c}.st-locked{padding:12px;color:#7b8796;font-size:13px;background:#f8fafc;border-radius:7px}
    .st-page-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin:0 0 16px}.st-page-heading .subtitle{margin:7px 0 0}
    .st-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
    @media(max-width:760px){.st-layout{grid-template-columns:1fr}.st-thread-head{flex-direction:column}.st-controls,.st-status-control{width:100%}.st-summary{gap:7px}.st-summary>div{padding:11px}.st-form-grid{grid-template-columns:1fr}.st-form-grid .st-span{grid-column:auto}.st-reply-bottom,.st-actions{align-items:flex-start;flex-wrap:wrap}.st-actions .st-note{width:100%}}
  `;
  document.head.append(style);

  /** Opens a ticket by number (deep links ?ticket=…, notifications): the Support page with that conversation. */
  window.DFSupport = {
    open(number) {
      const ticket = String(number || "").trim().toUpperCase();
      if (!ticket) return;
      if (role === "customer") return void DF.route.go(`support/${encodeURIComponent(ticket)}`);
      if (!canUseSupport()) return;
      wantedTicket = ticket;
      selectedTicketId = ticket;
      window[role === "merchant" ? "renderPage" : "render"]?.("Support");
      if (store.loaded) ensureDetail(ticket);
    },
    /** The new-ticket form, prefilled ({ subject, category, relatedRef }): e.g. the merchant parcel drawer's "Open a ticket about this parcel". */
    compose: prefill => showComposer(prefill),
  };

  initializeNavigation();
  if (role === "rider") setupRiderRequests();
  updateCount();
  if (canUseSupport()) {
    ensureLoaded().then(() => {
      updateCount();
      if (isSupportVisible()) refreshSupportPage();
    });
  }
  if (role !== "customer" && document.getElementById("breadcrumbPage")?.textContent === "Support") renderPageForRole("Support");
  document.addEventListener("click", handleRoleSupportShortcuts, true);
})();
