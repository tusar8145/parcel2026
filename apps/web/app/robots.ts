import type { MetadataRoute } from "next";
import { siteUrl } from "@/features/website/routes";

/** Crawl the public website; keep accounts, tracking results, the API and the staff panels out. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/api/",
        "/account",
        "/support",
        "/track/",
        "/application-received",
        "/courier-operation",
        "/rider",
        "/ecommerce-merchant",
        "/banking-merchant",
        "/super-admin",
      ],
    },
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
