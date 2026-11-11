/**
 * What the super admin pages share: the merchant list (with each merchant's service package), the platform overview,
 * staff and hubs (the classic bridge.js loaders), the classic wording for statuses and audit entries, Dhaka-time
 * formatting, and a dialog frame for the custom dialogs.
 */
import type { ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@panel/lib/api";
import { queryClient } from "@panel/lib/queryClient";
import { localPhone } from "@panel/lib/format";
import { DHAKA_SUBURBAN_DISTRICTS, normalizeDistrict } from "@delivery-fast/shared/dist/packages.js";
import { Icon } from "@panel/ui/Icon";

// ───────────── formatting (Asia/Dhaka, as the classic panel) ─────────────
const DHAKA = "Asia/Dhaka";
const dayKey = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: DHAKA });
const time = (d: Date) => d.toLocaleTimeString("en-US", { timeZone: DHAKA, hour: "numeric", minute: "2-digit" });
/** "Today, 10:55 PM", "Yesterday, 7:03 PM", "Nov 5, 4:10 PM". */
export function when(iso?: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (dayKey(d) === dayKey(new Date())) return `Today, ${time(d)}`;
  if (dayKey(d) === dayKey(new Date(Date.now() - 864e5))) return `Yesterday, ${time(d)}`;
  return `${d.toLocaleDateString("en-US", { timeZone: DHAKA, month: "short", day: "numeric" })}, ${time(d)}`;
}
/** "Nov 5, 2026, 4:10 PM" (dialogs). */
export const whenFull = (iso?: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "—");
export const dateOf = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: DHAKA, month: "short", day: "numeric", year: "numeric" }) : "—");
export const num = (n: unknown) => Number(n || 0).toLocaleString("en-US");
export const taka = (n: unknown) => `৳ ${Number(n || 0).toLocaleString("en-BD", { maximumFractionDigits: 0 })}`;
/** "01865-689982". */
export const phoneText = (p?: string | null) => localPhone(p || "").replace(/^(\d{5})(\d{6})$/, "$1-$2");
/** "↑ 12.4%", "↓ 3.0%", "new" or "—" against the previous period. */
export const change = (now: number, before: number) => (before ? `${now >= before ? "↑" : "↓"} ${Math.abs(((now - before) / before) * 100).toFixed(1)}%` : now ? "new" : "—");
export const initials = (name?: string | null) =>
  (name || "?")
    .split(/\s+/)
    .map(p => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

/** Every page of a cursor list (the classic `all()`: 200 a page, at most 2000). */
export async function all<T>(path: string): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  do {
    const page: { items: T[]; nextCursor?: string | null } = await api(`${path}${path.includes("?") ? "&" : "?"}limit=200${cursor ? `&cursor=${cursor}` : ""}`);
    items.push(...page.items);
    cursor = page.nextCursor ?? null;
  } while (cursor && items.length < 2000);
  return items;
}

// ───────────── merchants ─────────────
export type MerchantType = "ECOMMERCE" | "BANKING_FINANCIAL";
export type MerchantStatus = "ACTIVE" | "SUSPENDED" | "PENDING_REVIEW" | "INFO_REQUESTED" | "REJECTED";
export interface Place {
  street?: string | null;
  area?: string | null;
  zone?: string | null;
  district?: string | null;
  areaOther?: boolean;
  lat?: number | null;
  lng?: number | null;
}
export interface Merchant {
  id: string;
  code: string;
  name: string;
  type: MerchantType;
  status: MerchantStatus;
  contactName: string;
  contactEmail?: string | null;
  contactPhone?: string | null;
  createdAt: string;
  updatedAt?: string;
  pickupDistrict?: string | null;
  pickupZone?: string | null;
  pickupArea?: string | null;
  pickup?: Place | null;
  business?: Place | null;
  pickupSameAsBusiness?: boolean;
  addressComplete?: boolean;
  pickupContactName?: string | null;
  pickupContactPhone?: string | null;
  pickupTime?: string | null;
  handover?: string | null;
  pickupHub?: { id: string; name: string; code: string; address?: string | null } | null;
  /** The hub was chosen by a super admin (it doesn't follow the pickup address). */
  pickupHubFixed?: boolean;
  routeDistrict?: string | null;
  businessCategory?: string | null;
  websiteUrl?: string | null;
  rejectionReason?: string | null;
  kyc?: { status?: string; submittedAt?: string | null } | null;
  plan?: { id: string; name: string; discountPct?: number } | null;
  /** The service package it books with (from /packages/assignments). */
  package?: { id: string; name: string; isDefault?: boolean } | null;
}

/** The classic wording of a merchant account status. */
export const STATUS_LABEL: Record<MerchantStatus, string> = { ACTIVE: "Active", SUSPENDED: "Suspended", PENDING_REVIEW: "Under review", INFO_REQUESTED: "Under review", REJECTED: "Rejected" };
export const TYPE_LABEL: Record<MerchantType, string> = { ECOMMERCE: "E-commerce merchant", BANKING_FINANCIAL: "Banking & Financial merchant" };
export const SERVICES: Record<MerchantType, string> = { ECOMMERCE: "E-commerce · COD", BANKING_FINANCIAL: "Secure documents · OTP" };
export const packageLabel = (m: Merchant) => (m.package ? `${m.package.name}${m.package.isDefault ? " (default)" : ""}` : "Default package");
export const contactOf = (m: Merchant) => m.contactEmail || phoneText(m.contactPhone);

export function useMerchants() {
  return useQuery({
    queryKey: ["admin", "merchants"],
    queryFn: async () => {
      const [list, ...segments] = await Promise.all([
        all<Merchant>("/merchants"),
        ...(["ECOMMERCE", "BANKING_FINANCIAL"] as const).map(segment => api<{ merchant: { id: string }; package: Merchant["package"] }[]>(`/packages/assignments?segment=${segment}`).catch(() => [])),
      ]);
      const packages = new Map(segments.flat().map(a => [a.merchant.id, a.package]));
      return list.map(m => ({ ...m, package: packages.get(m.id) ?? null }));
    },
    staleTime: 20_000,
    refetchInterval: 30_000,
  });
}

// ───────────── overview ─────────────
export interface PeriodFigures {
  gmv: number;
  bookings: number;
  charges: number;
  activeMerchants: number;
  newMerchants: number;
  delivered: number;
  previous: { gmv: number; bookings: number; charges: number; activeMerchants: number; delivered: number };
  series: { bucket: string; labels: string[]; current: number[]; previous: number[] };
}
export interface Overview {
  generatedAt: string;
  period?: PeriodFigures;
  security?: { superAdmins: number; superAdminsWithMfa: number; staff: number; staffWithMfa: number; staffMfaPercent: number; pendingChanges: number; activeSupportSessions: number };
  periodStarts: { today: string; month: string };
  merchants: { total: number; active: number; suspended: number; pendingReview: number; newThisMonth: number; approvedThisMonth: number };
  staff: { active: number; byRole: Record<string, number> };
  parcels: { today: number; thisMonth: number; codThisMonth: number; chargesThisMonth: number };
  riders: { active: number; online: number; onBreak: number; offline: number };
  auditEventsThisMonth: number;
  merchantActivity: { merchantId: string; parcelsThisMonth: number; lastParcelAt?: string | null }[];
  riderActivity: { riderId: string; deliveredToday: number; pickedUpToday: number }[];
}
const overviewQuery = (query = "") => ({ queryKey: ["admin", "overview", query], queryFn: () => api<Overview>(`/admin/overview${query ? `?${query}` : ""}`), staleTime: 30_000 });
export function useOverview(query = "") {
  return useQuery({ ...overviewQuery(query), refetchInterval: 30_000 });
}
const staffQuery = () => ({ queryKey: ["admin", "staff"], queryFn: () => all<Staff>(`/users?roles=${STAFF_ROLES.join(",")}`), staleTime: 20_000 });

/**
 * Starts loading the Platform overview's figures as soon as the super admin is signed in, while the page's own code
 * is still downloading: the page then finds them ready (or on the way) and its counts start at once.
 */
export function prefetchOverview(periodQuery: string) {
  void queryClient.prefetchQuery(overviewQuery(""));
  void queryClient.prefetchQuery(overviewQuery(periodQuery));
  void queryClient.prefetchQuery(staffQuery());
}

// ───────────── staff, hubs ─────────────
export const STAFF_ROLES = ["SUPER_ADMIN", "OPS_MANAGER", "HUB_OPERATOR", "FINANCE", "SUPPORT_AGENT"] as const;
export const ROLE_LABEL: Record<string, string> = {
  SUPER_ADMIN: "Super Administrator",
  OPS_MANAGER: "Operations Administrator",
  FINANCE: "Finance Administrator",
  SUPPORT_AGENT: "Merchant Support",
  HUB_OPERATOR: "Hub Manager",
};
export const ROLE_SCOPE: Record<string, string> = { SUPER_ADMIN: "Platform-wide", OPS_MANAGER: "Courier operations", FINANCE: "COD & billing", SUPPORT_AGENT: "Merchant accounts" };
export interface Staff {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  status: "ACTIVE" | "SUSPENDED" | "DISABLED";
  lastLoginAt?: string | null;
  mfa?: { enabled?: boolean; required?: boolean } | null;
  roles: { role: string; hub?: { id: string; name: string } | null }[];
}
export function useStaff() {
  return useQuery(staffQuery());
}
export interface Hub {
  id: string;
  name: string;
  code: string;
  active: boolean;
  [key: string]: unknown;
}
export function useHubs() {
  return useQuery({ queryKey: ["admin", "hubs"], queryFn: () => api<Hub[]>("/hubs?includeInactive=true"), staleTime: 60_000 });
}

/** Where a hub stands, for grouped hub lists: Dhaka city, Dhaka's sub-urban districts, the rest, and franchise hubs. */
export type HubGroup = "INSIDE_DHAKA" | "DHAKA_SUBURBAN" | "OUTSIDE_DHAKA" | "FRANCHISE";
export const HUB_GROUPS: [HubGroup, string][] = [
  ["INSIDE_DHAKA", "Inside Dhaka"],
  ["DHAKA_SUBURBAN", "Dhaka sub-urban"],
  ["OUTSIDE_DHAKA", "Outside Dhaka"],
  ["FRANCHISE", "Franchise hubs"],
];
export function hubGroup(h: { type?: unknown; district?: unknown }): HubGroup {
  if (h.type === "FRANCHISE") return "FRANCHISE";
  const d = normalizeDistrict(typeof h.district === "string" ? h.district : "");
  if (d === "Dhaka") return "INSIDE_DHAKA";
  return DHAKA_SUBURBAN_DISTRICTS.some(s => s.toLowerCase() === d.toLowerCase()) ? "DHAKA_SUBURBAN" : "OUTSIDE_DHAKA";
}
/** Hubs in HUB_GROUPS order (name order inside a group), each with its group. */
export function groupHubs<T extends { type?: unknown; district?: unknown; name: string }>(hubs: T[]): { group: HubGroup; label: string; hubs: T[] }[] {
  return HUB_GROUPS.map(([group, label]) => ({ group, label, hubs: hubs.filter(h => hubGroup(h) === group).sort((a, b) => a.name.localeCompare(b.name)) })).filter(g => g.hubs.length);
}

// ───────────── audit wording (bridge.js) ─────────────
export interface AuditEntry {
  id: string;
  action: string;
  actorType?: string;
  actorLabel?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  ip?: string | null;
  data?: Record<string, unknown> | null;
  createdAt: string;
}
const AUDIT_TITLE: Record<string, string> = {
  "auth.login": "Signed in",
  "auth.signup": "Account created",
  "auth.locked": "Account locked after failed sign-ins",
  "auth.password_changed": "Password changed",
  "auth.password_reset": "Password reset",
  "merchant.apply": "Merchant application submitted",
  "merchant.approve": "Merchant account approved",
  "merchant.suspend": "Merchant account suspended",
  "merchant.update": "Merchant account updated",
  "merchant.self_update": "Merchant profile updated",
  "plan.create": "Service plan created",
  "plan.update": "Service plan updated",
  "rate_card.create": "Rate card published",
  "rate_card.deactivate": "Rate card withdrawn",
  "catalog.update": "Booking catalog updated",
  "platform_config.update": "Platform settings updated",
  "user.create": "Administrator account created",
  "user.status_change": "Account status changed",
  "user.role_add": "Role granted",
  "user.role_remove": "Role removed",
  "auth.mfa_enabled": "Two-step verification turned on",
  "auth.mfa_disabled": "Two-step verification turned off",
  "auth.mfa_reset": "Two-step verification reset",
  "auth.mfa_challenge": "Two-step verification requested",
  "auth.mfa_setup_required": "Two-step verification setup requested",
  "auth.mfa_failed": "Wrong two-step code",
  "auth.mfa_locked": "Two-step verification locked after wrong codes",
  "auth.mfa_recovery_code_used": "Recovery code used",
  "change.request": "Change sent for approval",
  "change.approve": "Change approved",
  "change.reject": "Change rejected",
  "change.cancel": "Change withdrawn",
  "change.applied": "Change applied",
  "change.failed": "Approved change could not be applied",
  "role.permissions_update": "Role permissions changed",
  "custom_role.create": "Custom role created",
  "custom_role.update": "Custom role changed",
  "custom_role.delete": "Custom role deleted",
  "merchant_rate.set": "Merchant tariff set",
  "merchant_rate.remove": "Merchant tariff removed",
  "impersonation.start": "Support access started",
  "impersonation.end": "Support access ended",
  "impersonation.request": "Request during support access",
  "parcel.create": "Parcel booked",
  "parcel.status_change": "Parcel status changed",
  "settlement.approve": "Settlement approved",
  "settlement.pay": "Settlement paid",
  "api_key.create": "API key created",
  "api_key.revoke": "API key revoked",
};
export const auditTitle = (a: AuditEntry) => AUDIT_TITLE[a.action] || a.action.replace(/[._]/g, " ").replace(/^./, c => c.toUpperCase());
const SETTING_LABEL: Record<string, string> = { "platform-config": "Platform settings", catalog: "Booking catalog" };
export function auditScope(a: AuditEntry, ctx: { merchants?: Merchant[]; staff?: Staff[] } = {}) {
  if (a.action.startsWith("auth.")) return "Platform access";
  const d = (a.data ?? {}) as Record<string, string | undefined>;
  if (d.trackingId) return d.trackingId;
  const merchant = a.entityType === "merchant" && ctx.merchants?.find(m => m.id === a.entityId);
  if (merchant) return `${merchant.name} · ${merchant.code}`;
  const user = a.entityType === "user" && ctx.staff?.find(u => u.id === a.entityId);
  if (user) return user.name;
  if (a.entityType === "setting" && a.entityId) return SETTING_LABEL[a.entityId] || a.entityId;
  if (d.name) return d.name;
  if (d.code) return d.code;
  return a.entityType && a.entityId ? `${a.entityType.replace(/_/g, " ")} ${a.entityId.length > 20 ? a.entityId.slice(-6) : a.entityId}` : "Platform";
}
export const auditSource = (a: AuditEntry) => (a.actorType === "API_KEY" ? "Merchant API" : a.actorType === "SYSTEM" ? "Automation" : a.ip ? `Web · ${a.ip}` : "Web");
export function auditKind(a: AuditEntry) {
  if (a.actorType === "API_KEY" || a.entityType === "merchant" || /^(merchant|api_key|webhook)\./.test(a.action)) return "merchant";
  if (a.entityType === "rider" || a.action.startsWith("cod.")) return "rider";
  if (a.action === "parcel.status_change") return "tracking";
  if (/^(parcel|auth|address|profile)\./.test(a.action)) return "website";
  return "admin";
}

/** Reload what a merchant decision changes (the classic reload("merchants", "overview", "audit")). */
export function useReloadMerchants() {
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: ["admin", "merchants"] }), qc.invalidateQueries({ queryKey: ["admin", "overview"] }), qc.invalidateQueries({ queryKey: ["admin", "audit"] })]);
}

// ───────────── dialog frame ─────────────
export function DialogFrame({ title, subtitle, close, children, foot }: { title: ReactNode; subtitle?: ReactNode; close: () => void; children: ReactNode; foot?: ReactNode }) {
  return (
    <>
      <div className="dialog-head">
        <div>
          <h2>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        <button type="button" className="button ghost icon dialog-close" aria-label="Close" onClick={close}>
          <Icon name="x" size={18} />
        </button>
      </div>
      <div className="dialog-body">{children}</div>
      {foot ? <div className="dialog-foot">{foot}</div> : null}
    </>
  );
}

/** A two-column "label · value" list (the classic address summary rows). */
export function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <div style={{ fontSize: 13 }}>
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: "grid", gridTemplateColumns: "minmax(110px,150px) 1fr", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--line)" }}>
          <span className="faint">{label}</span>
          <span>{value}</span>
        </div>
      ))}
    </div>
  );
}

// ───────────── platform settings (GET / PUT /settings/platform-config) ─────────────
export type PlatformConfig = Record<string, unknown>;
export function usePlatformConfig() {
  return useQuery({ queryKey: ["admin", "platform-config"], queryFn: () => api<PlatformConfig>("/settings/platform-config").catch((e): PlatformConfig => { if ((e as { status?: number })?.status === 404) return {}; throw e; }), staleTime: 10_000 });
}
/** Changes some keys of the platform settings: reads the latest, changes them, saves the whole object (as the classic page did). */
export async function savePlatformConfig(change: (current: PlatformConfig) => PlatformConfig) {
  const current = await api<PlatformConfig>("/settings/platform-config").catch(e => ((e as { status?: number })?.status === 404 ? {} : Promise.reject(e)));
  const saved = await api<PlatformConfig>("/settings/platform-config", { method: "PUT", body: change(current) });
  queryClient.setQueryData(["admin", "platform-config"], saved);
  return saved;
}

// ───────────── booking catalog (GET /catalog) ─────────────
export interface Catalog {
  districts: string[];
  zonesByDistrict: Record<string, string[]>;
  areasByZone: Record<string, string[]>;
  [key: string]: unknown;
}
export function useCatalog() {
  return useQuery({ queryKey: ["admin", "catalog"], queryFn: () => api<Catalog>("/catalog"), staleTime: 5 * 60_000 });
}
