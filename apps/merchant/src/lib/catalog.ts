/** The service catalog (districts → zones → areas, GET /catalog), reloaded when super admin changes geography. */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@panel/lib/api";
import { useLive } from "@panel/lib/events";

export interface Catalog {
  districts: string[];
  zonesByDistrict: Record<string, string[]>;
  areasByZone: Record<string, string[]>;
  [key: string]: unknown;
}

export function useCatalog() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["catalog"], queryFn: () => api<Catalog>("/catalog"), staleTime: 10 * 60_000 });
  useLive(["catalog.updated"], () => void qc.invalidateQueries({ queryKey: ["catalog"] }), { fallbackMs: 30 * 60_000 });
  return q.data;
}
