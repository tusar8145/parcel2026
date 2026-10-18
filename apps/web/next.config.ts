import path from "node:path";
import type { NextConfig } from "next";

const pages = ["courier-operation", "rider", "ecommerce-merchant", "banking-merchant", "super-admin", "franchise", "application"];

// The API runs separately (apps/api). Proxying it under /api keeps the browser on one
// origin, so the refresh-token cookie is first-party and no CORS is needed.
const API_ORIGIN = process.env.API_ORIGIN ?? "http://localhost:4000";

const nextConfig: NextConfig = {
  // Self-contained server for the Docker image (apps/web/Dockerfile). Dependencies are
  // hoisted to the monorepo root, so trace from there.
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../.."),
  // Each page's styles.css is read when the page is rendered (LegacyRootLayout).
  outputFileTracingIncludes: { "/**": ["./src/features/*/styles.css"] },
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

export default nextConfig;
