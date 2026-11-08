/**
 * The parcel table every stage uses (bridge.js shipmentRows + bridge-parcel.js row actions + bridge-lists.js tools):
 * tracking ID, merchant / recipient, destination, rider, status (+ failed badge), SLA, then the next action,
 * "Details" (the drawer) and More. The last column stays pinned while the table scrolls sideways.
 */
import { Select } from "@/ui/Select";
import { useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, describe } from "@/lib/api";
import { num, when } from "@/lib/format";
import { useOps } from "@/lib/ops";
import { Button, Empty, Loading, MoreMenu, Pill, useDebounced } from "@/ui/kit";
import { SearchSelect } from "@/ui/SearchSelect";
import { useEffect, useState } from "react";
import { ALL_STATUSES, LINES, failedDelivery, failureBadge, failureText, lineLabel, lineOf, riderOf, serviceOf, slaOf, type Parcel } from "./model";
import type { ParcelListState } from "./useParcelList";
import { useParcelActions } from "./useParcelActions";

export interface TableOptions {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Search box (server-side: tracking ID, phone, name). */
  search?: boolean;
  /** Status filter: "register" (every status + Needs info) or a list of labels. */
  statuses?: "register" | string[];
  dates?: boolean;
  lines?: boolean;
  merchants?: boolean;
  hubs?: boolean;
  failedFilter?: boolean;
  /** Problems › Failed delivery: attempts and last failure columns. */
  failureColumns?: boolean;
  /** New orders: tick rows → Accept & assign (N). */
  bulkAccept?: boolean;
  /** Ticking rows (print, export, bulk). */
  selectable?: boolean;
  extraTools?: ReactNode;
  id?: string;
}

const PAGE_SIZES = [50, 100, 200];
const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

interface MerchantRef {
  id: string;
  name: string;
  type?: string;
}
export function useOpsMerchants(enabled = true) {
  return useQuery({ queryKey: ["ops", "merchants"], queryFn: () => api<MerchantRef[]>("/ops/merchants"), staleTime: 5 * 60_000, enabled });
}

export default function ParcelTable({ list, options }: { list: ParcelListState; options: TableOptions }) {
  const ops = useOps();
  const actions = useParcelActions();
  const { filters, setFilters, rows } = list;
  const [q, setQ] = useState(filters.q ?? "");
  const debounced = useDebounced(q, 350);
  useEffect(() => {
    if ((filters.q ?? "") !== debounced) setFilters({ q: debounced });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);
  const merchants = useOpsMerchants(!!options.merchants);
  const merchantOptions = useMemo(() => {
    const line = filters.line || "";
    const known = new Map<string, string>();
    for (const m of merchants.data || []) if (!line || m.type === line) known.set(m.id, m.name);
    for (const p of rows) if (p.merchant && !known.has(p.merchant.id) && (!line || lineOf(p) === line)) known.set(p.merchant.id, p.merchant.name);
    return [...known].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label }));
  }, [merchants.data, rows, filters.line]);

  const allTicked = rows.length > 0 && rows.every(r => list.ticked.has(r.trackingId));
  const selectable = options.selectable !== false;
  const columns = 7 + (selectable ? 1 : 0) + (options.failureColumns ? 2 : 0);

  const tools = (
    <>
      {ops.scope.available && list.cfg.scoped !== false ? (
        <label className="row" style={{ gap: 6, fontSize: 12.5 }}>
          Show
          <Select className="select sm" value={ops.scope.value} onChange={e => ops.scope.set(e.target.value as "mine" | "all")} aria-label="Which hubs' parcels to show">
            <option value="mine">{ops.scope.label}</option>
            <option value="all">All hubs</option>
          </Select>
        </label>
      ) : null}
      {options.bulkAccept && ops.can("dispatch") && list.ticked.size ? (
        <Button size="sm" variant="primary" onClick={async () => (await actions.bulkAccept(list.tickedParcels())) && list.clearTicked()}>
          {`Accept & assign (${list.ticked.size})`}
        </Button>
      ) : null}
      {options.extraTools}
      {options.hubs && !ops.scope.available ? (
        <SearchSelect size="sm" label="Hub" emptyLabel="All hubs" options={ops.hubs.map(h => ({ value: h.id, label: h.name }))} value={filters.hubId || ""} onChange={v => setFilters({ hubId: v })} width={170} />
      ) : null}
      {options.failedFilter ? (
        <Select className="select sm" aria-label="Failed before" value={filters.failedBefore || ""} onChange={e => setFilters({ failedBefore: e.target.value })}>
          <option value="">All parcels</option>
          <option value="true">Failed before</option>
          <option value="false">Not failed before</option>
        </Select>
      ) : null}
      {options.statuses ? (
        <Select className="select sm" aria-label="Filter by status" value={filters.status || ""} onChange={e => setFilters({ status: e.target.value })}>
          <option value="">All statuses</option>
          {(options.statuses === "register" ? ALL_STATUSES : options.statuses).map(s => (
            <option key={s}>{s}</option>
          ))}
          {options.statuses === "register" ? <option value="Needs info">{`Needs info${ops.stageCounts?.detail?.needsInfo ? ` (${num(ops.stageCounts.detail.needsInfo)})` : ""}`}</option> : null}
        </Select>
      ) : null}
      {list.cfg.register ? (
        <label className="row" style={{ gap: 6, fontSize: 12.5 }}>
          Date field
          <Select className="select sm" value={filters.dateField || "pickup"} onChange={e => setFilters({ dateField: e.target.value as "pickup" | "status" })}>
            <option value="pickup">Pickup / created date</option>
            <option value="status">Status update date</option>
          </Select>
        </label>
      ) : null}
      {options.dates ? (
        <>
          <label className="row" style={{ gap: 6, fontSize: 12.5 }}>
            From
            <input className="input sm" type="date" aria-label="From date" value={filters.from || ""} onChange={e => setFilters({ from: e.target.value })} style={{ width: 140 }} />
          </label>
          <label className="row" style={{ gap: 6, fontSize: 12.5 }}>
            To
            <input className="input sm" type="date" aria-label="To date" value={filters.to || ""} onChange={e => setFilters({ to: e.target.value })} style={{ width: 140 }} />
          </label>
        </>
      ) : null}
      {options.lines ? (
        <Select className="select sm" aria-label="Filter by parcel type" value={filters.line || ""} onChange={e => setFilters({ line: e.target.value })}>
          <option value="">All parcel types</option>
          {LINES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      ) : null}
      {options.merchants && filters.line !== "CUSTOMER" ? (
        <SearchSelect size="sm" label="Merchants" emptyLabel="All merchants" options={merchantOptions} value={filters.merchantId || ""} onChange={v => setFilters({ merchantId: v })} width={190} />
      ) : null}
      {options.search !== false ? (
        <input className="input sm" type="search" placeholder="Search ID, phone, name" aria-label={`Search ${typeof options.title === "string" ? options.title : "parcels"}`} value={q} onChange={e => setQ(e.target.value)} style={{ width: 200 }} />
      ) : null}
    </>
  );

  return (
    <section className="panel" id={options.id}>
      <div className="panel-head">
        <div>
          <h2 className="panel-title">{options.title}</h2>
          {options.subtitle ? <p className="panel-subtitle">{options.subtitle}</p> : null}
        </div>
        <div className="tools">{tools}</div>
      </div>
      <div className="table-wrap" style={{ opacity: list.fetching && !list.loading ? 0.7 : 1, transition: "opacity .15s" }}>
        <table className="table parcels">
          <thead>
            <tr>
              {selectable ? (
                <th className="check-cell">
                  <input type="checkbox" aria-label="Select visible shipments" checked={allTicked} onChange={e => list.setTicked(e.target.checked ? new Set(rows.map(r => r.trackingId)) : new Set())} />
                </th>
              ) : null}
              <th>CN / tracking ID</th>
              <th>Merchant / recipient</th>
              <th>Destination</th>
              <th>Rider</th>
              {options.failureColumns ? (
                <>
                  <th>Attempts</th>
                  <th>Last failure</th>
                </>
              ) : null}
              <th>Status</th>
              <th>SLA</th>
              <th className="sticky-actions" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {list.loading ? (
              <tr>
                <td colSpan={columns}>
                  <Loading rows={4} />
                </td>
              </tr>
            ) : list.error && !rows.length ? (
              <tr>
                <td colSpan={columns}>
                  <Empty>{describe(list.error)}</Empty>
                </td>
              </tr>
            ) : !rows.length ? (
              <tr>
                <td colSpan={columns}>
                  <Empty>{list.filtered ? "No parcels match the search or filters." : list.cfg.empty || "Nothing here right now."}</Empty>
                </td>
              </tr>
            ) : (
              rows.map(p => <Row key={p.trackingId} p={p} list={list} options={options} />)
            )}
          </tbody>
        </table>
      </div>
      <Footer list={list} />
    </section>
  );
}

function Row({ p, list, options }: { p: Parcel; list: ParcelListState; options: TableOptions }) {
  const a = useParcelActions();
  const ops = useOps();
  const next = a.next(p);
  const line = lineOf(p);
  const sub = [lineLabel(p), serviceOf(p), when(p.createdAt)].filter(Boolean).join(" · ");
  const customer = line === "CUSTOMER" ? ` · Sender pays ৳${Number(p.charges?.total) || 0}${Number(p.codAmount) ? ` · COD ৳${Number(p.codAmount)}` : ""}` : "";
  const merchant = p.merchant?.name || p.sender?.name || "Merchant not set";
  const recipient = p.recipient?.name || "Recipient not set";
  const destination = p.delivery?.label || "Address not set";
  const rider = riderOf(p);
  const sla = slaOf(p);
  const badge = failureBadge(p);
  const ticked = list.ticked.has(p.trackingId);
  const dispatch = ops.can("dispatch");
  const pendingCustomer = line === "CUSTOMER" && p.status === "PENDING_CONFIRMATION";
  return (
    <tr className={ticked ? "selected" : undefined}>
      {options.selectable !== false ? (
        <td className="check-cell">
          <input type="checkbox" aria-label={`Select ${p.trackingId}`} checked={ticked} onChange={() => list.toggle(p.trackingId)} />
        </td>
      ) : null}
      <td className="card-title">
        <button type="button" className="link-button tracking" onClick={() => a.openParcel(p.trackingId)}>
          {p.trackingId}
        </button>
        {p.incomplete ? (
          <>
            {" "}
            <span className="pill warn" title={`Imported with details missing: ${(p.missingLabels || []).join(", ")}. Use Edit details to complete it before delivery.`}>
              Needs info
            </span>
            <span className="sub" style={{ color: "var(--warn)" }}>
              Missing: {(p.missingLabels || []).join(", ")}
            </span>
          </>
        ) : null}
        <span className="sub" title={sub + customer}>
          {cut(sub + customer, 64)}
        </span>
      </td>
      <td data-label="Merchant / recipient" title={`${merchant} → ${recipient}`}>
        <span className="strong">{cut(merchant, 30)}</span>
        <span className="sub">{cut(recipient, 30)}</span>
      </td>
      <td data-label="Destination" title={destination} style={{ minWidth: 160 }}>
        {cut(destination, 34)}
      </td>
      <td data-label="Rider" title={rider}>{cut(rider, 28)}</td>
      {options.failureColumns ? (
        <>
          <td data-label="Attempts">
            <strong>{`×${Number(p.failedAttempts) || 0}`}</strong>
            <span className="sub">{p.returnedAfterFailure ? `Back at ${p.currentHub?.name || "hub"}` : p.status === "RETRY_SCHEDULED" ? "Retry scheduled" : ""}</span>
          </td>
          <td data-label="Last failure" style={{ minWidth: 160 }}>
            {p.lastFailedAttempt?.reason || "—"}
            <span className="sub">{[p.lastFailedAttempt ? when(p.lastFailedAttempt.at) : "", p.lastFailedAttempt?.riderName].filter(Boolean).join(" · ")}</span>
          </td>
        </>
      ) : null}
      <td data-label="Status">
        <div className="row" style={{ gap: 4, flexWrap: "nowrap" }}>
          <Pill>{p.statusLabel}</Pill>
          {badge ? (
            <span className="pill bad" title={failureText(p, when)}>
              {`Failed ×${badge.count}${badge.reason ? ` · ${cut(badge.reason, 26)}` : ""}`}
            </span>
          ) : null}
        </div>
      </td>
      <td data-label="SLA">
        <Pill>{sla}</Pill>
      </td>
      <td className="sticky-actions">
        <div className="row-actions">
          {next ? (
            <Button size="sm" variant="primary" title={next.title} onClick={() => a.run(next.kind, p)}>
              {next.label}
            </Button>
          ) : null}
          {failedDelivery(p) && dispatch ? (
            <Button size="sm" variant="primary" title="Schedule the return to the sender, optionally on a return run" onClick={() => a.returnToSender(p)}>
              Return to sender
            </Button>
          ) : null}
          <Button size="sm" onClick={() => a.openParcel(p.trackingId)}>
            Details
          </Button>
          <MoreMenu
            items={[
              { label: "History", icon: "clock", onSelect: () => a.openParcel(p.trackingId) },
              next?.kind !== "edit" && { label: "Edit details", icon: "edit", onSelect: () => a.edit(p) },
              a.canChangeIntake(p) && { label: p.intake === "DROP_OFF" ? "Change to rider pickup" : "Change to drop-off", onSelect: () => a.changeIntake(p) },
              pendingCustomer && next?.kind !== "accept" && { label: "Accept & assign rider", onSelect: () => a.assign(p) },
              pendingCustomer && { label: "Cancel request", danger: true, onSelect: () => a.cancel(p) },
              next?.kind !== "resolve" && (p.status === "EXCEPTION" || sla === "At risk") && { label: "Resolve", onSelect: () => a.resolve(p) },
            ]}
          />
        </div>
      </td>
    </tr>
  );
}

function Footer({ list }: { list: ParcelListState }) {
  const noun = list.cfg.noun || "parcel";
  if (!list.paged) {
    const n = list.rows.length;
    return <div className="panel-foot">{list.loading && !n ? "Loading…" : `Showing ${num(n)} ${noun}${n === 1 ? "" : "s"} · updates live`}</div>;
  }
  const { page, pages, size, total } = list;
  const n = list.rows.length;
  const first = (page - 1) * size + 1;
  const near = [...new Set([1, page - 1, page, page + 1, pages])].filter(p => p >= 1 && p <= pages).sort((a, b) => a - b);
  return (
    <div className="panel-foot">
      <span>{list.loading && !n ? "Loading…" : total ? `Showing ${num(first)}–${num(first + n - 1)} of ${num(total)} ${noun}${total === 1 ? "" : "s"} · updates live` : `No ${noun}s`}</span>
      <span className="row" style={{ gap: 6 }}>
        <label className="row" style={{ gap: 6 }}>
          Rows per page
          <Select className="select sm" aria-label="Rows per page" value={size} onChange={e => list.setSize(Number(e.target.value))}>
            {PAGE_SIZES.map(s => (
              <option key={s}>{s}</option>
            ))}
          </Select>
        </label>
        {pages > 1 ? (
          <nav className="pager" aria-label="Pages">
            <button type="button" className="button sm" disabled={page === 1 || list.fetching} onClick={() => list.setPage(1)}>
              First
            </button>
            <button type="button" className="button sm" aria-label="Previous page" disabled={page === 1 || list.fetching} onClick={() => list.setPage(page - 1)}>
              ‹
            </button>
            {near.map((p, i) => (
              <span key={p} style={{ display: "contents" }}>
                {i && p - near[i - 1] > 1 ? <span aria-hidden="true">…</span> : null}
                <button type="button" className={`button sm ${p === page ? "primary" : ""}`} aria-current={p === page ? "page" : undefined} aria-label={`Page ${p}`} disabled={list.fetching && p !== page} onClick={() => list.setPage(p)}>
                  {num(p)}
                </button>
              </span>
            ))}
            <button type="button" className="button sm" aria-label="Next page" disabled={page === pages || list.fetching} onClick={() => list.setPage(page + 1)}>
              ›
            </button>
            <button type="button" className="button sm" disabled={page === pages || list.fetching} onClick={() => list.setPage(pages)}>
              Last
            </button>
          </nav>
        ) : null}
      </span>
    </div>
  );
}
