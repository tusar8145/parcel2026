/**
 * Operational settings › AI address reading (GET / PUT /routing/address-ai): when a delivery address can't be found on
 * the map as written, Claude rewrites it (area, road, landmark) and the map search runs again, so route plans (rider
 * app › Best route, Courier Operations › Route planner) place the parcel at its address, not the zone centre.
 * On / off, a monthly USD limit and a daily limit, this month's and today's use, the last 30 days and recent addresses.
 * Off, at a limit or failing: parcels are placed at their zone centre as before; nothing stops.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, describe } from "@panel/lib/api";
import { Button, Loading, Metric, PageHeading, Panel, Pill, Switch } from "@panel/ui/kit";
import { toast, toastError } from "@panel/ui/toast";

interface Tally {
  calls: number;
  found: number;
  notFound: number;
  errors: number;
  costUsd: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
interface Overview {
  settings: { enabled: boolean; monthlyLimitUsd: number; dailyLimit: number };
  apiKey: boolean;
  model: string;
  running: boolean;
  blocked: string | null;
  thisMonth: Tally & { month: string; remainingUsd: number };
  today: Tally & { date: string };
  days: (Tally & { date: string })[];
  recent: { at: string; trackingId: string; address: string; query: string | null; found: boolean; error?: string; costUsd: number }[];
}

const usd = (n: number) => `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;
const num = (n: number) => n.toLocaleString("en-US");
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
const when = (v: string) => new Date(v).toLocaleString("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const BLOCKED: Record<string, string> = {
  off: "Off: addresses not found as written are placed at their zone centre.",
  "no API key": "No Anthropic API key on the server (ANTHROPIC_API_KEY): the AI can't run.",
  "monthly limit reached": "This month's limit is reached: the AI is paused until next month (or raise the limit).",
  "daily limit reached": "Today's limit is reached: the AI is paused until tomorrow (or raise the limit).",
};

export default function AddressAi() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "address-ai"], queryFn: () => api<Overview>("/routing/address-ai") });
  const [monthly, setMonthly] = useState("");
  const [daily, setDaily] = useState("");
  const [busy, setBusy] = useState(false);
  const o = q.data;
  useEffect(() => {
    if (!o) return;
    setMonthly(String(o.settings.monthlyLimitUsd));
    setDaily(String(o.settings.dailyLimit));
  }, [o?.settings.monthlyLimitUsd, o?.settings.dailyLimit]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(body: Partial<Overview["settings"]>, done: string) {
    setBusy(true);
    try {
      qc.setQueryData(["admin", "address-ai"], await api<Overview>("/routing/address-ai", { method: "PUT", body }));
      toast(done, "good");
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    const m = Number(monthly);
    const d = Number(daily);
    if (!Number.isFinite(m) || m < 0) return toast("Enter the monthly limit in USD (0 or more).", "bad");
    if (!Number.isInteger(d) || d < 0) return toast("Enter the daily limit as a whole number (0 = no daily limit).", "bad");
    void save({ monthlyLimitUsd: m, dailyLimit: d }, "Limits saved.");
  }

  if (!o) return q.error ? <p className="faint">{describe(q.error)}</p> : <Loading rows={6} />;
  const m = o.thisMonth;
  const t = o.today;
  const used = o.settings.monthlyLimitUsd > 0 ? Math.min(100, Math.round((m.costUsd / o.settings.monthlyLimitUsd) * 100)) : 100;
  return (
    <>
      <PageHeading
        eyebrow="Operational settings"
        title="AI best route"
        subtitle="Route plans need each parcel on the map. When an address can't be found as written, AI rewrites it (area, road, landmark) and the map search runs again, so the parcel is placed at its address instead of the zone centre. Without it everything still works: such parcels are placed at their zone centre."
      />
      {o.blocked && o.blocked !== "off" ? <div className="callout warn" style={{ marginBottom: 12 }}>{BLOCKED[o.blocked] ?? o.blocked}</div> : null}
      <div className="metrics" style={{ marginBottom: 16 }}>
        <Metric label="Spent this month" icon="chart" value={usd(m.costUsd)} foot={`of ${usd(o.settings.monthlyLimitUsd)} (${used}%)`} note={`${usd(m.remainingUsd)} left`} />
        <Metric label="Addresses this month" icon="pin" value={num(m.calls)} foot={`${num(m.found)} found (${pct(m.found, m.calls)})`} note={`${num(m.notFound)} not found · ${num(m.errors)} errors`} />
        <Metric
          label="Today"
          icon="clock"
          value={num(t.calls)}
          foot={o.settings.dailyLimit ? `of ${num(o.settings.dailyLimit)} a day` : "no daily limit"}
          note={`${num(t.found)} found · ${usd(t.costUsd)}`}
        />
        <Metric label="Tokens this month" icon="refresh" value={num(m.input + m.output)} foot={`${num(m.input)} in · ${num(m.output)} out`} note={`+${num(m.cacheRead + m.cacheWrite)} cached`} />
      </div>
      <Panel
        title="Settings"
        subtitle={`${o.running ? "Running" : BLOCKED[o.blocked ?? ""] ?? "Not running"} Model: ${o.model}. At a limit the AI pauses (monthly: until next month; daily: until tomorrow); route planning never stops.`}
        tools={<Switch checked={o.settings.enabled} disabled={busy} label={o.settings.enabled ? "On" : "Off"} onChange={on => void save({ enabled: on }, `AI address reading ${on ? "on" : "off"}.`)} />}
      >
        <form className="panel-body" style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "end" }} onSubmit={submit}>
          <label className="field" style={{ width: 200 }}>
            <span>Monthly limit (USD)</span>
            <input className="input" type="number" min={0} step={0.5} value={monthly} onChange={e => setMonthly(e.target.value)} />
          </label>
          <label className="field" style={{ width: 200 }}>
            <span>Daily limit (addresses)</span>
            <input className="input" type="number" min={0} step={1} value={daily} onChange={e => setDaily(e.target.value)} />
          </label>
          <Button type="submit" variant="primary" disabled={busy}>
            Save limits
          </Button>
          <small className="faint" style={{ flexBasis: "100%" }}>About $0.0001 per address (Claude Haiku): 1,000 addresses ≈ $0.10. Each parcel's address goes to the AI at most once; daily limit 0 = none.</small>
        </form>
      </Panel>
      <div style={{ height: 16 }} />
      <Panel title="Last 30 days" subtitle="Addresses the AI read each day (Dhaka time).">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Day</th>
                <th className="num">Addresses</th>
                <th className="num">Found</th>
                <th className="num">Not found</th>
                <th className="num">Errors</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {o.days.map(d => (
                <tr key={d.date}>
                  <td>{d.date}</td>
                  <td className="num">{num(d.calls)}</td>
                  <td className="num">{`${num(d.found)} (${pct(d.found, d.calls)})`}</td>
                  <td className="num">{num(d.notFound)}</td>
                  <td className="num">{num(d.errors)}</td>
                  <td className="num">{usd(d.costUsd)}</td>
                </tr>
              ))}
              {!o.days.length ? (
                <tr>
                  <td colSpan={6} className="faint" style={{ textAlign: "center" }}>
                    Nothing yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Panel>
      <div style={{ height: 16 }} />
      <Panel title="Recent addresses" subtitle="The last 50 addresses the AI read, and what it searched for.">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Parcel</th>
                <th>Address as written</th>
                <th>AI search</th>
                <th>Result</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {o.recent.map((r, i) => (
                <tr key={`${r.at}-${i}`}>
                  <td className="nowrap">{when(r.at)}</td>
                  <td className="mono">{r.trackingId}</td>
                  <td>{r.address}</td>
                  <td>{r.query ?? "—"}</td>
                  <td>{r.error ? <Pill tone="bad">{`Error: ${r.error}`}</Pill> : r.found ? <Pill tone="good">Found</Pill> : <Pill tone="warn">Not found · zone centre</Pill>}</td>
                  <td className="num">{usd(r.costUsd)}</td>
                </tr>
              ))}
              {!o.recent.length ? (
                <tr>
                  <td colSpan={6} className="faint" style={{ textAlign: "center" }}>
                    Nothing yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}
