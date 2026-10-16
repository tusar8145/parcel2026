(() => {
  const storageKey = "deliveryfast-support-tickets";
  const statuses = ["Open", "In progress", "Waiting for requester", "Resolved", "Closed"];
  const categories = ["Delivery issue", "Pickup or collection", "COD / payment", "Account / API", "Rider or safety", "Other"];
  const maxAttachmentBytes = 350 * 1024;
  const maxAttachments = 3;
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char]));
  const role = location.pathname.endsWith("website.html") ? "customer"
    : location.pathname.endsWith("rider.html") ? "rider"
      : location.pathname.endsWith("courier-operation.html") || location.pathname.endsWith("courier.html") ? "operations"
        : "merchant";
  const roleName = () => {
    if (role === "customer") return "Website customer";
    if (role === "rider") return document.querySelector(".rider-info strong")?.textContent.trim() || "Rider";
    if (role === "operations") return "Courier operations";
    return document.querySelector(".workspace-meta strong")?.textContent.trim() || "Merchant";
  };
  let selectedTicketId = "";
  let composerOpen = role === "customer";
  let prefilled = {};

  function readTickets() {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];
    const records = JSON.parse(raw);
    if (!Array.isArray(records) || records.some(ticket => !ticket || typeof ticket.id !== "string" || !Array.isArray(ticket.messages))) {
      throw new Error("Support ticket storage has an invalid format.");
    }
    return records;
  }

  function writeTickets(tickets) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(tickets));
      return true;
    } catch (error) {
      console.error("Support tickets could not be saved.", error);
      window.showToast?.("The support update could not be saved. Remove large attachments or check browser storage.");
      return false;
    }
  }

  function toast(message) {
    if (typeof window.showToast === "function") window.showToast(message);
    else console.info(message);
  }

  function visibleTickets() {
    const tickets = readTickets();
    return role === "operations" ? tickets : tickets.filter(ticket => ticket.requesterRole === role);
  }

  function statusClass(status) {
    return status === "Resolved" || status === "Closed" ? "done"
      : status === "In progress" ? "active" : status === "Waiting for requester" ? "waiting" : "open";
  }

  function attachmentMarkup(attachments = []) {
    return attachments.map(file => {
      const validData = /^data:(image\/(png|jpeg|webp)|application\/pdf);base64,/.test(file.data || "");
      if (!validData) return `<span class="st-attachment">${escapeHtml(file.name)} · unavailable</span>`;
      return `<a class="st-attachment" href="${escapeHtml(file.data)}" download="${escapeHtml(file.name)}">${escapeHtml(file.name)}</a>`;
    }).join("");
  }

  function ticketCard(ticket) {
    const latest = ticket.messages[ticket.messages.length - 1];
    return `<button type="button" class="st-ticket ${selectedTicketId === ticket.id ? "selected" : ""}" data-support-open="${escapeHtml(ticket.id)}">
      <span class="st-ticket-top"><strong>${escapeHtml(ticket.id)}</strong><span class="st-badge ${statusClass(ticket.status)}">${escapeHtml(ticket.status)}</span></span>
      <strong class="st-ticket-subject">${escapeHtml(ticket.subject)}</strong>
      <span class="st-ticket-meta">${escapeHtml(ticket.requesterName)} · ${escapeHtml(ticket.category)}${ticket.relatedRef ? ` · ${escapeHtml(ticket.relatedRef)}` : ""}</span>
      <span class="st-ticket-meta">${escapeHtml(latest?.body || "")}</span>
      <small>${escapeHtml(ticket.updatedAt)} · ${ticket.messages.length} message${ticket.messages.length === 1 ? "" : "s"}</small>
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
        <label class="st-span">Subject<input name="subject" required maxlength="120" value="${escapeHtml(prefilled.subject || "")}" placeholder="Briefly describe the issue"></label>
        <label>Category<select name="category" required>${categories.map(category => `<option ${prefilled.category === category ? "selected" : ""}>${category}</option>`).join("")}</select></label>
        <label>Priority<select name="priority"><option>Normal</option><option ${prefilled.priority === "High" ? "selected" : ""}>High</option><option>Low</option></select></label>
        <label class="st-span">Tracking or reference number <span class="st-optional">(optional)</span><input name="relatedRef" maxlength="40" value="${escapeHtml(prefilled.relatedRef || "")}" placeholder="e.g. PP-28491"></label>
        <label class="st-span">Message<textarea name="message" required maxlength="3000" rows="4" placeholder="Tell us what happened and how we can help"></textarea></label>
        <label class="st-span">Attachments <span class="st-optional">(up to 3 files, 350 KB each; images or PDF)</span><input name="attachments" type="file" accept="image/png,image/jpeg,image/webp,application/pdf" multiple></label>
      </div>
      <div class="st-actions"><span class="st-note">Demo support is shared between these pages in this browser.</span><button class="button button-primary" type="submit">Create support ticket</button></div>
    </form>`;
  }

  function threadMarkup(ticket) {
    if (!ticket) return `<div class="st-empty"><strong>Select a support ticket</strong><p>Choose a ticket from the list to view its conversation and reply.</p></div>`;
    const messages = ticket.messages.map(message => `<article class="st-message ${message.senderRole === role ? "mine" : ""}">
      <div class="st-message-head"><strong>${escapeHtml(message.senderName)}</strong><span>${escapeHtml(message.createdAt)}</span></div>
      <p>${escapeHtml(message.body)}</p><div class="st-files">${attachmentMarkup(message.attachments)}</div>
    </article>`).join("");
    const requesterPhone = role === "operations" && ticket.requesterPhone ? ` · ${escapeHtml(ticket.requesterPhone)}` : "";
    const operationControls = role === "operations" ? `<label class="st-status-control">Ticket status<select data-support-status="${escapeHtml(ticket.id)}">${statuses.map(status => `<option ${ticket.status === status ? "selected" : ""}>${status}</option>`).join("")}</select></label>` : "";
    const locked = ticket.status === "Closed";
    return `<div class="st-thread-head"><div><span class="st-badge ${statusClass(ticket.status)}">${escapeHtml(ticket.status)}</span>
      <h2>${escapeHtml(ticket.subject)}</h2><p>${escapeHtml(ticket.id)} · ${escapeHtml(ticket.requesterName)}${requesterPhone} · ${escapeHtml(ticket.category)}${ticket.relatedRef ? ` · ${escapeHtml(ticket.relatedRef)}` : ""}</p></div>${operationControls}</div>
      <div class="st-messages">${messages}</div>
      ${locked ? `<div class="st-locked">This ticket is closed. Operations can reopen it by changing the status.</div>` : `<form class="st-reply" data-support-reply="${escapeHtml(ticket.id)}">
        <label class="st-sr-only" for="supportReply">Write a reply</label><textarea id="supportReply" name="message" required maxlength="3000" rows="3" placeholder="Write a reply to this conversation"></textarea>
        <div class="st-reply-bottom"><label class="st-file-label">Attach files<input name="attachments" type="file" accept="image/png,image/jpeg,image/webp,application/pdf" multiple></label><span class="st-note">Up to 3 files · 350 KB each</span><button class="button button-primary" type="submit">Send reply</button></div>
      </form>`}`;
  }

  function supportPage() {
    let tickets;
    try {
      tickets = visibleTickets().sort((a, b) => (b.updatedAtMs || Date.parse(b.updatedAt) || 0) - (a.updatedAtMs || Date.parse(a.updatedAt) || 0));
    } catch (error) {
      console.error("Support tickets could not be loaded.", error);
      return `<div class="page-heading"><div><p class="eyebrow">Support</p><h1>Support tickets</h1><p class="subtitle">Ticket data could not be loaded.</p></div></div><section class="panel"><p class="st-error">Saved support data is invalid. Clear this demo's support ticket data to continue.</p></section>`;
    }
    if (!tickets.some(ticket => ticket.id === selectedTicketId)) selectedTicketId = tickets[0]?.id || "";
    const selected = tickets.find(ticket => ticket.id === selectedTicketId);
    const openCount = tickets.filter(ticket => !["Resolved", "Closed"].includes(ticket.status)).length;
    const title = role === "operations" ? "Support inbox" : role === "customer" ? "Customer support" : "My support tickets";
    const description = role === "operations" ? "Respond to merchant, rider, and website customer requests. Replies and status changes are shared across demo pages." : "Create a ticket, attach screenshots or documents, and continue the conversation with courier operations.";
    return `<div class="st-page-heading"><div><p class="eyebrow">${role === "operations" ? "Service desk" : "Help & support"}</p><h1>${title}</h1><p class="subtitle">${description}</p></div>
      ${role !== "operations" ? `<button type="button" class="button button-primary" data-support-new>${composerOpen ? "Hide ticket form" : "New support ticket"}</button>` : ""}</div>
      <div class="st-summary"><div><strong>${tickets.length}</strong><span>Total tickets</span></div><div><strong>${openCount}</strong><span>Needs attention</span></div><div><strong>${tickets.filter(ticket => ticket.status === "Waiting for requester").length}</strong><span>Waiting for requester</span></div></div>
      ${composerMarkup()}
      <div class="st-layout"><section class="st-list panel"><div class="panel-heading"><div><h2 class="panel-title">Tickets</h2><p class="panel-subtitle">${role === "operations" ? "All support requests" : "Your support conversations"}</p></div></div>
      ${tickets.length ? `<div class="st-ticket-list">${tickets.map(ticketCard).join("")}</div>` : `<div class="st-empty"><strong>No support tickets yet</strong><p>${role === "operations" ? "New tickets from merchants, riders, and customers will appear here." : "Create a ticket and your conversation with operations will appear here."}</p></div>`}</section>
      <section class="st-thread panel" aria-label="Support conversation">${threadMarkup(selected)}</section></div>
      <p class="st-demo-note">Support tickets are saved in browser storage for this static demo. They are not sent to a live support service.</p>`;
  }

  function refreshSupportPage() {
    if (role === "customer") {
      if (location.hash.startsWith("#/support")) renderCustomerSupport();
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
  }

  function addNavigation() {
    if (role === "customer") return;
    const navigation = document.getElementById("navigation");
    if (!navigation || navigation.querySelector('[data-page="Support"]')) return;
    const group = document.createElement("div");
    group.className = "nav-group";
    group.innerHTML = `<div class="nav-label">${role === "operations" ? "Service desk" : role === "rider" ? "Help & safety" : "Support"}</div><button class="nav-item" data-page="Support"><svg fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4V5Z"/><path d="M8 9h8M8 12h5"/></svg>${role === "operations" ? "Support tickets" : "Support"}<span class="nav-count" data-support-count>0</span></button>`;
    navigation.append(group);
  }

  function readFile(file) {
    if (file.size > maxAttachmentBytes) throw new Error(`${file.name} is larger than 350 KB.`);
    if (!["image/png", "image/jpeg", "image/webp", "application/pdf"].includes(file.type)) throw new Error(`${file.name} must be a PNG, JPEG, WebP, or PDF file.`);
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ name: file.name, type: file.type, data: reader.result });
      reader.onerror = () => reject(new Error(`${file.name} could not be read.`));
      reader.readAsDataURL(file);
    });
  }

  async function readAttachments(input) {
    const files = [...(input?.files || [])];
    if (files.length > maxAttachments) throw new Error(`Choose no more than ${maxAttachments} attachments.`);
    return Promise.all(files.map(readFile));
  }

  function makeId(tickets) {
    const date = new Date().toISOString().slice(2, 10).replaceAll("-", "");
    const prefix = `DF-SUP-${date}-`;
    const highest = tickets.reduce((max, ticket) => {
      const match = ticket.id.match(new RegExp(`^DF-SUP-${date}-(\\d+)$`));
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0);
    return `${prefix}${String(highest + 1).padStart(4, "0")}`;
  }

  function timestamp() {
    return new Date().toLocaleString();
  }

  async function createTicket(form) {
    const data = new FormData(form);
    const subject = String(data.get("subject") || "").trim();
    const body = String(data.get("message") || "").trim();
    if (!subject || !body) throw new Error("Add a subject and message before submitting.");
    const attachments = await readAttachments(form.elements.attachments);
    let tickets = readTickets();
    const now = timestamp();
    const requesterName = role === "customer" ? String(data.get("requesterName") || "").trim() : roleName();
    const ticket = {
      id: makeId(tickets),
      requesterRole: role,
      requesterName,
      requesterPhone: role === "customer" ? String(data.get("requesterPhone") || "").trim() : "",
      subject,
      category: String(data.get("category")),
      priority: String(data.get("priority") || "Normal"),
      relatedRef: String(data.get("relatedRef") || "").trim().toUpperCase(),
      status: "Open",
      createdAt: now,
      updatedAt: now,
      updatedAtMs: Date.now(),
      messages: [{ senderRole: role, senderName: requesterName, body, attachments, createdAt: now }]
    };
    tickets.unshift(ticket);
    if (!writeTickets(tickets)) return;
    selectedTicketId = ticket.id;
    composerOpen = false;
    prefilled = {};
    updateCount();
    refreshSupportPage();
    toast(`${ticket.id} created. Courier operations can now respond.`);
  }

  async function replyToTicket(form) {
    const body = String(new FormData(form).get("message") || "").trim();
    if (!body) throw new Error("Write a message before sending your reply.");
    const attachments = await readAttachments(form.elements.attachments);
    const tickets = readTickets();
    const ticket = tickets.find(record => record.id === form.dataset.supportReply);
    if (!ticket) throw new Error("This support ticket is no longer available.");
    if (ticket.status === "Closed") throw new Error("This ticket is closed. Operations must reopen it before replying.");
    const now = timestamp();
    ticket.messages.push({ senderRole: role, senderName: role === "operations" ? "Courier operations" : roleName(), body, attachments, createdAt: now });
    ticket.updatedAt = now;
    ticket.updatedAtMs = Date.now();
    ticket.status = role === "operations" ? "Waiting for requester" : "Open";
    if (!writeTickets(tickets)) return;
    selectedTicketId = ticket.id;
    updateCount();
    refreshSupportPage();
    toast("Reply added to the support conversation.");
  }

  function updateStatus(select) {
    const tickets = readTickets();
    const ticket = tickets.find(record => record.id === select.dataset.supportStatus);
    if (!ticket || !statuses.includes(select.value)) return;
    if (ticket.status === select.value) return;
    const previous = ticket.status;
    ticket.status = select.value;
    const now = timestamp();
    ticket.updatedAt = now;
    ticket.updatedAtMs = Date.now();
    ticket.messages.push({ senderRole: "system", senderName: "Courier operations", body: `Status changed from ${previous} to ${ticket.status}.`, attachments: [], createdAt: now });
    if (!writeTickets(tickets)) return;
    selectedTicketId = ticket.id;
    updateCount();
    refreshSupportPage();
    toast(`${ticket.id} status updated to ${ticket.status}.`);
  }

  function renderCustomerSupport() {
    if (role !== "customer" || !location.hash.startsWith("#/support")) return;
    if (!window.deliveryFastCustomerSession) {
      window.requireCustomerLogin?.(location.hash.slice(2));
      return;
    }
    const path = location.hash.slice(2).split("/");
    if (path[1]) {
      const reference = decodeURIComponent(path[1]);
      const ticketExists = readTickets().some(ticket => ticket.id === reference);
      if (ticketExists) selectedTicketId = reference;
      else {
        selectedTicketId = "";
        composerOpen = true;
        prefilled = { ...prefilled, subject: `Help with ${reference}`, category: "Delivery issue", relatedRef: reference };
      }
    }
    document.title = "Delivery Fast — Customer support";
    document.getElementById("navLinks")?.classList.remove("open");
    document.getElementById("menuButton")?.setAttribute("aria-expanded", "false");
    document.querySelectorAll("main > :not(#pageView)").forEach(node => node.remove());
    const pageView = document.getElementById("pageView");
    if (!pageView) return;
    pageView.hidden = false;
    pageView.innerHTML = window.deliveryFastCustomerSession && typeof window.customerAreaShell === "function"
      ? window.customerAreaShell(supportPage(), "support")
      : `<div class="route-shell"><button class="route-back" type="button" data-route="home">Back to Delivery Fast</button>${supportPage()}</div>`;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function initializeNavigation() {
    addNavigation();
    if (role === "customer") {
      if (window.routeInfo) window.routeInfo.support = ["Customer support", "Customer support", "Ask about a delivery or pickup request and continue the conversation with courier operations."];
      window.addEventListener("hashchange", renderCustomerSupport);
      const originalNavigate = window.navigate;
      if (typeof originalNavigate === "function") {
        window.navigate = route => {
          if (String(route).startsWith("support")) {
            const hash = `#/${route}`;
            if (location.hash === hash) renderCustomerSupport();
            else location.hash = hash;
          } else originalNavigate(route);
        };
      }
      if (location.hash.startsWith("#/support")) renderCustomerSupport();
      else if (location.hash.startsWith("#/tracking/")) {
        const code = decodeURIComponent(location.hash.split("/")[2] || "");
        window.track?.(code);
      }
      return;
    }
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
    if (role === "customer") return;
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
    if (!count) return;
    try {
      count.textContent = String(visibleTickets().filter(ticket => !["Resolved", "Closed"].includes(ticket.status)).length);
    } catch (error) {
      console.error("Support ticket count could not be loaded.", error);
      count.textContent = "!";
    }
  }

  document.addEventListener("click", event => {
    const supportAnchor = role === "customer" && event.target.closest('a[href^="mailto:support@"]');
    if (supportAnchor) {
      event.preventDefault();
      const ref = location.hash.startsWith("#/tracking/") ? decodeURIComponent(location.hash.split("/")[2] || "") : "";
      const route = `support${ref ? `/${encodeURIComponent(ref)}` : ""}`;
      const title = supportAnchor.closest(".track-help")?.textContent;
      if (ref) {
        selectedTicketId = "";
        prefilled = { subject: `Help with ${ref}`, category: "Delivery issue", relatedRef: ref };
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
    if (event.target.closest("[data-route='home']") && role === "customer" && location.hash.startsWith("#/support")) {
      event.preventDefault();
      window.navigate("home");
    }
  }, true);

  document.addEventListener("submit", async event => {
    const ticketForm = event.target.closest("[data-support-ticket-form]");
    const replyForm = event.target.closest("[data-support-reply]");
    if (!ticketForm && !replyForm) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const submit = event.submitter;
    if (submit) submit.disabled = true;
    try {
      if (ticketForm) await createTicket(ticketForm);
      else await replyToTicket(replyForm);
    } catch (error) {
      console.error("Support ticket action failed.", error);
      toast(error.message || "The support ticket action failed.");
    } finally {
      if (submit?.isConnected) submit.disabled = false;
    }
  }, true);

  document.addEventListener("change", event => {
    if (role === "operations" && event.target.matches("[data-support-status]")) updateStatus(event.target);
  }, true);

  document.addEventListener("storage", event => {
    if (event.key !== storageKey) return;
    updateCount();
    if (role === "customer") renderCustomerSupport();
    else if (document.getElementById("breadcrumbPage")?.textContent === "Support") renderPageForRole("Support");
  });

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
    .st-badge.active{background:#edf2ff;color:#4266ce}.st-badge.waiting{background:#fff4dc;color:#a76a0d}.st-badge.done{background:#e8f7f0;color:#16845b}
    .st-thread-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding-bottom:13px;border-bottom:1px solid var(--line)}
    .st-thread-head h2{margin:8px 0 4px;font-size:17px}.st-thread-head p{margin:0;color:var(--muted,#7b8796);font-size:12px;line-height:1.5}
    .st-status-control{display:grid;gap:5px;min-width:155px;color:var(--muted,#7b8796);font-size:12px;font-weight:600}
    .st-status-control select,.st-composer input,.st-composer select,.st-composer textarea,.st-reply textarea{width:100%;padding:9px 10px;border:1px solid var(--line);border-radius:6px;color:var(--ink,#182230);background:#fff;font:inherit}
    .st-messages{display:grid;gap:10px;max-height:440px;overflow:auto;padding:14px 2px}
    .st-message{padding:11px 12px;border:1px solid var(--line);border-radius:8px;background:#fafbfd}
    .st-message.mine{border-color:#d9e3ff;background:#f5f7ff}.st-message-head{display:flex;justify-content:space-between;gap:10px;font-size:12px}
    .st-message-head span{color:#98a2af;font-size:11px}.st-message p{margin:8px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.55}
    .st-files{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.st-attachment{padding:5px 8px;border:1px solid var(--line);border-radius:6px;background:#fff;color:#4266ce;font-size:11px;text-decoration:none}
    .st-reply{border-top:1px solid var(--line);padding-top:12px}.st-reply textarea{resize:vertical}.st-reply-bottom,.st-actions{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:9px}
    .st-file-label{position:relative;color:#4266ce;font-size:12px;font-weight:600;cursor:pointer}.st-file-label input{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
    .st-composer{margin-bottom:14px;padding:16px;background:#fff;border:1px solid var(--line);border-radius:9px}
    .st-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:11px}.st-form-grid label{display:grid;gap:5px;color:#637083;font-size:12px;font-weight:600}.st-form-grid .st-span{grid-column:1/-1}
    .st-composer textarea{resize:vertical}.st-composer input[type=file]{font-size:12px}
    .st-empty{padding:34px 18px;text-align:center;color:var(--muted,#7b8796)}.st-empty strong{color:var(--ink,#182230)}.st-empty p{font-size:13px;line-height:1.5}
    .st-demo-note{margin:11px 0}.st-error{color:#b5473c}.st-locked{padding:12px;color:#7b8796;font-size:13px;background:#f8fafc;border-radius:7px}
    .st-page-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin:0 0 16px}.st-page-heading .subtitle{margin:7px 0 0}
    .st-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
    @media(max-width:760px){.st-layout{grid-template-columns:1fr}.st-thread-head{flex-direction:column}.st-status-control{width:100%}.st-summary{gap:7px}.st-summary>div{padding:11px}.st-form-grid{grid-template-columns:1fr}.st-form-grid .st-span{grid-column:auto}.st-reply-bottom,.st-actions{align-items:flex-start;flex-wrap:wrap}.st-actions .st-note{width:100%}}
  `;
  document.head.append(style);

  initializeNavigation();
  updateCount();
  if (role !== "customer" && document.getElementById("breadcrumbPage")?.textContent === "Support") renderPageForRole("Support");
  document.addEventListener("click", handleRoleSupportShortcuts, true);
})();
