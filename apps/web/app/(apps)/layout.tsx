import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Paira Express — Apps",
  applicationName: "Paira Express",
  description: "Download the Paira Express Android apps for merchants, riders and operations staff.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#2f62e3" };

/** /apps: the Android apps to download (linked from Courier Operations). Its own document, no panel scripts. */
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="icon" href="/api/v1/branding/icon" />
      </head>
      <body>{children}</body>
    </html>
  );
}
