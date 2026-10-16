import type { Metadata, Viewport } from "next";
import { HOME_DESCRIPTION, HOME_TITLE, SITE_NAME, siteUrl } from "./routes";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: HOME_TITLE,
  description: HOME_DESCRIPTION,
  applicationName: SITE_NAME,
  openGraph: { type: "website", siteName: SITE_NAME, locale: "en_BD", title: HOME_TITLE, description: HOME_DESCRIPTION, url: "/" },
  twitter: { card: "summary", title: HOME_TITLE, description: HOME_DESCRIPTION },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f8faf8",
};
