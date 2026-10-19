"use client";

import { useEffect } from "react";
import { WEBSITE_ROUTES } from "./routes";

/** Keep old `/#/route` links working while the non-home routes still use the legacy router. */
export default function LegacyHashRedirect() {
  useEffect(() => {
    const redirect = () => {
      if (!location.hash.startsWith("#/")) return;
      const [legacy, ...params] = location.hash.slice(2).split("/");
      const route = WEBSITE_ROUTES.find(item => item.legacy === legacy);
      if (!route) return;
      const suffix = params.map(encodeURIComponent).join("/");
      const path = [route.path, suffix].filter(Boolean).join("/");
      location.replace(path ? `/${path}` : "/");
    };
    redirect();
    window.addEventListener("hashchange", redirect);
    return () => window.removeEventListener("hashchange", redirect);
  }, []);

  return null;
}
