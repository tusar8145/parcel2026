import WebsitePage from "@/features/website/WebsitePage";
import { PrivacyPolicy } from "@/features/website/components/LegalPage";
import { pageMetadata } from "@/features/website/seo";
import { STATIC_PAGES } from "@/features/website/routes";

const page = STATIC_PAGES.find(p => p.path === "privacy")!;
export const metadata = pageMetadata({ ...page, index: true });

export default function Privacy() {
  return <WebsitePage staticPage={{ name: "privacy", content: <PrivacyPolicy /> }} />;
}
