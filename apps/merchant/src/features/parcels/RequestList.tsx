/**
 * New requests and All requests (shared/merchant-orders.js): server-paged GET /parcels (this merchant), filters,
 * rows per page, tick rows, Export (GET /merchants/me/parcels/export: every matching request or the ticked rows),
 * Print (the ticked rows, else every matching request, up to the PDF limit). Row actions as in the classic panel:
 * Details / Tracking history (the parcel drawer), Complete (Needs info), Cancel, Confirm return received, Label.
 *
 *   New requests   booked and not yet collected or brought in (stage=not_picked_up)
 *   All requests   every request, the last month unless other dates are chosen
 */
import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { api, apiRaw, describe } from "@panel/lib/api";
import { dayKey, localPhone, money, num, when } from "@panel/lib/format";
import { printFormat } from "@panel/lib/print";
import { Button, Pill, useDebounced } from "@panel/ui/kit";
import { Select } from "@panel/ui/Select";
import { SearchSelect } from "@panel/ui/SearchSelect";
import { toast } from "@panel/ui/toast";
import { useMerchant } from "@/lib/merchant";
import { cancelParcel, confirmReturnReceived } from "./actions";
import { completeDetails } from "./complete";
import { destination, documentOf, EDITABLE_INCOMPLETE, NEEDS_INFO, splitContents, STATUSES, type Parcel } from "./model";

const PAGE_SIZES = [25, 50, 100];
const PRINT_CAP = 1000;
/** The print formats of each merchant type (merchant-orders.js printOptions). */
export const printOptions = (doc: boolean) =>
  doc
    ? [
        { value: "invoice", label: "Invoices · A4" },
        { value: "invoice-4", label: "4 invoices · A4" },
        { value: "invoice-8", label: "8 invoices · A4" },
        { value: "label", label: "Shipment labels" },
        { value: "orders", label: "Consignment list" },
      ]
    : [
        { value: "invoice", label: "Invoices · A4" },
        { value: "invoice-4", label: "4 invoices · A4" },
        { value: "invoice-8", label: "8 invoices · A4" },
        { value: "pos", label: "Invoice · POS 80mm" },
        { value: "label", label: "Shipment labels" },
        { value: "orders", label: "Order list" },
      ];
const TYPE_LABEL: Record<string, string> = { ECOMMERCE: "E-commerce parcel", DOCUMENT: "Document delivery", PARCEL: "Domestic parcel", FRAGILE: "Fragile parcel" };

export type ListKind = "new" | "all";
interface Filters {
  q: string;
  status: string;
  dateField: "pickup" | "status";
  from: string;
  to: string;
  contents: string;
  payment: string;
  district: string;
  branch: string;
}

/** The last calendar month up to today (31 March → 28 February). */
function lastMonth() {
  const to = new Date();
  const from = new Date(to.getFullYear(), to.getMonth() - 1, 1);
  from.setDate(Math.min(to.getDate(), new Date(from.getFullYear(), from.getMonth() + 1, 0).getDate()));
  return { from: dayKey(from), to: dayKey(to) };
}
const defaults = (kind: ListKind): Filters => ({ q: "", status: "", dateField: "pickup", from: "", to: "", contents: "", payment: "", district: "", branch: "", ...(kind === "all" ? lastMonth() : {}) });
/** Kept while the panel is open: filters and page come back when the page is opened again. */
const kept = new Map<ListKind, { filters: Filters; page: number; size: number }>();

function query(kind: ListKind, f: Filters) {
  const params = new URLSearchParams();
  if (kind === "new") params.set("stage", "not_picked_up");
  if (f.q.trim().length >= 2) params.set("q", f.q.trim());
  if (f.status === NEEDS_INFO) params.set("incomplete", "true");
  else if (f.status) params.set("status", f.status);
  if (f.from) params.set("from", new Date(`${f.from}T00:00:00`).toISOString());
  if (f.to) params.set("to", new Date(`${f.to}T23:59:59.999`).toISOString());
  if (f.dateField === "status" && (f.from || f.to)) params.set("dateField", "status");
  for (const key of ["contents", "payment", "district", "branch"] as const) if (f[key]) params.set(key, f[key]);
  return params;
}

interface Answer {
  items: Parcel[];
  total: number;
  pages: number;
}

export function RequestList({ kind }: { kind: ListKind }) {
  const m = useMerchant();
  const [, setParams] = useSearchParams();
  const start = kept.get(kind);
  const [filters, setFiltersState] = useState<Filters>(start?.filters ?? defaults(kind));
  const [page, setPage] = useState(start?.page ?? 1);
  const [size, setSize] = useState(start?.size ?? 25);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState(filters.q);
  const debounced = useDebounced(search, 350);
  useEffect(() => void kept.set(kind, { filters, page, size }), [kind, filters, page, size]);
  useEffect(() => {
    if (debounced !== filters.q) setFilters({ q: debounced });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const base = useMemo(() => query(kind, filters), [kind, filters]);
  const key = `${base}&limit=${size}&page=${page}`;
  const list = useQuery({
    queryKey: ["m", "parcels", kind, key],
    queryFn: async () => {
      const answer = await api<Answer>(`/parcels?${key}${m.q("&")}`);
      // The page emptied (its requests left the filters): the last page that still has rows.
      if (!answer.items.length && answer.total > 0 && answer.pages < page) setPage(answer.pages);
      return answer;
    },
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
  /** The filters' choices: from the newest requests (the classic panel used the ones it kept in the browser). */
  const recent = useQuery({ queryKey: ["m", "parcels", "choices"], queryFn: () => api<{ items: Parcel[] }>(`/parcels?limit=200${m.q("&")}`), staleTime: 300_000 });
  const rows = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, list.data?.pages ?? 1);

  function setFilters(patch: Partial<Filters>) {
    const next = { ...filters, ...patch };
    if ((patch.from !== undefined || patch.to !== undefined) && next.from && next.to && next.from > next.to) return toast("The From date can't be after the To date.", "bad");
    setFiltersState(next);
    setPage(1);
    setTicked(new Set());
  }
  const base0 = defaults(kind);
  const filtered = (Object.keys(base0) as (keyof Filters)[]).some(k => filters[k] !== base0[k]);
  const choices = useMemo(() => {
    const pool = [...(recent.data?.items ?? []), ...rows];
    const unique = (values: (string | null | undefined)[]) => [...new Set(values.filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b));
    return { contents: unique(pool.map(p => (m.doc ? documentOf(p) : p.contents))), branch: unique(pool.map(p => p.originBranchCode)), district: unique(pool.map(p => p.delivery?.district)), needs: pool.filter(p => p.incomplete).length };
  }, [recent.data, rows]);

  const noun = m.doc ? "request" : "order";
  const allTicked = rows.length > 0 && rows.every(r => ticked.has(r.trackingId));
  const toggle = (id: string) => setTicked(s => (s.has(id) ? (s.delete(id), new Set(s)) : new Set(s.add(id))));

  async function printIds() {
    if (ticked.size) return [...ticked];
    const ids: string[] = [];
    for (let no = 1; ids.length < PRINT_CAP; no++) {
      const params = new URLSearchParams(base);
      params.set("limit", "200");
      params.set("page", String(no));
      const answer = await api<Answer>(`/parcels?${params}${m.q("&")}`);
      ids.push(...answer.items.map(p => p.trackingId));
      if (no >= answer.pages) break;
    }
    return ids.slice(0, PRINT_CAP);
  }
  const [format, setFormat] = useState("invoice");
  async function print() {
    const ids = await printIds();
    if (!ids.length) return toast(`There are no ${noun}s to print. Change the filters.`);
    await printFormat(format, ids, m.doc ? "Consignment list" : "Order list");
  }
  async function exportList() {
    if (!ticked.size && !total) return toast(`There are no ${noun}s to export. Change the dates or filters.`);
    const params = new URLSearchParams(base);
    if (ticked.size) params.set("trackingIds", [...ticked].join(","));
    try {
      const response = await apiRaw(`/merchants/me/parcels/export?${params}${m.q("&")}`);
      const name = /filename="?([^";]+)"?/.exec(response.headers.get("content-disposition") || "")?.[1] || "orders.xlsx";
      const url = URL.createObjectURL(await response.blob());
      const link = Object.assign(document.createElement("a"), { href: url, download: name });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      const count = Number(response.headers.get("x-row-count"));
      const matched = Number(response.headers.get("x-matched"));
      toast(count < matched ? `Exported the newest ${num(count)} of ${num(matched)} (the limit for one file). Use a shorter date range for the rest.` : `${num(count)} ${noun}${count === 1 ? "" : "s"} exported to Excel.`, "good");
    } catch (error) {
      toast(describe(error), "bad");
    }
  }

  const statusOptions = [...STATUSES[kind].map(s => ({ value: s, label: s })), { value: NEEDS_INFO, label: `Needs info${choices.needs ? ` (${choices.needs})` : ""}` }];
  const first = (page - 1) * size + 1;
  const near = [...new Set([1, page - 1, page, page + 1, pages])].filter(p => p >= 1 && p <= pages).sort((a, b) => a - b);
  const title = kind === "new" ? (m.doc ? "New requests" : "New orders") : m.doc ? "All requests" : "All orders";
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <div className="panel-title">{title} list</div>
          <div className="panel-subtitle">{kind === "all" ? "Newest first · the last month unless you choose other dates · updates live" : "Newest first · updates live"}</div>
        </div>
        <div className="tools">
          <input className="input sm" type="search" placeholder="Search ID, reference, phone, name" aria-label={`Search ${noun}s`} value={search} onChange={e => setSearch(e.target.value)} style={{ width: "min(300px, 100%)" }} />
          <Select className="select sm" searchable={false} icon="print" aria-label={m.doc ? "Document print format" : "Order print format"} value={format} onChange={e => setFormat(e.target.value)} style={{ width: 190 }}>
            {printOptions(m.doc).map(o => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <Button size="sm" icon="print" onClick={print} title={ticked.size ? `Print the ${ticked.size} ticked` : `Print every matching ${noun}`}>
            Print
          </Button>
          <Button size="sm" icon="download" onClick={exportList} title={ticked.size ? `Export the ${ticked.size} ticked` : `Export every matching ${noun}`}>
            Export
          </Button>
        </div>
      </div>
      <div className="tools filter-row">
        <label className="row" style={{ gap: 6, fontSize: 12.5 }}>
          Date field
          <Select className="select sm" aria-label="Date field" value={filters.dateField} onChange={e => setFilters({ dateField: e.target.value as Filters["dateField"] })}>
            <option value="pickup">Pickup / created date</option>
            <option value="status">Status update date</option>
          </Select>
        </label>
        <label className="row" style={{ gap: 6, fontSize: 12.5 }}>
          From
          <input className="input sm" type="date" aria-label="From date" value={filters.from} onChange={e => setFilters({ from: e.target.value })} style={{ width: 140 }} />
        </label>
        <label className="row" style={{ gap: 6, fontSize: 12.5 }}>
          To
          <input className="input sm" type="date" aria-label="To date" value={filters.to} onChange={e => setFilters({ to: e.target.value })} style={{ width: 140 }} />
        </label>
        <SearchSelect size="sm" label="Status" emptyLabel="All statuses" options={statusOptions} value={filters.status} onChange={v => setFilters({ status: v })} width={190} search={false} />
        <SearchSelect size="sm" label={m.doc ? "Document" : "Product"} emptyLabel={m.doc ? "All documents" : "All products"} options={choices.contents.map(v => ({ value: v, label: v }))} value={filters.contents} onChange={v => setFilters({ contents: v })} width={170} />
        {m.doc ? (
          <SearchSelect size="sm" label="Origin branch" emptyLabel="All branches" options={choices.branch.map(v => ({ value: v, label: v }))} value={filters.branch} onChange={v => setFilters({ branch: v })} width={150} />
        ) : (
          <SearchSelect size="sm" label="Payment" emptyLabel="COD and prepaid" search={false} options={[{ value: "cod", label: "Cash on delivery" }, { value: "prepaid", label: "Prepaid" }]} value={filters.payment} onChange={v => setFilters({ payment: v })} width={170} />
        )}
        <SearchSelect size="sm" label="District" emptyLabel="All districts" options={choices.district.map(v => ({ value: v, label: v }))} value={filters.district} onChange={v => setFilters({ district: v })} width={160} />
        {filtered ? (
          <Button size="sm" onClick={() => (setSearch(""), setFiltersState(defaults(kind)), setPage(1), setTicked(new Set()))}>
            Clear filters
          </Button>
        ) : null}
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="check-cell">
                <input type="checkbox" aria-label="Select visible records" checked={allTicked} onChange={() => setTicked(allTicked ? new Set() : new Set(rows.map(r => r.trackingId)))} />
              </th>
              <th>{m.doc ? "Consignment ID" : "Order ID"}</th>
              <th>{m.doc ? "Recipient" : "Customer"}</th>
              <th>Destination</th>
              <th>{m.doc ? "Document type" : "Item / service"}</th>
              <th>Created</th>
              <th>{m.doc ? "Delivery fee" : "Amount"}</th>
              <th>Status</th>
              <th>History</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(p => (
              <Row key={p.trackingId} doc={m.doc} p={p} ticked={ticked.has(p.trackingId)} onTick={() => toggle(p.trackingId)} onOpen={() => setParams(s => (s.set("parcel", p.trackingId), s))} />
            ))}
            {!rows.length ? (
              <tr>
                <td colSpan={9} className="empty-cell">
                  {list.isLoading ? "Loading…" : list.isError ? describe(list.error) : filtered ? `No ${noun}s match these filters.` : kind === "new" ? `No new ${noun}s. Create one or import a file.` : m.doc ? "No delivery requests yet. Create one with “New delivery request”." : "No orders yet. Create your first order or import a batch."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <div className="panel-foot">
        <span>
          {total ? `Showing ${num(first)}–${num(first + rows.length - 1)} of ${num(total)} ${noun}${total === 1 ? "" : "s"}` : list.isLoading ? "Loading…" : `No matching ${noun}s`}
          {ticked.size ? ` · ${num(ticked.size)} ticked` : ""}
        </span>
        <span className="row" style={{ gap: 6 }}>
          <label className="row" style={{ gap: 6 }}>
            Rows per page
            <Select className="select sm" aria-label="Rows per page" value={size} onChange={e => (setSize(Number(e.target.value)), setPage(1))}>
              {PAGE_SIZES.map(s => (
                <option key={s}>{s}</option>
              ))}
            </Select>
          </label>
          {pages > 1 ? (
            <nav className="pager" aria-label="Pages">
              <button type="button" className="button sm" aria-label="Previous page" disabled={page === 1 || list.isFetching} onClick={() => setPage(page - 1)}>
                ‹
              </button>
              {near.map((n, i) => (
                <span key={n} style={{ display: "contents" }}>
                  {i && n - near[i - 1] > 1 ? <span aria-hidden="true">…</span> : null}
                  <button type="button" className={`button sm ${n === page ? "primary" : ""}`} aria-current={n === page ? "page" : undefined} aria-label={`Page ${n}`} onClick={() => setPage(n)}>
                    {num(n)}
                  </button>
                </span>
              ))}
              <button type="button" className="button sm" aria-label="Next page" disabled={page === pages || list.isFetching} onClick={() => setPage(page + 1)}>
                ›
              </button>
            </nav>
          ) : null}
        </span>
      </div>
    </section>
  );
}

function Row({ p, doc, ticked, onTick, onOpen }: { p: Parcel; doc: boolean; ticked: boolean; onTick: () => void; onOpen: () => void }) {
  const [docType] = splitContents(p.contents);
  return (
    <tr className={ticked ? "ticked" : undefined}>
      <td className="check-cell">
        <input type="checkbox" aria-label={`Select ${p.trackingId}`} checked={ticked} onChange={onTick} />
      </td>
      <td>
        <button type="button" className="link-button tracking" onClick={onOpen}>
          {p.trackingId}
        </button>
        {p.merchantOrderRef ? <div className="sub">{p.merchantOrderRef}</div> : null}
      </td>
      <td>
        <div className="strong">{p.recipient?.name || "Recipient not set"}</div>
        <div className="sub">{localPhone(p.recipient?.phone)}</div>
      </td>
      <td>{destination(p)}</td>
      <td>{doc ? docType || "Business document" : p.contents || TYPE_LABEL[p.type] || "Domestic parcel"}</td>
      <td className="nowrap">{when(p.createdAt)}</td>
      <td className="nowrap">{money(doc ? p.charges?.total : Number(p.codAmount) > 0 ? p.codAmount : p.declaredValue || 0)}</td>
      <td>
        <Pill>{p.statusLabel}</Pill>
        {p.incomplete ? (
          <div>
            <Pill tone="warn">Needs info</Pill>
          </div>
        ) : null}
      </td>
      <td>
        <div className="row-actions">
          <Button size="sm" onClick={onOpen}>
            Tracking history
          </Button>
          {p.incomplete && EDITABLE_INCOMPLETE.includes(p.status) ? (
            <Button size="sm" variant="primary" onClick={() => completeDetails(p)}>
              Complete
            </Button>
          ) : null}
          {p.canCancel ? (
            <Button size="sm" onClick={() => cancelParcel(p)}>
              Cancel
            </Button>
          ) : null}
          {p.status === "RETURNED" && !p.returnInfo?.receivedAt ? (
            <Button size="sm" variant="primary" onClick={() => confirmReturnReceived(p.trackingId)}>
              Confirm return received
            </Button>
          ) : null}
        </div>
      </td>
    </tr>
  );
}
