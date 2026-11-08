/**
 * Who is working and with what: GET /ops/overview `me` (roles, hub scope, `can` flags), the hubs and riders
 * lookups, the stage counts for the scope on screen and the "My hub / All hubs" switch (bridge-lists.js Ops.scope).
 * Live parcel events refresh the counts and every parcel list (debounced), like DF.live in the legacy panel.
 */
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { useAuth } from "./auth";
import { useLive } from "./events";
import type { Hub, OpsCan, OpsMe, OpsOverview, Rider } from "./types";
import { useStored } from "@/ui/kit";
import type { MenuContext } from "@/app/nav";
import { toast } from "@/ui/toast";

export type StageCounts = { stages: Record<string, number>; detail?: Record<string, number>; [key: string]: unknown };

interface OpsApi {
  me: OpsMe | null;
  overview: OpsOverview | undefined;
  hubs: Hub[];
  riders: Rider[];
  stageCounts: StageCounts | undefined;
  can: (permission: keyof OpsCan) => boolean;
  /** Says why an action isn't available before calling the API (Ops.require). */
  require: (permission: keyof OpsCan, action: string) => boolean;
  roleName: string;
  scope: { available: boolean; value: "mine" | "all"; set: (v: "mine" | "all") => void; hubIds: string[] | null; label: string };
  hubById: (id?: string | null) => Hub | undefined;
  myHubs: Hub[] | null;
  menu: MenuContext;
  refreshAll: () => void;
}

const ROLE_LABEL: Record<string, string> = { SUPER_ADMIN: "Super admin", OPS_MANAGER: "Operations manager", HUB_OPERATOR: "Hub operator", FINANCE: "Finance", SUPPORT_AGENT: "Support agent" };
const OpsContext = createContext<OpsApi | null>(null);

export function OpsProvider({ children }: { children: ReactNode }) {
  const { user, hasRole } = useAuth();
  const qc = useQueryClient();
  const [scopeValue, setScope] = useStored<"mine" | "all">("deliveryfast-ops-scope", "mine");

  const overview = useQuery({ queryKey: ["ops", "overview"], queryFn: () => api<OpsOverview>("/ops/overview"), staleTime: 15_000 });
  const me = overview.data?.me ?? null;
  const hubs = useQuery({ queryKey: ["hubs"], queryFn: () => api<Hub[]>("/hubs"), staleTime: 5 * 60_000 });
  const canListRiders = hasRole("SUPER_ADMIN", "OPS_MANAGER", "HUB_OPERATOR", "SUPPORT_AGENT");
  const riders = useQuery({ queryKey: ["riders", "active"], queryFn: () => api<Rider[]>("/riders?active=true"), enabled: canListRiders, staleTime: 60_000 });
  const accountsConfig = useQuery({
    queryKey: ["accounts", "config"],
    queryFn: () => api<{ centralHub?: { id: string } | null }>("/accounts/config"),
    enabled: !!me?.can.receiveCash || !!me?.can.financeStaff,
    staleTime: 120_000,
    retry: false,
  });

  const scopeAvailable = !!me?.hubIds?.length;
  const scopeHubIds = scopeAvailable && scopeValue !== "all" ? me!.hubIds : null;
  const stageCounts = useQuery({
    queryKey: ["ops", "stage-counts", scopeHubIds?.join(",") ?? "all"],
    queryFn: () => api<StageCounts>(`/ops/stage-counts${scopeHubIds ? `?forHubIds=${scopeHubIds.join(",")}` : ""}`),
    enabled: !!me,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });

  const refreshAll = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["ops"] });
    void qc.invalidateQueries({ queryKey: ["parcels"] });
    void qc.invalidateQueries({ queryKey: ["parcel"] });
  }, [qc]);
  // A changed parcel: the counts, the lists and the open drawer reload (debounced; the safety poll catches missed events).
  useLive(["parcel.created", "parcel.updated"], refreshAll, { debounceMs: 600 });
  useLive(["catalog.updated", "hub.updated"], () => void qc.invalidateQueries({ queryKey: ["hubs"] }), { fallbackMs: 600_000 });
  useLive(["rider.updated"], () => void qc.invalidateQueries({ queryKey: ["riders"] }), { fallbackMs: 300_000 });

  const value = useMemo<OpsApi>(() => {
    const roleName = ROLE_LABEL[user?.roles.find(r => ROLE_LABEL[r]) ?? ""] || "Your role";
    const can = (p: keyof OpsCan) => !!me?.can?.[p];
    const hubList = hubs.data ?? [];
    const myHubs = me?.hubIds ? hubList.filter(h => me.hubIds!.includes(h.id)) : null;
    return {
      me,
      overview: overview.data,
      hubs: hubList,
      riders: riders.data ?? [],
      stageCounts: stageCounts.data,
      can,
      require: (p, action) => {
        if (!me || can(p)) return true;
        toast(`${roleName} accounts can't ${action}.`, "bad");
        return false;
      },
      roleName,
      scope: { available: scopeAvailable, value: scopeValue, set: setScope, hubIds: scopeHubIds, label: me?.hubIds?.length === 1 ? "My hub" : "My hubs" },
      hubById: id => hubList.find(h => h.id === id),
      myHubs,
      menu: { roles: new Set(user?.roles ?? []), me, centralHubId: accountsConfig.data?.centralHub?.id ?? null },
      refreshAll,
    };
  }, [me, overview.data, hubs.data, riders.data, stageCounts.data, user, scopeAvailable, scopeValue, setScope, scopeHubIds, accountsConfig.data, refreshAll]);

  return <OpsContext.Provider value={value}>{children}</OpsContext.Provider>;
}

export function useOps() {
  const value = useContext(OpsContext);
  if (!value) throw new Error("useOps outside OpsProvider");
  return value;
}
