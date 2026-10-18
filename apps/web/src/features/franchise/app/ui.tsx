"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

/** The browser client (public/legacy/shared/api.js). */
interface DFClient {
  api<T = any>(path: string, options?: { method?: string; body?: unknown }): Promise<T>;
  describe(error: unknown): string;
  auth: { user: { id: string; name: string; phone: string } | null; logout(): Promise<void> };
  live?: (types: string[], handler: () => unknown, opts?: { debounceMs?: number; fallbackMs?: number }) => void;
  confirm?: (o: { title: string; message?: string; confirm?: string; danger?: boolean }) => Promise<boolean>;
}
declare global {
  interface Window {
    DFPrint?: { open(path: string, opts?: { title?: string }): Promise<void> };
  }
}
export const df = () => (window as unknown as { DF: DFClient }).DF;
export const api = <T = any,>(path: string, options?: { method?: string; body?: unknown }) => df().api<T>(path, options);
export const describe = (error: unknown) => df().describe(error);
export const errorCode = (error: unknown) => (error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "");

export const tk = (n: number | null | undefined) => `৳${(Math.round(Number(n ?? 0) * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
export const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "—";
export const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");

// ───────────── toast ─────────────

type Toast = { text: string; bad?: boolean } | null;
const ToastContext = createContext<(text: string, bad?: boolean) => void>(() => undefined);
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<Toast>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((text: string, bad?: boolean) => {
    setToast({ text, bad });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 4200);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast ? (
        <div className={`fr-toast${toast.bad ? " bad" : ""}`} role="status" id="frToast">
          {toast.text}
        </div>
      ) : null}
    </ToastContext.Provider>
  );
}

// ───────────── data ─────────────

/** Loads `path`; `reload()` re-reads it; live events (DF.live) refresh it too. */
export function useApi<T>(path: string | null, liveTypes: string[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    if (!path) return;
    const mine = ++seq.current;
    setLoading(true);
    try {
      const value = await api<T>(path);
      if (mine === seq.current) {
        setData(value);
        setError("");
      }
    } catch (e) {
      if (mine === seq.current) setError(describe(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const live = liveTypes.join(",");
  useEffect(() => {
    if (!live) return;
    let active = true;
    df().live?.(live.split(","), () => active && reload(), { debounceMs: 400, fallbackMs: 60_000 });
    return () => {
      active = false;
    };
  }, [live, reload]);
  return { data, error, loading, reload, setData };
}

/** Runs an action with a busy flag and a toast for errors. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState("");
  const run = useCallback(
    async <T,>(key: string, work: () => Promise<T>, success?: string | ((value: T) => string)) => {
      setBusy(key);
      try {
        const value = await work();
        if (success) toast(typeof success === "function" ? success(value) : success);
        return value;
      } catch (e) {
        toast(describe(e), true);
        return undefined;
      } finally {
        setBusy("");
      }
    },
    [toast],
  );
  return { busy, run };
}

// ───────────── pieces ─────────────

export function Pill({ tone = "", children }: { tone?: "" | "green" | "blue" | "amber" | "red"; children: React.ReactNode }) {
  return <span className={`fr-pill${tone ? ` ${tone}` : ""}`}>{children}</span>;
}

export function Metric({ label, value, foot, tone }: { label: string; value: string; foot?: string; tone?: "accent" | "warn" }) {
  return (
    <div className={`fr-metric${tone ? ` ${tone}` : ""}`}>
      <small>{label}</small>
      <strong>{value}</strong>
      {foot ? <span>{foot}</span> : null}
    </div>
  );
}

export function Field({ label, htmlFor, error, full, children }: { label: string; htmlFor: string; error?: string; full?: boolean; children: React.ReactNode }) {
  return (
    <div className={`fr-field${full ? " full" : ""}`}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? <span className="error" id={`${htmlFor}-error`}>{error}</span> : null}
    </div>
  );
}

export function Dialog({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fr-dialog-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <section className="fr-dialog" role="dialog" aria-modal="true" aria-labelledby="frDialogTitle">
        <h2 id="frDialogTitle">{title}</h2>
        {subtitle ? <p>{subtitle}</p> : null}
        {children}
      </section>
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="fr-empty">{children}</div>;
}

export const STATUS_TONE: Record<string, "" | "green" | "blue" | "amber" | "red"> = {
  DELIVERED: "green",
  RETURNED: "green",
  AT_HUB: "blue",
  IN_TRANSIT: "blue",
  OUT_FOR_DELIVERY: "amber",
  ASSIGNED: "amber",
  PICKUP_ASSIGNED: "amber",
  PENDING_CONFIRMATION: "",
  EXCEPTION: "red",
  RETRY_SCHEDULED: "red",
  RETURN_SCHEDULED: "amber",
};

export interface Me {
  id: string;
  code: string;
  name: string;
  status: string;
  contactName: string;
  contactPhone: string;
  hub: { id: string; code: string; name: string; district: string; zone: string | null; address: string; active: boolean };
  rates: { pickupPercent: number; pickupMin: number; deliveryPercent: number; deliveryMin: number; returnPercent: number; returnMin: number };
  riderRates: { pickup: number; delivery: number; return: number };
  settlementMode: "DEDUCT" | "BILL";
  billingPeriodDays: number;
  depositHubs: { id: string; code: string; name: string; district: string }[];
  sendHubs: { id: string; code: string; name: string; district: string; type: string }[];
}

export interface Rider {
  id: string;
  code: string;
  name: string;
  phone: string;
  vehicle: string;
  zone: string | null;
  status: string;
  active: boolean;
  lastLoginAt: string | null;
  unpaid: number;
  cashWithRider: number;
  outForDelivery: number;
}

export interface ParcelItem {
  trackingId: string;
  status: string;
  statusLabel: string;
  sender: string;
  merchant: { id: string; name: string } | null;
  recipient: string;
  recipientPhone: string;
  destination: string;
  codAmount: number;
  deliveryCharge: number;
  returnReason: string | null;
  onReturnRun: boolean;
  hub: string | null;
  pickupRider: { id: string; label: string } | null;
  deliveryRider: { id: string; label: string } | null;
  updatedAt: string;
}

export const commissionText = (percent: number, min: number) => `${percent}%${min ? ` (min ${tk(min)})` : ""}`;
