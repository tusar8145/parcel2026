/**
 * The website comes in two designs: the new one (the main site) and the classic one (app/(website-classic), served
 * under /classic). Opening /classic… keeps the visitor on the classic design (a cookie) at the usual addresses;
 * ?site=new takes them back. Only the website's own pages pass through here (matcher), never the panels or the API.
 */
import { NextResponse, type NextRequest } from "next/server";

const COOKIE = "df_site";
const YEAR = 60 * 60 * 24 * 365;

export function proxy(request: NextRequest) {
  const url = request.nextUrl;
  // /classic, /classic/pricing …: remember the choice, then the usual address.
  if (url.pathname === "/classic" || url.pathname.startsWith("/classic/")) {
    const to = url.clone();
    to.pathname = url.pathname.slice("/classic".length) || "/";
    const res = NextResponse.redirect(to);
    res.cookies.set(COOKIE, "classic", { path: "/", maxAge: YEAR, sameSite: "lax" });
    return res;
  }
  if (url.searchParams.get("site") === "new") {
    const to = url.clone();
    to.searchParams.delete("site");
    const res = NextResponse.redirect(to);
    res.cookies.delete(COOKIE);
    return res;
  }
  if (request.cookies.get(COOKIE)?.value === "classic") {
    const to = url.clone();
    to.pathname = `/classic${url.pathname === "/" ? "" : url.pathname}`;
    return NextResponse.rewrite(to);
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/",
    "/classic/:path*",
    "/request",
    "/track/:path*",
    "/pricing",
    "/services",
    "/login",
    "/signup",
    "/become-a-rider",
    "/become-a-franchise",
    "/support",
    "/account/:path*",
    "/application-received",
    "/about",
    "/privacy",
    "/terms",
  ],
};
