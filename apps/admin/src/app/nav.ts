/**
 * The super admin menu (the classic panel's names, groups, sub-menus and order) and each page's address:
 * /admin/<slug>, the same slugs as the classic ?page= (so old links translate directly).
 */
import type { IconName } from "@panel/ui/Icon";

export interface PageDef {
  id: string;
  label: string;
  slug: string;
  icon: IconName;
  group: "governance" | "merchants" | "riders" | "monitoring" | "platform";
  /** A collapsible sub-menu inside Platform control. */
  sub?: "Notification settings" | "Messaging" | "Operational settings" | "Location settings";
  /** Other classic ?page= values that open this page. */
  legacy?: string[];
}

export const PAGES: PageDef[] = [
  { id: "Overview", label: "Platform overview", slug: "overview", icon: "grid", group: "governance", legacy: ["dashboard"] },
  { id: "Registrations", label: "Registrations", slug: "registrations", icon: "users", group: "governance" },
  { id: "Approvals", label: "Approval center", slug: "approval-center", icon: "check", group: "governance", legacy: ["approvals"] },
  { id: "E-commerce merchants", label: "E-commerce merchants", slug: "e-commerce-merchants", icon: "box", group: "merchants", legacy: ["ecommerce-merchants"] },
  { id: "Banking & Financial merchants", label: "Banking & Financial merchants", slug: "banking-and-financial-merchants", icon: "file", group: "merchants", legacy: ["banking-financial-merchants", "document-merchants"] },
  { id: "Franchises", label: "Franchises", slug: "franchises", icon: "share", group: "merchants" },
  { id: "Service plans", label: "Service plans & pricing", slug: "service-plans", icon: "sheet", group: "merchants", legacy: ["service-plans-and-pricing"] },
  { id: "Riders", label: "Riders", slug: "riders", icon: "truck", group: "riders" },
  { id: "Rider plans", label: "Rider earning plans", slug: "rider-plans", icon: "truck", group: "riders", legacy: ["rider-earning-plans"] },
  { id: "Platform activity", label: "Platform activity", slug: "platform-activity", icon: "chart", group: "monitoring" },
  { id: "Audit log", label: "Audit & security log", slug: "audit-log", icon: "lock", group: "monitoring", legacy: ["audit-and-security-log"] },
  { id: "Admin users", label: "Admin users & roles", slug: "admin-users", icon: "users", group: "platform", legacy: ["admin-users-and-roles"] },
  { id: "Platform settings", label: "Global notifications", slug: "global-notifications", icon: "bell", group: "platform", sub: "Notification settings", legacy: ["platform-settings", "parcel-notifications"] },
  { id: "Recent messages", label: "Recent messages", slug: "recent-messages", icon: "message", group: "platform", sub: "Notification settings" },
  { id: "Push messages", label: "Push messages", slug: "push-notifications", icon: "phone", group: "platform", sub: "Messaging", legacy: ["push-messages"] },
  { id: "SMS messages", label: "SMS messages", slug: "sms-messages", icon: "message", group: "platform", sub: "Messaging" },
  { id: "Email messages", label: "Email messages", slug: "email-messages", icon: "message", group: "platform", sub: "Messaging" },
  { id: "Website settings", label: "Website & branding", slug: "website-settings", icon: "edit", group: "platform", legacy: ["website-and-branding"] },
  { id: "Return reasons", label: "Return reasons", slug: "return-reasons", icon: "refresh", group: "platform", sub: "Operational settings" },
  { id: "Receiver relations", label: "Receiver relations", slug: "receiver-relations", icon: "users", group: "platform", sub: "Operational settings" },
  { id: "Fail delivery reasons", label: "Fail delivery reasons", slug: "fail-delivery-reasons", icon: "alert", group: "platform", sub: "Operational settings" },
  { id: "Products", label: "Products", slug: "products", icon: "box", group: "platform", sub: "Operational settings" },
  { id: "Priorities", label: "Priorities", slug: "priorities", icon: "alert", group: "platform", sub: "Operational settings" },
  { id: "Delivery types", label: "Delivery types", slug: "delivery-types", icon: "truck", group: "platform", sub: "Operational settings" },
  { id: "Invoice settings", label: "Invoice settings", slug: "invoice-settings", icon: "file", group: "platform", sub: "Operational settings" },
  { id: "Import settings", label: "Import Template settings", slug: "import-settings", icon: "upload", group: "platform", sub: "Operational settings", legacy: ["import-template-settings"] },
  { id: "Scan usage", label: "Scan with phone usage", slug: "scan-usage", icon: "camera", group: "platform", sub: "Operational settings" },
  { id: "AI import", label: "AI import", slug: "ai-import", icon: "sheet", group: "platform", sub: "Operational settings" },
  { id: "Address", label: "Address", slug: "address", icon: "pin", group: "platform", sub: "Location settings" },
  { id: "Hubs & zones", label: "Hubs & zones", slug: "hubs-and-zones", icon: "map", group: "platform", sub: "Location settings" },
  { id: "Integration settings", label: "Integration settings", slug: "integration-settings", icon: "settings", group: "platform", legacy: ["channels-and-limits", "channel-and-limits"] },
  { id: "System guide", label: "System guide", slug: "system-guide", icon: "help", group: "platform" },
];

export const GROUPS: { id: PageDef["group"]; label: string }[] = [
  { id: "governance", label: "Governance" },
  { id: "merchants", label: "Merchant management" },
  { id: "riders", label: "Rider setup & pricing" },
  { id: "monitoring", label: "Monitoring" },
  { id: "platform", label: "Platform control" },
];

export const pageBySlug = (slug?: string) => PAGES.find(p => p.slug === slug);
export const pageById = (id: string) => PAGES.find(p => p.id === id);

/** "?page=Registrations&tab=…" (classic links and notifications) → "/registrations". */
export function legacyPath(page: string): string | null {
  const key = page.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (key === "notifications") return "/notifications";
  const found = PAGES.find(p => p.slug === key || p.legacy?.includes(key) || p.id.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-") === key);
  return found ? `/${found.slug}` : null;
}
