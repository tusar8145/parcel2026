import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Delivery Fast — Rider workspace",
  applicationName: "Delivery Fast",
  icons: {
    icon: [
      { url: "/pwa/rider-192.png", sizes: "192x192", type: "image/png" },
      { url: "/pwa/rider-512.png", sizes: "512x512", type: "image/png" },
    ],
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
