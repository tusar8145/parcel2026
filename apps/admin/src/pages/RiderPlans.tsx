/**
 * Rider earning plans (03.js riderPlansPage + bridge-rider-plans.js + bridge-location.js):
 *   Delivery type   Customer parcels · E-commerce · Documents
 *   At a glance     active riders, the most used plan, riders on the plan chosen
 *   Earning plans   a card per plan (Starter, Growth, Business, Enterprise); the chosen plan's form: earning model
 *                   (per parcel, monthly salary, both) and its amounts
 *   Rider assignments  a plan per delivery type for each rider (searchable)
 *   Rider location  how often riders' positions update (GET / PUT /settings/location)
 * Plans and assignments are saved in the platform settings (`riderPlans`, `riderPlanAssignments`), which rider
 * earnings read (apps/api rider/earnings.ts). Riders without a choice are on Growth.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, describe } from "@panel/lib/api";
import { Button, Loading, PageHeading, Panel } from "@panel/ui/kit";
import { Select } from "@panel/ui/Select";
import { toast, toastError } from "@panel/ui/toast";
import { savePlatformConfig, usePlatformConfig, type PlatformConfig } from "@/lib/admin";

type Line = "parcel" | "ecommerce" | "document";
const LINES: [Line, string][] = [
  ["parcel", "Customer parcels"],
  ["ecommerce", "E-commerce"],
  ["document", "Documents"],
];
const TIERS = ["Starter", "Growth", "Business", "Enterprise"];
const MODE: Record<string, string> = { perParcel: "Per parcel", monthlySalary: "Monthly salary", both: "Salary + per parcel" };
const TABS: [string, string][] = [
  ["plans", "Earning plans"],
  ["assignments", "Rider assignments"],
  ["location", "Rider location"],
];
interface Plan {
  mode: "perParcel" | "monthlySalary" | "both";
  perParcel: number;
  monthlySalary: number;
}
const defaultPlan = (line: Line, tier: string): Plan => ({ mode: "perParcel", perParcel: { parcel: 25, ecommerce: 35, document: 30 }[line] * ({ Starter: 1, Growth: 1.25, Business: 1.6, Enterprise: 2 }[tier] ?? 1), monthlySalary: 0 });
const money = (n: unknown) => `৳${Number(n || 0).toLocaleString("en-BD")}`;
interface Rider {
  id: string;
  code: string;
  name: string;
  active: boolean;
  hub?: { name: string } | null;
  zone?: string | null;
}

/** The saved plans (older saves keyed plans by tier only) and assignments (a tier, or a tier per line). */
function readPlans(c: PlatformConfig | undefined, tiers: string[]) {
  const saved = (c?.riderPlans ?? {}) as Record<string, Record<string, Plan> | Plan>;
  return Object.fromEntries(LINES.map(([line]) => [line, Object.fromEntries(tiers.map(t => [t, ((saved[line] as Record<string, Plan>)?.[t] as Plan) || (saved[t] as Plan) || defaultPlan(line, t)]))])) as Record<Line, Record<string, Plan>>;
}
function readAssignments(c: PlatformConfig | undefined) {
  const saved = (c?.riderPlanAssignments ?? {}) as Record<string, string | Record<string, string>>;
  return Object.fromEntries(Object.entries(saved).map(([id, a]) => [id, typeof a === "string" ? Object.fromEntries(LINES.map(([l]) => [l, a])) : a])) as Record<string, Record<string, string>>;
}

export default function RiderPlans() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some(([k]) => k === params.get("section")) ? params.get("section")! : "plans";
  const config = usePlatformConfig();
  const riders = useQuery({ queryKey: ["admin", "riders"], queryFn: () => api<Rider[]>("/riders") });
  const [line, setLine] = useState<Line>("ecommerce");
  const [tier, setTier] = useState("Starter");
  const savedPlans = (config.data?.riderPlans ?? {}) as Record<string, Record<string, Plan>>;
  const tiers = [...new Set([...TIERS, ...LINES.flatMap(([l]) => Object.keys(savedPlans[l] ?? {}))])];
  const plans = readPlans(config.data, tiers);
  const assigned = readAssignments(config.data);
  const active = (riders.data ?? []).filter(r => r.active);
  const tierOf = (code: string, l: Line) => assigned[code]?.[l] || "Growth";
  const ridersOn = (l: Line, t: string) => active.filter(r => tierOf(r.code, l) === t).length;
  const lineLabel = LINES.find(([l]) => l === line)![1];
  const busiest = tiers.map(t => [t, ridersOn(line, t)] as const).sort((a, b) => b[1] - a[1])[0];
  const setTab = (k: string) =>
    setParams(
      p => {
        if (k === "plans") p.delete("section");
        else p.set("section", k);
        return p;
      },
      { replace: true },
    );
  const tile = (label: string, value: string, hint?: string) => (
    <article className="metric">
      <div className="metric-head">
        <span>{label}</span>
      </div>
      <div className="metric-value" style={{ fontSize: 18 }}>
        {value}
      </div>
      {hint ? (
        <div className="metric-foot">
          <span className="faint">{hint}</span>
        </div>
      ) : null}
    </article>
  );

  return (
    <>
      <PageHeading eyebrow="Rider management · Compensation" title="Rider earning plans" subtitle="Choose a delivery type, set what each plan pays, then give riders their plans." />
      <div className="seg-tabs" role="group" aria-label="Delivery type" style={{ marginBottom: 14 }}>
        {LINES.map(([l, label]) => (
          <button key={l} type="button" aria-pressed={line === l} className={line === l ? "on" : ""} onClick={() => setLine(l)}>
            {label}
          </button>
        ))}
      </div>
      <section className="metrics" aria-label={`${lineLabel} at a glance`}>
        {tile("Active riders", active.length.toLocaleString("en-US"))}
        {tile("Most used plan", busiest?.[1] ? busiest[0] : "None yet", busiest?.[1] ? `${busiest[1].toLocaleString("en-US")} rider${busiest[1] === 1 ? "" : "s"}` : "")}
        {tile(`On ${tier}`, ridersOn(line, tier).toLocaleString("en-US"), lineLabel)}
      </section>
      <div role="tablist" aria-label="Rider earning sections" style={{ display: "flex", gap: 2, borderBottom: "1px solid var(--line)", marginBottom: 14 }}>
        {TABS.map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            style={{ padding: "10px 14px", marginBottom: -1, border: 0, borderBottom: `2px solid ${tab === k ? "var(--primary)" : "transparent"}`, background: "none", color: tab === k ? "var(--primary)" : "var(--muted)", font: "inherit", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
          >
            {label}
          </button>
        ))}
      </div>
      {config.isLoading ? (
        <Loading rows={6} />
      ) : config.error ? (
        <div className="callout bad">{describe(config.error)}</div>
      ) : tab === "plans" ? (
        <Panel title={`${lineLabel} plans`} subtitle="Each delivery type has its own plans. Choose one to change what it pays.">
          <div className="panel-body">
            <div role="group" aria-label="Plans" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, marginBottom: 16 }}>
              {tiers.map(t => {
                const p = plans[line][t];
                const rate = p.mode === "monthlySalary" ? `${money(p.monthlySalary)}/month` : `${money(p.perParcel)}/parcel`;
                const extra = p.mode === "both" ? `${money(p.monthlySalary)}/month too` : MODE[p.mode] || "";
                const n = ridersOn(line, t);
                return (
                  <button key={t} type="button" aria-pressed={t === tier} className="metric" onClick={() => setTier(t)} style={t === tier ? { borderColor: "var(--primary)", background: "var(--primary-soft)" } : undefined}>
                    <strong>{t}</strong>
                    <b style={{ fontSize: 18 }}>{rate}</b>
                    <span className="faint" style={{ fontSize: 12 }}>
                      {extra}
                    </span>
                    <small className="faint">{`${n.toLocaleString("en-US")} rider${n === 1 ? "" : "s"}`}</small>
                  </button>
                );
              })}
            </div>
            <PlanForm key={`${line}|${tier}`} line={line} lineLabel={lineLabel} tier={tier} plan={plans[line][tier]} tiers={tiers} />
          </div>
        </Panel>
      ) : tab === "assignments" ? (
        <Assignments riders={active} tiers={tiers} plans={plans} assigned={assigned} loading={riders.isLoading} />
      ) : (
        <Location />
      )}
    </>
  );
}

function PlanForm({ line, lineLabel, tier, plan, tiers }: { line: Line; lineLabel: string; tier: string; plan: Plan; tiers: string[] }) {
  const [v, setV] = useState({ mode: plan.mode, perParcel: String(plan.perParcel ?? 0), monthlySalary: String(plan.monthlySalary ?? 0) });
  const [busy, setBusy] = useState(false);
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await savePlatformConfig(c => {
        const all = readPlans(c, tiers);
        all[line][tier] = { mode: v.mode, perParcel: Number(v.perParcel), monthlySalary: Number(v.monthlySalary) };
        return { ...c, riderPlans: all };
      });
      toast(`${lineLabel} ${tier} earning plan saved.`, "good");
    } catch (err) {
      toast(`Settings were not saved: ${describe(err)}`, "bad");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={e => void save(e)}>
      <div className="form-grid">
        <label className="field">
          <span>Earning model</span>
          <Select className="select" name="mode" value={v.mode} onChange={e => setV({ ...v, mode: e.target.value as Plan["mode"] })}>
            <option value="perParcel">Per parcel</option>
            <option value="monthlySalary">Monthly salary</option>
            <option value="both">Both</option>
          </Select>
        </label>
        {v.mode !== "monthlySalary" ? (
          <label className="field">
            <span>Per parcel (৳)</span>
            <input className="input" name="perParcel" type="number" min={0} step={0.01} required value={v.perParcel} onChange={e => setV({ ...v, perParcel: e.target.value })} />
          </label>
        ) : null}
        {v.mode !== "perParcel" ? (
          <label className="field">
            <span>Monthly salary (৳)</span>
            <input className="input" name="monthlySalary" type="number" min={0} required value={v.monthlySalary} onChange={e => setV({ ...v, monthlySalary: e.target.value })} />
          </label>
        ) : null}
      </div>
      <div style={{ marginTop: 12 }}>
        <Button type="submit" variant="primary" disabled={busy}>
          Save {lineLabel} {tier} plan
        </Button>
      </div>
    </form>
  );
}

function Assignments({ riders, tiers, plans, assigned, loading }: { riders: Rider[]; tiers: string[]; plans: Record<Line, Record<string, Plan>>; assigned: Record<string, Record<string, string>>; loading: boolean }) {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState("");
  const query = q.trim().toLowerCase();
  const shown = riders.filter(r => !query || `${r.code} ${r.name}`.toLowerCase().includes(query));
  async function assign(r: Rider, line: Line, tier: string) {
    setBusy(`${r.code}|${line}`);
    try {
      await savePlatformConfig(c => {
        const all = readAssignments(c);
        all[r.code] = { ...(all[r.code] ?? {}), [line]: tier };
        return { ...c, riderPlanAssignments: all };
      });
      toast(`Rider assigned to ${tier} for ${LINES.find(([l]) => l === line)![1]}.`, "good");
    } catch (err) {
      toast(`Settings were not saved: ${describe(err)}`, "bad");
      void qc.invalidateQueries({ queryKey: ["admin", "platform-config"] });
    } finally {
      setBusy("");
    }
  }
  return (
    <Panel
      title="Rider plan assignments"
      subtitle="Choose a separate earning plan for each delivery type handled by the rider."
      tools={<input className="input sm" type="search" placeholder="Search riders" aria-label="Search riders" value={q} onChange={e => setQ(e.target.value)} style={{ width: 220 }} />}
    >
      {loading ? (
        <Loading rows={5} />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Rider ID</th>
                <th>Rider</th>
                {LINES.map(([l, label]) => (
                  <th key={l}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map(r => (
                <tr key={r.id}>
                  <td>{r.code}</td>
                  <td>
                    <span className="strong">{r.name}</span>
                    <span className="sub">{r.hub?.name || r.zone || "No hub"}</span>
                  </td>
                  {LINES.map(([l]) => {
                    const t = assigned[r.code]?.[l] || "Growth";
                    const p = plans[l][t] ?? defaultPlan(l, t);
                    return (
                      <td key={l}>
                        <Select className="select sm" value={t} disabled={busy === `${r.code}|${l}`} onChange={e => void assign(r, l, e.target.value)}>
                          {tiers.map(x => (
                            <option key={x}>{x}</option>
                          ))}
                        </Select>
                        <span className="sub">{`${MODE[p.mode] ?? "Per parcel"} · ৳${p.perParcel || 0}/parcel · ৳${p.monthlySalary || 0}/month`}</span>
                      </td>
                    );
                  })}
                </tr>
              ))}
              {!shown.length ? (
                <tr>
                  <td colSpan={5} className="faint" style={{ textAlign: "center" }}>
                    No riders.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function Location() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "location-settings"], queryFn: () => api<{ intervalMinutes: number; movementMeters: number; staleAfterMinutes: number; defaults?: { intervalMinutes: number } }>("/settings/location") });
  const [v, setV] = useState<{ interval: string; meters: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.data && !v) setV({ interval: String(q.data.intervalMinutes), meters: String(q.data.movementMeters) });
  }, [q.data, v]);
  const s = q.data;
  async function save(e: FormEvent) {
    e.preventDefault();
    const meters = Number(v!.meters);
    if (!(Number.isFinite(meters) && meters >= 25 && meters <= 1000)) return setError("Enter 25 to 1000 metres.");
    setError("");
    setBusy(true);
    try {
      const intervalMinutes = Number(v!.interval);
      const movementMeters = Math.round(meters);
      qc.setQueryData(["admin", "location-settings"], await api("/settings/location", { method: "PUT", body: { intervalMinutes, movementMeters } }));
      toast(`Rider location: every ${intervalMinutes} minutes or after ${movementMeters} m.`, "good");
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel title="Rider location" subtitle="How often riders' (and shared vehicles') positions update on the maps">
      {!s || !v ? (
        q.error ? <p className="panel-body faint">{describe(q.error)}</p> : <Loading rows={2} />
      ) : (
        <form className="panel-body" onSubmit={e => void save(e)} noValidate>
          <div className="form-grid">
            <label className="field">
              <span>Rider location interval</span>
              <Select className="select" value={v.interval} onChange={e => setV({ ...v, interval: e.target.value })}>
                {[2, 5, 10].map(n => (
                  <option key={n} value={n}>{`Every ${n} minutes${n === s.defaults?.intervalMinutes ? " (default)" : ""}`}</option>
                ))}
              </Select>
            </label>
            <label className="field">
              <span>Movement threshold (metres)</span>
              <input className="input" type="number" min={25} max={1000} step={5} required value={v.meters} onChange={e => setV({ ...v, meters: e.target.value })} aria-invalid={!!error} />
              {error ? <span className="error">{error}</span> : null}
            </label>
          </div>
          <p className="faint" style={{ margin: "8px 0 0" }}>
            {`Riders on shift send their position on this interval and at once after moving this far. Phones sharing a linehaul vehicle's location use the same settings. Positions older than ${s.staleAfterMinutes} minutes show as "last known". Browsers only send while the rider app is open on the screen; background tracking would need a native app.`}
          </p>
          <div style={{ marginTop: 12 }}>
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? "Saving…" : "Save location settings"}
            </Button>
          </div>
        </form>
      )}
    </Panel>
  );
}
