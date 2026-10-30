import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { networkInterfaces } from "node:os";
import path from "node:path";
import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

const pages = [
  "courier-operation",
  "rider",
  "ecommerce-merchant",
  "banking-merchant",
  "super-admin",
  "franchise",
  "application",
];

// The API runs separately (apps/api). Proxying it under /api keeps the browser on one
// origin, so the refresh-token cookie is first-party and no CORS is needed.
const API_ORIGIN = process.env.API_ORIGIN ?? "http://localhost:4000";

function legacyAssetVersions(root: string, directory = root): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(versions, legacyAssetVersions(root, file));
    else {
      const relative = path.relative(root, file).split(path.sep).join("/");
      versions[`/legacy/${relative}`] = createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16);
    }
  }
  return versions;
}

/**
 * CHANGELOG.md (repo root): "## 1.2.0 — 2026-11-02" headings, newest first, each followed by "- change"
 * lines. The panels show the newest version and these notes (AppVersion).
 */
function releases(file: string) {
  const list: { version: string; date: string; changes: string[] }[] = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const head = /^##\s+v?(\d+\.\d+\.\d+)\s*(?:[—–-]\s*(\S+))?/.exec(line);
    const release = list[list.length - 1];
    const plain = (text: string) => text.replace(/`|\*\*/g, "").trim();
    if (head) list.push({ version: head[1], date: head[2] ?? "", changes: [] });
    else if (release && /^\s*[-*]\s+/.test(line)) release.changes.push(plain(line.replace(/^\s*[-*]\s+/, "")));
    else if (release?.changes.length && /^\s+\S/.test(line)) release.changes[release.changes.length - 1] += ` ${plain(line)}`;
  }
  if (!list.length) throw new Error(`${file} has no release heading ("## 1.0.0 — 2026-10-30")`);
  return list;
}

/**
 * This computer's network (LAN) addresses. Phones open the dev server through one of them ("Scan
 * with phone" links); Next.js blocks its dev scripts for any other host than localhost unless listed,
 * so the page would load without its JavaScript and never connect.
 */
function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap(list => list ?? [])
    .filter(a => a.family === "IPv4" && !a.internal)
    .map(a => a.address);
}

export default function nextConfig(phase: string): NextConfig {
  // The dev server reads public/legacy on every request and the files change while it runs: no
  // version hashes (they would be the ones from start-up) and no long-lived caching there.
  const dev = phase === PHASE_DEVELOPMENT_SERVER;
  const legacyVersions = dev ? {} : legacyAssetVersions(path.join(__dirname, "public", "legacy"));
  const changelog = releases(path.join(__dirname, "../../CHANGELOG.md"));
  return {
    env: {
      LEGACY_ASSET_VERSIONS: JSON.stringify(legacyVersions),
      APP_VERSION: changelog[0].version,
      APP_RELEASES: JSON.stringify(changelog.slice(0, 10)),
    },
    // Development only: phones on the same Wi-Fi may use the dev server (e.g. the Scan with phone page).
    ...(dev ? { allowedDevOrigins: lanAddresses() } : {}),
    // Self-contained server for the Docker image (apps/web/Dockerfile). Dependencies are
    // hoisted to the monorepo root, so trace from there.
    output: "standalone",
    outputFileTracingRoot: path.join(__dirname, "../.."),
    // Each page's styles.css is read when the page is rendered (LegacyRootLayout).
    outputFileTracingIncludes: { "/**": ["./src/features/*/styles.css"] },
    async headers() {
      return [
        {
          source: "/legacy/:path*",
          headers: [{ key: "Cache-Control", value: dev ? "no-cache" : "public, max-age=31536000, immutable" }],
        },
      ];
    },
    async rewrites() {
      return [{ source: "/api/:path*", destination: `${API_ORIGIN}/api/:path*` }];
    },
    // Keep old .html links working.
    async redirects() {
      return [
        { source: "/website.html", destination: "/", permanent: true },
        { source: "/courier.html", destination: "/courier-operation", permanent: true },
        ...pages.map(page => ({ source: `/${page}.html`, destination: `/${page}`, permanent: true })),
        // The document merchant panel became the Banking & Financial merchant panel.
        { source: "/document-merchant", destination: "/banking-merchant", permanent: true },
        { source: "/document-merchant.html", destination: "/banking-merchant", permanent: true },
      ];
    },
  };
}
