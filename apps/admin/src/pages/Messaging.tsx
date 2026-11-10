/**
 * Messaging: send a message to a group or to chosen people, by push, SMS or email, each page with its history.
 * - Push messages: features/push (in-app notification + push).
 * - SMS / Email messages: POST /notifications/messages/{sms|email}/preview (the count, confirmed before sending),
 *   POST /notifications/messages/{sms|email} (queued in the outbox, sent by the gateway), GET … (history).
 * A gateway switched off in Integration settings sends nothing; the page says so and doesn't send.
 */
import { useState } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { api, describe } from "@panel/lib/api";
import { confirm } from "@panel/ui/dialogs";
import { Button, PageHeading, Panel, Pill } from "@panel/ui/kit";
import { toast, toastError } from "@panel/ui/toast";
import { People, PushMessages } from "@/features/push";

export function PushMessagesPage() {
  return (
    <>
      <PageHeading eyebrow="Messaging" title="Push messages" subtitle="A message in the apps' notifications and as a push on the phones of merchants, riders or chosen people. The history is below." />
      <PushMessages />
    </>
  );
}
export const SmsMessagesPage = () => <ChannelMessages channel="sms" />;
export const EmailMessagesPage = () => <ChannelMessages channel="email" />;

const AUDIENCE: Record<string, string> = {
  ALL: "All merchants & riders",
  MERCHANTS: "All merchants",
  BANKING: "Banking & Financial merchants",
  ECOMMERCE: "E-commerce merchants",
  RIDERS: "All riders",
  STAFF: "Staff (operations, hubs, finance, support, franchises)",
  CUSTOMERS: "Website customers",
  USERS: "Chosen people",
};
const when = (value?: string | null) => (value ? new Date(value).toLocaleString("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "");

interface Row {
  id: string;
  createdAt: string;
  subject?: string | null;
  body: string;
  audience: string;
  chosen: number;
  recipients: number;
  queued: number;
  sent: number;
  failed: number;
  pending: number;
  createdBy?: string | null;
}
interface Picked {
  id: string;
  name: string;
  detail: string;
}
interface Gateway {
  channel: "SMS" | "EMAIL";
  enabled: boolean;
  mode: string;
}

/** SMS segments: 160 characters (70 with Bangla), 153 / 67 each when longer. */
function segments(text: string) {
  if (!text) return 0;
  const unicode = /[^\u0000-\u007f]/.test(text);
  const one = unicode ? 70 : 160;
  const many = unicode ? 67 : 153;
  return text.length <= one ? 1 : Math.ceil(text.length / many);
}

function ChannelMessages({ channel }: { channel: "sms" | "email" }) {
  const sms = channel === "sms";
  const label = sms ? "SMS" : "Email";
  const navigate = useNavigate();
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [audience, setAudience] = useState("ALL");
  const [chosen, setChosen] = useState<Map<string, Picked>>(new Map());
  const [busy, setBusy] = useState(false);
  const history = useQuery({ queryKey: ["admin", "messages", channel], queryFn: async () => (await api<{ items: Row[] }>(`/notifications/messages/${channel}?limit=50`)).items });
  const gateways = useQuery({ queryKey: ["admin", "gateways"], queryFn: () => api<Gateway[]>("/notifications/gateways") });
  const gateway = gateways.data?.find(g => g.channel === (sms ? "SMS" : "EMAIL"));
  const off = gateway ? !gateway.enabled : false;
  const userIds = () => (audience === "USERS" ? [...chosen.keys()] : []);

  async function send() {
    if (!sms && !subject.trim()) return toast("Write the subject.", "bad");
    if (!body.trim()) return toast("Write the message.", "bad");
    if (audience === "USERS" && !chosen.size) return toast("Choose at least one person.", "bad");
    setBusy(true);
    try {
      const p = await api<{ matched: number; recipients: number; missing: number; gatewayOn: boolean }>(`/notifications/messages/${channel}/preview`, { method: "POST", body: { audience, userIds: userIds() } });
      if (!p.gatewayOn) return toast(`${label} is switched off in Integration settings.`, "bad");
      if (!p.recipients) return toast(`Nobody in this group has ${sms ? "a phone number" : "an email"}.`, "bad");
      const who = audience === "USERS" ? `${chosen.size} chosen people` : AUDIENCE[audience].toLowerCase();
      const parts = sms ? segments(body.trim()) : 0;
      const message =
        `Send this ${label.toLowerCase()} to ${who}: ${p.recipients} ${p.recipients === 1 ? "person" : "people"}` +
        (p.missing ? ` (${p.missing} more have no ${sms ? "phone" : "email"})` : "") +
        "." +
        (sms ? ` ${parts} SMS each, ${parts * p.recipients} in all.` : "");
      if (!(await confirm({ title: `Send ${label.toLowerCase()}?`, message, ok: `Send to ${p.recipients}` }))) return;
      const r = await api<Row>(`/notifications/messages/${channel}`, { method: "POST", body: { audience, userIds: userIds(), body: body.trim(), ...(sms ? {} : { subject: subject.trim() }) } });
      toast(`Queued for ${r.recipients} people.`, "good");
      setSubject("");
      setBody("");
      setChosen(new Map());
      void history.refetch();
      setTimeout(() => void history.refetch(), 5000);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeading
        eyebrow="Messaging"
        title={`${label} messages`}
        subtitle={`An ${sms ? "SMS" : "email"} to every merchant and rider, a group or chosen people, sent through the ${sms ? "mram SMS" : "Mailjet email"} gateway. The history is below.`}
      />
      {off ? (
        <p className="faint" style={{ margin: "0 0 12px" }}>
          {label} is switched off: nothing is sent.{" "}
          <Button size="sm" onClick={() => navigate("/integration-settings")}>
            Integration settings
          </Button>
        </p>
      ) : null}
      <Panel title={`Send ${sms ? "an SMS" : "an email"}`} subtitle="You see how many people it goes to before it is sent.">
        <div className="panel-body" style={{ display: "grid", gap: 12 }}>
          {!sms ? (
            <label className="field">
              <span>Subject</span>
              <input className="input" maxLength={150} placeholder="e.g. Eid holiday schedule" value={subject} onChange={e => setSubject(e.target.value)} />
            </label>
          ) : null}
          <label className="field">
            <span>Message</span>
            <textarea className="textarea" maxLength={sms ? 1000 : 2000} rows={sms ? 3 : 6} placeholder="What do you want to tell them?" value={body} onChange={e => setBody(e.target.value)} />
            {sms ? (
              <small className="faint">
                {body.length} characters · {segments(body)} SMS
              </small>
            ) : null}
          </label>
          <div>
            <strong style={{ display: "block", marginBottom: 6 }}>Send to</strong>
            <div style={{ display: "grid", gap: 4 }}>
              {Object.entries(AUDIENCE).map(([k, text]) => (
                <label key={k} className="check">
                  <input type="radio" name={`${channel}Audience`} value={k} checked={audience === k} onChange={() => setAudience(k)} /> {text}
                </label>
              ))}
            </div>
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
            <Button variant="primary" disabled={busy || off} onClick={() => void send()}>
              Send {label.toLowerCase()}
            </Button>
          </div>
        </div>
      </Panel>
      <div style={{ height: 16 }} />
      <Panel
        title="History"
        subtitle={`Every ${label.toLowerCase()} sent from here, newest first, with how many were sent, failed or are waiting.`}
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
                <th>Result</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {(history.data ?? []).map(h => (
                <tr key={h.id}>
                  <td className="nowrap">{when(h.createdAt)}</td>
                  <td>
                    {h.subject ? <strong>{h.subject}</strong> : null}
                    <span className={h.subject ? "sub" : undefined} style={{ whiteSpace: "pre-wrap" }}>
                      {h.body}
                    </span>
                  </td>
                  <td>
                    {AUDIENCE[h.audience] || h.audience}
                    {h.audience === "USERS" ? ` (${h.chosen})` : ""}
                  </td>
                  <td>{h.recipients}</td>
                  <td className="nowrap">
                    <Pill tone="good">{`${h.sent} sent`}</Pill> {h.failed ? <Pill tone="bad">{`${h.failed} failed`}</Pill> : null} {h.pending ? <Pill>{`${h.pending} waiting`}</Pill> : null}
                  </td>
                  <td>{h.createdBy || ""}</td>
                </tr>
              ))}
              {history.data && !history.data.length ? (
                <tr>
                  <td colSpan={6} className="faint" style={{ textAlign: "center", padding: 18 }}>
                    Nothing sent yet.
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
