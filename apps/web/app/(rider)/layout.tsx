import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/noto-sans-bengali";
import LegacyRootLayout from "@/shared/LegacyRootLayout";

export { metadata, viewport } from "@/features/rider/metadata";

export default function Layout({ children }: { children: React.ReactNode }) {
  return <LegacyRootLayout app="rider">{children}</LegacyRootLayout>;
}
