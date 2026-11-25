import fs from "node:fs";
import path from "node:path";
import PwaInstall from "./PwaInstall";
import BrandingRuntime from "./branding/BrandingRuntime";
import { STATIC_PAGES, WEBSITE_ROUTES } from "@/features/website/routes";

// Apps with their own markup, and so their own layer; every other panel shares panels.css. The website has its own (website/theme.css).
const OWN_THEME = ["franchise", "application"];

// Hide only pages that still require the legacy scripts to finish booting. A website page the server wrote in
// full (Terms, Privacy, About) shows at once.
const BOOT_CSS = "html:not(.legacy-ready) body:has([data-legacy-boot]):not(:has([data-static-page])){opacity:0}";

// The new website hides only the part its scripts draw (main[data-boot]), so the header stays in place from page to
// page; the part then fades in. A spinner shows when that takes longer than a moment.
const SITE_BOOT_CSS =
  "html:not(.legacy-ready) main[data-boot]{position:relative;min-height:100vh}" +
  "html:not(.legacy-ready) main[data-boot]>*{opacity:0;pointer-events:none}" +
  'html:not(.legacy-ready) main[data-boot]:before{content:"";position:absolute;top:min(34vh,260px);left:50%;width:34px;height:34px;margin-left:-17px;border:3px solid rgb(20 40 75 / 12%);border-top-color:#fbb51b;border-radius:50%;opacity:0;animation:site-spin .8s linear infinite,site-in .2s .4s forwards}' +
  "html.legacy-ready main[data-boot]{animation:site-in .2s ease-out}" +
  "@keyframes site-in{from{opacity:0}to{opacity:1}}@keyframes site-spin{to{transform:rotate(360deg)}}";

// The website's own pages are fetched ahead (the HTML only, nothing runs) when the pointer rests on their link.
const SITE_PREFETCH = JSON.stringify({
  prefetch: [
    {
      where: { href_matches: ["/", ...WEBSITE_ROUTES.filter(r => r.index && r.path && r.path !== "merchant").map(r => `/${r.path}`), ...STATIC_PAGES.map(p => `/${p.path}`)] },
      eagerness: "moderate",
    },
  ],
});

// The logo holds the name, so the written name beside it shows only for another company (data-brand-custom,
// set by branding/runtime.ts), which replaces the logo with its own.
const LOGO_CSS =
  "html:not([data-brand-custom]) :is(.brand-word,.brand-name,.fr-brand b){display:none}" +
  "html[data-brand-custom] [data-brand-mark]{display:none}" +
  ".brand-mark:has([data-brand-mark],[data-brand-logo]){width:auto!important;height:auto!important;max-width:100%}" +
  "[data-brand-mark]{max-width:100%;height:auto}" +
  "@media(max-width:520px){.header [data-brand-mark]{width:150px}}";

// Modals close only from their own buttons (✕, Cancel…) or Escape, never by a click outside them. Every panel's
// modals (legacy scripts and React) close on a click whose target is the backdrop itself, so such clicks are
// stopped here, at window in the capture phase, before any of those handlers. A backdrop is a fixed element that
// covers the screen; the mobile menu's overlay still closes on a tap.
const MODAL_GUARD = `(function(){
  var MENU = /sidebar|nav|menu/i;
  function isBackdrop(t) {
    if (!(t instanceof HTMLElement) || t === document.body || t === document.documentElement || t.tagName === "DIALOG") return false;
    if (!t.firstElementChild || t.closest("button,a,input,select,textarea,label,[role=button]")) return false;
    if (MENU.test(String(t.className)) || MENU.test(t.id)) return false;
    if (getComputedStyle(t).position !== "fixed") return false;
    var r = t.getBoundingClientRect();
    return r.width >= innerWidth * 0.9 && r.height >= innerHeight * 0.9;
  }
  ["pointerdown", "mousedown", "touchstart", "pointerup", "mouseup", "touchend", "click"].forEach(function (type) {
    window.addEventListener(type, function (event) {
      if (isBackdrop(event.target)) event.stopImmediatePropagation();
    }, { capture: true, passive: true });
  });
})();`;

/**
 * Root layout for a ported page. The page's CSS is inlined verbatim, like the <style>
 * blocks in the original .html files. It deliberately skips the CSS bundler, whose
 * minifier rewrites declarations (e.g. `background:transparent` -> `background:0 0`).
 */
/** `classic`: the website in its previous design (website/theme.css, served at /classic); else the new one (theme-v2.css). */
export default function LegacyRootLayout({ app, children, classic = false }: { app: string; children: React.ReactNode; classic?: boolean }) {
  // Line endings as the browser's HTML parser leaves them (\r\n → \n): a Windows checkout's CRLF file
  // would otherwise differ from the parsed <style> text and React reports a hydration mismatch.
  const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8").replace(/\r\n?/g, "\n");
  const css = read(`src/features/${app}/styles.css`);
  // The look on top of the page's own styles (so it wins): the website's own theme, else the panels' shared one.
  const theme = app === "website" ? read(`src/features/website/${classic ? "theme.css" : "theme-v2.css"}`) : read("src/shared/theme/tokens.css") + read(`src/shared/theme/${OWN_THEME.includes(app) ? app : "panels"}.css`);
  const newSite = app === "website" && !classic;
  return (
    <html lang="en">
      <head>
        {newSite ? <link rel="preload" as="font" type="font/woff2" href="/fonts/nunito-sans/nunito-sans-latin-wght-normal.woff2" crossOrigin="anonymous" /> : null}
        <link rel="manifest" href="/deliveryfast.webmanifest" />
        {/* The browser tab icon (Super admin › Branding & company; a default icon until one is uploaded). */}
        <link rel="icon" href="/api/v1/branding/icon" />
        <style dangerouslySetInnerHTML={{ __html: (newSite ? SITE_BOOT_CSS : BOOT_CSS) + LOGO_CSS }} />
        <script dangerouslySetInnerHTML={{ __html: MODAL_GUARD }} />
        <style dangerouslySetInnerHTML={{ __html: css }} />
        {newSite ? <script type="speculationrules" dangerouslySetInnerHTML={{ __html: SITE_PREFETCH }} /> : null}
        {theme ? <style dangerouslySetInnerHTML={{ __html: theme }} /> : null}
        <noscript>
          <style>{"body,main[data-boot]>*{opacity:1!important}"}</style>
        </noscript>
      </head>
      <body data-app={app} data-site={app === "website" ? (classic ? "classic" : "new") : undefined}>
        {children}
        <PwaInstall />
        {/* White label: the company's name, logo, tab icon and contact details from Super admin › Branding & company. */}
        <BrandingRuntime />
      </body>
    </html>
  );
}
