/**
 * The menu and its views, as in the legacy panel (public/legacy/courier-operation/bridge-nav.js VIEWS):
 * a view is one or more tabs; the address is /ops/<view>/<tab> (slugs). Who sees which view is the same
 * as allowedViews() there; the API still decides every action.
 */
import type { IconName } from "@panel/ui/Icon";
import type { OpsMe } from "@/lib/types";
import { slug } from "@panel/lib/format";

export type StageKey = "newOrders" | "pickup" | "hubDesk" | "transfers" | "delivery" | "problems" | "returns";

export interface TabDef {
  id: string;
  /** Hidden for this person (Accounts tabs by role). */
  show?: (ctx: MenuContext) => boolean;
}
export interface ViewDef {
  id: string;
  label: string;
  icon: IconName;
  group: "today" | "queue" | "journey" | "money" | "find" | "manage";
  step?: string;
  /** The journey stage whose count the menu shows. */
  stage?: StageKey;
  count?: "workQueue" | "accounts";
  title?: string;
  subtitle?: string;
  tabs: TabDef[];
}

export interface MenuContext {
  roles: Set<string>;
  me: OpsMe | null;
  /** GET /accounts/config centralHub id (its staff handle money too). */
  centralHubId?: string | null;
}

const tabs = (...ids: string[]): TabDef[] => ids.map(id => ({ id }));

/** Finance, operations managers, super admins, and the central hub's staff (bridge-accounts.js moneyStaff). */
export function moneyStaff({ me, centralHubId }: MenuContext) {
  if (me?.can.manageFinance && me.can.financeStaff) return true;
  if (!centralHubId || !me?.can.receiveCash) return false;
  return !me.hubIds || me.hubIds.includes(centralHubId);
}
/** Accounts tabs by role (bridge-accounts.js Ops.accountsTab). */
const ACCOUNTS_TABS: Record<string, (c: MenuContext) => boolean> = {
  Overview: moneyStaff,
  "E-commerce": moneyStaff,
  Financial: moneyStaff,
  Customer: moneyStaff,
  "Rider cash": c => !!c.me?.can.receiveCash || moneyStaff(c),
  "Hub transfers": c => !!c.me?.can.receiveCash || moneyStaff(c),
  "Rider pay": c => !!c.me?.can.manageFinance || !!c.me?.can.manageRiders,
  Franchise: c => !!c.me?.can.receiveCash || !!c.me?.can.financeStaff,
};

export const VIEWS: ViewDef[] = [
  { id: "Today", label: "Today", icon: "grid", group: "today", tabs: tabs("Today") },
  {
    id: "New orders",
    label: "New orders",
    icon: "box",
    group: "journey",
    stage: "newOrders",
    subtitle: "Orders waiting for operations: accept and assign a pickup rider, switch to drop-off, or cancel the request.",
    tabs: tabs("New orders"),
  },
  { id: "All parcels", label: "All parcels", icon: "search", group: "today", tabs: tabs("All", "E-commerce", "Banking & Financial", "Customer") },
  { id: "Work queue", label: "Parcel queue", icon: "queue", group: "queue", count: "workQueue", tabs: tabs("Work queue") },
  {
    id: "Scan desk",
    label: "Scan desk",
    icon: "scan",
    group: "queue",
    subtitle: "Quick updates by scanning, one tab per job: receive, pickups, transfers, deliveries, failed deliveries and returns.",
    tabs: tabs("Receive entry", "Receive & assign rider", "Pickup entry", "Transfer out", "Collect from hub", "Out for delivery entry", "Delivery entry", "Failed delivery entry", "Return rider assign", "Return entry"),
  },
  { id: "Pickup", label: "Pickup", icon: "clock", group: "journey", step: "2", stage: "pickup", subtitle: "Assign pickup riders to accepted orders and follow merchants' scheduled pickups.", tabs: tabs("Assign pickup rider", "Scheduled pickups") },
  { id: "Hub desk", label: "Hub desk", icon: "pin", group: "journey", step: "3", stage: "hubDesk", subtitle: "Parcels at your hub with their next step, and the day's reconciliation. Scanning work is on Scan desk.", tabs: tabs("At my hub", "End of day") },
  { id: "Transfers", label: "Transfers", icon: "truck", group: "journey", step: "4", stage: "transfers", tabs: tabs("Send", "Receive", "On the road", "Issues", "Vehicles") },
  { id: "Delivery", label: "Delivery", icon: "route", group: "journey", step: "5", stage: "delivery", subtitle: "Assign delivery riders to parcels at the hub, plan routes and follow riders on the map.", tabs: tabs("Assign delivery rider") },
  {
    id: "Problems",
    label: "Problems",
    icon: "alert",
    group: "journey",
    step: "6",
    stage: "problems",
    subtitle: "Resolve exceptions, failed deliveries, missing details and parcels at risk of running late.",
    tabs: tabs("Exceptions", "Failed delivery", "Needs info", "SLA late-risk"),
  },
  { id: "Returns", label: "Returns", icon: "box", group: "journey", step: "7", stage: "returns", tabs: tabs("Returns") },
  {
    id: "Accounts",
    label: "Accounts",
    icon: "wallet",
    group: "money",
    count: "accounts",
    tabs: Object.entries(ACCOUNTS_TABS).map(([id, show]) => ({ id, show })),
  },
  { id: "Reports", label: "Reports", icon: "chart", group: "find", tabs: tabs("Reports", "Analytics & SLA", "Rider report", "Hub transfer report") },
  { id: "Riders", label: "Riders", icon: "users", group: "manage", tabs: tabs("Riders", "Shifts & attendance", "Verification") },
  { id: "Merchants", label: "Merchants", icon: "users", group: "manage", tabs: tabs("Merchants") },
  { id: "CN stock", label: "CN stock", icon: "box", group: "manage", tabs: tabs("CN stock") },
  { id: "Settings", label: "Settings", icon: "settings", group: "manage", tabs: tabs("Settings") },
];

/** "1" in front of New orders (the journey starts there). */
VIEWS.find(v => v.id === "New orders")!.step = "1";

export const GROUP_LABEL: Record<ViewDef["group"], string | null> = {
  today: null,
  queue: "Parcels & scanning",
  journey: "Parcel journey",
  money: "Money",
  find: "Find & report",
  manage: "Manage",
};

export const JOURNEY: { view: string; stage: StageKey; icon: IconName; hint: string }[] = [
  { view: "New orders", stage: "newOrders", icon: "box", hint: "Accept & assign rider" },
  { view: "Pickup", stage: "pickup", icon: "clock", hint: "Riders collecting" },
  { view: "Hub desk", stage: "hubDesk", icon: "pin", hint: "At hubs · to receive or hand over" },
  { view: "Transfers", stage: "transfers", icon: "truck", hint: "Between hubs" },
  { view: "Delivery", stage: "delivery", icon: "route", hint: "With delivery riders" },
  { view: "Problems", stage: "problems", icon: "alert", hint: "Exceptions · failed · needs info" },
  { view: "Returns", stage: "returns", icon: "box", hint: "Going back to merchants" },
];

export const viewById = (id: string) => VIEWS.find(v => v.id === id);
export const viewBySlug = (s?: string) => VIEWS.find(v => slug(v.id) === s || slug(v.label) === s);
export const tabBySlug = (view: ViewDef, s?: string) => view.tabs.find(t => slug(t.id) === s);
export const pathFor = (view: string, tab?: string) => {
  const v = viewById(view);
  if (!v) return "/";
  return `/${slug(v.id)}${tab && v.tabs.length > 1 ? `/${slug(tab)}` : ""}`;
};

/** Which views this person sees (bridge-nav.js allowedViews). */
export function allowedViews(ctx: MenuContext): Set<string> {
  const { roles, me } = ctx;
  const all = new Set(VIEWS.map(v => v.id));
  if (roles.has("SUPER_ADMIN") || roles.has("OPS_MANAGER")) return all;
  const allow = new Set<string>();
  if (roles.has("HUB_OPERATOR")) {
    ["Today", ...JOURNEY.map(j => j.view), "Work queue", "Scan desk", "All parcels"].forEach(v => allow.add(v));
    if (me?.can.readRiders) allow.add("Riders");
    if (me?.can.receiveCash) allow.add("Accounts");
  }
  if (roles.has("FINANCE")) ["Accounts", "All parcels", "Merchants", "Reports"].forEach(v => allow.add(v));
  if (roles.has("SUPPORT_AGENT")) ["All parcels", "Today"].forEach(v => allow.add(v));
  return allow.size ? allow : all; // custom roles: the whole menu; the API still decides
}

/** Finance-only people see Money first. */
export const financeFirst = (roles: Set<string>) => roles.has("FINANCE") && !["SUPER_ADMIN", "OPS_MANAGER", "HUB_OPERATOR"].some(r => roles.has(r));

/** Old page names (links in notifications, bookmarks) → view and tab (bridge-nav.js OLD). */
export const OLD_PAGES: Record<string, [string, string?]> = {
  Overview: ["Today"],
  "Live overview": ["Today"],
  Shipments: ["All parcels", "All"],
  "E-commerce operations": ["All parcels", "E-commerce"],
  "Banking & Financial operations": ["All parcels", "Banking & Financial"],
  "Domestic & documents": ["All parcels", "Banking & Financial"],
  "Customer parcels": ["All parcels", "Customer"],
  Dispatch: ["Delivery"],
  "Dispatch & routes": ["Delivery"],
  Hubs: ["Scan desk", "Receive entry"],
  Linehaul: ["Transfers"],
  "Returns (RTO)": ["Returns"],
  "Scheduled pickups": ["Pickup", "Scheduled pickups"],
  Exceptions: ["Problems", "Exceptions"],
  Analytics: ["Reports", "Analytics & SLA"],
  "Analytics & SLA": ["Reports", "Analytics & SLA"],
  "COD & finance": ["Accounts"],
  "COD & settlement": ["Accounts"],
  "Merchant accounts": ["Merchants"],
  "Riders & fleet": ["Riders"],
  "Admin settings": ["Settings"],
};

/** A legacy ?page=&tab= link → our path. */
export function legacyPath(page: string, tab?: string | null) {
  const s = slug(page);
  const view = VIEWS.find(v => slug(v.id) === s || slug(v.label) === s);
  if (view) return pathFor(view.id, tab ? view.tabs.find(t => slug(t.id) === slug(tab))?.id : undefined);
  const old = Object.entries(OLD_PAGES).find(([k]) => slug(k) === s);
  if (old) return pathFor(old[1][0], tab ?? old[1][1]);
  return null;
}
