import LegacyRootLayout from "@/shared/LegacyRootLayout";

export { metadata, viewport } from "@/features/super-admin/metadata";

export default function Layout({ children }: { children: React.ReactNode }) {
  return <LegacyRootLayout app="super-admin">{children}</LegacyRootLayout>;
}
