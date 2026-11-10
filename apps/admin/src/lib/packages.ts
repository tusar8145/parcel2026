/** Service packages and parcel products (bridge-packages.js): what Service plans & pricing and Products load. */
import { useQuery } from "@tanstack/react-query";
import { api } from "@panel/lib/api";

export type Segment = "CUSTOMER" | "ECOMMERCE" | "BANKING_FINANCIAL";
export const SEGMENTS: [Segment, string][] = [
  ["CUSTOMER", "Customer"],
  ["ECOMMERCE", "E-commerce"],
  ["BANKING_FINANCIAL", "Banking & Financial"],
];
export const segLabel = (code: string) => SEGMENTS.find(([c]) => c === code)?.[1] ?? code;
export const PENDING = "Sent for approval: another super admin has to approve it (Admin users & roles → Approvals). Nothing changes until then.";

export interface ServiceCatalog {
  services: { code: string; label: string; group: string; segments: string[]; core?: boolean; hint?: string }[];
  groups: { code: string; label: string }[];
  priceFields: { key: string; label: string; group: string; segments: string[]; unit?: string; sign?: string; signed?: boolean }[];
  defaults: Record<string, number>;
  labels: { speed: Record<string, string>; firstMile: Record<string, string>; lastMile: Record<string, string> };
  productTypes: { code: string; label: string }[];
}
export interface PackageVersion {
  version: number;
  effectiveFrom: string;
  services: string[];
  prices: Record<string, number>;
}
export interface Package {
  id: string;
  segment: Segment;
  name: string;
  description?: string | null;
  status: "ACTIVE" | "ARCHIVED";
  isDefault: boolean;
  merchants?: number;
  current?: PackageVersion | null;
  versions?: PackageVersion[];
  scheduled?: PackageVersion[];
}
export interface Assignment {
  merchant: { id: string; code: string; name: string; status: string };
  package?: { id: string; name: string; isDefault?: boolean } | null;
  scheduled: { package?: { name: string } | null; effectiveFrom: string }[];
}
export interface Product {
  id: string;
  segment: "ECOMMERCE" | "BANKING_FINANCIAL";
  name: string;
  type: string;
  active: boolean;
  parcels: number;
  categoryId: string | null;
  categoryName: string | null;
}
/** A product category (its channels decide where its parcels' messages go). */
export interface Category {
  id: string;
  segment: "ECOMMERCE" | "BANKING_FINANCIAL";
  name: string;
  sortOrder: number;
  active: boolean;
  notifySms: boolean;
  notifyEmail: boolean;
  notifyPush: boolean;
  products: number;
  parcels: number;
}
/** A priority tag (no charge). */
export interface Priority {
  id: string;
  segment: "ECOMMERCE" | "BANKING_FINANCIAL";
  name: string;
  isDefault: boolean;
  sortOrder: number;
  active: boolean;
  parcels: number;
}
/** A delivery type (its + charge is set per package version). */
export interface DeliveryType {
  id: string;
  code: string;
  name: string;
  segments: Segment[];
  slaLevel: "REGULAR" | "SAME_DAY" | "EXPRESS";
  sortOrder: number;
  active: boolean;
  parcels: number;
}

export const useServiceCatalog = () => useQuery({ queryKey: ["admin", "service-catalog"], queryFn: () => api<ServiceCatalog>("/service-catalog"), staleTime: 10 * 60_000 });
export const usePackages = () => useQuery({ queryKey: ["admin", "packages"], queryFn: () => api<Package[]>("/packages") });
export const useAssignments = () =>
  useQuery({
    queryKey: ["admin", "package-assignments"],
    queryFn: async () => {
      const [ECOMMERCE, BANKING_FINANCIAL] = await Promise.all([api<Assignment[]>("/packages/assignments?segment=ECOMMERCE"), api<Assignment[]>("/packages/assignments?segment=BANKING_FINANCIAL")]);
      return { ECOMMERCE, BANKING_FINANCIAL } as Record<string, Assignment[]>;
    },
  });
export const useCategories = () => useQuery({ queryKey: ["admin", "product-categories"], queryFn: () => api<Category[]>("/product-categories?includeInactive=true") });
export const usePriorities = () => useQuery({ queryKey: ["admin", "parcel-priorities"], queryFn: () => api<Priority[]>("/parcel-priorities?includeInactive=true") });
export const useDeliveryTypes = () => useQuery({ queryKey: ["admin", "delivery-types"], queryFn: () => api<DeliveryType[]>("/delivery-types?includeInactive=true") });
export const useProducts = () => useQuery({ queryKey: ["admin", "parcel-products"], queryFn: () => api<Product[]>("/parcel-products?includeInactive=true") });
export const fmtDate = (d?: string | null) => (d ? new Date(d).toLocaleString("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
export const money = (n: unknown) => `৳${Number(n ?? 0).toLocaleString("en-BD")}`;
