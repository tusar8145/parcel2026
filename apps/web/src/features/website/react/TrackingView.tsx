"use client";

import { useCallback, useEffect, useState } from "react";
import { df, describe, isApiError, toast } from "./df";
import { FieldError, useBusy, useForm } from "./form";

const STAGES = ["Order received", "Picked up", "At local hub", "Out for delivery", "Delivered"];
const PROOF: Record<string, string> = { SIGNATURE: "Signature", OTP: "OTP", PHOTO: "Photo" };
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : undefined);
const TRACKING_ID = /^[A-Z]{2,4}-\d{6}-[0-9A-Z]{4,8}$/;

/** What the tracking card shows, from either the public (masked) or the full parcel view. */
interface Item {
  trackingId: string;
  status: string;
  statusLabel: string;
  stage: number;
  serviceLevel: string;
  sender: string;
  senderArea: string;
  recipient: string;
  recipientPhone?: string;
  destination: string;
  destinationArea: string;
  contents?: string | null;
  weight: string;
  packaging?: string | null;
  payment: string;
  currentLocation: string;
  pickupWindow: string | null;
  eta?: string;
  deliveredAt?: string;
  proofMethod: string | null;
  canCancel: boolean;
  events: { time?: string; title: string; place: string; detail: string }[];
  full: boolean;
  feedback?: { rating: number; comment?: string | null } | null;
  canGiveFeedback?: boolean;
  /** Service packages: the rider's live position / phone while out for delivery. */
  live?: { rider: { name: string; phone: string | null }; location: { lat: number; lng: number; at: string } | null } | null;
  /** Hub Pickup: where the receiver collects it, and by when. */
  collect?: { hub: { name: string; address: string } | null; dueAt?: string | null } | null;
}

function toItem(p: any, full: boolean): Item {
  const events = [...(p.events ?? [])].filter((e: any) => !e.internal);
  const latest = events[events.length - 1];
  const isFull = full && typeof p.sender === "object";
  return {
    trackingId: p.trackingId,
    status: p.status,
    statusLabel: p.statusLabel,
    stage: p.stage,
    serviceLevel: p.serviceLevelLabel ?? p.serviceLevel,
    sender: isFull ? p.sender.name : p.sender,
    senderArea: isFull ? [p.pickup.zone, p.pickup.district].filter(Boolean).join(", ") : p.origin,
    recipient: isFull ? p.recipient.name : p.recipient,
    recipientPhone: isFull ? `+880 ${String(p.recipient.phone).replace(/^\+?880/, "")}` : undefined,
    destination: isFull ? p.delivery.label : p.destination,
    destinationArea: isFull ? [p.delivery.area, p.delivery.zone, p.delivery.district].filter(Boolean).join(", ") : p.destination,
    contents: isFull ? p.contents : undefined,
    weight: p.weightKg ? `${p.weightKg} kg` : "",
    packaging: p.packaging,
    payment: isFull ? `Sender pays ৳${p.charges.total}${p.codAmount ? ` · COD to collect ৳${p.codAmount}` : " · No COD"}` : p.codAmount ? `Cash on delivery · ৳${p.codAmount}` : "Prepaid",
    currentLocation: p.currentHub?.name ?? p.currentLocation ?? latest?.location ?? "In progress",
    pickupWindow: p.pickupWindow?.label ?? null,
    eta: p.estimatedDeliveryAt ? new Date(p.estimatedDeliveryAt).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }) : undefined,
    deliveredAt: when(p.deliveredAt),
    proofMethod: p.proof?.method ?? p.proofMethod ?? null,
    canCancel: !!p.canCancel,
    events: events.reverse().map((e: any) => ({ time: when(e.at), title: e.title, place: e.location || "", detail: e.description || "" })),
    full: isFull,
    feedback: p.feedback,
    canGiveFeedback: p.canGiveFeedback,
    live: p.liveDelivery ?? null,
    collect: p.collect ?? null,
  };
}

interface Proof {
  method: string;
  receivedBy?: string | null;
  capturedAt?: string | null;
  recordedAt?: string;
  location?: { lat: number; lng: number } | null;
  image?: { fileId: string; mimeType: string } | null;
}

/** /track and /track/<ID>[?t=<link token>]: search, status, history, proof of delivery, cancel and rating. */
export default function TrackingView({ param }: { param?: string }) {
  const token = typeof location !== "undefined" ? new URLSearchParams(location.search).get("t") || undefined : undefined;
  const code = (param ?? "").trim().toUpperCase();
  const [item, setItem] = useState<Item | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "missing" | "error">(code ? "loading" : "idle");
  const [error, setError] = useState("");
  const [proof, setProof] = useState<Proof | null>(null);
  const [owner, setOwner] = useState<"user" | "token" | null>(null);

  const load = useCallback(async () => {
    if (!code) return;
    const api = df().api;
    try {
      let result: Item | null = null;
      let who: "user" | "token" | null = null;
      if (token) {
        try {
          result = toItem(await api(`/track/${encodeURIComponent(code)}/full?t=${encodeURIComponent(token)}`), true);
          who = "token";
        } catch (err) {
          if (!(isApiError(err) && err.status === 404)) throw err;
        }
      }
      if (!result && df().auth.user) {
        try {
          result = toItem(await api(`/parcels/${encodeURIComponent(code)}`), true);
          who = "user";
        } catch (err) {
          if (!(isApiError(err) && (err.status === 404 || err.status === 403))) throw err;
        }
      }
      result ??= toItem(await api(`/track/${encodeURIComponent(code)}`), false);
      if (who === "user" && result.status === "DELIVERED") {
        const feedback = await api(`/parcels/${encodeURIComponent(code)}/feedback`).catch(() => null);
        if (feedback) result = { ...result, feedback: feedback.feedback, canGiveFeedback: feedback.canGiveFeedback };
      }
      setItem(result);
      setOwner(who);
      setState("idle");
      if (who === "user" && result.status === "DELIVERED")
        api<Proof>(`/parcels/${encodeURIComponent(code)}/proof`)
          .then(setProof)
          .catch(() => setProof(null)); // not recorded yet, or not available to this account
    } catch (err) {
      if (isApiError(err) && err.status === 404) setState("missing");
      else {
        setError(describe(err));
        setState("error");
      }
    }
  }, [code, token]);

  useEffect(() => {
    setItem(null);
    setProof(null);
    setState(code ? "loading" : "idle");
    void load();
  }, [load, code]);

  // Live: parcel changes reach signed-in owners as events; everyone else can refresh.
  useEffect(() => {
    if (!code || !df().auth.user || !df().events) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = ["parcel.updated", "reconnect"].map(type =>
      df().events!.on(type, () => {
        clearTimeout(timer);
        timer = setTimeout(() => void load(), 400);
      }),
    );
    return () => {
      clearTimeout(timer);
      off.forEach(fn => fn());
    };
  }, [code, load]);

  return (
    <div className="tracking-card">
      <div>
        <p className="eyebrow">Your parcel, right here</p>
        <h2>Where is it now?</h2>
        <p>See the estimated arrival, current location, shipment journey, and delivery details. No account needed.</p>
      </div>
      <div>
        <SearchForm initial={code} />
        <RecentParcels />
      </div>
      <div className={code ? "tracking-result show" : "tracking-result"} id="trackingResult" aria-live="polite">
        {state === "loading" ? (
          <div className="result-head">
            <div>
              <h3>Looking up {code}…</h3>
            </div>
          </div>
        ) : state === "missing" ? (
          <div className="result-head">
            <div>
              <h3>{"We couldn't find that tracking number"}</h3>
              <p>Check the ID and try again. Tracking IDs look like PP-261015-7K3QF.</p>
            </div>
            <span className="badge">Not found</span>
          </div>
        ) : state === "error" ? (
          <div className="result-head">
            <div>
              <h3>Tracking is unavailable right now</h3>
              <p>{error}</p>
            </div>
            <button className="button" type="button" onClick={() => void load()}>
              Try again
            </button>
          </div>
        ) : item ? (
          <Result item={item} proof={proof} owner={owner} token={token} onChange={load} />
        ) : null}
      </div>
    </div>
  );
}

function SearchForm({ initial }: { initial: string }) {
  const form = useForm(
    { trackingInput: initial },
    {
      trackingInput: v => {
        const id = v.trim().toUpperCase().replace(/\s+/g, "");
        if (!id) return "Enter your tracking number";
        if (!TRACKING_ID.test(id)) return "Tracking IDs look like PP-261015-7K3QF";
        return "";
      },
    },
  );
  useEffect(() => form.set("trackingInput", initial), [initial]); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.validate()) return;
    df().route.go(`tracking/${encodeURIComponent(form.values.trackingInput.trim().toUpperCase().replace(/\s+/g, ""))}`);
  };
  const bound = form.bind("trackingInput");
  return (
    <form ref={form.formRef} className="track-form" id="trackForm" data-react="1" noValidate onSubmit={submit}>
      <div className="input-wrap">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
          <circle cx="10.8" cy="10.8" r="7.3" />
          <path d="m16 16 5 5" />
        </svg>
        <input {...bound} aria-label="Tracking number" placeholder="Enter your tracking number" autoComplete="off" spellCheck={false} />
      </div>
      <button className="button button-primary" type="submit">
        Track parcel
      </button>
      <FieldError id="trackingInput" message={form.error("trackingInput")} />
    </form>
  );
}

/** Signed-in customers get their recent parcels as shortcuts. */
function RecentParcels() {
  const recent = df().auth.hasRole("CUSTOMER") ? df().parcels.cache.slice(0, 2).map((p: { trackingId: string }) => p.trackingId) : [];
  if (!recent.length) return null;
  return (
    <div className="track-hint">
      {"Your recent parcels: "}
      {recent.map((id, i) => (
        <span key={id}>
          {i ? " · " : ""}
          <button type="button" onClick={() => df().route.go(`tracking/${encodeURIComponent(id)}`)}>
            {id}
          </button>
        </span>
      ))}
    </div>
  );
}

function Result({ item, proof, owner, token, onChange }: { item: Item; proof: Proof | null; owner: "user" | "token" | null; token?: string; onChange: () => Promise<void> }) {
  const delivered = item.status === "DELIVERED";
  const stage = Math.max(0, Math.min(Number(item.stage) || 0, STAGES.length - 1));
  const badgeClass = delivered ? "" : /transit|delivery/i.test(item.statusLabel) ? "in-transit" : /failed|exception|return/i.test(item.statusLabel) ? "warning" : "";
  const latest = item.events[0];
  return (
    <>
      <section className="track-status-card" aria-label="Current shipment status">
        <div className="track-status-top">
          <div>
            <h3>{delivered ? "Your shipment has been delivered" : `Estimated delivery: ${item.eta || "Check back for an updated estimate"}`}</h3>
            <p>{delivered && item.deliveredAt ? `Successfully received ${item.deliveredAt}.` : latest?.detail || "Your shipment is moving through our delivery network."}</p>
          </div>
          <span className={`badge ${badgeClass}`}>{item.statusLabel || "In progress"}</span>
        </div>
        <div className="track-status-meta">
          <span>
            {"Tracking ID "}
            <strong>{item.trackingId}</strong>
          </span>
          <span>
            {"Last update "}
            <strong>{latest?.time || "Just now"}</strong>
          </span>
          <span>
            {"Current location "}
            <strong>{item.currentLocation}</strong>
          </span>
          {item.pickupWindow ? (
            <span data-pickup-window="1">
              {"Pickup time "}
              <strong>{item.pickupWindow}</strong>
            </span>
          ) : null}
          {item.collect?.hub ? (
            <span data-collect-hub="1">
              {"Hub Pickup at "}
              <strong>{`${item.collect.hub.name}, ${item.collect.hub.address}`}</strong>
              {item.collect.dueAt ? ` · collect by ${new Date(item.collect.dueAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}` : ""}
            </span>
          ) : null}
          {item.live ? (
            <span data-live-rider="1">
              {`Rider ${item.live.rider.name} `}
              {item.live.rider.phone ? (
                <a href={`tel:${item.live.rider.phone}`} style={{ fontWeight: 700 }}>
                  {item.live.rider.phone}
                </a>
              ) : null}
              {item.live.location ? (
                <>
                  {" · "}
                  <a href={`https://www.openstreetmap.org/?mlat=${item.live.location.lat}&mlon=${item.live.location.lng}#map=16/${item.live.location.lat}/${item.live.location.lng}`} target="_blank" rel="noreferrer">
                    {"Live location"}
                  </a>
                  {` (${when(item.live.location.at)})`}
                </>
              ) : null}
            </span>
          ) : null}
        </div>
      </section>
      <div className="track-progress" role="list" aria-label="Delivery progress">
        {STAGES.map((label, index) => (
          <div
            key={label}
            className={`track-progress-step ${index < stage || (delivered && index === stage) ? "done" : ""} ${index === stage && !delivered ? "current" : ""}`}
            role="listitem"
            aria-current={index === stage && !delivered ? "step" : "false"}
          >
            {label}
            <small>{index < stage ? "Completed" : index === stage ? (delivered ? "Complete" : "Current step") : "Upcoming"}</small>
          </div>
        ))}
      </div>
      <div className="track-detail-grid">
        <section className="track-info-card">
          <h4>From</h4>
          <dl>
            <div>
              <dt>Sender</dt>
              <dd>{item.sender || "Delivery Fast sender"}</dd>
            </div>
            <div>
              <dt>Pickup area</dt>
              <dd>{item.senderArea || "Pickup location recorded"}</dd>
            </div>
            {item.pickupWindow ? (
              <div>
                <dt>Pickup time</dt>
                <dd>{item.pickupWindow}</dd>
              </div>
            ) : null}
          </dl>
        </section>
        <section className="track-info-card">
          <h4>Delivering to</h4>
          <dl>
            <div>
              <dt>Recipient</dt>
              <dd>{item.recipient || "Recipient"}</dd>
            </div>
            <div>
              <dt>Contact</dt>
              <dd>{item.recipientPhone || "Hidden for privacy"}</dd>
            </div>
            <div>
              <dt>Delivery address</dt>
              <dd>{item.destination || "Address shared with delivery team"}</dd>
            </div>
          </dl>
        </section>
        <section className="track-info-card">
          <h4>Shipment details</h4>
          <dl>
            <div>
              <dt>Service</dt>
              <dd>{item.serviceLevel || "Domestic delivery"}</dd>
            </div>
            <div>
              <dt>Parcel</dt>
              <dd>{item.contents || "Shipment"}</dd>
            </div>
            <div>
              <dt>Package / weight</dt>
              <dd>{[item.packaging, item.weight].filter(Boolean).join(" · ") || "Not provided"}</dd>
            </div>
            <div>
              <dt>Payment</dt>
              <dd>{item.payment}</dd>
            </div>
          </dl>
        </section>
      </div>
      <div className="track-lower-grid">
        <section className="track-journey">
          <h4>Delivery route</h4>
          <div className="track-route">
            <div>
              <small>Picked up from</small>
              <strong>{item.senderArea || "Origin area"}</strong>
            </div>
            <span className="track-route-arrow" aria-hidden="true">
              →
            </span>
            <div>
              <small>Going to</small>
              <strong>{item.destinationArea || "Delivery area"}</strong>
            </div>
          </div>
          <p className="track-private-note">
            {item.full ? "You're seeing the full details because you booked this parcel." : "Recipient contact information is partially hidden to protect privacy."}
          </p>
        </section>
        <ProofCard item={item} proof={proof} owner={owner} />
      </div>
      <section className="track-events" style={{ marginTop: 12 }}>
        <h4>Shipment history</h4>
        <ol className="track-event-list">
          {item.events.map((event, i) => (
            <li className="track-event" key={i}>
              <time className="track-event-time">{event.time || ""}</time>
              <span className="track-event-dot" aria-hidden="true" />
              <div className="track-event-copy">
                <strong>{event.title || "Shipment update"}</strong>
                <p>{`${event.place} · ${event.detail}`}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>
      {delivered && (owner || item.feedback) ? <Feedback item={item} token={owner === "token" ? token : undefined} onDone={onChange} /> : null}
      <div className="track-help">
        <p>
          <strong>Need help with this delivery?</strong>
          <br />
          {"Keep your tracking ID handy when contacting our support team."}
        </p>
        <a href={`mailto:support@deliveryfast.example?subject=${encodeURIComponent(`Help with ${item.trackingId}`)}`}>{"Contact support →"}</a>
      </div>
      {item.canCancel && owner ? <CancelButton item={item} owner={owner} token={token} onDone={onChange} /> : null}
    </>
  );
}

function ProofCard({ item, proof, owner }: { item: Item; proof: Proof | null; owner: "user" | "token" | null }) {
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    setImage(null);
    if (!proof?.image) return;
    df()
      .api<{ dataUrl: string }>(`/files/${proof.image.fileId}`, { headers: { accept: "application/json" } })
      .then(r => setImage(r.dataUrl))
      .catch(() => setImage(null));
  }, [proof]);
  if (item.status !== "DELIVERED")
    return (
      <div className="track-pod">
        <h4>Delivery confirmation</h4>
        <p>Once delivered, the tracking page will show the delivery time and available proof of delivery. Signature and photo details may require the sender to sign in.</p>
      </div>
    );
  return (
    <div className="track-pod" data-proof={proof ? "full" : "summary"}>
      <div className="pod-confirmed">
        <i aria-hidden="true">✓</i>
        {" Delivery confirmed"}
      </div>
      <h4>Proof of delivery</h4>
      <p>
        {proof
          ? `${PROOF[proof.method] ?? proof.method} proof recorded${proof.receivedBy ? ` · received by ${proof.receivedBy}` : ""}`
          : item.proofMethod
            ? `${PROOF[item.proofMethod] ?? item.proofMethod} proof recorded`
            : "The recipient's delivery confirmation is recorded. Sign-in may be required to view a signature or delivery photo."}
      </p>
      {proof?.capturedAt ? (
        <p style={{ marginTop: 8 }}>
          <strong>Captured:</strong>
          {` ${when(proof.capturedAt)}${proof.location ? ` · ${proof.location.lat.toFixed(5)}, ${proof.location.lng.toFixed(5)}` : ""}`}
        </p>
      ) : null}
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={image} alt={`${PROOF[proof!.method] ?? "Proof"} of delivery`} style={{ marginTop: 10, maxWidth: "100%", maxHeight: 180, borderRadius: 8, border: "1px solid #dfe8e2", background: "#fff" }} />
      ) : null}
      {item.deliveredAt ? (
        <p style={{ marginTop: 8 }}>
          <strong>Received:</strong>
          {` ${item.deliveredAt}`}
        </p>
      ) : null}
      {!proof && !owner ? <p style={{ marginTop: 8, fontSize: 12 }}>{"Sign in as the sender to see the signature or photo."}</p> : null}
    </div>
  );
}

function CancelButton({ item, owner, token, onDone }: { item: Item; owner: "user" | "token"; token?: string; onDone: () => Promise<void> }) {
  const { busy, run } = useBusy();
  const cancel = () =>
    run(async () => {
      if (!(await df().confirm({ title: `Cancel pickup request ${item.trackingId}?`, message: "The rider won't come for it. This can't be undone.", confirm: "Cancel pickup", cancel: "Keep it", danger: true }))) return;
      try {
        if (owner === "token") await df().api(`/track/${encodeURIComponent(item.trackingId)}/cancel`, { method: "POST", body: { token } });
        else await df().api(`/parcels/${encodeURIComponent(item.trackingId)}/cancel`, { method: "POST", body: {} });
        await df().parcels.reload().catch(() => undefined);
        toast("Your pickup request was cancelled.");
        await onDone();
      } catch (err) {
        toast(describe(err));
      }
    });
  return (
    <>
      <button className="button" type="button" data-cancel-request={item.trackingId} disabled={busy} onClick={() => void cancel()}>
        Cancel pickup request
      </button>
      <p className="route-note">You can cancel only before operations confirms the pickup.</p>
    </>
  );
}

/** 1–5 stars and a comment, once per delivered parcel. */
function Feedback({ item, token, onDone }: { item: Item; token?: string; onDone: () => Promise<void> }) {
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const form = useForm({ feedbackComment: "" }, { feedbackComment: v => (v.trim().length > 1000 ? "Use at most 1000 characters" : "") });
  const [ratingError, setRatingError] = useState("");
  const { busy, run } = useBusy();

  useEffect(() => {
    if (location.hash === "#feedback") document.getElementById("feedback")?.scrollIntoView({ behavior: "smooth" });
  }, []);

  if (item.feedback)
    return (
      <section className="track-events" id="feedback" data-feedback="done" style={{ marginTop: 12 }}>
        <h4>Your rating</h4>
        <p aria-label={`${item.feedback.rating} out of 5 stars`} style={{ fontSize: 22, color: "#f2a900", letterSpacing: 2 }}>
          {"★".repeat(item.feedback.rating) + "☆".repeat(5 - item.feedback.rating)}
        </p>
        {item.feedback.comment ? <p>{item.feedback.comment}</p> : null}
        <p className="route-note">Thank you for your feedback.</p>
      </section>
    );
  if (!item.canGiveFeedback) return null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!rating) return setRatingError("Choose a rating from 1 to 5 stars");
    if (!form.validate()) return;
    void run(async () => {
      try {
        await df().api(`/parcels/${encodeURIComponent(item.trackingId)}/feedback`, {
          method: "POST",
          body: { rating, comment: form.values.feedbackComment.trim() || undefined, ...(token ? { token } : {}) },
        });
        toast("Thanks for rating your delivery!");
        await onDone();
      } catch (err) {
        const { mapped } = form.showServerError(err, { comment: "feedbackComment" });
        if (!mapped) setRatingError(describe(err));
      }
    });
  };
  const shown = hover || rating;
  return (
    <form ref={form.formRef} className="track-events" id="feedback" data-feedback="form" data-react="1" noValidate onSubmit={submit} style={{ marginTop: 12 }}>
      <h4>How was your delivery?</h4>
      <div role="radiogroup" aria-label="Rating" style={{ display: "flex", gap: 4, margin: "6px 0" }} onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map(n => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={rating === n}
            aria-label={`${n} star${n > 1 ? "s" : ""}`}
            data-star={n}
            onMouseEnter={() => setHover(n)}
            onClick={() => (setRating(n), setRatingError(""))}
            style={{ background: "none", border: 0, padding: 2, fontSize: 28, lineHeight: 1, cursor: "pointer", color: n <= shown ? "#f2a900" : "#c9d3ce" }}
          >
            ★
          </button>
        ))}
      </div>
      <FieldError id="feedbackRating" message={ratingError} />
      <div className="field" style={{ marginTop: 8 }}>
        <label htmlFor="feedbackComment">Anything we should know? (optional)</label>
        <textarea {...form.bind("feedbackComment")} rows={3} maxLength={1000} placeholder="The rider was on time and polite…" />
        <FieldError id="feedbackComment" message={form.error("feedbackComment")} />
      </div>
      <button className="button button-primary" type="submit" disabled={busy} style={{ marginTop: 8 }}>
        {busy ? "Please wait…" : "Send rating"}
      </button>
    </form>
  );
}
