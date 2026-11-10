/**
 * Scan with phone usage (Operational settings): how many label photos were read, by Claude or the local reader,
 * how long they took, and Claude's estimated cost (GET /parcel-scans/usage ?from &to &page &pageSize; Dhaka days,
 * this month by default). The estimate uses list prices; the bill is in the Anthropic Console › Usage.
 */
import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api, describe } from "@panel/lib/api";
import { saveCsv } from "@panel/lib/csv";
import { Button, Metric, PageHeading, Panel, Pill } from "@panel/ui/kit";
import { Pager } from "@panel/ui/Pager";
import { num, when } from "@/lib/admin";

interface Usage {
  from: string;
  to: string;
  reader: { name: "claude" | "local"; model: string | null };
  totals: { photos: number; claude: number; local: number; read: number; failed: number; fallbacks: number; tokens: { input: number; cacheRead: number; cacheWrite: number; output: number }; costUsd: number; avgMs: number };
  models: { model: string | null; photos: number; costUsd: number; avgMs: number }[];
  daily: { day: string; photos: number; claude: number; failed: number; costUsd: number }[];
  log: {
    total: number;
    page: number;
    pageSize: number;
    items: {
      id: string;
      createdAt: string;
      kindLabel: string;
      merchant: { name: string; code: string } | null;
      user: string | null;
      reader: "CLAUDE" | "LOCAL";
      model: string | null;
      status: "READ" | "FAILED" | "READING";
      fallback: boolean;
      error: string | null;
      fields: number;
      ms: number;
      tokens: number;
      costUsd: number;
    }[];
  };
}

/** Dhaka's today, YYYY-MM-DD. */
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka" }).format(new Date());
const usd = (v: number) => (v === 0 ? "$0" : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
const secs = (ms: number) => (ms ? `${(ms / 1000).toFixed(1)} s` : "—");

export default function ScanUsage() {
  const [from, setFrom] = useState(() => `${today().slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(50);
  const usage = useQuery({
    queryKey: ["admin", "scan-usage", from, to, page, size],
    queryFn: () => api<Usage>(`/parcel-scans/usage?${new URLSearchParams({ from, to, page: String(page), pageSize: String(size) })}`),
    placeholderData: keepPreviousData,
  });
  const d = usage.data;
  const t = d?.totals;
  const items = d?.log.items ?? [];
  const pages = Math.max(1, Math.ceil((d?.log.total ?? 0) / size));
  const range = (set: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.value) set(e.target.value);
    setPage(1);
  };

  return (
    <>
      <PageHeading
        eyebrow="Operational settings"
        title="Scan with phone usage"
        subtitle="Every label photo read: by Claude or the local reader, how long it took and Claude's estimated cost."
        actions={
          <Button
            icon="download"
            disabled={!items.length}
            onClick={() =>
              saveCsv(`scan-usage-${from}-to-${to}.csv`, [
                ["TIME", "TYPE", "MERCHANT", "STAFF", "READER", "MODEL", "RESULT", "FIELDS", "SECONDS", "TOKENS", "COST (USD)"],
                ...items.map(r => [when(r.createdAt), r.kindLabel, r.merchant ? `${r.merchant.code} ${r.merchant.name}` : "", r.user ?? "", r.fallback ? "Local (Claude failed)" : r.reader === "CLAUDE" ? "Claude" : "Local", r.model ?? "", r.status, String(r.fields), (r.ms / 1000).toFixed(1), String(r.tokens), r.costUsd.toFixed(6)]),
              ])
            }
          >
            Export page
          </Button>
        }
      />
      <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "end", marginBottom: 14 }}>
        <label className="field">
          <span>From</span>
          <input className="input" type="date" value={from} max={to} onChange={range(setFrom)} />
        </label>
        <label className="field">
          <span>To</span>
          <input className="input" type="date" value={to} min={from} max={today()} onChange={range(setTo)} />
        </label>
        {d ? (
          <span className="muted" style={{ paddingBottom: 8 }}>
            {d.reader.name === "claude" ? `Photos are read by Claude (${d.reader.model}).` : "Photos are read by the local reader (OCR + rules); Claude is off (SCAN_READER)."}
          </span>
        ) : null}
      </div>
      {usage.error ? <div className="callout bad">{describe(usage.error)}</div> : null}
      <div className="metrics">
        <Metric label="Photos scanned" icon="camera" value={t ? num(t.photos) : "0"} foot={t ? `${num(t.read)} read · ${num(t.failed)} not read` : ""} note={`${from} to ${to}`} />
        <Metric label="Read by Claude" icon="scan" value={t ? num(t.claude) : "0"} foot={t ? `${num(t.local)} by the local reader` : ""} note={t?.fallbacks ? `${num(t.fallbacks)} fell back (Claude failed)` : "no fallbacks"} />
        <Metric label="Claude cost (estimate)" icon="wallet" value={t ? usd(t.costUsd) : "$0"} foot={t && t.claude ? `${usd(t.costUsd / t.claude)} a photo` : "list prices"} note="bill: Anthropic Console › Usage" />
        <Metric label="Average time" icon="clock" value={t ? secs(t.avgMs) : "—"} foot={t ? `${num(t.tokens.input + t.tokens.cacheRead + t.tokens.cacheWrite + t.tokens.output)} tokens` : ""} note="per photo, read on the server" />
      </div>
      {d?.models.length ? (
        <Panel title="By model" subtitle="Claude's readings in the period">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Photos</th>
                  <th>Average time</th>
                  <th>Cost (estimate)</th>
                </tr>
              </thead>
              <tbody>
                {d.models.map(m => (
                  <tr key={m.model ?? "?"}>
                    <td className="strong">{m.model ?? "—"}</td>
                    <td>{num(m.photos)}</td>
                    <td>{secs(m.avgMs)}</td>
                    <td>{usd(m.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}
      <Panel title="By day" subtitle="Dhaka days, newest first">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Day</th>
                <th>Photos</th>
                <th>By Claude</th>
                <th>Not read</th>
                <th>Cost (estimate)</th>
              </tr>
            </thead>
            <tbody>
              {(d?.daily ?? []).map(r => (
                <tr key={r.day}>
                  <td className="strong nowrap">{r.day}</td>
                  <td>{num(r.photos)}</td>
                  <td>{num(r.claude)}</td>
                  <td>{num(r.failed)}</td>
                  <td>{usd(r.costUsd)}</td>
                </tr>
              ))}
              {!d?.daily.length ? (
                <tr>
                  <td colSpan={5} className="faint" style={{ textAlign: "center" }}>
                    {usage.isLoading ? "Loading…" : "No photos were scanned in this period."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel title="Scan log" subtitle="Every photo read, newest first">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Type</th>
                <th>Merchant</th>
                <th>Staff</th>
                <th>Reader</th>
                <th>Result</th>
                <th>Fields</th>
                <th>Time taken</th>
                <th>Tokens</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {items.map(r => (
                <tr key={r.id}>
                  <td className="nowrap">{when(r.createdAt)}</td>
                  <td>{r.kindLabel}</td>
                  <td>{r.merchant ? `${r.merchant.code} · ${r.merchant.name}` : "—"}</td>
                  <td>{r.user ?? "—"}</td>
                  <td title={r.error ?? undefined}>
                    {r.fallback ? <Pill tone="warn">Local (Claude failed)</Pill> : r.reader === "CLAUDE" ? <Pill tone="violet">{r.model ?? "Claude"}</Pill> : <Pill tone="neutral">Local</Pill>}
                  </td>
                  <td>{r.status === "READ" ? <Pill tone="good">Read</Pill> : <Pill tone="bad">Not read</Pill>}</td>
                  <td>{num(r.fields)}</td>
                  <td className="nowrap">{secs(r.ms)}</td>
                  <td>{r.tokens ? num(r.tokens) : "—"}</td>
                  <td className="nowrap">{r.reader === "CLAUDE" || r.fallback ? usd(r.costUsd) : "—"}</td>
                </tr>
              ))}
              {!items.length ? (
                <tr>
                  <td colSpan={10} className="faint" style={{ textAlign: "center" }}>
                    {usage.isLoading ? "Loading the log…" : "No photos were scanned in this period."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <Pager
          page={page}
          pages={pages}
          size={size}
          total={d?.log.total ?? 0}
          shown={items.length}
          noun="photo"
          sizes={[50, 100, 200]}
          busy={usage.isFetching}
          text={d?.log.total ? `Showing ${num((page - 1) * size + 1)}–${num((page - 1) * size + items.length)} of ${num(d.log.total)}` : "No photos"}
          setPage={setPage}
          setSize={s => {
            setSize(s);
            setPage(1);
          }}
        />
      </Panel>
    </>
  );
}
