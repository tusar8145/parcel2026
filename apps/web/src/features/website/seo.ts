import type { Metadata } from "next";
import { SITE_NAME } from "./routes";

// Kept apart from metadata.ts: the layout re-exports that module's `metadata`, and the
// bundler keeps only those exports there.

/** Title, description, canonical URL, Open Graph and indexing for one website path. */
export function pageMetadata({ path, title, description, index }: { path: string; title: string; description: string; index: boolean }): Metadata {
  const url = `/${path}`;
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { type: "website", siteName: SITE_NAME, locale: "en_BD", title, description, url },
    twitter: { card: "summary", title, description },
    robots: index ? { index: true, follow: true } : { index: false, follow: true, nocache: true },
  };
}
