import WebsitePage from "@/features/website/WebsitePage";
import { LegalPage } from "@/features/website/components/LegalPage";
import { pageMetadata } from "@/features/website/seo";
import { STATIC_PAGES } from "@/features/website/routes";
import { siteContent } from "@/features/website/siteContent";

const page = STATIC_PAGES.find(p => p.path === "privacy")!;
export const metadata = pageMetadata({ ...page, index: true });

export default async function Page() {
  const site = await siteContent();
  return <WebsitePage staticPage={{ name: "privacy", content: <LegalPage page={site.privacy} edited={site.edited.privacy} /> }} />;
}
