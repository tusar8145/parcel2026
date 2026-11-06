/*
 * Super admin › Website & branding (GET /website/admin, PUT /website; About: PUT /branding):
 *
 *   Company & branding  name, logo, tab icon, contact, social links (bridge-branding.js draws this tab)
 *   Signups & booking   switches for merchant, rider, franchise and customer sign-up, and "Send a parcel"
 *   About · Privacy · Terms   the pages' text (the same format as the About text)
 *   FAQs                add, edit, reorder and remove questions
 *
 * Every save clears the public pages' cache (DF.clearSiteCache), so the website shows it at once.
 */
(() => {
  const DF = window.DF;
  if (!DF) return;
  const PAGE = "Website settings";
  const TITLE = "Website & branding";
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const toast = text => window.showToast?.(text);
  const fail = error => toast(error instanceof DF.ApiError ? DF.describe(error) : error.message);
  const FORMAT = "A blank line starts a new block. “## ” makes a heading, “- ” a list item, “1. ” a numbered item.";
  const TABS = [
    ["company", "Company & branding"],
    ["signups", "Signups & booking"],
    ["about", "About Us"],
    ["privacy", "Privacy Policy"],
    ["terms", "Terms of Service"],
    ["faqs", "FAQs"],
  ];
  const SWITCHES = [
    ["merchant", "Become a merchant", "The merchant application on the website."],
    ["rider", "Apply as a rider", "The rider application on the website."],
    ["franchise", "Become a franchise partner", "The franchise application on the website."],
    ["customer", "Website customer signup & login", "New customer accounts and customer sign-in. Staff, merchants, riders and franchises always sign in."],
  ];
  const S = { tab: new URLSearchParams(location.search).get("section") || "company", site: null, faqs: [], open: false };
  if (!TABS.some(([key]) => key === S.tab)) S.tab = "company";
  try {
    if (typeof generic === "object" && !generic[PAGE]) generic[PAGE] = { desc: "What the public website offers, and its pages", cols: [], rows: [] };
  } catch {}

  const toggle = (id, label, hint, on) =>
    `<label class="config-check" style="align-items:flex-start;padding:12px 0;border-top:1px solid var(--line)"><input type="checkbox" data-site-switch="${id}" ${on ? "checked" : ""}><span><strong style="display:block">${esc(label)}</strong><span class="panel-subtitle">${esc(hint)}</span></span></label>`;

  function signupsTab() {
    const s = S.site;
    return `<section class="panel" style="padding:4px 18px 8px"><div class="panel-heading" style="padding-left:0"><div><h2 class="panel-title">Signups</h2><p class="panel-subtitle">On by default. When one is off, its links leave the website and its page says it's closed.</p></div></div>${SWITCHES.map(([key, label, hint]) => toggle(key, label, hint, s.signups[key])).join("")}</section>
      <section class="panel" style="padding:4px 18px 8px;margin-top:14px"><div class="panel-heading" style="padding-left:0"><div><h2 class="panel-title">Booking</h2><p class="panel-subtitle">Merchants and operations aren't affected.</p></div></div>${toggle("sendParcel", "Send a parcel", "The website's booking for customers and guests.", s.sendParcel)}</section>`;
  }

  function pageTab(key, page, { hint, reset }) {
    return `<form class="panel" id="siteForm" data-site-page="${key}" style="padding:16px 18px"><div class="form-grid"><div class="field full"><label for="siteTitle">Title</label><input id="siteTitle" required maxlength="120" value="${esc(page.title)}"></div><div class="field full"><label for="siteIntro">Line under the title</label><textarea id="siteIntro" rows="2" maxlength="400">${esc(page.intro)}</textarea></div><div class="field full"><label for="siteBody">Text</label><textarea id="siteBody" rows="22" required maxlength="40000">${esc(page.body)}</textarea><p class="panel-subtitle" style="margin:4px 0 0">${esc(hint)}</p></div></div><div class="modal-actions">${reset ? `<button class="button" type="button" data-site-reset="${key}">Use the original text</button>` : ""}<a class="button" href="/${key}" target="_blank" rel="noopener">View page</a><button class="button button-primary" type="submit">Save and publish</button></div></form>`;
  }

  function faqsTab() {
    const rows = S.faqs
      .map(
        (f, i) => `<article data-faq="${i}" style="display:grid;gap:8px;padding:12px 0;border-top:1px solid var(--line)"><div class="field"><label>Question</label><input data-faq-field="question" maxlength="200" required value="${esc(f.question)}"></div><div class="field"><label>Answer</label><textarea data-faq-field="answer" rows="3" maxlength="2000" required>${esc(f.answer)}</textarea></div><div style="display:flex;gap:6px"><button type="button" class="button button-sm" data-faq-move="-1" ${i ? "" : "disabled"} aria-label="Move up">▲</button><button type="button" class="button button-sm" data-faq-move="1" ${i < S.faqs.length - 1 ? "" : "disabled"} aria-label="Move down">▼</button><button type="button" class="button button-sm" data-faq-remove>Remove</button></div></article>`,
      )
      .join("");
    return `<form class="panel" id="siteForm" data-site-page="faqs" style="padding:16px 18px"><div class="panel-heading" style="padding-left:0"><div><h2 class="panel-title">FAQs</h2><p class="panel-subtitle">Shown on the home page, in this order.</p></div><button type="button" class="button" id="faqAdd">Add a question</button></div>${rows || `<p class="empty-state">No questions yet.</p>`}<div class="modal-actions"><button class="button button-primary" type="submit">Save and publish</button></div></form>`;
  }

  function body() {
    const s = S.site;
    if (S.tab === "company") return `<div id="brHost" data-brand-keep></div>`;
    if (S.tab === "signups") return signupsTab();
    if (S.tab === "faqs") return faqsTab();
    if (S.tab === "about") return pageTab("about", s.about, { hint: `${FORMAT} “### Title” with lines under it makes a card; “[100+] Hubs” a number tile.` });
    return pageTab(S.tab, s[S.tab], { hint: FORMAT, reset: true });
  }

  function draw() {
    const main = $("mainContent");
    if (!S.site) return;
    window.DFPackages?.styles();
    main.innerHTML = `<div class="page-heading"><div><p class="eyebrow">Platform control · public website</p><h1>${TITLE}</h1><p class="subtitle">Your company, what the website offers, and its pages. Changes show on the website as soon as you save.</p></div></div>
      <div class="svp-tabs" role="tablist" aria-label="${TITLE}">${TABS.map(([key, label]) => `<button type="button" role="tab" class="svp-tab" data-site-tab="${key}" aria-selected="${key === S.tab}" tabindex="${key === S.tab ? 0 : -1}">${esc(label)}</button>`).join("")}</div>
      <div id="siteBodyPanel" role="tabpanel">${body()}</div>`;
    const crumb = $("breadcrumbPage");
    if (crumb) crumb.textContent = TITLE;
    if (S.tab === "company") window.DFBranding?.mount();
    const url = new URL(location.href);
    if (S.tab === "company") url.searchParams.delete("section");
    else url.searchParams.set("section", S.tab);
    if (url.href !== location.href) history.replaceState(history.state, "", url);
  }

  async function load() {
    try {
      S.site = await DF.api("/website/admin");
      S.faqs = S.site.faqs.map(f => ({ ...f }));
      if (onPage()) draw();
    } catch (error) {
      fail(error);
    }
  }
  const onPage = () => S.open;

  /** Saves, then clears the website's cache. */
  async function publish(body, message) {
    S.site = { ...(await DF.api("/website", { method: "PUT", body })), defaults: S.site.defaults };
    await DF.clearSiteCache();
    toast(message);
  }

  const readFaqs = () => {
    for (const row of document.querySelectorAll("[data-faq]")) {
      const f = S.faqs[Number(row.dataset.faq)];
      for (const field of row.querySelectorAll("[data-faq-field]")) f[field.dataset.faqField] = field.value;
    }
  };

  document.addEventListener("click", event => {
    if (!onPage() || !(event.target instanceof Element)) return;
    const hit = selector => event.target.closest(selector);
    let el;
    if ((el = hit("[data-site-tab]"))) {
      S.tab = el.dataset.siteTab;
      draw();
      return document.querySelector(`[data-site-tab="${S.tab}"]`)?.focus();
    }
    if (hit("#faqAdd")) {
      readFaqs();
      S.faqs.push({ id: `faq-${Date.now().toString(36)}`, question: "", answer: "" });
      draw();
      return [...document.querySelectorAll('[data-faq-field="question"]')].pop()?.focus();
    }
    if ((el = hit("[data-faq-move]"))) {
      readFaqs();
      const i = Number(el.closest("[data-faq]").dataset.faq);
      const to = i + Number(el.dataset.faqMove);
      [S.faqs[i], S.faqs[to]] = [S.faqs[to], S.faqs[i]];
      return draw();
    }
    if ((el = hit("[data-faq-remove]"))) {
      readFaqs();
      S.faqs.splice(Number(el.closest("[data-faq]").dataset.faq), 1);
      return draw();
    }
    if ((el = hit("[data-site-reset]"))) {
      const original = S.site.defaults[el.dataset.siteReset];
      $("siteTitle").value = original.title;
      $("siteIntro").value = original.intro;
      $("siteBody").value = original.body;
      toast("The original text is in the form. Save to publish it.");
    }
  });

  document.addEventListener("keydown", event => {
    const tab = event.target.closest?.("[data-site-tab]");
    if (!tab || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    const tabs = [...document.querySelectorAll("[data-site-tab]")];
    const next = tabs[(tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    event.preventDefault();
    next.click();
  });

  document.addEventListener("change", event => {
    const box = event.target.closest?.("[data-site-switch]");
    if (!box || !onPage()) return;
    const key = box.dataset.siteSwitch;
    const on = box.checked;
    box.disabled = true;
    const change = key === "sendParcel" ? { sendParcel: on } : { signups: { [key]: on } };
    const label = key === "sendParcel" ? "Send a parcel" : SWITCHES.find(s => s[0] === key)[1];
    publish(change, `${label} is ${on ? "on" : "off"}.`)
      .catch(error => {
        box.checked = !on;
        fail(error);
      })
      .finally(() => (box.disabled = false));
  });

  document.addEventListener(
    "submit",
    event => {
      const form = event.target;
      if (form.id !== "siteForm") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const key = form.dataset.sitePage;
      const button = form.querySelector('button[type="submit"]');
      const work = async () => {
        if (key === "faqs") {
          readFaqs();
          await publish({ faqs: S.faqs }, "FAQs published.");
          S.faqs = S.site.faqs.map(f => ({ ...f }));
          return;
        }
        const page = { title: $("siteTitle").value.trim(), intro: $("siteIntro").value.trim(), body: $("siteBody").value.trim() };
        if (key === "about") {
          await DF.api("/branding", { method: "PUT", body: { about: page } });
          await DF.clearSiteCache();
          S.site = { ...S.site, about: page };
          return toast("About Us published.");
        }
        await publish({ [key]: page }, `${TABS.find(t => t[0] === key)[1]} published.`);
      };
      void DF.busy(button, () => work().catch(fail), "Publishing…");
    },
    true,
  );

  const base = window.showPage;
  window.showPage = showPage = function (page) {
    // The old Branding & company page and its links.
    if (page === "Branding & company") {
      S.tab = "company";
      page = PAGE;
    }
    const wasOpen = S.open;
    S.open = page === PAGE;
    if (wasOpen && !S.open) window.DFBranding?.leave();
    base(page);
    if (!S.open) return;
    $("mainContent").innerHTML = `<div class="page-heading"><div><h1>${TITLE}</h1></div></div><p class="panel-subtitle">Loading…</p>`;
    void load();
  };
})();
