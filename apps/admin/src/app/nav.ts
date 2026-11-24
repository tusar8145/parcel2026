/**
 * The super admin menu (MENU: main items, some folding out into sub-menus) and each page's address: /admin/<slug>,
 * the same slugs as the classic ?page= (so old links translate directly).
 */
import type { IconName } from "@panel/ui/Icon";

export interface PageDef {
  id: string;
  /** The page's full name (top bar). */
  label: string;
  /** A shorter name in the menu, where its sub-menu already says the rest. */
  menu?: string;
  slug: string;
  icon: IconName;
  /** Other classic ?page= values and old addresses that open this page. */
  legacy?: string[];
}

export const PAGES: PageDef[] = [
  { id: "Overview", label: "Platform overview", slug: "overview", icon: "grid", legacy: ["dashboard"] },
  // Registrations and the Approval center were the same page: one item now; the old addresses still open it.
  { id: "Registrations", label: "Registrations", slug: "registrations", icon: "users", legacy: ["approval-center", "approvals"] },
  { id: "Banking & Financial merchants", label: "Banking & Financial merchants", menu: "Banking & Financial", slug: "banking-and-financial-merchants", icon: "file", legacy: ["banking-financial-merchants", "document-merchants"] },
  { id: "E-commerce merchants", label: "E-commerce merchants", menu: "E-commerce", slug: "e-commerce-merchants", icon: "box", legacy: ["ecommerce-merchants"] },
  { id: "Service plans", label: "Service plans & pricing", menu: "Service plan", slug: "service-plans", icon: "sheet", legacy: ["service-plans-and-pricing"] },
  { id: "Riders", label: "Riders", slug: "riders", icon: "truck" },
  { id: "Franchise riders", label: "Franchise riders", slug: "franchise-riders", icon: "truck" },
  { id: "Rider plans", label: "Rider earning plans", slug: "rider-plans", icon: "truck", legacy: ["rider-earning-plans"] },
  { id: "Live map", label: "Live map", slug: "live-map", icon: "pin" },
  { id: "Platform activity", label: "Platform activity", slug: "platform-activity", icon: "chart" },
  { id: "Audit log", label: "Audit & security log", slug: "audit-log", icon: "lock", legacy: ["audit-and-security-log"] },
  { id: "Admin users", label: "Admin users & roles", slug: "admin-users", icon: "users", legacy: ["admin-users-and-roles"] },
  { id: "Platform settings", label: "Global notifications", menu: "Notification", slug: "global-notifications", icon: "bell", legacy: ["platform-settings", "parcel-notifications"] },
  { id: "Push messages", label: "Push messages", slug: "push-notifications", icon: "push", legacy: ["push-messages"] },
  { id: "SMS messages", label: "SMS messages", slug: "sms-messages", icon: "sms" },
  { id: "Email messages", label: "Email messages", slug: "email-messages", icon: "mail" },
  { id: "Recent messages", label: "Recent messages", menu: "Message History", slug: "recent-messages", icon: "message" },
  { id: "Mobile apps", label: "Mobile apps", slug: "mobile-apps", icon: "phone" },
  { id: "Website settings", label: "Website & branding", menu: "Website & Branding", slug: "website-settings", icon: "edit", legacy: ["website-and-branding"] },
  { id: "Return reasons", label: "Return reasons", slug: "return-reasons", icon: "refresh" },
  { id: "Receiver relations", label: "Receiver relations", slug: "receiver-relations", icon: "users" },
  { id: "Fail delivery reasons", label: "Fail delivery reasons", slug: "fail-delivery-reasons", icon: "alert" },
  { id: "Products", label: "Products", slug: "products", icon: "box" },
  { id: "Priorities", label: "Priorities", slug: "priorities", icon: "alert" },
  { id: "Delivery types", label: "Delivery types", slug: "delivery-types", icon: "truck" },
  { id: "Invoice settings", label: "Invoice settings", slug: "invoice-settings", icon: "file" },
  { id: "Import settings", label: "Import Template settings", slug: "import-settings", icon: "upload", legacy: ["import-template-settings"] },
  { id: "Scan usage", label: "AI Scan with phone", slug: "scan-usage", icon: "camera" },
  { id: "CN scan", label: "AI CN_Scan", slug: "cn-scan", icon: "camera" },
  { id: "AI import", label: "AI Product & Address", slug: "ai-import", icon: "sheet" },
  { id: "AI address reading", label: "AI best route", slug: "ai-address-reading", icon: "pin" },
  { id: "Address", label: "Address", slug: "address", icon: "pin" },
  { id: "Hubs & zones", label: "Hubs & zones", slug: "hubs-and-zones", icon: "map" },
  { id: "Franchises", label: "Franchise settings", menu: "Franchise", slug: "franchises", icon: "share" },
  { id: "Integration settings", label: "Integration settings", menu: "Integration", slug: "integration-settings", icon: "settings", legacy: ["channels-and-limits", "channel-and-limits"] },
  { id: "System guide", label: "System guide", slug: "system-guide", icon: "help" },
];

/** A page (its id) or a sub-menu that folds out. */
export type MenuEntry = string | { label: string; icon: IconName; items: MenuEntry[] };

/** The menu, in two parts (a line between them). */
export const MENU: { label: string; entries: MenuEntry[] }[] = [
  {
    label: "Business",
    entries: [
      "Overview",
      "Registrations",
      { label: "Merchant Manage", icon: "box", items: ["Banking & Financial merchants", "E-commerce merchants", "Service plans"] },
      { label: "Rider Manage", icon: "truck", items: ["Riders", "Rider plans", "Franchise riders"] },
      { label: "Monitoring", icon: "chart", items: ["Live map", "Platform activity", "Audit log"] },
    ],
  },
  {
    label: "Platform control",
    entries: [
      "Admin users",
      { label: "Send Message", icon: "message", items: ["Push messages", "SMS messages", "Email messages", "Recent messages"] },
      {
        label: "Operational",
        icon: "sheet",
        items: ["Return reasons", "Receiver relations", "Fail delivery reasons", "Products", "Priorities", "Delivery types", "Invoice settings", "Import settings", "Scan usage", "CN scan", "AI import", "AI address reading"],
      },
      { label: "Hub", icon: "pin", items: ["Address", "Hubs & zones"] },
      {
        label: "Settings",
        icon: "settings",
        items: [
          "Franchises",
          "Platform settings",
          "Integration settings",
          "Website settings",
          "Mobile apps",
        ],
      },
      "System guide",
    ],
  },
];

/** The pages a menu entry holds (itself, or everything in its sub-menus). */
export const pagesIn = (e: MenuEntry): string[] => (typeof e === "string" ? [e] : e.items.flatMap(pagesIn));
/** The sub-menus (their labels) that hold a page, outermost first. */
export function foldersOf(id: string, entries: MenuEntry[] = MENU.flatMap(g => g.entries)): string[] {
  for (const e of entries) {
    if (typeof e === "string") continue;
    if (pagesIn(e).includes(id)) return [e.label, ...foldersOf(id, e.items)];
  }
  return [];
}

export const pageBySlug = (slug?: string) => PAGES.find(p => p.slug === slug);
export const pageById = (id: string) => PAGES.find(p => p.id === id);

/** "?page=Registrations&tab=…" (classic links and notifications) → "/registrations". */
export function legacyPath(page: string): string | null {
  const key = page.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (key === "notifications") return "/notifications";
  const found = PAGES.find(p => p.slug === key || p.legacy?.includes(key) || p.id.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-") === key);
  return found ? `/${found.slug}` : null;
}
