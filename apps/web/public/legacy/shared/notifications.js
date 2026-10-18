/*
 * In-app notifications in every panel (window.DFNotify): the bell in the top bar and a Notifications page.
 * Loaded right after the page scripts (and shared/support.js), before the bridges, in Courier Operations,
 * super admin, both merchant panels and the rider app.
 *
 *   Bell        the panel's own bell (#notifications / #notificationButton) shows the unread count
 *               (GET /me/notifications/count, "99+" above 99) in its .notification-dot; live via the
 *               "notification.created" / "notification.read" events (plus reconnect and a slow safety poll)
 *   Dropdown    the latest notifications, "Mark all read" and "See all notifications"; extra sections can be
 *               added by a panel (DFNotify.addSection(fn), e.g. Courier Operations' live alerts)
 *   Item        clicking marks it read (POST /me/notifications/:id/read) and opens its link: a page / tab of
 *               this panel, a parcel (?parcel=) or a support ticket (?ticket=) through DF.nav, other panels by URL
 *   Page        "Notifications" (?page=notifications): All / Unread, Mark all read, "Load more" (cursor paging)
 *
 * Each person sees only their own notifications (the API scopes them to the signed-in user).
 */
(() => {
  const DF = window.DF;
  if (!DF || !DF.auth?.user) return;
  const app = document.body.dataset.app;
  const RENDERER = { "courier-operation": "render", rider: "render", "ecommerce-merchant": "renderPage", "banking-merchant": "renderPage", "super-admin": "showPage" }[app];
  if (!RENDERER) return;
  const PAGE = "Notifications";
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const bell = () => $("notifications") || $("notificationButton");

  document.head.insertAdjacentHTML(
    "beforeend",
    `<style id="dfNotifyStyles">
.notification-dot.dfn-count{width:auto;height:auto;min-width:17px;padding:0 4px;right:-7px;top:-7px;border-radius:9px;color:#fff;font:700 10px/13px system-ui,sans-serif;text-align:center;letter-spacing:0}
.notification-dot[hidden]{display:none!important}
.dfn-pop{position:fixed;z-index:70;width:min(380px,calc(100vw - 24px));max-height:min(560px,75vh);display:flex;flex-direction:column;border:1px solid var(--line,#e3e8ef);border-radius:10px;background:#fff;box-shadow:0 18px 40px #1720332b;font-size:13px;color:var(--ink,#182230)}
.dfn-pop-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:11px 12px 8px;border-bottom:1px solid var(--line,#e3e8ef)}
.dfn-pop-head strong{font-size:14px}
.dfn-pop-body{overflow:auto;padding:6px}
.dfn-pop-foot{padding:8px;border-top:1px solid var(--line,#e3e8ef);text-align:center}
.dfn-link{border:0;background:none;color:#3766e8;font:inherit;font-weight:600;cursor:pointer;padding:4px 6px;border-radius:6px}
.dfn-link:hover,.dfn-link:focus-visible{background:#f1f5ff;outline:none}
.dfn-link:disabled{color:#a0a9b5;cursor:default;background:none}
.dfn-item{position:relative;display:flex;gap:10px;width:100%;padding:9px 10px 9px 22px;border:0;border-radius:8px;background:none;text-align:left;font:inherit;color:inherit;cursor:pointer}
.dfn-item:hover,.dfn-item:focus-visible{background:#f3f6fb;outline:none}
.dfn-item.unread::before{content:"";position:absolute;left:8px;top:15px;width:7px;height:7px;border-radius:50%;background:#3766e8}
.dfn-item .dfn-text{display:grid;gap:2px;min-width:0;flex:1}
.dfn-item strong{font-weight:600;overflow-wrap:anywhere}
.dfn-item:not(.unread) strong{font-weight:500;color:#475467}
.dfn-item small{color:#7b8594;overflow-wrap:anywhere}
.dfn-item time{flex:none;color:#98a2ae;font-size:11px;white-space:nowrap}
.dfn-empty{margin:14px 8px;color:#7b8594;text-align:center}
.dfn-section{border-top:1px solid var(--line,#e3e8ef);margin-top:6px;padding-top:6px}
.dfn-filters{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}
.dfn-page .dfn-item{padding:12px 12px 12px 26px;border-bottom:1px solid var(--line,#eef1f5);border-radius:0}
.dfn-page .dfn-item.unread::before{left:11px;top:18px}
.dfn-more{display:flex;justify-content:center;padding:12px}
</style>`,
  );

  const state = { unread: 0, items: [], loadedAt: 0, page: { filter: "all", items: [], next: null, loading: false, error: "" } };
  const sections = [];

  // ───────────── count ─────────────

  function paint() {
    const button = bell();
    if (!button) return;
    let dot = button.querySelector(".notification-dot");
    if (!dot) {
      dot = document.createElement("i");
      dot.className = "notification-dot";
      button.append(dot);
    }
    const n = state.unread;
    dot.hidden = n <= 0;
    dot.classList.toggle("dfn-count", n > 0);
    dot.textContent = n > 0 ? (n > 99 ? "99+" : String(n)) : "";
    dot.setAttribute("data-count", String(n));
    button.setAttribute("aria-label", n > 0 ? `Notifications, ${n} unread` : "Notifications");
    button.setAttribute("aria-haspopup", "dialog");
    const badge = document.querySelector('#navigation [data-page="Notifications"] .nav-count');
    if (badge) badge.textContent = n > 99 ? "99+" : String(n);
  }

  let counting = null;
  async function refreshCount() {
    counting ??= DF.api("/me/notifications/count")
      .then(r => {
        state.unread = Number(r.unread) || 0;
        paint();
      })
      .catch(() => undefined)
      .finally(() => (counting = null));
    return counting;
  }

  // ───────────── items ─────────────

  function ago(iso) {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
    return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }
  const itemMarkup = n =>
    `<button type="button" class="dfn-item${n.readAt ? "" : " unread"}" data-dfn-id="${esc(n.id)}" data-dfn-link="${esc(n.link || "")}"><span class="dfn-text"><strong>${esc(n.title)}</strong>${n.body ? `<small>${esc(n.body)}</small>` : ""}</span><time datetime="${esc(n.createdAt)}" title="${esc(new Date(n.createdAt).toLocaleString())}">${esc(ago(n.createdAt))}</time></button>`;

  /** Marks it read (once) and opens its link: in this panel through DF.nav, elsewhere by URL. */
  async function openItem(id, link) {
    const known = [...state.items, ...state.page.items].find(n => n.id === id);
    if (known && !known.readAt) {
      known.readAt = new Date().toISOString();
      for (const other of [...state.items, ...state.page.items]) if (other.id === id) other.readAt = known.readAt;
      state.unread = Math.max(0, state.unread - 1);
      paint();
      try {
        const r = await DF.api(`/me/notifications/${id}/read`, { method: "POST" });
        state.unread = Number(r.unread) || 0;
        paint();
      } catch {}
    }
    closePop();
    if (pageVisible()) drawPage();
    if (link) DF.nav ? DF.nav.go(link) : location.assign(link);
  }

  async function readAll() {
    try {
      await DF.api("/me/notifications/read-all", { method: "POST" });
      const now = new Date().toISOString();
      for (const n of [...state.items, ...state.page.items]) n.readAt ||= now;
      state.unread = 0;
      paint();
      if (pop) drawPop();
      if (pageVisible()) drawPage();
    } catch (error) {
      DF.toast?.(DF.describe(error));
    }
  }

  // ───────────── dropdown ─────────────

  let pop = null;
  function closePop() {
    pop?.remove();
    pop = null;
    bell()?.setAttribute("aria-expanded", "false");
  }
  function place() {
    const anchor = bell();
    if (!pop || !anchor) return;
    const r = anchor.getBoundingClientRect();
    pop.style.top = `${Math.round(r.bottom + 8)}px`;
    pop.style.left = `${Math.max(12, Math.min(window.innerWidth - pop.offsetWidth - 12, r.right - pop.offsetWidth))}px`;
  }
  async function drawPop(loading = false) {
    if (!pop) return;
    const list = loading && !state.items.length ? `<p class="dfn-empty">Loading…</p>` : state.items.length ? state.items.map(itemMarkup).join("") : `<p class="dfn-empty">You're all caught up. New notifications appear here.</p>`;
    pop.innerHTML = `<div class="dfn-pop-head"><strong>Notifications</strong><button type="button" class="dfn-link" data-dfn-readall ${state.unread ? "" : "disabled"}>Mark all read</button></div><div class="dfn-pop-body">${list}<div data-dfn-sections></div></div><div class="dfn-pop-foot"><button type="button" class="dfn-link" data-dfn-all>See all notifications${state.unread ? ` (${state.unread} unread)` : ""}</button></div>`;
    place();
    const holder = pop.querySelector("[data-dfn-sections]");
    for (const section of sections) {
      try {
        const html = await section();
        if (html && pop && holder.isConnected) holder.insertAdjacentHTML("beforeend", `<div class="dfn-section">${html}</div>`);
      } catch {}
    }
    place();
  }
  async function loadLatest() {
    const page = await DF.api("/me/notifications?limit=8");
    state.items = page.items || [];
    state.unread = Number(page.unread) || 0;
    state.loadedAt = Date.now();
    paint();
  }
  async function openPop() {
    closePop();
    pop = document.createElement("div");
    pop.className = "dfn-pop";
    pop.id = "notificationsPanel";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "Notifications");
    document.body.append(pop);
    bell()?.setAttribute("aria-expanded", "true");
    void drawPop(true);
    try {
      await loadLatest();
    } catch (error) {
      if (pop) pop.querySelector(".dfn-pop-body").innerHTML = `<p class="dfn-empty">${esc(DF.describe(error))}</p>`;
      return;
    }
    void drawPop();
  }

  // Capture phase on window, registered before the bridges: the bell is ours (no demo toasts).
  window.addEventListener(
    "click",
    event => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("#notifications, #notificationButton")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return void (pop ? closePop() : openPop());
      }
      const item = target.closest("[data-dfn-id]");
      if (item) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return void openItem(item.dataset.dfnId, item.dataset.dfnLink);
      }
      if (target.closest("[data-dfn-readall]")) {
        event.stopImmediatePropagation();
        return void readAll();
      }
      if (target.closest("[data-dfn-all]")) {
        event.stopImmediatePropagation();
        closePop();
        return void openPage();
      }
      const filter = target.closest("[data-dfn-filter]");
      if (filter) {
        event.stopImmediatePropagation();
        state.page.filter = filter.dataset.dfnFilter;
        return void loadPage(true);
      }
      if (target.closest("[data-dfn-more]")) {
        event.stopImmediatePropagation();
        return void loadPage(false);
      }
      // Panels' own links inside the dropdown (e.g. the operations alerts) close it.
      if (pop && pop.contains(target) && target.closest("button")) return void setTimeout(closePop);
      if (pop && !pop.contains(target)) closePop();
    },
    true,
  );
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && pop) closePop();
  });
  window.addEventListener("resize", place);

  // ───────────── the Notifications page ─────────────

  const pageVisible = () => $("breadcrumbPage")?.textContent === PAGE && !!document.querySelector("#mainContent .dfn-page");

  function drawPage() {
    const main = $("mainContent");
    if (!main) return;
    const p = state.page;
    const rows = p.items.length
      ? p.items.map(itemMarkup).join("")
      : p.loading
        ? `<p class="dfn-empty">Loading…</p>`
        : `<p class="dfn-empty">${esc(p.error || (p.filter === "unread" ? "No unread notifications." : "No notifications yet. Updates about your work appear here."))}</p>`;
    main.innerHTML = `<div class="page-heading"><div><p class="eyebrow">Your inbox</p><h1>Notifications</h1><p class="subtitle">Updates for you: parcels, tickets, approvals and alerts. Click one to open it.</p></div><div class="heading-actions"><button type="button" class="button" data-dfn-readall ${state.unread ? "" : "disabled"}>Mark all as read</button></div></div>
      <section class="panel dfn-page"><div class="panel-heading"><div><h2 class="panel-title">${p.filter === "unread" ? "Unread" : "All notifications"}</h2><p class="panel-subtitle">${state.unread} unread · newest first</p></div></div>
      <div class="dfn-filters" role="tablist" aria-label="Show"><button type="button" role="tab" class="button button-sm${p.filter === "all" ? " button-primary" : ""}" data-dfn-filter="all" aria-selected="${p.filter === "all"}">All</button><button type="button" role="tab" class="button button-sm${p.filter === "unread" ? " button-primary" : ""}" data-dfn-filter="unread" aria-selected="${p.filter === "unread"}">Unread${state.unread ? ` (${state.unread > 99 ? "99+" : state.unread})` : ""}</button></div>
      <div class="dfn-list" id="dfnList">${rows}</div>${p.next ? `<div class="dfn-more"><button type="button" class="button" data-dfn-more ${p.loading ? "disabled" : ""}>Load more</button></div>` : ""}</section>`;
  }

  async function loadPage(first) {
    const p = state.page;
    if (p.loading && !first) return;
    p.loading = true;
    if (first) {
      p.items = [];
      p.next = null;
    }
    p.error = "";
    if (pageVisible() || first) drawPage();
    const seq = (loadPage.seq = (loadPage.seq || 0) + 1);
    try {
      const params = new URLSearchParams({ limit: "25" });
      if (p.filter === "unread") params.set("unread", "true");
      if (!first && p.next) params.set("cursor", p.next);
      const page = await DF.api(`/me/notifications?${params}`);
      if (seq !== loadPage.seq) return;
      p.items = first ? page.items : [...p.items, ...page.items];
      p.next = page.nextCursor;
      state.unread = Number(page.unread) || 0;
      paint();
    } catch (error) {
      p.error = DF.describe(error);
    } finally {
      if (seq === loadPage.seq) p.loading = false;
    }
    if ($("breadcrumbPage")?.textContent === PAGE) drawPage();
  }

  function showPage() {
    const crumb = $("breadcrumbPage");
    if (crumb) crumb.textContent = PAGE;
    document.querySelectorAll(".nav-item").forEach(item => item.classList.toggle("active", item.dataset.page === PAGE));
    $("sidebar")?.classList.remove("open");
    drawPage();
    void loadPage(true);
  }
  /** Opens the Notifications page through the panel's own navigation (history, title). */
  function openPage() {
    if (DF.nav?.panel) DF.nav.go(`${location.pathname}?page=notifications`);
    else window[RENDERER]?.(PAGE);
  }

  // The panel's renderer draws the Notifications page (the other pages pass through).
  const original = window[RENDERER];
  if (typeof original === "function") {
    window[RENDERER] = function (page, ...rest) {
      if (page === PAGE) return showPage();
      return original.call(this, page, ...rest);
    };
  }

  // ───────────── live ─────────────

  DF.live(["notification.created", "notification.read"], async () => {
    await refreshCount();
    if (pop && Date.now() - state.loadedAt > 500) {
      await loadLatest().catch(() => undefined);
      void drawPop();
    }
    if (pageVisible() && !state.page.loading && state.page.items.length <= 25) void loadPage(true);
  }, { debounceMs: 250, fallbackMs: 90_000 });

  paint();
  void refreshCount();

  window.DFNotify = {
    PAGE,
    refresh: refreshCount,
    open: openPop,
    close: closePop,
    openPage,
    /** An extra section in the dropdown: fn() → HTML (or "" for nothing), called each time it opens. */
    addSection: fn => sections.push(fn),
    get unread() {
      return state.unread;
    },
  };
})();
