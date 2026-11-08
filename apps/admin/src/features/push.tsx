/**
 * Push (bridge-push.js). Integration settings shows the Firebase part; Notification settings › Push notifications
 * sends messages and shows the history:
 * - Firebase: the service account file (uploaded or pasted; stored encrypted, never shown again), on / off, status
 *   (project, phones per app, last success / error) and a test push to a chosen person
 *   (GET / PUT /notifications/push, POST /notifications/push/test).
 * - Send a message to every merchant and rider, all merchants, all riders, or chosen people
 *   (POST /notifications/push/broadcasts; people from GET /notifications/push/recipients?q=).
 * - History (GET /notifications/push/broadcasts?limit=50).
 */
import { useState } from "react";
import { useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, describe } from "@panel/lib/api";
import { confirm } from "@panel/ui/dialogs";
import { Button, Loading, Panel, Pill, useDebounced } from "@panel/ui/kit";
import { toast, toastError } from "@panel/ui/toast";

const AUDIENCE: Record<string, string> = { ALL: "All merchants & riders", MERCHANTS: "All merchants", RIDERS: "All riders", USERS: "Chosen people" };
const when = (value?: string | null) => (value ? new Date(value).toLocaleString("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "Never");

interface PushStatus {
  active: boolean;
  source?: string;
  configured: boolean;
  enabled: boolean;
  projectId?: string | null;
  clientEmail?: string | null;
  devicesByApp?: Record<string, number>;
  lastSuccessAt?: string | null;
  lastErrorAt?: string | null;
  lastError?: string | null;
}
interface Recipient {
  id: string;
  name: string;
  detail: string;
  phone?: string | null;
  devices?: number;
}
interface Broadcast {
  id: string;
  createdAt: string;
  title: string;
  body: string;
  audience: string;
  chosen?: number;
  recipients: number;
  sending?: boolean;
  delivered: number;
  devices: number;
  failed: number;
  createdBy?: string | null;
}

const usePushStatus = () => useQuery({ queryKey: ["admin", "push"], queryFn: () => api<PushStatus>("/notifications/push") });
const useHistory = () => useQuery({ queryKey: ["admin", "push-history"], queryFn: async () => (await api<{ items: Broadcast[] }>("/notifications/push/broadcasts?limit=50")).items });

function People({ placeholder, mode, onPick }: { placeholder: string; mode: "send" | "test"; onPick: (u: Recipient) => void }) {
  const [text, setText] = useState("");
  const q = useDebounced(text.trim(), 300);
  const found = useQuery({ queryKey: ["admin", "push-recipients", q], enabled: q.length >= 2, queryFn: async () => (await api<{ items: Recipient[] }>(`/notifications/push/recipients?q=${encodeURIComponent(q)}`)).items });
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <input className="input" type="search" autoComplete="off" placeholder={placeholder} value={text} onChange={e => setText(e.target.value)} style={{ maxWidth: 340 }} />
      {q.length >= 2 && found.data ? (
        found.data.length ? (
          <div style={{ display: "grid", gap: 4, maxWidth: 620 }}>
            {found.data.map(u => (
              <button
                key={u.id}
                type="button"
                className="button sm"
                style={{ justifyContent: "space-between", display: "flex", textAlign: "left" }}
                onClick={() => {
                  onPick(u);
                  if (mode === "test") setText("");
                }}
              >
                <span>
                  <strong>{u.name}</strong> · {u.detail}
                  {u.phone ? ` · ${u.phone}` : ""}
                </span>
                <span className="faint">{u.devices ? `${u.devices} phone(s)` : "no app yet"}</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="faint" style={{ margin: 0 }}>
            Nobody found.
          </p>
        )
      ) : null}
    </div>
  );
}

/** Integration settings › Firebase push. */
export function FirebasePush() {
  const qc = useQueryClient();
  const q = usePushStatus();
  const [key, setKey] = useState("");
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [testUser, setTestUser] = useState<Recipient | null>(null);
  const [busy, setBusy] = useState("");
  const s = q.data;
  if (!s) return <Panel title="Firebase push">{q.error ? <p className="panel-body faint">{describe(q.error)}</p> : <Loading rows={3} />}</Panel>;
  const [label, tone] = s.active ? (s.source === "file" ? ["On (development key file)", undefined] : ["On", "good"]) : s.configured ? ["Off", "warn"] : ["Not set up", "bad"];
  const apps = s.devicesByApp || {};
  const on = enabled ?? s.enabled;
  async function save() {
    setBusy("save");
    try {
      const next = await api<PushStatus>("/notifications/push", { method: "PUT", body: { enabled: on, ...(key.trim() ? { serviceAccount: key.trim() } : {}) } });
      qc.setQueryData(["admin", "push"], next);
      setKey("");
      setEnabled(null);
      toast("Push settings saved.", "good");
    } catch (e) {
      toastError(e);
    } finally {
      setBusy("");
    }
  }
  async function test() {
    if (!testUser) return toast("Choose who gets the test first.", "bad");
    setBusy("test");
    try {
      const r = await api<{ delivered: number; failed: number }>("/notifications/push/test", { method: "POST", body: { userId: testUser.id } });
      toast(r.delivered ? `Test sent to ${r.delivered} phone(s).` : `Firebase refused the test (${r.failed} failed). See the last error.`, r.delivered ? "good" : "bad");
      void q.refetch();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy("");
    }
  }
  return (
    <Panel title="Firebase push" subtitle="Push notifications for the Delivery Fast Merchant, Rider and Operations apps (Firebase Cloud Messaging).">
      <div className="panel-body" style={{ display: "grid", gap: 12 }}>
        <p className="faint" style={{ margin: 0 }}>
          <Pill tone={tone as "good" | "warn" | "bad" | undefined}>{label}</Pill> <Pill tone={s.configured ? "good" : "warn"}>{s.configured ? "Key saved" : "No key"}</Pill>
          {s.projectId ? (
            <>
              {" "}
              · Project <strong>{s.projectId}</strong>
            </>
          ) : null}{" "}
          · Phones: {apps.merchant || 0} merchant, {apps.rider || 0} rider, {apps.operations || 0} operations · Last success: {when(s.lastSuccessAt)} · Last error: {when(s.lastErrorAt)}
          {s.lastError ? ` — ${s.lastError}` : ""}
        </p>
        <label className="field">
          <span>Service account file (Firebase › Project settings › Service accounts › Generate new private key)</span>
          <input type="file" accept=".json,application/json" onChange={async e => e.target.files?.[0] && setKey(await e.target.files[0].text())} />
          <textarea className="textarea" rows={3} style={{ fontFamily: "monospace", fontSize: 12 }} value={key} onChange={e => setKey(e.target.value)} placeholder={s.configured ? `Saved for ${s.clientEmail || ""} · choose a new file or paste it only to replace the key` : "…or paste the file's contents here"} />
        </label>
        <label className="check">
          <input type="checkbox" checked={on} onChange={e => setEnabled(e.target.checked)} /> Send push notifications
        </label>
        <div>
          <Button variant="primary" disabled={busy === "save"} onClick={() => void save()}>
            Save
          </Button>
        </div>
        <hr style={{ border: 0, borderTop: "1px solid var(--line)", margin: "4px 0" }} />
        <div style={{ display: "grid", gap: 6 }}>
          <strong>Send a test</strong>
          <span className="faint">Choose someone who has the app signed in on a phone.</span>
          <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-start" }}>
            <People placeholder="Name, phone, merchant or rider code" mode="test" onPick={setTestUser} />
            {testUser ? <span className="faint">To: {testUser.name}</span> : null}
            <Button disabled={busy === "test"} onClick={() => void test()}>
              Send test push
            </Button>
          </div>
        </div>
      </div>
    </Panel>
  );
}

/** Notification settings › Push notifications: send a message and the history. */
export function PushMessages() {
  const navigate = useNavigate();
  const status = usePushStatus();
  const history = useHistory();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [audience, setAudience] = useState("ALL");
  const [chosen, setChosen] = useState<Map<string, Recipient>>(new Map());
  const [busy, setBusy] = useState("");
  const ready = status.data ? status.data.configured && status.data.enabled : true;

  async function send() {
    if (title.trim().length < 3) return toast("Write a title (at least 3 characters).", "bad");
    if (!body.trim()) return toast("Write the message.", "bad");
    if (audience === "USERS" && !chosen.size) return toast("Choose at least one person.", "bad");
    const who = audience === "USERS" ? `${chosen.size} chosen people` : AUDIENCE[audience].toLowerCase();
    if (!(await confirm({ title: "Send this message?", message: `Send "${title.trim()}" to ${who}?`, ok: "Send message" }))) return;
    setBusy("send");
    try {
      const r = await api<{ recipients: number }>("/notifications/push/broadcasts", { method: "POST", body: { title: title.trim(), body: body.trim(), audience, userIds: audience === "USERS" ? [...chosen.keys()] : [] } });
      toast(`Sent to ${r.recipients} people. Phones are counted in the history.`, "good");
      setTitle("");
      setBody("");
      setChosen(new Map());
      void history.refetch();
      // The phone counts arrive when Firebase has answered.
      setTimeout(() => void history.refetch(), 4000);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy("");
    }
  }
  return (
    <>
      {!ready ? (
        <p className="faint" style={{ margin: "0 0 12px" }}>
          Firebase isn't sending yet, so messages reach notifications only.{" "}
          <Button size="sm" onClick={() => navigate("/integration-settings")}>
            Set it up
          </Button>
        </p>
      ) : null}
      <Panel title="Send a message" subtitle={`It appears in each person's notifications and as a push on their phone. Merchants get the push when their service plan has "Firebase push notifications".`}>
        <div className="panel-body" style={{ display: "grid", gap: 12 }}>
          <label className="field">
            <span>Title</span>
            <input className="input" maxLength={120} placeholder="e.g. Eid holiday schedule" value={title} onChange={e => setTitle(e.target.value)} />
          </label>
          <label className="field">
            <span>Message</span>
            <textarea className="textarea" maxLength={500} rows={3} placeholder="What do you want to tell them?" value={body} onChange={e => setBody(e.target.value)} />
          </label>
          <div>
            <strong style={{ display: "block", marginBottom: 6 }}>Send to</strong>
            {Object.entries(AUDIENCE).map(([k, label]) => (
              <label key={k} className="check" style={{ marginRight: 14 }}>
                <input type="radio" name="pushAudience" value={k} checked={audience === k} onChange={() => setAudience(k)} /> {label}
              </label>
            ))}
          </div>
          {audience === "USERS" ? (
            <div style={{ display: "grid", gap: 8 }}>
              <People placeholder="Search: name, phone, merchant or rider code" mode="send" onPick={u => setChosen(m => new Map(m).set(u.id, u))} />
              <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                {[...chosen.values()].map(u => (
                  <span key={u.id} className="pill" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                    {u.name} · {u.detail}
                    <button
                      type="button"
                      aria-label="Remove"
                      style={{ border: 0, background: "transparent", cursor: "pointer", fontWeight: 700 }}
                      onClick={() =>
                        setChosen(m => {
                          const n = new Map(m);
                          n.delete(u.id);
                          return n;
                        })
                      }
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          <div>
            <Button variant="primary" disabled={busy === "send"} onClick={() => void send()}>
              Send message
            </Button>
          </div>
        </div>
      </Panel>
      <div style={{ height: 16 }} />
      <Panel
        title="Message history"
        subtitle="Every message sent from here, newest first. Phones: pushes Firebase accepted of the phones it went to."
        tools={
          <Button size="sm" disabled={history.isFetching} onClick={() => void history.refetch()}>
            Refresh
          </Button>
        }
      >
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Sent</th>
                <th>Message</th>
                <th>To</th>
                <th>People</th>
                <th>Phones</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {(history.data ?? []).map(h => (
                <tr key={h.id}>
                  <td className="nowrap">{when(h.createdAt)}</td>
                  <td>
                    <strong>{h.title}</strong>
                    <span className="sub">{h.body}</span>
                  </td>
                  <td>
                    {AUDIENCE[h.audience] || h.audience}
                    {h.audience === "USERS" ? ` (${h.chosen})` : ""}
                  </td>
                  <td>{h.recipients}</td>
                  <td>
                    {h.sending ? (
                      <Pill>Sending…</Pill>
                    ) : (
                      <>
                        {h.delivered} of {h.devices}
                        {h.failed ? (
                          <>
                            {" · "}
                            <Pill tone="warn">{`${h.failed} failed`}</Pill>
                          </>
                        ) : null}
                      </>
                    )}
                  </td>
                  <td>{h.createdBy || ""}</td>
                </tr>
              ))}
              {history.data && !history.data.length ? (
                <tr>
                  <td colSpan={6} className="faint" style={{ textAlign: "center", padding: 18 }}>
                    No messages sent yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {history.error ? <p className="panel-body faint">{describe(history.error)}</p> : null}
      </Panel>
    </>
  );
}
