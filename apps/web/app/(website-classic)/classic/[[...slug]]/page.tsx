import type { Metadata } from "next";
import { renderWebsite, routeMetadata, routeParams, type RouteProps } from "@/features/website/websiteRoute";

/** The classic design of every website URL: same pages and features, never indexed (the new design is the main site). */
export async function generateMetadata(props: RouteProps): Promise<Metadata> {
  return { ...(await routeMetadata(props)), robots: { index: false, follow: false } };
}

export function generateStaticParams() {
  return routeParams();
}

export default async function Page({ params }: RouteProps) {
  return renderWebsite(params, true);
}
