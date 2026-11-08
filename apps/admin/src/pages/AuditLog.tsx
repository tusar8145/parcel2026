/**
 * Audit & security log (01.js + bridge-audit.js + bridge-security.js): the whole log from the server, 20 rows a page
 * (GET /audit-logs ?page &limit &q; the search runs on the server), Export log (the page on screen), and the metrics:
 * privileged actions this month, two-step coverage, failed sign-ins and lockouts in the last 7 days, retention.
 */
import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api, describe } from "@panel/lib/api";
import { saveCsv } from "@panel/lib/csv";
import { Button, Metric, PageHeading, Panel, Pill, useDebounced } from "@panel/ui/kit";
import { Pager } from "@panel/ui/Pager";
import { auditScope, auditSource, auditTitle, num, when, useMerchants, useOverview, useStaff, type AuditEntry } from "@/lib/admin";

const ALERT_ACTIONS = new Set(["auth.locked", "auth.mfa_locked", "auth.mfa_failed", "auth.login_failed"]);
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");

export default function AuditLog() {
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim(), 350);
  const overview = useOverview();
  const staff = useStaff();
  const merchants = useMerchants();
  const log = useQuery({
    queryKey: ["admin", "audit", "page", page, size, q],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), limit: String(size) });
      if (q) params.set("q", q);
      const answer = await api<{ items: AuditEntry[]; total: number; pages: number }>(`/audit-logs?${params}`);
      // The search or a smaller log left this page empty: the last page with rows.
      if (!answer.items.length && answer.total > 0 && page > answer.pages) setPage(answer.pages);
      return answer;
    },
    placeholderData: keepPreviousData,
  });
  const alerts = useQuery({
    queryKey: ["admin", "audit", "alerts"],
    queryFn: async () => {
      const since = new Date(Date.now() - 7 * 864e5).toISOString();
      return (await api<{ items: AuditEntry[] }>(`/audit-logs?action=auth.&from=${encodeURIComponent(since)}&limit=200`)).items.filter(a => ALERT_ACTIONS.has(a.action));
    },
  });
  const active = (staff.data ?? []).filter(u => u.status === "ACTIVE");
  const supers = active.filter(u => u.roles.some(r => r.role === "SUPER_ADMIN"));
  const on = (list: typeof active) => list.filter(u => u.mfa?.enabled).length;
  const locks = (alerts.data ?? []).filter(a => a.action === "auth.locked" || a.action === "auth.mfa_locked").length;
  const ctx = { merchants: merchants.data, staff: staff.data };
  const row = (a: AuditEntry) => [auditTitle(a), a.actorLabel || "System", auditScope(a, ctx), when(a.createdAt), auditSource(a), "Success"];
  const items = log.data?.items ?? [];

  return (
    <>
      <PageHeading
        eyebrow="Security & accountability"
        title="Audit & security log"
        subtitle="Review privileged account activity, security events, and platform configuration changes."
        actions={
          <Button icon="download" onClick={() => saveCsv("audit-log.csv", [["EVENT", "ACTOR", "SCOPE", "TIMESTAMP", "SOURCE", "RESULT"], ...items.map(row)])}>
            Export log
          </Button>
        }
      />
      <div className="metrics">
        <Metric label="Privileged actions" icon="sheet" value={overview.data ? num(overview.data.auditEventsThisMonth) : "—"} foot="this month" note="recorded user actions" />
        <Metric label="MFA coverage" icon="lock" value={staff.data ? pct(on(active), active.length) : "—"} foot={`${on(supers)} of ${supers.length} super admins`} note={`${on(active)} of ${active.length} staff accounts`} />
        <Metric label="Security alerts" icon="alert" value={alerts.data ? num(alerts.data.length) : "—"} foot={`${num(locks)} lockout${locks === 1 ? "" : "s"}`} note="failed sign-ins · last 7 days" />
        <Metric label="Audit retention" icon="settings" value="365 days" foot="platform policy" note="log management" />
      </div>
      <Panel
        title="Audit log register"
        subtitle="Newest first · every entry, 20 a page unless you choose more"
        tools={
          <input
            className="input sm"
            type="search"
            placeholder="Search action or person"
            aria-label="Search action or person"
            value={search}
            onChange={e => {
              setSearch(e.target.value);
              setPage(1);
            }}
            style={{ width: 220 }}
          />
        }
      >
        {log.error ? <div className="callout bad" style={{ margin: 16 }}>{describe(log.error)}</div> : null}
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Event</th>
                <th>Actor</th>
                <th>Scope</th>
                <th>Timestamp</th>
                <th>Source</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {items.map(a => {
                const r = row(a);
                return (
                  <tr key={a.id}>
                    <td className="strong">{r[0]}</td>
                    <td>{r[1]}</td>
                    <td>{r[2]}</td>
                    <td className="nowrap">{r[3]}</td>
                    <td>{r[4]}</td>
                    <td>
                      <Pill tone="good">{r[5]}</Pill>
                    </td>
                  </tr>
                );
              })}
              {!items.length ? (
                <tr>
                  <td colSpan={6} className="faint" style={{ textAlign: "center" }}>
                    {log.isLoading ? "Loading the log…" : q ? "No entries match the search." : "No entries yet."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <Pager
          page={page}
          pages={Math.max(1, log.data?.pages ?? 1)}
          size={size}
          total={log.data?.total ?? 0}
          shown={items.length}
          noun="entry"
          sizes={[20, 50, 100]}
          busy={log.isFetching}
          text={log.data?.total ? `Showing ${num((page - 1) * size + 1)}–${num((page - 1) * size + items.length)} of ${num(log.data.total)}` : "No entries"}
          setPage={setPage}
          setSize={s => {
            setSize(s);
            setPage(1);
          }}
        />
      </Panel>
    </>
  );
}
