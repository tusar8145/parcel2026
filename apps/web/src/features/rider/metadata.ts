import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Delivery Fast — Rider workspace",
  applicationName: "Delivery Fast Rider",
  // Installable app (Android "Add to Home screen"); the service worker is public/rider-sw.js.
  manifest: "/rider.webmanifest",
  icons: {
    icon: [
      { url: "/pwa/rider-192.png", sizes: "192x192", type: "image/png" },
      { url: "/pwa/rider-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/pwa/rider-apple-180.png", sizes: "180x180" }],
  },
  appleWebApp: { capable: true, title: "DF Rider", statusBarStyle: "default" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f5f7fa",
};
