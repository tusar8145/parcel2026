/**
 * Parcel queue (menu key "Work queue", bridge-workqueue.js): every parcel's next step worked out by the system,
 * by stage, with counts. A step opens into its groups (route, area, rider, hub); a group lists its parcels on the
 * right, exports them to Excel and has a scan box that does the step one parcel at a time. Counts follow live events.
 */
import { Select } from "@/ui/Select";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, describe, download } from "@/lib/api";
import { useLive } from "@/lib/events";
import { localPhone, num, when } from "@/lib/format";
import { useOps } from "@/lib/ops";
import { Button, Empty, PageHeading, Panel, Pill } from "@/ui/kit";
import { Icon } from "@/ui/Icon";
import { toastError } from "@/ui/toast";
import { useParcelActions } from "@/features/parcels/useParcelActions";
import { OperationTimeBar } from "@/features/scan/OperationTime";
import { ScanInput, type ScanInputHandle, type ScanSource } from "@/features/scan/scanner";

const STAGES = ["Pickup", "Hub", "Transfer", "Delivery", "Problems"];
const STAGE_LABEL: Record<string, string> = { Pickup: "Pickup", Hub: "Receive at hub", Transfer: "Between hubs", Delivery: "Delivery", Problems: "Returns & problems" };
const ASSIGN = new Set(["ASSIGN_PICKUP", "ASSIGN_DELIVERY"]);

interface Task {
  key: string;
  stage: string;
  label: string;
  hint: string;
  count: number;
  action: string | null;
  actionLabel?: string;
}
interface Overview {
  tasks: Task[];
  missingDetails?: { key: string; label: string; hint: string; count: number } | null;
}
interface Groups {
  groups: { key: string; label: string; count: number }[];
  total: number;
  truncated?: boolean;
}
interface Row {
  trackingId: string;
  statusLabel: string;
  merchant?: string;
  recipient?: string;
  recipientPhone?: string;
  missing?: string[];
  destination?: string;
  fromHub?: string;
  toHub?: string;
  rider?: string;
  currentHub?: string;
  waitingSince?: string;
}

const kept = { hubId: "", open: null as string | null, sel: null as { task: string; group: string } | null, riderId: {} as Record<string, string>, receiveHubId: "" };

export default function WorkQueue() {
  const ops = useOps();
  const qc = useQueryClient();
  const actions = useParcelActions();
  const [hubId, setHubId] = useState(kept.hubId);
  const [open, setOpen] = useState<string | null>(kept.open);
  const [sel, setSel] = useState(kept.sel);
  const [riderId, setRiderId] = useState<Record<string, string>>(kept.riderId);
  const [receiveHubId, setReceiveHubId] = useState(kept.receiveHubId);
  const [log, setLog] = useState<{ ok: boolean; message: string; at: Date }[]>([]);
  useEffect(() => void Object.assign(kept, { hubId, open, sel, riderId, receiveHubId }), [hubId, open, sel, riderId, receiveHubId]);
  const box = useRef<ScanInputHandle>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const own = ops.myHubs?.length === 1 ? ops.myHubs[0] : null;
  const qs = (extra: Record<string, string | undefined> = {}) => {
    const p = new URLSearchParams();
    if (hubId) p.set("hubId", hubId);
    for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : "";
  };

  const overview = useQuery({ queryKey: ["work-queue", "overview", hubId], queryFn: () => api<Overview>(`/work-queue${qs()}`) });
  const groupsOf = (key: string | null | undefined) => ({
    queryKey: ["work-queue", "groups", key, hubId],
    queryFn: () => api<Groups>(`/work-queue/${key}${qs()}`),
    enabled: !!key,
  });
  const openGroups = useQuery(groupsOf(open));
  const selGroups = useQuery(groupsOf(sel?.task));
  const list = useQuery({
    queryKey: ["work-queue", "list", sel?.task, sel?.group, hubId],
    queryFn: () => api<{ items: Row[]; total: number }>(`/work-queue/${sel!.task}/parcels${qs({ group: sel!.group })}`),
    enabled: !!sel,
  });
  useLive(["parcel.updated", "parcel.created", "linehaul.updated", "return_run.updated"], () => void qc.invalidateQueries({ queryKey: ["work-queue"] }), { debounceMs: 1500 });

  const o = overview.data;
  const taskOf = (key?: string | null): Task | null => (!key ? null : key === o?.missingDetails?.key ? { ...o.missingDetails, stage: "Problems", action: null } : o?.tasks.find(t => t.key === key) ?? null);
  const task = taskOf(sel?.task);

  function select(taskKey: string, group = "") {
    if (sel?.task !== taskKey || sel.group !== group) setReceiveHubId("");
    setSel({ task: taskKey, group });
    setLog([]);
  }

  function scan(code: string, source: ScanSource) {
    if (!task?.action || !sel) return;
    const rider = riderId[task.key] || "";
    if (ASSIGN.has(task.action) && !rider) {
      box.current?.feedback(false);
      return setLog(l => [{ ok: false, message: "Choose the rider first, then scan.", at: new Date() }, ...l]);
    }
    queue.current = queue.current.then(async () => {
      let r: { ok: boolean; message: string; parcel?: { trackingId: string } };
      try {
        r = await api(`/work-queue/${task.key}/scan`, {
          method: "POST",
          body: { code, source, group: sel.group || undefined, riderId: ASSIGN.has(task.action!) ? rider : undefined, hubId: task.action === "RECEIVE" ? own?.id || receiveHubId || undefined : undefined },
        });
      } catch (error) {
        r = { ok: false, message: describe(error) };
      }
      box.current?.feedback(r.ok, r.message);
      setLog(l => [{ ok: r.ok, message: r.message, at: new Date() }, ...l].slice(0, 50));
      if (r.ok && r.parcel)
        qc.setQueryData<{ items: Row[]; total: number }>(["work-queue", "list", sel.task, sel.group, hubId], d => d && { items: d.items.filter(p => p.trackingId !== r.parcel!.trackingId), total: Math.max(0, d.total - 1) });
      void qc.invalidateQueries({ queryKey: ["work-queue", "overview"] });
      void qc.invalidateQueries({ queryKey: ["work-queue", "groups"] });
    });
  }

  const hubs = ops.myHubs || ops.hubs;
  const missing = o?.missingDetails;
  const g = selGroups.data;
  const group = g?.groups.find(x => x.key === sel?.group);
  const transfer = !!task?.key.startsWith("transfer-");
  const riderCol = !!task && (task.key.startsWith("pickup") || task.key.startsWith("delivery") || task.key === "failed-receive");
  const l = list.data;
  return (
    <>
      <PageHeading
        eyebrow="Network operations · next steps"
        title="Parcel queue"
        subtitle="Every parcel's next step, worked out by the system. Open a step, choose a group, then scan parcels to do it."
        actions={
          <>
            <Select className="select" aria-label="Hub" value={hubId} onChange={e => setHubId(e.target.value)}>
              {ops.myHubs ? hubs.length > 1 ? <option value="">All my hubs</option> : null : <option value="">Whole network</option>}
              {hubs.map(h => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </Select>
            {missing ? (
              <button type="button" className="button danger" title={missing.hint} aria-current={sel?.task === missing.key} onClick={() => select(missing.key)}>
                {missing.label} <span className="pill bad">{num(missing.count)}</span>
              </button>
            ) : null}
            <Button icon="refresh" onClick={() => qc.invalidateQueries({ queryKey: ["work-queue"] })}>
              Refresh
            </Button>
            <OperationTimeBar />
          </>
        }
      />
      <div className="grid-main" style={{ gridTemplateColumns: "minmax(280px, 380px) minmax(0, 1fr)" }}>
        <section className="panel" aria-label="Next steps" style={{ padding: "6px 0" }}>
          {overview.isError ? <p className="muted" style={{ padding: 16 }}>{describe(overview.error)}</p> : null}
          {!o && !overview.isError ? <p className="muted" style={{ padding: 16 }}>Loading the work queue…</p> : null}
          {o
            ? STAGES.map(stage => {
                const tasks = o.tasks.filter(t => t.stage === stage);
                if (!tasks.length) return null;
                return (
                  <div key={stage}>
                    <div className="nav-label" style={{ padding: "12px 16px 4px" }}>
                      {STAGE_LABEL[stage]}
                    </div>
                    {tasks.map(t => {
                      const isOpen = open === t.key;
                      return (
                        <div key={t.key}>
                          <button type="button" className="menu-item" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : t.key)} style={{ padding: "10px 16px", borderRadius: 0, background: isOpen ? "var(--primary-soft)" : undefined }}>
                            <span style={{ display: "flex", transform: isOpen ? "rotate(90deg)" : undefined, transition: "transform .15s", color: "var(--faint)" }}>
                              <Icon name="chevronRight" size={14} />
                            </span>
                            <span className="grow" style={{ minWidth: 0 }}>
                              <strong style={{ display: "block", color: "var(--ink)" }}>{t.label}</strong>
                              <small className="faint" style={{ display: "block", fontWeight: 400 }}>
                                {t.hint}
                              </small>
                            </span>
                            <span className={`pill ${t.count ? "warn" : "neutral"}`}>{num(t.count)}</span>
                          </button>
                          {isOpen ? (
                            <div style={{ padding: "2px 12px 10px 28px", display: "grid", gap: 2 }}>
                              {!openGroups.data && !openGroups.isError ? <p className="muted">Loading…</p> : null}
                              {openGroups.isError ? <p className="muted">{describe(openGroups.error)}</p> : null}
                              {openGroups.data && !openGroups.data.groups.length ? <p className="muted">Nothing waiting.</p> : null}
                              {openGroups.data?.groups.length ? (
                                <>
                                  {[{ key: "", label: "All", count: openGroups.data.total }, ...openGroups.data.groups].map(x => (
                                    <button key={x.key} type="button" className="menu-item" aria-current={sel?.task === t.key && sel.group === x.key} onClick={() => select(t.key, x.key)} style={sel?.task === t.key && sel.group === x.key ? { background: "var(--primary-soft)", color: "var(--primary)", fontWeight: 650 } : undefined}>
                                      <span className="grow" style={{ overflowWrap: "anywhere" }}>
                                        {x.label}
                                      </span>
                                      <span className="pill neutral">{num(x.count)}</span>
                                    </button>
                                  ))}
                                  {openGroups.data.truncated ? <p className="muted">Showing the first 10,000 parcels.</p> : null}
                                </>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                );
              })
            : null}
        </section>
        {!task ? (
          <Panel>
            <Empty title="Choose a step on the left">Open it to see its groups, then choose a group to list, export and scan its parcels.</Empty>
          </Panel>
        ) : (
          <Panel
            title={`${task.label}${group ? ` · ${group.label}` : ""}`}
            subtitle={l ? `${num(l.total)} parcel${l.total === 1 ? "" : "s"}` : "Loading…"}
            tools={
              <>
                <Select className="select sm" aria-label="Group" value={sel!.group} onChange={e => select(sel!.task, e.target.value)} style={{ maxWidth: 280 }}>
                  <option value="">{`All (${num(g?.total ?? task.count ?? 0)})`}</option>
                  {(g?.groups || []).map(x => (
                    <option key={x.key} value={x.key}>
                      {`${x.label} (${num(x.count)})`}
                    </option>
                  ))}
                </Select>
                <Button size="sm" icon="download" disabled={!l?.total} onClick={() => download(`/work-queue/${sel!.task}/export${qs({ group: sel!.group })}`, "work-queue.xlsx").catch(toastError)}>
                  Excel
                </Button>
              </>
            }
          >
            {task.action && ops.can("dispatch") ? (
              <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)", background: "var(--surface-2)" }}>
                <div className="form-grid" style={{ gridTemplateColumns: ASSIGN.has(task.action) || (task.action === "RECEIVE" && !own) ? "minmax(200px, 280px) 1fr" : "1fr" }}>
                  {ASSIGN.has(task.action) ? (
                    <label className="field">
                      <span>Rider</span>
                      <Select className="select" value={riderId[task.key] || ""} onChange={e => setRiderId(r => ({ ...r, [task.key]: e.target.value }))}>
                        <option value="">— Choose the rider —</option>
                        {ops.riders
                          .filter(r => r.active !== false)
                          .map(r => (
                            <option key={r.id} value={r.id}>
                              {`${r.label || `${r.code} · ${r.name}`}${r.hub?.name ? ` · ${r.hub.name}` : ""}`}
                            </option>
                          ))}
                      </Select>
                    </label>
                  ) : task.action === "RECEIVE" && !own ? (
                    <label className="field">
                      <span>Receiving hub (optional)</span>
                      <Select className="select" value={receiveHubId} onChange={e => setReceiveHubId(e.target.value)}>
                        <option value="">Its expected hub</option>
                        {hubs.map(h => (
                          <option key={h.id} value={h.id}>
                            {h.name}
                          </option>
                        ))}
                      </Select>
                    </label>
                  ) : null}
                  <ScanInput ref={box} id="wqScan" big={false} label={`Scan or type a tracking ID · ${task.action === "RECEIVE" && own ? `Receive at ${own.name}` : task.actionLabel || "Do this step"}`} onScan={scan} />
                </div>
                {log.length ? (
                  <ul style={{ listStyle: "none", margin: "10px 0 0", padding: 0, display: "grid", gap: 4, maxHeight: 160, overflow: "auto" }} aria-live="polite">
                    {log.map((e, i) => (
                      <li key={i} style={{ fontSize: 12.5, padding: "5px 9px", borderRadius: 7, background: e.ok ? "var(--good-soft)" : "var(--bad-soft)", color: e.ok ? "var(--good)" : "var(--bad)" }}>
                        <time className="faint" style={{ marginRight: 6 }}>
                          {e.at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                        </time>
                        {e.message}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : !task.action ? (
              <p className="muted" style={{ padding: "10px 16px", margin: 0, borderBottom: "1px solid var(--line)" }}>
                {task.hint}
              </p>
            ) : null}
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Tracking ID</th>
                    <th>Status</th>
                    <th>Merchant / sender</th>
                    <th>Recipient</th>
                    <th>{transfer ? "From → to" : "Delivery area"}</th>
                    <th>{riderCol ? "Rider" : "Hub"}</th>
                    <th>Waiting since</th>
                  </tr>
                </thead>
                <tbody>
                  {l?.items.length ? (
                    l.items.map(p => (
                      <tr key={p.trackingId}>
                        <td>
                          <button type="button" className="link-button tracking" onClick={() => actions.openParcel(p.trackingId)}>
                            {p.trackingId}
                          </button>
                        </td>
                        <td>
                          <Pill>{p.statusLabel}</Pill>
                        </td>
                        <td>{p.merchant || "—"}</td>
                        <td>
                          {p.recipient || "—"}
                          {p.missing?.length ? <span className="sub" style={{ color: "var(--bad)" }}>Missing: {p.missing.join(", ")}</span> : p.recipientPhone ? <span className="sub">{localPhone(p.recipientPhone)}</span> : null}
                        </td>
                        <td>{transfer ? `${p.fromHub || "—"} → ${p.toHub || "No serving hub"}` : p.destination || "—"}</td>
                        <td>{(riderCol ? p.rider : p.currentHub) || "—"}</td>
                        <td className="nowrap">{when(p.waitingSince)}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={7} className="empty">
                        {list.isError ? describe(list.error) : l ? "Nothing waiting here." : "Loading…"}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {l && l.total > l.items.length ? <div className="panel-foot">{`Showing ${num(l.items.length)} of ${num(l.total)}. The Excel file has them all.`}</div> : null}
          </Panel>
        )}
      </div>
    </>
  );
}
