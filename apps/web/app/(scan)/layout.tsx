import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Paira Express — Scan parcels",
  applicationName: "Paira Express",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#2f62e3" };

/** The phone page of "Scan with phone" (Courier Operations › New orders): its own document, no panel scripts. */
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
