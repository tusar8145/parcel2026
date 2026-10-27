/*
 * White label on every page (website and panels; started by <BrandingRuntime/> in the root layout): the company
 * set in Super admin › Branding & company (GET /api/v1/branding) replaces the default one where pages show it -
 * the name ("Delivery Fast" in text, titles and the "delivery fast" wordmark), the logo (the pigeon mark), the
 * browser tab icon and the contact details (phone, email, address, also in tel: / mailto: links). Nothing else
 * changes.
 *
 * With the default company nothing is touched (no observer runs). The last branding is kept in localStorage so a
 * page shows it at once; the API answer then brings it up to date. Elements inside [data-brand-keep] are left as
 * they are (the branding editor itself). getBranding() / onBrandingChange() for React, window.DFBranding for the
 * panels' scripts.
 */

export interface BrandingView {
  companyName: string;
  legalName: string;
  tagline: string;
  website: string;
  contact: { phone: string; email: string; address: string; hours: string };
  social: Record<string, string>;
  about: { title: string; body: string };
  logoUrl: string | null;
  iconUrl: string;
}

const DEFAULT = {
  name: "Delivery Fast",
  phone: "01969 921122",
  tel: "+8801969921122",
  email: "info@deliveryfast.com.bd",
  address: "House-6 Road -2A Banani, Dhaka-1213",
};
const KEY = "df.branding.v1";
const SKIP = new Set(["SCRIPT", "STYLE", "TEXTAREA", "NOSCRIPT", "CODE", "INPUT", "SELECT", "OPTION"]);
const listeners = new Set<(b: BrandingView) => void>();
let b: BrandingView | null = null;
let loaded = false;

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const digits = (p: string) => String(p || "").replace(/[^\d+]/g, "").replace(/^0(?=1)/, "+880");

/** "Swift Parcel" → "SP", "Dakghor" → "DA", "Paira Express Ltd" → "PE". */
export function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w));
  const letters = words.length > 1 ? words.slice(0, 2).map(w => [...w.replace(/[^\p{L}\p{N}]/gu, "")][0] ?? "") : [...(words[0] ?? "").replace(/[^\p{L}\p{N}]/gu, "")].slice(0, 2);
  return letters.join("").toUpperCase() || "DF";
}

function readStored() {
  if (loaded) return;
  loaded = true;
  try {
    b = JSON.parse(localStorage.getItem(KEY) || "null");
  } catch {}
}

/** The company's branding (null until known: the default company). */
export function getBranding(): BrandingView | null {
  if (typeof window !== "undefined") readStored();
  return b;
}

export function onBrandingChange(fn: (b: BrandingView) => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** [from, to] text pairs that differ from the defaults. */
function pairs(): [string, string][] {
  if (!b) return [];
  const c = b.contact || ({} as BrandingView["contact"]);
  const list: [string, string][] = [
    [DEFAULT.name, b.companyName],
    [DEFAULT.phone, c.phone],
    [DEFAULT.email, c.email],
    [DEFAULT.address, c.address],
  ];
  return list.filter(([from, to]) => to && to !== from);
}

const active = () => pairs().length > 0 || !!b?.logoUrl;
const kept = (node: Node) => !!(node.parentElement || (node as Element)).closest?.("[data-brand-keep]");

function fixText(node: Text) {
  const p = node.parentElement;
  if (!p || SKIP.has(p.tagName) || p.isContentEditable || kept(node)) return;
  let t = node.nodeValue;
  if (!t || t.length < 4) return;
  let changed = false;
  for (const [from, to] of pairs()) {
    if (t.includes(from)) {
      t = t.split(from).join(to);
      changed = true;
    }
  }
  if (changed) node.nodeValue = t;
}

function fixElement(el: Element) {
  if (!b || kept(el)) return;
  // Attributes people see or links use.
  for (const attr of ["aria-label", "title", "alt", "placeholder"]) {
    const v = el.getAttribute(attr);
    if (!v) continue;
    let next = v;
    for (const [from, to] of pairs()) next = next.split(from).join(to);
    if (next !== v) el.setAttribute(attr, next);
  }
  if (el.tagName === "A") {
    const href = el.getAttribute("href") || "";
    const c = b.contact || ({} as BrandingView["contact"]);
    if (href === `tel:${DEFAULT.tel}` && c.phone && c.phone !== DEFAULT.phone) el.setAttribute("href", `tel:${digits(c.phone)}`);
    if (href === `mailto:${DEFAULT.email}` && c.email && c.email !== DEFAULT.email) el.setAttribute("href", `mailto:${c.email}`);
    if (href.includes("google.com/maps") && href.includes("Banani") && c.address && c.address !== DEFAULT.address)
      el.setAttribute("href", `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.address)}`);
  }
  // The two-tone wordmark: "delivery <span>fast</span>" → the company name, its last word in the accent colour.
  const html = el as HTMLElement;
  if (el.matches(".brand-word, .brand-name") && !html.dataset.brandDone && b.companyName && b.companyName !== DEFAULT.name) {
    if ((el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase() === "delivery fast") {
      const words = b.companyName.trim().split(/\s+/);
      const last = words.pop();
      el.innerHTML = `${words.length ? `${esc(words.join(" "))} ` : ""}<span>${esc(last)}</span>`;
      html.dataset.brandDone = "1";
    }
  }
  // The name painted on the van in the website's hero ("delivery fast", lower case), made smaller to fit the van.
  if (el.matches(".van-logo") && !html.dataset.brandDone && b.companyName && b.companyName !== DEFAULT.name && el.textContent?.trim().toLowerCase() === "delivery fast") {
    el.textContent = b.companyName.trim().toLowerCase();
    html.style.whiteSpace = "nowrap";
    const room = 92; // the van body is 115px wide, the text starts 18px in
    if (html.scrollWidth > room) html.style.fontSize = `${Math.max(8, Math.floor((13 * room) / html.scrollWidth))}px`;
    html.dataset.brandDone = "1";
  }
  // The workspace badge ("DF" in the super admin sidebar): the company's initials.
  if (el.matches(".workspace-icon") && !html.dataset.brandDone && b.companyName && b.companyName !== DEFAULT.name && el.textContent?.trim() === "DF") {
    el.textContent = initials(b.companyName);
    html.dataset.brandDone = "1";
  }
  // The logo: the uploaded image instead of the pigeon mark.
  if (b.logoUrl && el.matches("svg[data-brand-mark]")) {
    const w = parseFloat((el as SVGElement).style.width) || el.getBoundingClientRect().width || 40;
    const img = document.createElement("img");
    img.src = b.logoUrl;
    img.alt = b.companyName || "";
    img.dataset.brandLogo = "1";
    img.style.cssText = `width:${w}px;height:${w}px;object-fit:contain;display:block`;
    el.replaceWith(img);
  }
}

function fixTree(root: Node) {
  if (!root || !b || !active()) return;
  if (root.nodeType === Node.TEXT_NODE) return fixText(root as Text);
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const el = root as Element;
  fixElement(el);
  el.querySelectorAll(".brand-word, .brand-name, .workspace-icon, .van-logo, svg[data-brand-mark], a[href], [aria-label], [title], [alt], [placeholder]").forEach(fixElement);
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) fixText(n as Text);
}

function fixTitle() {
  if (!b?.companyName || b.companyName === DEFAULT.name) return;
  if (document.title.includes(DEFAULT.name)) document.title = document.title.split(DEFAULT.name).join(b.companyName);
}

let headWatch: MutationObserver | null = null;
function fixIcon() {
  const url = b?.iconUrl;
  if (!url) return;
  const links = [...document.querySelectorAll('link[rel~="icon"]')];
  if (!links.length) {
    const l = document.createElement("link");
    l.rel = "icon";
    document.head.appendChild(l);
    links.push(l);
  }
  for (const l of links) if (l.getAttribute("href") !== url) l.setAttribute("href", url);
  // React may put its own <link rel="icon"> back: keep an uploaded icon's (versioned) address.
  if (!headWatch && !/=default$/.test(url)) {
    headWatch = new MutationObserver(() => {
      if ([...document.querySelectorAll('link[rel~="icon"]')].some(l => l.getAttribute("href") !== b?.iconUrl)) fixIcon();
    });
    headWatch.observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ["href"] });
  }
}

// Pages keep drawing (React, the panels' scripts): new parts are fixed as they appear, once per frame.
let observer: MutationObserver | null = null;
let pending = new Set<Node>();
let scheduled = false;
const OBSERVE = { childList: true, subtree: true, characterData: true };
function watch() {
  if (observer || !active() || !document.body) return;
  const o = new MutationObserver(records => {
    for (const r of records) {
      if (r.type === "characterData") pending.add(r.target);
      else r.addedNodes.forEach(n => pending.add(n));
    }
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const nodes = pending;
      pending = new Set();
      o.disconnect();
      nodes.forEach(n => n.isConnected && fixTree(n));
      fixTitle();
      o.observe(document.body, OBSERVE);
    });
  });
  observer = o;
  o.observe(document.body, OBSERVE);
  const title = document.querySelector("title");
  if (title) new MutationObserver(fixTitle).observe(title, { childList: true, characterData: true, subtree: true });
}

let started = false;
function applyAll() {
  if (!started) return;
  fixIcon();
  if (!b || !active()) return;
  fixTitle();
  if (document.body) fixTree(document.body);
  watch();
}

/**
 * Starts once per page load, after React has hydrated it (changing the server HTML earlier makes React redraw the
 * page). Pages booting the panels' scripts stay hidden until html.legacy-ready, so the change shows in the same
 * frame there.
 */
export function startBranding() {
  if (started || typeof window === "undefined") return;
  readStored();
  (window as unknown as { DFBranding: unknown }).DFBranding = { get: getBranding, onChange: onBrandingChange };
  const go = () => {
    if (started) return;
    started = true;
    applyAll();
  };
  const html = document.documentElement;
  if (html.classList.contains("legacy-ready") || !document.querySelector("[data-legacy-boot]")) requestAnimationFrame(() => setTimeout(go, 0));
  else {
    const ready = new MutationObserver(() => html.classList.contains("legacy-ready") && (ready.disconnect(), go()));
    ready.observe(html, { attributes: true, attributeFilter: ["class"] });
    setTimeout(() => (ready.disconnect(), go()), 8000);
  }

  fetch("/api/v1/branding", { credentials: "same-origin" })
    .then(r => (r.ok ? r.json() : null))
    .then((next: BrandingView | null) => {
      if (!next) return;
      const before = JSON.stringify(b);
      b = next;
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {}
      if (JSON.stringify(next) === before) return;
      applyAll();
      listeners.forEach(fn => {
        try {
          fn(next);
        } catch {}
      });
    })
    .catch(() => {});
}
