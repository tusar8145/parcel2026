import type { Metadata } from "next";
import { notFound } from "next/navigation";
import WebsitePage from "@/features/website/WebsitePage";
import WebsiteHomePage from "@/features/website/WebsiteHomePage";
import { pageMetadata } from "@/features/website/seo";
import { routeForSegments } from "@/features/website/routes";

type Props = { params: Promise<{ slug?: string[] }> };

/**
 * Every website URL (/, /request, /track/PP-…, /account/orders …). The server renders the
 * route's title, description, canonical URL and indexing rule; the page scripts show its view.
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug = [] } = await params;
  const match = routeForSegments(slug);
  if (!match) return { title: "Paira Express — Page not found", robots: { index: false } };
  const { route, param } = match;
  if (route.legacy === "tracking" && param)
    // A tracking result is personal and changes all the time: never indexed.
    return pageMetadata({
      path: `track/${encodeURIComponent(param)}`,
      title: `Paira Express — Track ${param.toUpperCase()}`,
      description: `Delivery status and history for parcel ${param.toUpperCase()}.`,
      index: false,
    });
  if (param) return pageMetadata({ path: `${route.path}/${encodeURIComponent(param)}`, title: route.title, description: route.description, index: false });
  return pageMetadata(route);
}

export default async function Page({ params }: Props) {
  const { slug = [] } = await params;
  if (!routeForSegments(slug)) notFound();
  if (slug.length === 0) return <WebsiteHomePage />;
  return <WebsitePage />;
}
