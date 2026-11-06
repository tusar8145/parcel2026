import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Delivery Fast — Rider workspace",
  applicationName: "Delivery Fast",
  // The browser tab icon comes from branding (LegacyRootLayout); the home-screen icon stays the app's own.
  icons: {
    apple: [{ url: "/pwa/rider-apple-180.png", sizes: "180x180" }],
  },
  appleWebApp: { capable: true, title: "Delivery Fast", statusBarStyle: "default" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f5f7fa",
};
