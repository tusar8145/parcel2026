/*
 * Searchable selects for every panel: DF.searchSelect(select, opts).
 *
 * The native <select> stays exactly where it is and stays the source of truth: it keeps its
 * look, its value, its change events, `disabled` / `hidden` and every script that reads it.
 * Opening it (click, tap, Enter / Space / Alt+↓ / F4, or just typing) shows a small popup with
 * a search box and the options instead of the browser's list:
 *   - type to filter (every word must match; accents and case are ignored), optgroups kept;
 *   - ↑ / ↓ / Home / End / PageUp / PageDown move, Enter picks, Esc / Tab close;
 *   - picking sets the select (selectedIndex) and fires `input` + `change` (bubbling), so page
 *     scripts, bridges and React's onChange all see a normal change;
 *   - ARIA: the search box is a combobox (aria-controls / aria-activedescendant) over a listbox
 *     of options (groups as role="group"); the select gets aria-haspopup / aria-expanded;
 *   - the list is rebuilt from the select's current options every time it opens and while it is
 *     open (a MutationObserver), so selects refilled later stay correct;
 *   - works in modals, drawers and <dialog>s (the popup goes into an open modal <dialog>, else
 *     <body>, fixed-positioned above everything, and follows scrolling).
 *
 * Applied automatically to every single-choice select with more than DF.searchSelect.threshold
 * (12) options, including selects added or refilled later (events are delegated, nothing is bound
 * per element). Opt out with data-search="off"; opt in a short list with data-search or by calling
 * DF.searchSelect(select, { label, placeholder }).
 */
(() => {
  const DF = window.DF || (window.DF = {});
  const explicit = new WeakMap(); // select → options from DF.searchSelect(select, opts)
  const THRESHOLD = 12;
  let uid = 0;
  let open = null; // { select, pop, input, list, items, active, observer, query }

  // ───────────── styles (each panel's own tokens, with fallbacks) ─────────────
  const css = `
.df-ss-pop{position:fixed;z-index:2147483600;box-sizing:border-box;display:flex;flex-direction:column;min-width:220px;max-width:calc(100vw - 16px);background:#fff;border:1px solid var(--line,#e4e8ee);border-radius:9px;box-shadow:0 14px 38px rgba(16,24,40,.18);font:inherit;font-size:13px;color:var(--ink,#172033);overflow:hidden}
.df-ss-pop *{box-sizing:border-box}
.df-ss-search{position:relative;padding:8px;border-bottom:1px solid var(--line,#eef1f5)}
.df-ss-search svg{position:absolute;left:18px;top:50%;transform:translateY(-50%);width:14px;height:14px;color:var(--muted,#8792a2);pointer-events:none}
.df-ss-input{display:block;width:100%;margin:0;padding:8px 10px 8px 30px;border:1px solid var(--line,#e4e8ee);border-radius:7px;background:#fff;color:inherit;font:inherit;font-size:13px;outline:none;min-height:0}
.df-ss-input:focus{border-color:var(--blue,var(--green,#3766e8));box-shadow:0 0 0 3px color-mix(in srgb,var(--blue,var(--green,#3766e8)) 14%,transparent)}
.df-ss-list{overflow:auto;overscroll-behavior:contain;padding:4px;max-height:300px;outline:none}
.df-ss-group-label{padding:8px 10px 3px;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--muted,#8792a2)}
.df-ss-option{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:6px;cursor:pointer;line-height:1.35;word-break:break-word}
.df-ss-option[aria-selected="true"]{font-weight:600;color:var(--blue,var(--green,#3766e8))}
.df-ss-option[aria-selected="true"]::after{content:"✓";margin-left:auto;padding-left:8px}
.df-ss-option.df-ss-active{background:var(--blue-soft,var(--mint,#edf2ff))}
.df-ss-option[aria-disabled="true"]{color:#a7b0bd;cursor:not-allowed}
.df-ss-text{flex:1;min-width:0}
.df-ss-option mark{padding:0;background:none;color:inherit;font-weight:700;text-decoration:underline;text-underline-offset:2px}
.df-ss-empty{padding:12px 10px;color:var(--muted,#8792a2);text-align:center}
.df-ss-count{padding:5px 10px 7px;border-top:1px solid var(--line,#eef1f5);color:var(--muted,#8792a2);font-size:11px}
select[data-df-ss]{cursor:pointer}
@media (max-width:640px){.df-ss-pop{font-size:14px}.df-ss-input{font-size:16px}.df-ss-option{padding:10px}}
`;
  function injectStyles() {
    if (document.getElementById("df-select-search-css")) return;
    const style = document.createElement("style");
    style.id = "df-select-search-css";
    style.textContent = css;
    document.head.append(style);
  }

  // ───────────── eligibility ─────────────
  const optOut = select => select.dataset.search === "off" || select.dataset.search === "false";
  function eligible(select) {
    if (!(select instanceof HTMLSelectElement) || select.multiple || select.size > 1 || optOut(select)) return false;
    const opts = explicit.get(select);
    if (opts) return select.options.length > (opts.threshold ?? 0);
    if (select.hasAttribute("data-search")) return true;
    return select.options.length > (DF.searchSelect?.threshold ?? THRESHOLD);
  }
  function mark(select) {
    if (eligible(select)) {
      if (!select.hasAttribute("data-df-ss")) {
        select.setAttribute("data-df-ss", "");
        select.setAttribute("aria-haspopup", "listbox");
        if (!select.hasAttribute("aria-expanded")) select.setAttribute("aria-expanded", "false");
      }
    } else if (select.hasAttribute("data-df-ss")) {
      select.removeAttribute("data-df-ss");
      select.removeAttribute("aria-haspopup");
      select.removeAttribute("aria-expanded");
    }
  }

  // ───────────── text helpers ─────────────
  const fold = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  function labelOf(select, opts) {
    if (opts?.label) return opts.label;
    const label = select.labels?.[0]?.textContent || select.getAttribute("aria-label") || select.title || "";
    return label.replace(/\s*\*\s*$/, "").replace(/\s*\(optional\)\s*/i, "").trim() || "options";
  }
  /** The option text with the first match of each word underlined. */
  function highlight(text, words) {
    if (!words.length) return esc(text);
    const folded = fold(text);
    const marks = [];
    for (const w of words) {
      const i = folded.indexOf(w);
      if (i >= 0) marks.push([i, i + w.length]);
    }
    marks.sort((a, b) => a[0] - b[0]);
    let out = "";
    let at = 0;
    for (const [s, e] of marks) {
      if (s < at) continue;
      out += esc(text.slice(at, s)) + `<mark>${esc(text.slice(s, e))}</mark>`;
      at = e;
    }
    return out + esc(text.slice(at));
  }

  // ───────────── popup ─────────────
  const SEARCH_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`;

  function openFor(select, query = "") {
    if (open?.select === select) return;
    close(false);
    if (select.disabled || !select.isConnected || !select.getClientRects().length) return;
    injectStyles();
    mark(select);
    const opts = explicit.get(select) || {};
    const id = `df-ss-${++uid}`;
    const label = labelOf(select, opts);
    const pop = document.createElement("div");
    pop.className = "df-ss-pop";
    pop.dataset.dfSsFor = select.id || "";
    pop.innerHTML = `<div class="df-ss-search">${SEARCH_ICON}<input class="df-ss-input" type="text" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls="${id}-list" aria-label="Search ${esc(label.toLowerCase())}" placeholder="${esc(opts.placeholder || `Search ${label.toLowerCase()}…`)}" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="done"></div><div class="df-ss-list" role="listbox" id="${id}-list" aria-label="${esc(label)}" tabindex="-1"></div><div class="df-ss-count" aria-live="polite"></div>`;
    const container = select.closest("dialog")?.matches?.(":modal") ? select.closest("dialog") : document.body;
    container.append(pop);
    const input = pop.querySelector(".df-ss-input");
    const list = pop.querySelector(".df-ss-list");
    open = { select, pop, input, list, id, items: [], active: -1, query };
    input.value = query;
    render(true);
    place();
    select.setAttribute("aria-expanded", "true");
    select.setAttribute("aria-controls", `${id}-list`);
    open.observer = new MutationObserver(() => open?.select === select && render(false));
    open.observer.observe(select, { childList: true, subtree: true, attributes: true, characterData: true, attributeFilter: ["label", "disabled", "hidden", "value", "selected"] });
    input.addEventListener("input", () => render(true));
    list.addEventListener("mousedown", event => event.preventDefault()); // keep focus in the search box
    list.addEventListener("click", event => {
      const item = event.target.closest?.(".df-ss-option");
      if (item) choose(Number(item.dataset.index));
    });
    list.addEventListener("mousemove", event => {
      const item = event.target.closest?.(".df-ss-option");
      if (item && Number(item.dataset.pos) !== open.active) setActive(Number(item.dataset.pos), false);
    });
    pop.addEventListener("focusout", event => {
      const next = event.relatedTarget;
      if (open && next && !pop.contains(next) && next !== select) close(false);
    });
    input.focus({ preventScroll: true });
    if (query) input.setSelectionRange(query.length, query.length);
  }

  /** Rebuilds the list from the select's current options (keeps the search text). */
  function render(resetActive) {
    const { select, input, list, id } = open;
    const words = fold(input.value).split(/\s+/).filter(Boolean);
    const items = [];
    let html = "";
    let group = null;
    let groupHtml = "";
    let groupHas = false;
    const flush = () => {
      if (group && groupHas) html += `<div role="group" aria-labelledby="${id}-g${items.length}"><div class="df-ss-group-label" id="${id}-g${items.length}" role="presentation">${esc(group.label)}</div>${groupHtml}</div>`;
      group = null;
      groupHtml = "";
      groupHas = false;
    };
    [...select.options].forEach((option, index) => {
      const parent = option.parentElement instanceof HTMLOptGroupElement ? option.parentElement : null;
      if (parent !== group) {
        flush();
        group = parent;
      }
      if (option.hidden || parent?.hidden) return;
      const text = option.label || option.textContent || "";
      // The empty "Choose …" placeholder only shows before anything is typed.
      if (words.length && option.value === "") return;
      const hay = fold(`${text} ${option.dataset.search || ""}`);
      if (words.length && !words.every(w => hay.includes(w))) return;
      const disabled = option.disabled || parent?.disabled;
      const pos = items.length;
      items.push({ index, disabled });
      const markup = `<div class="df-ss-option" role="option" id="${id}-o${pos}" data-index="${index}" data-pos="${pos}" aria-selected="${index === select.selectedIndex}"${disabled ? ' aria-disabled="true"' : ""}><span class="df-ss-text">${highlight(text, words)}</span></div>`;
      if (group) {
        groupHtml += markup;
        groupHas = true;
      } else html += markup;
    });
    flush();
    list.innerHTML = html || `<div class="df-ss-empty">No matches for “${esc(input.value.trim())}”</div>`;
    const total = [...select.options].filter(o => o.value !== "" && !o.hidden).length;
    const shown = items.filter(i => select.options[i.index].value !== "").length;
    open.pop.querySelector(".df-ss-count").textContent = words.length ? `${shown} of ${total} match` : `${total} options · type to search`;
    open.items = items;
    let active = resetActive ? -1 : Math.min(open.active, items.length - 1);
    if (resetActive) {
      const current = items.findIndex(i => i.index === select.selectedIndex && select.options[i.index]?.value !== "");
      active = words.length ? items.findIndex(i => !i.disabled) : current >= 0 ? current : items.findIndex(i => !i.disabled);
    }
    setActive(active, true);
  }

  function setActive(pos, scroll) {
    const { input, list, items } = open;
    open.active = pos;
    list.querySelector(".df-ss-active")?.classList.remove("df-ss-active");
    const el = pos >= 0 && pos < items.length ? list.querySelector(`[data-pos="${pos}"]`) : null;
    if (el) {
      el.classList.add("df-ss-active");
      input.setAttribute("aria-activedescendant", el.id);
      if (scroll) el.scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  }

  function move(delta) {
    const { items } = open;
    if (!items.length) return;
    let pos = open.active;
    for (let step = 0; step < items.length; step++) {
      pos = pos < 0 ? (delta > 0 ? 0 : items.length - 1) : Math.max(0, Math.min(items.length - 1, pos + delta));
      if (!items[pos].disabled) break;
      if ((pos === 0 && delta < 0) || (pos === items.length - 1 && delta > 0)) break;
    }
    if (items[pos] && !items[pos].disabled) setActive(pos, true);
  }

  function choose(index) {
    const { select } = open;
    const option = select.options[index];
    if (!option || option.disabled || option.parentElement?.disabled) return;
    const changed = select.selectedIndex !== index;
    close(true);
    if (changed) {
      select.selectedIndex = index;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  function close(refocus) {
    if (!open) return;
    const { select, pop, observer } = open;
    open = null;
    observer?.disconnect();
    pop.remove();
    select.setAttribute("aria-expanded", "false");
    select.removeAttribute("aria-controls");
    if (refocus && select.isConnected) select.focus({ preventScroll: true });
  }

  /** Below the select (or above when there's more room there), inside the viewport. */
  function place() {
    if (!open) return;
    const { select, pop, list } = open;
    if (!select.isConnected || !select.getClientRects().length) return close(false);
    const r = select.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const width = Math.min(Math.max(r.width, 240), vw - 16);
    const below = vh - r.bottom - 8;
    const above = r.top - 8;
    const up = below < 260 && above > below;
    const room = Math.max(140, (up ? above : below) - 4);
    list.style.maxHeight = `${Math.max(90, Math.min(300, room - 90))}px`;
    pop.style.width = `${width}px`;
    pop.style.maxHeight = `${room}px`;
    const left = Math.max(8, Math.min(r.left, vw - width - 8));
    pop.style.left = `${left}px`;
    pop.style.top = up ? "" : `${r.bottom + 4}px`;
    pop.style.bottom = up ? `${vh - r.top + 4}px` : "";
    pop.style.transform = "";
    // A transformed ancestor (some dialogs) moves fixed elements: correct by the difference.
    const got = pop.getBoundingClientRect();
    const dx = left - got.left;
    const dy = up ? r.top - 4 - got.bottom : r.bottom + 4 - got.top;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) pop.style.transform = `translate(${dx}px,${dy}px)`;
  }

  // ───────────── delegated events (capture on window: before modal / shortcut handlers) ─────────────
  const selectOf = target => (target instanceof HTMLSelectElement && eligible(target) ? target : null);

  window.addEventListener(
    "mousedown",
    event => {
      if (open && !open.pop.contains(event.target) && event.target !== open.select) close(false);
      const select = event.button === 0 ? selectOf(event.target) : null;
      if (!select || select.disabled) return;
      event.preventDefault(); // no native list
      if (open?.select === select) return close(true);
      openFor(select); // focus goes straight to the search box (the select isn't blurred)
    },
    true,
  );

  // Touch: the browser opens its own picker after the tap; cancel that and open the popup.
  let touch = null;
  window.addEventListener("touchstart", event => (touch = selectOf(event.target) ? { x: event.touches[0].clientX, y: event.touches[0].clientY, target: event.target } : null), { capture: true, passive: true });
  window.addEventListener(
    "touchend",
    event => {
      const select = selectOf(event.target);
      if (!select || !touch || touch.target !== select || select.disabled) return;
      const t = event.changedTouches[0];
      if (Math.abs(t.clientX - touch.x) > 10 || Math.abs(t.clientY - touch.y) > 10) return; // a scroll
      event.preventDefault();
      if (open?.select === select) return close(true);
      openFor(select);
    },
    { capture: true, passive: false },
  );

  window.addEventListener(
    "keydown",
    event => {
      if (open && (event.target === open.input || open.pop.contains(event.target))) {
        const handled = () => {
          event.preventDefault();
          event.stopImmediatePropagation();
        };
        const page = Math.max(1, Math.floor(open.list.clientHeight / 32));
        switch (event.key) {
          case "ArrowDown":
            if (event.altKey) return;
            handled();
            return move(1);
          case "ArrowUp":
            if (event.altKey) return handled(), close(true);
            handled();
            return move(-1);
          case "PageDown":
            handled();
            return move(page);
          case "PageUp":
            handled();
            return move(-page);
          case "Home":
          case "End":
            if (!event.ctrlKey && open.input.value) return; // move the caret in the search text
            handled();
            return setActive(event.key === "Home" ? open.items.findIndex(i => !i.disabled) : open.items.length - 1 - [...open.items].reverse().findIndex(i => !i.disabled), true);
          case "Enter": {
            handled();
            const item = open.items[open.active];
            return item ? choose(item.index) : undefined;
          }
          case "Escape":
            handled();
            return close(true);
          case "Tab":
            // Leaves the popup and goes on from the select.
            return close(true);
        }
        return;
      }
      const select = selectOf(event.target);
      if (!select || select.disabled || event.ctrlKey || event.metaKey) return;
      const printable = event.key.length === 1 && !event.altKey && event.key !== " ";
      if (printable || event.key === "Enter" || event.key === " " || event.key === "F4" || (event.altKey && (event.key === "ArrowDown" || event.key === "ArrowUp"))) {
        event.preventDefault();
        event.stopImmediatePropagation();
        openFor(select, printable ? event.key : "");
      }
    },
    true,
  );

  window.addEventListener("focusin", event => event.target instanceof HTMLSelectElement && mark(event.target), true);
  window.addEventListener("resize", () => open && place());
  window.addEventListener("scroll", event => open && !open.pop.contains(event.target) && place(), true);

  // ARIA hints on long selects as they appear or are refilled (debounced).
  let scanTimer = 0;
  function scan() {
    scanTimer = 0;
    for (const select of document.querySelectorAll("select")) mark(select);
    if (open && (!open.select.isConnected || !open.select.getClientRects().length)) close(false);
  }
  const queueScan = () => scanTimer || (scanTimer = setTimeout(scan, 120));
  const start = () => {
    injectStyles();
    // The website keeps its markup identical to design-reference/ (DOM parity tests): there the hints
    // are added when a select is focused or opened, not up front.
    if (document.body.dataset.app === "website") return;
    scan();
    new MutationObserver(queueScan).observe(document.body, { childList: true, subtree: true });
  };
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });

  /**
   * Makes `select` searchable (also a short one). opts: { label, placeholder, threshold = 0 }.
   * Returns { open(query), close(), refresh() }. Call again to change the options.
   */
  function searchSelect(select, opts = {}) {
    if (!(select instanceof HTMLSelectElement)) return null;
    explicit.set(select, { threshold: 0, ...opts });
    mark(select);
    return {
      open: query => openFor(select, query || ""),
      close: () => open?.select === select && close(true),
      refresh: () => (open?.select === select ? render(false) : mark(select)),
    };
  }
  searchSelect.threshold = THRESHOLD;
  searchSelect.isOpen = () => !!open;
  DF.searchSelect = searchSelect;
})();
