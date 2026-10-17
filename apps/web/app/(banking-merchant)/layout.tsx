import LegacyRootLayout from "@/shared/LegacyRootLayout";

export { metadata, viewport } from "@/features/banking-merchant/metadata";

export default function Layout({ children }: { children: React.ReactNode }) {
  return <LegacyRootLayout app="banking-merchant">{children}</LegacyRootLayout>;
}
