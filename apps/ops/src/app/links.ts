/** Links from notifications, alerts and other panels → this panel's routes. */
import { legacyPath } from "./nav";

/**
 * "/ops?page=Problems&tab=Exceptions&parcel=PP-1" → "/problems/exceptions?parcel=PP-1" (inside /ops),
 * or null when the link belongs to another panel (opened by URL).
 */
export function internalLink(link: string): string | null {
  let url: URL;
  try {
    url = new URL(link, location.origin);
  } catch {
    return null;
  }
  if (url.origin !== location.origin) return null;
  const parcel = url.searchParams.get("parcel");
  const ticket = url.searchParams.get("ticket");
  const tail = parcel ? `?parcel=${encodeURIComponent(parcel)}` : ticket ? `?ticket=${encodeURIComponent(ticket)}` : "";
  const root = url.pathname.replace(/\/$/, "") === "/ops";
  if (url.pathname.startsWith("/ops") && !(root && url.searchParams.has("page"))) return url.pathname.slice(4) + url.search || "/";
  if (!root) return null;
  const page = url.searchParams.get("page");
  if (!page) return `/${tail}`;
  if (/^notifications$/i.test(page)) return "/notifications";
  if (/^support/i.test(page)) return `/support${tail}`;
  const path = legacyPath(page, url.searchParams.get("tab"));
  return path ? `${path}${tail}` : `/${tail}`;
}

/**
 * On opening this console: a link with ?page=…&tab=… (notifications, e-mails) opens the same view.
 */
export function arriveFromClassic() {
  if (location.pathname.replace(/\/$/, "") !== "/ops" || !new URLSearchParams(location.search).has("page")) return;
  const to = internalLink(`/ops${location.search}`);
  if (to) history.replaceState(null, "", `/ops${to}`);
}
