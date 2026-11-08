/** Links from notifications, alerts and other panels → this panel's routes. */
import { legacyPath } from "./nav";

/**
 * "/courier-operation?page=Problems&tab=Exceptions&parcel=PP-1" → "/problems/exceptions?parcel=PP-1" (inside /ops),
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
  if (url.pathname.startsWith("/ops")) return url.pathname.slice(4) + url.search || "/";
  if (url.pathname !== "/courier-operation") return null;
  const page = url.searchParams.get("page");
  if (!page) return `/${tail}`;
  if (/^notifications$/i.test(page)) return "/notifications";
  if (/^support/i.test(page)) return `/support${tail}`;
  const path = legacyPath(page, url.searchParams.get("tab"));
  return path ? `${path}${tail}` : `/${tail}`;
}

/** Opening the classic console: it stays chosen on reload (next.config.ts sends /courier-operation here otherwise). */
export function chooseClassic() {
  document.cookie = "df-classic=1; path=/; SameSite=Lax";
}

/**
 * On opening this console: the classic choice ends, and a classic link sent here (/courier-operation?page=…&tab=…,
 * redirected to /ops with its query) opens the same view.
 */
export function arriveFromClassic() {
  document.cookie = "df-classic=; path=/; max-age=0";
  if (location.pathname.replace(/\/$/, "") !== "/ops" || !new URLSearchParams(location.search).has("page")) return;
  const to = internalLink(`/courier-operation${location.search}`);
  if (to) history.replaceState(null, "", `/ops${to}`);
}
