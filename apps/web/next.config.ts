import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
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

export default function nextConfig(phase: string): NextConfig {
  // The dev server reads public/legacy on every request and the files change while it runs: no
  // version hashes (they would be the ones from start-up) and no long-lived caching there.
  const dev = phase === PHASE_DEVELOPMENT_SERVER;
  const legacyVersions = dev ? {} : legacyAssetVersions(path.join(__dirname, "public", "legacy"));
  return {
    env: { LEGACY_ASSET_VERSIONS: JSON.stringify(legacyVersions) },
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
