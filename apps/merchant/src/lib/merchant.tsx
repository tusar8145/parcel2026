/**
 * The merchant workspace (shared/merchant-bridge.js resolveMerchant / boot):
 *   - GET /merchants/me (?merchantId= the workspace chosen before, kept for the browser session). Members of several
 *     merchants get MERCHANT_REQUIRED with their ids: each is loaded and the Banking & Financial one is opened.
 *   - Another type of merchant is sent to its own panel; an account that isn't active only gets "Account verification".
 *   - Every /merchants/me/* and /parcels call carries ?merchantId= (q()), as the classic panel's did.
 *   - Live: merchant.updated (suspended → verification screen), parcel events refresh the lists and counts.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError, describe } from "@panel/lib/api";
import { useLive } from "@panel/lib/events";

/** This panel's merchant type and its words (banking-merchant/bridge.js). */
export const PANEL = {
  type: "BANKING_FINANCIAL" as const,
  typeLabel: "Banking & Financial merchant",
  ownerLabel: "Corporate owner",
  staffLabel: "Operations staff",
};
/** Who may open the panel: PANEL_ROLES["banking-merchant"] in shared/api.js. */
export const MERCHANT_ROLES = ["MERCHANT_OWNER", "MERCHANT_STAFF", "SUPER_ADMIN"];
const WORKSPACE_KEY = "deliveryfast-merchant-workspace";

export interface Merchant {
  id: string;
  code: string;
  name: string;
  type: "ECOMMERCE" | "BANKING_FINANCIAL";
  status: string;
  myRole?: "MERCHANT_OWNER" | "MERCHANT_STAFF" | string;
  kyc?: { status?: string; rejectionReason?: string | null; submittedAt?: string | null; reviewedAt?: string | null } | null;
  [key: string]: unknown;
}

type State = { status: "loading" } | { status: "error"; message: string } | { status: "none" } | { status: "ready"; merchant: Merchant; workspaces: Merchant[] };

interface MerchantApi {
  merchant: Merchant;
  workspaces: Merchant[];
  isOwner: boolean;
  /** Not active (under review, information requested, not approved, suspended): only the verification screen. */
  locked: boolean;
  /** "?merchantId=…" (or "&merchantId=…" with sep "&") for the API calls of this workspace. */
  q: (sep?: "?" | "&") => string;
  reload: () => Promise<void>;
  /** Opens another workspace (a member of several merchants). */
  switchTo: (m: Merchant) => void;
}

const Ctx = createContext<MerchantApi | null>(null);

function wanted(): string | null {
  try {
    return new URLSearchParams(location.search).get("merchant") || sessionStorage.getItem(WORKSPACE_KEY);
  } catch {
    return null;
  }
}

async function resolve(): Promise<{ merchant: Merchant; workspaces: Merchant[] } | null> {
  const id = wanted();
  try {
    const me = await api<Merchant>(`/merchants/me${id ? `?merchantId=${encodeURIComponent(id)}` : ""}`);
    return { merchant: me, workspaces: [me] };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (id && error.status === 403) {
      try {
        sessionStorage.removeItem(WORKSPACE_KEY);
      } catch {
        /* private mode */
      }
      return resolve();
    }
    if (error.code !== "MERCHANT_REQUIRED") {
      if (error.status === 403) return null;
      throw error;
    }
    const ids = ((error.details as { merchantIds?: string[] } | undefined)?.merchantIds ?? []).filter(Boolean);
    const all = (await Promise.all(ids.map(m => api<Merchant>(`/merchants/me?merchantId=${m}`).catch(() => null)))).filter(Boolean) as Merchant[];
    const merchant = all.find(m => m.type === PANEL.type) || all[0];
    return merchant ? { merchant, workspaces: all } : null;
  }
}

/** The classic panel of a merchant type (the e-commerce panel isn't rebuilt yet). */
export const panelOf = (type: string) => (type === PANEL.type ? "/merchant/" : "/ecommerce-merchant");

export function MerchantProvider({ children, fallback }: { children: ReactNode; fallback: (state: Exclude<State, { status: "ready" }>) => ReactNode }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const qc = useQueryClient();

  const load = useCallback(async () => {
    try {
      const found = await resolve();
      if (!found) return setState({ status: "none" });
      if (found.merchant.type !== PANEL.type) {
        location.replace(panelOf(found.merchant.type));
        return; // stay on "loading" while the other panel opens
      }
      setState({ status: "ready", ...found });
    } catch (error) {
      setState({ status: "error", message: describe(error) });
    }
  }, []);
  useEffect(() => void load(), [load]);

  const merchant = state.status === "ready" ? state.merchant : null;
  // The account itself: suspended (or approved) switches between the verification screen and the panel at once.
  useLive(
    ["merchant.updated"],
    async () => {
      if (!merchant) return;
      const fresh = await api<Merchant>(`/merchants/me?merchantId=${merchant.id}`).catch(() => null);
      if (fresh) setState(s => (s.status === "ready" ? { ...s, merchant: fresh } : s));
      void qc.invalidateQueries({ queryKey: ["m"] });
    },
    { enabled: !!merchant, fallbackMs: 300_000 },
  );
  // A changed parcel: every list and count of this panel reloads (debounced).
  useLive(["parcel.created", "parcel.updated"], () => void qc.invalidateQueries({ queryKey: ["m"] }), { enabled: !!merchant, debounceMs: 800 });

  const value = useMemo<MerchantApi | null>(() => {
    if (state.status !== "ready") return null;
    const m = state.merchant;
    return {
      merchant: m,
      workspaces: state.workspaces,
      isOwner: m.myRole === "MERCHANT_OWNER",
      locked: m.status !== "ACTIVE",
      q: (sep = "?") => `${sep}merchantId=${m.id}`,
      reload: async () => {
        const fresh = await api<Merchant>(`/merchants/me?merchantId=${m.id}`);
        setState(s => (s.status === "ready" ? { ...s, merchant: fresh } : s));
      },
      switchTo: other => {
        try {
          sessionStorage.setItem(WORKSPACE_KEY, other.id);
        } catch {
          /* private mode */
        }
        location.href = panelOf(other.type);
      },
    };
  }, [state]);

  if (state.status !== "ready" || !value) return <>{fallback(state as Exclude<State, { status: "ready" }>)}</>;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMerchant() {
  const value = useContext(Ctx);
  if (!value) throw new Error("useMerchant outside MerchantProvider");
  return value;
}
