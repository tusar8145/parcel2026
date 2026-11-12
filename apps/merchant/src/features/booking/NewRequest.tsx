/**
 * "New delivery request" (merchant-bridge.js booking + shared/order-services.js + paste-message.js +
 * merchant-features.js pickup window), POST /parcels with an Idempotency-Key (a retry of the same form can't book twice):
 *   Paste a message   POST /parse-message fills the EMPTY fields (name, phone, address, reference)
 *   Service           the package's choices (GET /packages/me): first mile + drop-off hub, last mile (Hub Pickup names
 *                     its hub from the price), Delivery type, open box, messages checklist; pickup time (GET /pickup-slots)
 *   Recipient, address (district / zone / area picked from the full address, GET /catalog/place), address category
 *   Request           product, declared value, internal reference, item description, pre-printed CN
 *   Price             POST /merchants/me/quote with the same choices, so it matches the booked charge
 * The sender and pickup are the merchant's profile. After booking the request's details open (Print label there).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { bdPhoneProblem, normalizeBdPhone } from "@delivery-fast/shared/dist/phone.js";
import { api, ApiError, describe } from "@panel/lib/api";
import { openCustom } from "@panel/ui/dialogs";
import { Icon } from "@panel/ui/Icon";
import { SearchSelect } from "@panel/ui/SearchSelect";
import { Select } from "@panel/ui/Select";
import { toast } from "@panel/ui/toast";
import { useCatalog, type Catalog } from "@/lib/catalog";
import { useMerchant, type Merchant } from "@/lib/merchant";
import { refreshMerchant } from "@/features/parcels/actions";

/** Delivery proof methods as the request shows them. */
const PROOF_LABEL: Record<string, string> = { PHOTO: "Scan POD (signed invoice photo)", OTP: "OTP verification (recipient's code)", SIGNATURE: "Recipient signature" };

const AUTO_COLLECT = "The hub serving the delivery zone (choose the zone)";
const taka = (n: unknown) => `৳${Number(n || 0).toLocaleString("en-BD")}`;

interface PackageView {
  options: { firstMiles: string[]; defaultFirstMile?: string; lastMiles: string[]; defaultLastMile?: string; speeds: string[]; cod: boolean; openBox: boolean; proofMethods?: string[] };
  labels: { firstMile: Record<string, string>; lastMile: Record<string, string>; speed: Record<string, string>; productType?: Record<string, string> };
  /** Products with their message channels (sms, email, push: where their parcels' messages go). */
  products?: { id: string; name: string; type: string; channels?: string[] }[];
  /** Priorities (tags; one is the default). */
  priorities?: { id: string; name: string; isDefault: boolean }[];
  notifications?: { code: string; title: string }[];
  dropHubs?: { id: string; name: string; type?: string }[];
}
interface Quote {
  lines?: { label: string; amount: number }[];
  totalCharge: number;
  /** false: the package charges nothing (no price is shown). */
  chargesOn?: boolean;
  returnCharge?: number;
  returnPercent?: number;
  package?: { name: string } | null;
  collectHub?: { name: string; address?: string | null } | null;
}
interface Slots {
  days: { label: string; closed?: boolean; slots: { start: string; end: string; label: string; available: boolean; remaining: number | null }[] }[];
}

/** Opens the form; onDone(trackingId) opens the new request's details. */
export function openNewRequest(onDone: (trackingId: string) => void) {
  return openCustom(close => <NewRequestDialog close={() => close()} onDone={onDone} />, "wide");
}

/** The pickup zone of the merchant's profile (merchant-bridge.js pickupZone). */
function pickupZone(m: Merchant, catalog: Catalog | undefined) {
  const pickup = m.pickup as { zone?: string } | undefined;
  if (pickup?.zone) return pickup.zone;
  const zones = catalog?.zonesByDistrict?.[String(m.pickupDistrict)] ?? [];
  const area = String(m.pickupArea ?? "");
  return zones.find(z => z === area || (catalog?.areasByZone?.[z] ?? []).includes(area) || String(m.pickupAddress ?? "").toLowerCase().includes(z.toLowerCase())) || zones[0] || area;
}
const newKey = () => `web-${(crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^\w-]/g, "")}`;

function NewRequestDialog({ close, onDone }: { close: () => void; onDone: (trackingId: string) => void }) {
  const m = useMerchant();
  const mm = m.merchant as Merchant & Record<string, unknown>;
  const catalog = useCatalog();
  const [view, setView] = useState<PackageView | null>(null);
  const [pkgError, setPkgError] = useState("");
  const [slots, setSlots] = useState<Slots["days"]>([]);
  const doc = m.doc;
  // Delivery proof: required (default) and, optionally, one specific method of the package's.
  const [proof, setProof] = useState({ required: true, specific: false, method: "" });
  const [svc, setSvc] = useState({ firstMile: "", dropHubId: "", lastMile: "", speed: "REGULAR", openBox: false, cod: true, codAmount: "", off: new Set<string>(), category: "", priority: "" });
  const [recipient, setRecipient] = useState({ name: "", phone: "" });
  const [place, setPlace] = useState({ street: "", district: "", zone: "", area: "", category: doc ? "Office" : "Home" });
  const [req, setReq] = useState({ product: "", value: "", ref: "", contents: "", cn: "", window: "", weight: "0.5" });
  const [quote, setQuote] = useState<{ q?: Quote; text?: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ json: string; key: string } | null>(null);
  // "From your catalogue" (merchant-features.js addProductPicker): an active product prefills the request.
  const [catalogue, setCatalogue] = useState<{ id: string; name: string; sku: string; price: number; active: boolean; category?: string | null; weightKg?: number | null }[]>([]);
  const [refHint, setRefHint] = useState(doc ? "e.g. CARD-2026-0012" : "e.g. ORDER-1001");

  useEffect(() => {
    api<PackageView>("/packages/me").then(
      v => {
        setView(v);
        const hubs = v.dropHubs ?? [];
        setSvc(s => ({
          ...s,
          firstMile: v.options.defaultFirstMile || v.options.firstMiles[0] || "",
          dropHubId: hubs.length === 1 ? hubs[0].id : "",
          lastMile: v.options.defaultLastMile || v.options.lastMiles[0] || "",
          speed: v.options.speeds[0] || "REGULAR",
          priority: (v.priorities ?? []).find(p => p.isDefault)?.id ?? "",
        }));
      },
      e => setPkgError(describe(e)),
    );
    api<{ items: { id: string; name: string; sku: string; price: number; active: boolean; category?: string | null; weightKg?: number | null }[] }>(`/merchants/me/products?limit=200${m.q("&")}`).then(
      r => setCatalogue(r.items.filter(p => p.active).sort((a, b) => a.name.localeCompare(b.name))),
      () => setCatalogue([]),
    );
    api<Slots>(`/pickup-slots?district=${encodeURIComponent(String(mm.pickupDistrict ?? ""))}`).then(
      d => setSlots(d.days || []),
      () => setSlots([]), // pickup slots aren't available: "any time"
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const product = view?.products?.find(p => p.name === req.product) ?? null;
  // A product without SMS and email sends no messages to tick.
  const silent = !!product?.channels && !product.channels.includes("sms") && !product.channels.includes("email");
  /** The service as sent (order-services.js read). */
  const service = useMemo(() => {
    if (!view) return null;
    const o = view.options;
    const firstMile = (o.firstMiles.length > 1 ? svc.firstMile : "") || o.defaultFirstMile || o.firstMiles[0];
    const lastMile = (o.lastMiles.length > 1 ? svc.lastMile : "") || o.defaultLastMile || o.lastMiles[0];
    const all = view.notifications ?? [];
    const ticked = all.filter(n => !svc.off.has(n.code)).map(n => n.code);
    return {
      firstMile,
      ...(firstMile === "HUB_DROP" && svc.dropHubId ? { dropHubId: svc.dropHubId } : {}),
      lastMile,
      speed: (o.speeds.length > 1 ? svc.speed : "") || o.speeds[0] || "REGULAR",
      ...(req.product ? { product: req.product } : {}),
      ...(svc.priority ? { priority: svc.priority } : {}),
      openBox: o.openBox ? svc.openBox : false,
      // Cash on delivery (E-commerce): only when the package offers it and it is ticked.
      codOn: !doc && o.cod ? svc.cod : false,
      ...(all.length && ticked.length !== all.length && !silent ? { notifications: ticked } : {}),
    } as { firstMile: string; dropHubId?: string; lastMile: string; speed: string; product?: string; category?: string; priority?: string; openBox: boolean; codOn: boolean; notifications?: string[] };
  }, [view, svc, req.product, silent]);
  const drop = service?.firstMile === "HUB_DROP";
  const hubCollect = service?.lastMile === "HUB_COLLECT";
  // The proof methods for this request: the package's, without OTP when the Delivery code message isn't sent.
  const proofMethods = (view?.options.proofMethods ?? []).filter(m => m !== "OTP" || (!silent && (!service?.notifications || service.notifications.includes("notify.delivery_code"))));
  const proofMethod = proof.required && proof.specific && proofMethods.includes(proof.method) ? proof.method : undefined;

  /** The request's body (merchant-bridge.js orderBody): sender and pickup from the merchant's profile. */
  const body = () => {
    const pickup = mm.pickup as { zone?: string; area?: string; lat?: number | null; lng?: number | null } | undefined;
    const [start, end] = req.window ? req.window.split("|") : [];
    const { codOn, ...choices } = service ?? ({ codOn: false } as NonNullable<typeof service>);
    const codAmount = codOn ? Number(svc.codAmount) || 0 : 0;
    return {
      ...choices,
      sender: { name: mm.name, phone: (mm.pickupContactPhone as string) || (mm.contactPhone as string) },
      pickup: {
        category: "Office",
        street: mm.pickupAddress as string,
        area: ((pickup?.zone ? pickup.area : (mm.pickupArea as string)) || undefined) as string | undefined,
        zone: pickupZone(mm, catalog),
        district: mm.pickupDistrict as string,
        ...(pickup?.lat != null ? { lat: pickup.lat, lng: pickup.lng } : {}),
      },
      recipient: { name: recipient.name.trim(), phone: recipient.phone.trim() ? normalizeBdPhone(recipient.phone.trim()) ?? recipient.phone.trim() : "" },
      delivery: { category: place.category || "Office", street: place.street.trim(), area: place.area || undefined, zone: place.zone, district: place.district },
      type: doc ? "DOCUMENT" : "ECOMMERCE",
      // Banking & Financial has no weight in pricing: the API needs one, 0.5 kg (the included weight).
      weightKg: doc ? 0.5 : Number(req.weight) || 0.5,
      declaredValue: Number(req.value) || undefined,
      // Cash on delivery: the separate COD amount, only when the package offers COD and it is ticked.
      codAmount: doc ? 0 : codAmount,
      merchantOrderRef: req.ref.trim() || undefined,
      contents: req.contents.trim() || undefined,
      cn: req.cn.trim().toUpperCase() || undefined,
      pickupWindow: start ? { start, end } : undefined,
      saveAddresses: false,
      proofRequired: proof.required,
      ...(proofMethod ? { proofMethod } : {}),
    };
  };

  // Live price: the same places and choices the booking sends (product included).
  const quoteInput = (() => {
    if (!place.district) return null;
    const b = body();
    return {
      pickupDistrict: b.pickup.district,
      pickupZone: b.pickup.zone,
      pickupArea: b.pickup.area,
      deliveryDistrict: b.delivery.district,
      ...(b.delivery.zone ? { deliveryZone: b.delivery.zone } : {}),
      ...(b.delivery.area ? { deliveryArea: b.delivery.area } : {}),
      ...(doc ? {} : { weightKg: b.weightKg }),
      codAmount: b.codAmount,
      ...(service ? { firstMile: service.firstMile, dropHubId: service.dropHubId, lastMile: service.lastMile, speed: service.speed, openBox: service.openBox, product: service.product } : {}),
    };
  })();
  const quoteKey = JSON.stringify(quoteInput);
  useEffect(() => {
    if (!quoteInput) return setQuote({ text: "Choose the delivery district to see the price from your service package." });
    let live = true;
    const timer = setTimeout(() => {
      api<Quote>(`/merchants/me/quote${m.q()}`, { method: "POST", body: quoteInput }).then(
        q => live && setQuote({ q }),
        e => live && setQuote({ text: e instanceof ApiError && e.status === 422 ? describe(e) : "Delivery charges use your service package and are confirmed when you create the order." }),
      );
    }, 250);
    return () => ((live = false), clearTimeout(timer));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quoteKey]);

  const problems = () => {
    const e: Record<string, string> = {};
    if (!recipient.name.trim()) e.name = "Enter the recipient's name";
    const ph = recipient.phone.trim() ? bdPhoneProblem(recipient.phone) : "Enter the recipient's phone number";
    if (ph) e.phone = ph;
    if (!place.street.trim()) e.street = "Enter the street address";
    if (!place.district) e.district = "Choose the delivery district";
    if (!place.zone) e.zone = "Choose the delivery zone";
    if (req.value && !(Number(req.value) >= 0)) e.value = "Enter a value of ৳0 or more";
    if (req.cn.trim() && !/^[A-Za-z]{2,4}-\d{6}-[0-9A-Za-z]{4,8}$/.test(req.cn.trim())) e.cn = "Enter the consignment number printed on the label";
    if (view && drop && !svc.dropHubId) e.dropHub = "Choose the hub the sender brings the parcel to";
    if (!doc) {
      const w = req.weight.trim();
      if (!w) e.weight = "Enter the weight";
      else if (!(Number(w) >= 0.01)) e.weight = "At least 0.01 kg";
      else if (Number(w) > 50) e.weight = "At most 50 kg";
      if (service?.codOn) {
        const n = Number(svc.codAmount);
        if (!svc.codAmount.trim()) e.codAmount = "Enter the cash to collect, or untick COD";
        else if (!(n >= 1)) e.codAmount = "Enter an amount of at least ৳1";
        else if (n > 1_000_000) e.codAmount = "The amount is too large";
      }
    }
    return e;
  };
  useEffect(() => {
    if (checked) setErrors(problems());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checked, recipient, place, req, svc]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const found = problems();
    setChecked(true);
    setErrors(found);
    if (Object.keys(found).length) {
      document.getElementById(`nr_${Object.keys(found)[0]}`)?.focus();
      return toast("Check the highlighted fields.", "bad");
    }
    const b = body();
    const json = JSON.stringify(b);
    if (!pending.current || pending.current.json !== json) pending.current = { json, key: newKey() };
    setBusy(true);
    try {
      const p = await api<{ trackingId: string; charges: { total: number } }>(`/parcels${m.q()}`, { method: "POST", body: b, headers: { "Idempotency-Key": pending.current.key } });
      pending.current = null;
      refreshMerchant();
      toast(`${doc ? "Request" : "Order"} ${p.trackingId} created · delivery charge ${taka(p.charges.total)}.`, "good");
      close();
      onDone(p.trackingId);
    } catch (error) {
      // A definite answer ends this attempt; a lost connection may retry with the same key.
      if (error instanceof ApiError && error.status < 500) pending.current = null;
      toast(describe(error), "bad");
    } finally {
      setBusy(false);
    }
  }

  const field = (id: string, label: string, control: ReactNode, o: { full?: boolean; req?: boolean; hint?: ReactNode } = {}) => (
    <label className={`field${o.full ? " full" : ""}`} htmlFor={`nr_${id}`}>
      <span>
        {label}
        {o.req ? <span className="req" aria-hidden="true"> *</span> : null}
      </span>
      {control}
      {errors[id] ? <span className="error">{errors[id]}</span> : o.hint ? <small className="faint">{o.hint}</small> : null}
    </label>
  );
  const o = view?.options;
  const L = view?.labels;
  // Products in the catalog's order.
  const products = view?.products ?? [];
  const zones = catalog?.zonesByDistrict?.[place.district] ?? [];
  const areas = catalog?.areasByZone?.[place.zone] ?? [];
  const notes = view?.notifications ?? [];
  const on = notes.filter(n => !svc.off.has(n.code)).length;

  return (
    <form onSubmit={submit} noValidate>
      <div className="dialog-head">
        <div>
          <h2>{doc ? "Create a new delivery request" : "Create a new order"}</h2>
          <p>
            From {mm.name} · {String(mm.pickupAddress ?? "")}
          </p>
        </div>
        <button type="button" className="button ghost icon dialog-close" aria-label="Close" onClick={close} disabled={busy}>
          <Icon name="x" size={18} />
        </button>
      </div>
      <div className="dialog-body">
        <PasteMessage
          kind={doc ? "document" : "ecommerce"}
          apply={f => {
            const filled: string[] = [];
            const local = (p: string) => String(p || "").replace(/^\+?880/, "").replace(/^0(?=1)/, "");
            if (f.recipient_name && !recipient.name.trim()) (setRecipient(r => ({ ...r, name: String(f.recipient_name) })), filled.push("name"));
            if (f.recipient_phone && !recipient.phone.trim()) (setRecipient(r => ({ ...r, phone: local(String(f.recipient_phone)) })), filled.push("phone"));
            if (f.address && !place.street.trim()) (setPlace(p => ({ ...p, street: String(f.address) })), filled.push("full address"));
            // COD (E-commerce): switch it on with the amount.
            if (!doc && view?.options.cod && f.cod_amount && Number(f.cod_amount) > 0 && !svc.codAmount) (setSvc(x => ({ ...x, cod: true, codAmount: String(Number(f.cod_amount)) })), filled.push(`COD ৳${Number(f.cod_amount).toLocaleString("en-US")}`));
            if (!doc && f.weight_kg && (!req.weight || req.weight === "0.5")) (setReq(r => ({ ...r, weight: String(f.weight_kg) })), filled.push("weight"));
            if (f.order_ref && !req.ref.trim()) (setReq(r => ({ ...r, ref: String(f.order_ref) })), filled.push("reference"));
            return filled;
          }}
        />
        <h3 className="section-title">Service</h3>
        {pkgError ? <div className="callout bad">{pkgError}</div> : !view ? <p className="faint">Loading your service package…</p> : null}
        {view && o && L ? (
          <div className="form-grid">
            {o.firstMiles.length > 1
              ? field(
                  "firstMile",
                  "First mile",
                  <Select id="nr_firstMile" className="select" searchable={false} value={svc.firstMile} onChange={e => setSvc(s => ({ ...s, firstMile: e.target.value }))}>
                    {o.firstMiles.map(f => (
                      <option key={f} value={f}>
                        {L.firstMile[f]}
                      </option>
                    ))}
                  </Select>,
                )
              : null}
            {o.firstMiles.includes("HUB_DROP") && drop
              ? field(
                  "dropHub",
                  "Drop-off hub",
                  <SearchSelect id="nr_dropHub" label="Drop-off hub" value={svc.dropHubId} onChange={v => setSvc(s => ({ ...s, dropHubId: v }))} placeholder="Choose the hub" invalid={!!errors.dropHub} options={(view.dropHubs ?? []).map(h => ({ value: h.id, label: h.type === "FRANCHISE" ? `${h.name} · Franchise` : h.name }))} />,
                  { req: true },
                )
              : null}
            {o.lastMiles.length > 1
              ? field(
                  "lastMile",
                  "Last mile",
                  <Select id="nr_lastMile" className="select" searchable={false} value={svc.lastMile} onChange={e => setSvc(s => ({ ...s, lastMile: e.target.value }))}>
                    {o.lastMiles.map(l => (
                      <option key={l} value={l}>
                        {L.lastMile[l]}
                      </option>
                    ))}
                  </Select>,
                )
              : null}
            {o.lastMiles.includes("HUB_COLLECT") && hubCollect ? (
              <div className="field">
                <span>Collect from</span>
                <strong style={{ padding: "8px 0" }}>{quote?.q?.collectHub ? `${quote.q.collectHub.name}${quote.q.collectHub.address ? ` · ${quote.q.collectHub.address}` : ""}` : AUTO_COLLECT}</strong>
              </div>
            ) : null}
            {o.speeds.length > 1
              ? field(
                  "speed",
                  "Delivery type",
                  <Select id="nr_speed" className="select" searchable={false} value={svc.speed} onChange={e => setSvc(s => ({ ...s, speed: e.target.value }))}>
                    {o.speeds.map(s => (
                      <option key={s} value={s}>
                        {L.speed[s]}
                      </option>
                    ))}
                  </Select>,
                )
              : null}
            {!doc && o.cod ? (
              <>
                <label className="full" style={{ display: "flex", flexDirection: "row", gap: 7, alignItems: "center", fontWeight: 600, gridColumn: "1 / -1" }}>
                  <input type="checkbox" checked={svc.cod} onChange={e => setSvc(x => ({ ...x, cod: e.target.checked }))} /> Collect cash on delivery (COD)
                </label>
                {svc.cod
                  ? field(
                      "codAmount",
                      "COD amount (৳)",
                      <input id="nr_codAmount" className="input" type="number" min={1} max={1000000} step={1} inputMode="numeric" placeholder="Cash to collect from the recipient" value={svc.codAmount} aria-invalid={errors.codAmount ? true : undefined} onChange={e => setSvc(x => ({ ...x, codAmount: e.target.value }))} />,
                      { req: true },
                    )
                  : null}
              </>
            ) : null}
            {o.openBox ? (
              <label className="full" style={{ display: "flex", flexDirection: "row", gap: 7, alignItems: "center", fontWeight: 600, gridColumn: "1 / -1" }}>
                <input type="checkbox" checked={svc.openBox} onChange={e => setSvc(s => ({ ...s, openBox: e.target.checked }))} /> Open box / check before pay
              </label>
            ) : null}
            <div className="full" style={{ display: "grid", gap: 6, gridColumn: "1 / -1" }}>
              <label style={{ display: "flex", flexDirection: "row", gap: 7, alignItems: "center", fontWeight: 600 }}>
                <input type="checkbox" checked={proof.required} onChange={e => setProof(x => ({ ...x, required: e.target.checked }))} /> Delivery proof required
              </label>
              {proof.required && proofMethods.length ? (
                <label style={{ display: "flex", flexDirection: "row", gap: 7, alignItems: "center" }}>
                  <input
                    type="checkbox"
                    checked={proof.specific}
                    onChange={e => setProof(x => ({ ...x, specific: e.target.checked, method: x.method && proofMethods.includes(x.method) ? x.method : proofMethods[0] }))}
                  />{" "}
                  Set specific proof
                </label>
              ) : null}
              {proof.required && proof.specific && proofMethods.length ? (
                <Select className="select" aria-label="Specific proof" value={proofMethod ?? proofMethods[0]} onChange={e => setProof(x => ({ ...x, method: e.target.value }))} style={{ maxWidth: 360 }}>
                  {proofMethods.map(m => (
                    <option key={m} value={m}>
                      {PROOF_LABEL[m] ?? m}
                    </option>
                  ))}
                </Select>
              ) : null}
              <small className="faint">
                {!proof.required
                  ? "The rider can complete the delivery without proof."
                  : proofMethod
                    ? `The rider must give: ${PROOF_LABEL[proofMethod]}.`
                    : `The rider must give one of: ${proofMethods.map(m => PROOF_LABEL[m] ?? m).join(", ") || "the service plan's proof"}.`}
              </small>
            </div>
            {notes.length ? (
              <details className="field full">
                <summary style={{ cursor: "pointer", fontWeight: 600 }}>{silent ? "Messages to send (none: this product doesn't send messages)" : `Messages to send (${on} of ${notes.length})`}</summary>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(220px, 100%), 1fr))", gap: "5px 12px", marginTop: 6, fontSize: 13 }}>
                  {notes.map(n => (
                    <label key={n.code} className="row" style={{ gap: 7, fontWeight: 400 }}>
                      <input
                        type="checkbox"
                        disabled={silent}
                        checked={!svc.off.has(n.code)}
                        onChange={e =>
                          setSvc(s => {
                            const off = new Set(s.off);
                            if (e.target.checked) off.delete(n.code);
                            else off.add(n.code);
                            return { ...s, off };
                          })
                        }
                      />
                      {n.title}
                    </label>
                  ))}
                </div>
                {silent ? <p className="faint" style={{ margin: "6px 0 0", fontSize: 12 }}>This product doesn't send messages</p> : null}
              </details>
            ) : null}
            {field(
              "window",
              "Pickup time",
              <Select id="nr_window" className="select" value={req.window} onChange={e => setReq(r => ({ ...r, window: e.target.value }))}>
                <option value="">Any time (operations will confirm)</option>
                {slots
                  .filter(d => !d.closed)
                  .map(d => (
                    <optgroup key={d.label} label={d.label}>
                      {d.slots
                        .filter(s => s.available)
                        .map(s => (
                          <option key={`${s.start}|${s.end}`} value={`${s.start}|${s.end}`}>
                            {`${d.label} · ${s.label}${s.remaining !== null ? ` · ${s.remaining} left` : ""}`}
                          </option>
                        ))}
                    </optgroup>
                  ))}
              </Select>,
              { hint: "Operations confirm the exact time." },
            )}
          </div>
        ) : null}

        <h3 className="section-title" style={{ marginTop: 16 }}>
          Recipient
        </h3>
        <div className="form-grid">
          {field("name", "Recipient name", <input id="nr_name" className="input" maxLength={120} placeholder="e.g. Jamie Lee" value={recipient.name} aria-invalid={errors.name ? true : undefined} onChange={e => setRecipient(r => ({ ...r, name: e.target.value }))} />, { req: true })}
          {field(
            "phone",
            "Recipient phone",
            <div className="phone-input">
              <span>+880</span>
              <input id="nr_phone" className="input" inputMode="tel" placeholder="17XXXXXXXX" value={recipient.phone} aria-invalid={errors.phone ? true : undefined} onChange={e => setRecipient(r => ({ ...r, phone: e.target.value }))} />
            </div>,
            { req: true },
          )}
          <Street doc={doc} value={place.street} catalog={catalog} invalid={!!errors.street} error={errors.street} onChange={street => setPlace(p => ({ ...p, street }))} onPlace={found => setPlace(p => ({ ...p, ...found }))} />
          {field(
            "district",
            "District",
            <SearchSelect id="nr_district" label="districts" value={place.district} onChange={v => setPlace(p => ({ ...p, district: v, zone: "", area: "" }))} placeholder={catalog ? "Choose district" : "Loading…"} invalid={!!errors.district} options={(catalog?.districts ?? []).map(v => ({ value: v, label: v }))} />,
            { req: true },
          )}
          {field(
            "zone",
            "Zone",
            <SearchSelect id="nr_zone" label="zones" value={place.zone} onChange={v => setPlace(p => ({ ...p, zone: v, area: "" }))} placeholder={place.district ? "Choose zone" : "Choose the district first"} disabled={!place.district} invalid={!!errors.zone} options={zones.map(v => ({ value: v, label: v }))} />,
            { req: true },
          )}
          {field(
            "area",
            "Area (optional)",
            <SearchSelect id="nr_area" label="areas" value={place.area} onChange={v => setPlace(p => ({ ...p, area: v }))} placeholder={place.zone ? (areas.length ? "Choose area (optional)" : "No areas listed") : "Choose the zone first"} disabled={!place.zone || !areas.length} emptyLabel={areas.length ? "No area" : undefined} options={areas.map(v => ({ value: v, label: v }))} />,
          )}
          {field(
            "category",
            "Address category",
            <Select id="nr_category" className="select" searchable={false} value={place.category} onChange={e => setPlace(p => ({ ...p, category: e.target.value }))}>
              {(doc ? ["Office", "Home", "Other"] : ["Home", "Office", "Other"]).map(c => (
                <option key={c}>{c}</option>
              ))}
            </Select>,
          )}
        </div>

        <h3 className="section-title" style={{ marginTop: 16 }}>
          {doc ? "Request" : "Order"}
        </h3>
        <div className="form-grid">
          {catalogue.length
            ? field(
                "catalogue",
                "From your catalogue (optional)",
                <SearchSelect
                  id="nr_catalogue"
                  label="catalogue"
                  value=""
                  placeholder="Choose a product to prefill…"
                  onChange={id => {
                    const p = catalogue.find(x => x.id === id);
                    if (!p) return;
                    // The product dropdown lists only the package's products: pick one only when the saved item matches it.
                    const wanted = doc ? p.name : p.category || p.name;
                    if (products.some(x => x.name === wanted)) setReq(r => ({ ...r, product: wanted }));
                    if (!doc && p.weightKg) setReq(r => ({ ...r, weight: String(p.weightKg) }));
                    // The catalogue price is the product value; with COD ticked it is also the cash to collect.
                    if (p.price) setReq(r => ({ ...r, value: String(p.price) }));
                    if (!doc && p.price && service?.codOn && !svc.codAmount) setSvc(x => ({ ...x, codAmount: String(p.price) }));
                    setRefHint(`e.g. ${p.sku}-${new Date().getDate()}`);
                  }}
                  options={catalogue.map(p => ({ value: p.id, label: `${p.name} · ${p.sku}${p.price ? ` · ${taka(p.price)}` : ""}` }))}
                />,
                { full: true },
              )
            : null}
          {products.length
            ? field(
                "product",
                "Product (optional)",
                <SearchSelect
                  id="nr_product"
                  label="products"
                  value={req.product}
                  onChange={v => setReq(r => ({ ...r, product: v }))}
                  emptyLabel="No product (Regular)"
                  options={products.map(p => ({ value: p.name, label: `${p.name} · ${L?.productType?.[p.type] || p.type}` }))}
                />,
              )
            : null}
          {view?.priorities?.length
            ? field(
                "priority",
                "Priority",
                <Select id="nr_priority" className="select" searchable={false} value={svc.priority} onChange={e => setSvc(s => ({ ...s, priority: e.target.value }))}>
                  {view.priorities.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>,
              )
            : null}
          {doc
            ? null
            : field("weight", "Weight (kg)", <input id="nr_weight" className="input" type="number" min={0.01} max={50} step={0.01} value={req.weight} aria-invalid={errors.weight ? true : undefined} onChange={e => setReq(r => ({ ...r, weight: e.target.value }))} />, { req: true })}
          {field("value", doc ? "Declared value (optional)" : "Product value (optional)", <input id="nr_value" className="input" type="number" min={0} placeholder={doc ? "0" : "Declared value of the goods"} value={req.value} aria-invalid={errors.value ? true : undefined} onChange={e => setReq(r => ({ ...r, value: e.target.value }))} />)}
          {field("ref", doc ? "Internal reference / cost center (optional)" : "Order reference (optional)", <input id="nr_ref" className="input" maxLength={80} placeholder={refHint} value={req.ref} onChange={e => setReq(r => ({ ...r, ref: e.target.value }))} />)}
          {field("contents", doc ? "Item description (optional)" : "Contents (optional)", <input id="nr_contents" className="input" maxLength={200} value={req.contents} onChange={e => setReq(r => ({ ...r, contents: e.target.value }))} />)}
          {field("cn", "Pre-printed CN (optional)", <input id="nr_cn" className="input" placeholder="Label from your CN stock" value={req.cn} aria-invalid={errors.cn ? true : undefined} onChange={e => setReq(r => ({ ...r, cn: e.target.value }))} />)}
        </div>

        <div className="callout" style={{ marginTop: 14, ...(quote?.q?.chargesOn === false ? { display: "none" } : {}) }} aria-live="polite">
          {quote?.q?.lines ? (
            <div style={{ display: "grid", gap: 3, fontSize: 13, flex: 1 }}>
              {quote.q.lines.map(l => (
                <div key={l.label} className="row" style={{ justifyContent: "space-between" }}>
                  <span>{l.label}</span>
                  <span>
                    {l.amount < 0 ? "−" : ""}
                    {taka(Math.abs(l.amount))}
                  </span>
                </div>
              ))}
              <div className="row" style={{ justifyContent: "space-between", fontWeight: 700, borderTop: "1px solid var(--line)", paddingTop: 4 }}>
                <span>Delivery charge{quote.q.package?.name ? ` · ${quote.q.package.name}` : ""}</span>
                <span>{taka(quote.q.totalCharge)}</span>
              </div>
              {quote.q.returnCharge ? <div className="faint" style={{ fontSize: 12 }}>If it comes back: return charge {taka(quote.q.returnCharge)}</div> : null}
            </div>
          ) : quote?.q ? (
            `Estimated delivery charge ${taka(quote.q.totalCharge)}.`
          ) : (
            (quote?.text ?? "")
          )}
        </div>
      </div>
      <div className="dialog-foot">
        <button type="button" className="button" onClick={close} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="button primary" aria-busy={busy || undefined} disabled={busy}>
          {doc ? "Create request" : "Create order"}
        </button>
      </div>
    </form>
  );
}

/** The full address: after a pause (or on leaving it) GET /catalog/place picks the district / zone / area it names. */
function Street({ doc, value, catalog, invalid, error, onChange, onPlace }: { doc: boolean; value: string; catalog: Catalog | undefined; invalid: boolean; error?: string; onChange: (v: string) => void; onPlace: (p: { district: string; zone: string; area: string }) => void }) {
  const read = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const current = useRef(value);
  current.current = value;
  useEffect(() => () => clearTimeout(timer.current), []);
  async function detect(text: string) {
    text = text.trim();
    if (text.length < 4 || read.current === text || !catalog) return;
    read.current = text;
    let found: { district?: string; zone?: string; area?: string } | null;
    try {
      found = await api(`/catalog/place?address=${encodeURIComponent(text)}`);
    } catch {
      return;
    }
    if (!found || current.current.trim() !== text || !found.district || !catalog.districts.includes(found.district)) return;
    const zone = found.zone && (catalog.zonesByDistrict[found.district] ?? []).includes(found.zone) ? found.zone : "";
    const area = zone && found.area && (catalog.areasByZone[zone] ?? []).includes(found.area) ? found.area : "";
    onPlace({ district: found.district, zone, area });
  }
  return (
    <label className="field full" htmlFor="nr_street">
      <span>
        Full address<span className="req" aria-hidden="true"> *</span>
      </span>
      <input
        id="nr_street"
        className="input"
        maxLength={200}
        placeholder={doc ? "e.g. Level 5, Tower 2, Road 11, Gulshan 2, Dhaka" : "e.g. Flat 4B, House 22, Road 7, Block C, Banani, Dhaka"}
        value={value}
        aria-invalid={invalid || undefined}
        onChange={e => {
          const v = e.target.value;
          onChange(v);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => void detect(v), 900);
        }}
        onBlur={e => (clearTimeout(timer.current), void detect(e.target.value))}
      />
      {error ? <span className="error">{error}</span> : <small className="faint">District, zone and area follow the address; you can change them.</small>}
    </label>
  );
}

/** "Got the customer's details in a message? Paste it" (paste-message.js): POST /parse-message fills the empty fields. */
function PasteMessage({ apply, kind }: { apply: (fields: Record<string, unknown>) => string[]; kind: "document" | "ecommerce" }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function read() {
    if (text.trim().length < 5) return setNote({ ok: false, text: "Paste the message first." });
    setBusy(true);
    try {
      const { fields } = await api<{ fields: Record<string, unknown> }>("/parse-message", { method: "POST", body: { text, kind } });
      const filled = apply(fields);
      setNote(
        filled.length
          ? { ok: true, text: `Filled: ${filled.join(", ")}. Check them; district, zone and area follow the address. Fill in anything still empty.` }
          : { ok: false, text: Object.keys(fields).length ? "Those fields already have values; nothing was changed." : "No name, phone or address found in that message. Please fill in the form." },
      );
    } catch (e) {
      setNote({ ok: false, text: describe(e) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="paste-box">
      <button type="button" className="paste-toggle" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <span className="paste-ai" aria-hidden="true">
          AI
        </span>
        <span style={{ flex: 1, textAlign: "left" }}>
          <strong>Got the customer's details in a message? Paste it</strong>
          <small>Optional · we fill the name, phone, address and amount from it (English or বাংলা)</small>
        </span>
        <span aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>
      {open ? (
        <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
          <textarea className="input" rows={4} maxLength={3000} aria-label="Paste the message" placeholder={"e.g.\nName: Ayesha Rahman\nPhone: 01712345678\nAddress: House 12, Road 5, Dhanmondi, Dhaka"} value={text} onChange={e => setText(e.target.value)} autoFocus />
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="button primary sm" onClick={() => void read()} disabled={busy} aria-busy={busy || undefined}>
              {busy ? "Reading…" : "Fill the form"}
            </button>
            <button type="button" className="button sm" onClick={() => (setText(""), setNote(null))}>
              Clear
            </button>
          </div>
          {note ? (
            <p role="status" style={{ margin: 0, fontSize: 13, color: note.ok ? "var(--good)" : "var(--muted)" }}>
              {note.text}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
