import WebsitePage from "@/features/website/WebsitePage";
import { ServicesPage } from "@/features/website/v2/MenuPages";
import { pageMetadata } from "@/features/website/seo";
import { WEBSITE_ROUTES } from "@/features/website/routes";

const page = WEBSITE_ROUTES.find(r => r.path === "services")!;
export const metadata = pageMetadata({ ...page, index: true });

/** The menu's services page (new design). */
export default async function Page() {
  return <WebsitePage staticPage={{ name: "services", content: <ServicesPage /> }} />;
}
