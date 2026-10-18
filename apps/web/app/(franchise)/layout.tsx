import LegacyRootLayout from "@/shared/LegacyRootLayout";

export { metadata, viewport } from "@/features/franchise/metadata";

export default function Layout({ children }: { children: React.ReactNode }) {
  return <LegacyRootLayout app="franchise">{children}</LegacyRootLayout>;
}
