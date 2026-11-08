/**
 * A server-paged parcel list (bridge-lists.js): GET /parcels with the list's fixed query (stage, line…), its search
 * and filters, numbered pages (rows per page 50 / 100 / 200) or a short feed, the "My hub / All hubs" scope, ticked
 * rows, printing (ticked rows, else every parcel the filters match, up to the PDF limit) and Excel export.
 * Filters are kept per list while the panel is open (switching tabs keeps them).
 */
import { useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api, apiRaw } from "@/lib/api";
import { dayKey, num } from "@/lib/format";
import { useOps } from "@/lib/ops";
import { toast } from "@/ui/toast";
import type { Parcel } from "./model";

export interface ListFilters {
  q?: string;
  status?: string;
  from?: string;
  to?: string;
  dateField?: "pickup" | "status";
  line?: string;
  merchantId?: string;
  hubId?: string;
  failedBefore?: string;
}

export interface ListConfig {
  /** Remembers this list's filters and page while the panel is open. */
  id: string;
  /** Fixed query: { stage }, { line }, { status }, { incomplete }. */
  params?: Record<string, string | undefined>;
  /** Rows per page (feeds: the number shown). */
  limit?: number;
  /** false: a short feed without paging (Today). */
  paged?: boolean;
  /** All parcels: the last month by default, a Date field, every status, Excel export. */
  register?: boolean;
  /** false: ignore the "My hub" scope. */
  scoped?: boolean;
  noun?: string;
  empty?: string;
}

interface Answer {
  items: Parcel[];
  nextCursor: string | null;
  total?: number;
  pages?: number;
}

const remembered = new Map<string, { filters: ListFilters; page: number; size: number }>();

/** The last calendar month up to today ("2026-10-05" to "2026-11-05"). */
function lastMonth() {
  const to = new Date();
  const from = new Date(to.getFullYear(), to.getMonth() - 1, 1);
  from.setDate(Math.min(to.getDate(), new Date(from.getFullYear(), from.getMonth() + 1, 0).getDate()));
  return { from: dayKey(from), to: dayKey(to) };
}

export function useParcelList(cfg: ListConfig) {
  const ops = useOps();
  const start = remembered.get(cfg.id);
  const [filters, setFiltersState] = useState<ListFilters>(start?.filters ?? (cfg.register ? { ...lastMonth(), dateField: "pickup" } : {}));
  const [page, setPageState] = useState(start?.page ?? 1);
  const [size, setSizeState] = useState(start?.size ?? cfg.limit ?? 100);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const paged = cfg.paged !== false;
  const remember = (f = filters, p = page, s = size) => remembered.set(cfg.id, { filters: f, page: p, size: s });

  const scopeHubs = cfg.scoped === false ? null : ops.scope.hubIds;
  const fixedKey = JSON.stringify(cfg.params ?? {});
  /** The query for GET /parcels without paging (also the export's and the print's). */
  const base = useMemo(() => {
    const params = new URLSearchParams();
    const fixed = cfg.params ?? {};
    for (const [k, v] of Object.entries(fixed)) if (v != null && v !== "") params.set(k, String(v));
    const f = filters;
    if (f.q && f.q.trim().length >= 2) params.set("q", f.q.trim());
    if (f.status === "Needs info") params.set("incomplete", "true");
    else if (f.status) params.set("status", f.status);
    if (f.from) params.set("from", new Date(`${f.from}T00:00:00`).toISOString());
    if (f.to) params.set("to", new Date(`${f.to}T23:59:59.999`).toISOString());
    if (f.dateField === "status" && (f.from || f.to)) params.set("dateField", "status");
    if (f.line && !fixed.line) params.set("line", f.line);
    if (f.merchantId) params.set("merchantId", f.merchantId);
    if (f.hubId) params.set("hubId", f.hubId);
    if (f.failedBefore) params.set("failedBefore", f.failedBefore);
    if (scopeHubs && !f.hubId) params.set("forHubIds", scopeHubs.join(","));
    return params;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixedKey, filters, scopeHubs?.join(",")]);

  const pageQuery = new URLSearchParams(base);
  pageQuery.set("limit", String(size));
  if (paged) pageQuery.set("page", String(page));
  const key = pageQuery.toString();

  const q = useQuery({
    queryKey: ["parcels", "list", cfg.id, key],
    queryFn: async () => {
      const answer = await api<Answer>(`/parcels?${key}`);
      // The page emptied (its parcels left the filters): the last page that still has rows.
      if (paged && !answer.items.length && (answer.total ?? 0) > 0 && answer.pages && answer.pages < page) {
        setPageState(answer.pages);
        remember(filters, answer.pages);
      }
      return answer;
    },
    enabled: !!ops.me,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
  const rows = q.data?.items ?? [];
  const total = q.data?.total ?? rows.length;
  const pages = Math.max(1, q.data?.pages ?? 1);

  function setFilters(patch: Partial<ListFilters>) {
    const next = { ...filters, ...patch };
    if (patch.from !== undefined || patch.to !== undefined) {
      if (next.from && next.to && next.from > next.to) return toast("The From date can't be after the To date.", "bad");
    }
    // A merchant of another type (or any merchant, for customer parcels) no longer applies.
    if (patch.line !== undefined && next.merchantId && patch.line === "CUSTOMER") next.merchantId = "";
    setFiltersState(next);
    setPageState(1);
    setTicked(new Set());
    remember(next, 1);
  }
  const setPage = (p: number) => {
    setPageState(p);
    remember(filters, p);
  };
  const setSize = (s: number) => {
    setSizeState(s);
    setPageState(1);
    remember(filters, 1, s);
  };
  const filtered = Object.values(filters).some(Boolean);

  /** Every tracking ID the filters match (up to `cap`), paging through GET /parcels. */
  async function matchingIds(cap: number) {
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams(base);
      params.set("limit", "200");
      if (cursor) params.set("cursor", cursor);
      const answer: Answer = await api<Answer>(`/parcels?${params}`);
      ids.push(...answer.items.map(p => p.trackingId));
      cursor = answer.nextCursor;
    } while (cursor && ids.length < cap);
    return { ids: [...new Set(ids)].slice(0, cap), capped: ids.length > cap || !!cursor };
  }

  /** What a print button prints: the ticked rows, else every parcel the filters match (up to `cap`). */
  async function printIds(cap: number) {
    if (ticked.size) return { ids: [...ticked], capped: ticked.size > cap };
    if (total <= rows.length) return { ids: rows.map(r => r.trackingId).slice(0, cap), capped: rows.length > cap };
    return matchingIds(cap);
  }

  /** The filtered parcels (or the ticked rows) as Excel, written by the server (every page). */
  async function exportExcel() {
    if (!ticked.size && !rows.length) return toast("There are no parcels to export. Change the dates or filters.");
    const params = new URLSearchParams(base);
    if (ticked.size) params.set("trackingIds", [...ticked].join(","));
    const response = await apiRaw(`/parcels/export?${params}`);
    const name = /filename="?([^";]+)"?/.exec(response.headers.get("content-disposition") || "")?.[1] || "parcels.xlsx";
    const url = URL.createObjectURL(await response.blob());
    const link = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    const count = Number(response.headers.get("x-row-count"));
    const matched = Number(response.headers.get("x-matched"));
    toast(count < matched ? `Exported the newest ${num(count)} of ${num(matched)} parcels (the limit for one file). Use a shorter date range for the rest.` : `${num(count)} parcel${count === 1 ? "" : "s"} exported to Excel.`, "good");
  }

  return {
    cfg,
    rows,
    total,
    pages,
    page,
    size,
    paged,
    loading: q.isLoading,
    fetching: q.isFetching,
    error: q.error,
    filters,
    filtered,
    setFilters,
    setPage,
    setSize,
    ticked,
    setTicked,
    toggle: (id: string) =>
      setTicked(t => {
        const n = new Set(t);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      }),
    tickedParcels: () => rows.filter(r => ticked.has(r.trackingId)),
    clearTicked: () => setTicked(new Set()),
    printIds,
    exportExcel,
    refetch: q.refetch,
    /** The query for bulk updates (filters as the server reads them). */
    query: base,
  };
}

export type ParcelListState = ReturnType<typeof useParcelList>;
