/**
 * Scan desk › Rider operation: choose a rider, then do the rider app's steps for them (hub-desk/riders/:riderId/…, the
 * rider app's own rules on the server): Pickup from merchant, Receive from hub (optional, a check only), Start
 * deliveries, Deliver (code, signature or photo; cash; partial), Could not deliver (reason; try again / return to
 * sender) and Returned to merchant. The rider app's wording (mobile/rider_app/lib/scan.dart, deliveries.dart).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError, describe } from "@panel/lib/api";
import { num } from "@panel/lib/format";
import { useOps } from "@/lib/ops";
import { Button, Empty, Panel, Pill } from "@panel/ui/kit";
import { Select } from "@panel/ui/Select";
import { LogList, shrink, type LogEntry } from "./deskShared";
import { normalizeScan, ScanInput, type ScanInputHandle } from "./scanner";

type Step = "pickup" | "receive" | "start" | "deliver" | "failed" | "returned";
const STEPS: [Step, string][] = [
  ["pickup", "Pickup from merchant"],
  ["receive", "Receive from hub (optional)"],
  ["start", "Start deliveries"],
  ["deliver", "Deliver"],
  ["failed", "Could not deliver"],
  ["returned", "Returned to merchant"],
];
const HINT: Record<Step, string> = {
  pickup: "At a merchant: choose the pickup, then scan each parcel they hand over.",
  receive: "At the hub: scan the parcels given to the rider to check they are theirs (deliveries and returns). Nothing changes.",
  start: "Before the rider leaves: scan each parcel as it is loaded. The recipient gets the delivery code by SMS.",
  deliver: "At the door: scan the parcel (or pick it below), then the cash and the proof.",
  failed: "Choose the reason and what happens next once, then scan each parcel it applies to.",
  returned: "Choose the return run, then scan each parcel the merchant takes back.",
};
/** Fallback while the super admin's list loads (GET /delivery/fail-reasons). */
const REASONS = ["Recipient unavailable", "Incorrect address", "Recipient refused", "Unable to contact recipient", "Access / safety issue"];
const PROOF_LABEL: Record<string, string> = { OTP: "Recipient's code", SIGNATURE: "Signature", PHOTO: "Photo", NONE: "No proof" };
const taka = (n: number) => `৳${num(n)}`;

interface TaskParcel {
  trackingId: string;
  status: string;
  statusLabel?: string;
  recipient?: { name?: string | null; phone?: string | null } | null;
  merchant?: { name?: string } | null;
  codAmount?: number | string | null;
  proofRequired?: boolean;
  proofMethods?: string[];
  deliveryCodeSent?: boolean;
  devDeliveryCode?: string | null;
  pickupStop?: { key: string; name: string | null; address: string };
}
interface Tasks {
  pickups: TaskParcel[];
  deliveries: TaskParcel[];
  carrying: TaskParcel[];
}
interface Run {
  id: string;
  number: string;
  status: string;
  merchant: { name: string; address: string; phone: string | null };
  parcels: { trackingId: string; recipientName: string | null; returnReason: string | null }[];
}

/** Kept while the panel is open (switching tabs keeps the work). */
const rop = {
  riderId: "",
  step: "pickup" as Step,
  stopKey: "",
  reason: "",
  next: "RETRY",
  note: "",
  runId: "",
  receivedBy: "",
  logs: { pickup: [], receive: [], start: [], deliver: [], failed: [], returned: [] } as Record<Step, LogEntry[]>,
};

export default function RiderOperation() {
  const ops = useOps();
  const [, force] = useState(0);
  const redraw = () => force(n => n + 1);
  const set = (patch: Partial<typeof rop>) => (Object.assign(rop, patch), redraw());
  const own = new Set(ops.myHubs?.map(h => h.id) ?? []);
  // The rider's own hub's riders first (as the other rider choices), then by name.
  const riders = useMemo(
    () => ops.riders.filter(r => r.active !== false).sort((a, b) => Number(own.has(b.hub?.id ?? "")) - Number(own.has(a.hub?.id ?? "")) || (a.label || a.name).localeCompare(b.label || b.name)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ops.riders, ops.myHubs],
  );
  const rider = riders.find(r => r.id === rop.riderId) ?? null;
  const base = rider ? `/hub-desk/riders/${encodeURIComponent(rider.id)}` : "";
  const tasks = useQuery({ queryKey: ["rider-op", "tasks", rop.riderId], queryFn: () => api<Tasks>(`${base}/tasks`), enabled: !!rider, staleTime: 5_000 });
  const runs = useQuery({ queryKey: ["rider-op", "runs", rop.riderId], queryFn: async () => (await api<{ items: Run[] }>(`${base}/return-runs`)).items, enabled: !!rider, staleTime: 5_000 });
  const refresh = () => Promise.all([tasks.refetch(), runs.refetch()]);
  const add = (step: Step, entry: LogEntry) => {
    rop.logs[step] = [entry, ...rop.logs[step]].slice(0, 100);
    redraw();
  };

  return (
    <Panel title={`Rider operation${rider ? ` · ${rider.label || `${rider.code} · ${rider.name}`}` : ""}`} subtitle="Choose a rider, then do the rider app's steps for them (the rider app's own rules). You are recorded as the one who entered it.">
      <div className="panel-body">
        <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label className="field" style={{ minWidth: 280, flex: "0 1 340px" }}>
            <span>Rider</span>
            <Select className="select" value={rop.riderId} onChange={e => set({ riderId: e.target.value, stopKey: "", runId: "" })}>
              <option value="">— Choose the rider —</option>
              {riders.map(r => (
                <option key={r.id} value={r.id}>
                  {`${r.label || `${r.code} · ${r.name}`}${r.hub?.name ? ` · ${r.hub.name}` : ""}`}
                </option>
              ))}
            </Select>
          </label>
          {rider && tasks.data ? (
            <div className="row" style={{ gap: 6, flexWrap: "wrap", paddingBottom: 6 }}>
              <Pill tone="neutral">{`${tasks.data.pickups.length} pickups`}</Pill>
              <Pill tone="neutral">{`${tasks.data.carrying.length} carrying`}</Pill>
              <Pill tone="neutral">{`${tasks.data.deliveries.length} deliveries`}</Pill>
              <Pill tone="neutral">{`${runs.data?.length ?? 0} return runs`}</Pill>
            </div>
          ) : null}
        </div>
        {!rider ? (
          <Empty title="No rider chosen">Choose the rider whose steps you're doing.</Empty>
        ) : (
          <>
            <div className="row" role="tablist" aria-label="Rider steps" style={{ gap: 6, flexWrap: "wrap", margin: "14px 0 10px" }}>
              {STEPS.map(([id, label]) => (
                <button key={id} type="button" role="tab" aria-selected={rop.step === id} className={`button sm${rop.step === id ? " primary" : ""}`} onClick={() => set({ step: id })}>
                  {label}
                </button>
              ))}
            </div>
            <p className="muted" style={{ margin: "0 0 10px", fontSize: 12.5 }}>
              {HINT[rop.step]}
            </p>
            {tasks.isError ? <p className="form-error">{describe(tasks.error)}</p> : null}
            <StepBody key={`${rop.riderId}-${rop.step}`} step={rop.step} base={base} riderName={rider.label || rider.name} tasks={tasks.data} runs={runs.data} refresh={refresh} add={add} set={set} />
            <LogList entries={rop.logs[rop.step]} />
          </>
        )}
      </div>
    </Panel>
  );
}

interface StepProps {
  step: Step;
  base: string;
  riderName: string;
  tasks?: Tasks;
  runs?: Run[];
  refresh: () => Promise<unknown>;
  add: (step: Step, entry: LogEntry) => void;
  set: (patch: Partial<typeof rop>) => void;
}

function StepBody(props: StepProps) {
  switch (props.step) {
    case "pickup":
      return <PickupStep {...props} />;
    case "receive":
      return <ReceiveStep {...props} />;
    case "start":
      return <ScanStep {...props} label="Scan each parcel as the rider loads it" run={code => post(props.base, `/parcels/${encodeURIComponent(code)}/start-delivery`, {}).then(() => `${code} out for delivery · code sent to the recipient`)} />;
    case "deliver":
      return <DeliverStep {...props} />;
    case "failed":
      return <FailedStep {...props} />;
    case "returned":
      return <ReturnedStep {...props} />;
  }
}

const post = (base: string, path: string, body: Record<string, unknown>) => api<Record<string, unknown>>(`${base}${path}`, { method: "POST", body });

/** One scan box: each code runs the step; the answer (or the API's refusal) goes to the log. */
function ScanStep({ step, add, refresh, label, run, disabled, children }: StepProps & { label: string; run: (code: string) => Promise<string>; disabled?: boolean; children?: React.ReactNode }) {
  const box = useRef<ScanInputHandle>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  function scan(raw: string) {
    const code = normalizeScan(raw);
    queue.current = queue.current.then(async () => {
      try {
        const message = await run(code);
        box.current?.feedback(true, message);
        add(step, { tone: "", message, at: new Date() });
      } catch (error) {
        // The API's refusal as it says it; a check of our own (Receive from hub) as written.
        const message = `${code}: ${error instanceof ApiError || !(error instanceof Error) ? describe(error) : error.message}`;
        box.current?.feedback(false, message);
        add(step, { tone: "bad", message, at: new Date() });
      }
      void refresh();
    });
  }
  return (
    <>
      {children}
      <ScanInput ref={box} onScan={scan} label={label} disabled={disabled} id="ropScan" />
    </>
  );
}

function PickupStep(props: StepProps) {
  const pickups = props.tasks?.pickups ?? [];
  const stops = [...new Map(pickups.filter(p => p.pickupStop).map(p => [p.pickupStop!.key, p.pickupStop!])).values()];
  const stopKey = stops.some(s => s.key === rop.stopKey) ? rop.stopKey : (stops[0]?.key ?? "");
  const expected = pickups.filter(p => p.pickupStop?.key === stopKey);
  return (
    <ScanStep
      {...props}
      label={stops.length ? "Scan each parcel the merchant hands over" : "No pickup assigned to this rider"}
      disabled={!stops.length}
      run={code => post(props.base, `/parcels/${encodeURIComponent(code)}/pickup`, { outcome: "COLLECTED", ...(stopKey ? { expectedStop: stopKey } : {}) }).then(() => `${code} collected`)}
    >
      {stops.length ? (
        <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 10 }}>
          <label className="field" style={{ minWidth: 280 }}>
            <span>Which pickup?</span>
            <Select className="select" value={stopKey} onChange={e => props.set({ stopKey: e.target.value })}>
              {stops.map(s => (
                <option key={s.key} value={s.key}>
                  {`${s.name ?? "Sender"} · ${pickups.filter(p => p.pickupStop?.key === s.key).length} parcel(s)`}
                </option>
              ))}
            </Select>
          </label>
          <small className="faint" style={{ paddingBottom: 8 }}>{`${expected.length} still to collect here: ${expected.slice(0, 6).map(p => p.trackingId).join(", ")}${expected.length > 6 ? ", …" : ""}`}</small>
        </div>
      ) : (
        <Empty title="No pickups">This rider has no pickup to do. Assign one on Assign pickup rider.</Empty>
      )}
    </ScanStep>
  );
}

function ReceiveStep(props: StepProps) {
  const find = (code: string, tasks?: Tasks, runs?: Run[]) => {
    const d = tasks?.deliveries.find(p => p.trackingId === code);
    if (d) return `${code} is ${props.riderName}'s delivery: ${d.recipient?.name ?? ""}`.trim();
    const run = runs?.find(r => r.parcels.some(p => p.trackingId === code));
    if (run) return `${code} is on ${props.riderName}'s return run ${run.number} (${run.merchant.name})`;
    return null;
  };
  return (
    <ScanStep
      {...props}
      label="Scan each parcel the hub gives the rider"
      run={async code => {
        let hit = find(code, props.tasks, props.runs);
        if (!hit) {
          const [tasks, runs] = (await props.refresh()) as [{ data?: Tasks }, { data?: Run[] }];
          hit = find(code, tasks?.data, runs?.data);
        }
        if (!hit) throw new Error("not assigned to this rider. Assign it first (Delivery rider assign or Return rider assign).");
        return hit;
      }}
    />
  );
}

function DeliverStep(props: StepProps) {
  const deliveries = (props.tasks?.deliveries ?? []).filter(p => ["ASSIGNED", "OUT_FOR_DELIVERY", "RETRY_SCHEDULED", "EXCEPTION"].includes(p.status));
  const [open, setOpen] = useState<string | null>(null);
  const box = useRef<ScanInputHandle>(null);
  const parcel = deliveries.find(p => p.trackingId === open) ?? null;
  if (parcel)
    return (
      <DeliverForm
        parcel={parcel}
        base={props.base}
        onCancel={() => setOpen(null)}
        onDone={message => {
          props.add("deliver", { tone: "", message, at: new Date() });
          setOpen(null);
          void props.refresh();
        }}
      />
    );
  return (
    <>
      <ScanInput
        ref={box}
        id="ropScan"
        label="Scan the parcel at the door"
        onScan={raw => {
          const code = normalizeScan(raw);
          if (deliveries.some(p => p.trackingId === code)) return setOpen(code);
          const message = `${code} is not one of this rider's deliveries.`;
          box.current?.feedback(false, message);
          props.add("deliver", { tone: "bad", message, at: new Date() });
        }}
      />
      {deliveries.length ? (
        <div className="table-wrap" style={{ marginTop: 12, maxHeight: 320, overflow: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Parcel</th>
                <th>Recipient</th>
                <th>Status</th>
                <th className="num">COD</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {deliveries.map(p => (
                <tr key={p.trackingId}>
                  <td className="strong mono">{p.trackingId}</td>
                  <td>{p.recipient?.name || "—"}</td>
                  <td>{p.statusLabel || p.status}</td>
                  <td className="num">{taka(Number(p.codAmount ?? 0))}</td>
                  <td className="num">
                    <Button size="sm" variant="primary" onClick={() => setOpen(p.trackingId)}>
                      Deliver
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="No deliveries">This rider has no delivery to complete.</Empty>
      )}
    </>
  );
}

function DeliverForm({ parcel, base, onCancel, onDone }: { parcel: TaskParcel; base: string; onCancel: () => void; onDone: (message: string) => void }) {
  const cod = Number(parcel.codAmount ?? 0);
  const required = parcel.proofRequired !== false;
  const methods = [...(parcel.proofMethods?.length ? parcel.proofMethods : ["OTP", "SIGNATURE", "PHOTO"]), ...(required ? [] : ["NONE"])];
  const relations = useQuery({ queryKey: ["receiver-relations"], queryFn: async () => (await api<{ relations: string[] }>("/delivery/receiver-relations")).relations, staleTime: 10 * 60_000 });
  const [receivedBy, setReceivedBy] = useState(parcel.recipient?.name ?? "");
  const [relation, setRelation] = useState("Self");
  const [method, setMethod] = useState(required ? methods[0] : "NONE");
  const [otp, setOtp] = useState("");
  const [photo, setPhoto] = useState<string | null>(null);
  const [partial, setPartial] = useState(false);
  const [cash, setCash] = useState(String(cod));
  const [cashConfirmed, setCashConfirmed] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pad = useRef<SignaturePadHandle>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const started = parcel.deliveryCodeSent === true || parcel.status === "OUT_FOR_DELIVERY";

  async function resend() {
    try {
      await post(base, `/parcels/${encodeURIComponent(parcel.trackingId)}/resend-code`, {});
      setError(null);
      setOtp("");
      alertOk("A new code was sent to the recipient.");
    } catch (e) {
      setError(describe(e));
    }
  }
  const [okText, alertOk] = useState<string | null>(null);

  async function submit() {
    setError(null);
    if (!receivedBy.trim()) return setError("Enter who received it.");
    let proof: Record<string, string> | undefined;
    if (method === "OTP") {
      if (!otp.trim()) return setError("Enter the code from the recipient's SMS.");
      proof = { method: "OTP", otp: otp.trim() };
    } else if (method === "SIGNATURE") {
      const png = pad.current?.toDataUrl();
      if (!png) return setError("Ask the recipient to sign in the box.");
      proof = { method: "SIGNATURE", image: png };
    } else if (method === "PHOTO") {
      if (!photo) return setError("Take a photo of the signed invoice.");
      proof = { method: "PHOTO", image: photo };
    }
    const collected = partial ? Number(cash) : cod;
    if (partial && (!Number.isFinite(collected) || collected < 0 || collected > cod)) return setError(`Enter an amount from ৳0 to ${taka(cod)}`);
    if (cod > 0 && !partial && !cashConfirmed) return setError(`Confirm that the rider collected ${taka(cod)}.`);
    setBusy(true);
    try {
      await post(base, `/parcels/${encodeURIComponent(parcel.trackingId)}/delivery`, {
        outcome: "DELIVERED",
        receivedBy: receivedBy.trim(),
        receiverRelation: relation,
        ...(proof ? { proof } : {}),
        codCollected: collected,
        ...(partial ? { partial: true } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        capture: { capturedAt: new Date().toISOString() },
      });
      onDone(partial ? `${parcel.trackingId} partly delivered · ${taka(collected)} collected` : `${parcel.trackingId} delivered${cod > 0 ? ` · ${taka(collected)} collected` : ""}`);
    } catch (e) {
      setError(describe(e));
      setBusy(false);
    }
  }

  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 12, padding: 16, display: "grid", gap: 14 }}>
      <div className="row" style={{ justifyContent: "space-between", gap: 12 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 16 }} className="mono">{`Deliver ${parcel.trackingId}`}</h3>
          <small className="faint">{[parcel.recipient?.name, parcel.recipient?.phone, parcel.statusLabel].filter(Boolean).join(" · ")}</small>
        </div>
        <Button size="sm" onClick={onCancel}>
          Back to the list
        </Button>
      </div>
      <div className="form-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        <label className="field">
          <span>Received by · Name</span>
          <input className="input" maxLength={120} value={receivedBy} onChange={e => setReceivedBy(e.target.value)} />
        </label>
        <label className="field">
          <span>Relation to the recipient</span>
          <Select className="select" value={relation} onChange={e => setRelation(e.target.value)}>
            {(relations.data?.length ? relations.data : ["Self"]).map(r => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </label>
      </div>
      {cod > 0 ? (
        <div className="field">
          <span className="field-label">Cash</span>
          {!partial ? (
            <label className="check" style={{ fontWeight: 700, color: "var(--good)" }}>
              <input type="checkbox" checked={cashConfirmed} onChange={e => setCashConfirmed(e.target.checked)} /> {`The rider collected ${taka(cod)}`}
            </label>
          ) : null}
          {parcel.merchant ? (
            <label className="check">
              <input type="checkbox" checked={partial} onChange={e => setPartial(e.target.checked)} /> Partial delivery · The recipient kept only part of the order; the rest goes back to the merchant.
            </label>
          ) : null}
          {partial ? (
            <label className="field" style={{ maxWidth: 260 }}>
              <span>{`Cash collected (৳0 to ${taka(cod)})`}</span>
              <input className="input" type="number" min={0} max={cod} step="any" value={cash} onChange={e => setCash(e.target.value)} />
            </label>
          ) : null}
        </div>
      ) : (
        <p className="muted" style={{ margin: 0 }}>No cash to collect</p>
      )}
      <div className="field">
        <span className="field-label">Proof</span>
        {methods.length > 1 ? (
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            {methods.map(m => (
              <button key={m} type="button" className={`button sm${method === m ? " primary" : ""}`} onClick={() => setMethod(m)}>
                {PROOF_LABEL[m] ?? m}
              </button>
            ))}
          </div>
        ) : null}
        {method === "NONE" ? <p className="muted" style={{ margin: "6px 0 0" }}>This parcel was booked without proof required: the delivery can be completed without it.</p> : null}
        {method === "OTP" ? (
          <div style={{ display: "grid", gap: 6, marginTop: 6, maxWidth: 360 }}>
            {!started ? <p style={{ margin: 0, color: "var(--warn, #8a5300)" }}>Start the delivery first: the code is sent to the recipient then.</p> : null}
            <input className="input" inputMode="numeric" maxLength={8} placeholder="Code from the recipient's SMS" value={otp} onChange={e => setOtp(e.target.value)} />
            {parcel.devDeliveryCode ? <small className="faint">{`Test code: ${parcel.devDeliveryCode}`}</small> : null}
            <div>
              <Button size="sm" disabled={!started} onClick={() => void resend()}>
                Send the code again
              </Button>
              {okText ? <small className="faint" style={{ marginLeft: 8 }}>{okText}</small> : null}
            </div>
          </div>
        ) : null}
        {method === "SIGNATURE" ? (
          <div style={{ marginTop: 6 }}>
            <SignaturePad ref={pad} />
            <div className="row" style={{ gap: 8, marginTop: 4 }}>
              <small className="faint">The recipient signs in the box.</small>
              <Button size="sm" onClick={() => pad.current?.clear()}>
                Clear
              </Button>
            </div>
          </div>
        ) : null}
        {method === "PHOTO" ? (
          <div className="row" style={{ gap: 8, marginTop: 6 }}>
            <Button icon="camera" onClick={() => photoInput.current?.click()}>
              {photo ? "Take it again" : "Take a photo of the signed invoice"}
            </Button>
            {photo ? <img src={photo} alt="Signed invoice" style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 8, border: "1px solid var(--line)" }} /> : null}
            <input
              ref={photoInput}
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              onChange={e => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) shrink(file).then(setPhoto, err => setError(describe(err)));
              }}
            />
          </div>
        ) : null}
      </div>
      <label className="field">
        <span>Note (optional)</span>
        <input className="input" maxLength={500} value={note} onChange={e => setNote(e.target.value)} />
      </label>
      {error ? (
        <p role="alert" className="form-error" style={{ margin: 0 }}>
          {error}
        </p>
      ) : null}
      <div>
        <Button variant="primary" icon="check" disabled={busy} onClick={() => void submit()}>
          {busy ? "Saving…" : "Confirm delivery"}
        </Button>
      </div>
    </div>
  );
}

function FailedStep(props: StepProps) {
  const reasons = useQuery({ queryKey: ["fail-reasons"], queryFn: async () => (await api<{ reasons: string[] }>("/delivery/fail-reasons")).reasons, staleTime: 10 * 60_000 });
  // As the rider app's batch "Could not deliver": the list without "Other" (that one needs a note per parcel).
  const list = (reasons.data?.length ? reasons.data : REASONS).filter(r => r !== "Other");
  const reason = list.includes(rop.reason) ? rop.reason : (list[0] ?? "");
  useEffect(() => {
    if (reason && reason !== rop.reason) rop.reason = reason;
  }, [reason]);
  return (
    <ScanStep
      {...props}
      label="Scan each parcel it applies to"
      run={code =>
        post(props.base, `/parcels/${encodeURIComponent(code)}/delivery`, { outcome: "FAILED", reason, nextAction: rop.next, ...(rop.note.trim() ? { note: rop.note.trim() } : {}) }).then(
          () => `${code} saved: ${reason} (${rop.next === "RETRY" ? "try again" : "return to sender"})`,
        )
      }
    >
      <div className="form-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", marginBottom: 10 }}>
        <label className="field">
          <span>Why could they not be delivered?</span>
          <Select className="select" value={reason} onChange={e => props.set({ reason: e.target.value })}>
            {list.map(r => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </label>
        <div className="field">
          <span className="field-label">What next?</span>
          <div className="row" style={{ gap: 6 }}>
            {[
              ["RETRY", "Try again"],
              ["RETURN", "Return to sender"],
            ].map(([v, l]) => (
              <button key={v} type="button" className={`button sm${rop.next === v ? " primary" : ""}`} onClick={() => props.set({ next: v })}>
                {l}
              </button>
            ))}
          </div>
        </div>
        <label className="field">
          <span>Note (optional)</span>
          <input className="input" maxLength={500} value={rop.note} onChange={e => props.set({ note: e.target.value })} />
        </label>
      </div>
    </ScanStep>
  );
}

function ReturnedStep(props: StepProps) {
  const runs = props.runs ?? [];
  const runId = runs.some(r => r.id === rop.runId) ? rop.runId : (runs[0]?.id ?? "");
  const run = runs.find(r => r.id === runId);
  return (
    <ScanStep
      {...props}
      disabled={!run}
      label={run ? `Scan each parcel ${run.merchant.name} takes back` : "No return run assigned to this rider"}
      run={code =>
        post(props.base, `/parcels/${encodeURIComponent(code)}/return`, { runId, ...(rop.receivedBy.trim() ? { receivedBy: rop.receivedBy.trim() } : {}) }).then(r => `${code} returned${r.runCompleted ? ` · ${run?.number ?? "the run"} complete` : ""}`)
      }
    >
      {runs.length ? (
        <div className="form-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", marginBottom: 10 }}>
          <label className="field">
            <span>Which return run?</span>
            <Select className="select" value={runId} onChange={e => props.set({ runId: e.target.value })}>
              {runs.map(r => (
                <option key={r.id} value={r.id}>
                  {`${r.number} · ${r.merchant.name} · ${r.parcels.length} parcel(s)`}
                </option>
              ))}
            </Select>
          </label>
          <label className="field">
            <span>Who is taking the parcels back? · Name (optional)</span>
            <input className="input" maxLength={120} value={rop.receivedBy} onChange={e => props.set({ receivedBy: e.target.value })} />
          </label>
          {run ? <small className="faint" style={{ alignSelf: "end", paddingBottom: 8 }}>{`${run.parcels.length} still to return: ${run.parcels.slice(0, 6).map(p => p.trackingId).join(", ")}${run.parcels.length > 6 ? ", …" : ""}`}</small> : null}
        </div>
      ) : (
        <Empty title="No return runs">This rider has no return run. Give them returns on Return rider assign.</Empty>
      )}
    </ScanStep>
  );
}

// ───────────── signature pad ─────────────

interface SignaturePadHandle {
  toDataUrl: () => string | null;
  clear: () => void;
}

/** A box the recipient signs in (mouse, pen or finger): a PNG data URL, or null while nothing is drawn. */
const SignaturePad = function SignaturePad({ ref }: { ref: React.Ref<SignaturePadHandle> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawn = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * e.currentTarget.width) / r.width, y: ((e.clientY - r.top) * e.currentTarget.height) / r.height };
  };
  const clear = () => {
    const c = canvas.current;
    if (!c) return;
    const g = c.getContext("2d")!;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, c.width, c.height);
    drawn.current = false;
  };
  useEffect(clear, []);
  const handle: SignaturePadHandle = { toDataUrl: () => (drawn.current && canvas.current ? canvas.current.toDataURL("image/png") : null), clear };
  if (typeof ref === "function") ref(handle);
  else if (ref) (ref as React.MutableRefObject<SignaturePadHandle | null>).current = handle;
  return (
    <canvas
      ref={canvas}
      width={640}
      height={220}
      aria-label="Signature box"
      style={{ width: "100%", maxWidth: 520, height: 180, border: "1px solid var(--line)", borderRadius: 10, background: "#fff", touchAction: "none", cursor: "crosshair" }}
      onPointerDown={e => {
        e.currentTarget.setPointerCapture(e.pointerId);
        last.current = point(e);
      }}
      onPointerMove={e => {
        if (!last.current) return;
        const g = e.currentTarget.getContext("2d")!;
        const p = point(e);
        g.strokeStyle = "#101828";
        g.lineWidth = 3;
        g.lineCap = "round";
        g.beginPath();
        g.moveTo(last.current.x, last.current.y);
        g.lineTo(p.x, p.y);
        g.stroke();
        last.current = p;
        drawn.current = true;
      }}
      onPointerUp={() => (last.current = null)}
      onPointerLeave={() => (last.current = null)}
    />
  );
};

