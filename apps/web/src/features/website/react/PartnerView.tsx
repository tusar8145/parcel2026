"use client";

import { useEffect } from "react";
import { df, describe, site, toast } from "./df";
import { FieldError, PhoneInput, Select, TextInput, e164, rules, useBusy, useForm, local10 } from "./form";

export type PartnerKind = "merchant" | "rider" | "franchise";

const INVITE_KEY = "deliveryfast-merchant-invite";
/** A merchant invitation token from the link (?invite=…), kept while the visitor signs in. */
export function inviteToken(): string | null {
  try {
    const fromUrl = new URLSearchParams(location.search).get("invite");
    if (fromUrl) sessionStorage.setItem(INVITE_KEY, fromUrl);
    return fromUrl || sessionStorage.getItem(INVITE_KEY);
  } catch {
    return null;
  }
}

/** What a signed-out visitor typed, kept while they sign in (same page, so it survives navigation). */
let draft: { kind: PartnerKind; values: Record<string, string> } | null = null;

const MERCHANT_AREAS = ["Dhaka", "Chattogram", "Gazipur", "Narayanganj", "Sylhet", "Other district"];
const RIDER_AREAS = ["Dhaka North", "Dhaka Central", "Dhaka South", "Chattogram", "Other district"];
const VEHICLES: [string, string][] = [
  ["MOTORCYCLE", "Motorcycle"],
  ["BICYCLE", "Bicycle"],
  ["ON_FOOT", "On foot"],
];
const TERRITORIES: [string, string][] = [
  ["CITY_ZONE", "City zone"],
  ["DISTRICT", "District"],
  ["MULTI_DISTRICT_REGION", "Multi-district region"],
];

const initial = {
  merchantAccountType: "E-commerce merchant",
  merchantSector: "",
  partnerName: "",
  partnerContact: "",
  partnerEmail: "",
  partnerPhone: "",
  partnerArea: "",
  partnerDistrict: "",
  partnerPickupAddress: "",
  partnerPickupArea: "",
  riderVehicle: "MOTORCYCLE",
  partnerExperience: "",
  partnerInvestment: "",
};
type Values = typeof initial;

/** Merchant, rider and franchise applications (merchant → super admin review; rider/franchise → support desk). */
export default function PartnerView({ kind }: { kind: PartnerKind }) {
  const isDoc = (v: Values) => v.merchantAccountType === "Document merchant";
  const form = useForm<Values>(initial, {
    merchantSector: (v, all) => (kind === "merchant" && isDoc(all) && !v ? "Choose the institution type" : ""),
    partnerName: rules.length(2, 120, kind === "merchant" ? "Business name" : "Name"),
    partnerContact: v => (kind === "merchant" ? rules.length(2, 120, "Contact person")(v) : ""),
    partnerEmail: rules.optionalEmail,
    partnerPhone: rules.phone,
    partnerArea: v => (kind === "franchise" ? rules.length(2, 120, "Proposed hub location")(v) : v ? "" : "Choose an area"),
    partnerDistrict: (v, all) => (kind === "merchant" && all.partnerArea === "Other district" ? rules.length(2, 80, "District")(v) : ""),
    partnerPickupAddress: v => (kind === "merchant" ? rules.length(5, 300, "Pickup address")(v) : ""),
    partnerPickupArea: v => (kind === "merchant" ? rules.length(2, 80, "Pickup area")(v) : ""),
    partnerExperience: v => (kind === "franchise" && v.trim() && v.trim().length < 2 ? "Use at least 2 characters" : rules.optionalMax(300)(v)),
    partnerInvestment: v => (kind === "franchise" && !v ? "Choose a territory size" : ""),
  });
  const { busy, run } = useBusy();
  const user = df().auth.user;

  // Prefill from the account, or restore what was typed before signing in.
  useEffect(() => {
    if (draft?.kind === kind) {
      const saved = draft.values; // the updater runs later, after draft is cleared
      form.setValues(v => ({ ...v, ...saved }));
      draft = null;
      return;
    }
    if (user)
      // Only empty fields: what the visitor typed (restored above) wins.
      form.setValues(v => {
        const nameField = kind === "merchant" ? "partnerContact" : "partnerName";
        return { ...v, [nameField]: v[nameField] || user.name, partnerPhone: v.partnerPhone || local10(user.phone), partnerEmail: v.partnerEmail || user.email || "" };
      });
    // Invited merchants: prefill from the invitation (POST /merchants/invites/lookup).
    const token = kind === "merchant" ? inviteToken() : null;
    if (token)
      df()
        .api<{ name?: string; businessName?: string; type?: string; phone?: string; email?: string | null }>("/merchants/invites/lookup", { method: "POST", body: { token } })
        .then(invite =>
          form.setValues(v => ({
            ...v,
            merchantAccountType: invite.type === "CORPORATE_DOCUMENT" ? "Document merchant" : v.merchantAccountType,
            partnerName: v.partnerName || invite.businessName || "",
            partnerContact: v.partnerContact || invite.name || "",
            partnerPhone: v.partnerPhone || (invite.phone ? local10(invite.phone) : ""),
            partnerEmail: v.partnerEmail || invite.email || "",
          })),
        )
        .catch(err => {
          toast(`${describe(err)} You can still apply without the invitation.`);
          try {
            sessionStorage.removeItem(INVITE_KEY);
          } catch {}
        });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.validate()) return;
    if (!df().auth.user) {
      draft = { kind, values: form.values };
      site()?.askToSignIn(kind, "Please sign in or create an account to send your application. We'll bring you back to this form.");
      return;
    }
    const v = form.values;
    void run(async () => {
      try {
        if (kind === "merchant") {
          const documents = isDoc(v);
          const result = await df().api("/merchants/applications", {
            method: "POST",
            body: {
              type: documents ? "CORPORATE_DOCUMENT" : "ECOMMERCE",
              name: v.partnerName.trim(),
              contactName: v.partnerContact.trim(),
              contactPhone: e164(v.partnerPhone),
              contactEmail: v.partnerEmail.trim() || undefined,
              pickupAddress: v.partnerPickupAddress.trim(),
              pickupArea: v.partnerPickupArea.trim(),
              pickupDistrict: v.partnerArea === "Other district" ? v.partnerDistrict.trim() : v.partnerArea,
              inviteToken: inviteToken() || undefined,
            },
          });
          try {
            sessionStorage.removeItem(INVITE_KEY);
          } catch {}
          site()?.applicationSent(`Your ${documents ? "document" : "e-commerce"} merchant application ${result.merchant.code} was received.`, result.message);
          return;
        }
        const body =
          kind === "rider"
            ? { kind: "RIDER", name: v.partnerName.trim(), phone: e164(v.partnerPhone), email: v.partnerEmail.trim() || undefined, area: v.partnerArea, vehicle: v.riderVehicle }
            : {
                kind: "FRANCHISE",
                name: v.partnerName.trim(),
                phone: e164(v.partnerPhone),
                email: v.partnerEmail.trim() || undefined,
                location: v.partnerArea.trim(),
                experience: v.partnerExperience.trim() || undefined,
                territory: v.partnerInvestment,
              };
        const result = await df().api("/applications", { method: "POST", body });
        site()?.applicationSent(`Your ${kind} application ${result.application.number} was received.`, result.message);
      } catch (err) {
        const { mapped, rest } = form.showServerError(err, {
          name: "partnerName",
          contactName: "partnerContact",
          contactPhone: "partnerPhone",
          phone: "partnerPhone",
          contactEmail: "partnerEmail",
          email: "partnerEmail",
          pickupAddress: "partnerPickupAddress",
          pickupArea: "partnerPickupArea",
          pickupDistrict: "partnerDistrict",
          area: "partnerArea",
          location: "partnerArea",
          experience: "partnerExperience",
          territory: "partnerInvestment",
          vehicle: "riderVehicle",
        });
        if (!mapped || rest.length) toast(rest.join(" · ") || describe(err));
      }
    });
  };

  const text = (name: keyof Values, label: string, placeholder: string, opts: { required?: boolean; type?: string; autoComplete?: string; hidden?: boolean } = {}) => (
    <div className="field" hidden={opts.hidden}>
      <label htmlFor={name}>{opts.required === false ? label : `${label} *`}</label>
      <TextInput bound={form.bind(name)} error={form.error(name)} type={opts.type ?? "text"} placeholder={placeholder} autoComplete={opts.autoComplete ?? "off"} />
      <FieldError id={name} message={form.error(name)} />
    </div>
  );
  const select = (name: keyof Values, label: string, options: (string | [string, string])[], placeholder?: string, hidden?: boolean) => (
    // #merchantSectorField: the page script (01.js) toggles it when the account type changes.
    <div className="field" hidden={hidden} id={name === "merchantSector" ? "merchantSectorField" : undefined}>
      <label htmlFor={name}>{`${label} *`}</label>
      <Select bound={form.bind(name)} error={form.error(name)} options={options} placeholder={placeholder} />
      <FieldError id={name} message={form.error(name)} />
    </div>
  );
  const phone = (
    <div className="field">
      <label htmlFor="partnerPhone">Phone number *</label>
      <PhoneInput bound={form.bind("partnerPhone")} error={form.error("partnerPhone")} />
      <FieldError id="partnerPhone" message={form.error("partnerPhone")} />
    </div>
  );

  return (
    <form ref={form.formRef} id={`${kind}Form`} className="route-card route-form" data-form={kind} data-react="1" noValidate onSubmit={submit}>
      {kind === "merchant" ? (
        <>
          {select("merchantAccountType", "Merchant account type", [
            ["E-commerce merchant", "E-commerce merchant — online shop and product parcels"],
            ["Document merchant", "Document merchant — bank, fintech, or institution"],
          ])}
          {select("merchantSector", "Institution type", ["Bank", "Fintech / payments", "Insurance / financial services", "Other institution"], "Select institution type", !isDoc(form.values))}
          {text("partnerName", "Business / institution name", "Registered business or institution name", { autoComplete: "organization" })}
          {text("partnerContact", "Contact person", "Your full name", { autoComplete: "name" })}
          {text("partnerEmail", "Business email", "you@business.com", { type: "email", required: false, autoComplete: "email" })}
          {phone}
          {select("partnerArea", "Business location", MERCHANT_AREAS, "Select your area")}
          {text("partnerDistrict", "District", "e.g. Cumilla", { hidden: form.values.partnerArea !== "Other district" })}
          {text("partnerPickupAddress", "Pickup address", "House, road and area for parcel pickups", { autoComplete: "street-address" })}
          {text("partnerPickupArea", "Pickup area / thana", "e.g. Gulshan")}
        </>
      ) : kind === "rider" ? (
        <>
          {text("partnerName", "Full name", "Your full name", { autoComplete: "name" })}
          {phone}
          {text("partnerEmail", "Email address", "you@example.com", { type: "email", required: false, autoComplete: "email" })}
          {select("partnerArea", "Preferred work area", RIDER_AREAS, "Select your area")}
          {select("riderVehicle", "Vehicle type", VEHICLES)}
        </>
      ) : (
        <>
          {text("partnerName", "Your name", "Full name", { autoComplete: "name" })}
          {phone}
          {text("partnerEmail", "Email address", "you@example.com", { type: "email", required: false, autoComplete: "email" })}
          {text("partnerArea", "Proposed hub location", "District, area or market")}
          {text("partnerExperience", "Business experience", "Courier, retail, logistics...", { required: false })}
          {select("partnerInvestment", "Preferred territory", TERRITORIES, "Choose a territory size")}
        </>
      )}
      <div className="route-actions">
        <span className="route-note">
          {user ? "Your application goes to the Delivery Fast team. We'll contact you after review." : "You'll sign in or create an account before sending. We'll keep what you typed."}
        </span>
        <button className="button button-primary" type="submit" disabled={busy}>
          {busy ? "Please wait…" : `Send ${kind} application`}
        </button>
      </div>
    </form>
  );
}
