import WebsitePage from "@/features/website/WebsitePage";
import { HelpPage } from "@/features/website/v2/MenuPages";
import { pageMetadata } from "@/features/website/seo";
import { STATIC_PAGES } from "@/features/website/routes";
import { siteContent } from "@/features/website/siteContent";

const page = STATIC_PAGES.find(p => p.path === "help")!;
export const metadata = pageMetadata({ ...page, index: true });

/** The menu's help page (new design). */
export default async function Page() {
  const { faqs } = await siteContent();
  return <WebsitePage staticPage={{ name: "help", content: <HelpPage faqs={faqs} /> }} />;
}
