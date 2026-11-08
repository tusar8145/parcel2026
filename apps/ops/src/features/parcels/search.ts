import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "@panel/lib/api";
import { useLive } from "@panel/lib/events";
import { queryClient } from "@panel/lib/queryClient";
import type { Parcel } from "./model";

/** Scanner input → a tracking ID / CN (trims, upper-cases, drops a tracking URL's path). */
export function normalizeCode(raw: string) {
  let code = String(raw || "").trim();
  const fromUrl = /\/(?:track|t)\/([A-Za-z0-9-]+)/.exec(code);
  if (fromUrl) code = fromUrl[1];
  return code.replace(/\s+/g, "").toUpperCase();
}

/** Tracking ID, CN or phone → matching parcels (top-bar search, Hub desk "Find"). */
export async function findParcels(raw: string): Promise<Parcel[]> {
  const code = normalizeCode(raw);
  if (/^[A-Z0-9-]{4,}$/.test(code) && !/^\d+$/.test(code)) {
    try {
      const parcel = await api<Parcel>(`/parcels/${encodeURIComponent(code)}`);
      queryClient.setQueryData(["parcel", parcel.trackingId], parcel);
      return [parcel];
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
    }
  }
  const page = await api<{ items: Parcel[] }>(`/parcels?limit=20&q=${encodeURIComponent(raw.trim())}`);
  return page.items;
}

export interface Catalog {
  districts: string[];
  zonesByDistrict: Record<string, string[]>;
  areasByZone: Record<string, string[]>;
  [key: string]: unknown;
}

/** The service catalog (districts → zones → areas), reloaded when super admin changes it. */
export function useCatalog() {
  const q = useQuery({ queryKey: ["catalog"], queryFn: () => api<Catalog>("/catalog", { auth: false }), staleTime: 10 * 60_000 });
  useLive(["catalog.updated"], () => void q.refetch(), { fallbackMs: 30 * 60_000 });
  return q.data;
}
