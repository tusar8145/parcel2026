import type { Metadata } from "next";
import { renderWebsite, routeMetadata, routeParams, type RouteProps } from "@/features/website/websiteRoute";

/** Every website URL, in the new design (the main site). */
export async function generateMetadata(props: RouteProps): Promise<Metadata> {
  return routeMetadata(props);
}

/** /services has its own page (app/(website)/services). */
export function generateStaticParams() {
  return routeParams().filter(p => p.slug.join("/") !== "services");
}

export default async function Page({ params }: RouteProps) {
  return renderWebsite(params, false);
}
