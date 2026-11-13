import { defineConfig, type Plugin } from "vite";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

/**
 * Served at /admin/ on the same domain as the API (the refresh cookie is same-origin).
 * Production: built into apps/web/public/admin, which Next.js serves (next.config.ts sends /admin/* to its index.html).
 * Development: `npm run dev -w @delivery-fast/admin` proxies /api to the local API (API_ORIGIN, default :4000).
 */
const api = process.env.API_ORIGIN ?? "http://localhost:4000";
/** The website (apps/web): Website & branding clears its page cache (POST /site-cache) after a save. */
const web = process.env.WEB_ORIGIN ?? "http://localhost:3000";

/** Development only: the website's shared files the panel loads at run time (/legacy/shared/system-guide.js, /vendor/zxing). */
const webPublic = fileURLToPath(new URL("../web/public", import.meta.url));
const TYPES: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".wasm": "application/wasm" };
const websiteFiles = (): Plugin => ({
  name: "website-files",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const path = decodeURIComponent((req.url || "").split("?")[0]);
      if (!/^\/(legacy|vendor)\//.test(path)) return next();
      const file = normalize(join(webPublic, path));
      if (!file.startsWith(webPublic) || !existsSync(file) || !statSync(file).isFile()) return next();
      res.setHeader("content-type", TYPES[extname(file)] ?? "application/octet-stream");
      createReadStream(file).pipe(res);
    });
  },
});

/** CHANGELOG.md (repo root), read at build time: "## 1.2.0 — 2026-11-02" headings, newest first, then "- change" lines. */
function releases() {
  const file = fileURLToPath(new URL("../../CHANGELOG.md", import.meta.url));
  if (!existsSync(file)) return [];
  const out: { version: string; date: string; changes: string[] }[] = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const head = /^##\s+(\d+\.\d+\.\d+)\s*[\u2014-]\s*(\S+)/.exec(line);
    if (head) out.push({ version: head[1], date: head[2], changes: [] });
    else if (out.length && /^-\s+/.test(line)) out[out.length - 1].changes.push(line.replace(/^-\s+/, "").replace(/\*\*|`/g, ""));
  }
  return out;
}

export default defineConfig({
  base: "/admin/",
  // What's new (the menu's foot): the version and every release's changes.
  define: { __APP_RELEASES__: JSON.stringify(releases()) },
  plugins: [react(), websiteFiles()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // What the React panels share (packages/panel-ui): UI kit, API client, sign-in, live events, styles.
      "@panel": fileURLToPath(new URL("../../packages/panel-ui/src", import.meta.url)),
    },
    dedupe: ["react", "react-dom", "@tanstack/react-query"],
  },
  // The shared package is CommonJS (dist/): pre-bundled in development, converted in the build.
  optimizeDeps: { include: ["@delivery-fast/shared/dist/phone.js", "@delivery-fast/shared/dist/parcel-status.js"] },
  server: { port: 5176, proxy: { "/api": { target: api, changeOrigin: false }, "/site-cache": { target: web, changeOrigin: false } } },
  build: {
    outDir: "../web/public/admin",
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    commonjsOptions: { include: [/packages[\/]shared/, /node_modules/] },
    rollupOptions: {
      output: {
        manualChunks: id => {
          if (id.includes("node_modules/leaflet")) return "map";
          if (id.includes("node_modules/react") || id.includes("node_modules/scheduler")) return "react";
          if (id.includes("node_modules/@tanstack")) return "query";
        },
      },
    },
  },
});
