/**
 * Support tickets (shared/support.js, operations role; API /support/tickets):
 *   Staff (support:manage — operations managers, support agents, super admins): the inbox of every ticket, with the
 *   SLA state (first response / resolution, breaches), status / priority / assignee, internal notes, canned responses
 *   (insert, save from a reply), partner-application decisions on application tickets.
 *   Other operations staff (hub operators): their own tickets, a new-ticket form and a 1–5 rating once resolved.
 * Attachments are fetched with the access token (GET /files/:id as JSON) and saved from a blob URL. Lists reload on
 * live ticket.updated / application.updated events; ?ticket=<number> opens that ticket.
 */
import { Select } from "@/ui/Select";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, describe } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useLive } from "@/lib/events";
import { localPhone } from "@/lib/format";
import { Button, Empty, Loading, Metric, PageHeading, Panel, Pill } from "@/ui/kit";
import { prompt } from "@/ui/dialogs";
import { toast, toastError } from "@/ui/toast";

const STATUSES = ["Open", "In progress", "Waiting for requester", "Resolved", "Closed"];
const CATEGORIES = ["Delivery issue", "Pickup or collection", "COD / payment", "Account / API", "Rider or safety", "Other"];
const PRIORITIES: [string, string][] = [
  ["LOW", "Low"],
  ["NORMAL", "Normal"],
  ["HIGH", "High"],
  ["URGENT", "Urgent"],
];
// packages/shared/src/roles.ts: support:manage and support:create.
const STAFF_ROLES = ["SUPER_ADMIN", "OPS_MANAGER", "SUPPORT_AGENT"];
const REQUESTER_ROLES = ["CUSTOMER", "MERCHANT_OWNER", "MERCHANT_STAFF", "RIDER", "HUB_OPERATOR", ...STAFF_ROLES];
const APPLICATION_CATEGORIES = ["Rider application", "Franchise application"];
const MAX_BYTES = 5 * 1024 * 1024;
const EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "heic", "heif", "pdf", "doc", "docx", "xls", "xlsx", "csv", "ppt", "pptx", "txt"];
const ACCEPT = "image/*,.heic,.heif,.pdf,.doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx,.txt";
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : "");

interface Sla {
  state: string;
  firstResponseAt?: string | null;
  firstResponseDueAt?: string | null;
  firstResponseBreached?: boolean;
  resolutionDueAt?: string | null;
  paused?: boolean;
  escalationLevel?: number;
}
interface Ticket {
  number: string;
  status: string;
  statusLabel: string;
  priority: string;
  subject: string;
  category: string;
  relatedRef?: string | null;
  requester: { id: string; name: string; phone?: string | null };
  assignee: { id: string; name: string } | null;
  lastMessage?: { preview: string } | null;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  sla?: Sla | null;
  survey?: { rating?: number } | null;
}
interface Message {
  id: string;
  body: string;
  internal?: boolean;
  createdAt: string;
  author: { kind: string; id?: string | null; label: string };
  attachments?: { id: string; filename: string }[];
}
interface Detail extends Ticket {
  messages: Message[];
}
interface Application {
  number: string;
  kind: string;
  statusLabel: string;
  details?: Record<string, string>;
  decisionNote?: string | null;
  allowedNext?: string[];
}

const tone = (status: string) => (status === "Resolved" || status === "Closed" ? "good" : status === "In progress" ? "info" : status === "Waiting for requester" ? "warn" : "neutral");

async function fetchTickets() {
  const all: Ticket[] = [];
  let cursor: string | null = null;
  do {
    const page: { items: Ticket[]; nextCursor: string | null } = await api(`/support/tickets?limit=200${cursor ? `&cursor=${cursor}` : ""}`);
    all.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor && all.length < 1000);
  return all;
}

function readFile(file: File) {
  if (file.size > MAX_BYTES) throw new Error(`${file.name} is larger than 5 MB.`);
  const ext = (/\.([a-z0-9]+)$/i.exec(file.name)?.[1] || "").toLowerCase();
  if (!EXTENSIONS.includes(ext)) throw new Error(`${file.name}: attach photos (JPG, PNG, WebP, GIF, HEIC), PDF, Word, Excel, PowerPoint, CSV or text files.`);
  return new Promise<{ filename: string; dataUrl: string }>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ filename: file.name.slice(0, 120), dataUrl: String(reader.result) });
    reader.onerror = () => reject(new Error(`${file.name} could not be read.`));
    reader.readAsDataURL(file);
  });
}
async function readFiles(files: FileList | null) {
  const list = [...(files ?? [])];
  if (list.length > 5) throw new Error("Choose no more than 5 attachments.");
  return Promise.all(list.map(readFile));
}
/** A ticket attachment: fetched with the access token, handed to the browser as a blob URL. */
async function downloadAttachment(id: string) {
  const file = await api<{ dataUrl: string; mimeType: string; filename: string }>(`/files/${encodeURIComponent(id)}`, { headers: { accept: "application/json" } });
  const base64 = file.dataUrl.slice(file.dataUrl.indexOf(",") + 1);
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: file.mimeType }));
  const a = Object.assign(document.createElement("a"), { href: url, download: file.filename, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export default function Support() {
  const { user, hasRole } = useAuth();
  const qc = useQueryClient();
  const staff = hasRole(...STAFF_ROLES);
  const allowed = hasRole(...REQUESTER_ROLES);
  const [params, setParams] = useSearchParams();
  const [composer, setComposer] = useState(false);
  const tickets = useQuery({
    queryKey: ["support", "tickets", user?.id],
    queryFn: async () => {
      const items = await fetchTickets();
      // Staff see every ticket; outside the inbox only their own.
      return staff ? items : items.filter(t => t.requester.id === user?.id);
    },
    enabled: allowed,
    staleTime: 15_000,
  });
  useLive(["ticket.updated", "application.updated"], () => void qc.invalidateQueries({ queryKey: ["support"] }), { fallbackMs: 120_000 });
  const list = useMemo(() => [...(tickets.data ?? [])].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)), [tickets.data]);
  const wanted = params.get("ticket")?.toUpperCase() || "";
  const [selected, setSelected] = useState(wanted);
  useEffect(() => {
    if (wanted) setSelected(wanted);
  }, [wanted]);
  useEffect(() => {
    if (tickets.data && !list.some(t => t.number === selected)) setSelected(list[0]?.number ?? "");
  }, [tickets.data, list, selected]);
  const ticket = list.find(t => t.number === selected) ?? null;
  const select = (n: string) => {
    setSelected(n);
    if (params.has("ticket"))
      setParams(
        p => {
          p.delete("ticket");
          return p;
        },
        { replace: true },
      );
  };
  const title = staff ? "Support inbox" : "My support tickets";
  const heading = (subtitle?: string) => (
    <PageHeading
      eyebrow={staff ? "Service desk" : "Help & support"}
      title={title}
      subtitle={subtitle || (staff ? "Respond to merchant, rider, and website customer requests. Requesters see your replies and status changes on their own support page." : "Create a ticket, attach screenshots or documents, and continue the conversation with courier operations.")}
      actions={
        !staff && allowed ? (
          <Button variant="primary" onClick={() => setComposer(c => !c)}>
            {composer ? "Hide ticket form" : "New support ticket"}
          </Button>
        ) : null
      }
    />
  );
  if (!allowed)
    return (
      <>
        {heading("Support tickets aren't available for your role.")}
        <Panel>
          <Empty title="Not available">Your account can't open support tickets. Contact your operations manager.</Empty>
        </Panel>
      </>
    );
  if (tickets.error && !tickets.data)
    return (
      <>
        {heading("Ticket data could not be loaded.")}
        <Panel>
          <Empty title="Couldn't load the tickets">{describe(tickets.error)} We'll try again shortly.</Empty>
        </Panel>
      </>
    );
  const loading = tickets.isLoading;
  const openCount = list.filter(t => !["Resolved", "Closed"].includes(t.statusLabel)).length;
  const changed = (detail?: Detail | null) => {
    if (detail) {
      qc.setQueryData(["support", "ticket", detail.number], detail);
      setSelected(detail.number);
    }
    void qc.invalidateQueries({ queryKey: ["support", "tickets"] });
  };
  return (
    <>
      {heading()}
      <div className="metrics">
        <Metric label="Total tickets" value={loading ? "–" : list.length} icon="message" />
        <Metric label="Needs attention" value={loading ? "–" : openCount} icon="alert" />
        <Metric label="Waiting for requester" value={loading ? "–" : list.filter(t => t.statusLabel === "Waiting for requester").length} icon="clock" />
      </div>
      {composer && !staff ? <Composer done={d => (setComposer(false), changed(d))} /> : null}
      <div className="support-layout">
        <Panel title="Tickets" subtitle={staff ? "All support requests" : "Your support conversations"} className="support-list">
          {loading ? (
            <Loading rows={4} />
          ) : list.length ? (
            <div className="support-tickets">
              {list.map(t => (
                <button key={t.number} type="button" className={`support-ticket${t.number === selected ? " selected" : ""}`} onClick={() => select(t.number)}>
                  <span className="row" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
                    <strong>{t.number}</strong>
                    <span className="row" style={{ gap: 4 }}>
                      {staff && t.sla?.state === "breached" ? <Pill tone="bad">SLA breached</Pill> : staff && t.sla?.state === "paused" ? <Pill tone="warn">SLA paused</Pill> : null}
                      <Pill tone={tone(t.statusLabel)}>{t.statusLabel}</Pill>
                    </span>
                  </span>
                  <strong className="support-subject">{t.subject}</strong>
                  <span className="faint">
                    {t.requester.name} · {t.category}
                    {t.relatedRef ? ` · ${t.relatedRef}` : ""}
                  </span>
                  <span className="faint support-preview">{t.lastMessage?.preview || ""}</span>
                  <small className="faint">
                    {when(t.updatedAt)} · {t.messageCount} message{t.messageCount === 1 ? "" : "s"}
                  </small>
                </button>
              ))}
            </div>
          ) : (
            <Empty title="No support tickets yet">{staff ? "New tickets from merchants, riders, and customers will appear here." : "Create a ticket and your conversation with operations will appear here."}</Empty>
          )}
        </Panel>
        <Panel className="support-thread">
          {ticket ? (
            <Thread key={ticket.number} ticket={ticket} staff={staff} changed={changed} />
          ) : (
            <Empty title="Select a support ticket">Choose a ticket from the list to view its conversation and reply.</Empty>
          )}
        </Panel>
      </div>
      <p className="faint" style={{ margin: "10px 2px 0", fontSize: 12.5 }}>
        {staff ? "Replies go to the requester's support page. Internal notes are visible to support staff only." : "Replies from Delivery Fast support appear in this conversation."}
      </p>
    </>
  );
}

function Composer({ done }: { done: (d: Detail) => void }) {
  const [form, setForm] = useState({ subject: "", category: CATEGORIES[0], priority: "Normal", relatedRef: "", message: "" });
  const files = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const subject = form.subject.trim();
    const message = form.message.trim();
    if (subject.length < 3 || !message) return setError("Add a subject and message before submitting.");
    setBusy(true);
    setError("");
    try {
      const attachments = await readFiles(files.current?.files ?? null);
      const relatedRef = form.relatedRef.trim().toUpperCase();
      const ticket = await api<Detail>("/support/tickets", { method: "POST", body: { subject, category: form.category, priority: form.priority, message, attachments, ...(relatedRef ? { relatedRef } : {}) } });
      toast(`${ticket.number} created. Courier operations can now respond.`, "good");
      done(ticket);
    } catch (err) {
      setError(err instanceof Error && !("status" in err) ? err.message : describe(err));
      setBusy(false);
    }
  }
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm(f => ({ ...f, [k]: e.target.value }));
  return (
    <Panel title="New support ticket">
      <form onSubmit={submit} style={{ padding: 16 }} noValidate>
        <div className="form-grid">
          <label className="field full">
            <span>Subject</span>
            <input className="input" maxLength={120} value={form.subject} onChange={set("subject")} placeholder="Briefly describe the issue" />
          </label>
          <label className="field">
            <span>Category</span>
            <Select className="select" value={form.category} onChange={set("category")}>
              {CATEGORIES.map(c => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </label>
          <label className="field">
            <span>Priority</span>
            <Select className="select" value={form.priority} onChange={set("priority")}>
              <option>Normal</option>
              <option>High</option>
              <option>Low</option>
            </Select>
          </label>
          <label className="field full">
            <span>Tracking or reference number (optional)</span>
            <input className="input" maxLength={40} value={form.relatedRef} onChange={set("relatedRef")} placeholder="e.g. PP-28491" />
          </label>
          <label className="field full">
            <span>Message</span>
            <textarea className="textarea" maxLength={3000} rows={4} value={form.message} onChange={set("message")} placeholder="Tell us what happened and how we can help" />
          </label>
          <label className="field full">
            <span>Attachments (optional)</span>
            <input ref={files} className="input" type="file" accept={ACCEPT} multiple />
            <small>Photos, PDF, Word, Excel, PowerPoint, CSV or text · up to 5 files, 5 MB each</small>
          </label>
        </div>
        {error ? (
          <p role="alert" style={{ color: "var(--bad)", margin: "10px 0 0" }}>
            {error}
          </p>
        ) : null}
        <div className="row" style={{ justifyContent: "space-between", marginTop: 12 }}>
          <span className="faint">Courier operations replies in this conversation.</span>
          <Button type="submit" variant="primary" disabled={busy}>
            Create support ticket
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function Thread({ ticket, staff, changed }: { ticket: Ticket; staff: boolean; changed: (d?: Detail | null) => void }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ["support", "ticket", ticket.number, ticket.updatedAt], queryFn: () => api<Detail>(`/support/tickets/${encodeURIComponent(ticket.number)}`), staleTime: 60_000 });
  const assignees = useQuery({ queryKey: ["support", "assignees"], queryFn: () => api<{ id: string; name: string }[]>("/support/assignees"), enabled: staff, staleTime: 10 * 60_000 });
  const canned = useQuery({ queryKey: ["support", "canned"], queryFn: () => api<{ id: string; title: string; body: string; shortcut?: string | null }[]>("/support/canned-responses"), enabled: staff, staleTime: 10 * 60_000 });
  const application = useQuery({
    queryKey: ["support", "application", ticket.number],
    queryFn: () => api<Application>(`/applications/${encodeURIComponent(ticket.number)}`),
    enabled: staff && APPLICATION_CATEGORIES.includes(ticket.category),
    retry: false,
  });
  const [reply, setReply] = useState("");
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const files = useRef<HTMLInputElement>(null);
  const status = ticket.statusLabel;
  const locked = status === "Closed";

  async function update(body: Record<string, unknown>, message: (d: Detail) => string) {
    try {
      const d = await api<Detail>(`/support/tickets/${encodeURIComponent(ticket.number)}`, { method: "PATCH", body });
      changed(d);
      toast(message(d), "good");
    } catch (e) {
      toastError(e);
    }
  }
  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const body = reply.trim();
    if (!body) return toast("Write a message before sending your reply.", "bad");
    setBusy(true);
    try {
      const attachments = await readFiles(files.current?.files ?? null);
      const d = await api<Detail>(`/support/tickets/${encodeURIComponent(ticket.number)}/messages`, { method: "POST", body: { body, attachments, internal: staff && internal } });
      setReply("");
      setInternal(false);
      if (files.current) files.current.value = "";
      changed(d);
      toast(staff && internal ? "Internal note added." : "Reply added to the support conversation.", "good");
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }
  async function saveCanned() {
    const body = reply.trim();
    if (!body) return toast("Write the reply you want to save first.");
    const title = await prompt({ title: "Save as a canned response", label: "Title", value: body.slice(0, 40), ok: "Save" });
    if (!title) return;
    try {
      const row = await api<{ title: string }>("/support/canned-responses", { method: "POST", body: { title: title.slice(0, 80), body } });
      void qc.invalidateQueries({ queryKey: ["support", "canned"] });
      toast(`Saved "${row.title}".`, "good");
    } catch (e) {
      toastError(e);
    }
  }
  async function decide(app: Application, next: string) {
    const needsMessage = next === "INFO_REQUESTED" || next === "REJECTED";
    const titles: Record<string, string> = { INFO_REQUESTED: "Ask the applicant for information", REJECTED: "Reject the application", APPROVED: "Approve the application" };
    const message = await prompt({ title: titles[next] || `${app.number}: update status`, message: "The applicant receives this message.", label: "Message to the applicant", required: needsMessage, multiline: true, ok: next === "REJECTED" ? "Reject" : "Send" });
    if (message === null || (needsMessage && !message)) return;
    try {
      const r = await api<Application>(`/applications/${encodeURIComponent(app.number)}/status`, { method: "POST", body: { status: next, ...(message ? { message: message.slice(0, 1000) } : {}) } });
      qc.setQueryData(["support", "application", ticket.number], r);
      changed(null);
      toast(`${app.number}: ${r.statusLabel}.`, "good");
    } catch (e) {
      toastError(e);
    }
  }
  const people = [...(assignees.data ?? [])];
  if (ticket.assignee && !people.some(p => p.id === ticket.assignee!.id)) people.unshift(ticket.assignee);
  if (user && !people.some(p => p.id === user.id)) people.unshift({ id: user.id, name: user.name });
  const sla = ticket.sla;
  const app = application.data;
  const appLabels: Record<string, string> = { UNDER_REVIEW: "Start review", INFO_REQUESTED: "Request information", APPROVED: app?.kind === "RIDER" ? "Approve & create rider" : "Approve", REJECTED: "Reject" };

  return (
    <div className="stack" style={{ padding: 16 }}>
      <div className="stack" style={{ gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <Pill tone={tone(status)}>{status}</Pill>
          <h2 style={{ margin: "6px 0 2px", fontSize: 17 }}>{ticket.subject}</h2>
          <p className="faint" style={{ margin: 0 }}>
            {ticket.number} · {ticket.requester.name}
            {staff && ticket.requester.phone ? ` · ${localPhone(ticket.requester.phone)}` : ""} · {ticket.category}
            {ticket.relatedRef ? ` · ${ticket.relatedRef}` : ""}
          </p>
          {staff && sla ? (
            <p style={{ margin: "4px 0 0", fontSize: 12.5, color: sla.state === "breached" ? "var(--bad)" : "var(--muted)" }}>
              {[
                sla.firstResponseAt ? `First response ${when(sla.firstResponseAt)}${sla.firstResponseBreached ? " (late)" : ""}` : `First response due ${when(sla.firstResponseDueAt)}`,
                !["Resolved", "Closed"].includes(status) ? (sla.paused ? "Resolution clock paused (waiting for requester)" : `Resolve by ${when(sla.resolutionDueAt)}`) : null,
                sla.escalationLevel ? `Escalated ×${sla.escalationLevel}` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          ) : null}
        </div>
        {staff ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, paddingBottom: 12, borderBottom: "1px solid var(--line)" }}>
            <label className="field">
              <span>Ticket status</span>
              <Select className="select sm" value={status} onChange={e => e.target.value !== status && void update({ status: e.target.value }, d => `${ticket.number} status updated to ${d.statusLabel}.`)}>
                {STATUSES.map(s => (
                  <option key={s}>{s}</option>
                ))}
              </Select>
            </label>
            <label className="field">
              <span>Priority</span>
              <Select className="select sm" value={ticket.priority} onChange={e => void update({ priority: e.target.value }, () => `${ticket.number} priority set to ${PRIORITIES.find(p => p[0] === e.target.value)?.[1] ?? e.target.value}.`)}>
                {PRIORITIES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
            </label>
            <label className="field">
              <span>Assigned to</span>
              <Select className="select sm" value={ticket.assignee?.id ?? ""} onChange={e => void update({ assigneeId: e.target.value || null }, d => (d.assignee ? `${ticket.number} assigned to ${d.assignee.name}.` : `${ticket.number} is now unassigned.`))}>
                <option value="">Unassigned</option>
                {people.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.id === user?.id ? `${p.name} (me)` : p.name}
                  </option>
                ))}
              </Select>
            </label>
          </div>
        ) : null}
      </div>

      {staff && APPLICATION_CATEGORIES.includes(ticket.category) ? (
        app ? (
          <div style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 12, background: "var(--surface-2, #f8fafc)" }}>
            <strong>
              {app.kind === "RIDER" ? "Rider" : "Franchise"} application · {app.statusLabel}
            </strong>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "4px 14px", margin: "8px 0", fontSize: 13 }}>
              {Object.entries(app.details || {}).map(([k, v]) => (
                <span key={k}>
                  <em className="faint">{k}</em> {v}
                </span>
              ))}
            </div>
            {app.decisionNote ? <p className="faint" style={{ margin: "0 0 8px" }}>{app.decisionNote}</p> : null}
            <div className="row">
              {(app.allowedNext || []).map(s => (
                <Button key={s} size="sm" variant={s === "REJECTED" ? "danger" : s === "APPROVED" ? "primary" : "default"} onClick={() => decide(app, s)}>
                  {appLabels[s] || s}
                </Button>
              ))}
            </div>
          </div>
        ) : (
          <p className="faint">Loading application…</p>
        )
      ) : null}

      <div className="support-messages">
        {detail.isLoading ? (
          <p className="faint">Loading conversation…</p>
        ) : detail.error ? (
          <p style={{ color: "var(--bad)" }}>{describe(detail.error)}</p>
        ) : (
          detail.data?.messages.map(m => {
            const system = m.author.kind === "system";
            const mine = !!m.author.id && m.author.id === user?.id;
            return (
              <article key={m.id} className={`support-message${mine ? " mine" : ""}${m.internal ? " internal" : ""}`}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <strong>
                    {system ? "Delivery Fast support" : m.author.label}
                    {m.internal ? (
                      <em style={{ marginLeft: 6, fontSize: 11.5, color: "#8a5a00", fontStyle: "normal" }}>
                        Internal note
                      </em>
                    ) : null}
                  </strong>
                  <span className="faint" style={{ fontSize: 12 }}>
                    {when(m.createdAt)}
                  </span>
                </div>
                <p style={{ margin: "6px 0 0", whiteSpace: "pre-wrap" }}>{m.body}</p>
                {m.attachments?.length ? (
                  <div className="row" style={{ marginTop: 6 }}>
                    {m.attachments.map(f => (
                      <a key={f.id} href={`/api/v1/files/${f.id}`} className="button sm" onClick={e => (e.preventDefault(), void downloadAttachment(f.id).catch(toastError))}>
                        {f.filename}
                      </a>
                    ))}
                  </div>
                ) : null}
              </article>
            );
          })
        )}
      </div>

      {!staff && ["Resolved", "Closed"].includes(status) ? <Csat ticket={ticket} changed={changed} /> : null}

      {locked ? (
        <div className="faint" style={{ padding: 12, border: "1px dashed var(--line-strong)", borderRadius: 10, textAlign: "center" }}>
          This ticket is closed. Operations can reopen it by changing the status.
        </div>
      ) : (
        <form onSubmit={send} className="stack" style={{ gap: 8 }}>
          <label className="field">
            <span className="sr-only">Write a reply</span>
            <textarea className="textarea" maxLength={3000} rows={3} value={reply} onChange={e => setReply(e.target.value)} placeholder="Write a reply to this conversation" />
          </label>
          <input ref={files} className="input" type="file" accept={ACCEPT} multiple aria-label="Attach files" title="Photos, PDF, Office, CSV or text · up to 5 files, 5 MB each" />
          <div className="row" style={{ justifyContent: "flex-end" }}>
            {staff ? (
              <>
                <Select
                  className="select sm"
                  style={{ width: "auto", marginRight: "auto" }}
                  value=""
                  aria-label="Insert a canned response"
                  onChange={e => {
                    const row = canned.data?.find(r => r.id === e.target.value);
                    if (row) setReply(v => (v ? `${v.trimEnd()}\n\n${row.body}` : row.body));
                  }}
                >
                  <option value="" hidden>Insert canned response…</option>
                  {(canned.data ?? []).map(r => (
                    <option key={r.id} value={r.id}>
                      {r.title}
                      {r.shortcut ? ` (/${r.shortcut})` : ""}
                    </option>
                  ))}
                </Select>
                <Button size="sm" onClick={saveCanned}>
                  Save as canned
                </Button>
                <label className="check">
                  <input type="checkbox" checked={internal} onChange={e => setInternal(e.target.checked)} /> Internal note (staff only)
                </label>
              </>
            ) : null}
            <Button type="submit" variant="primary" disabled={busy}>
              Send reply
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

function Csat({ ticket, changed }: { ticket: Ticket; changed: (d?: Detail | null) => void }) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const rated = ticket.survey?.rating;
  if (rated)
    return (
      <div style={{ padding: 12, border: "1px solid var(--line)", borderRadius: 10 }}>
        <strong>Thanks for your feedback</strong>{" "}
        <span className="faint">
          You rated this conversation {"★".repeat(rated)}
          {"☆".repeat(5 - rated)}
        </span>
      </div>
    );
  return (
    <form
      style={{ padding: 12, border: "1px solid var(--line)", borderRadius: 10, display: "grid", gap: 8 }}
      onSubmit={async e => {
        e.preventDefault();
        if (!rating) return toast("Choose a rating.", "bad");
        try {
          const d = await api<Detail>(`/support/tickets/${encodeURIComponent(ticket.number)}/csat`, { method: "POST", body: { rating, ...(comment.trim() ? { comment: comment.trim() } : {}) } });
          changed(d);
          toast("Thank you for rating our support.", "good");
        } catch (err) {
          toastError(err);
        }
      }}
    >
      <strong>How did we do?</strong>
      <span className="row">
        {[1, 2, 3, 4, 5].map(n => (
          <label key={n} className="check">
            <input type="radio" name="rating" checked={rating === n} onChange={() => setRating(n)} /> {n}★
          </label>
        ))}
      </span>
      <input className="input" maxLength={1000} value={comment} onChange={e => setComment(e.target.value)} placeholder="Anything we could do better? (optional)" />
      <div>
        <Button type="submit" size="sm">
          Send rating
        </Button>
      </div>
    </form>
  );
}
