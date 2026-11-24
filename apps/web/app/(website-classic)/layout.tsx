import LegacyRootLayout from "@/shared/LegacyRootLayout";

export { metadata, viewport } from "@/features/website/metadata";

/** The website in its previous design, served at /classic (proxy.ts keeps a visitor there once chosen). */
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <LegacyRootLayout app="website" classic>
      {children}
    </LegacyRootLayout>
  );
}
