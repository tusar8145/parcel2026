/**
 * Reports (merchant-features.js reports): the period (last 7 / 30 / 90 days, 12 months, custom), the period's
 * headline numbers (delivery-performance highlights), and the reports this person may open
 * (GET /merchants/me/reports) grouped by purpose: View on screen or Download Excel.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, describe, download } from "@panel/lib/api";
import { openCustom } from "@panel/ui/dialogs";
import { Icon } from "@panel/ui/Icon";
import { Button, Metric, PageHeading, Panel } from "@panel/ui/kit";
import { Select } from "@panel/ui/Select";
import { toast } from "@panel/ui/toast";
import { useMerchant } from "@/lib/merchant";

const PERIODS: [string, string][] = [
  ["7", "Last 7 days"],
  ["30", "Last 30 days"],
  ["90", "Last 90 days"],
  ["365", "Last 12 months"],
  ["custom", "Custom dates"],
];
const dayOf = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const dateOnly = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const dateTime = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
interface Highlight {
  label: string;
  value: number | string;
  format?: "money" | "percent";
}
const highlight = (h: Highlight) => (h.format === "money" ? `৳${Number(h.value).toLocaleString("en-BD")}` : h.format === "percent" ? `${h.value}%` : typeof h.value === "number" ? h.value.toLocaleString("en-BD") : h.value);
interface Report {
  title: string;
  from: string;
  to: string;
  columns: string[];
  rows: unknown[][];
  highlights: Highlight[];
}

export default function Reports() {
  const m = useMerchant();
  const [period, setPeriod] = useState("30");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  /** The chosen period as a query; null while custom dates are incomplete or the wrong way round. */
  const range = (() => {
    const f = period === "custom" ? from : dayOf(new Date(Date.now() - Number(period) * 86_400_000));
    const t = period === "custom" ? to : dayOf(new Date());
    if (!f || !t || f > t) return null;
    return `from=${encodeURIComponent(new Date(`${f}T00:00:00`).toISOString())}&to=${encodeURIComponent(new Date(`${t}T23:59:59.999`).toISOString())}`;
  })();
  const catalog = useQuery({ queryKey: ["m", "reports"], queryFn: () => api<{ kind: string; group: string; title: string; description: string }[]>(`/merchants/me/reports${m.q()}`) });
  const kpis = useQuery({ queryKey: ["m", "reports", "kpis", range], enabled: !!range, queryFn: () => api<Report>(`/merchants/me/reports/delivery-performance?format=json&${range}${m.q("&")}`).then(r => r.highlights) });
  const groups = [...new Set((catalog.data ?? []).map(r => r.group))];

  async function downloadReport(kind: string) {
    if (!range) return toast("Choose the From and To dates, with From before To.");
    try {
      const name = await download(`/merchants/me/reports/${kind}?format=xlsx&${range}${m.q("&")}`, `${kind}.xlsx`);
      toast(`${catalog.data?.find(r => r.kind === kind)?.title || "Report"} downloaded: ${name}`, "good");
    } catch (e) {
      toast(describe(e), "bad");
    }
  }
  async function viewReport(kind: string) {
    if (!range) return toast("Choose the From and To dates, with From before To.");
    try {
      const report = await api<Report>(`/merchants/me/reports/${kind}?format=json&${range}${m.q("&")}`);
      await openCustom(
        close => (
          <>
            <div className="dialog-head">
              <div>
                <h2>{report.title}</h2>
                <p>
                  {dateOnly(report.from)} – {dateOnly(report.to)} · {report.rows.length} row(s)
                </p>
              </div>
              <button type="button" className="button ghost icon dialog-close" aria-label="Close" onClick={() => close()}>
                <Icon name="x" size={18} />
              </button>
            </div>
            <div className="dialog-body">
              <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                {report.highlights.map(h => (
                  <span key={h.label} className="pill info">
                    {h.label}: {highlight(h)}
                  </span>
                ))}
              </div>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      {report.columns.map(c => (
                        <th key={c}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {report.rows.slice(0, 200).map((r, i) => (
                      <tr key={i}>
                        {r.map((v, j) => (
                          <td key={j}>{typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) ? dateTime(v) : v == null ? "—" : String(v)}</td>
                        ))}
                      </tr>
                    ))}
                    {!report.rows.length ? (
                      <tr>
                        <td colSpan={report.columns.length} className="empty-cell">
                          No rows in this period.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
              {report.rows.length > 200 ? <p className="faint">First 200 rows shown; download the Excel file for all of them.</p> : null}
            </div>
            <div className="dialog-foot">
              <Button variant="primary" icon="download" onClick={() => downloadReport(kind)}>
                Download Excel
              </Button>
            </div>
          </>
        ),
        "wide",
      );
    } catch (e) {
      toast(describe(e), "bad");
    }
  }

  return (
    <>
      <PageHeading eyebrow="Banking & Financial workspace" title="Reports" subtitle="Open a report on screen or download it to Excel. Everything comes from your live data." />
      <Panel>
        <div className="panel-body row" style={{ gap: 12, alignItems: "end", flexWrap: "wrap" }}>
          <label className="field" style={{ minWidth: 180 }}>
            <span>Period</span>
            <Select className="select sm" aria-label="Report period" searchable={false} value={period} onChange={e => setPeriod(e.target.value)}>
              {PERIODS.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </Select>
          </label>
          {period === "custom" ? (
            <>
              <label className="field">
                <span>From</span>
                <input className="input sm" type="date" value={from} onChange={e => setFrom(e.target.value)} />
              </label>
              <label className="field">
                <span>To</span>
                <input className="input sm" type="date" value={to} onChange={e => setTo(e.target.value)} />
              </label>
            </>
          ) : null}
        </div>
      </Panel>
      {kpis.data ? (
        <div className="metrics" style={{ marginTop: 14 }}>
          {kpis.data.map(h => (
            <Metric key={h.label} label={h.label} value={highlight(h)} />
          ))}
        </div>
      ) : null}
      <div style={{ display: "grid", gap: 14, marginTop: 14 }}>
        {catalog.isLoading ? <Panel><div className="empty-cell">Loading reports…</div></Panel> : null}
        {catalog.isError ? <Panel><div className="empty-cell">{describe(catalog.error)}</div></Panel> : null}
        {groups.map(group => (
          <Panel key={group} title={group}>
            <div className="panel-body" style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
              {(catalog.data ?? [])
                .filter(r => r.group === group)
                .map(r => (
                  <article key={r.kind} style={{ display: "grid", gap: 10, alignContent: "space-between", padding: 14, border: "1px solid var(--line)", borderRadius: 10 }}>
                    <div>
                      <strong style={{ display: "block", fontSize: 14, marginBottom: 4 }}>{r.title}</strong>
                      <span className="muted" style={{ fontSize: 13 }}>
                        {r.description}
                      </span>
                    </div>
                    <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                      <Button size="sm" onClick={() => viewReport(r.kind)}>
                        View
                      </Button>
                      <Button size="sm" icon="download" onClick={() => downloadReport(r.kind)}>
                        Download Excel
                      </Button>
                    </div>
                  </article>
                ))}
            </div>
          </Panel>
        ))}
      </div>
    </>
  );
}
