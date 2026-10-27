/*
 * Super admin › Branding & company (GET / PUT /branding): the company the platform runs for - its name, logo,
 * browser tab icon, contact details, social links and the website's About text. Every page shows them through
 * src/shared/branding/runtime.ts; messages and PDFs use the name. Nothing else changes.
 */
(() => {
  const DF = window.DF;
  if (!DF) return;
  const PAGE = "Branding & company";
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const toast = message => (typeof showToast === "function" ? showToast(message) : DF.toast?.(message)); // eslint-disable-line no-undef -- the page's own toast (01.js)
  const IMAGE_TYPES = "image/png,image/jpeg,image/webp,image/svg+xml,image/x-icon,image/vnd.microsoft.icon,.ico";
  const ABOUT_FORMAT =
    "A blank line starts a new block. “## ” makes a heading; “### Title” with lines under it makes a card (cards next to each other sit side by side); “[2024] Incorporated” makes a number tile; “- ” a bullet and “1. ” a numbered item; other lines are paragraphs.";
  const LIMITS = { logo: 400 * 1024, icon: 100 * 1024 };
  // An uploaded image waiting to be saved: a data URL, null = remove, undefined = unchanged.
  // draft: what is typed and not saved yet (the page may be redrawn while it is filled in).
  const S = { b: null, draft: null, open: false, error: "", saving: false, logo: undefined, icon: undefined };

  try {
    if (typeof generic === "object" && !generic[PAGE]) generic[PAGE] = { desc: PAGE, cols: [], rows: [] }; // eslint-disable-line no-undef
  } catch {}

  const field = (id, label, value, opts = {}) =>
    `<label${opts.full ? ' style="grid-column:1/-1"' : ""}>${esc(label)}${
      opts.area
        ? `<textarea id="${id}" rows="${opts.rows || 3}" placeholder="${esc(opts.placeholder || "")}">${esc(value)}</textarea>`
        : `<input id="${id}" type="${opts.type || "text"}" value="${esc(value)}" placeholder="${esc(opts.placeholder || "")}" ${opts.required ? "required" : ""}>`
    }${opts.hint ? `<small style="color:#8a94a3;font-size:12px">${esc(opts.hint)}</small>` : ""}</label>`;

  // The logo the pages show now (the pigeon mark), taken from the sidebar the first time it is seen.
  let currentMark = "";
  const markHtml = () => {
    const svg = document.querySelector("svg[data-brand-mark]");
    if (svg && !currentMark) {
      const copy = svg.cloneNode(true);
      copy.removeAttribute("style");
      copy.setAttribute("width", "60");
      copy.setAttribute("height", "60");
      currentMark = copy.outerHTML;
    }
    return currentMark;
  };

  function preview(which) {
    const pending = S[which];
    const url = pending === undefined ? (which === "logo" ? S.b.logoUrl : S.b.iconUrl) : pending;
    const size = which === "logo" ? 72 : 40;
    const box = `width:${size}px;height:${size}px;border:1px solid var(--line);border-radius:8px;background:#fff`;
    const img = url
      ? `<img src="${esc(url)}" alt="" style="${box};object-fit:contain;padding:4px">`
      : which === "logo" && markHtml()
        ? `<div style="${box};display:grid;place-items:center;overflow:hidden" data-brand-keep>${markHtml()}</div>`
        : `<div style="width:${size}px;height:${size}px;border:1px dashed var(--line);border-radius:8px;display:grid;place-items:center;color:#9aa4b2;font-size:11px">None</div>`;
    const custom = pending === undefined ? (which === "logo" ? !!S.b.logoUrl : !String(S.b.iconUrl).endsWith("=default")) : pending !== null;
    const note = which === "logo" ? (url ? "Your logo, shown in every header." : "The current logo (the pigeon mark). Upload one to replace it.") : custom ? "Your icon." : "The default icon.";
    return `<div style="display:flex;align-items:center;gap:14px">${img}<div style="display:grid;gap:6px"><span style="color:#667283;font-size:12px">${esc(note)}${pending !== undefined ? " (not saved yet)" : ""}</span><div style="display:flex;gap:7px;flex-wrap:wrap"><button class="button" type="button" data-pick="${which}">Upload…</button>${custom ? `<button class="button" type="button" data-clear="${which}">${which === "logo" ? "Remove" : "Use default"}</button>` : ""}</div></div></div>`;
  }

  function markup() {
    if (!S.b) return `<p class="panel-subtitle" style="margin-top:12px">${esc(S.error || "Loading…")}</p>`;
    const d = S.draft;
    const b = d ? { ...S.b, ...d, contact: { ...S.b.contact, ...d.contact }, social: { ...S.b.social, ...d.social }, about: { ...S.b.about, ...d.about } } : S.b;
    const c = b.contact || {};
    const s = b.social || {};
    return `<form id="brandForm" class="config-form" novalidate data-brand-keep>
      <div class="config-layout" style="margin:0">
        <section class="panel"><div class="panel-heading"><div><h2 class="panel-title">Company</h2><p class="panel-subtitle">Shown in headers, page and tab titles, messages and PDFs</p></div></div>
          <div class="form-grid" style="margin-top:12px">
            ${field("brName", "Company name", b.companyName, { required: true, hint: "Replaces “Paira Express” everywhere it shows." })}
            ${field("brLegal", "Legal name", b.legalName === b.companyName ? "" : b.legalName, { placeholder: "Same as the company name", hint: "On invoices and statements." })}
            ${field("brTagline", "Tagline", b.tagline, { full: true })}
            ${field("brWebsite", "Website", b.website, { type: "url", placeholder: "https://", full: true })}
          </div></section>
        <section class="panel"><div class="panel-heading"><div><h2 class="panel-title">Logo & tab icon</h2><p class="panel-subtitle">PNG, JPEG, WebP or SVG (ICO for the icon). Square images look best.</p></div></div>
          <div style="display:grid;gap:16px;margin-top:12px">
            <div><div style="font-weight:600;font-size:13px;margin-bottom:8px">Logo <span style="color:#8a94a3;font-weight:400">· up to 400 KB</span></div><div id="brLogoBox">${preview("logo")}</div></div>
            <div><div style="font-weight:600;font-size:13px;margin-bottom:8px">Browser tab icon <span style="color:#8a94a3;font-weight:400">· up to 100 KB, 64×64 or larger</span></div><div id="brIconBox">${preview("icon")}</div></div>
          </div>
          <input type="file" id="brFile" accept="${IMAGE_TYPES}" hidden></section>
        <section class="panel"><div class="panel-heading"><div><h2 class="panel-title">Contact</h2><p class="panel-subtitle">Website footer, contact links, help text</p></div></div>
          <div class="form-grid" style="margin-top:12px">
            ${field("brPhone", "Phone", c.phone)}
            ${field("brEmail", "Email", c.email, { type: "email" })}
            ${field("brAddress", "Address", c.address, { full: true, area: true, rows: 2 })}
            ${field("brHours", "Opening hours", c.hours, { full: true, placeholder: "e.g. Sat–Thu, 9am–8pm" })}
          </div></section>
        <section class="panel"><div class="panel-heading"><div><h2 class="panel-title">Social links</h2><p class="panel-subtitle">Full addresses (https://…); empty ones are not shown</p></div></div>
          <div class="form-grid" style="margin-top:12px">
            ${field("brFacebook", "Facebook", s.facebook, { type: "url", placeholder: "https://facebook.com/…" })}
            ${field("brInstagram", "Instagram", s.instagram, { type: "url", placeholder: "https://instagram.com/…" })}
            ${field("brLinkedin", "LinkedIn", s.linkedin, { type: "url", placeholder: "https://linkedin.com/…" })}
            ${field("brYoutube", "YouTube", s.youtube, { type: "url", placeholder: "https://youtube.com/…" })}
            ${field("brWhatsapp", "WhatsApp", s.whatsapp, { type: "url", placeholder: "https://wa.me/8801…", full: true })}
          </div></section>
      </div>
      <section class="panel" style="margin-top:14px"><div class="panel-heading"><div><h2 class="panel-title">About page</h2><p class="panel-subtitle">The website's <a href="/about" target="_blank" rel="noopener">/about</a> page: change any part of it.</p></div><button class="button" type="button" data-about-reset>Restore original About text</button></div>
        <div class="form-grid" style="margin-top:12px">
          ${field("brAboutTitle", "Title", b.about?.title === `About ${b.companyName}` ? "" : b.about?.title, { full: true, placeholder: "About <company name>" })}
          ${field("brAboutIntro", "Line under the title", b.about?.intro, { full: true, area: true, rows: 2, hint: "Empty: the original line." })}
          ${field("brAboutBody", "Text", b.about?.body, { full: true, area: true, rows: 22, hint: ABOUT_FORMAT })}
        </div></section>
      <div class="modal-actions"><button class="button button-primary" type="submit" ${S.saving ? "disabled" : ""}>${S.saving ? "Saving…" : "Save branding"}</button></div>
      <p class="panel-subtitle" style="margin:6px 0 0;text-align:right">Pages show the change within a minute. The mobile apps' names and icons are set when the apps are built.</p>
    </form>`;
  }

  /** The form's text fields as PUT /branding takes them. */
  function values() {
    const v = id => $(id).value.trim();
    return {
      companyName: v("brName"),
      legalName: v("brLegal"),
      tagline: v("brTagline"),
      website: v("brWebsite"),
      contact: { phone: v("brPhone"), email: v("brEmail"), address: v("brAddress"), hours: v("brHours") },
      social: { facebook: v("brFacebook"), instagram: v("brInstagram"), linkedin: v("brLinkedin"), youtube: v("brYoutube"), whatsapp: v("brWhatsapp") },
      about: { title: v("brAboutTitle"), intro: v("brAboutIntro"), body: $("brAboutBody").value.trim() },
    };
  }

  /** Paira Express's own About text with the company's name in it. */
  function defaultAbout(name = $("brName")?.value.trim() || S.b.companyName) {
    const named = t => String(t || "").split("Paira Express").join(name || "Paira Express");
    return { intro: named(S.b.defaults?.about?.intro), body: named(S.b.defaults?.about?.body).trim() };
  }

  function paint() {
    const host = $("brHost");
    if (!host) return;
    host.innerHTML = markup();
    const form = $("brandForm");
    if (!form) return;
    const check = DF.validate
      ? DF.validate(form, {
          brName: v => (String(v).trim().length >= 2 ? "" : "Enter the company name."),
          brEmail: v => (!v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? "" : "Enter a valid email."),
        })
      : null;
    let picking = null;
    form.addEventListener("input", event => {
      if (event.target.id !== "brFile") S.draft = values();
    });
    form.addEventListener("click", event => {
      const pick = event.target.closest("[data-pick]");
      const clear = event.target.closest("[data-clear]");
      if (event.target.closest("[data-about-reset]")) {
        const d = defaultAbout();
        $("brAboutTitle").value = "";
        $("brAboutIntro").value = d.intro;
        $("brAboutBody").value = d.body;
        S.draft = values();
        toast("The original About text is back in the form. Save to keep it.");
      }
      if (pick) {
        picking = pick.dataset.pick;
        $("brFile").value = "";
        $("brFile").click();
      }
      if (clear) {
        S[clear.dataset.clear] = null;
        refreshImages();
      }
    });
    $("brFile").addEventListener("change", () => {
      const file = $("brFile").files?.[0];
      if (!file || !picking) return;
      if (file.size > LIMITS[picking]) return toast(`The ${picking === "logo" ? "logo" : "tab icon"} must be ${LIMITS[picking] / 1024} KB or smaller.`);
      const which = picking;
      const reader = new FileReader();
      reader.onload = () => {
        let url = String(reader.result || "");
        // Browsers name .ico files differently; the API takes image/x-icon.
        url = url.replace(/^data:(application\/octet-stream|image\/ico|image\/vnd\.microsoft\.icon);/, "data:image/x-icon;");
        if (!/^data:image\/(png|jpeg|webp|svg\+xml|x-icon);base64,/.test(url)) return toast("Use a PNG, JPEG, WebP or SVG image.");
        S[which] = url;
        refreshImages();
      };
      reader.readAsDataURL(file);
    });
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (check && !check()) return;
      const typed = values();
      // Paira Express's own text is kept as "the default", so it follows a later change of the company name.
      const d = defaultAbout(typed.companyName);
      if (typed.about.body === d.body) typed.about.body = "";
      if (typed.about.intro === d.intro) typed.about.intro = "";
      const body = {
        ...typed,
        ...(S.logo !== undefined ? { logo: S.logo } : {}),
        ...(S.icon !== undefined ? { icon: S.icon } : {}),
      };
      S.saving = true;
      form.querySelector("[type=submit]").disabled = true;
      form.querySelector("[type=submit]").textContent = "Saving…";
      try {
        S.b = await DF.api("/branding", { method: "PUT", body });
        S.draft = null;
        S.logo = S.icon = undefined;
        try {
          localStorage.setItem("df.branding.v1", JSON.stringify(S.b));
        } catch {}
        toast("Branding saved. Reload a page to see it there.");
      } catch (error) {
        toast(DF.describe(error));
      }
      S.saving = false;
      paint();
    });
  }

  function refreshImages() {
    if ($("brLogoBox")) $("brLogoBox").innerHTML = preview("logo");
    if ($("brIconBox")) $("brIconBox").innerHTML = preview("icon");
  }

  // The page can be opened twice in a row (navigation): only the latest load draws.
  let loads = 0;
  async function load() {
    const mine = ++loads;
    let b = null;
    let error = "";
    try {
      b = await DF.api("/branding");
    } catch (e) {
      error = DF.describe(e);
    }
    if (mine !== loads) return;
    if (b) S.b = b;
    S.error = error;
    paint();
  }

  const baseShowPage = window.showPage;
  window.showPage = showPage = function (page) { // eslint-disable-line no-global-assign, no-undef -- the page's own showPage (01.js)
    baseShowPage(page);
    const wasOpen = S.open;
    S.open = page === PAGE;
    if (page !== PAGE) return;
    const main = $("mainContent");
    // Opened again from another page: start from what is saved (a redraw of the open page keeps the draft).
    if (!wasOpen) S.draft = S.logo = S.icon = undefined;
    main.innerHTML = `<div class="page-heading" data-brand-keep><div><p class="eyebrow">Platform control · white label</p><h1>Branding & company</h1><p class="subtitle">The company this platform runs for: name, logo, browser tab icon, contact details and the About page. Functions don't change.</p></div></div><div id="brHost" data-brand-keep></div>`;
    paint();
    void load();
  };
})();
