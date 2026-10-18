/*
 * Dashboard period filter (window.DF.period), shared by every panel's overview pages.
 *
 *   Today · Yesterday · This week · Last 7 days · This month · Last month · Custom range (from–to)
 *
 * Dates are Asia/Dhaka calendar days (UTC+6, no daylight saving); weeks start on Saturday, the first
 * day of the Bangladeshi week. The API takes the same days as ?from=YYYY-MM-DD&to=YYYY-MM-DD
 * (inclusive; apps/api/src/common/period.ts). The choice is remembered per page: in the URL
 * (?period=this_week, or ?period=custom&from=…&to=…, so a shared link opens the same period) and in
 * localStorage (`deliveryfast-period:<page>`) as the fallback.
 *
 *   const period = DF.period.control("ops-today", { defaultKey: "today", onChange: state => reload() });
 *   period.activate();               // when the page is shown: URL (deep link) → saved choice → default
 *   period.mount(container);         // the select (+ date pickers for a custom range), panel classes
 *   period.query();                  // "from=2026-10-17&to=2026-10-18"
 *   period.text();                   // "This week · 17–18 Oct"
 *
 * Only the page that last showed its period owns the URL's period, so moving between pages within a
 * panel never carries one page's period into another; the first page shown after loading reads it.
 */
(() => {
  const DF = window.DF;
  if (!DF) return;
  const DHAKA_MS = 6 * 3600_000;
  const DAY_MS = 86_400_000;
  const MAX_DAYS = 366;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const PRESETS = [
    ["today", "Today"],
    ["yesterday", "Yesterday"],
    ["this_week", "This week"],
    ["last_7_days", "Last 7 days"],
    ["this_month", "This month"],
    ["last_month", "Last month"],
    ["custom", "Custom range"],
  ];
  const LABEL = Object.fromEntries(PRESETS);
  const DAY = /^\d{4}-\d{2}-\d{2}$/;

  const today = (now = new Date()) => new Date(now.getTime() + DHAKA_MS).toISOString().slice(0, 10);
  const shift = (day, days) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
  const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
  const validDay = day => DAY.test(day || "") && !Number.isNaN(Date.parse(`${day}T00:00:00Z`)) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;

  /** The Dhaka days [from, to] of a preset. */
  function range(key, now = new Date()) {
    const t = today(now);
    const [y, m] = t.split("-").map(Number);
    const monthStart = (year, month) => new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 10);
    switch (key) {
      case "yesterday":
        return { from: shift(t, -1), to: shift(t, -1) };
      case "this_week":
        return { from: shift(t, -((new Date(`${t}T00:00:00Z`).getUTCDay() + 1) % 7)), to: t };
      case "last_7_days":
        return { from: shift(t, -6), to: t };
      case "this_month":
        return { from: monthStart(y, m), to: t };
      case "last_month":
        return { from: monthStart(y, m - 1), to: shift(monthStart(y, m), -1) };
      default:
        return { from: t, to: t };
    }
  }

  /** A problem with a custom range, or "". */
  function problem(from, to) {
    if (!validDay(from) || !validDay(to)) return "Choose both dates";
    if (from > to) return "The start date must be on or before the end date";
    if (daysBetween(from, to) > MAX_DAYS) return `Choose at most ${MAX_DAYS} days`;
    return "";
  }

  /** A full state { key, from, to } (presets get today's dates). */
  function normalize(raw, defaultKey) {
    if (raw?.key === "custom" && !problem(raw.from, raw.to)) return { key: "custom", from: raw.from, to: raw.to };
    const key = raw?.key && raw.key !== "custom" && LABEL[raw.key] ? raw.key : defaultKey;
    return { key, ...range(key) };
  }

  /** "18 Oct", "13–18 Oct", "28 Sep – 18 Oct", "28 Dec 2025 – 3 Jan 2026". */
  function span(from, to) {
    const part = day => {
      const [y, m, d] = day.split("-").map(Number);
      return { y, m, d, text: `${d} ${MONTHS[m - 1]}` };
    };
    const a = part(from);
    const b = part(to);
    const year = a.y !== Number(today().slice(0, 4));
    if (from === to) return `${a.text}${year ? ` ${a.y}` : ""}`;
    if (a.y !== b.y) return `${a.text} ${a.y} – ${b.text} ${b.y}`;
    if (a.m !== b.m) return `${a.text} – ${b.text}${year ? ` ${b.y}` : ""}`;
    return `${a.d}–${b.text}${year ? ` ${b.y}` : ""}`;
  }
  const describe = state => `${state.key === "custom" ? "Custom range" : LABEL[state.key]} · ${span(state.from, state.to)}`;
  /** Words for a figure's footer: "today", "this week", "in this period" (custom). */
  const words = state => ({ today: "today", yesterday: "yesterday", this_week: "this week", last_7_days: "last 7 days", this_month: "this month", last_month: "last month" })[state.key] || "in this period";
  /** "vs. yesterday", "vs. previous 7 days"… for trend footers. */
  const versus = state => (state.key === "today" ? "vs. yesterday" : state.key === "yesterday" ? "vs. the day before" : state.key === "this_month" || state.key === "last_month" ? "vs. previous period" : `vs. previous ${daysBetween(state.from, state.to)} days`);

  // ───────────── memory: URL (deep link) and localStorage ─────────────

  let urlOwner = null;
  const storageKey = page => `deliveryfast-period:${page}`;
  const fromUrl = () => {
    const params = new URLSearchParams(location.search);
    const key = params.get("period");
    const from = params.get("from");
    const to = params.get("to");
    if (key === "custom" || (!key && from && to)) return { key: "custom", from, to };
    return key ? { key } : null;
  };
  const saved = page => {
    try {
      return JSON.parse(localStorage.getItem(storageKey(page)) || "null");
    } catch {
      return null;
    }
  };
  const save = (page, state) => {
    try {
      localStorage.setItem(storageKey(page), JSON.stringify(state.key === "custom" ? state : { key: state.key }));
    } catch {}
  };
  // Next.js handles history.replaceState through its router, which must be initialised first: until the
  // page's scripts are all in (html.legacy-ready) the latest URL waits.
  let pendingUrl = null;
  const ready = () => document.documentElement.classList.contains("legacy-ready");
  const writeUrl = state => {
    pendingUrl = state;
    if (ready()) return flushUrl();
    if (writeUrl.observer) return;
    writeUrl.observer = new MutationObserver(() => {
      if (!ready()) return;
      writeUrl.observer.disconnect();
      setTimeout(flushUrl, 0);
    });
    writeUrl.observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  };
  const flushUrl = () => {
    const state = pendingUrl;
    pendingUrl = null;
    if (!state) return;
    try {
      const url = new URL(location.href);
      for (const k of ["period", "from", "to"]) url.searchParams.delete(k);
      url.searchParams.set("period", state.key);
      if (state.key === "custom") {
        url.searchParams.set("from", state.from);
        url.searchParams.set("to", state.to);
      }
      if (url.href !== location.href) history.replaceState(history.state, "", url.pathname + url.search + url.hash);
    } catch {}
  };

  // ───────────── the control ─────────────

  document.head.insertAdjacentHTML(
    "beforeend",
    `<style id="dfPeriodStyles">
.df-period{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap}
.df-period [hidden]{display:none!important}
.df-period-custom{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap}
.df-period input[type=date]{min-width:0;max-width:150px}
.df-period-error{color:#c2412d;font-size:12px;flex-basis:100%}
.df-period-note{color:#8b96a4;font-size:12px;font-weight:600}
@media(max-width:720px){.df-period{width:100%}.df-period select{flex:1}}
</style>`,
  );

  const controls = new Map();

  function control(page, { defaultKey = "today", onChange = () => undefined, label = "Period" } = {}) {
    let state = null;
    const self = {
      page,
      defaultKey,
      /** Reads the period for this page (URL when it owns it, else the saved choice, else the default) and claims the URL. */
      activate() {
        const linked = urlOwner === null || urlOwner === page ? fromUrl() : null;
        state = normalize(linked || saved(page) || (state && { key: state.key, from: state.from, to: state.to }), defaultKey);
        if (linked) save(page, state);
        urlOwner = page;
        writeUrl(state);
        return self.get();
      },
      get() {
        if (!state) state = normalize(saved(page), defaultKey);
        // Presets follow the calendar (e.g. "Today" after midnight).
        if (state.key !== "custom") state = { key: state.key, ...range(state.key) };
        return { ...state, label: state.key === "custom" ? "Custom range" : LABEL[state.key], text: describe(state), words: words(state), versus: versus(state), days: daysBetween(state.from, state.to) };
      },
      /** Sets the period (from code or the control) and tells the page. */
      set(next) {
        state = normalize(next, defaultKey);
        save(page, state);
        urlOwner = page;
        writeUrl(state);
        self.sync();
        Promise.resolve(onChange(self.get())).catch(error => console.error("Delivery Fast: period change failed", error));
      },
      /** "from=…&to=…" for the API. */
      query() {
        const s = self.get();
        return `from=${s.from}&to=${s.to}`;
      },
      text: () => self.get().text,
      /** Puts the control into `container` (once; later calls update it). */
      mount(container, where = "afterbegin") {
        if (!container) return null;
        let el = container.querySelector(`.df-period[data-period="${page}"]`);
        if (!el) {
          const s = self.get();
          el = document.createElement("div");
          el.className = "df-period";
          el.dataset.period = page;
          el.innerHTML = `<select class="select-small" data-period-select aria-label="${label}">${PRESETS.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select><span class="df-period-custom" hidden><input type="date" class="select-small" data-period-from aria-label="From date"><span aria-hidden="true">–</span><input type="date" class="select-small" data-period-to aria-label="To date"><button type="button" class="button button-sm" data-period-apply>Apply</button></span><span class="df-period-error" role="alert" hidden></span>`;
          container.insertAdjacentElement(where, el);
          el.querySelector("[data-period-from]").value = s.from;
          el.querySelector("[data-period-to]").value = s.to;
        }
        self.sync();
        return el;
      },
      /** Brings every mounted copy in line with the state. */
      sync() {
        const s = self.get();
        for (const el of document.querySelectorAll(`.df-period[data-period="${page}"]`)) {
          const select = el.querySelector("[data-period-select]");
          if (select.dataset.choosing !== "custom") select.value = s.key;
          el.querySelector(".df-period-custom").hidden = !(s.key === "custom" || select.value === "custom");
          for (const input of el.querySelectorAll('input[type="date"]')) input.max = today();
          el.title = s.text;
        }
      },
    };
    controls.set(page, self);
    return self;
  }

  // One set of listeners for every control (pages redraw their markup often).
  const ownerOf = el => controls.get(el.closest(".df-period")?.dataset.period);
  document.addEventListener("change", event => {
    const select = event.target.closest?.(".df-period [data-period-select]");
    if (!select) return;
    const ctrl = ownerOf(select);
    if (!ctrl) return;
    const box = select.closest(".df-period");
    if (select.value === "custom") {
      // Choose the dates, then Apply.
      select.dataset.choosing = "custom";
      const s = ctrl.get();
      box.querySelector(".df-period-custom").hidden = false;
      box.querySelector("[data-period-from]").value = s.from;
      box.querySelector("[data-period-to]").value = s.to;
      box.querySelector("[data-period-from]").focus();
      return;
    }
    delete select.dataset.choosing;
    box.querySelector(".df-period-error").hidden = true;
    ctrl.set({ key: select.value });
  });
  const apply = box => {
    const ctrl = ownerOf(box);
    if (!ctrl) return;
    const from = box.querySelector("[data-period-from]").value;
    const to = box.querySelector("[data-period-to]").value;
    const error = box.querySelector(".df-period-error");
    const message = problem(from, to);
    error.textContent = message;
    error.hidden = !message;
    if (message) return;
    delete box.querySelector("[data-period-select]").dataset.choosing;
    ctrl.set({ key: "custom", from, to });
  };
  document.addEventListener("click", event => {
    const button = event.target.closest?.(".df-period [data-period-apply]");
    if (button) apply(button.closest(".df-period"));
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Enter") return;
    const input = event.target.closest?.(".df-period input[type=date]");
    if (!input) return;
    event.preventDefault();
    apply(input.closest(".df-period"));
  });

  DF.period = { PRESETS, LABEL, MAX_DAYS, today, range, problem, span, describe, control, controls };
})();
