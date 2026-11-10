/**
 * Recent messages (bridge-notifications.js outboxPanel, GET /notifications/outbox?limit=100&channel=&state=): the
 * latest SMS and emails and how they went, filtered by channel and status; the text is hidden (it can contain codes).
 * Paged on screen.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, describe } from "@panel/lib/api";
import { Loading, PageHeading, Panel, Pill } from "@panel/ui/kit";
import { Pager, usePaged } from "@panel/ui/Pager";

interface OutboxItem {
  id: string;
  createdAt: string;
  channel: string;
  template: string;
  to: string;
  state: "PENDING" | "SENT" | "FAILED";
  notBefore?: string | null;
  provider?: string | null;
  lastError?: string | null;
}
const when = (value?: string | null) => (value ? new Date(value).toLocaleString("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "Never");

export default function RecentMessages() {
  const [channel, setChannel] = useState("");
  const [state, setState] = useState("");
  const query = new URLSearchParams({ limit: "100", ...(channel ? { channel } : {}), ...(state ? { state } : {}) });
  const q = useQuery({ queryKey: ["admin", "outbox", channel, state], queryFn: () => api<OutboxItem[]>(`/notifications/outbox?${query}`), refetchInterval: 30_000 });
  const { rows, pager } = usePaged(q.data ?? [], 25);
  return (
    <>
      <PageHeading eyebrow="Notification settings" title="Recent messages" subtitle="The latest SMS and email messages and how they went." />
      <Panel
        title="Recent messages"
        subtitle="The latest 100 messages (message text is hidden: it can contain codes)."
        tools={
          <div className="row" style={{ gap: 8 }}>
            <select className="select" aria-label="Channel" value={channel} onChange={e => setChannel(e.target.value)}>
              <option value="">All channels</option>
              <option value="SMS">SMS</option>
              <option value="EMAIL">Email</option>
            </select>
            <select className="select" aria-label="Status" value={state} onChange={e => setState(e.target.value)}>
              <option value="">Any status</option>
              <option value="SENT">Sent</option>
              <option value="PENDING">Pending</option>
              <option value="FAILED">Failed</option>
            </select>
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
                  <th>Channel</th>
                  <th>Event</th>
                  <th>To</th>
                  <th>Status</th>
                  <th>Gateway</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(m => (
                  <tr key={m.id}>
                    <td className="nowrap">{when(m.createdAt)}</td>
                    <td>{m.channel === "EMAIL" ? "Email" : m.channel}</td>
                    <td>{m.template.startsWith("broadcast:") ? "Message (Messaging)" : m.template}</td>
                    <td>{m.to}</td>
                    <td>
                      <Pill tone={m.state === "SENT" ? "good" : m.state === "FAILED" ? "bad" : "warn"}>{m.state === "PENDING" && m.notBefore ? "Waiting" : m.state === "SENT" ? "Sent" : m.state === "FAILED" ? "Failed" : "Pending"}</Pill>
                    </td>
                    <td>
                      {m.provider || "—"}
                      {m.lastError ? ` · ${m.lastError}` : ""}
                    </td>
                  </tr>
                ))}
                {!rows.length ? (
                  <tr>
                    <td colSpan={6}>{channel || state ? "No messages match the filter." : "No messages yet."}</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        )}
        <Pager {...pager} noun="message" />
      </Panel>
    </>
  );
}
