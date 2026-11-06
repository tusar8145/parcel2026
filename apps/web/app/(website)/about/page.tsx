import WebsitePage from "@/features/website/WebsitePage";
import { AboutPage } from "@/features/website/components/AboutPage";
import { pageMetadata } from "@/features/website/seo";
import { STATIC_PAGES } from "@/features/website/routes";
import { siteContent } from "@/features/website/siteContent";

const page = STATIC_PAGES.find(p => p.path === "about")!;
export const metadata = pageMetadata({ ...page, index: true });

export default async function About() {
  const { about } = await siteContent();
  return <WebsitePage staticPage={{ name: "about", content: <AboutPage about={about} /> }} />;
}
