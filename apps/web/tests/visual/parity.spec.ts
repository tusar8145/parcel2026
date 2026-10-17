/**
 * Parity check: every Next.js page must match its original file in design-reference/.
 * For each view it compares the post-script DOM, the computed style of every element
 * (and ::before/::after), and a full-page screenshot.
 *
 *   npm run build && npm run test:visual
 */
import { test, expect, type Browser, type Page } from "@playwright/test";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import fs from "node:fs";
import path from "node:path";

const NEXT = "http://localhost:3100";
const ORIGINAL = "http://localhost:3101";
const FIXED_NOW = new Date("2026-10-15T10:00:00+06:00");
const DIFF_DIR = path.join(__dirname, "__diff__");

// Links between pages were rewritten on purpose: "rider.html" -> "/rider" (and the dead "courier.html" -> "/courier-operation").
// The document merchant panel is now the Banking & Financial merchant panel (/banking-merchant).
const ROUTES: Record<string, string> = { website: "/", courier: "/courier-operation", "document-merchant": "/banking-merchant" };
const rewritePageLinks = (html: string) =>
  html.replace(
    /href="(website|courier-operation|courier|rider|ecommerce-merchant|document-merchant|super-admin)\.html/g,
    (_, name) => `href="${ROUTES[name] ?? "/" + name}`,
  );

type View = { name: string; go?: (page: Page) => Promise<void> };

const hash = (h: string) => async (page: Page) => {
  await page.evaluate(h => (location.hash = h), h);
};
const navPage = (id: string) => async (page: Page) => {
  await page
    .locator(`#navigation [data-page="${id}"]`)
    .first()
    .evaluate(el => (el as HTMLElement).click());
};

// Views that must still match the original exactly. Sign-in, tracking, account, pricing (zones
// come from the server catalog) and the panels now run on the API (panels also require
// signing in), so they differ on purpose. The request wizard, sign-up and the merchant,
// rider and franchise applications are React forms with inline validation, a fixed +880
// prefix, address search with a map pin and pickup time slots (and without the "demo only"
// notes), so they differ on purpose too. The home page is compared.
const websiteRoutes: string[] = [];

/**
 * Intended changes to the original website, applied to it before comparing: links use real
 * URLs instead of hash routes ("#/pricing" -> "/pricing", "#/tracking" -> "/track"), and the
 * footer links to the Privacy Policy, Terms of Service and cookie settings, and the document merchant is
 * now the Banking & Financial merchant.
 */
const WEBSITE_PATHS: Record<string, string> = { tracking: "/track", rider: "/become-a-rider" };
async function applyIntendedWebsiteChanges(page: Page) {
  await page.evaluate(paths => {
    for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href^="#/"]')) {
      const route = a.getAttribute("href")!.slice(2);
      a.setAttribute("href", paths[route] ?? `/${route}`);
    }
    // "Document merchants" are now "Banking & Financial merchants".
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue?.includes("document merchant")) n.nodeValue = n.nodeValue.replace(/document merchant/g, "Banking & Financial merchant");
    const col = document.querySelectorAll(".footer .footer-col")[2];
    if (col)
      col.insertAdjacentHTML(
        "beforeend",
        '<a href="/privacy">Privacy Policy</a><a href="/terms">Terms of Service</a><a href="/privacy#cookies" data-cookie-settings="1">Cookie settings</a>',
      );
  }, WEBSITE_PATHS);
}

const PAGES: { file: string; route: string; views: (page: Page) => Promise<View[]> }[] = [
  {
    file: "website.html",
    route: "/",
    views: async () => [
      { name: "home" },
      ...websiteRoutes.map(r => ({ name: r.replace("/", "_"), go: hash(`#/${r}`) })),
    ],
  },
];

async function open(browser: Browser, url: string, isNext: boolean, use: Record<string, unknown>) {
  const context = await browser.newContext(use);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.clock.install({ time: FIXED_NOW }); // fake timers, advanced identically on both pages in settle()
  await page.addInitScript(() => {
    let seed = 42; // deterministic Math.random on both sides
    Math.random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  });
  // The cookie choice is made, so the consent banner (not in the original) stays closed.
  await page.addInitScript(() => localStorage.setItem("deliveryfast-cookie-consent", JSON.stringify({ analytics: false, at: new Date().toISOString() })));
  await page.goto(url, { waitUntil: "load" });
  if (isNext) await page.waitForSelector("html.legacy-ready", { state: "attached" });
  await settle(page);
  return { context, page, errors };
}

async function settle(page: Page) {
  await page.clock.runFor(3000);
  await page.waitForTimeout(100);
  await page.evaluate(async () => {
    await document.fonts.ready;
    // Freeze animations so both pages are compared at the same frame.
    for (const animation of document.getAnimations()) {
      try {
        animation.finish();
      } catch {
        animation.pause(); // infinite animations can't finish
        animation.currentTime = 0;
      }
    }
  });
}

/**
 * Body DOM after the scripts ran, minus framework-only nodes. Whitespace in text is
 * collapsed only where CSS collapses it (white-space: normal/nowrap), so indentation
 * differences between the .html source and JSX don't count, but <pre> text does.
 */
const snapshotDom = (page: Page) =>
  page.evaluate(() => {
    const outlet = document.body.firstElementChild?.matches("div[hidden]:empty")
      ? document.body.firstElementChild
      : null; // Next.js metadata outlet
    const ignored = (n: Node) =>
      n === outlet || (n instanceof Element && n.matches("script, noscript, next-route-announcer, nextjs-portal"));
    const serialize = (node: Node): string => {
      let out = "";
      let text = "";
      const flush = (parent: Element) => {
        if (!text) return;
        const ws = getComputedStyle(parent).whiteSpaceCollapse || getComputedStyle(parent).whiteSpace;
        out += /^(collapse|normal|nowrap)$/.test(ws) ? text.replace(/[ \t\n\r\f]+/g, " ") : text;
        text = "";
      };
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) text += (child as Text).data;
        else if (child instanceof Element && !ignored(child)) {
          flush(node as Element);
          const attrs = [...child.attributes]
            .filter(a => !(child === document.body && a.name === "data-app"))
            .map(a => `${a.name}="${a.name === "style" ? (child as HTMLElement).style.cssText : a.value}"`)
            .sort()
            .join(" ");
          out += `<${child.tagName.toLowerCase()} ${attrs}>${serialize(child)}</${child.tagName.toLowerCase()}>`;
        }
      }
      flush(node as Element);
      return out;
    };
    return serialize(document.body).trim();
  });

/** Computed style of every element in document order. */
const snapshotStyles = (page: Page) =>
  page.evaluate(() => {
    const outlet = document.body.firstElementChild?.matches("div[hidden]:empty")
      ? document.body.firstElementChild
      : null;
    const skip = (el: Element) => el === outlet || el.closest("script, noscript, next-route-announcer, nextjs-portal");
    const out: string[] = [];
    for (const el of document.querySelectorAll("body, body *")) {
      if (skip(el)) continue;
      const parts = [null, "::before", "::after"].map(pseudo => {
        const cs = getComputedStyle(el, pseudo);
        const props: string[] = [];
        for (let i = 0; i < cs.length; i++) props.push(cs[i] + ":" + cs.getPropertyValue(cs[i]) + ";");
        return props.sort().join(""); // custom properties are listed in no fixed order
      });
      out.push(el.tagName + (el.id ? "#" + el.id : "") + "|" + parts.join("|"));
    }
    return out;
  });

function firstDifference(a: string, b: string) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `at ${i}:\n  original: …${a.slice(Math.max(0, i - 120), i + 120)}…\n  next:     …${b.slice(Math.max(0, i - 120), i + 120)}…`;
}

function styleDifference(a: string[], b: string[]) {
  if (a.length !== b.length) return `element count ${a.length} vs ${b.length}`;
  const i = a.findIndex((s, k) => s !== b[k]);
  if (i < 0) return "";
  const [tag, ...pa] = a[i].split("|"),
    pb = b[i].split("|").slice(1);
  const diffs = ["", "::before", "::after"].flatMap((pseudo, k) => {
    const props = (s: string) =>
      new Map(
        s
          .split(";")
          .filter(Boolean)
          .map(d => [d.slice(0, d.indexOf(":")), d.slice(d.indexOf(":") + 1)]),
      );
    const ma = props(pa[k]),
      mb = props(pb[k]);
    return [...new Set([...ma.keys(), ...mb.keys()])]
      .filter(p => ma.get(p) !== mb.get(p))
      .map(p => `${pseudo}${p}: ${ma.get(p)} -> ${mb.get(p)}`);
  });
  return `element #${i} ${tag}: ${diffs.slice(0, 8).join("; ")}`;
}

function comparePng(a: Buffer, b: Buffer, name: string) {
  const ia = PNG.sync.read(a),
    ib = PNG.sync.read(b);
  if (ia.width !== ib.width || ia.height !== ib.height)
    return `size ${ia.width}x${ia.height} vs ${ib.width}x${ib.height}`;
  const diff = new PNG({ width: ia.width, height: ia.height });
  const pixels = pixelmatch(ia.data, ib.data, diff.data, ia.width, ia.height, { threshold: 0.05 });
  if (pixels) {
    fs.mkdirSync(DIFF_DIR, { recursive: true });
    fs.writeFileSync(path.join(DIFF_DIR, `${name}.png`), PNG.sync.write(diff));
    return `${pixels} pixels differ (see __diff__/${name}.png)`;
  }
  return "";
}

for (const def of PAGES) {
  test(def.file, async ({ browser, viewport, userAgent, deviceScaleFactor, isMobile, hasTouch }, info) => {
    const use = { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch };
    const original = await open(browser, ORIGINAL + "/" + def.file, false, use);
    if (def.file === "website.html") await applyIntendedWebsiteChanges(original.page);
    const next = await open(browser, NEXT + def.route, true, use);
    const problems: string[] = [];

    for (const view of await def.views(original.page)) {
      if (view.go) {
        await view.go(original.page);
        await view.go(next.page);
        await Promise.all([settle(original.page), settle(next.page)]);
      }
      const label = `${def.file.replace(".html", "")}-${view.name}-${info.project.name}`;

      const [rawA, domB] = await Promise.all([snapshotDom(original.page), snapshotDom(next.page)]);
      const domA = rewritePageLinks(rawA);
      if (domA !== domB) problems.push(`[${view.name}] DOM differs ${firstDifference(domA, domB)}`);

      const styleDiff = styleDifference(
        ...(await Promise.all([snapshotStyles(original.page), snapshotStyles(next.page)])),
      );
      if (styleDiff) problems.push(`[${view.name}] computed style differs: ${styleDiff}`);

      const shot = (p: Page) => p.screenshot({ fullPage: true, animations: "disabled", caret: "hide" });
      const pixelDiff = comparePng(await shot(original.page), await shot(next.page), label);
      if (pixelDiff) problems.push(`[${view.name}] screenshot: ${pixelDiff}`);
    }

    if (original.errors.join("\n") !== next.errors.join("\n"))
      problems.push(
        `script errors differ:\n  original: ${original.errors.join(" | ")}\n  next: ${next.errors.join(" | ")}`,
      );

    await original.context.close();
    await next.context.close();
    expect(problems, problems.join("\n\n")).toEqual([]);
  });
}
