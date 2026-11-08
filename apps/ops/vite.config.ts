import { defineConfig, type Plugin } from "vite";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

/**
 * Served at /ops/ on the same domain as the API (the refresh cookie is same-origin).
 * Production: built into apps/web/public/ops, which Next.js serves (next.config.ts sends /ops/* to its index.html).
 * Development: `npm run dev -w @delivery-fast/ops` proxies /api to the local API (API_ORIGIN, default :4000).
 */
const api = process.env.API_ORIGIN ?? "http://localhost:4000";

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

export default defineConfig({
  base: "/ops/",
  plugins: [react(), websiteFiles()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // The shared package is CommonJS (dist/): pre-bundled in development, converted in the build.
  optimizeDeps: { include: ["@delivery-fast/shared/dist/phone.js", "@delivery-fast/shared/dist/parcel-status.js"] },
  server: { port: 5174, proxy: { "/api": { target: api, changeOrigin: false } } },
  build: {
    outDir: "../web/public/ops",
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
