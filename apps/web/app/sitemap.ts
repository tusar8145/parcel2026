import type { MetadataRoute } from "next";
import { STATIC_PAGES, WEBSITE_ROUTES, siteUrl } from "@/features/website/routes";

/** Public, indexable website pages. Account, tracking results and panels are left out. */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl();
  return [
    ...WEBSITE_ROUTES.filter(r => r.index).map(r => ({
      url: `${base}/${r.path}`,
      changeFrequency: r.changeFrequency ?? "monthly",
      priority: r.priority ?? 0.5,
    })),
    ...STATIC_PAGES.map(p => ({ url: `${base}/${p.path}`, changeFrequency: "yearly" as const, priority: 0.3 })),
  ];
}
