/**
 * CN_Scan AI (Operational settings): the apps' CN_Scan reads parcel photos with the AI. On / off, a daily limit, today's
 * readings, and this month's photos, readings and estimated cost (GET/PUT /cn/settings, GET /cn/usage). Off (or over
 * the limit): the photo and the CN are still kept; the details are typed in Courier Operations.
 */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, describe } from "@panel/lib/api";
import { Button, Metric, PageHeading, Panel, Pill, Switch } from "@panel/ui/kit";
import { toast, toastError } from "@panel/ui/toast";
import { num } from "@/lib/admin";

interface Settings {
  aiEnabled: boolean;
  dailyLimit: number | null;
  aiAvailable: boolean;
  readToday: number;
}
interface Usage {
  from: string;
  to: string;
  photos: number;
  skipped: number;
  reads: number;
  costUsd: number;
  daily: { day: string; reads: number; failed: number; costUsd: number }[];
}
const dhakaToday = () => new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
const usd = (v: number) => `$${v.toFixed(v < 1 ? 4 : 2)}`;

export default function CnScan() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["admin", "cn-settings"], queryFn: () => api<Settings>("/cn/settings") });
  const [from, setFrom] = useState(dhakaToday().slice(0, 8) + "01");
  const [to, setTo] = useState(dhakaToday());
  const usage = useQuery({ queryKey: ["admin", "cn-usage", from, to], queryFn: () => api<Usage>(`/cn/usage?from=${from}&to=${to}`) });
  const s = settings.data;
  const [on, setOn] = useState(true);
  const [limit, setLimit] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!s) return;
    setOn(s.aiEnabled);
    setLimit(s.dailyLimit === null ? "" : String(s.dailyLimit));
  }, [s]);

  async function save() {
    const dailyLimit = limit.trim() === "" ? null : Math.max(0, Math.round(Number(limit)));
    if (dailyLimit !== null && !Number.isFinite(dailyLimit)) return toast("Enter the daily limit as a number, or leave it empty for no limit.", "bad");
    setBusy(true);
    try {
      await api("/cn/settings", { method: "PUT", body: { aiEnabled: on, dailyLimit } });
      await qc.invalidateQueries({ queryKey: ["admin", "cn-settings"] });
      toast("CN_Scan AI settings saved.", "good");
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  const u = usage.data;
  return (
    <>
      <PageHeading eyebrow="Operational settings" title="CN_Scan AI" subtitle="The Ops and Rider apps' CN_Scan: a photo of the parcel with its CN label; the AI reads the recipient, phone, address and COD into the parcel." />
      <Panel title="AI reading" subtitle="Off, or over today's limit: the photo and the CN are still kept, and the details are typed in Courier Operations.">
        <div className="panel-body" style={{ display: "grid", gap: 14, maxWidth: 560 }}>
          {s && !s.aiAvailable ? <div className="callout warn">The AI isn't set up on the server (no Claude key), so photos are kept but not read.</div> : null}
          <Switch checked={on} label={on ? "AI reading on" : "AI reading off"} onChange={setOn} />
          <label className="field">
            <span>Daily limit (photos read per day)</span>
            <input className="input" type="number" min={0} step={1} placeholder="No limit" value={limit} onChange={e => setLimit(e.target.value)} style={{ maxWidth: 200 }} />
            <small>{s ? `Read today: ${num(s.readToday)}${s.dailyLimit !== null ? ` of ${num(s.dailyLimit)}` : ""}. Empty = no limit.` : "…"}</small>
          </label>
          <div>
            <Button variant="primary" onClick={() => void save()} disabled={busy || !s}>
              Save
            </Button>
          </div>
          {settings.error ? <div className="callout bad">{describe(settings.error)}</div> : null}
        </div>
      </Panel>
      <div style={{ height: 16 }} />
      <Panel
        title="Usage and cost"
        subtitle="Dhaka days. The cost is estimated from list prices; the bill is in the Anthropic Console › Usage."
        tools={
          <>
            <input className="input sm" type="date" aria-label="From" value={from} max={to} onChange={e => e.target.value && setFrom(e.target.value)} />
            <input className="input sm" type="date" aria-label="To" value={to} min={from} max={dhakaToday()} onChange={e => e.target.value && setTo(e.target.value)} />
          </>
        }
      >
        <div className="metrics" style={{ padding: "12px 16px 0" }}>
          <Metric label="Photos" icon="camera" value={u ? num(u.photos) : "—"} foot={u ? `${num(u.skipped)} not read` : ""} note="CN_Scan" />
          <Metric label="Read by AI" icon="check" value={u ? num(u.reads) : "—"} foot="" note="readings" />
          <Metric label="Estimated cost" icon="chart" value={u ? usd(u.costUsd) : "—"} foot={u && u.reads ? `${usd(u.costUsd / u.reads)} per photo` : ""} note="USD" />
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Day</th>
                <th className="num">Read</th>
                <th className="num">Failed</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {(u?.daily ?? [])
                .slice()
                .reverse()
                .map(d => (
                  <tr key={d.day}>
                    <td>{d.day}</td>
                    <td className="num">{num(d.reads)}</td>
                    <td className="num">{d.failed ? <Pill tone="warn">{num(d.failed)}</Pill> : "0"}</td>
                    <td className="num">{usd(d.costUsd)}</td>
                  </tr>
                ))}
              {u && !u.daily.length ? (
                <tr>
                  <td colSpan={4} className="faint">
                    No readings in this period.
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
