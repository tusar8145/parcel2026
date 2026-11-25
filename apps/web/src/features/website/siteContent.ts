import { DEFAULT_BRANDING, DEFAULT_WEBSITE, type WebsiteSettings } from "@delivery-fast/shared";

export const SITE_CACHE_TAG = "website";

export type SiteContent = WebsiteSettings & { about: typeof DEFAULT_BRANDING.about; edited: { privacy: boolean; terms: boolean } };

const FALLBACK: SiteContent = { ...DEFAULT_WEBSITE, about: DEFAULT_BRANDING.about, edited: { privacy: false, terms: false } };

/**
 * The public pages' content and switches (GET /website). Cached with the pages, so they open at once; saving in
 * Super admin clears it (app/site-cache/route.ts), and the time limit covers a save whose clearing didn't reach us.
 * The API not reachable: the site's own text, with everything open.
 */
export async function siteContent(): Promise<SiteContent> {
  try {
    const res = await fetch(`${process.env.API_ORIGIN ?? "http://localhost:4000"}/api/v1/website`, {
      next: { tags: [SITE_CACHE_TAG], revalidate: 300 },
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) return (await res.json()) as SiteContent;
  } catch {}
  return FALLBACK;
}

type Social = Partial<Record<"facebook" | "instagram" | "linkedin" | "youtube" | "whatsapp", string>>;
export interface SiteBranding {
  social: Social;
  /** The uploaded logo, null for the default one. */
  logo: { url: string; alt: string } | null;
}

/** The company's logo and social links (Super admin › Branding & company), cached and cleared like the content above. */
export async function siteBranding(): Promise<SiteBranding> {
  try {
    const res = await fetch(`${process.env.API_ORIGIN ?? "http://localhost:4000"}/api/v1/branding`, {
      next: { tags: [SITE_CACHE_TAG], revalidate: 300 },
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const branding = (await res.json()) as { companyName?: string; logoUrl?: string | null; social?: Social };
      return { social: branding.social ?? {}, logo: branding.logoUrl ? { url: branding.logoUrl, alt: branding.companyName ?? "" } : null };
    }
  } catch {}
  return { social: {}, logo: null };
}
