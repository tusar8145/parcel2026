/**
 * Global notifications (bridge-notifications.js, GET /notifications/events): every message in tabs by group, Parcel
 * first (the former Parcel notifications page), with counts, search and filters (channel, customised, switched off,
 * security), per event × channel on / off (PUT /notifications/templates/:event/:channel { enabled }), the text on
 * hover, and the template editor: variables, preview (POST /notifications/preview), save, reset to default.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, describe } from "@panel/lib/api";
import { confirm } from "@panel/ui/dialogs";
import { Button, Loading, PageHeading, Panel, Pill } from "@panel/ui/kit";
import { Select } from "@panel/ui/Select";
import { toast, toastError } from "@panel/ui/toast";

type Channel = "sms" | "email" | "push";
const CHANNEL_NAME: Record<Channel, string> = { sms: "SMS", email: "Email", push: "Push" };
interface ChannelView {
  enabledByAdmin: boolean;
  locked?: boolean;
  customized?: boolean;
  updatedAt?: string | null;
  subject?: string;
  body?: string;
  html?: string;
}
interface EventView {
  event: string;
  label: string;
  group: string;
  audience: string;
  mandatory?: boolean;
  vars: string[];
  required: string[];
  channels: Partial<Record<Channel, ChannelView>>;
}
interface Catalog {
  groups?: string[];
  events: EventView[];
  commonVars: string[];
  channels: Record<string, boolean>;
}
const PARCEL_GROUP = "Parcel";
const when = (value?: string | null) => (value ? new Date(value).toLocaleString("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "Never");
const isCustomized = (e: EventView) => Object.values(e.channels).some(c => c?.customized);
const isDisabled = (e: EventView) => Object.values(e.channels).some(c => c && !c.locked && !c.enabledByAdmin);

export const GlobalNotifications = () => <Messages />;
export default GlobalNotifications;

function Messages() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "notification-events"], queryFn: () => api<Catalog>("/notifications/events") });
  const [F, setF] = useState({ q: "", channel: "", state: "", group: "" });
  const [editing, setEditing] = useState<{ event: string; channel: Channel } | null>(null);
  const [busy, setBusy] = useState("");
  const [hover, setHover] = useState<{ e: EventView; rect: DOMRect } | null>(null);
  const editor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (editing) editor.current?.scrollIntoView({ block: "nearest" });
  }, [editing]);

  const c = q.data;
  const replaceEvent = (view: EventView) => qc.setQueryData<Catalog>(["admin", "notification-events"], old => (old ? { ...old, events: old.events.map(e => (e.event === view.event ? view : e)) } : old));

  const heading = (
    <PageHeading
      eyebrow="Notification settings"
      title="Global notifications"
      subtitle="Every message the platform sends, by group: parcels (booked, picked up, out for delivery, delivered, returned…), merchants, money, support, accounts, operations, riders and partners. The SMS / email on / off switches and limits are in Integration settings."
    />
  );
  if (!c) return <>{heading}{q.error ? <div className="callout bad">{describe(q.error)}</div> : <Loading rows={6} />}</>;

  const order = c.groups || [];
  const groups: { name: string; events: EventView[] }[] = [];
  for (const e of c.events) {
    let g = groups.find(x => x.name === e.group);
    if (!g) groups.push((g = { name: e.group, events: [] }));
    g.events.push(e);
  }
  // Parcel first, then the catalog's order.
  const rank = (name: string) => (name === PARCEL_GROUP ? -1 : order.indexOf(name) + 1 || 99);
  groups.sort((a, b) => rank(a.name) - rank(b.name));
  const tabbed = groups.length > 1;
  const group = tabbed && !groups.some(g => g.name === F.group) ? groups[0]?.name || "" : F.group;
  const shownGroups = tabbed ? groups.filter(g => g.name === group) : groups;
  const scoped = shownGroups.reduce((n, g) => n + g.events.length, 0);
  const words = F.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const match = (e: EventView, g: string) =>
    words.every(w => `${e.label} ${e.event} ${e.audience} ${g}`.toLowerCase().includes(w)) &&
    (!F.channel || !!e.channels[F.channel as Channel]) &&
    (F.state !== "customised" || isCustomized(e)) &&
    (F.state !== "disabled" || isDisabled(e)) &&
    (F.state !== "security" || !!e.mandatory);
  const shown = shownGroups.reduce((n, g) => n + g.events.filter(e => match(e, g.name)).length, 0);
  const off = (["sms", "email"] as const).filter(ch => !c.channels[ch]).map(ch => CHANNEL_NAME[ch]);
  const note = off.length
    ? `${off.join(" and ")} is switched off in Integration settings: no ${off.join(" or ")} is sent.`
    : `${group} messages (${scoped}). Switch them on or off per channel (SMS, email, push to the apps) and edit their texts. Push uses the in-app notification's text; codes are never pushed. Security messages (codes, alerts) are always sent.`;

  async function toggle(e: EventView, channel: Channel, enabled: boolean) {
    setBusy(`${e.event}|${channel}`);
    try {
      const view = await api<EventView>(`/notifications/templates/${encodeURIComponent(e.event)}/${channel}`, { method: "PUT", body: { enabled } });
      replaceEvent(view);
      toast(`${view.label} ${CHANNEL_NAME[channel]} ${enabled ? "switched on" : "switched off"}.`);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy("");
    }
  }
  const cell = (e: EventView, channel: Channel) => {
    const ch = e.channels[channel];
    if (!ch) return <td className="faint">No {CHANNEL_NAME[channel].toLowerCase()}</td>;
    return (
      <td>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <label className="check" style={{ whiteSpace: "nowrap" }}>
          <input type="checkbox" checked={ch.enabledByAdmin || !!ch.locked} disabled={!!ch.locked || busy === `${e.event}|${channel}`} onChange={x => void toggle(e, channel, x.target.checked)} /> {ch.locked ? "Always on" : "On"}
        </label>
        {channel === "push" ? (
          <span className="sub" title="The push shows the same title and text as the in-app notification">
            Bell text
          </span>
        ) : (
          <Button size="sm" onClick={() => setEditing({ event: e.event, channel })}>
            Edit{ch.customized ? " · customised" : ""}
          </Button>
        )}
        </div>
      </td>
    );
  };
  const badges = (e: EventView) => (
    <>
      {e.mandatory ? <Pill tone="good">Security · always sent</Pill> : null} {isCustomized(e) ? <Pill>Customised</Pill> : null}{" "}
      {isDisabled(e) ? <Pill tone="warn">{Object.values(e.channels).every(x => x && !x.locked && !x.enabledByAdmin) ? "Off" : "Partly off"}</Pill> : null}
    </>
  );
  const editingEvent = editing && c.events.find(e => e.event === editing.event);

  return (
    <>
      {heading}
      <Panel
        title="Notification messages"
        subtitle={note}
        tools={
          <>
            <input className="input sm" type="search" placeholder="Search messages..." aria-label="Search notification messages" value={F.q} onChange={e => setF({ ...F, q: e.target.value })} style={{ width: 190 }} />
            <Select className="select sm" aria-label="Filter by channel" value={F.channel} onChange={e => setF({ ...F, channel: e.target.value })}>
              <option value="">All channels</option>
              <option value="sms">Has SMS</option>
              <option value="email">Has email</option>
              <option value="push">Has push</option>
            </Select>
            <Select className="select sm" aria-label="Filter by state" value={F.state} onChange={e => setF({ ...F, state: e.target.value })}>
              <option value="">All messages</option>
              <option value="customised">Customised</option>
              <option value="disabled">Switched off</option>
              <option value="security">Security messages</option>
            </Select>
          </>
        }
        footer={<span>{shown === scoped ? `Showing all ${scoped} messages` : shown ? `Showing ${shown} of ${scoped} messages` : "No messages match the search and filters."}</span>}
      >
        {tabbed ? (
          <div style={{ padding: "12px 16px 0" }}>
            <div className="seg-tabs" role="tablist" aria-label="Message groups">
              {groups.map(g => (
                <button key={g.name} type="button" role="tab" aria-selected={g.name === group} className={g.name === group ? "on" : ""} onClick={() => setF({ ...F, group: g.name })}>
                  {g.name} <span className="nav-count" style={{ marginLeft: 4 }}>{g.events.length}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Message</th>
                <th>Recipient</th>
                <th>SMS</th>
                <th>Email</th>
                <th>Push</th>
              </tr>
            </thead>
            <tbody>
              {shownGroups.map(g => {
                const events = g.events.filter(e => match(e, g.name));
                if (!events.length) return null;
                return [
                  <tr key={`g-${g.name}`}>
                    <td colSpan={5} style={{ background: "var(--surface-2)" }}>
                      <strong>{g.name}</strong> <span className="faint">{`${g.events.length} message${g.events.length === 1 ? "" : "s"}`}</span>
                    </td>
                  </tr>,
                  ...events.map(e => (
                    <tr key={e.event}>
                      <td>
                        <div tabIndex={0} style={{ cursor: "help" }} onMouseEnter={x => setHover({ e, rect: x.currentTarget.getBoundingClientRect() })} onMouseLeave={() => setHover(null)} onFocus={x => setHover({ e, rect: x.currentTarget.getBoundingClientRect() })} onBlur={() => setHover(null)}>
                          <strong>{e.label}</strong> {badges(e)}
                          <span className="sub">
                            {e.event} · {Object.keys(e.channels).map(x => CHANNEL_NAME[x as Channel]).join(" + ")}
                          </span>
                        </div>
                      </td>
                      <td>{e.audience}</td>
                      {cell(e, "sms")}
                      {cell(e, "email")}
                      {cell(e, "push")}
                    </tr>
                  )),
                ];
              })}
            </tbody>
          </table>
        </div>
      </Panel>
      {editingEvent && editing ? (
        <div ref={editor} style={{ marginTop: 16 }}>
          <Editor key={`${editing.event}|${editing.channel}`} e={editingEvent} channel={editing.channel} commonVars={c.commonVars} onSaved={replaceEvent} onClose={() => setEditing(null)} />
        </div>
      ) : null}
      {hover ? <TemplateCard e={hover.e} rect={hover.rect} /> : null}
    </>
  );
}

const PREVIEW_LIMIT = 700;
const clip = (text: string) => (text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT).trimEnd()}… (Edit shows the full text)` : text);

/** Hover (or keyboard focus) on a message name shows its current SMS / email text. */
function TemplateCard({ e, rect }: { e: EventView; rect: DOMRect }) {
  const block = (title: string, ch: ChannelView, body: React.ReactNode) => (
    <div style={{ display: "grid", gap: 4 }}>
      <div className="row" style={{ gap: 6 }}>
        <strong style={{ fontSize: 12, letterSpacing: ".04em", textTransform: "uppercase" }}>{title}</strong>
        {ch.customized ? <Pill>Customised</Pill> : <span className="faint">Default text</span>}
        {!ch.locked && !ch.enabledByAdmin ? <Pill tone="warn">Off</Pill> : null}
      </div>
      {body}
    </div>
  );
  const text = (v?: string) => <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 13, lineHeight: 1.5 }}>{clip(v || "")}</div>;
  const top = rect.bottom + 8 + 300 > window.innerHeight ? Math.max(16, rect.top - 308) : rect.bottom + 8;
  return createPortal(
    <div role="tooltip" style={{ position: "fixed", zIndex: 60, left: Math.max(16, Math.min(rect.left, window.innerWidth - 456)), top, maxWidth: "min(440px, calc(100vw - 32px))", maxHeight: 300, overflow: "auto", display: "grid", gap: 10, padding: "12px 14px", background: "#fff", border: "1px solid var(--line)", borderRadius: 10, boxShadow: "0 14px 40px #1018282e", pointerEvents: "none" }}>
      <div style={{ fontSize: 13, fontWeight: 700 }}>{e.label}</div>
      {e.channels.sms ? block("SMS", e.channels.sms, text(e.channels.sms.body)) : null}
      {e.channels.email
        ? block(
            "Email",
            e.channels.email,
            <>
              <div style={{ fontSize: 13 }}>
                <span className="faint">Subject:</span> {e.channels.email.subject}
              </div>
              {text(e.channels.email.body)}
            </>,
          )
        : null}
      {e.channels.push ? block("Push", e.channels.push, text("To the apps of signed-in recipients, with the in-app notification's title and text.")) : null}
    </div>,
    document.body,
  );
}

function Editor({ e, channel, commonVars, onSaved, onClose }: { e: EventView; channel: Channel; commonVars: string[]; onSaved: (v: EventView) => void; onClose: () => void }) {
  const ch = e.channels[channel]!;
  const email = channel === "email";
  const [subject, setSubject] = useState(ch.subject ?? "");
  const [body, setBody] = useState(ch.body ?? "");
  const [html, setHtml] = useState(ch.html ?? "");
  const [busy, setBusy] = useState("");
  const [preview, setPreview] = useState<React.ReactNode>(null);
  const last = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const emailBox = useRef<HTMLDivElement>(null);
  const vars = [...e.vars, ...commonVars];
  const draft = () => (email ? { subject, body, html } : { body });

  function insert(v: string) {
    const field = last.current || bodyRef.current;
    if (!field) return;
    const token = `{{${v}}}`;
    const at = field.selectionStart ?? field.value.length;
    const next = field.value.slice(0, at) + token + field.value.slice(field.selectionEnd ?? at);
    if (field.id === "ntSubject") setSubject(next);
    else if (field.id === "ntHtml") setHtml(next);
    else setBody(next);
    requestAnimationFrame(() => {
      field.focus();
      field.selectionStart = field.selectionEnd = at + token.length;
    });
  }
  async function save(ev: FormEvent) {
    ev.preventDefault();
    if (email && !subject.trim()) return toast("Enter a subject", "bad");
    if (!body.trim()) return toast("Enter the message text", "bad");
    if (email && !html.trim()) return toast("Enter the HTML body", "bad");
    setBusy("save");
    try {
      onSaved(await api<EventView>(`/notifications/templates/${encodeURIComponent(e.event)}/${channel}`, { method: "PUT", body: draft() }));
      toast("Template saved.", "good");
    } catch (err) {
      setPreview(<p style={{ color: "#c2410c" }}>{describe(err)}</p>);
      toastError(err);
    } finally {
      setBusy("");
    }
  }
  async function runPreview() {
    setBusy("preview");
    try {
      const r = await api<{ body: string; subject?: string; html?: string; sms?: { length: number; encoding: string; segments: number } }>("/notifications/preview", { method: "POST", body: { event: e.event, channel, ...draft() } });
      if (channel === "sms" && r.sms) {
        setPreview(
          <div className="callout" style={{ marginTop: 10, display: "block" }}>
            <strong>SMS preview</strong>
            <p style={{ whiteSpace: "pre-wrap", margin: "6px 0" }}>{r.body}</p>
            <small className="faint">{`${r.sms.length} characters · ${r.sms.encoding} · ${r.sms.segments} SMS part${r.sms.segments === 1 ? "" : "s"}${r.sms.encoding === "UCS-2" ? " (Bangla/Unicode: 70 characters per part)" : ""}`}</small>
          </div>,
        );
      } else {
        setPreview(
          <div className="callout" style={{ marginTop: 10, display: "block" }}>
            <strong>Subject:</strong> {r.subject}
            <div ref={emailBox} role="document" aria-label="Email preview" style={{ display: "block", maxHeight: 420, overflow: "auto", marginTop: 8, border: "1px solid var(--line)", borderRadius: 9, background: "#fff" }} />
          </div>,
        );
        // Shadow DOM keeps the email styles apart from the page; scripts and handlers are stripped.
        requestAnimationFrame(() => {
          const host = emailBox.current;
          if (!host || host.shadowRoot) return;
          const doc = new DOMParser().parseFromString(r.html || "", "text/html");
          doc.querySelectorAll("script,iframe,object,embed,link,meta,base,form").forEach(el => el.remove());
          doc.querySelectorAll("*").forEach(el => {
            for (const attr of [...el.attributes]) if (/^on/i.test(attr.name) || (/^(href|src)$/i.test(attr.name) && /^\s*javascript:/i.test(attr.value))) el.removeAttribute(attr.name);
          });
          host.attachShadow({ mode: "open" }).innerHTML = doc.body.innerHTML;
        });
      }
    } catch (err) {
      setPreview(<p style={{ color: "#c2410c" }}>{describe(err)}</p>);
    } finally {
      setBusy("");
    }
  }
  async function reset() {
    if (!(await confirm({ title: "Restore the default text?", message: "Your edits to this message are replaced by the default text.", ok: "Restore default" }))) return;
    setBusy("reset");
    try {
      const view = await api<EventView>(`/notifications/templates/${encodeURIComponent(e.event)}/${channel}/reset`, { method: "POST" });
      onSaved(view);
      const c2 = view.channels[channel];
      setSubject(c2?.subject ?? "");
      setBody(c2?.body ?? "");
      setHtml(c2?.html ?? "");
      toast("Default text restored.", "good");
    } catch (err) {
      toastError(err);
    } finally {
      setBusy("");
    }
  }
  return (
    <Panel title={`${e.label} · ${CHANNEL_NAME[channel]}`} subtitle={`${e.audience}. ${ch.customized ? `Customised ${when(ch.updatedAt)}.` : "Default text."}`}>
      <form className="panel-body" style={{ display: "grid", gap: 12 }} onSubmit={ev => void save(ev)} noValidate>
        <p className="faint" style={{ margin: 0 }}>
          Variables (click to insert):{" "}
          {vars.map(v => (
            <button key={v} type="button" className="button sm" style={{ margin: "2px 4px 2px 0" }} onClick={() => insert(v)}>
              {`{{${v}}}`}
            </button>
          ))}
          {e.required.length ? ` · must include ${e.required.map(v => `{{${v}}}`).join(", ")}` : ""}. Optional text: {"{{#var}}…{{/var}}"} shows only when var has a value.
        </p>
        {email ? (
          <label className="field">
            <span>Subject</span>
            <input id="ntSubject" className="input" maxLength={200} value={subject} onChange={x => setSubject(x.target.value)} onFocus={x => (last.current = x.target)} />
          </label>
        ) : null}
        <label className="field">
          <span>{email ? "Plain-text body" : "SMS text"}</span>
          <textarea id="ntBody" ref={bodyRef} className="textarea" rows={5} maxLength={4000} value={body} onChange={x => setBody(x.target.value)} onFocus={x => (last.current = x.target)} />
        </label>
        {email ? (
          <label className="field">
            <span>HTML body</span>
            <textarea id="ntHtml" className="textarea" rows={7} maxLength={50000} value={html} onChange={x => setHtml(x.target.value)} onFocus={x => (last.current = x.target)} style={{ fontFamily: "monospace", fontSize: 12 }} />
          </label>
        ) : null}
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <Button type="submit" variant="primary" disabled={!!busy}>
            Save template
          </Button>
          <Button disabled={!!busy} onClick={() => void runPreview()}>
            Preview
          </Button>
          <Button disabled={!ch.customized || !!busy} onClick={() => void reset()}>
            Reset to default
          </Button>
          <Button onClick={onClose}>Close</Button>
        </div>
        <div aria-live="polite">{preview}</div>
      </form>
    </Panel>
  );
}
