import WebsitePage from "@/features/website/WebsitePage";
import { TermsOfService } from "@/features/website/components/LegalPage";
import { pageMetadata } from "@/features/website/seo";
import { STATIC_PAGES } from "@/features/website/routes";

const page = STATIC_PAGES.find(p => p.path === "terms")!;
export const metadata = pageMetadata({ ...page, index: true });

export default function Terms() {
  return <WebsitePage staticPage={{ name: "terms", content: <TermsOfService /> }} />;
}
