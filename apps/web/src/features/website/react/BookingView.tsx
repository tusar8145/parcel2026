"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { df, describe, site, toast } from "./df";
import { AddressFields, addressBody, catalog, type AddressNames } from "./AddressFields";
import { PasteMessage, type MessageFields } from "./PasteMessage";
import { Field, FieldError, PhoneInput, Select, TextInput, cooldownFrom, e164, rules, useBusy, useCountdown, useForm, local10 } from "./form";
import { addressText } from "@/shared/addressText";

const PICKUP: AddressNames = {
  category: "requestPickupCategory",
  district: "requestPickupDistrict",
  zone: "requestPickupZone",
  street: "requestPickup",
  lat: "requestPickupLat",
  lng: "requestPickupLng",
  search: "requestPickupSearch",
};
const DELIVERY: AddressNames = {
  category: "requestDeliveryCategory",
  district: "requestDistrict",
  zone: "requestZone",
  area: "requestArea",
  street: "requestDelivery",
  lat: "requestDeliveryLat",
  lng: "requestDeliveryLng",
  search: "requestDeliverySearch",
};

interface Slot {
  start: string;
  end: string;
  label: string;
  available: boolean;
  remaining: number | null;
}
interface SlotDay {
  date: string;
  label: string;
  closed: boolean;
  slots: Slot[];
}
interface Quote {
  lines?: { code: string; label: string; amount: number }[];
  /** Hub Pickup: the hub the receiver collects from (chosen, or the one serving their zone). */
  collectHub?: { id: string; name: string; address?: string | null } | null;
  baseCharge: number;
  weightCharge: number;
  serviceCharge: number;
  codFee: number;
  codFeePercent: number;
  discount: number;
  totalCharge: number;
}
interface SavedAddress {
  id: string;
  role: "PICKUP" | "RECEIVER";
  category: "HOME" | "OFFICE" | "OTHER";
  contactName: string;
  phone: string;
  street: string;
  area: string | null;
  zone: string;
  district: string;
  lat: number | null;
  lng: number | null;
  isDefault: boolean;
}

const CATEGORY_LABEL = { HOME: "Home", OFFICE: "Office", OTHER: "Other" } as const;
const WEIGHT_LABEL = (kg: number) => `${kg} kg`;
/** Product types in the spec's order: Regular, Document, Books. */
const TYPE_ORDER: Record<string, number> = { REGULAR: 0, DOCUMENT: 1, BOOKS: 2 };

const STEP_FIELDS = [
  ["requestName", "requestPhone", PICKUP.district, PICKUP.zone, PICKUP.street, "requestSlot"],
  ["requestReceiver", "requestReceiverPhone", DELIVERY.district, DELIVERY.zone, DELIVERY.street],
  ["requestServiceLevel", "requestWeight", "requestCodAmount", "requestDropHub"],
] as const;

/** API detail paths → form fields, so server messages appear under the right field. */
const PATHS = {
  "sender.name": "requestName",
  "sender.phone": "requestPhone",
  "pickup.street": PICKUP.street,
  "pickup.zone": PICKUP.zone,
  "pickup.district": PICKUP.district,
  "recipient.name": "requestReceiver",
  "recipient.phone": "requestReceiverPhone",
  "delivery.street": DELIVERY.street,
  "delivery.zone": DELIVERY.zone,
  "delivery.district": DELIVERY.district,
  "delivery.area": DELIVERY.area!,
  weightKg: "requestWeight",
  serviceLevel: "requestServiceLevel",
  speed: "requestServiceLevel",
  codAmount: "requestCodAmount",
  collectHubId: "requestCollectHub",
  dropHubId: "requestDropHub",
  product: "requestProduct",
  pickupWindow: "requestSlot",
  "pickupWindow.start": "requestSlot",
  "pickupWindow.end": "requestSlot",
} as const;

/**
 * Pickup request wizard: sender & pickup (with a pickup time), recipient & delivery,
 * parcel & service with the server's price, then booking — signed in, or as a guest after
 * verifying the sender's phone by SMS.
 */
export default function BookingView() {
  const user = df().auth.user;
  const isCustomer = df().auth.isWebsiteCustomer();
  const cat = catalog();
  // The website customer package (service packages): its services, first / last mile choices and messages.
  const pkg = cat.customerPackage;
  // The package's services only (no "Same day": Express is the same-day service).
  const services: [string, string][] = pkg ? pkg.options.speeds.map(s => [s, pkg.labels.speed[s] ?? s]) : [["REGULAR", "Regular"]];
  const [unticked, setUnticked] = useState<string[]>([]);
  const [step, setStep] = useState(0);
  const [days, setDays] = useState<SlotDay[] | null>(null);
  const [day, setDay] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [saved, setSaved] = useState<SavedAddress[]>([]);
  const [guest, setGuest] = useState<{ stage: "phone" | "code"; hint?: string } | null>(null);
  const idempotencyKey = useRef("");
  const { busy, run } = useBusy();
  const countdown = useCountdown();

  const form = useForm(
    {
      requestName: isCustomer && user ? user.name : "",
      requestPhone: isCustomer && user ? local10(user.phone) : "",
      requestPickupCategory: "Home",
      requestPickupDistrict: "",
      requestPickupZone: "",
      requestPickup: "",
      requestPickupLat: "",
      requestPickupLng: "",
      requestPickupSearch: "",
      requestSlot: "",
      requestReceiver: "",
      requestReceiverPhone: "",
      requestDeliveryCategory: "Home",
      requestDistrict: "",
      requestZone: "",
      requestArea: "",
      requestDelivery: "",
      requestDeliveryLat: "",
      requestDeliveryLng: "",
      requestDeliverySearch: "",
      requestServiceLevel: services[0]?.[0] ?? "REGULAR",
      requestWeight: "0.5",
      requestProduct: "",
      requestFirstMile: pkg?.options.defaultFirstMile ?? "RIDER_PICKUP",
      requestDropHub: "",
      requestLastMile: pkg?.options.defaultLastMile ?? "DOORSTEP",
      requestCollectHub: "",
      // Cash on delivery is ticked by default (the sender unticks it for prepaid parcels).
      requestCodEnabled: "1",
      requestCodAmount: "",
      requestInstructions: "",
      guestCode: "",
    },
    {
      requestName: rules.length(1, 120, "Your name"),
      requestPhone: rules.phone,
      requestPickupDistrict: rules.required("Choose the pickup district"),
      requestPickupZone: rules.required("Choose the pickup zone"),
      requestPickup: rules.length(1, 200, "Pickup address"),
      requestSlot: (v, all) => (all.requestFirstMile !== "HUB_DROP" && days && days.some(d => d.slots.some(s => s.available)) && !v ? "Choose a pickup time" : ""),
      requestDropHub: (v, all) => (all.requestFirstMile === "HUB_DROP" && !v ? "Choose the hub you bring the parcel to" : ""),
      requestReceiver: rules.length(1, 120, "Receiver's name"),
      requestReceiverPhone: rules.phone,
      requestDistrict: rules.required("Choose the delivery district"),
      requestZone: rules.required("Choose the delivery zone"),
      requestDelivery: rules.length(1, 200, "Delivery address"),
      requestWeight: v => (!v.trim() ? "Enter the weight" : !(Number(v) >= 0.01) ? "At least 0.01 kg" : Number(v) > 50 ? "At most 50 kg" : ""),
      requestCodAmount: (v, all) =>
        all.requestCodEnabled !== "1" ? "" : !v.trim() ? "Enter the amount to collect" : !(Number(v) >= 1) ? "Enter an amount of at least ৳1" : Number(v) > 1_000_000 ? "The amount is too large" : "",
      requestInstructions: rules.optionalMax(500),
      guestCode: v => (guest?.stage === "code" ? rules.otp(v) : ""),
    },
  );
  const v = form.values;
  // A product with "Send SMS & email" off: no parcel messages (the API stores an empty list).
  const productSilent = !!v.requestProduct && !!cat.productsWithoutMessages?.includes(v.requestProduct);

  // Pickup slots for the chosen district (capacity is per district).
  useEffect(() => {
    let live = true;
    const district = v.requestPickupDistrict;
    df()
      .api<{ days: SlotDay[] }>(`/pickup-slots${district ? `?district=${encodeURIComponent(district)}` : ""}`)
      .then(r => {
        if (!live) return;
        setDays(r.days);
        const firstOpen = r.days.find(d => d.slots.some(s => s.available));
        setDay(d => (d && r.days.some(x => x.date === d && x.slots.some(s => s.available)) ? d : (firstOpen?.date ?? "")));
        form.setValues(cur => {
          const still = r.days.some(d => d.slots.some(s => s.available && `${s.start}|${s.end}` === cur.requestSlot));
          if (still) return cur;
          const first = firstOpen?.slots.find(s => s.available);
          return { ...cur, requestSlot: first ? `${first.start}|${first.end}` : "" };
        });
      })
      .catch(() => live && setDays([]));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.requestPickupDistrict]);

  // Saved addresses (signed-in customers).
  useEffect(() => {
    if (!isCustomer) return;
    df()
      .api<SavedAddress[]>("/me/addresses")
      .then(list => {
        setSaved(list);
        const home = list.find(a => a.role === "PICKUP" && a.isDefault);
        if (home) applySaved(home, "PICKUP");
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCustomer]);

  // The server's price for the current choices.
  const quoteKey = [v.requestPickupDistrict, v.requestPickupZone, v.requestDistrict, v.requestZone, v.requestWeight, v.requestServiceLevel, v.requestCodEnabled === "1" ? v.requestCodAmount : "0", v.requestFirstMile, v.requestDropHub, v.requestLastMile, v.requestCollectHub, v.requestProduct].join("|");
  useEffect(() => {
    if (!v.requestPickupDistrict || !v.requestDistrict) return setQuote(null);
    let live = true;
    const timer = setTimeout(() => {
      df()
        .api<Quote>("/pricing/quote", {
          method: "POST",
          body: {
            pickupDistrict: v.requestPickupDistrict,
            pickupZone: v.requestPickupZone,
            deliveryDistrict: v.requestDistrict,
            deliveryZone: v.requestZone,
            weightKg: Number(v.requestWeight) || 0.5,
            ...(pkg ? { speed: v.requestServiceLevel } : { serviceLevel: v.requestServiceLevel }),
            codAmount: v.requestCodEnabled === "1" ? Number(v.requestCodAmount) || 0 : 0,
            ...packageChoices(),
          },
        })
        .then(q => live && setQuote(q))
        .catch(err => {
          if (!live) return;
          setQuote(null);
          // A choice the package refuses (e.g. Express outside the same district) shows under the service.
          if ((err as { status?: number }).status === 422) form.setServerErrors({ requestServiceLevel: describe(err) });
        });
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quoteKey]);

  function applySaved(a: SavedAddress, role: "PICKUP" | "RECEIVER") {
    const names = role === "PICKUP" ? PICKUP : DELIVERY;
    form.setValues(cur => ({
      ...cur,
      ...(role === "PICKUP" ? { requestName: a.contactName, requestPhone: local10(a.phone) } : { requestReceiver: a.contactName, requestReceiverPhone: local10(a.phone) }),
      [names.category]: CATEGORY_LABEL[a.category],
      [names.district]: a.district,
      [names.zone]: a.zone,
      ...(names.area ? { [names.area]: a.area ?? "" } : {}),
      [names.street]: a.street,
      [names.lat]: a.lat != null ? String(a.lat) : "",
      [names.lng]: a.lng != null ? String(a.lng) : "",
    }));
  }

  const next = () => {
    if (!form.validate([...STEP_FIELDS[step]] as (keyof typeof v)[])) return toast("Please complete all required details before continuing.");
    setStep(s => Math.min(2, s + 1));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  /** First / last mile, hubs and the product (service packages). */
  function packageChoices() {
    if (!pkg) return {};
    return {
      firstMile: v.requestFirstMile,
      ...(v.requestFirstMile === "HUB_DROP" && v.requestDropHub ? { dropHubId: v.requestDropHub } : {}),
      lastMile: v.requestLastMile,
      ...(v.requestLastMile === "HUB_COLLECT" && v.requestCollectHub ? { collectHubId: v.requestCollectHub } : {}),
      ...(v.requestProduct ? { product: v.requestProduct } : {}),
    };
  }

  const body = () => {
    const [start, end] = v.requestFirstMile === "HUB_DROP" ? [] : v.requestSlot.split("|");
    return {
      sender: { name: v.requestName.trim(), phone: e164(v.requestPhone) },
      pickup: addressBody(v, PICKUP),
      recipient: { name: v.requestReceiver.trim(), phone: e164(v.requestReceiverPhone) },
      delivery: addressBody(v, DELIVERY),
      ...(pkg ? { speed: v.requestServiceLevel } : { serviceLevel: v.requestServiceLevel }),
      weightKg: Number(v.requestWeight) || 0.5,
      contents: v.requestProduct || undefined,
      ...packageChoices(),
      ...(pkg && unticked.length && !productSilent ? { notifications: pkg.notifications.map(n => n.code).filter(code => !unticked.includes(code)) } : {}),
      codAmount: v.requestCodEnabled === "1" ? Number(v.requestCodAmount) || 0 : 0,
      instructions: v.requestInstructions.trim() || undefined,
      ...(start && end ? { pickupWindow: { start, end } } : {}),
    };
  };

  /** Back to the step that holds the first field the server complained about. */
  const showBookingError = (err: unknown) => {
    const { mapped, rest } = form.showServerError(err, PATHS as unknown as Record<string, keyof typeof v>);
    if (mapped) {
      const fields = Object.keys((err as { details?: { path: string }[] }).details ?? {}).length ? (err as { details: { path: string | string[] }[] }).details.map(d => (Array.isArray(d.path) ? d.path.join(".") : d.path)) : [];
      const firstField = fields.map(p => (PATHS as Record<string, string>)[p]).find(Boolean);
      const stepOf = STEP_FIELDS.findIndex(list => (list as readonly string[]).includes(firstField ?? ""));
      if (stepOf >= 0 && stepOf !== step) setStep(stepOf);
    }
    if (!mapped || rest.length) toast(rest.join(" · ") || describe(err));
  };

  const booked = async (trackingId: string, total: number, token?: string) => {
    idempotencyKey.current = "";
    await site()?.refreshAccount();
    df().route.go(`tracking/${encodeURIComponent(trackingId)}${token ? `?t=${encodeURIComponent(token)}` : ""}`);
    toast(`Pickup request submitted · sender delivery charge ৳${total} · Tracking ID: ${trackingId}`);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (step < 2) return next();
    if (!form.validate()) {
      const firstBad = STEP_FIELDS.findIndex(list => list.some(name => form.error(name as keyof typeof v)));
      if (firstBad >= 0 && firstBad < step) setStep(firstBad);
      return;
    }
    idempotencyKey.current ||= `web-${crypto.randomUUID()}`;
    if (isCustomer) {
      void run(async () => {
        try {
          const parcel = await df().api("/parcels", { method: "POST", body: body(), headers: { "idempotency-key": idempotencyKey.current } });
          await booked(parcel.trackingId, parcel.charges.total);
        } catch (err) {
          showBookingError(err);
        }
      });
      return;
    }
    // Guest: verify the sender's phone first.
    if (!guest || guest.stage === "phone") return void sendGuestCode();
    void run(async () => {
      try {
        const { verificationToken } = await df().auth.guestConfirm(e164(v.requestPhone), v.guestCode.trim());
        const result = await df().api("/guest/parcels", { method: "POST", body: { ...body(), verificationToken }, headers: { "idempotency-key": idempotencyKey.current } });
        setGuest(null);
        await booked(result.trackingId, result.parcel.charges?.total ?? quote?.totalCharge ?? 0, result.accessToken);
      } catch (err) {
        const { mapped } = form.showServerError(err, { code: "guestCode", verificationToken: "guestCode", ...(PATHS as unknown as Record<string, keyof typeof v>) });
        if (!mapped) form.setServerErrors({ guestCode: describe(err) });
      }
    });
  };

  const sendGuestCode = () =>
    run(async () => {
      try {
        const result = await df().auth.guestVerification(e164(v.requestPhone));
        setGuest({ stage: "code", hint: result.devCode ? `Development code: ${result.devCode}` : result.message });
        countdown.start(cooldownFrom(result));
      } catch (err) {
        const wait = cooldownFrom(null, err);
        if (wait) countdown.start(wait);
        setGuest(g => g ?? { stage: "phone" });
        const { mapped } = form.showServerError(err, { phone: "requestPhone" });
        if (!mapped) toast(describe(err));
      }
    });

  const slotsOfDay = days?.find(d => d.date === day)?.slots ?? [];
  const chosenSlot = days?.flatMap(d => d.slots.map(s => ({ ...s, day: d.label }))).find(s => `${s.start}|${s.end}` === v.requestSlot);
  const pickupSaved = saved.filter(a => a.role === "PICKUP");
  const receiverSaved = saved.filter(a => a.role === "RECEIVER");
  const serviceLabel = services.find(([code]) => code === v.requestServiceLevel)?.[1] ?? v.requestServiceLevel;
  // Products of the Customer & E-commerce list with their type ("Fashion & Apparel · Regular").
  const productOptions = useMemo<[string, string][]>(
    () => [["", "No product (Regular)"], ...(pkg?.products ? [...pkg.products].sort((a, b) => (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9) || a.name.localeCompare(b.name)).map(p => [p.name, `${p.name} · ${pkg.labels.productType?.[p.type] ?? p.type}`] as [string, string]) : cat.products.map(p => [p, p] as [string, string]))],
    [pkg, cat.products],
  );

  /** A pasted message (PasteMessage): what it has goes into the empty fields — the receiver and the delivery address, the sender, the amount. */
  const fillFromMessage = (f: MessageFields) => {
    const filled: string[] = [];
    const next: Record<string, string> = {};
    const put = (key: keyof typeof v, value: string | undefined, label: string, empty = (cur: string) => !cur.trim()) => {
      if (value && empty(String(v[key] ?? ""))) {
        next[key] = value;
        filled.push(label);
      }
    };
    put("requestReceiver", f.recipient_name, "receiver's name");
    put("requestReceiverPhone", f.recipient_phone && local10(f.recipient_phone), "receiver's phone");
    put("requestDelivery", f.address, "delivery address");
    // The place found in the message (its district / zone / area also follow the address as it is set).
    if (f.district && !v.requestDistrict && catalog().districts.includes(f.district)) {
      next.requestDistrict = f.district;
      if (f.zone && (catalog().zonesByDistrict[f.district] ?? []).includes(f.zone)) next.requestZone = f.zone;
      if (f.zone && f.area && (catalog().areasByZone[f.zone] ?? []).includes(f.area)) next.requestArea = f.area;
      filled.push("delivery district / zone");
    }
    put("requestName", f.sender_name, "your name");
    put("requestPhone", f.sender_phone && local10(f.sender_phone), "your phone");
    if (f.cod_amount && Number(f.cod_amount) > 0 && !v.requestCodAmount) {
      Object.assign(next, { requestCodEnabled: "1", requestCodAmount: String(Number(f.cod_amount)) });
      filled.push(`cash to collect ৳${Number(f.cod_amount).toLocaleString("en-US")}`);
    }
    put("requestWeight", f.weight_kg, "weight", cur => !cur.trim() || cur === "0.5");
    put("requestInstructions", f.instructions, "note");
    if (filled.length) form.setValues(c => ({ ...c, ...next }));
    return filled;
  };

  return (
    <form ref={form.formRef} id="requestForm" className="route-card route-form" data-form="request" data-react="1" noValidate onSubmit={submit}>
      <PasteMessage onFill={fillFromMessage} />
      <div className="route-stepper" aria-label="Pickup request steps">
        {[0, 1, 2].map(i => (
          <span key={i} style={{ display: "contents" }}>
            {i > 0 ? <span className="step-line" /> : null}
            <span className={i === step ? "step-pill active" : "step-pill"}>{String(i + 1)}</span>
          </span>
        ))}
      </div>

      <div className={step === 0 ? "route-step active" : "route-step"} data-request-step="0">
        <h2 className="field full">Pickup details</h2>
        {pickupSaved.length ? (
          <div className="field full">
            <label htmlFor="requestPickupSaved">Choose a saved pickup address</label>
            <select id="requestPickupSaved" defaultValue="" onChange={e => e.target.value && applySaved(pickupSaved.find(a => a.id === e.target.value)!, "PICKUP")}>
              <option value="">Enter a new address</option>
              {pickupSaved.map(a => (
                <option key={a.id} value={a.id}>{`${CATEGORY_LABEL[a.category]} · ${addressText(a.street, a.area, a.zone, a.district)}`}</option>
              ))}
            </select>
          </div>
        ) : null}
        <Field label="Your name" required htmlFor="requestName" error={form.error("requestName")}>
          <TextInput bound={form.bind("requestName")} error={form.error("requestName")} placeholder="Full name" autoComplete="name" />
        </Field>
        <Field label="Phone number" required htmlFor="requestPhone" error={form.error("requestPhone")} hint={!isCustomer ? "We'll text a code to this number to confirm the booking." : undefined}>
          <PhoneInput bound={form.bind("requestPhone")} error={form.error("requestPhone")} />
        </Field>
        <AddressFields form={form} names={PICKUP} label="Pickup" streetLabel="Pickup full address" />
        <div className="field full" data-pickup-slots="1">
          <span className="field-label">Pickup time *</span>
          {days === null ? (
            <small className="field-hint">Loading pickup times…</small>
          ) : !days.some(d => d.slots.some(s => s.available)) ? (
            <small className="field-hint">No pickup times are open online right now. Operations will call you to arrange the pickup.</small>
          ) : (
            <>
              <div className="address-category-options" role="radiogroup" aria-label="Pickup day" style={{ flexWrap: "wrap" }}>
                {days.map(d => (
                  <label className="address-category-option" key={d.date} style={d.closed || !d.slots.some(s => s.available) ? { opacity: 0.45 } : undefined}>
                    <input type="radio" name="requestPickupDay" value={d.date} checked={day === d.date} disabled={d.closed || !d.slots.some(s => s.available)} onChange={() => setDay(d.date)} />
                    {d.label}
                  </label>
                ))}
              </div>
              <div className="address-category-options" role="radiogroup" aria-label="Pickup time" style={{ flexWrap: "wrap", marginTop: 8 }}>
                {slotsOfDay.map(s => (
                  <label className="address-category-option" key={s.start} style={!s.available ? { opacity: 0.45 } : undefined} title={!s.available ? "Fully booked or too soon" : undefined}>
                    <input
                      id={`requestSlot-${s.start}`}
                      type="radio"
                      name="requestSlot"
                      value={`${s.start}|${s.end}`}
                      checked={v.requestSlot === `${s.start}|${s.end}`}
                      disabled={!s.available}
                      onChange={() => form.set("requestSlot", `${s.start}|${s.end}`)}
                    />
                    {s.label}
                    {s.remaining !== null && s.available ? ` · ${s.remaining} left` : ""}
                  </label>
                ))}
              </div>
            </>
          )}
          <input id="requestSlot" type="hidden" value={v.requestSlot} readOnly />
          <FieldError id="requestSlot" message={form.error("requestSlot")} />
        </div>
      </div>

      <div className={step === 1 ? "route-step active" : "route-step"} data-request-step="1">
        <h2 className="field full">Delivery details</h2>
        {receiverSaved.length ? (
          <div className="field full">
            <label htmlFor="requestReceiverSaved">Saved delivery addresses</label>
            <select id="requestReceiverSaved" defaultValue="" onChange={e => e.target.value && applySaved(receiverSaved.find(a => a.id === e.target.value)!, "RECEIVER")}>
              <option value="">Enter a new address</option>
              {receiverSaved.map(a => (
                <option key={a.id} value={a.id}>{`${a.contactName} · ${addressText(a.street, a.area, a.zone, a.district)}`}</option>
              ))}
            </select>
          </div>
        ) : null}
        <Field label="Receiver's name" required htmlFor="requestReceiver" error={form.error("requestReceiver")}>
          <TextInput bound={form.bind("requestReceiver")} error={form.error("requestReceiver")} placeholder="Full name" />
        </Field>
        <Field label="Receiver's phone" required htmlFor="requestReceiverPhone" error={form.error("requestReceiverPhone")}>
          <PhoneInput bound={form.bind("requestReceiverPhone")} error={form.error("requestReceiverPhone")} />
        </Field>
        <AddressFields form={form} names={DELIVERY} label="Delivery" streetLabel="Delivery full address" />
      </div>

      <div className={step === 2 ? "route-step active" : "route-step"} data-request-step="2">
        <h2 className="field full">Parcel and service</h2>
        <div className="field">
          <label htmlFor="requestProduct">Product (optional)</label>
          <Select bound={form.bind("requestProduct")} options={productOptions} />
        </div>
        <div className="field">
          <label htmlFor="requestWeight">Weight (kg) *</label>
          <TextInput bound={form.bind("requestWeight")} error={form.error("requestWeight")} type="number" min="0.01" max="50" step="0.1" inputMode="decimal" placeholder="0.5" />
          <FieldError id="requestWeight" message={form.error("requestWeight")} />
        </div>
        <div className="field">
          <label htmlFor="requestServiceLevel">Service *</label>
          <Select bound={form.bind("requestServiceLevel")} options={services} />
        </div>
        {pkg && pkg.options.firstMiles.length > 1 ? (
          <div className="field">
            <label htmlFor="requestFirstMile">How the parcel reaches us</label>
            <Select bound={form.bind("requestFirstMile")} options={pkg.options.firstMiles.map(f => [f, pkg.labels.firstMile[f] ?? f] as [string, string])} />
          </div>
        ) : null}
        {pkg && v.requestFirstMile === "HUB_DROP" ? (
          <div className="field">
            <label htmlFor="requestDropHub">Drop-off hub *</label>
            <Select bound={form.bind("requestDropHub")} error={form.error("requestDropHub")} options={[["", "Choose the hub"] as [string, string], ...pkg.dropHubs.map(h => [h.id, h.type === "FRANCHISE" ? `${h.name} · Franchise` : h.name] as [string, string])]} />
            <FieldError id="requestDropHub" message={form.error("requestDropHub")} />
          </div>
        ) : null}
        {pkg && pkg.options.lastMiles.length > 1 ? (
          <div className="field">
            <label htmlFor="requestLastMile">Delivery</label>
            <Select bound={form.bind("requestLastMile")} options={pkg.options.lastMiles.map(l => [l, pkg.labels.lastMile[l] ?? l] as [string, string])} />
          </div>
        ) : null}
        {pkg && v.requestLastMile === "HUB_COLLECT" ? (
          <div className="field">
            <label>{"Collect from"}</label>
            {/* No choice: the receiver collects at the hub serving their zone (named by the price quote). */}
            <div id="requestCollectHub" style={{ padding: "8px 0", fontWeight: 650, lineHeight: 1.4 }}>
              {quote?.collectHub ? `${quote.collectHub.name}${quote.collectHub.address ? ` · ${quote.collectHub.address}` : ""}` : "The hub serving the receiver's zone (choose the zone)"}
            </div>
            <small className="field-hint">{"The receiver gets an SMS with the hub address and a collection code."}</small>
          </div>
        ) : null}
        <div className="field full">
          <label className="checkline">
            <input id="requestCodEnabled" type="checkbox" checked={v.requestCodEnabled === "1"} onChange={e => form.set("requestCodEnabled", e.target.checked ? "1" : "")} />
            {" Collect cash on delivery from the receiver"}
          </label>
        </div>
        <div className="field" hidden={v.requestCodEnabled !== "1"}>
          <label htmlFor="requestCodAmount">COD amount to collect (৳) *</label>
          <TextInput bound={form.bind("requestCodAmount")} error={form.error("requestCodAmount")} type="number" min="1" step="1" inputMode="numeric" placeholder="Enter collection amount" />
          <FieldError id="requestCodAmount" message={form.error("requestCodAmount")} />
        </div>
        <div className="field full">
          <label htmlFor="requestInstructions">Notes for the rider</label>
          <TextInput bound={form.bind("requestInstructions")} error={form.error("requestInstructions")} placeholder="e.g. Call before arriving, gate code" />
          <FieldError id="requestInstructions" message={form.error("requestInstructions")} />
        </div>
        {pkg && pkg.notifications.length ? (
          <details className="field full" id="requestNotifications" data-messages-off={productSilent ? "" : undefined}>
            <summary style={{ cursor: "pointer", fontWeight: 600 }}>
              {productSilent ? "Messages we send (none: this product doesn't send messages)" : `Messages we send (${pkg.notifications.length - unticked.length} of ${pkg.notifications.length})`}
            </summary>
            {pkg.notifications.map(n => (
              <label className="checkline" key={n.code}>
                <input type="checkbox" disabled={productSilent} checked={!unticked.includes(n.code)} onChange={e => setUnticked(list => (e.target.checked ? list.filter(c => c !== n.code) : [...list, n.code]))} />
                {` ${n.title}`}
              </label>
            ))}
            {productSilent ? <p style={{ margin: "6px 0 0", color: "#8792a2", fontSize: 12 }}>{"This product doesn't send messages"}</p> : null}
          </details>
        ) : null}
        <div className="field full">
          <div className="route-price-preview" id="requestPricePreview" aria-live="polite">
            <strong>Estimated cost breakdown</strong>
            {quote?.lines ? (
              <>
                {quote.lines.map(l => (
                  <div className="cost-row" key={l.code} data-line={l.code}>
                    <span>{l.label}</span>
                    <span>{`${l.amount < 0 ? "− " : ""}৳ ${Math.abs(l.amount)}`}</span>
                  </div>
                ))}
                <div className="cost-row cost-total">
                  <strong>Sender pays for delivery</strong>
                  <strong>{`৳ ${quote.totalCharge}`}</strong>
                </div>
              </>
            ) : quote ? (
              <>
                <div className="cost-row">
                  <span>Delivery by route</span>
                  <span>{`৳ ${quote.baseCharge}`}</span>
                </div>
                <div className="cost-row">
                  <span>Weight charge</span>
                  <span>{`৳ ${quote.weightCharge}`}</span>
                </div>
                <div className="cost-row">
                  <span>Service</span>
                  <span>{`৳ ${quote.serviceCharge}`}</span>
                </div>
                <div className="cost-row">
                  <span>COD collection</span>
                  <span>{v.requestCodEnabled === "1" && Number(v.requestCodAmount) > 0 ? `৳ ${Number(v.requestCodAmount)} from receiver` : "Not selected"}</span>
                </div>
                <div className="cost-row">
                  <span>{`COD fee (${quote.codFeePercent}%)`}</span>
                  <span>{`৳ ${quote.codFee}`}</span>
                </div>
                <div className="cost-row cost-total">
                  <strong>Sender pays for delivery</strong>
                  <strong>{`৳ ${quote.totalCharge}`}</strong>
                </div>
              </>
            ) : (
              <div className="cost-row">
                <span>Choose the pickup and delivery areas to see the price.</span>
              </div>
            )}
          </div>
        </div>
        <div className="field full">
          <h3>Review your request</h3>
          <div className="route-review" id="requestReview">
            <div className="review-item">
              <strong>{"Sender & pickup"}</strong>
              <div>{`${v.requestName || "—"} · ${v.requestPhone ? `+880 ${v.requestPhone}` : "—"}`}</div>
              <div>{`${v.requestPickupCategory}: ${v.requestPickup || "—"}`}</div>
              <div>{`${v.requestPickupZone || "—"}, ${v.requestPickupDistrict || "—"}`}</div>
              <div>{chosenSlot ? `Pickup: ${chosenSlot.day}, ${chosenSlot.label}` : "Pickup time: to be arranged"}</div>
            </div>
            <div className="review-item">
              <strong>{"Receiver & delivery"}</strong>
              <div>{`${v.requestReceiver || "—"} · ${v.requestReceiverPhone ? `+880 ${v.requestReceiverPhone}` : "—"}`}</div>
              <div>{`${v.requestDeliveryCategory}: ${v.requestDelivery || "—"}`}</div>
              <div>{[v.requestArea, v.requestZone, v.requestDistrict].filter(Boolean).join(", ") || "—"}</div>
            </div>
            <div className="review-item">
              <strong>Parcel</strong>
              <div>{`${serviceLabel} · ${WEIGHT_LABEL(Number(v.requestWeight))}`}</div>
              <div>{v.requestProduct || "No product (Regular)"}</div>
              <div>{v.requestCodEnabled === "1" && Number(v.requestCodAmount) > 0 ? `COD to collect: ৳${Number(v.requestCodAmount)}` : "No COD"}</div>
            </div>
            <div className="review-item">
              <strong>Cost breakdown</strong>
              {quote ? (
                <>
                  <div>{`Delivery: ৳${quote.baseCharge}`}</div>
                  <div>{`Weight: ৳${quote.weightCharge} · Service: ৳${quote.serviceCharge}`}</div>
                  <div>{`COD fee: ৳${quote.codFee}`}</div>
                  <div>
                    <strong>{`Sender pays: ৳${quote.totalCharge}`}</strong>
                  </div>
                </>
              ) : (
                <div>—</div>
              )}
            </div>
          </div>
        </div>
        {!isCustomer && guest ? (
          <div className="field full" data-guest-verification="1" style={{ padding: 14, border: "1px solid #dfe8e2", borderRadius: 10, background: "#f8faf8" }}>
            <strong>{"Confirm your phone number"}</strong>
            <p className="route-note" style={{ margin: "4px 0 10px" }}>
              {`Enter the 6-digit code we sent to +880 ${v.requestPhone}. `}
              {user ? "" : "No account needed — you'll get a private tracking link."}
            </p>
            <label htmlFor="guestCode">Verification code *</label>
            <TextInput bound={form.bind("guestCode")} error={form.error("guestCode")} placeholder="6-digit code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus />
            {guest.hint ? <small className="field-hint">{guest.hint}</small> : null}
            <FieldError id="guestCode" message={form.error("guestCode")} />
            <small className="field-hint" style={{ display: "block" }}>
              {countdown.left > 0 ? (
                `You can request a new code in ${countdown.left} s.`
              ) : (
                <a role="button" tabIndex={0} style={{ color: "var(--green)", fontWeight: 700, cursor: "pointer" }} onClick={e => (e.preventDefault(), void sendGuestCode())}>
                  Send a new code
                </a>
              )}
            </small>
          </div>
        ) : null}
      </div>

      <div className="route-actions">
        <span className="route-note">
          {isCustomer ? "Your pickup request needs operations confirmation. You can cancel it while it is still pending." : (
            <>
              {"Booking without an account: we'll confirm your phone by SMS. "}
              <a href="/login" data-route="login" style={{ color: "var(--green)", fontWeight: 700 }}>
                Log in
              </a>
              {" to use saved addresses."}
            </>
          )}
        </span>
        <div className="route-action-buttons">
          <button className="button button-quiet" id="requestBack" type="button" hidden={step === 0} onClick={() => setStep(s => Math.max(0, s - 1))}>
            Back
          </button>
          <button className="button button-primary" id="requestNext" type="button" hidden={step === 2} onClick={next}>
            Continue
          </button>
          <button className="button button-primary" id="requestSubmit" type="submit" hidden={step !== 2} disabled={busy}>
            {busy ? "Please wait…" : isCustomer ? "Submit pickup request" : guest?.stage === "code" ? "Confirm and book" : "Verify phone and book"}
          </button>
        </div>
      </div>
      <div className="route-result" id="routeResult" aria-live="polite" />
    </form>
  );
}
