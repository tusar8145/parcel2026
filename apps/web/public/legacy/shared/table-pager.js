/*
 * Numbered pages for every long table on a panel page. Tables with pages of their own (server-paged lists,
 * tables with a .pagination footer) are left alone. A table's search and filters hide rows with [hidden]: the
 * pages cover the rows that remain, and a table with few rows has no footer.
 */
(() => {
  const SIZES = [25, 50, 100];
  const state = new WeakMap();
  const esc = text => String(text).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  document.head.insertAdjacentHTML(
    "beforeend",
    `<style id="dfTablePagerCss">.df-page-off{display:none!important}.df-table-pager{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;padding:11px 16px;border-top:1px solid var(--line,#e4e7ec);color:#98a2ae;font-size:12px}.df-table-pager div{display:inline-flex;flex-wrap:wrap;gap:4px;align-items:center}</style>`,
  );

  const hasOwnPages = table => {
    const box = table.closest(".table-panel, .panel") || table.parentElement;
    return !!table.closest("[data-list]") || !!table.tBodies[0]?.dataset.listBody || !!box?.querySelector(".pagination, [data-list-more]");
  };

  function paint(table) {
    const body = table.tBodies[0];
    if (!body) return;
    const anchor = table.closest(".table-scroll") || table;
    const s = state.get(table) || { size: SIZES[0], page: 1, footer: null };
    state.set(table, s);
    const rows = [...body.rows].filter(row => !row.hidden && !row.querySelector("td[colspan]"));
    for (const row of body.rows) row.classList.remove("df-page-off");
    if (rows.length <= SIZES[0]) {
      s.footer?.remove();
      s.footer = null;
      s.page = 1;
      return;
    }
    const pages = Math.ceil(rows.length / s.size);
    s.page = Math.min(s.page, pages);
    const first = (s.page - 1) * s.size;
    rows.forEach((row, i) => row.classList.toggle("df-page-off", i < first || i >= first + s.size));
    if (!s.footer?.isConnected) {
      s.footer = document.createElement("div");
      s.footer.className = "df-table-pager";
      anchor.after(s.footer);
      s.footer.addEventListener("click", event => {
        const jump = event.target.closest("[data-page-to]");
        if (!jump || jump.disabled) return;
        s.page = Number(jump.dataset.pageTo);
        paint(table);
        anchor.scrollIntoView({ block: "nearest" });
      });
      s.footer.addEventListener("change", event => {
        s.size = Number(event.target.value);
        s.page = 1;
        paint(table);
      });
    }
    const button = (label, page, aria, { on = false, off = false } = {}) =>
      `<button type="button" class="button button-sm${on ? " button-primary" : ""}" data-page-to="${page}" aria-label="${esc(aria)}"${on ? ' aria-current="page"' : ""}${off ? " disabled" : ""}>${esc(label)}</button>`;
    const near = [...new Set([1, s.page - 1, s.page, s.page + 1, pages])].filter(n => n >= 1 && n <= pages).sort((a, b) => a - b);
    s.footer.innerHTML = `<span>Showing ${(first + 1).toLocaleString("en-US")}–${Math.min(first + s.size, rows.length).toLocaleString("en-US")} of ${rows.length.toLocaleString("en-US")}</span><div><label style="display:inline-flex;gap:6px;align-items:center;margin-right:6px">Rows per page<select class="select-small" aria-label="Rows per page">${SIZES.map(n => `<option value="${n}"${n === s.size ? " selected" : ""}>${n}</option>`).join("")}</select></label><nav aria-label="Pages" style="display:inline-flex;gap:4px;align-items:center">${button("‹", s.page - 1, "Previous page", { off: s.page === 1 })}${near.map((n, i) => `${i && n - near[i - 1] > 1 ? "<span>…</span>" : ""}${button(n, n, `Page ${n}`, { on: n === s.page })}`).join("")}${button("›", s.page + 1, "Next page", { off: s.page === pages })}</nav></div>`;
  }

  let queued = false;
  function scan() {
    queued = false;
    const main = document.getElementById("mainContent");
    if (!main) return;
    for (const table of main.querySelectorAll("table")) if (!hasOwnPages(table) && (table.tBodies[0]?.rows.length > SIZES[0] || state.get(table)?.footer)) paint(table);
  }
  const queue = records => {
    if (queued || records.every(r => r.target.closest?.(".df-table-pager"))) return;
    queued = true;
    requestAnimationFrame(scan);
  };
  const start = () => {
    const main = document.getElementById("mainContent");
    if (main) new MutationObserver(queue).observe(main, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
