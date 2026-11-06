/*
 * Super admin › Audit & security log: the whole log, 20 rows a page from the server (GET /audit-logs ?page &q),
 * in the page's own table. The search runs on the server too, so it covers every entry, not one page.
 */
(() => {
  const DF = window.DF;
  if (!DF) return;
  const PAGE = "Audit log";
  const SIZES = [20, 50, 100];
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmt = n => Number(n || 0).toLocaleString("en-US");
  const S = { no: 1, size: SIZES[0], q: "", total: 0, pages: 1, rows: null, seq: 0, open: false, timer: null };

  function drawRows() {
    const body = $("genericBody");
    if (!body) return;
    if (!S.rows) return void (body.innerHTML = `<tr><td colspan="6" class="empty-state">Loading the log…</td></tr>`);
    body.innerHTML = S.rows.length
      ? S.rows.map(a => `<tr>${window.DFAdminAudit.row(a).map((cell, i, all) => `<td>${i === all.length - 1 ? statusPill(cell) : esc(cell)}</td>`).join("")}</tr>`).join("") // eslint-disable-line no-undef -- 01.js
      : `<tr><td colspan="6" class="empty-state">${S.q ? "No entries match the search." : "No entries yet."}</td></tr>`;
    let foot = $("auditPager");
    if (!foot) {
      body.closest(".table-scroll").insertAdjacentHTML("afterend", `<div class="df-table-pager" id="auditPager"></div>`);
      foot = $("auditPager");
    }
    const first = (S.no - 1) * S.size + 1;
    const jump = (label, no, aria, { on = false, off = false } = {}) => `<button type="button" class="button button-sm${on ? " button-primary" : ""}" data-audit-page="${no}" aria-label="${esc(aria)}"${on ? ' aria-current="page"' : ""}${off ? " disabled" : ""}>${esc(label)}</button>`;
    const near = [...new Set([1, S.no - 1, S.no, S.no + 1, S.pages])].filter(n => n >= 1 && n <= S.pages).sort((a, b) => a - b);
    // .pagination: the page has its own, so shared/table-pager.js leaves this table alone.
    foot.innerHTML = `<span>${S.total ? `Showing ${fmt(first)}–${fmt(first + S.rows.length - 1)} of ${fmt(S.total)}` : "No entries"}</span><div><label style="display:inline-flex;gap:6px;align-items:center;margin-right:6px">Rows per page<select class="select-small" id="auditSize" aria-label="Rows per page">${SIZES.map(n => `<option value="${n}"${n === S.size ? " selected" : ""}>${n}</option>`).join("")}</select></label><nav class="pagination" aria-label="Pages" style="display:inline-flex;gap:4px;align-items:center">${jump("‹", S.no - 1, "Previous page", { off: S.no === 1 })}${near.map((n, i) => `${i && n - near[i - 1] > 1 ? "<span>…</span>" : ""}${jump(fmt(n), n, `Page ${n}`, { on: n === S.no })}`).join("")}${jump("›", S.no + 1, "Next page", { off: S.no === S.pages })}</nav></div>`;
  }

  async function load() {
    const seq = ++S.seq;
    const params = new URLSearchParams({ page: String(S.no), limit: String(S.size) });
    if (S.q.trim()) params.set("q", S.q.trim());
    try {
      const answer = await DF.api(`/audit-logs?${params}`);
      if (seq !== S.seq) return;
      // The search or a smaller log left this page empty: the last page with rows.
      if (!answer.items.length && answer.total > 0) {
        S.no = answer.pages;
        return load();
      }
      Object.assign(S, { rows: answer.items, total: answer.total, pages: Math.max(1, answer.pages) });
    } catch (error) {
      if (seq !== S.seq) return;
      window.showToast?.(DF.describe(error));
      S.rows = S.rows || [];
    }
    if (S.open) drawRows();
  }

  function takeOver() {
    const search = $("genericSearch");
    if (search) {
      // A fresh box: the page script's handler only hides the rows on screen.
      const box = search.cloneNode(false);
      box.placeholder = "Search action or person";
      box.value = S.q;
      search.replaceWith(box);
    }
    // The sample footer ("100 most recent events") gives way to the real pages.
    document.querySelector("#mainContent .table-panel .table-footer")?.remove();
    const subtitle = document.querySelector("#mainContent .table-panel .panel-subtitle");
    if (subtitle) subtitle.textContent = "Newest first · every entry, 20 a page unless you choose more";
    drawRows();
    void load();
  }

  document.addEventListener("input", event => {
    if (!S.open || event.target.id !== "genericSearch") return;
    S.q = event.target.value;
    S.no = 1;
    clearTimeout(S.timer);
    S.timer = setTimeout(() => void load(), 350);
  });
  document.addEventListener("change", event => {
    if (!S.open || event.target.id !== "auditSize") return;
    S.size = Number(event.target.value);
    S.no = 1;
    void load();
  });
  document.addEventListener("click", event => {
    const jump = event.target instanceof Element ? event.target.closest("[data-audit-page]") : null;
    if (!jump || jump.disabled) return;
    S.no = Number(jump.dataset.auditPage);
    void DF.busy(jump, load).then(() => document.querySelector("#mainContent .table-panel")?.scrollIntoView({ block: "start", behavior: "smooth" }));
  });

  const base = window.showPage;
  window.showPage = showPage = function (page) {
    S.open = page === PAGE;
    base(page);
    if (S.open) takeOver();
  };
})();
