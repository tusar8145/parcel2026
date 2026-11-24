import WebsitePage from "@/features/website/WebsitePage";
import { PartnersPage } from "@/features/website/v2/MenuPages";
import { pageMetadata } from "@/features/website/seo";
import { STATIC_PAGES } from "@/features/website/routes";

const page = STATIC_PAGES.find(p => p.path === "partners")!;
export const metadata = pageMetadata({ ...page, index: true });

/** The menu's partners page (new design). */
export default async function Page() {
  return <WebsitePage staticPage={{ name: "partners", content: <PartnersPage /> }} />;
}
