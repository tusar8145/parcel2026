/**
 * Every website URL (/, /request, /track/PP-…, /account/orders …) in either design: the new one
 * (app/(website)/[[...slug]]) and the classic one (app/(website-classic)/classic/[[...slug]], see proxy.ts).
 * The server renders the route's title, description, canonical URL and indexing rule; the page scripts show its view.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import WebsitePage from "./WebsitePage";
import WebsiteHomePage from "./WebsiteHomePage";
import { pageMetadata } from "./seo";
import { routeForSegments, WEBSITE_ROUTES } from "./routes";
import { ClosedPage } from "./components/ClosedPage";
import { isClosed } from "./SiteSwitches";
import { siteContent } from "./siteContent";

export type RouteProps = { params: Promise<{ slug?: string[] }> };

export async function routeMetadata({ params }: RouteProps): Promise<Metadata> {
  const { slug = [] } = await params;
  const match = routeForSegments(slug);
  if (!match) return { title: "Delivery Fast — Page not found", robots: { index: false } };
  const { route, param } = match;
  if (route.legacy === "tracking" && param)
    // A tracking result is personal and changes all the time: never indexed.
    return pageMetadata({
      path: `track/${encodeURIComponent(param)}`,
      title: `Delivery Fast — Track ${param.toUpperCase()}`,
      description: `Delivery status and history for parcel ${param.toUpperCase()}.`,
      index: false,
    });
  if (param) return pageMetadata({ path: `${route.path}/${encodeURIComponent(param)}`, title: route.title, description: route.description, index: false });
  return pageMetadata(route);
}

/** Built ahead (home, /login, /pricing …), so they open from the cache; /track/PP-… is drawn on request. */
export function routeParams() {
  return WEBSITE_ROUTES.map(route => ({ slug: route.path ? route.path.split("/") : [] }));
}

export async function renderWebsite(params: RouteProps["params"], classic: boolean) {
  const { slug = [] } = await params;
  const match = routeForSegments(slug);
  if (!match) notFound();
  if (slug.length === 0) return <WebsiteHomePage classic={classic} />;
  // Turned off in Super admin › Website settings: the page says so instead of a form that would be refused.
  if (isClosed(await siteContent(), match.route.legacy)) return <WebsitePage classic={classic} staticPage={{ name: "closed", content: <ClosedPage route={match.route.legacy} /> }} />;
  return <WebsitePage classic={classic} panelAssets={match.route.legacy === "login"} />;
}
