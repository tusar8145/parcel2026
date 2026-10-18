"use client";

import { useEffect, useMemo, useState } from "react";
import { Field, api, describe, tk, useAction, useToast, type Me } from "./ui";

interface Catalog {
  districts: string[];
  zonesByDistrict: Record<string, string[]>;
  areasByZone: Record<string, string[]>;
  customerPackage?: { options: { speeds: string[] }; labels: { speed: Record<string, string> } };
}
interface Quote {
  lines: { label: string; amount: number }[];
  totalCharge: number;
  tierLabel: string;
}
interface Booked {
  trackingId: string;
  recipient: string;
  destination: string;
  paidAtCounter: number;
  codAmount: number;
}

const EMPTY = {
  senderName: "",
  senderPhone: "",
  recipientName: "",
  recipientPhone: "",
  district: "",
  zone: "",
  area: "",
  street: "",
  category: "HOME",
  weightKg: "1",
  codAmount: "0",
  speed: "REGULAR",
  contents: "",
};
type Form = typeof EMPTY;

const phoneOk = (v: string) => /^(?:\+?880|0)?1[3-9]\d{8}$/.test(v.replace(/[\s-]/g, ""));

/** Walk-in at the counter: website customer prices, paid in cash at the counter; the parcel is received at once. */
export default function WalkIn({ me }: { me: Me }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState("");
  const [booked, setBooked] = useState<Booked | null>(null);

  useEffect(() => {
    void api<Catalog>("/catalog").then(setCatalog, e => toast(describe(e), true));
  }, [toast]);

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const value = e.target.value;
    setForm(f => ({ ...f, [k]: value, ...(k === "district" ? { zone: "", area: "" } : k === "zone" ? { area: "" } : {}) }));
    setErrors(x => ({ ...x, [k]: undefined }));
  };
  const zones = useMemo(() => (form.district ? (catalog?.zonesByDistrict[form.district] ?? []) : []), [catalog, form.district]);
  const areas = useMemo(() => (form.zone ? (catalog?.areasByZone[form.zone] ?? []) : []), [catalog, form.zone]);
  const speeds = catalog?.customerPackage?.options.speeds ?? ["REGULAR"];
  const speedLabel = (s: string) => catalog?.customerPackage?.labels.speed[s] ?? s;

  // The price, as the counter charges it (debounced while typing).
  useEffect(() => {
    if (!form.district || !form.zone || !(Number(form.weightKg) > 0)) return void setQuote(null);
    const timer = setTimeout(() => {
      api<Quote>("/franchise/walk-in/quote", {
        method: "POST",
        body: { deliveryDistrict: form.district, deliveryZone: form.zone, deliveryArea: form.area || undefined, weightKg: Number(form.weightKg), codAmount: Number(form.codAmount) || 0, speed: form.speed },
      }).then(
        q => (setQuote(q), setQuoteError("")),
        e => (setQuote(null), setQuoteError(describe(e))),
      );
    }, 350);
    return () => clearTimeout(timer);
  }, [form.district, form.zone, form.area, form.weightKg, form.codAmount, form.speed]);

  const validate = () => {
    const e: Partial<Record<keyof Form, string>> = {};
    if (form.senderName.trim().length < 2) e.senderName = "Enter the sender's name";
    if (!phoneOk(form.senderPhone)) e.senderPhone = "Enter a valid mobile number";
    if (form.recipientName.trim().length < 2) e.recipientName = "Enter the recipient's name";
    if (!phoneOk(form.recipientPhone)) e.recipientPhone = "Enter a valid mobile number";
    if (!form.district) e.district = "Choose the district";
    if (!form.zone) e.zone = "Choose the area (thana)";
    if (form.street.trim().length < 3) e.street = "Enter the street address";
    if (!(Number(form.weightKg) > 0) || Number(form.weightKg) > 50) e.weightKg = "0.1 to 50 kg";
    if (Number(form.codAmount) < 0) e.codAmount = "Can't be negative";
    setErrors(e);
    return !Object.keys(e).length;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    const result = await run(
      "book",
      () =>
        api<Booked>("/franchise/walk-in", {
          method: "POST",
          body: {
            sender: { name: form.senderName.trim(), phone: form.senderPhone.trim() },
            recipient: { name: form.recipientName.trim(), phone: form.recipientPhone.trim() },
            delivery: { category: form.category, street: form.street.trim(), district: form.district, zone: form.zone, area: form.area || undefined },
            weightKg: Number(form.weightKg),
            codAmount: Number(form.codAmount) || 0,
            speed: form.speed,
            contents: form.contents.trim() || undefined,
            serviceLevel: "Regular",
            saveAddresses: false,
          },
        }),
      b => `${b.trackingId} booked. Collect ${tk(b.paidAtCounter)} from the sender.`,
    );
    if (result) setBooked(result);
  };

  const print = (path: string, title: string) => void window.DFPrint?.open(path, { title });

  if (booked)
    return (
      <>
        <div className="fr-heading">
          <div>
            <p className="fr-eyebrow">{me.hub.name}</p>
            <h1>Walk-in booked</h1>
            <p>The parcel is at your hub. Print the label and the receipt.</p>
          </div>
        </div>
        <section className="fr-card" id="frBooked">
          <div className="fr-rows">
            <div className="fr-row">
              <span>Tracking number</span>
              <b id="frBookedId">{booked.trackingId}</b>
            </div>
            <div className="fr-row">
              <span>To</span>
              <b>{`${booked.recipient} · ${booked.destination}`}</b>
            </div>
            <div className="fr-row">
              <span>Collect from the sender now</span>
              <b id="frBookedPaid">{tk(booked.paidAtCounter)}</b>
            </div>
            {booked.codAmount ? (
              <div className="fr-row">
                <span>Cash to collect from the recipient</span>
                <b>{tk(booked.codAmount)}</b>
              </div>
            ) : null}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 16 }}>
            <button type="button" className="fr-btn" onClick={() => print(`/documents/labels?ids=${booked.trackingId}&format=thermal`, "Preparing the label…")}>
              Print label
            </button>
            <button type="button" className="fr-btn" onClick={() => print(`/documents/invoices?ids=${booked.trackingId}&layout=pos`, "Preparing the receipt…")}>
              Print receipt
            </button>
            <button type="button" className="fr-btn primary" id="frNewWalkIn" onClick={() => (setBooked(null), setForm(EMPTY), setQuote(null))}>
              New walk-in
            </button>
          </div>
        </section>
      </>
    );

  return (
    <>
      <div className="fr-heading">
        <div>
          <p className="fr-eyebrow">{me.hub.name}</p>
          <h1>Walk-in booking</h1>
          <p>A customer brings a parcel to your counter. Prices are Delivery Fast&apos;s website prices; the customer pays you now.</p>
        </div>
      </div>
      <form className="fr-split" onSubmit={submit} noValidate id="frWalkInForm">
        <section className="fr-card">
          <div className="fr-form">
            <p className="fr-section-title">Sender</p>
            <Field label="Name" htmlFor="wiSenderName" error={errors.senderName}>
              <input id="wiSenderName" value={form.senderName} onChange={set("senderName")} autoComplete="off" />
            </Field>
            <Field label="Mobile" htmlFor="wiSenderPhone" error={errors.senderPhone}>
              <input id="wiSenderPhone" value={form.senderPhone} onChange={set("senderPhone")} inputMode="tel" placeholder="01XXXXXXXXX" autoComplete="off" />
            </Field>
            <p className="fr-section-title">Recipient</p>
            <Field label="Name" htmlFor="wiRecipientName" error={errors.recipientName}>
              <input id="wiRecipientName" value={form.recipientName} onChange={set("recipientName")} autoComplete="off" />
            </Field>
            <Field label="Mobile" htmlFor="wiRecipientPhone" error={errors.recipientPhone}>
              <input id="wiRecipientPhone" value={form.recipientPhone} onChange={set("recipientPhone")} inputMode="tel" placeholder="01XXXXXXXXX" autoComplete="off" />
            </Field>
            <Field label="District" htmlFor="wiDistrict" error={errors.district}>
              <select id="wiDistrict" value={form.district} onChange={set("district")}>
                <option value="">Choose</option>
                {(catalog?.districts ?? []).map(d => (
                  <option key={d}>{d}</option>
                ))}
              </select>
            </Field>
            <Field label="Area (thana)" htmlFor="wiZone" error={errors.zone}>
              <select id="wiZone" value={form.zone} onChange={set("zone")} disabled={!zones.length}>
                <option value="">Choose</option>
                {zones.map(z => (
                  <option key={z}>{z}</option>
                ))}
              </select>
            </Field>
            <Field label="Locality (optional)" htmlFor="wiArea">
              <select id="wiArea" value={form.area} onChange={set("area")} disabled={!areas.length}>
                <option value="">—</option>
                {areas.map(a => (
                  <option key={a}>{a}</option>
                ))}
              </select>
            </Field>
            <Field label="Address type" htmlFor="wiCategory">
              <select id="wiCategory" value={form.category} onChange={set("category")}>
                <option value="HOME">Home</option>
                <option value="OFFICE">Office</option>
                <option value="OTHER">Other</option>
              </select>
            </Field>
            <Field label="Street address" htmlFor="wiStreet" error={errors.street} full>
              <input id="wiStreet" value={form.street} onChange={set("street")} placeholder="House, road, flat" autoComplete="off" />
            </Field>
            <p className="fr-section-title">Parcel</p>
            <Field label="Weight (kg)" htmlFor="wiWeight" error={errors.weightKg}>
              <input id="wiWeight" type="number" min="0.1" max="50" step="0.1" value={form.weightKg} onChange={set("weightKg")} />
            </Field>
            <Field label="Cash to collect from recipient (৳)" htmlFor="wiCod" error={errors.codAmount}>
              <input id="wiCod" type="number" min="0" step="1" value={form.codAmount} onChange={set("codAmount")} />
            </Field>
            <Field label="Service" htmlFor="wiSpeed">
              <select id="wiSpeed" value={form.speed} onChange={set("speed")}>
                {speeds.map(s => (
                  <option key={s} value={s}>
                    {speedLabel(s)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="What's inside (optional)" htmlFor="wiContents">
              <input id="wiContents" value={form.contents} onChange={set("contents")} autoComplete="off" />
            </Field>
          </div>
        </section>
        <section className="fr-card fr-sticky">
          <div className="fr-card-head">
            <div>
              <h2>Price</h2>
              <p>From your hub, handed over at the counter.</p>
            </div>
          </div>
          {quote ? (
            <div className="fr-quote" id="frQuote">
              {quote.lines.map(l => (
                <div className="line" key={l.label}>
                  <span>{l.label}</span>
                  <span>{tk(l.amount)}</span>
                </div>
              ))}
              <div className="total">
                <span>Collect now</span>
                <span id="frQuoteTotal">{tk(quote.totalCharge)}</span>
              </div>
            </div>
          ) : (
            <p className="fr-hint">{quoteError || "Choose the destination and weight to see the price."}</p>
          )}
          <button type="submit" className="fr-btn primary" id="frBook" style={{ width: "100%", marginTop: 14, height: 42 }} disabled={busy === "book"}>
            {busy === "book" ? "Booking…" : "Book and receive"}
          </button>
        </section>
      </form>
    </>
  );
}
