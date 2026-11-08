/**
 * Channel & limits (bridge-notifications.js settingsTab): the platform-wide SMS / email switches (platform settings
 * `channels`, as the classic page saved them) and the SMS / OTP limits and message settings
 * (GET / PUT /notifications/settings).
 */
import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, describe } from "@panel/lib/api";
import { Button, Loading, PageHeading, Panel } from "@panel/ui/kit";
import { toast, toastError } from "@panel/ui/toast";
import { savePlatformConfig, usePlatformConfig } from "@/lib/admin";

interface Settings {
  limits: { sms: { minIntervalSeconds: number; perRecipientPerHour: number; perRecipientPerDay: number; globalPerMinute: number }; otp: { cooldownSeconds: number; perPhonePerHour: number; perIpPerHour: number } };
  brand: { appName: string; support: string };
  defaults: { limits: Settings["limits"] };
}

export default function ChannelsLimits() {
  return (
    <>
      <PageHeading eyebrow="Notification settings" title="Channel & limits" subtitle="Which channels send, the limits and quiet hours." />
      <div className="grid-2" style={{ alignItems: "start" }}>
        <Channels />
        <Limits />
      </div>
    </>
  );
}

function Channels() {
  const config = usePlatformConfig();
  const saved = (config.data?.channels ?? {}) as { sms?: boolean; email?: boolean };
  const [sms, setSms] = useState(true);
  const [email, setEmail] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!config.data) return;
    setSms(saved.sms ?? true);
    setEmail(saved.email ?? true);
  }, [config.data]); // eslint-disable-line react-hooks/exhaustive-deps
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await savePlatformConfig(c => ({ ...c, channels: { publicTracking: true, ...((c.channels as object) ?? {}), sms, email } }));
      toast(`Notification channels saved: SMS ${sms ? "on" : "off"}, email ${email ? "on" : "off"}.`, "good");
    } catch (err) {
      toast(`Settings were not saved: ${describe(err)}`, "bad");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel title="Notification channels" subtitle="SMS and email can be switched off for the whole platform (security messages are always sent); public tracking is always available.">
      {config.isLoading ? (
        <Loading rows={3} />
      ) : (
        <form className="panel-body" style={{ display: "grid", gap: 10 }} onSubmit={e => void save(e)}>
          <label className="check">
            <input type="checkbox" checked={sms} onChange={e => setSms(e.target.checked)} /> SMS notifications enabled
          </label>
          <label className="check">
            <input type="checkbox" checked={email} onChange={e => setEmail(e.target.checked)} /> Email notifications enabled
          </label>
          <label className="check">
            <input type="checkbox" checked disabled /> Website tracking for everyone · always on
          </label>
          <div>
            <Button type="submit" variant="primary" disabled={busy}>
              Save channels
            </Button>
          </div>
        </form>
      )}
    </Panel>
  );
}

const FIELDS: [string, string, (s: Settings["limits"]) => number, number, number, (d: Settings["limits"]) => string][] = [
  ["ntMinInterval", "Seconds between SMS to one number", l => l.sms.minIntervalSeconds, 0, 3600, d => `Later messages wait, they aren't dropped. Default ${d.sms.minIntervalSeconds}.`],
  ["ntPerHour", "SMS per number per hour", l => l.sms.perRecipientPerHour, 1, 1000, d => `Default ${d.sms.perRecipientPerHour}.`],
  ["ntPerDay", "SMS per number per day", l => l.sms.perRecipientPerDay, 1, 5000, d => `Over this, non-urgent SMS are not sent. Default ${d.sms.perRecipientPerDay}.`],
  ["ntGlobal", "SMS per minute, whole platform", l => l.sms.globalPerMinute, 1, 100000, d => `Default ${d.sms.globalPerMinute}.`],
  ["ntOtpCooldown", "Seconds before a new code can be requested", l => l.otp.cooldownSeconds, 15, 900, d => `Shown as a countdown. Default ${d.otp.cooldownSeconds}.`],
  ["ntOtpPhone", "Codes per number per hour", l => l.otp.perPhonePerHour, 1, 50, d => `Default ${d.otp.perPhonePerHour}.`],
  ["ntOtpIp", "Codes per IP address per hour", l => l.otp.perIpPerHour, 1, 1000, d => `Default ${d.otp.perIpPerHour}.`],
];

function Limits() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "notification-settings"], queryFn: () => api<Settings>("/notifications/settings") });
  const [v, setV] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const s = q.data;
    if (!s) return;
    setV({ ...Object.fromEntries(FIELDS.map(([id, , get]) => [id, String(get(s.limits))])), ntAppName: s.brand.appName, ntSupport: s.brand.support });
  }, [q.data]);
  if (!q.data) return <Panel title="SMS limits and message settings" subtitle="Loading…">{q.error ? <div className="callout bad" style={{ margin: 16 }}>{describe(q.error)}</div> : <Loading rows={4} />}</Panel>;
  const d = q.data.defaults.limits;

  function check() {
    const out: Record<string, string> = {};
    for (const [id, , , min, max] of FIELDS) {
      const n = Number(v[id]);
      out[id] = v[id] === "" || !Number.isInteger(n) ? "Enter a whole number" : n < min || n > max ? `Between ${min} and ${max}` : "";
    }
    if (!out.ntPerDay && Number(v.ntPerDay) < Number(v.ntPerHour)) out.ntPerDay = "Can't be lower than the hourly limit";
    out.ntAppName = v.ntAppName?.trim() ? "" : "Enter a name";
    out.ntSupport = v.ntSupport?.trim() ? "" : "Enter a phone number or address";
    setErrors(out);
    return !Object.values(out).some(Boolean);
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!check()) return;
    const n = (id: string) => Number(v[id]);
    setBusy(true);
    try {
      const saved = await api<Settings>("/notifications/settings", {
        method: "PUT",
        body: {
          limits: { sms: { minIntervalSeconds: n("ntMinInterval"), perRecipientPerHour: n("ntPerHour"), perRecipientPerDay: n("ntPerDay"), globalPerMinute: n("ntGlobal") }, otp: { cooldownSeconds: n("ntOtpCooldown"), perPhonePerHour: n("ntOtpPhone"), perIpPerHour: n("ntOtpIp") } },
          brand: { appName: v.ntAppName.trim(), support: v.ntSupport.trim() },
        },
      });
      qc.setQueryData(["admin", "notification-settings"], saved);
      toast("Notification limits saved.", "good");
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }
  const input = (id: string, label: string, props: Record<string, unknown>, hint?: string) => (
    <label className="field" key={id}>
      <span>{label}</span>
      <input id={id} className="input" value={v[id] ?? ""} onChange={e => setV({ ...v, [id]: e.target.value })} aria-invalid={!!errors[id]} {...props} />
      {errors[id] ? <span className="error">{errors[id]}</span> : hint ? <small>{hint}</small> : null}
    </label>
  );
  return (
    <Panel title="SMS limits and message settings" subtitle="Codes and security messages skip the per-number limits but count towards them.">
      <form className="panel-body form-grid" onSubmit={e => void save(e)} noValidate>
        {FIELDS.map(([id, label, , min, max, hint]) => input(id, label, { type: "number", min, max, step: 1, required: true }, hint(d)))}
        {input("ntAppName", "Name in messages", { maxLength: 40, required: true })}
        {input("ntSupport", "How to reach support ({{support}})", { maxLength: 60, required: true })}
        <div className="full">
          <Button type="submit" variant="primary" disabled={busy}>
            Save limits
          </Button>
        </div>
      </form>
    </Panel>
  );
}
