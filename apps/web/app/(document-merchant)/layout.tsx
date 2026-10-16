import LegacyRootLayout from "@/shared/LegacyRootLayout";

export { metadata, viewport } from "@/features/document-merchant/metadata";

export default function Layout({ children }: { children: React.ReactNode }) {
  return <LegacyRootLayout app="document-merchant">{children}</LegacyRootLayout>;
}
