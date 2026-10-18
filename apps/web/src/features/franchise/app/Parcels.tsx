"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog, Empty, Field, Pill, STATUS_TONE, api, describe, tk, useAction, useApi, useToast, when, type Me, type ParcelItem, type Rider } from "./ui";

const TABS = [
  { view: "incoming", label: "Incoming", hint: "Sent to your hub: scan them in when they arrive." },
  { view: "at-hub", label: "At your hub", hint: "Assign a rider to deliver, or send to another hub." },
  { view: "pickups", label: "Pickups", hint: "Pickups handed to your hub: assign one of your riders." },
  { view: "drop-offs", label: "Awaiting drop-off", hint: "Merchants or customers will bring these to your hub." },
  { view: "out", label: "Out for delivery", hint: "With your riders now." },
  { view: "returns", label: "Returns", hint: "Parcels to take back to their merchants." },
  { view: "delivered", label: "Delivered (7 days)", hint: "Delivered by your riders." },
] as const;
type View = (typeof TABS)[number]["view"];

interface ReturnRun {
  id: string;
  number: string;
  status: string;
  merchant: string | null;
  rider: string | null;
  parcels: string[];
  createdAt: string;
}

export default function Parcels({ me }: { me: Me }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const [view, setView] = useState<View>(() => (TABS.find(t => t.view === new URLSearchParams(location.search).get("tab"))?.view ?? "at-hub") as View);
  const [q, setQ] = useState("");
  const path = `/franchise/parcels?view=${view}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}`;
  const list = useApi<{ items: ParcelItem[] }>(path, ["parcel.updated", "parcel.created"]);
  const riders = useApi<Rider[]>("/franchise/riders");
  const runs = useApi<ReturnRun[]>(view === "returns" ? "/franchise/return-runs" : null);
  const activeRiders = useMemo(() => (riders.data ?? []).filter(r => r.active), [riders.data]);
  const [assignFor, setAssignFor] = useState<{ parcel: ParcelItem; task: "PICKUP" | "DELIVERY" } | null>(null);
  const [sendFor, setSendFor] = useState<ParcelItem | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [returnRider, setReturnRider] = useState("");

  const selectTab = (v: View) => {
    setView(v);
    setPicked([]);
    const url = new URL(location.href);
    url.searchParams.set("tab", v);
    history.replaceState(null, "", url);
  };

  // ───────────── scan in ─────────────
  const [code, setCode] = useState("");
  const [scan, setScan] = useState<{ ok: boolean; text: string } | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);
  const receive = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = code.trim();
    if (!value) return;
    try {
      const res = await api<{ ok: boolean; message: string }>("/franchise/receive", { method: "POST", body: { code: value, source: "KEYBOARD" } });
      setScan({ ok: res.ok, text: res.message });
      if (res.ok) void list.reload();
    } catch (err) {
      setScan({ ok: false, text: describe(err) });
    }
    setCode("");
    scanRef.current?.focus();
  };

  const items = list.data?.items ?? [];
  const tab = TABS.find(t => t.view === view)!;

  return (
    <>
      <div className="fr-heading">
        <div>
          <p className="fr-eyebrow">{me.hub.name}</p>
          <h1>Parcels</h1>
          <p>Receive, assign your riders, send on to other hubs and take returns back.</p>
        </div>
      </div>

      <section className="fr-card" aria-label="Receive">
        <div className="fr-card-head">
          <div>
            <h2>Receive at your hub</h2>
            <p>Scan or type the tracking number of a parcel arriving from another hub, a drop-off or a transfer.</p>
          </div>
        </div>
        <form className="fr-scan" onSubmit={receive}>
          <input ref={scanRef} id="frScan" value={code} onChange={e => setCode(e.target.value)} placeholder="Tracking number, e.g. PP-261018-B54GG" autoComplete="off" aria-label="Tracking number" />
          <button type="submit" className="fr-btn primary" style={{ height: 42 }}>
            Receive
          </button>
        </form>
        {scan ? (
          <div className={`fr-scan-result ${scan.ok ? "ok" : "bad"}`} id="frScanResult" role="status">
            {scan.text}
          </div>
        ) : null}
      </section>

      <section className="fr-card">
        <div className="fr-card-head" style={{ alignItems: "center" }}>
          <div className="fr-tabs" role="tablist" aria-label="Parcels">
            {TABS.map(t => (
              <button key={t.view} type="button" role="tab" data-tab={t.view} aria-selected={view === t.view} onClick={() => selectTab(t.view)}>
                {t.label}
              </button>
            ))}
          </div>
          <input
            className="fr-search"
            aria-label="Search"
            placeholder="Search tracking, phone or name"
            value={q}
            onChange={e => setQ(e.target.value)}
            style={{ height: 36, border: "1px solid #dfe3e8", borderRadius: 8, padding: "0 10px", minWidth: 220 }}
          />
        </div>
        <p className="fr-hint" style={{ marginBottom: 10 }}>
          {tab.hint}
        </p>

        {view === "returns" ? (
          <div className="fr-notice" style={{ marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ flex: 1, minWidth: 220 }}>{picked.length ? `${picked.length} selected. Choose the rider taking them back.` : "Tick the parcels to take back, then choose the rider."}</span>
            <select id="frReturnRider" value={returnRider} onChange={e => setReturnRider(e.target.value)} style={{ height: 34, border: "1px solid #c9d6f8", borderRadius: 8, padding: "0 8px" }}>
              <option value="">Choose a rider</option>
              {activeRiders.map(r => (
                <option key={r.id} value={r.id}>{`${r.code} · ${r.name}`}</option>
              ))}
            </select>
            <button
              type="button"
              className="fr-btn primary sm"
              id="frCreateReturnRun"
              disabled={!picked.length || !returnRider || busy === "return"}
              onClick={() =>
                void run("return", () => api<ReturnRun[]>("/franchise/return-runs", { method: "POST", body: { trackingIds: picked, riderId: returnRider } }), r => `${r.length} return run${r.length === 1 ? "" : "s"} sent out.`).then(r => {
                  if (!r) return;
                  setPicked([]);
                  void list.reload();
                  void runs.reload();
                })
              }
            >
              Send back to merchant
            </button>
          </div>
        ) : null}

        {list.error ? <div className="fr-notice amber">{list.error}</div> : null}
        <div className="fr-table-wrap">
          <table className="fr-table" id="frParcels">
            <thead>
              <tr>
                {view === "returns" ? <th aria-label="Select" /> : null}
                <th>Parcel</th>
                <th>From</th>
                <th>To</th>
                <th>Status</th>
                <th className="num">COD</th>
                <th className="num">Delivery charge</th>
                <th>Rider</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map(p => {
                const rider = p.deliveryRider ?? p.pickupRider;
                const canPick = view === "returns" && !p.onReturnRun && p.merchant;
                return (
                  <tr key={p.trackingId} data-parcel={p.trackingId}>
                    {view === "returns" ? (
                      <td>
                        {canPick ? (
                          <input
                            type="checkbox"
                            aria-label={`Select ${p.trackingId}`}
                            checked={picked.includes(p.trackingId)}
                            onChange={e => setPicked(s => (e.target.checked ? [...s, p.trackingId] : s.filter(t => t !== p.trackingId)))}
                          />
                        ) : null}
                      </td>
                    ) : null}
                    <td>
                      <strong>{p.trackingId}</strong>
                      <small>{when(p.updatedAt)}</small>
                    </td>
                    <td>{p.sender}</td>
                    <td>
                      {p.recipient}
                      <small>{p.destination}</small>
                    </td>
                    <td>
                      <Pill tone={STATUS_TONE[p.status] ?? ""}>{p.statusLabel}</Pill>
                      {p.returnReason ? <small>{`Return: ${p.returnReason}`}</small> : null}
                    </td>
                    <td className="num">{p.codAmount ? tk(p.codAmount) : "—"}</td>
                    <td className="num">{tk(p.deliveryCharge)}</td>
                    <td>{rider ? rider.label : "—"}</td>
                    <td className="actions">
                      {view === "pickups" && !p.pickupRider ? (
                        <button type="button" className="fr-btn sm primary" data-assign="PICKUP" onClick={() => setAssignFor({ parcel: p, task: "PICKUP" })}>
                          Assign rider
                        </button>
                      ) : null}
                      {view === "at-hub" ? (
                        <>
                          <button type="button" className="fr-btn sm primary" data-assign="DELIVERY" onClick={() => setAssignFor({ parcel: p, task: "DELIVERY" })}>
                            Assign rider
                          </button>{" "}
                          <button type="button" className="fr-btn sm" data-send onClick={() => setSendFor(p)}>
                            Send to hub
                          </button>
                        </>
                      ) : null}
                      {view === "returns" && p.onReturnRun ? <Pill tone="amber">On a return run</Pill> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!list.loading && !items.length ? <Empty>{q ? "No parcels match your search." : "Nothing here right now."}</Empty> : null}
        </div>
      </section>

      {view === "returns" && runs.data?.length ? (
        <section className="fr-card" aria-label="Return runs">
          <div className="fr-card-head">
            <div>
              <h2>Return runs out now</h2>
              <p>Mark a run done when the rider has handed the parcels to the merchant.</p>
            </div>
          </div>
          <div className="fr-table-wrap">
            <table className="fr-table" id="frReturnRuns">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Merchant</th>
                  <th>Rider</th>
                  <th>Parcels</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {runs.data.map(r => (
                  <tr key={r.id} data-run={r.number}>
                    <td>
                      <strong>{r.number}</strong>
                      <small>{when(r.createdAt)}</small>
                    </td>
                    <td>{r.merchant ?? "—"}</td>
                    <td>{r.rider ?? "—"}</td>
                    <td>{r.parcels.join(", ")}</td>
                    <td className="actions">
                      <button
                        type="button"
                        className="fr-btn sm primary"
                        data-complete-run={r.id}
                        disabled={busy === r.id}
                        onClick={() =>
                          void run(r.id, () => api(`/franchise/return-runs/${r.id}/complete`, { method: "POST", body: {} }), `${r.number}: returned to ${r.merchant ?? "the merchant"}.`).then(ok => {
                            if (ok === undefined) return;
                            void runs.reload();
                            void list.reload();
                          })
                        }
                      >
                        Returned to merchant
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {assignFor ? (
        <AssignDialog
          parcel={assignFor.parcel}
          task={assignFor.task}
          riders={activeRiders}
          onClose={() => setAssignFor(null)}
          onDone={() => {
            setAssignFor(null);
            void list.reload();
          }}
        />
      ) : null}
      {sendFor ? (
        <SendDialog
          me={me}
          parcel={sendFor}
          onClose={() => setSendFor(null)}
          onDone={hub => {
            setSendFor(null);
            toast(`${sendFor.trackingId} is on its way to ${hub}.`);
            void list.reload();
          }}
        />
      ) : null}
    </>
  );
}

function AssignDialog({ parcel, task, riders, onClose, onDone }: { parcel: ParcelItem; task: "PICKUP" | "DELIVERY"; riders: Rider[]; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const [riderId, setRiderId] = useState(riders[0]?.id ?? "");
  const submit = useCallback(
    () =>
      void run("assign", () => api(`/franchise/parcels/${parcel.trackingId}/assign`, { method: "POST", body: { riderId, task } }), `${parcel.trackingId} assigned.`).then(r => r !== undefined && onDone()),
    [run, parcel, riderId, task, onDone],
  );
  return (
    <Dialog title={`Assign a rider · ${parcel.trackingId}`} subtitle={task === "PICKUP" ? `Collect from ${parcel.sender}.` : `Deliver to ${parcel.recipient}, ${parcel.destination}.`} onClose={onClose}>
      {riders.length ? (
        <Field label="Rider" htmlFor="frAssignRider">
          <select id="frAssignRider" value={riderId} onChange={e => setRiderId(e.target.value)}>
            {riders.map(r => (
              <option key={r.id} value={r.id}>{`${r.code} · ${r.name}${r.outForDelivery ? ` (${r.outForDelivery} out now)` : ""}`}</option>
            ))}
          </select>
        </Field>
      ) : (
        <div className="fr-notice amber">Add a rider first (Riders page).</div>
      )}
      <div className="fr-dialog-actions">
        <button type="button" className="fr-btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="fr-btn primary" id="frAssignSubmit" disabled={!riderId || busy === "assign"} onClick={submit}>
          Assign
        </button>
      </div>
    </Dialog>
  );
}

function SendDialog({ me, parcel, onClose, onDone }: { me: Me; parcel: ParcelItem; onClose: () => void; onDone: (hub: string) => void }) {
  const { busy, run } = useAction();
  const [hubId, setHubId] = useState(me.sendHubs[0]?.id ?? "");
  useEffect(() => setHubId(h => h || me.sendHubs[0]?.id || ""), [me.sendHubs]);
  const hub = me.sendHubs.find(h => h.id === hubId);
  return (
    <Dialog title={`Send to another hub · ${parcel.trackingId}`} subtitle="The receiving hub scans it in when it arrives." onClose={onClose}>
      <Field label="Hub" htmlFor="frSendHub">
        <select id="frSendHub" value={hubId} onChange={e => setHubId(e.target.value)}>
          {me.sendHubs.map(h => (
            <option key={h.id} value={h.id}>{`${h.name} (${h.district})${h.type === "FRANCHISE" ? " · Franchise" : ""}`}</option>
          ))}
        </select>
      </Field>
      <div className="fr-dialog-actions">
        <button type="button" className="fr-btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="fr-btn primary"
          id="frSendSubmit"
          disabled={!hubId || busy === "send"}
          onClick={() => void run("send", () => api(`/franchise/parcels/${parcel.trackingId}/send`, { method: "POST", body: { hubId } })).then(r => r !== undefined && onDone(hub?.name ?? "the hub"))}
        >
          Send
        </button>
      </div>
    </Dialog>
  );
}
