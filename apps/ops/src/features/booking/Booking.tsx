/**
 * New order — bookings by operations (bridge-pages.js "New shipment" + shared/order-services.js), POST /ops/parcels:
 *   E-commerce / Banking & Financial merchant  sender and pickup from the merchant's profile, its service package
 *   Walk-in sender (customer parcel)           sender name / phone and pickup address typed here, no merchant,
 *                                              the Customer default package
 * Order of the form: account → service (first mile + drop-off hub, last mile, Service, COD + amount, open box,
 * messages) → sender → recipient → delivery address → parcel (product, weight, contents, reference, pre-printed CN) →
 * live price (POST /packages/quote with the same body the booking sends). The full address picks its district / zone /
 * area (GET /catalog/place). After booking the parcel's drawer opens (Print label there).
 */
import { Select } from "@/ui/Select";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { bdPhoneProblem, normalizeBdPhone } from "@delivery-fast/shared/dist/phone.js";
import { api, describe } from "@/lib/api";
import { addressText } from "@/lib/format";
import { useOps } from "@/lib/ops";
import { openCustom } from "@/ui/dialogs";
import { Button } from "@/ui/kit";
import { Icon } from "@/ui/Icon";
import { SearchSelect } from "@/ui/SearchSelect";
import { toast } from "@/ui/toast";
import { useCatalog, type Catalog } from "@/features/parcels/search";
import { openCamera } from "@/features/scan/scanner";

export type BookingLine = "ecommerce" | "banking" | "walkin";
const LINE_LABEL: Record<BookingLine, string> = { ecommerce: "E-commerce merchant", banking: "Banking & Financial merchant", walkin: "Walk-in sender (customer parcel)" };
const LINE_TITLE: Record<BookingLine, string> = { ecommerce: "Create e-commerce order", banking: "Create Banking & Financial order", walkin: "Create walk-in order" };
const AUTO_COLLECT = "The hub serving the delivery zone (choose the zone)";
const TYPE_ORDER: Record<string, number> = { REGULAR: 0, DOCUMENT: 1, BOOKS: 2 };
const taka = (n: unknown) => `৳${Number(n || 0).toLocaleString("en-BD")}`;

interface Merchant {
  id: string;
  code: string;
  name: string;
  type: string;
  status: string;
  contactName: string;
  contactPhone?: string | null;
  pickupDistrict: string;
  pickupZone: string | null;
  pickupArea: string | null;
  pickupAddress: string | null;
  pickupContactName?: string | null;
  pickupContactPhone?: string | null;
  pickupHub: { id: string; name: string } | null;
}
interface PackageView {
  options: { firstMiles: string[]; defaultFirstMile?: string; lastMiles: string[]; defaultLastMile?: string; speeds: string[]; cod: boolean; openBox: boolean };
  labels: { firstMile: Record<string, string>; lastMile: Record<string, string>; speed: Record<string, string>; productType?: Record<string, string> };
  products?: { id: string; name: string; type: string; sendMessages?: boolean }[];
  notifications?: { code: string; title: string }[];
  dropHubs?: { id: string; name: string; type?: string }[];
}
interface Quote {
  lines?: { label: string; amount: number }[];
  totalCharge: number;
  returnCharge?: number;
  package?: { name: string } | null;
  collectHub?: { name: string; address?: string | null } | null;
}
interface Place {
  street: string;
  district: string;
  zone: string;
  area: string;
}
const emptyPlace: Place = { street: "", district: "", zone: "", area: "" };

/** Opens the booking form; `line` fixes the kind of sender (otherwise a "Booking for" select, E-commerce first). */
export function openBooking(line?: BookingLine) {
  return openCustom(close => <BookingDialog fixed={line} close={() => close()} />, "wide");
}

/** Package views are the same for a minute (order-services.js load cache). */
const pkgCache = new Map<string, { view: PackageView; until: number }>();
async function loadPackage(path: string) {
  const hit = pkgCache.get(path);
  if (hit && hit.until > Date.now()) return hit.view;
  const view = await api<PackageView>(path);
  pkgCache.set(path, { view, until: Date.now() + 60_000 });
  return view;
}

function BookingDialog({ fixed, close }: { fixed?: BookingLine; close: () => void }) {
  const ops = useOps();
  const catalog = useCatalog();
  const [, setParams] = useSearchParams();
  const [line, setLine] = useState<BookingLine>(fixed ?? "ecommerce");
  const [merchants, setMerchants] = useState<Merchant[] | null>(null);
  const [merchantId, setMerchantId] = useState("");
  const [sender, setSender] = useState({ name: "", phone: "" });
  const [pickup, setPickup] = useState<Place>(emptyPlace);
  const [recipient, setRecipient] = useState({ name: "", phone: "" });
  const [delivery, setDelivery] = useState<Place>(emptyPlace);
  const [parcel, setParcel] = useState({ product: "", weight: "0.5", contents: "", ref: "", cn: "" });
  const [pkg, setPkg] = useState<{ key: string; view: PackageView | null; error?: string } | null>(null);
  const [svc, setSvc] = useState({ firstMile: "", dropHubId: "", lastMile: "", speed: "REGULAR", cod: false, codAmount: "", openBox: false, off: new Set<string>() });
  const [quote, setQuote] = useState<{ q?: Quote; text?: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const walkIn = line === "walkin";
  const banking = line === "banking";

  // Merchants (active, of the line; hub managers book for their hub's merchants).
  useEffect(() => {
    api<Merchant[]>("/ops/merchants").then(setMerchants, e => toast(describe(e), "bad"));
  }, []);
  const mine = ops.myHubs?.map(h => h.id) ?? null;
  const lineMerchants = useMemo(
    () => (merchants ?? []).filter(m => m.status === "ACTIVE" && (line === "banking") === (m.type === "BANKING_FINANCIAL") && (!mine || (m.pickupHub && mine.includes(m.pickupHub.id)))),
    [merchants, line, mine],
  );
  useEffect(() => {
    if (walkIn || !merchants) return;
    setMerchantId(id => (lineMerchants.some(m => m.id === id) ? id : lineMerchants.length === 1 ? lineMerchants[0].id : ""));
  }, [lineMerchants, walkIn, merchants]);
  const merchant = walkIn ? null : (merchants ?? []).find(m => m.id === merchantId) ?? null;

  // The sender's service package: the merchant's, or the Customer default package for walk-ins.
  const pkgKey = walkIn ? "walkin" : merchantId;
  useEffect(() => {
    if (!pkgKey) return setPkg(null);
    let live = true;
    setPkg({ key: pkgKey, view: null });
    loadPackage(walkIn ? "/packages/effective?segment=CUSTOMER" : `/packages/effective?merchantId=${encodeURIComponent(merchantId)}`).then(
      view => {
        if (!live) return;
        setPkg({ key: pkgKey, view });
        const hubs = dropHubsOf(view);
        setSvc({
          firstMile: view.options.defaultFirstMile || view.options.firstMiles[0] || "",
          dropHubId: hubs.length === 1 ? hubs[0].id : "",
          lastMile: view.options.defaultLastMile || view.options.lastMiles[0] || "",
          speed: "REGULAR",
          cod: false,
          codAmount: "",
          openBox: false,
          off: new Set(),
        });
        setParcel(p => ({ ...p, product: "" }));
      },
      e => live && setPkg({ key: pkgKey, view: null, error: describe(e) }),
    );
    return () => void (live = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pkgKey]);
  const view = pkg?.view ?? null;
  const dropHubsOf = (v: PackageView) => (ops.myHubs ?? ops.hubs.filter(h => h.active !== false)).map(h => ({ id: h.id, name: h.name, type: h.type })) || v.dropHubs || [];
  const product = view?.products?.find(p => p.name === parcel.product) ?? null;
  const silent = !!product && product.sendMessages === false;

  /** The service as sent (order-services.js read): the select's value, else the package's only / default way. */
  const service = useMemo(() => {
    if (!view) return null;
    const o = view.options;
    const firstMile = (o.firstMiles.length > 1 ? svc.firstMile : "") || o.defaultFirstMile || o.firstMiles[0];
    const lastMile = (o.lastMiles.length > 1 ? svc.lastMile : "") || o.defaultLastMile || o.lastMiles[0];
    const codOn = o.cod ? svc.cod : false;
    const all = view.notifications ?? [];
    const ticked = all.filter(n => !svc.off.has(n.code)).map(n => n.code);
    return {
      firstMile,
      ...(firstMile === "HUB_DROP" && svc.dropHubId ? { dropHubId: svc.dropHubId } : {}),
      lastMile,
      speed: (o.speeds.length > 1 ? svc.speed : "") || "REGULAR",
      ...(parcel.product ? { product: parcel.product } : {}),
      openBox: o.openBox ? svc.openBox : false,
      cod: codOn,
      codAmount: codOn ? Number(svc.codAmount) || 0 : 0,
      ...(all.length && ticked.length !== all.length && !silent ? { notifications: ticked } : {}),
    } as { firstMile: string; dropHubId?: string; lastMile: string; speed: string; product?: string; openBox: boolean; cod: boolean; codAmount: number; notifications?: string[] };
  }, [view, svc, parcel.product, silent]);
  const drop = service?.firstMile === "HUB_DROP";
  const hubCollect = service?.lastMile === "HUB_COLLECT";

  // Live price: the same places and choices the booking sends (product included, so the price matches).
  const quoteBody = () => {
    if (!service) return null;
    const dropHub = drop ? ops.hubs.find(h => h.id === service.dropHubId) : null;
    const from = walkIn
      ? pickup.district || !dropHub
        ? { pickupDistrict: pickup.district, pickupZone: pickup.zone || undefined, pickupArea: pickup.area || undefined }
        : { pickupDistrict: dropHub.district, pickupZone: dropHub.zone || undefined }
      : { pickupDistrict: merchant?.pickupDistrict, pickupZone: merchant?.pickupZone || undefined };
    const { cod: _cod, codAmount, notifications: _n, ...choices } = service;
    void _cod;
    void _n;
    return {
      ...(walkIn ? {} : { merchantId }),
      ...from,
      deliveryDistrict: delivery.district,
      deliveryZone: delivery.zone,
      ...(delivery.area ? { deliveryArea: delivery.area } : {}),
      ...(banking ? {} : { weightKg: Number(parcel.weight) || 0.5 }),
      codAmount: banking ? 0 : codAmount || 0,
      ...choices,
    };
  };
  const quoteKey = JSON.stringify(quoteBody());
  useEffect(() => {
    if (!view) return setQuote(null);
    const body = quoteBody();
    if (!body?.pickupDistrict || !body.deliveryDistrict)
      return setQuote({ text: walkIn && !body?.pickupDistrict ? "Choose the sender's district and the delivery district to see the price." : "Choose the delivery district to see the price." });
    let live = true;
    const timer = setTimeout(() => {
      api<Quote>("/packages/quote", { method: "POST", body }).then(
        q => live && setQuote({ q }),
        e => live && setQuote({ text: describe(e) }),
      );
    }, 300);
    return () => ((live = false), clearTimeout(timer));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quoteKey]);

  // ───────────── checks ─────────────
  const problems = (): Record<string, string> => {
    const e: Record<string, string> = {};
    const need = (id: string, ok: unknown, message: string) => !ok && (e[id] = message);
    if (!walkIn) need("merchant", merchantId, "Choose the merchant account");
    if (walkIn) {
      need("senderName", sender.name.trim(), "Enter the sender's name");
      const p = sender.phone.trim() ? bdPhoneProblem(sender.phone) : "Enter the sender's phone number";
      if (p) e.senderPhone = p;
      if (!drop) {
        need("pickupDistrict", pickup.district, "Choose the sender's district");
        need("pickupZone", pickup.zone, "Choose the sender's zone");
        need("pickupStreet", pickup.street.trim(), "Enter the sender's address");
      }
    }
    need("recipient", recipient.name.trim(), "Enter the recipient's name");
    const rp = recipient.phone.trim() ? bdPhoneProblem(recipient.phone) : "Enter the recipient's phone number";
    if (rp) e.phone = rp;
    need("district", delivery.district, "Choose the delivery district");
    need("zone", delivery.zone, "Choose the delivery zone");
    if (!hubCollect) need("street", delivery.street.trim(), "Enter the street address");
    if (!banking) {
      const w = parcel.weight.trim();
      if (!w) e.weight = "Enter the weight";
      else if (!(Number(w) >= 0.01)) e.weight = "At least 0.01 kg";
      else if (Number(w) > 50) e.weight = "At most 50 kg";
    }
    if (parcel.cn.trim() && !/^[A-Za-z]{2,4}-\d{6}-[0-9A-Za-z]{4,8}$/.test(parcel.cn.trim())) e.cn = "Enter the consignment number printed on the label";
    if (view && drop && !svc.dropHubId) e.dropHub = "Choose the hub the sender brings the parcel to";
    if (service?.cod) {
      const n = Number(svc.codAmount);
      if (!svc.codAmount.trim()) e.codAmount = "Enter the cash to collect, or untick COD";
      else if (!(n >= 1)) e.codAmount = "Enter an amount of at least ৳1";
      else if (n > 1_000_000) e.codAmount = "The amount is too large";
    }
    return e;
  };
  // After the first submit, errors follow the typing.
  useEffect(() => {
    if (checked) setErrors(problems());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checked, line, merchantId, sender, pickup, recipient, delivery, parcel, svc, service]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const found = problems();
    setChecked(true);
    setErrors(found);
    if (Object.keys(found).length) {
      document.getElementById(`bk_${Object.keys(found)[0]}`)?.focus();
      return toast("Check the highlighted fields.", "bad");
    }
    if (!view || !service) return toast(walkIn ? "The Customer package is still loading. Try again in a moment." : "Choose the merchant account.", "bad");
    const { cod: _cod, codAmount = 0, firstMile, dropHubId, ...choices } = service;
    void _cod;
    const dropOff = firstMile === "HUB_DROP";
    const body = {
      ...(merchant
        ? { merchantId: merchant.id }
        : {
            sender: { name: sender.name.trim(), phone: normalizeBdPhone(sender.phone.trim()) },
            ...(dropOff && !pickup.street.trim() ? {} : { pickup: { category: "HOME", street: pickup.street.trim(), area: pickup.area || undefined, zone: pickup.zone, district: pickup.district } }),
          }),
      // Drop at hub is the hub drop-off intake (the hub receive desk expects it); other first miles go as chosen.
      intake: dropOff ? "DROP_OFF" : "PICKUP",
      ...(dropOff ? { dropOffHubId: dropHubId } : { firstMile }),
      recipient: { name: recipient.name.trim(), phone: normalizeBdPhone(recipient.phone.trim()) },
      delivery: { category: "HOME", street: delivery.street.trim(), area: delivery.area || undefined, zone: delivery.zone, district: delivery.district },
      type: banking ? "DOCUMENT" : line === "ecommerce" ? "ECOMMERCE" : "PARCEL",
      // Banking & Financial has no weight in pricing: the API needs one, 0.5 kg (the included weight).
      weightKg: banking ? 0.5 : Number(parcel.weight),
      codAmount: banking ? 0 : codAmount,
      ...choices,
      contents: parcel.contents.trim() || undefined,
      merchantOrderRef: parcel.ref.trim() || undefined,
      cn: parcel.cn.trim().toUpperCase() || undefined,
    };
    setBusy(true);
    try {
      const p = await api<{ trackingId: string; intake: string; statusLabel: string; merchant?: { name: string } | null; sender?: { name: string } | null; dropOffHub?: { name: string } | null; charges: { total: number } }>("/ops/parcels", { method: "POST", body });
      close();
      ops.refreshAll();
      // The new parcel's drawer: its details, price breakdown and "Print label".
      setParams(s => (s.set("parcel", p.trackingId), s));
      const who = p.merchant?.name || `${p.sender?.name || sender.name.trim()} (walk-in)`;
      const next = p.intake === "DROP_OFF" ? `${p.statusLabel.toLowerCase()} at ${p.dropOffHub?.name || "the hub"}. Print the label from the parcel panel.` : "Assign a pickup rider in Dispatch.";
      toast(`${p.trackingId} booked for ${who} · charge ৳${p.charges.total} · ${next}`, "good");
    } catch (e) {
      toast(describe(e), "bad");
      setBusy(false);
    }
  }

  // ───────────── layout ─────────────
  const err = (id: string) => errors[id];
  const field = (id: string, label: string, control: React.ReactNode, { full = false, req = false, hint }: { full?: boolean; req?: boolean; hint?: React.ReactNode } = {}) => (
    <div className={`field${full ? " full" : ""}`}>
      <label htmlFor={`bk_${id}`} className="field-label">
        {label}
        {req ? <span style={{ color: "#c2410c", fontWeight: 700 }}> *</span> : null}
      </label>
      {control}
      {hint ? <small>{hint}</small> : null}
      {err(id) ? (
        <span className="error" id={`bk_${id}_err`}>
          {err(id)}
        </span>
      ) : null}
    </div>
  );
  const input = (id: string, value: string, onChange: (v: string) => void, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <input id={`bk_${id}`} className="input" value={value} onChange={e => onChange(e.target.value)} aria-invalid={err(id) ? true : undefined} autoComplete="off" {...extra} />
  );
  const phone = (id: string, value: string, onChange: (v: string) => void) => (
    <div className="phone-input">
      <span>+880</span>
      <input id={`bk_${id}`} className="input" inputMode="tel" autoComplete="off" placeholder="1XXXXXXXXX" value={value.replace(/^\+?880/, "")} onChange={e => onChange(e.target.value)} aria-invalid={err(id) ? true : undefined} />
    </div>
  );
  const section = (title: string) => (
    <div className="full" style={{ margin: "4px 0 -4px", paddingTop: 10, borderTop: "1px solid var(--line)", color: "#8792a2", fontSize: 11, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase" }}>
      {title}
    </div>
  );
  const o = view?.options;
  const sortedProducts = [...(view?.products ?? [])].sort((a, b) => (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9) || a.name.localeCompare(b.name));
  const dropHubs = view ? dropHubsOf(view) : [];
  const notes = view?.notifications ?? [];
  const onCount = notes.filter(n => !svc.off.has(n.code)).length;

  return (
    <form onSubmit={submit} noValidate>
      <div className="dialog-head">
        <div>
          <h2>{LINE_TITLE[line]}</h2>
          <p>
            {walkIn
              ? "Books a customer parcel for a walk-in sender (no merchant): picked up from the sender's address or dropped off at a hub. Priced with the Customer default package."
              : "Books the parcel for a merchant: picked up by a rider from the merchant's registered address, or dropped off at a hub. The price comes from the merchant's service package."}
          </p>
        </div>
        <button type="button" className="button ghost icon dialog-close" aria-label="Close" onClick={close}>
          <Icon name="x" size={18} />
        </button>
      </div>
      <div className="dialog-body">
        <div className="form-grid">
          {section(fixed === "walkin" ? "Booking" : "Account")}
          {fixed ? null : field(
            "line",
            "Booking for",
            <Select id="bk_line" className="select" value={line} onChange={e => setLine(e.target.value as BookingLine)}>
              {(Object.keys(LINE_LABEL) as BookingLine[]).map(l => (
                <option key={l} value={l}>
                  {LINE_LABEL[l]}
                </option>
              ))}
            </Select>,
            { full: true },
          )}
          {walkIn
            ? null
            : field(
                "merchant",
                "Merchant account",
                <SearchSelect
                  id="bk_merchant"
                  label="merchants"
                  value={merchantId}
                  onChange={setMerchantId}
                  invalid={!!err("merchant")}
                  placeholder={!merchants ? "Loading merchants…" : lineMerchants.length ? "Choose the merchant" : mine ? "No active merchants of your hub for this category" : "No active merchants for this category"}
                  options={lineMerchants.map(m => ({ value: m.id, label: `${m.name} · ${m.code} · ${m.pickupHub?.name || "no hub"}` }))}
                />,
                {
                  full: true,
                  req: true,
                  hint: merchant
                    ? `Picks up from ${addressText(merchant.pickupAddress, merchant.pickupArea, merchant.pickupZone, merchant.pickupDistrict)} · ${merchant.pickupContactName || merchant.contactName} ${merchant.pickupContactPhone || merchant.contactPhone || ""}${merchant.pickupHub ? ` · hub ${merchant.pickupHub.name}` : ""}`
                    : undefined,
                },
              )}

          {/* The service first: it decides which addresses are needed (drop at hub: no sender address; Hub Pickup: no street). */}
          {section("Service")}
          {!pkg ? (
            <p className="full faint" style={{ margin: 0 }}>
              Choose the merchant account to see its services and price.
            </p>
          ) : !view ? (
            <p className="full" style={{ margin: 0, color: pkg.error ? "var(--bad)" : "var(--faint)" }}>
              {pkg.error || "Loading the service package…"}
            </p>
          ) : (
            <>
              {o!.firstMiles.length > 1
                ? field(
                    "firstMile",
                    "First mile",
                    <Select id="bk_firstMile" className="select" value={svc.firstMile} onChange={e => setSvc(s => ({ ...s, firstMile: e.target.value }))}>
                      {o!.firstMiles.map(f => (
                        <option key={f} value={f}>
                          {view.labels.firstMile[f] ?? f}
                        </option>
                      ))}
                    </Select>,
                  )
                : null}
              {o!.firstMiles.includes("HUB_DROP") && drop
                ? field(
                    "dropHub",
                    "Drop-off hub",
                    <Select id="bk_dropHub" className="select" value={svc.dropHubId} onChange={e => setSvc(s => ({ ...s, dropHubId: e.target.value }))} aria-invalid={err("dropHub") ? true : undefined}>
                      <option value="">Choose the hub</option>
                      {dropHubs.map(h => (
                        <option key={h.id} value={h.id}>
                          {h.type === "FRANCHISE" ? `${h.name} · Franchise` : h.name}
                        </option>
                      ))}
                    </Select>,
                    { req: true },
                  )
                : null}
              {o!.lastMiles.length > 1
                ? field(
                    "lastMile",
                    "Last mile",
                    <Select id="bk_lastMile" className="select" value={svc.lastMile} onChange={e => setSvc(s => ({ ...s, lastMile: e.target.value }))}>
                      {o!.lastMiles.map(l => (
                        <option key={l} value={l}>
                          {view.labels.lastMile[l] ?? l}
                        </option>
                      ))}
                    </Select>,
                  )
                : null}
              {o!.lastMiles.includes("HUB_COLLECT") && hubCollect ? (
                <div className="field">
                  <span className="field-label">Collect from</span>
                  <div style={{ padding: "8px 0", fontWeight: 650, lineHeight: 1.4 }}>
                    {quote?.q && "collectHub" in quote.q ? (quote.q.collectHub ? `${quote.q.collectHub.name}${quote.q.collectHub.address ? ` · ${quote.q.collectHub.address}` : ""}` : AUTO_COLLECT) : AUTO_COLLECT}
                  </div>
                </div>
              ) : null}
              {o!.speeds.length > 1
                ? field(
                    "speed",
                    "Service",
                    <Select id="bk_speed" className="select" value={svc.speed} onChange={e => setSvc(s => ({ ...s, speed: e.target.value }))}>
                      {o!.speeds.map(s => (
                        <option key={s} value={s}>
                          {view.labels.speed[s] ?? s}
                        </option>
                      ))}
                    </Select>,
                  )
                : null}
              {o!.cod || o!.openBox ? (
                <div className="full row" style={{ gap: "8px 18px" }}>
                  {o!.cod ? (
                    <label className="check" style={{ fontWeight: 600 }}>
                      <input type="checkbox" checked={svc.cod} onChange={e => setSvc(s => ({ ...s, cod: e.target.checked }))} /> Collect cash on delivery (COD)
                    </label>
                  ) : null}
                  {o!.openBox ? (
                    <label className="check" style={{ fontWeight: 600 }}>
                      <input type="checkbox" checked={svc.openBox} onChange={e => setSvc(s => ({ ...s, openBox: e.target.checked }))} /> Open box / check before pay
                    </label>
                  ) : null}
                </div>
              ) : null}
              {o!.cod && svc.cod
                ? field("codAmount", "COD amount (৳)", input("codAmount", svc.codAmount, v => setSvc(s => ({ ...s, codAmount: v })), { type: "number", min: 1, max: 1000000, step: 1, inputMode: "numeric", placeholder: "Cash to collect from the recipient" }), { req: true })
                : null}
              {notes.length ? (
                <details className="full">
                  <summary style={{ cursor: "pointer", fontWeight: 600 }}>{silent ? "Messages to send (none: this product doesn't send messages)" : `Messages to send (${onCount} of ${notes.length})`}</summary>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(220px, 100%), 1fr))", gap: "5px 12px", marginTop: 6, fontSize: 13 }}>
                    {notes.map(n => (
                      <label key={n.code} className="check">
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
                        />{" "}
                        {n.title}
                      </label>
                    ))}
                  </div>
                  {silent ? <p style={{ margin: "6px 0 0", color: "#8792a2", fontSize: 12 }}>This product doesn't send messages</p> : null}
                </details>
              ) : null}
            </>
          )}

          {walkIn ? (
            <>
              {section("Sender")}
              {drop ? (
                <p className="full" style={{ margin: "-4px 0 0", color: "var(--muted)", fontSize: 12.5 }}>
                  Dropped at the hub: the sender's address is optional. A return comes back to the drop-off hub for the sender to collect.
                </p>
              ) : null}
              {field("senderName", "Sender name", input("senderName", sender.name, v => setSender(s => ({ ...s, name: v })), { maxLength: 120, placeholder: "Walk-in sender's name" }), { req: true })}
              {field("senderPhone", "Sender phone", phone("senderPhone", sender.phone, v => setSender(s => ({ ...s, phone: v }))), { req: true })}
              <PlaceFields
                prefix="pickup"
                catalog={catalog}
                place={pickup}
                set={setPickup}
                errors={errors}
                field={field}
                streetLabel={drop ? "Sender address (optional)" : "Sender address (pickup and returns)"}
                streetPlaceholder="e.g. House 12, Road 5, Dhanmondi, Dhaka"
                labels={["Sender district", "Sender zone", "Sender area (optional)"]}
                required={!drop}
              />
            </>
          ) : null}

          {section("Recipient")}
          {field("recipient", "Recipient name", input("recipient", recipient.name, v => setRecipient(r => ({ ...r, name: v })), { maxLength: 120, placeholder: "Recipient name" }), { req: true })}
          {field("phone", "Recipient phone", phone("phone", recipient.phone, v => setRecipient(r => ({ ...r, phone: v }))), { req: true })}

          {section("Delivery address")}
          <PlaceFields
            prefix=""
            catalog={catalog}
            place={delivery}
            set={setDelivery}
            errors={errors}
            field={field}
            streetLabel={hubCollect ? "Street address (optional for Hub Pickup)" : "Full address"}
            streetPlaceholder="e.g. Flat 4B, House 22, Road 7, Block C, Banani, Dhaka"
            labels={["District", "Zone", "Area (optional)"]}
            required
            streetRequired={!hubCollect}
            streetFull
          />

          {section("Parcel")}
          {field(
            "product",
            "Product (optional)",
            <Select id="bk_product" className="select" value={parcel.product} onChange={e => setParcel(p => ({ ...p, product: e.target.value }))} disabled={!view}>
              <option value="">No product (Regular)</option>
              {sortedProducts.map(p => (
                <option key={p.id} value={p.name}>
                  {p.name} · {view?.labels.productType?.[p.type] || p.type}
                </option>
              ))}
            </Select>,
          )}
          {banking ? null : field("weight", "Weight (kg)", input("weight", parcel.weight, v => setParcel(p => ({ ...p, weight: v })), { type: "number", min: 0.01, max: 50, step: 0.1, inputMode: "decimal" }), { req: true })}
          {field(
            "contents",
            banking ? "Item description (optional)" : "Contents (optional)",
            input("contents", parcel.contents, v => setParcel(p => ({ ...p, contents: v })), { maxLength: 120, placeholder: banking ? "e.g. Credit card for account ending 4821" : "e.g. 2 T-shirts" }),
          )}
          {field("ref", "Order reference (optional)", input("ref", parcel.ref, v => setParcel(p => ({ ...p, ref: v })), { maxLength: 80 }))}
          {field(
            "cn",
            "Pre-printed CN (optional)",
            <div className="row" style={{ flexWrap: "nowrap" }}>
              {input("cn", parcel.cn, v => setParcel(p => ({ ...p, cn: v })), { maxLength: 24, placeholder: "Label from CN stock" })}
              <button
                type="button"
                className="button icon"
                aria-label="Scan the CN label with the camera"
                title="Scan the CN label"
                onClick={async () => {
                  const code = await openCamera({ title: "Scan the CN label" });
                  if (code) setParcel(p => ({ ...p, cn: code }));
                }}
              >
                <Icon name="camera" />
              </button>
            </div>,
          )}
          <div className="full" aria-live="polite" style={{ fontSize: 13, color: "#637083" }}>
            {!view ? null : quote?.q?.lines ? (
              <div style={{ display: "grid", gap: 3 }}>
                {quote.q.lines.map((l, i) => (
                  <div key={i} className="row" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
                    <span>{l.label}</span>
                    <span>
                      {l.amount < 0 ? "−" : ""}
                      {taka(Math.abs(l.amount))}
                    </span>
                  </div>
                ))}
                <div className="row" style={{ justifyContent: "space-between", flexWrap: "nowrap", fontWeight: 700, borderTop: "1px solid var(--line)", paddingTop: 4, color: "var(--ink)" }}>
                  <span>Delivery charge{quote.q.package?.name ? ` · ${quote.q.package.name}` : ""}</span>
                  <span>{taka(quote.q.totalCharge)}</span>
                </div>
                {quote.q.returnCharge ? <div style={{ color: "#8792a2", fontSize: 12 }}>If it comes back: return charge {taka(quote.q.returnCharge)}</div> : null}
              </div>
            ) : (
              quote?.text ?? null
            )}
          </div>
        </div>
      </div>
      <div className="dialog-foot">
        <Button onClick={close} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={busy} aria-busy={busy || undefined}>
          Book order
        </Button>
      </div>
    </form>
  );
}

/**
 * Street (the full address) → district → zone → area from the catalog ("Choose …" first, nothing preselected). The
 * full address picks the district / zone / area it names (GET /catalog/place, after a pause or on leaving the field);
 * they can still be changed.
 */
function PlaceFields({
  prefix,
  catalog,
  place,
  set,
  errors,
  field,
  streetLabel,
  streetPlaceholder,
  labels,
  required,
  streetRequired = required,
  streetFull,
}: {
  prefix: string;
  catalog: Catalog | undefined;
  place: Place;
  set: React.Dispatch<React.SetStateAction<Place>>;
  errors: Record<string, string>;
  field: (id: string, label: string, control: React.ReactNode, o?: { full?: boolean; req?: boolean; hint?: React.ReactNode }) => React.ReactNode;
  streetLabel: string;
  streetPlaceholder: string;
  labels: [string, string, string];
  required: boolean;
  streetRequired?: boolean;
  streetFull?: boolean;
}) {
  const id = (k: string) => (prefix ? `${prefix}${k[0].toUpperCase()}${k.slice(1)}` : k);
  const zones = catalog?.zonesByDistrict?.[place.district] ?? [];
  const areas = catalog?.areasByZone?.[place.zone] ?? [];
  const read = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const placeRef = useRef(place);
  placeRef.current = place;
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
    if (!found || placeRef.current.street.trim() !== text) return; // typed on meanwhile: the next pause reads again
    // Picked level by level; a place not offered here (e.g. inactive) stops at its parent.
    const next = { ...placeRef.current };
    if (found.district && catalog.districts.includes(found.district)) {
      if (next.district !== found.district) Object.assign(next, { district: found.district, zone: "", area: "" });
      if (found.zone && (catalog.zonesByDistrict[found.district] ?? []).includes(found.zone)) {
        if (next.zone !== found.zone) Object.assign(next, { zone: found.zone, area: "" });
        if (found.area && (catalog.areasByZone[found.zone] ?? []).includes(found.area)) next.area = found.area;
      }
      set(next);
    }
  }
  useEffect(() => () => clearTimeout(timer.current), []);
  const opts = (list: string[]) => list.map(v => ({ value: v, label: v }));
  return (
    <>
      {field(
        id("street"),
        streetLabel,
        <input
          id={`bk_${id("street")}`}
          className="input"
          maxLength={200}
          placeholder={streetPlaceholder}
          value={place.street}
          aria-invalid={errors[id("street")] ? true : undefined}
          onChange={e => {
            const v = e.target.value;
            set(p => ({ ...p, street: v }));
            clearTimeout(timer.current);
            timer.current = setTimeout(() => void detect(v), 900);
          }}
          onBlur={e => (clearTimeout(timer.current), void detect(e.target.value))}
        />,
        { full: streetFull, req: streetRequired },
      )}
      {field(
        id("district"),
        labels[0],
        <SearchSelect id={`bk_${id("district")}`} label="districts" value={place.district} onChange={v => set(p => ({ ...p, district: v, zone: "", area: "" }))} placeholder={catalog ? "Choose district" : "Loading…"} invalid={!!errors[id("district")]} options={opts(catalog?.districts ?? [])} />,
        { req: required },
      )}
      {field(
        id("zone"),
        labels[1],
        <SearchSelect id={`bk_${id("zone")}`} label="zones" value={place.zone} onChange={v => set(p => ({ ...p, zone: v, area: "" }))} placeholder={place.district ? "Choose zone" : "Choose the district first"} disabled={!place.district} invalid={!!errors[id("zone")]} options={opts(zones)} />,
        { req: required },
      )}
      {field(
        id("area"),
        labels[2],
        <SearchSelect
          id={`bk_${id("area")}`}
          label="areas"
          value={place.area}
          onChange={v => set(p => ({ ...p, area: v }))}
          placeholder={place.zone ? (areas.length ? "Choose area (optional)" : "No areas listed") : "Choose the zone first"}
          disabled={!place.zone || !areas.length}
          emptyLabel={areas.length ? "No area" : undefined}
          options={opts(areas)}
        />,
      )}
    </>
  );
}
