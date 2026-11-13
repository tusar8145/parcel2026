/**
 * The parcel drawer (?parcel=<tracking ID>): next action and the other actions, failed attempts, partial delivery,
 * "Where is it now", details, price, proof of delivery, staff notes, messages sent and the tracking history.
 * Stays open beside the page while you work; follows live changes (bridge-parcel.js paintDrawer).
 */
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, describe, download } from "@panel/lib/api";
import { useLive } from "@panel/lib/events";
import { localPhone, money, when } from "@panel/lib/format";
import { useOps } from "@/lib/ops";
import { Icon } from "@panel/ui/Icon";
import { Button, MoreMenu, Pill } from "@panel/ui/kit";
import { toast } from "@panel/ui/toast";
import { changeProductType, changeReturnCharge, printLabels, refreshParcels } from "./actions";
import { CLOSED, PICKUP_STAGE, awaitingDropOff, failedDelivery, failureBadge, failureText, riderOf, slaOf, type Parcel } from "./model";
import { useParcelActions } from "./useParcelActions";
import { MessagePlanView } from "@panel/ui/MessagePlan";
import { CnPhotos, DeliveredMap } from "./CnDetails";

const PositionMap = lazy(() => import("@panel/ui/PositionMap"));

/** Delivery proof as booked: not required, one specific method, or any of the parcel's methods. */
const PROOF_SHORT: Record<string, string> = { PHOTO: "Scan POD photo", OTP: "OTP", SIGNATURE: "Signature" };
function proofText(p: { proofRequired?: boolean; proofMethod?: string | null; proofMethods?: string[] }) {
  if (p.proofRequired === false) return "Not required";
  if (p.proofMethod) return `Required · ${PROOF_SHORT[p.proofMethod] ?? p.proofMethod} only`;
  return p.proofMethods?.length ? `Required · ${p.proofMethods.map(m => PROOF_SHORT[m] ?? m).join(" / ")}` : "Required";
}

export default function ParcelDrawer() {
  const [params, setParams] = useSearchParams();
  const id = params.get("parcel");
  const matches = (params.get("matches") || "").split(",").filter(Boolean);
  const close = () =>
    setParams(p => {
      p.delete("parcel");
      p.delete("matches");
      return p;
    });
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!id) return;
    closeRef.current?.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => e.key === "Escape" && !document.querySelector("dialog[open]") && close();
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  if (!id) return null;
  return (
    <aside className="drawer" role="dialog" aria-modal="false" aria-labelledby="drawerTitle">
      <DrawerContent id={id} matches={matches} close={close} closeRef={closeRef} />
    </aside>
  );
}

/** A parcel's full details (the side panel's content; also the search window's right pane). */
export function DrawerContent({ id, matches, close, closeRef }: { id: string; matches: string[]; close: () => void; closeRef: React.RefObject<HTMLButtonElement | null> }) {
  const qc = useQueryClient();
  const actions = useParcelActions();
  const q = useQuery({ queryKey: ["parcel", id], queryFn: () => api<Parcel>(`/parcels/${encodeURIComponent(id)}`), staleTime: 5_000 });
  useLive(["parcel.updated"], () => void q.refetch(), { fallbackMs: 60_000 });
  const p = q.data;

  if (q.isError)
    return (
      <>
        <header className="drawer-head">
          <h2 id="drawerTitle">{id}</h2>
          <button ref={closeRef} type="button" className="button sm icon" aria-label="Close parcel details" onClick={close}>
            <Icon name="x" />
          </button>
        </header>
        <div className="drawer-body">
          <div className="callout bad">{q.error instanceof ApiError && q.error.status === 404 ? `Parcel ${id} was not found.` : describe(q.error)}</div>
        </div>
      </>
    );
  const badge = p && failureBadge(p);
  return (
    <>
      <header className="drawer-head">
        <div>
          <h2 id="drawerTitle" className="mono">
            {id}
          </h2>
          {p ? (
            <div className="row" style={{ marginTop: 6, gap: 6 }}>
              <Pill>{p.statusLabel}</Pill>
              <Pill>{slaOf(p)}</Pill>
              {badge ? <span className="pill bad" title={failureText(p, when)}>{`Failed ×${badge.count}${badge.reason ? ` · ${badge.reason.slice(0, 26)}` : ""}`}</span> : null}
            </div>
          ) : null}
        </div>
        <button ref={closeRef} type="button" className="button sm icon" aria-label="Close parcel details" onClick={close}>
          <Icon name="x" />
        </button>
      </header>
      <div className="drawer-body">
        {matches.length > 1 ? (
          <section>
            <h3 className="section-title">{matches.length} matching parcels</h3>
            <div className="stack" style={{ gap: 6 }}>
              {matches.map(m => (
                <button key={m} type="button" className={`button sm ${m === id ? "primary" : ""}`} style={{ justifyContent: "space-between" }} onClick={() => actions.openParcel(m, matches)}>
                  <span>{m}</span>
                  <MatchLabel id={m} />
                </button>
              ))}
            </div>
          </section>
        ) : null}
        {!p ? (
          <div className="stack">
            <span className="skeleton" style={{ width: "60%" }} />
            <span className="skeleton" />
            <span className="skeleton" style={{ width: "80%" }} />
          </div>
        ) : (
          <>
            <Actions p={p} />
            <FailedSection p={p} />
            <PartialSection p={p} />
            <section>
              <h3 className="section-title">Where is it now</h3>
              <Suspense fallback={<span className="faint">Finding the parcel…</span>}>
                <PositionMap trackingId={p.trackingId} status={`${p.status}:${p.updatedAt}`} />
              </Suspense>
            </section>
            <section>
              <h3 className="section-title">Parcel</h3>
              <KV
                rows={[
                  ["Merchant / sender", p.merchant?.name || p.sender?.name || "—"],
                  ["Recipient", [p.recipient?.name, localPhone(p.recipient?.phone)].filter(Boolean).join(" · ") || "—"],
                  ["Deliver to", p.delivery?.label || "—"],
                  ["Pickup from", p.intake === "DROP_OFF" ? `Drop-off at ${p.dropOffHub?.name || "hub"}` : p.pickup?.label || "—"],
                  ["Service", [p.serviceLevelLabel, p.type === "DOCUMENT" ? "Document" : "Parcel", p.weightKg != null ? `${p.weightKg} kg` : ""].filter(Boolean).join(" · ")],
                  ["Delivery type", p.deliveryType || p.service?.speedLabel || ""],
                  ["Priority", p.priority || ""],
                  ["Delivery proof", proofText(p)],
                  [
                    "Product",
                    p.product ? (
                      <span key="product">
                        {p.product}
                        {p.systemProduct && p.systemProduct.toLowerCase() !== p.product.toLowerCase() ? (
                          <small className="faint" style={{ display: "block", fontSize: 11 }} title="The system product this name was matched to">{`System product: ${p.systemProduct}`}</small>
                        ) : null}
                      </span>
                    ) : (
                      ""
                    ),
                  ],
                  ["Rider", riderOf(p)],
                  ["Hub", p.currentHub?.name || "—"],
                  ["Order ref", p.merchantOrderRef || ""],
                  ["Booked", when(p.createdAt)],
                  ["Promised by", p.estimatedDeliveryAt ? when(p.estimatedDeliveryAt) : ""],
                  ["Missing", p.incomplete ? (p.missingLabels || []).join(", ") : ""],
                  ["Return", p.returnInfo ? [p.returnInfo.reason, p.returnInfo.runId ? "in a return run" : "awaiting a return run"].filter(Boolean).join(" · ") : ""],
                ]}
              />
            </section>
            {p.chargesOff ? null : (
              <section>
                <h3 className="section-title">Price</h3>
                <Price p={p} />
              </section>
            )}
            <section>
              <h3 className="section-title">Messages (SMS · email · push)</h3>
              <MessagePlanView plan={p.messagePlan} />
            </section>
            <section>
              <h3 className="section-title">Proof of delivery</h3>
              <Proof p={p} />
            </section>
            {p.deliveredLocation ? (
              <section>
                <h3 className="section-title">Delivered at</h3>
                <DeliveredMap at={p.deliveredLocation} />
              </section>
            ) : null}
            {p.cnFlow ? (
              <section>
                <h3 className="section-title">CN photos (CN_Scan)</h3>
                <CnPhotos trackingId={p.trackingId} />
              </section>
            ) : null}
            <Notes p={p} onSaved={fresh => qc.setQueryData(["parcel", id], fresh)} />
            <Messages id={p.trackingId} />
            <section>
              <h3 className="section-title">Tracking history</h3>
              <History p={p} />
            </section>
          </>
        )}
      </div>
    </>
  );
}

function MatchLabel({ id }: { id: string }) {
  const qc = useQueryClient();
  const p = qc.getQueryData<Parcel>(["parcel", id]);
  return <span style={{ fontWeight: 500 }}>{p ? `${p.recipient.name || "—"} · ${p.statusLabel}` : ""}</span>;
}

function KV({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="kv">
      {rows
        .filter(([, v]) => v != null && v !== "")
        .map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
    </dl>
  );
}

function Actions({ p }: { p: Parcel }) {
  const a = useParcelActions();
  const ops = useOps();
  const next = a.next(p);
  const dispatch = ops.can("dispatch");
  const corrections = a.corrections(p);
  const open = !CLOSED.includes(p.status);
  return (
    <section>
      <h3 className="section-title">Actions</h3>
      <div className="row" style={{ gap: 6 }}>
        {next ? (
          <Button size="sm" variant="primary" title={next.title} onClick={() => a.run(next.kind, p)}>
            {next.label}
          </Button>
        ) : null}
        {failedDelivery(p) && dispatch ? (
          <Button size="sm" variant="primary" title="Schedule the return to the sender, optionally on a return run" onClick={() => a.returnToSender(p)}>
            Return to sender
          </Button>
        ) : null}
        {dispatch && open ? (
          <>
            {next?.kind !== "edit" ? (
              <Button size="sm" onClick={() => a.edit(p)}>
                Edit details
              </Button>
            ) : null}
            {next?.kind !== "accept" && next?.kind !== "assign" && (PICKUP_STAGE.includes(p.status) || p.status === "AT_HUB") && !awaitingDropOff(p) ? (
              <Button size="sm" onClick={() => a.assign(p)}>
                Assign rider
              </Button>
            ) : null}
            {a.canChangeIntake(p) ? (
              <Button size="sm" onClick={() => a.changeIntake(p)}>
                {p.intake === "DROP_OFF" ? "Change to rider pickup" : "Change to drop-off"}
              </Button>
            ) : null}
            {p.status === "PENDING_CONFIRMATION" ? (
              <Button size="sm" onClick={() => a.cancel(p)}>
                Cancel request
              </Button>
            ) : null}
          </>
        ) : null}
        <Button size="sm" icon="print" onClick={() => printLabels([p.trackingId])}>
          Print label (PDF)
        </Button>
        <MoreMenu
          items={[
            corrections.productType && { label: "Change product type", onSelect: () => changeProductType(p) },
            corrections.returnCharge && { label: "Return charge", onSelect: () => changeReturnCharge(p) },
          ]}
        />
      </div>
    </section>
  );
}

const NEXT_STEP: Record<string, string> = { RETRY: "Retry planned", RETURN_TO_HUB: "Back to hub" };
function FailedSection({ p }: { p: Parcel }) {
  const count = Number(p.failedAttempts) || 0;
  if (!count) return null;
  const attempts = [...(p.attempts || [])].reverse();
  const fallback = (p.events || []).filter(e => /failed/i.test(e.title)).reverse();
  return (
    <section>
      <h3 className="section-title">Delivery attempts ({count} failed)</h3>
      {failedDelivery(p) ? (
        <div className="callout bad" style={{ marginBottom: 8 }}>
          {p.returnedAfterFailure
            ? `Back at ${p.currentHub?.name || "the hub"} after a failed delivery. Re-attempt with a rider or return it to the sender.`
            : "Delivery failed; another attempt is scheduled. Re-attempt with a rider or return it to the sender."}
        </div>
      ) : null}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Rider</th>
              <th>Result · reason</th>
              <th>Next</th>
            </tr>
          </thead>
          <tbody>
            {attempts.length
              ? attempts.map(a => (
                  <tr key={a.id}>
                    <td className="nowrap">{when(a.at)}</td>
                    <td>{a.rider ? `${a.rider.code} · ${a.rider.name}` : "—"}</td>
                    <td>
                      {a.outcome === "FAILED" ? <Pill tone="bad">Failed</Pill> : <Pill tone="good">Delivered</Pill>} {a.reason || ""}
                      {a.note ? <span className="sub">{a.note}</span> : null}
                    </td>
                    <td>{a.nextAction ? NEXT_STEP[a.nextAction] || a.nextAction : ""}</td>
                  </tr>
                ))
              : fallback.length
                ? fallback.map(e => (
                    <tr key={e.id}>
                      <td className="nowrap">{when(e.at)}</td>
                      <td>{e.actor || "—"}</td>
                      <td>{e.description || e.title}</td>
                      <td />
                    </tr>
                  ))
                : (
                  <tr>
                    <td colSpan={4} className="empty">
                      No attempt details recorded.
                    </td>
                  </tr>
                )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PartialSection({ p }: { p: Parcel }) {
  const a = useParcelActions();
  const taka = (n: unknown) => `৳${Math.round(Number(n) || 0).toLocaleString("en-US")}`;
  if (p.partialDelivery) {
    const d = p.partialDelivery;
    return (
      <section>
        <h3 className="section-title">Partial delivery</h3>
        <p style={{ margin: "0 0 8px" }}>
          The recipient kept part of the order and paid <strong>{taka(d.codCollected)}</strong>
          {d.codAmount ? ` of the ${taka(d.codAmount)} COD` : ""}. The delivery charge is unchanged.{d.note ? <em> {d.note}</em> : null}
        </p>
        <div className="row">
          {d.returnOrders.map(r => (
            <button key={r.trackingId} type="button" className="button sm" onClick={() => a.openParcel(r.trackingId)}>
              {r.trackingId} · return order
            </button>
          ))}
        </div>
      </section>
    );
  }
  if (p.returnOf)
    return (
      <section>
        <h3 className="section-title">Return order</h3>
        <p style={{ margin: 0 }}>
          Carries back what the recipient didn't keep on the partial delivery of{" "}
          <button type="button" className="link-button" onClick={() => a.openParcel(p.returnOf!)}>
            {p.returnOf}
          </button>
          . Return charge: <strong>{p.returnInfo?.chargeWaived ? "not charged" : taka(p.returnInfo?.charge)}</strong>.
        </p>
      </section>
    );
  return null;
}

function Price({ p }: { p: Parcel }) {
  const c = p.charges || {};
  const lines = c.lines?.length
    ? c.lines
    : (
        [
          ["Base charge", c.base],
          ["Weight", c.weight],
          ["Service", c.service],
          ["COD fee", c.codFee],
          ["Re-attempt", c.reattempt],
          ["Discount", c.discount ? -Math.abs(c.discount) : 0],
        ] as [string, number | undefined][]
      )
        .filter(([, amount]) => Number(amount))
        .map(([label, amount]) => ({ label, amount: Number(amount) }));
  return (
    <div>
      <dl className="kv">
        {lines.map(l => (
          <div key={l.label} style={{ display: "contents" }}>
            <dt>{l.label}</dt>
            <dd className="mono">{money(l.amount)}</dd>
          </div>
        ))}
        <dt style={{ color: "var(--ink)", fontWeight: 600 }}>Total</dt>
        <dd className="mono" style={{ color: "var(--ink)", fontWeight: 650 }}>
          {money(c.total)}
        </dd>
      </dl>
      {Number(p.codAmount) ? (
        <p className="muted" style={{ margin: "8px 0 0" }}>
          Cash on delivery: <strong>{money(p.codAmount)}</strong>
          {p.cod ? ` · ${p.cod.state.toLowerCase().replace(/_/g, " ")}` : ""}
        </p>
      ) : null}
    </div>
  );
}

const METHOD: Record<string, string> = { OTP: "Delivery code", SIGNATURE: "Signature", PHOTO: "Photo" };
function Proof({ p }: { p: Parcel }) {
  const q = useQuery({
    queryKey: ["parcel", p.trackingId, "proof"],
    queryFn: () => api<{ rider?: { code: string; name: string }; otpVerified?: boolean; location?: { lat: number; lng: number }; note?: string; image?: { fileId: string } }>(`/parcels/${encodeURIComponent(p.trackingId)}/proof`),
    enabled: !!p.proof,
    staleTime: 60_000,
  });
  if (!p.proof) return <p className="muted" style={{ margin: 0 }}>{p.status === "DELIVERED" ? "No proof of delivery recorded." : "Recorded by the rider at delivery."}</p>;
  const full = q.data;
  const rows: [string, React.ReactNode][] = [
    ["Method", METHOD[p.proof.method] || p.proof.method],
    ["Received by", [p.proof.receivedBy || "—", p.receiverRelation && p.receiverRelation !== "Self" ? `(${p.receiverRelation})` : p.receiverRelation === "Self" ? "(self)" : ""].filter(Boolean).join(" ")],
    ["Recorded", when(p.proof.recordedAt)],
  ];
  if (full?.rider) rows.push(["Rider", `${full.rider.code} · ${full.rider.name}`]);
  if (full?.otpVerified) rows.push(["Code", "Verified"]);
  if (full?.location) rows.push(["Location", `${full.location.lat.toFixed(5)}, ${full.location.lng.toFixed(5)}`]);
  if (full?.note) rows.push(["Note", full.note]);
  return (
    <>
      <KV rows={rows} />
      {q.isError ? <p className="muted">{describe(q.error)}</p> : null}
      {full?.image ? (
        <p style={{ margin: "8px 0 0" }}>
          <Button size="sm" onClick={() => download(`/files/${encodeURIComponent(full.image!.fileId)}`, "proof-of-delivery")}>
            Open {p.proof.method === "SIGNATURE" ? "signature" : "photo"}
          </Button>
        </p>
      ) : null}
    </>
  );
}

function Notes({ p, onSaved }: { p: Parcel; onSaved: (fresh: Parcel) => void }) {
  const ops = useOps();
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<{ text: string; tone: "good" | "bad" | "" } | null>(null);
  const [busy, setBusy] = useState(false);
  const notes = [...(p.events || [])].filter(e => e.internal).reverse();
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const note = draft.trim();
    if (note.length < 2) return setStatus({ text: "Write the note first (at least 2 characters).", tone: "bad" });
    setBusy(true);
    setStatus({ text: "Saving…", tone: "" });
    try {
      const fresh = await api<Parcel>(`/parcels/${encodeURIComponent(p.trackingId)}/notes`, { method: "POST", body: { note } });
      onSaved(fresh);
      setDraft("");
      setStatus({ text: "Note added.", tone: "good" });
      toast(`${p.trackingId}: note added.`, "good");
      refreshParcels(p.trackingId);
    } catch (err) {
      setStatus({ text: describe(err), tone: "bad" });
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <h3 className="section-title">Staff notes</h3>
      {ops.can("dispatch") ? (
        <form onSubmit={save} className="stack" style={{ gap: 6, marginBottom: 10 }}>
          <label className="field">
            <span>Add a staff note</span>
            <textarea className="textarea" rows={2} maxLength={1000} placeholder="e.g. Recipient asked for delivery after 5 pm" value={draft} onChange={e => setDraft(e.target.value)} aria-invalid={status?.tone === "bad" ? true : undefined} />
          </label>
          <div className="row">
            <Button type="submit" size="sm" variant="primary" disabled={busy} aria-busy={busy || undefined}>
              Add note
            </Button>
            <small role="status" aria-live="polite" style={{ color: status?.tone === "bad" ? "var(--bad)" : status?.tone === "good" ? "var(--good)" : "var(--muted)" }}>
              {status?.text}
            </small>
          </div>
          <small className="faint">Staff only · recorded on the parcel's timeline with your name.</small>
        </form>
      ) : null}
      {notes.length ? (
        <div className="stack" style={{ gap: 8 }}>
          {notes.map(n => (
            <div key={n.id} style={{ padding: "9px 11px", border: "1px solid var(--line)", borderRadius: 8 }}>
              <strong style={{ color: "var(--ink)" }}>{n.title}</strong>
              {n.description ? <div className="muted" style={{ marginTop: 3 }}>{n.description}</div> : null}
              <small className="faint" style={{ display: "block", marginTop: 4 }}>
                {[when(n.at), n.actor].filter(Boolean).join(" · ")}
              </small>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          No staff notes yet.
        </p>
      )}
    </section>
  );
}

interface Message {
  id: string;
  channel: string;
  eventLabel: string;
  state: "SENT" | "PENDING" | "FAILED" | string;
  subject?: string | null;
  text: string;
  to: string;
  sentAt?: string | null;
  queuedAt?: string | null;
  provider?: string | null;
  attempts: number;
  lastError?: string | null;
}
const MESSAGE_STATE: Record<string, [string, "good" | "warn" | "bad"]> = { SENT: ["Sent", "good"], PENDING: ["Queued", "warn"], FAILED: ["Failed", "bad"] };
function Messages({ id }: { id: string }) {
  const q = useQuery({ queryKey: ["parcel", id, "messages"], queryFn: () => api<{ items: Message[] }>(`/parcels/${encodeURIComponent(id)}/messages`), staleTime: 30_000 });
  return (
    <section>
      <h3 className="section-title row" style={{ justifyContent: "space-between" }}>
        Messages sent
        <button type="button" className="button sm" style={{ textTransform: "none", letterSpacing: 0 }} onClick={() => void q.refetch()}>
          Refresh
        </button>
      </h3>
      {q.isLoading ? <p className="muted">Loading messages…</p> : null}
      {q.isError ? <p className="muted">{describe(q.error)}</p> : null}
      {q.data && !q.data.items.length ? <p className="muted" style={{ margin: 0 }}>No SMS or email has been sent about this parcel.</p> : null}
      <div className="stack" style={{ gap: 8 }}>
        {q.data?.items.map(m => {
          const [label, tone] = MESSAGE_STATE[m.state] || [m.state, "warn"];
          return (
            <div key={m.id} style={{ padding: "9px 11px", border: "1px solid var(--line)", borderRadius: 8 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong style={{ color: "var(--ink)" }}>
                  {m.channel === "EMAIL" ? "Email" : "SMS"} · {m.eventLabel}
                </strong>
                <Pill tone={tone}>{label}</Pill>
              </div>
              <div className="muted" style={{ marginTop: 4, whiteSpace: "pre-line" }}>
                {m.subject ? `${m.subject}\n` : ""}
                {m.text.length > 320 ? `${m.text.slice(0, 320)}…` : m.text}
              </div>
              <small className="faint" style={{ display: "block", marginTop: 4 }}>
                {[`To ${m.to}`, when(m.sentAt || m.queuedAt), m.provider, m.attempts > 1 ? `${m.attempts} attempts` : ""].filter(Boolean).join(" · ")}
              </small>
              {m.lastError && m.state !== "SENT" ? <small style={{ display: "block", color: "var(--bad)" }}>{m.lastError}</small> : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function History({ p }: { p: Parcel }) {
  const events = [...(p.events || [])].reverse();
  if (!events.length) return <p className="muted" style={{ margin: 0 }}>No tracking events yet.</p>;
  return (
    <ol className="timeline">
      {events.map(e => (
        <li key={e.id}>
          <strong>
            {e.title}
            {e.internal ? " · internal" : ""}
          </strong>
          {e.location || e.description ? <div className="muted">{[e.location, e.description].filter(Boolean).join(" · ")}</div> : null}
          <small>{[when(e.at), e.actor].filter(Boolean).join(" · ")}</small>
        </li>
      ))}
    </ol>
  );
}
