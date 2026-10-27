import { DEFAULT_BRANDING } from "@delivery-fast/shared";
import WebsitePage from "@/features/website/WebsitePage";
import { AboutPage } from "@/features/website/components/AboutPage";
import { pageMetadata } from "@/features/website/seo";
import { STATIC_PAGES } from "@/features/website/routes";

const page = STATIC_PAGES.find(p => p.path === "about")!;
export const metadata = pageMetadata({ ...page, index: true });

// The text comes from Super admin › Branding & company: read on every visit, so a saved change shows at once.
export const dynamic = "force-dynamic";

async function about() {
  try {
    const res = await fetch(`${process.env.API_ORIGIN ?? "http://localhost:4000"}/api/v1/branding`, { cache: "no-store", signal: AbortSignal.timeout(4000) });
    if (res.ok) return ((await res.json()) as { about: typeof DEFAULT_BRANDING.about }).about;
  } catch {}
  // The API not reachable: Delivery Fast's own page.
  return DEFAULT_BRANDING.about;
}

export default async function About() {
  return <WebsitePage staticPage={{ name: "about", content: <AboutPage about={await about()} /> }} />;
}
