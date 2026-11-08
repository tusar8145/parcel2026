/**
 * Recipients & branches (merchant-bridge.js customerRows): the people and branches the merchant sends to, grouped
 * by phone from its newest 1,000 requests (as the classic panel kept them), newest first; cancelled pickups and
 * requests without a phone are left out. Cards from GET /merchants/me/stats; search; Export (CSV).
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@panel/lib/api";
import { saveCsv } from "@panel/lib/csv";
import { num, when } from "@panel/lib/format";
import { Button, Metric, PageHeading, Panel, Pill } from "@panel/ui/kit";
import { toast } from "@panel/ui/toast";
import { useMerchant } from "@/lib/merchant";
import { phoneText } from "@/lib/text";
import type { Parcel } from "@/features/parcels/model";
import { Pager } from "@/features/parcels/Pager";

const CAP = 1000;
type Full = Parcel & { deliveredAt?: string | null };

/** The merchant's newest requests, up to 1,000 (GET /parcels, 200 a page). */
export function useRecentParcels() {
  const m = useMerchant();
  return useQuery({
    queryKey: ["m", "parcels", "recent-1000"],
    staleTime: 60_000,
    queryFn: async () => {
      const all: Full[] = [];
      let cursor: string | null = null;
      do {
        const page: { items: Full[]; nextCursor: string | null } = await api(`/parcels?limit=200${m.q("&")}${cursor ? `&cursor=${cursor}` : ""}`);
        all.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor && all.length < CAP);
      return { items: all, truncated: !!cursor };
    },
  });
}

export default function Recipients() {
  const m = useMerchant();
  const parcels = useRecentParcels();
  const stats = useQuery({ queryKey: ["m", "stats", "nav"], queryFn: () => api<{ customers?: { total: number; newThisMonth: number } }>(`/merchants/me/stats?period=7d${m.q("&")}`) });
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(25);
  const groups = useMemo(() => {
    const map = new Map<string, { name: string; phone: string; count: number; last: string; lastDelivered: string | null; branch: string }>();
    for (const p of parcels.data?.items ?? []) {
      if (p.status === "PICKUP_CANCELLED" || !p.recipient?.phone) continue;
      const g = map.get(p.recipient.phone) || { name: p.recipient.name || "", phone: p.recipient.phone, count: 0, last: p.createdAt, lastDelivered: null, branch: "" };
      g.count++;
      if (p.createdAt > g.last) g.last = p.createdAt;
      if (p.deliveredAt && (!g.lastDelivered || p.deliveredAt > g.lastDelivered)) g.lastDelivered = p.deliveredAt;
      if (!g.branch) g.branch = p.originBranchCode || "";
      map.set(p.recipient.phone, g);
    }
    return [...map.values()].sort((a, b) => (a.last < b.last ? 1 : -1));
  }, [parcels.data]);
  const branches = useMemo(() => new Set((parcels.data?.items ?? []).map(p => p.originBranchCode).filter(Boolean)).size, [parcels.data]);
  const t = search.trim().toLowerCase();
  const shown = t ? groups.filter(g => `${g.name} ${g.phone} ${phoneText(g.phone)} ${g.branch}`.toLowerCase().includes(t)) : groups;
  const pages = Math.max(1, Math.ceil(shown.length / size));
  const rows = shown.slice((page - 1) * size, page * size);
  const columns = ["Recipient / branch", "Phone", "Consignments", "Branch code", "Last delivery", "Status"];
  const values = (g: (typeof groups)[number]) => [g.name, phoneText(g.phone), String(g.count), g.branch || "—", g.lastDelivered ? when(g.lastDelivered) : "Not delivered yet", "Active"];
  const st = stats.data?.customers;

  return (
    <>
      <PageHeading
        eyebrow="Banking & Financial workspace"
        title="Recipients & branches"
        subtitle="Approved receiving parties and corporate branch locations."
        actions={
          <Button
            icon="download"
            onClick={() => {
              if (!shown.length) return toast("There are no recipients to export.");
              saveCsv("recipients-and-branches.csv", [columns, ...shown.map(values)]);
              toast(`${num(shown.length)} recipient${shown.length === 1 ? "" : "s"} exported.`, "good");
            }}
          >
            Export
          </Button>
        }
      />
      <div className="metrics">
        <Metric label="Origin branches" value={parcels.data ? num(branches) : "—"} icon="pin" />
        <Metric label="Active receivers" value={st ? num(st.total) : "—"} icon="users" />
        <Metric label="New this month" value={st ? num(st.newThisMonth) : "—"} icon="plus" />
      </div>
      <Panel
        title="Customers list"
        subtitle={`Live data${parcels.data?.truncated ? ` · from your newest ${num(CAP)} requests` : ""}`}
        tools={<input className="input sm" type="search" placeholder="Search customers..." aria-label="Search recipients" value={search} onChange={e => (setSearch(e.target.value), setPage(1))} style={{ width: 240 }} />}
      >
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                {columns.map(c => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(g => (
                <tr key={g.phone}>
                  <td className="strong">{g.name}</td>
                  <td className="nowrap">{phoneText(g.phone)}</td>
                  <td>{num(g.count)}</td>
                  <td>{g.branch || "—"}</td>
                  <td className="nowrap">{g.lastDelivered ? when(g.lastDelivered) : "Not delivered yet"}</td>
                  <td>
                    <Pill tone="good">Active</Pill>
                  </td>
                </tr>
              ))}
              {!rows.length ? (
                <tr>
                  <td colSpan={6} className="empty-cell">
                    {parcels.isLoading ? "Loading…" : t ? "No recipients match." : "No recipients yet."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <Pager page={page} pages={pages} size={size} total={shown.length} shown={rows.length} noun="recipient" setPage={setPage} setSize={s => (setSize(s), setPage(1))} />
      </Panel>
    </>
  );
}
