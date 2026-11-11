/**
 * The parcel side drawer (shared/merchant-parcel.js), on ?parcel=<trackingId> anywhere in the panel. GET /parcels/:id
 * gives the merchant view: public tracking events only, no staff notes or rider details (except the package's
 * "Share rider phone" on the delivery day). Sections in the classic order: actions, needs info, failed delivery,
 * live rider location, where is it now, recipient, shipment, price, Hub Pickup, return, proof of delivery,
 * messages, support, status timeline. Esc closes; live parcel events refresh it.
 */
import { lazy, Suspense, useEffect, useRef, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router";
import { api, ApiError, describe } from "@panel/lib/api";
import { useLive } from "@panel/lib/events";
import { date, money, when } from "@panel/lib/format";
import { parcelDocuments } from "@panel/lib/print";
import { Button, Pill } from "@panel/ui/kit";
import { Icon } from "@panel/ui/Icon";
import { useMerchant } from "@/lib/merchant";
import { cancelParcel, confirmReturnReceived, printLabel, requestReturn } from "./actions";
import { completeDetails } from "./complete";
import { EDITABLE_INCOMPLETE, type Parcel } from "./model";
import { MessagePlanView, type MessagePlan } from "@panel/ui/MessagePlan";

const PositionMap = lazy(() => import("@panel/ui/PositionMap"));

const TYPE_LABEL: Record<string, string> = { ECOMMERCE: "E-commerce parcel", DOCUMENT: "Document delivery", PARCEL: "Domestic parcel", FRAGILE: "Fragile parcel" };
const RETURNABLE = ["PICKED_UP", "AT_HUB", "IN_TRANSIT", "ASSIGNED", "OUT_FOR_DELIVERY", "RETRY_SCHEDULED", "EXCEPTION"];
const PROOF_METHOD: Record<string, string> = { OTP: "Recipient code", SIGNATURE: "Signature", PHOTO: "Photo" };

/** The parcel as GET /parcels/:id gives it to its merchant. */
interface Full extends Parcel {
  instructions?: string | null;
  product?: string | null;
  intake?: string;
  dropOffHub?: { name: string } | null;
  openBox?: boolean;
  collect?: { hub?: { name?: string; address?: string } | null; readyAt?: string | null; dueAt?: string | null } | null;
  cod?: { state?: string } | null;
  pickupWindow?: { label?: string } | null;
  currentHub?: { name: string } | null;
  deliveredAt?: string | null;
  estimatedDeliveryAt?: string | null;
  cancelReason?: string | null;
  failedAttempts?: number;
  lastFailedAttempt?: { reason?: string | null; at?: string | null } | null;
  returnedAfterFailure?: boolean;
  missingLabels?: string[];
  liveDelivery?: { locationStatus?: string | null; staleAfterMinutes?: number; rider?: { name?: string; phone?: string | null } | null; location?: { lat: number; lng: number; ageSeconds?: number } | null } | null;
  service?: { speedLabel?: string; firstMileLabel?: string; lastMileLabel?: string; messages?: string[] } | null;
  priority?: string | null;
  deliveryType?: string | null;
  /** The package charged nothing: no price is shown. */
  chargesOff?: boolean;
  messagePlan?: MessagePlan;
  charges: Parcel["charges"] & { reattempt?: number; lines?: { label: string; amount: number }[] };
  returnInfo?: { reason?: string | null; requestedAt?: string | null; charge?: number | null; receivedAt?: string | null; onReturnRun?: boolean } | null;
  proof?: { method: string; receivedBy?: string | null; recordedAt?: string | null } | null;
}

/** +8801712345678 → +880 1712-345678 */
const phoneText = (p?: string | null) => {
  const m = /^\+880(\d{4})(\d{6})$/.exec(String(p || ""));
  return m ? `+880 ${m[1]}-${m[2]}` : p || "";
};

export default function ParcelDrawer() {
  const [params, setParams] = useSearchParams();
  const id = params.get("parcel");
  const close = () => setParams(p => (p.delete("parcel"), p));
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
      <Content key={id} id={id.toUpperCase()} close={close} closeRef={closeRef} />
    </aside>
  );
}

function Content({ id, close, closeRef }: { id: string; close: () => void; closeRef: React.RefObject<HTMLButtonElement | null> }) {
  const m = useMerchant();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ["m", "parcel", id],
    queryFn: async () => {
      const p = await api<Full>(`/parcels/${encodeURIComponent(id)}`);
      if (p.merchant && p.merchant.id !== m.merchant.id) throw new ApiError(404, { code: "NOT_FOUND", message: "Not found" });
      return p;
    },
    staleTime: 5_000,
    retry: false,
  });
  useLive(["parcel.updated"], () => void q.refetch(), { fallbackMs: 60_000 });
  const p = q.data;
  const head = (
    <header className="drawer-head">
      <div style={{ minWidth: 0 }}>
        <h2 id="drawerTitle" className="mono">
          {p?.trackingId ?? id}
        </h2>
        {p ? (
          <div className="row" style={{ marginTop: 6, gap: 6 }}>
            <Pill>{p.statusLabel}</Pill>
            {p.incomplete ? <Pill tone="warn">Needs info</Pill> : null}
            {p.failedAttempts && !["DELIVERED", "PICKUP_CANCELLED"].includes(p.status) ? <span className="pill bad">{`Failed ×${p.failedAttempts}`}</span> : null}
          </div>
        ) : null}
      </div>
      <button ref={closeRef} type="button" className="button ghost icon dialog-close" aria-label="Close parcel details" onClick={close}>
        <Icon name="x" size={18} />
      </button>
    </header>
  );
  if (q.isError)
    return (
      <>
        {head}
        <div className="drawer-body">
          <div className="callout bad">{q.error instanceof ApiError && q.error.status === 404 ? `No parcel ${id} in your account.` : describe(q.error)}</div>
        </div>
      </>
    );
  if (!p)
    return (
      <>
        {head}
        <div className="drawer-body">
          <div className="stack">
            <span className="skeleton" style={{ width: "60%" }} />
            <span className="skeleton" />
            <span className="skeleton" style={{ width: "80%" }} />
          </div>
        </div>
      </>
    );

  const doc = p.type === "DOCUMENT";
  const info = p.returnInfo;
  const events = (p.events || []).filter(e => !e.internal).slice().reverse();
  const c = p.charges || ({} as Full["charges"]);
  const lines =
    c.lines?.length
      ? [...c.lines, ...(Number(c.reattempt) && !c.lines.some(l => /re-?attempt/i.test(l.label)) ? [{ label: "Re-attempt", amount: Number(c.reattempt) }] : [])]
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
  const firstMile = p.service?.firstMileLabel || (p.intake === "DROP_OFF" ? "Drop at hub" : "Rider pickup");
  const returnStage = info?.receivedAt ? "Received by you" : p.status === "RETURNED" ? "Returned · confirm you received it" : p.status === "RETURN_SCHEDULED" ? (info?.onReturnRun ? "On a return run" : "Return scheduled") : "Return requested";

  return (
    <>
      {head}
      <div className="drawer-body">
        <Section title="Actions">
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            {p.incomplete && EDITABLE_INCOMPLETE.includes(p.status) ? (
              <Button size="sm" variant="primary" onClick={() => completeDetails(p)}>
                Complete details
              </Button>
            ) : null}
            {p.canCancel ? (
              <Button size="sm" onClick={() => cancelParcel(p)}>
                {doc ? "Cancel request" : "Cancel order"}
              </Button>
            ) : null}
            {RETURNABLE.includes(p.status) && !info?.requestedAt ? (
              <Button size="sm" onClick={() => requestReturn(p.trackingId)}>
                Request return
              </Button>
            ) : null}
            {p.status === "RETURNED" && !info?.receivedAt ? (
              <Button size="sm" variant="primary" onClick={() => confirmReturnReceived(p.trackingId)}>
                Confirm return received
              </Button>
            ) : null}
            {p.status !== "PICKUP_CANCELLED" ? (
              <>
                <Button size="sm" icon="print" onClick={() => printLabel(p.trackingId)}>
                  Print label (PDF)
                </Button>
                <Button size="sm" icon="download" onClick={() => parcelDocuments("invoices", [p.trackingId], { layout: "a4", line: "all" }, "Preparing the invoice…")}>
                  Download invoice (PDF)
                </Button>
              </>
            ) : null}
          </div>
        </Section>
        {p.incomplete ? <div className="callout warn">{`Needs info: missing ${(p.missingLabels || []).join(", ")}. It won't go out for delivery until the recipient's name, phone, address and destination are filled in.`}</div> : null}
        {p.failedAttempts && !["DELIVERED", "PICKUP_CANCELLED"].includes(p.status) ? (
          <div className="callout bad">
            {`Delivery failed ×${p.failedAttempts}${p.returnedAfterFailure ? `, back at ${p.currentHub?.name || "the hub"}` : p.status === "RETRY_SCHEDULED" ? ", another attempt is scheduled" : ""}${p.lastFailedAttempt?.reason ? ` · Last reason: ${p.lastFailedAttempt.reason}${p.lastFailedAttempt.at ? ` (${when(p.lastFailedAttempt.at)})` : ""}` : ""}`}
          </div>
        ) : null}
        <Live p={p} />
        {p.status !== "PICKUP_CANCELLED" ? (
          <Section title="Where is it now">
            <Suspense fallback={<span className="faint">Finding the parcel…</span>}>
              <PositionMap trackingId={p.trackingId} status={`${p.status}:${p.updatedAt}`} />
            </Suspense>
          </Section>
        ) : null}
        <Section title="Recipient">
          <KV
            rows={[
              ["Name", p.recipient?.name || "Not set yet"],
              ["Phone", phoneText(p.recipient?.phone) || "Not set yet"],
              ["Deliver to", p.delivery?.label],
              ["Relationship", p.receiverRelation],
              ["Instructions", p.instructions],
            ]}
          />
        </Section>
        <Section title="Shipment">
          <KV
            rows={[
              ["Order ref", p.merchantOrderRef],
              [doc ? "Document" : "Product", p.product || p.contents || TYPE_LABEL[p.type] || ""],
              ["Type", TYPE_LABEL[p.type] || p.type],
              ["Weight", !doc && p.weightKg != null ? `${p.weightKg} kg` : ""],
              ["Packaging", p.packaging],
              ["Delivery type", p.deliveryType || p.service?.speedLabel || p.serviceLevelLabel],
              ["Priority", p.priority],
              ["First mile", p.intake === "DROP_OFF" && p.dropOffHub ? `${firstMile} · ${p.dropOffHub.name}` : firstMile],
              ["Last mile", p.service?.lastMileLabel || (p.collect ? "Hub Pickup" : "Home delivery")],
              ["Open box", p.openBox ? "Allowed" : ""],
              [doc ? "Value" : "COD", doc ? "" : Number(p.codAmount) ? `${money(p.codAmount)}${p.cod ? ` · ${p.cod.state === "SETTLED" ? "paid to you" : "collected"}` : ""}` : "No cash to collect"],
              ["Product value", Number(p.declaredValue) ? money(p.declaredValue) : ""],
              ["Pickup window", p.pickupWindow?.label],
              ["Current hub", p.currentHub?.name],
              ["Booked", when(p.createdAt)],
              [p.deliveredAt ? "Delivered" : "Estimated delivery", when(p.deliveredAt || p.estimatedDeliveryAt)],
              ["Cancellation reason", p.cancelReason],
            ]}
          />
        </Section>
        {p.chargesOff ? null : (
        <Section title="Price">
          <div className="price-lines">
            {lines.map(l => (
              <div key={l.label} className="row" style={{ justifyContent: "space-between", fontSize: 13 }}>
                <span>{l.label}</span>
                <span>{money(l.amount)}</span>
              </div>
            ))}
            <div className="row" style={{ justifyContent: "space-between", fontWeight: 700, borderTop: "1px solid var(--line)", paddingTop: 6, marginTop: 4 }}>
              <span>Total</span>
              <span>{money(c.total)}</span>
            </div>
          </div>
        </Section>
        )}
        {p.collect ? (
          <Section title="Hub Pickup">
            <KV
              rows={[
                ["Collect at", p.collect.hub?.name || "The hub serving the recipient's zone"],
                ["Address", p.collect.hub?.address],
                ["Ready since", when(p.collect.readyAt)],
                ["Collect by", date(p.collect.dueAt)],
                ["Status", p.status === "READY_FOR_COLLECTION" ? "Waiting for the recipient" : p.status === "DELIVERED" ? "Collected" : ""],
              ]}
            />
          </Section>
        ) : null}
        {info || ["RETURN_SCHEDULED", "RETURNED"].includes(p.status) ? (
          <Section title="Return">
            <KV
              rows={[
                ["Status", <Pill key="s">{returnStage}</Pill>],
                ["Reason", info?.reason],
                ["Requested", when(info?.requestedAt)],
                ["Return charge", info?.charge != null && !p.chargesOff ? money(info.charge) : ""],
                ["Received", when(info?.receivedAt)],
              ]}
            />
          </Section>
        ) : null}
        <Proof p={p} />
        <Section title="Messages (SMS · email · push)">
          <MessagePlanView plan={p.messagePlan} booked={!!p.service} />
        </Section>
        <Section title="Support">
          <Button
            size="sm"
            icon="message"
            onClick={() => {
              close();
              navigate(`/support?compose=1&subject=${encodeURIComponent(`Help with ${p.trackingId}`)}&category=${encodeURIComponent("Delivery issue")}&related=${encodeURIComponent(p.trackingId)}`);
            }}
          >
            Open a ticket about this parcel
          </Button>
        </Section>
        <Section title="Status timeline">
          {events.length ? (
            <ol className="timeline">
              {events.map((e, i) => (
                <li key={i}>
                  <strong>{e.title}</strong>
                  {e.description || e.location ? <div className="muted">{[e.description, e.location].filter(Boolean).join(" · ")}</div> : null}
                  <small>{when(e.at || e.createdAt)}</small>
                </li>
              ))}
            </ol>
          ) : (
            <p className="faint" style={{ margin: 0 }}>
              No tracking events yet.
            </p>
          )}
        </Section>
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="section-title">{title}</h3>
      {children}
    </section>
  );
}

function KV({ rows }: { rows: [string, ReactNode][] }) {
  const shown = rows.filter(([, v]) => v != null && v !== "");
  return (
    <dl className="kv">
      {shown.map(([k, v]) => (
        <div key={k} style={{ display: "contents" }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Out for delivery with the package's "Live rider location" (and "Share rider phone" on the delivery day). */
function Live({ p }: { p: Full }) {
  const live = p.liveDelivery;
  if (!live || p.status !== "OUT_FOR_DELIVERY") return null;
  const name = live.rider?.name || "The rider";
  const loc = live.location;
  const mins = loc ? Math.floor((loc.ageSeconds || 0) / 60) : 0;
  const text = !live.locationStatus
    ? `${name} is out for delivery`
    : loc
      ? `${name} · updated ${mins < 1 ? "just now" : `${mins} min ago`}`
      : live.locationStatus === "STALE"
        ? `${name} · location not updated for over ${live.staleAfterMinutes || 15} minutes`
        : live.locationStatus === "OFF_SHIFT"
          ? `${name} · not sharing a location right now`
          : `${name} · waiting for the rider's location`;
  return (
    <Section title="Live rider location">
      <div className="callout info">
        <strong>{text}</strong>
        {loc ? (
          <>
            {" "}
            <a href={`https://www.openstreetmap.org/?mlat=${loc.lat}&mlon=${loc.lng}#map=16/${loc.lat}/${loc.lng}`} target="_blank" rel="noopener" style={{ fontWeight: 600 }}>
              Open map ↗
            </a>
          </>
        ) : null}
        {live.rider?.phone ? (
          <div style={{ marginTop: 4 }}>
            Rider phone (today): <a href={`tel:${live.rider.phone}`}>{phoneText(live.rider.phone)}</a>
          </div>
        ) : null}
      </div>
    </Section>
  );
}

/** Proof of delivery: GET /parcels/:id/proof (only what the merchant may see: no rider, no rider note). */
function Proof({ p }: { p: Full }) {
  const full = useQuery({
    queryKey: ["m", "proof", p.trackingId],
    enabled: !!p.proof,
    staleTime: 600_000,
    queryFn: async () => {
      const proof = await api<{ capturedAt?: string; location?: { lat: number; lng: number } | null; image?: { url?: string } | null }>(`/parcels/${encodeURIComponent(p.trackingId)}/proof`);
      let dataUrl = "";
      if (proof.image?.url) {
        const file = await api<{ dataUrl?: string }>(proof.image.url.replace(/^\/api\/v1/, ""), { headers: { accept: "application/json" } }).catch(() => null);
        if (file?.dataUrl && /^data:image\//.test(file.dataUrl)) dataUrl = file.dataUrl;
      }
      return { capturedAt: proof.capturedAt, location: proof.location, dataUrl };
    },
  });
  if (!p.proof)
    return p.status === "DELIVERED" ? (
      <Section title="Proof of delivery">
        <p className="faint" style={{ margin: 0 }}>
          No proof of delivery recorded.
        </p>
      </Section>
    ) : null;
  const f = full.data;
  return (
    <Section title="Proof of delivery">
      <KV
        rows={[
          ["Method", PROOF_METHOD[p.proof.method] || p.proof.method],
          ["Received by", p.proof.receivedBy || p.recipient?.name || ""],
          ["Recorded", when(f?.capturedAt || p.proof.recordedAt)],
          [
            "Location",
            f?.location ? (
              <a href={`https://www.openstreetmap.org/?mlat=${f.location.lat}&mlon=${f.location.lng}#map=17/${f.location.lat}/${f.location.lng}`} target="_blank" rel="noopener">
                Open map ↗
              </a>
            ) : (
              ""
            ),
          ],
        ]}
      />
      {f?.dataUrl ? <img src={f.dataUrl} alt={`Proof of delivery (${PROOF_METHOD[p.proof.method] || ""})`} style={{ display: "block", maxWidth: "100%", maxHeight: 220, marginTop: 8, borderRadius: 8, border: "1px solid var(--line)" }} /> : null}
    </Section>
  );
}
