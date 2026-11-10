/**
 * Operational settings › AI import (GET / PUT /imports/ai, GET /imports/ai/usage): Claude matches an Excel file's
 * product names and addresses that the lists don't, creating products, categories and zones (tagged AI created).
 * On / off, the monthly limit in USD, the channel rule for new categories, this month's spend and the log.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, describe } from "@panel/lib/api";
import { Button, Loading, Metric, PageHeading, Panel, Pill, Switch } from "@panel/ui/kit";
import { toast, toastError } from "@panel/ui/toast";

interface Overview {
  settings: { enabled: boolean; monthlyLimitUsd: number; channelPrompt: string };
  apiKey: boolean;
  model: string;
  thisMonth: {
    imports: number;
    calls: number;
    costUsd: number;
    remainingUsd: number;
    tokens: { input: number; cacheRead: number; cacheWrite: number; output: number };
    products: number;
    places: number;
    productsCreated: number;
    categoriesCreated: number;
    zonesCreated: number;
  };
  created: { products: number; categories: number; zones: number };
}
interface UsageRow {
  id: string;
  createdAt: string;
  importNumber: string | null;
  user: string | null;
  merchant: string | null;
  products: number;
  places: number;
  productsMatched: number;
  productsCreated: number;
  categoriesCreated: number;
  placesMatched: number;
  zonesCreated: number;
  calls: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  costUsd: number;
  ms: number;
  error: string | null;
}

const usd = (n: number) => `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;
const num = (n: number) => n.toLocaleString("en-US");
const when = (v: string) => new Date(v).toLocaleString("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const thisMonth = () => new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 7);

export default function AiImport() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "ai-import"], queryFn: () => api<Overview>("/imports/ai") });
  const [month, setMonth] = useState(thisMonth());
  const log = useQuery({ queryKey: ["admin", "ai-import", "usage", month], queryFn: () => api<{ month: string; totalUsd: number; count: number; items: UsageRow[] }>(`/imports/ai/usage?month=${month}&limit=200`) });
  const [limit, setLimit] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const o = q.data;
  useEffect(() => {
    if (!o) return;
    setLimit(String(o.settings.monthlyLimitUsd));
    setPrompt(o.settings.channelPrompt);
  }, [o?.settings.monthlyLimitUsd, o?.settings.channelPrompt]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(body: Partial<Overview["settings"]>, done: string) {
    setBusy(true);
    try {
      const next = await api<Overview>("/imports/ai", { method: "PUT", body });
      qc.setQueryData(["admin", "ai-import"], next);
      toast(done, "good");
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    const n = Number(limit);
    if (!Number.isFinite(n) || n < 0) return toast("Enter the monthly limit in USD (0 or more).", "bad");
    void save({ monthlyLimitUsd: n, channelPrompt: prompt.trim() }, "AI import settings saved.");
  }

  if (!o) return q.error ? <p className="faint">{describe(q.error)}</p> : <Loading rows={6} />;
  const m = o.thisMonth;
  const used = o.settings.monthlyLimitUsd > 0 ? Math.min(100, Math.round((m.costUsd / o.settings.monthlyLimitUsd) * 100)) : 100;
  return (
    <>
      <PageHeading
        eyebrow="Operational settings"
        title="AI import"
        subtitle="Excel imports (merchants and operations): product names and addresses the lists don't match are matched by AI. A new product, category or zone is created at once (tagged AI created; a new zone is served by the nearest zone's hub). Each decision is remembered, so the same name doesn't go to the AI again."
      />
      {!o.apiKey ? <div className="callout warn" style={{ marginBottom: 12 }}>No Anthropic API key on the server (ANTHROPIC_API_KEY): the AI can't run.</div> : null}
      <div className="metrics" style={{ marginBottom: 16 }}>
        <Metric label="Spent this month" icon="chart" value={usd(m.costUsd)} foot={`of ${usd(o.settings.monthlyLimitUsd)} (${used}%)`} note={`${usd(m.remainingUsd)} left`} />
        <Metric label="Files" icon="sheet" value={num(m.imports)} foot={`${num(m.calls)} AI calls`} note={`${num(m.products + m.places)} names sent`} />
        <Metric label="Created this month" icon="box" value={num(m.productsCreated + m.categoriesCreated + m.zonesCreated)} foot={`${num(m.productsCreated)} prod · ${num(m.categoriesCreated)} cat · ${num(m.zonesCreated)} zones`} note={`all time ${num(o.created.products + o.created.categories + o.created.zones)}`} />
        <Metric label="Tokens this month" icon="refresh" value={num(m.tokens.input + m.tokens.output)} foot={`${num(m.tokens.input)} in · ${num(m.tokens.output)} out`} note={`+${num(m.tokens.cacheRead + m.tokens.cacheWrite)} cached`} />
      </div>
      <Panel
        title="Settings"
        subtitle="Off: files are checked as before (unmatched products are booked as written; unmatched places need a fix in the preview). At the monthly limit the AI stops until the next month; imports never stop."
        tools={<Switch checked={o.settings.enabled} disabled={busy} label={o.settings.enabled ? "On" : "Off"} onChange={on => void save({ enabled: on }, `AI import ${on ? "on" : "off"}.`)} />}
      >
        <form className="panel-body" style={{ display: "grid", gap: 12, maxWidth: 760 }} onSubmit={submit}>
          <label className="field" style={{ maxWidth: 220 }}>
            <span>Monthly limit (USD)</span>
            <input className="input" type="number" min={0} step={0.5} value={limit} onChange={e => setLimit(e.target.value)} />
          </label>
          <label className="field">
            <span>Channel rule for new categories</span>
            <textarea
              className="textarea"
              rows={4}
              maxLength={4000}
              placeholder="e.g. Cards, PIN, cheque books and anything of value: SMS, email and push on. Statements and letters: SMS off, email on. Clothing and household goods: SMS on, email off."
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
            />
            <small className="faint">When the AI creates a category, it sets its SMS, email and push from this rule (empty: all on). The super admin can change them later in Product categories.</small>
          </label>
          <div>
            <Button type="submit" variant="primary" disabled={busy}>
              Save settings
            </Button>
          </div>
        </form>
      </Panel>
      <div style={{ height: 16 }} />
      <Panel
        title="Log"
        subtitle={log.data ? `${num(log.data.count)} files · ${usd(log.data.totalUsd)} in ${log.data.month} (estimated from list prices; the bill is in the Anthropic Console)` : "Each file the AI looked at."}
        tools={<input className="input" type="month" aria-label="Month" value={month} onChange={e => setMonth(e.target.value || thisMonth())} style={{ width: 160 }} />}
      >
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Import</th>
                <th>By</th>
                <th className="num">Products</th>
                <th className="num">Addresses</th>
                <th>Created</th>
                <th className="num">Tokens</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {(log.data?.items ?? []).map(r => (
                <tr key={r.id}>
                  <td className="nowrap">{when(r.createdAt)}</td>
                  <td>
                    {r.importNumber ?? "—"}
                    {r.error ? (
                      <span className="sub">
                        <Pill tone="warn">{r.error.slice(0, 80)}</Pill>
                      </span>
                    ) : null}
                  </td>
                  <td>
                    {r.user ?? "—"}
                    {r.merchant ? <span className="sub">{r.merchant}</span> : null}
                  </td>
                  <td className="num">
                    {num(r.products)}
                    <span className="sub">{num(r.productsMatched)} matched</span>
                  </td>
                  <td className="num">
                    {num(r.places)}
                    <span className="sub">{num(r.placesMatched)} placed</span>
                  </td>
                  <td>{[r.productsCreated ? `${r.productsCreated} products` : "", r.categoriesCreated ? `${r.categoriesCreated} categories` : "", r.zonesCreated ? `${r.zonesCreated} zones` : ""].filter(Boolean).join(" · ") || "—"}</td>
                  <td className="num">
                    {num(r.inputTokens + r.outputTokens)}
                    <span className="sub">{`${r.calls} call${r.calls === 1 ? "" : "s"} · ${(r.ms / 1000).toFixed(1)} s`}</span>
                  </td>
                  <td className="num">{usd(r.costUsd)}</td>
                </tr>
              ))}
              {log.data && !log.data.items.length ? (
                <tr>
                  <td colSpan={8} className="faint" style={{ textAlign: "center", padding: 18 }}>
                    Nothing this month.
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
