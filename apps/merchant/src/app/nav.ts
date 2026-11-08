/**
 * The menu (the classic merchant panels', same names and order) and the address of each page: /merchant/<slug>.
 * E-commerce merchants see their own words for some pages ("New orders", "All orders", "Customers", "Products")
 * at their own addresses; both addresses open the page. Old links (?page=<legacy slug>) are translated.
 */
import type { IconName } from "@panel/ui/Icon";

export interface PageDef {
  id: string;
  label: string;
  slug: string;
  icon: IconName;
  group: "workspace" | "manage" | "help";
  /** E-commerce: the page's own name and address, when they differ. */
  eLabel?: string;
  eSlug?: string;
  /** The classic panel's ?page= slugs that open this page. */
  legacy: string[];
  /** Owners only (the classic panel showed staff a note instead). */
  ownerOnly?: boolean;
  subtitle?: string;
}

export const PAGES: PageDef[] = [
  { id: "Overview", label: "Overview", slug: "overview", icon: "grid", group: "workspace", legacy: ["overview", "dashboard"] },
  { id: "New requests", label: "New requests", slug: "new-requests", eLabel: "New orders", eSlug: "new-orders", icon: "plus", group: "workspace", legacy: ["new-orders", "new-requests"] },
  { id: "All requests", label: "All requests", slug: "all-requests", eLabel: "All orders", eSlug: "all-orders", icon: "file", group: "workspace", legacy: ["orders", "all-requests", "all-orders", "shipments", "delivery-tracking"] },
  { id: "Pickup requests", label: "Pickup requests", slug: "pickup-requests", icon: "truck", group: "workspace", legacy: ["pickup-requests"] },
  { id: "Recipients & branches", label: "Recipients & branches", slug: "recipients", eLabel: "Customers", eSlug: "customers", icon: "users", group: "workspace", legacy: ["customers", "recipients-and-branches"] },
  { id: "Product catalogue", label: "Product catalogue", slug: "products", eLabel: "Products", icon: "box", group: "workspace", legacy: ["products", "product-catalogue"] },
  { id: "Balance", label: "Balance", slug: "balance", icon: "wallet", group: "manage", legacy: ["balance", "payments", "billing"] },
  { id: "Reports", label: "Reports", slug: "reports", icon: "chart", group: "manage", legacy: ["reports"] },
  { id: "API & Webhooks", label: "API & Webhooks", slug: "api-and-webhooks", icon: "share", group: "manage", legacy: ["api-and-webhooks"] },
  { id: "Services & pricing", label: "Services & pricing", slug: "services-and-pricing", icon: "sheet", group: "manage", legacy: ["services-and-pricing"] },
  { id: "Settings", label: "Settings", slug: "settings", icon: "settings", group: "manage", legacy: ["settings"] },
  { id: "Support", label: "Support", slug: "support", icon: "message", group: "help", legacy: ["support"] },
];

export const GROUP_LABEL: Record<PageDef["group"], string> = { workspace: "Workspace", manage: "Manage", help: "Support" };

export const pageBySlug = (slug?: string) => PAGES.find(p => p.slug === slug || p.eSlug === slug);
export const pageById = (id: string) => PAGES.find(p => p.id === id);
/** The page's name and address for this merchant type (doc = Banking & Financial). */
export const labelOf = (p: PageDef, doc: boolean) => (doc ? p.label : (p.eLabel ?? p.label));
export const slugOf = (p: PageDef, doc: boolean) => (doc ? p.slug : (p.eSlug ?? p.slug));
export const pathOf = (id: string, doc: boolean) => {
  const p = pageById(id);
  return `/${p ? slugOf(p, doc) : "overview"}`;
};

/** "?page=orders&parcel=FD-1" (classic links) → "/all-requests?parcel=FD-1" (E-commerce: "/all-orders…"). */
export function legacyPath(page: string, doc = true): string | null {
  const key = page.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (key === "notifications") return "/notifications";
  const found = PAGES.find(p => p.legacy.includes(key) || p.slug === key || p.eSlug === key);
  return found ? `/${slugOf(found, doc)}` : null;
}
