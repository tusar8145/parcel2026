/**
 * Integration settings (bridge-notifications.js gateways + bridge-push.js): the SMS (mram) and email (Mailjet)
 * gateways — status metrics, settings with write-only keys (PUT /notifications/gateways/:channel), health, and a test
 * message (POST /notifications/gateways/:channel/test) — and Firebase push.
 * Push notifications (Notification settings) is the sending page of the same module.
 */
import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, describe } from "@panel/lib/api";
import { Button, Loading, Metric, PageHeading, Panel, Pill } from "@panel/ui/kit";
import { toast, toastError } from "@panel/ui/toast";
import { bdPhoneProblem, normalizeBdPhone } from "@delivery-fast/shared/dist/phone.js";
import { FirebasePush, PushMessages } from "@/features/push";

interface Gateway {
  channel: "SMS" | "EMAIL";
  mode?: string;
  configured: boolean;
  enabled: boolean;
  settings: { apiKey?: string | null; apiSecret?: string | null; senderId?: string; baseUrl?: string; fromEmail?: string; fromName?: string };
  last24h: { sent: number; failed: number; pending: number };
  lastSuccessAt?: string | null;
  lastErrorAt?: string | null;
  lastError?: string | null;
  warning?: string | null;
}
const when = (value?: string | null) => (value ? new Date(value).toLocaleString("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "Never");
const STATUS = (g: Gateway): [string, "good" | "warn" | "bad" | undefined] => (g.mode === "live" ? ["Live", "good"] : g.configured && g.enabled ? ["Log only (development)", undefined] : g.configured ? ["Disabled", "warn"] : ["Not configured", "bad"]);
const urlProblem = (value: string) => {
  try {
    return /^https?:$/.test(new URL(value).protocol) ? "" : "Use an http(s) address";
  } catch {
    return "Enter a full address, e.g. https://…";
  }
};
const emailProblem = (value: string) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? "" : "Enter a valid email address");

export function Integrations() {
  const q = useQuery({ queryKey: ["admin", "gateways"], queryFn: () => api<Gateway[]>("/notifications/gateways") });
  return (
    <>
      <PageHeading eyebrow="Platform control" title="Integration settings" subtitle="The SMS (mram), email (Mailjet) and Firebase push connections: status, keys and a test message." />
      {q.error ? <div className="callout bad">{describe(q.error)}</div> : null}
      {!q.data ? (
        <Loading rows={6} />
      ) : (
        <>
          <div className="metrics">
            {q.data.map(g => (
              <Metric key={g.channel} label={g.channel === "SMS" ? "SMS · mram" : "Email · Mailjet"} value={STATUS(g)[0]} foot={`${g.last24h.sent} sent`} note={`${g.last24h.failed} failed · ${g.last24h.pending} waiting (24 h)`} />
            ))}
          </div>
          <div className="grid-2" style={{ alignItems: "start", marginBottom: 16 }}>
            {q.data.map(g => (
              <GatewayCard key={g.channel} g={g} reload={() => void q.refetch()} />
            ))}
          </div>
        </>
      )}
      <FirebasePush />
    </>
  );
}
export default Integrations;

export function PushNotifications() {
  return (
    <>
      <PageHeading eyebrow="Notification settings" title="Push notifications" subtitle="Send messages to merchants and riders, and see what was sent." />
      <PushMessages />
    </>
  );
}

function GatewayCard({ g, reload }: { g: Gateway; reload: () => void }) {
  const sms = g.channel === "SMS";
  const s = g.settings;
  const [label, tone] = STATUS(g);
  const [v, setV] = useState<Record<string, string>>({ senderId: s.senderId ?? "", baseUrl: s.baseUrl ?? "", fromEmail: s.fromEmail ?? "", fromName: s.fromName ?? "", apiKey: "", apiSecret: "" });
  const [enabled, setEnabled] = useState(g.enabled);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [to, setTo] = useState("");
  const [result, setResult] = useState<React.ReactNode>(null);
  const [busy, setBusy] = useState("");
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: e.target.value });

  async function save(e: FormEvent) {
    e.preventDefault();
    const out: Record<string, string> = { baseUrl: urlProblem(v.baseUrl.trim()) };
    if (sms) out.senderId = v.senderId.length > 30 ? "At most 30 characters" : "";
    else {
      out.fromEmail = v.fromEmail.trim() ? emailProblem(v.fromEmail) : "";
      out.fromName = v.fromName.trim() ? "" : "Enter a sender name";
    }
    setErrors(out);
    if (Object.values(out).some(Boolean)) return;
    const body = sms
      ? { enabled, senderId: v.senderId.trim(), baseUrl: v.baseUrl.trim(), ...(v.apiKey.trim() ? { apiKey: v.apiKey.trim() } : {}) }
      : { enabled, fromName: v.fromName.trim(), baseUrl: v.baseUrl.trim(), ...(v.fromEmail.trim() ? { fromEmail: v.fromEmail.trim() } : {}), ...(v.apiKey.trim() ? { apiKey: v.apiKey.trim() } : {}), ...(v.apiSecret.trim() ? { apiSecret: v.apiSecret.trim() } : {}) };
    setBusy("save");
    try {
      await api(`/notifications/gateways/${sms ? "sms" : "email"}`, { method: "PUT", body });
      toast(`${sms ? "SMS" : "Email"} gateway saved.`, "good");
      setV(x => ({ ...x, apiKey: "", apiSecret: "" }));
      reload();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy("");
    }
  }
  async function test(e: FormEvent) {
    e.preventDefault();
    const problem = sms ? bdPhoneProblem(to) : emailProblem(to);
    if (problem) return setErrors({ ...errors, to: problem });
    setErrors({ ...errors, to: "" });
    setBusy("test");
    try {
      const r = await api<{ ok: boolean; providerMessageId?: string; error?: string }>(`/notifications/gateways/${sms ? "sms" : "email"}/test`, { method: "POST", body: sms ? { phone: normalizeBdPhone(to) } : { email: to.trim() } });
      setResult(
        r.ok ? (
          <p>
            <Pill tone="good">Sent</Pill> {r.providerMessageId ? `Gateway reference ${r.providerMessageId}` : ""}
          </p>
        ) : (
          <p>
            <Pill tone="bad">Failed</Pill> {r.error || "The gateway rejected the message"}
          </p>
        ),
      );
      toast(r.ok ? `Test ${sms ? "sms" : "email"} sent.` : `Test ${sms ? "sms" : "email"} failed.`, r.ok ? "good" : "bad");
    } catch (err) {
      setResult(
        <p>
          <Pill tone="bad">Failed</Pill> {describe(err)}
        </p>,
      );
    } finally {
      setBusy("");
    }
  }
  const field = (k: string, label: string, props: Record<string, unknown> = {}) => (
    <label className="field">
      <span>{label}</span>
      <input className="input" value={v[k]} onChange={set(k)} aria-invalid={!!errors[k]} {...props} />
      {errors[k] ? <span className="error">{errors[k]}</span> : null}
    </label>
  );
  const key = (k: string, label: string, masked: string | null | undefined, placeholder: string) => field(k, label, { type: "password", autoComplete: "new-password", maxLength: 500, placeholder: masked ? `Saved (${masked}) · leave empty to keep` : placeholder });
  return (
    <Panel title={sms ? "SMS gateway · mram" : "Email gateway · Mailjet"} subtitle={sms ? "Codes, delivery codes and parcel updates by SMS." : "Account, invoice and parcel emails."}>
      <div className="panel-body" style={{ display: "grid", gap: 12 }}>
        <p className="faint" style={{ margin: 0 }}>
          <Pill tone={tone}>{label}</Pill> <Pill tone={g.configured ? "good" : "warn"}>{g.configured ? "Credentials saved" : "No credentials"}</Pill> · Last success: {when(g.lastSuccessAt)} · Last error: {when(g.lastErrorAt)}
          {g.lastError ? ` — ${g.lastError}` : ""}
        </p>
        {g.warning ? (
          <div className="callout" role="status">
            {g.warning}
          </div>
        ) : null}
        <form style={{ display: "grid", gap: 10 }} onSubmit={e => void save(e)} noValidate>
          <label className="check">
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> Send through {sms ? "mram" : "Mailjet"} in production
          </label>
          {sms ? (
            <>
              {key("apiKey", "API key", s.apiKey, "mram API key")}
              {field("senderId", "Sender ID", { maxLength: 30, placeholder: "Approved sender ID or masking" })}
              {field("baseUrl", "API base URL", { maxLength: 300 })}
            </>
          ) : (
            <>
              {key("apiKey", "API key", s.apiKey, "Mailjet API key")}
              {key("apiSecret", "Secret key", s.apiSecret, "Mailjet secret key")}
              {field("fromEmail", "From email", { type: "email", maxLength: 200, placeholder: "no-reply@your-domain" })}
              {field("fromName", "From name", { maxLength: 100 })}
              {field("baseUrl", "API base URL", { maxLength: 300 })}
            </>
          )}
          <div>
            <Button type="submit" variant="primary" disabled={busy === "save"}>
              Save {sms ? "SMS" : "email"} gateway
            </Button>
          </div>
        </form>
        <form style={{ display: "grid", gap: 8, marginTop: 6 }} onSubmit={e => void test(e)} noValidate>
          <label className="field">
            <span>{sms ? "Send a test SMS to" : "Send a test email to"}</span>
            <input className="input" type={sms ? "tel" : "email"} maxLength={200} placeholder={sms ? "17XXXXXXXX" : "you@example.com"} value={to} onChange={e => setTo(e.target.value)} aria-invalid={!!errors.to} />
            {errors.to ? <span className="error">{errors.to}</span> : null}
          </label>
          <div className="row" style={{ gap: 8 }}>
            <Button type="submit" disabled={!g.configured || busy === "test"}>
              Send test {sms ? "SMS" : "email"}
            </Button>
            <small className="faint">Sends one real message now{g.configured ? "" : " (save the credentials first)"}.</small>
          </div>
          <div aria-live="polite">{result}</div>
        </form>
      </div>
    </Panel>
  );
}
