/**
 * Suggest riders (bridge-network.js, the original "Create dispatch"): suggested riders for every shipment waiting
 * at the hub, by zone, rider load and distance. Untick any to assign by hand.
 *   GET  /routing/suggestions?kind=delivery|pickup|all&limit=100[&hubId]
 *   POST /routing/suggestions/accept { items: [{ trackingId, riderId }] }
 */
import { Select } from "@panel/ui/Select";
import { Icon } from "@panel/ui/Icon";
import { useEffect, useState } from "react";
import { api, describe } from "@panel/lib/api";
import { when } from "@panel/lib/format";
import type { Hub } from "@/lib/types";
import { openCustom } from "@panel/ui/dialogs";
import { Button } from "@panel/ui/kit";
import { toast } from "@panel/ui/toast";

interface Suggestion {
  trackingId: string;
  kind: "pickup" | "delivery";
  zone: string;
  dueAt?: string | null;
  rider: { id: string; label: string };
  reasons: string[];
  score: number;
}
interface Result {
  suggestions: Suggestion[];
  unmatched: { trackingId: string; reason: string }[];
}

export function suggestRiders({ hubs, myHubs, kind, done }: { hubs: Hub[]; myHubs: Hub[] | null; kind: "pickup" | "delivery"; done: () => void }) {
  return openCustom(close => <SuggestDialog hubs={myHubs ?? hubs} mine={!!myHubs} kind={kind} close={() => close()} done={done} />, "wide");
}

function SuggestDialog({ hubs, mine, kind: initialKind, close, done }: { hubs: Hub[]; mine: boolean; kind: string; close: () => void; done: () => void }) {
  const [hubId, setHubId] = useState(mine ? (hubs[0]?.id ?? "") : "");
  const [kind, setKind] = useState(initialKind);
  const [data, setData] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [off, setOff] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    setData(null);
    setError("");
    setOff(new Set());
    api<Result>(`/routing/suggestions?kind=${kind}&limit=100${hubId ? `&hubId=${hubId}` : ""}`)
      .then(r => live && setData(r))
      .catch(e => live && setError(describe(e)));
    return () => void (live = false);
  }, [hubId, kind]);
  const items = data?.suggestions ?? [];
  const chosen = items.filter((_, i) => !off.has(i));
  async function assign() {
    if (!chosen.length) return setError("Select at least one suggestion to assign.");
    setBusy(true);
    try {
      const result = await api<{ assigned: unknown[]; failed: { trackingId: string; message: string }[] }>("/routing/suggestions/accept", {
        method: "POST",
        body: { items: chosen.map(s => ({ trackingId: s.trackingId, riderId: s.rider.id })) },
      });
      close();
      done();
      toast(
        `${result.assigned.length} shipment${result.assigned.length === 1 ? "" : "s"} assigned${result.failed.length ? `; ${result.failed.length} not assigned (${result.failed[0].trackingId}: ${result.failed[0].message})` : ""}.`,
        result.failed.length ? "default" : "good",
      );
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }
  const toggle = (i: number) => setOff(s => (s.has(i) ? (s.delete(i), new Set(s)) : new Set(s.add(i))));
  return (
    <>
      <div className="dialog-head">
        <div>
          <h2>Suggest riders</h2>
          <p>{data ? `${items.length} suggestion${items.length === 1 ? "" : "s"} by zone, rider load and distance. Untick any you want to assign by hand.` : "Suggested riders for every shipment waiting at the hub."}</p>
        </div>
        <button type="button" className="button ghost icon dialog-close" aria-label="Close" onClick={close}>
          <Icon name="x" size={18} />
        </button>
      </div>
      <div className="dialog-body">
        <div className="form-grid">
          <label className="field">
            <span>Hub</span>
            <Select className="select" value={hubId} onChange={e => setHubId(e.target.value)}>
              {mine ? null : <option value="">All hubs</option>}
              {hubs.map(h => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </Select>
          </label>
          <label className="field">
            <span>Shipments</span>
            <Select className="select" value={kind} onChange={e => setKind(e.target.value)}>
              <option value="delivery">Deliveries waiting at the hub</option>
              <option value="pickup">Pickup requests</option>
              <option value="all">Deliveries and pickups</option>
            </Select>
          </label>
        </div>
        <div className="table-wrap" style={{ maxHeight: 340, marginTop: 12 }}>
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 32 }}>
                  <input type="checkbox" aria-label="Select all" checked={!!items.length && !off.size} onChange={e => setOff(e.target.checked ? new Set() : new Set(items.map((_, i) => i)))} />
                </th>
                <th>Shipment</th>
                <th>Suggested rider</th>
                <th className="num">Score</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s, i) => (
                <tr key={s.trackingId}>
                  <td>
                    <input type="checkbox" checked={!off.has(i)} onChange={() => toggle(i)} aria-label={`Assign ${s.trackingId}`} />
                  </td>
                  <td>
                    <strong>{s.trackingId}</strong>
                    <span className="sub">
                      {s.kind === "pickup" ? "Pickup" : "Delivery"} · {s.zone}
                      {s.dueAt ? ` · due ${when(s.dueAt)}` : ""}
                    </span>
                  </td>
                  <td>
                    {s.rider.label}
                    <span className="sub">{s.reasons.join(" · ")}</span>
                  </td>
                  <td className="num">{s.score}</td>
                </tr>
              ))}
              {!items.length ? (
                <tr>
                  <td colSpan={4} className="empty">
                    {!data && !error ? "Finding riders…" : "No shipments are waiting for a rider here."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {data?.unmatched.length ? (
          <p className="faint" style={{ margin: "8px 0 0" }}>
            {data.unmatched.length} not matched: {data.unmatched.slice(0, 5).map(u => `${u.trackingId} (${u.reason})`).join(", ")}
            {data.unmatched.length > 5 ? "…" : ""}
          </p>
        ) : null}
        {error ? (
          <p role="alert" style={{ color: "var(--bad)", margin: "8px 0 0" }}>
            {error}
          </p>
        ) : null}
      </div>
      <div className="dialog-foot">
        <Button onClick={close} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void assign()} disabled={busy || !chosen.length} aria-busy={busy || undefined}>
          Assign selected{chosen.length ? ` (${chosen.length})` : ""}
        </Button>
      </div>
    </>
  );
}
