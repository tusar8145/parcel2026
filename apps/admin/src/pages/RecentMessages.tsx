/**
 * Recent messages (GET /notifications/outbox, /notifications/outbox/by-merchant): what was sent, with its text (codes
 * and private links masked), the event, the parcel and its merchant, to whom (masked) and how it went; filtered by
 * period (Dhaka days), channel, status, merchant and a search. "Per merchant": how many SMS / emails each merchant's
 * parcels got in the period (click one to see its messages).
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, describe } from "@panel/lib/api";
import { Button, Loading, Metric, PageHeading, Panel, Pill, Tabs } from "@panel/ui/kit";
import { Pager, usePaged } from "@panel/ui/Pager";
import { num } from "@/lib/admin";

interface OutboxItem {
  id: string;
  createdAt: string;
  channel: string;
  template: string;
  eventLabel: string;
  text: string;
  subject?: string | null;
  parts?: number;
  trackingId?: string | null;
  merchant?: { id: string; code: string; name: string } | null;
  to: string;
  state: "PENDING" | "SENT" | "FAILED";
  notBefore?: string | null;
  provider?: string | null;
  lastError?: string | null;
}
interface ByMerchant {
  total: number;
  items: { merchant: { id: string; code: string; name: string; type: string } | null; total: number; sent: number; failed: number; pending: number }[];
}
const when = (value?: string | null) => (value ? new Date(value).toLocaleString("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "Never");
const today = () => new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() + 6 * 3600_000 - n * 86_400_000).toISOString().slice(0, 10);
const PRESETS: [string, () => [string, string]][] = [
  ["Today", () => [today(), today()]],
  ["Last 7 days", () => [daysAgo(6), today()]],
  ["This month", () => [today().slice(0, 8) + "01", today()]],
  ["Last 30 days", () => [daysAgo(29), today()]],
];

export default function RecentMessages() {
  const [tab, setTab] = useState<"messages" | "merchants">("messages");
  const [from, setFrom] = useState(daysAgo(6));
  const [to, setTo] = useState(today());
  const [channel, setChannel] = useState("SMS");
  const [state, setState] = useState("");
  const [merchant, setMerchant] = useState<{ id: string; name: string } | null>(null);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const query = new URLSearchParams({ limit: "500", from, to, ...(channel ? { channel } : {}), ...(state ? { state } : {}), ...(merchant ? { merchantId: merchant.id } : {}), ...(search.trim() ? { q: search.trim() } : {}) });
  const q = useQuery({ queryKey: ["admin", "outbox", query.toString()], queryFn: () => api<OutboxItem[]>(`/notifications/outbox?${query}`), refetchInterval: 30_000, enabled: tab === "messages" });
  const per = useQuery({ queryKey: ["admin", "outbox-by-merchant", channel || "SMS", from, to], queryFn: () => api<ByMerchant>(`/notifications/outbox/by-merchant?channel=${channel || "SMS"}&from=${from}&to=${to}`), enabled: tab === "merchants" });
  const { rows, pager } = usePaged(q.data ?? [], 25);
  const list = q.data ?? [];
  const sent = list.filter(m => m.state === "SENT").length;
  const failed = list.filter(m => m.state === "FAILED").length;
  const parts = list.reduce((a, m) => a + (m.parts ?? 0), 0);

  const period = (
    <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
      {PRESETS.map(([label, range]) => {
        const [f, t] = range();
        return (
          <Button key={label} size="sm" variant={f === from && t === to ? "primary" : undefined} onClick={() => (setFrom(f), setTo(t))}>
            {label}
          </Button>
        );
      })}
      <input className="input sm" type="date" aria-label="From" value={from} max={to} onChange={e => e.target.value && setFrom(e.target.value)} />
      <input className="input sm" type="date" aria-label="To" value={to} min={from} max={today()} onChange={e => e.target.value && setTo(e.target.value)} />
      <select className="select sm" aria-label="Channel" value={channel} onChange={e => setChannel(e.target.value)}>
        {tab === "messages" ? <option value="">All channels</option> : null}
        <option value="SMS">SMS</option>
        <option value="EMAIL">Email</option>
      </select>
    </div>
  );

  return (
    <>
      <PageHeading eyebrow="Notification settings" title="Recent messages" subtitle="What was sent, to whom and how it went, and how many SMS each merchant's parcels got." />
      <div style={{ marginBottom: 12 }}>
        <Tabs
          label="View"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "messages", label: "Messages" },
            { id: "merchants", label: "Per merchant" },
          ]}
        />
      </div>
      {tab === "merchants" ? (
        <Panel title={`${channel === "EMAIL" ? "Emails" : "SMS"} per merchant`} subtitle={`Messages about each merchant's parcels, ${from} to ${to} (Dhaka). Click a merchant to see its messages.`} tools={period}>
          {per.error ? <div className="callout bad" style={{ margin: 16 }}>{describe(per.error)}</div> : null}
          {!per.data ? (
            <Loading rows={6} />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Merchant</th>
                    <th className="num">Total</th>
                    <th className="num">Sent</th>
                    <th className="num">Failed</th>
                    <th className="num">Waiting</th>
                    <th className="num">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {per.data.items.map(r => (
                    <tr key={r.merchant?.id ?? "none"}>
                      <td>
                        {r.merchant ? (
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => {
                              setMerchant({ id: r.merchant!.id, name: r.merchant!.name });
                              setTab("messages");
                            }}
                          >
                            <strong>{r.merchant.name}</strong>
                          </button>
                        ) : (
                          <strong>No merchant</strong>
                        )}
                        <span className="sub">{r.merchant ? `${r.merchant.code} · ${r.merchant.type === "BANKING_FINANCIAL" ? "Banking & Financial" : "E-commerce"}` : "Customer parcels, sign-in codes, staff and other messages"}</span>
                      </td>
                      <td className="num">
                        <strong>{num(r.total)}</strong>
                      </td>
                      <td className="num">{num(r.sent)}</td>
                      <td className="num">{r.failed ? <Pill tone="bad">{num(r.failed)}</Pill> : "0"}</td>
                      <td className="num">{num(r.pending)}</td>
                      <td className="num">{per.data!.total ? `${Math.round((r.total / per.data!.total) * 100)}%` : "—"}</td>
                    </tr>
                  ))}
                  {!per.data.items.length ? (
                    <tr>
                      <td colSpan={6} className="faint">
                        No messages in this period.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      ) : (
        <>
          <div className="metrics">
            <Metric label="Messages" icon="message" value={q.data ? num(list.length) : "—"} foot={list.length >= 500 ? "the latest 500" : ""} note={`${from} to ${to}`} />
            <Metric label="Sent" icon="check" value={q.data ? num(sent) : "—"} foot="" note="delivered to the gateway" />
            <Metric label="Failed" icon="alert" value={q.data ? num(failed) : "—"} foot="" note="see the gateway's reply" />
            <Metric label="SMS parts" icon="sms" value={q.data ? num(parts) : "—"} foot="long or Bangla SMS use more parts" note="what the gateway counts" />
          </div>
          <Panel
            title="Messages"
            subtitle="Codes and private links in the text are hidden. Click a row to read the whole message."
            tools={
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                {period}
                <select className="select sm" aria-label="Status" value={state} onChange={e => setState(e.target.value)}>
                  <option value="">Any status</option>
                  <option value="SENT">Sent</option>
                  <option value="PENDING">Waiting</option>
                  <option value="FAILED">Failed</option>
                </select>
                <input className="input sm" type="search" placeholder="Tracking ID or number" aria-label="Search" value={search} onChange={e => setSearch(e.target.value)} style={{ width: 170 }} />
                {merchant ? (
                  <Button size="sm" onClick={() => setMerchant(null)} title="Show every merchant">
                    {`${merchant.name} ✕`}
                  </Button>
                ) : null}
              </div>
            }
          >
            {q.error ? <div className="callout bad" style={{ margin: 16 }}>{describe(q.error)}</div> : null}
            {q.isLoading ? (
              <Loading rows={6} />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Message</th>
                      <th>Parcel · merchant</th>
                      <th>To</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(m => (
                      <tr key={m.id} onClick={() => setOpen(open === m.id ? null : m.id)} style={{ cursor: "pointer", verticalAlign: "top" }}>
                        <td className="nowrap">{when(m.createdAt)}</td>
                        <td style={{ maxWidth: 460 }}>
                          <strong>{m.eventLabel}</strong> <span className="faint">{`· ${m.channel === "EMAIL" ? "Email" : `SMS${m.parts && m.parts > 1 ? ` (${m.parts} parts)` : ""}`}`}</span>
                          {m.subject ? <span className="sub">{m.subject}</span> : null}
                          <span className="sub" style={open === m.id ? { whiteSpace: "pre-wrap", wordBreak: "break-word" } : { display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {m.text}
                          </span>
                        </td>
                        <td>
                          {m.trackingId ?? "—"}
                          <span className="sub">{m.merchant ? m.merchant.name : m.trackingId ? "Customer parcel" : ""}</span>
                        </td>
                        <td className="nowrap">{m.to}</td>
                        <td>
                          <Pill tone={m.state === "SENT" ? "good" : m.state === "FAILED" ? "bad" : "warn"}>{m.state === "PENDING" && m.notBefore ? "Waiting" : m.state === "SENT" ? "Sent" : m.state === "FAILED" ? "Failed" : "Pending"}</Pill>
                          {m.lastError ? <span className="sub" style={{ color: "#b42318" }}>{m.lastError}</span> : m.provider ? <span className="sub">{m.provider}</span> : null}
                        </td>
                      </tr>
                    ))}
                    {!rows.length ? (
                      <tr>
                        <td colSpan={5}>No messages match the filter.</td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            )}
            <Pager {...pager} noun="message" />
          </Panel>
        </>
      )}
    </>
  );
}
