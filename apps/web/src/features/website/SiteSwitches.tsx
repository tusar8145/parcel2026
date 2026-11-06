import type { SiteContent } from "./siteContent";

/** Every way into a feature, by its link (server-drawn and page-script links alike). */
const links = (href: string, open: string) => [`a[href="${href}"]`, `a[href="#${href}"]`, `[data-open="${open}"]`, `[data-route="${open}"]`];
const partner = (href: string, open: string) => [...links(href, open), `.partner-card:has(a[href="${href}"])`];

/** Super admin › Website settings: what is off doesn't show, from the first paint. */
export default function SiteSwitches({ site }: { site: SiteContent }) {
  const hidden = [
    ...(site.signups.merchant ? [] : partner("/merchant", "merchant")),
    ...(site.signups.rider ? [] : partner("/become-a-rider", "rider")),
    ...(site.signups.franchise ? [] : partner("/become-a-franchise", "franchise")),
    ...(site.signups.customer ? [] : links("/signup", "signup")),
    ...(site.sendParcel ? [] : links("/request", "request")),
  ];
  return hidden.length ? <style dangerouslySetInnerHTML={{ __html: `${hidden.join(",")}{display:none!important}` }} /> : null;
}

/** The route's switch, by the page scripts' route name; undefined for routes without one. */
export function isClosed(site: SiteContent, route: string) {
  const open: Record<string, boolean> = { merchant: site.signups.merchant, rider: site.signups.rider, franchise: site.signups.franchise, signup: site.signups.customer, request: site.sendParcel };
  return open[route] === false;
}
