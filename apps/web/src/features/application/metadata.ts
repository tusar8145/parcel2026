import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Paira Express — Your application",
  applicationName: "Paira Express",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f5f7fa",
};
