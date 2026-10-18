"use client";

import { useEffect, useRef, useState } from "react";
import { PRODUCT_TYPE_LABEL } from "@delivery-fast/shared";
import { df, describe, isApiError, site, toast, type MfaChallenge, type SessionUser } from "./df";
import { FieldError, PhoneInput, Select, TextInput, cooldownFrom, e164, rules, useBusy, useCountdown, useForm, local10 } from "./form";
import { MerchantPlaceFields, placeBody, placeNames, placePaths, placeRules } from "./MerchantPlaceFields";

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

/**
 * What a signed-out visitor typed, kept in this tab (sessionStorage) until the application is
 * sent: it survives the sign-in / sign-up pages, a reload and the SMS-code step. Passwords and
 * codes are never kept.
 */
const DRAFT_KEY = "deliveryfast-partner-draft";
const SECRET_FIELDS = new Set(["accountPassword", "accountOtp", "accountLoginPassword"]);
function saveDraft(kind: PartnerKind, values: Record<string, string>) {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ kind, values: Object.fromEntries(Object.entries(values).filter(([k]) => !SECRET_FIELDS.has(k))) }));
  } catch {}
}
function readDraft(kind: PartnerKind): Record<string, string> | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || "null") as { kind?: string; values?: Record<string, unknown> } | null;
    if (saved?.kind !== kind || !saved.values || typeof saved.values !== "object") return null;
    return Object.fromEntries(Object.entries(saved.values).filter(([k, v]) => typeof v === "string" && !SECRET_FIELDS.has(k))) as Record<string, string>;
  } catch {
    return null;
  }
}
function clearDraft() {
  try {
    sessionStorage.removeItem(DRAFT_KEY);
  } catch {}
}

type InviteInfo = { name?: string; businessName?: string | null; type?: string | null; phone?: string | null; email?: string | null; hasAccount?: boolean };
type OtpSent = { purpose: "SIGNUP" | "LOGIN"; phone: string; hint: string };
const isChallenge = (r: SessionUser | MfaChallenge): r is MfaChallenge => "mfaToken" in r && !!(r.mfaRequired || r.mfaSetupRequired);
const looksLikePhone = (v: string) => /^[+\d\s()-]{7,}$/.test(v.trim());
const linkStyle = { color: "var(--green)", fontWeight: 700, cursor: "pointer" } as const;
const noticeStyle = (tone: "ok" | "warn" | "error") =>
  ({
    padding: "10px 12px",
    borderRadius: 10,
    fontSize: 13,
    lineHeight: 1.45,
    border: `1px solid ${tone === "ok" ? "#bfe3d5" : tone === "warn" ? "#f5d48a" : "#f3b8a0"}`,
    background: tone === "ok" ? "#effaf5" : tone === "warn" ? "#fff8e6" : "#fff3ee",
    color: tone === "error" ? "#9a3412" : "var(--ink, #12221d)",
  }) as const;
/** Fields without a <label for>, named in the error summary. */
const SUMMARY_LABELS: Record<string, string> = { pickupTime: "Preferred pickup time", handover: "How you'll hand over parcels" };

/** Structured merchant addresses: the business address and (when it differs) the pickup address. */
const BIZ = placeNames("biz");
const PU = placeNames("pu");
const PICKUP_TIMES: [string, string][] = [
  ["MORNING", "Morning (9am–12pm)"],
  ["MIDDAY", "Midday (12pm–3pm)"],
  ["AFTERNOON", "Afternoon (3pm–6pm)"],
];
const placeInitial = (n: ReturnType<typeof placeNames>) => Object.fromEntries(Object.values(n).map(k => [k, ""]));
type ServingHub = { name: string; code: string; address: string; district: string } | null;
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
  businessCategory: "",
  websiteUrl: "",
  ...(placeInitial(BIZ) as Record<string, string>),
  ...(placeInitial(PU) as Record<string, string>),
  pickupSame: "1",
  pickupContactName: "",
  pickupContactPhone: "",
  pickupTime: "",
  handover: "RIDER_PICKUP",
  riderVehicle: "MOTORCYCLE",
  partnerExperience: "",
  partnerInvestment: "",
  // Signed-out merchants create their account (or sign in) at the end of the form.
  accountMode: "new",
  accountMethod: "password",
  accountPassword: "",
  accountOtp: "",
  accountLogin: "",
  accountLoginPassword: "",
};
type Values = typeof initial & Record<string, string>;

/**
 * Merchant, rider and franchise applications (merchant → super admin review; rider/franchise → support desk).
 * Signed-out visitors create their account (password + SMS code) or sign in at the end of the form. Until
 * approved, they see only their application: the merchant panel's verification page, or /application.
 */
export default function PartnerView({ kind }: { kind: PartnerKind }) {
  const isDoc = (v: Values) => v.merchantAccountType === "Banking & Financial merchant";
  const user = df().auth.user;
  /** Signed out: the account is created (or signed in) here, then the application is sent. */
  const inline = !user;
  /** The account holder's name: the merchant's contact person, else the applicant. */
  const accountName = kind === "merchant" ? "partnerContact" : "partnerName";
  const [otp, setOtp] = useState<OtpSent | null>(null);
  const otpTarget = (v: Values): Omit<OtpSent, "hint"> | null =>
    v.accountMode === "new" ? { purpose: "SIGNUP", phone: e164(v.partnerPhone) } : v.accountMethod === "otp" ? { purpose: "LOGIN", phone: e164(v.accountLogin) } : null;
  const codeSent = (v: Values) => {
    const target = otpTarget(v);
    return !!otp && !!target && otp.purpose === target.purpose && otp.phone === target.phone;
  };
  // What this visitor typed before (sign-in round trip, reload) is the starting point.
  const [start] = useState<Values>(() => ({ ...initial, ...(readDraft(kind) ?? {}) }) as Values);
  const form = useForm<Values>(start, {
    merchantSector: (v, all) => (kind === "merchant" && isDoc(all) && !v ? "Choose the institution type" : ""),
    partnerName: rules.length(2, 120, kind === "merchant" ? "Business name" : "Name"),
    partnerContact: v => (kind === "merchant" ? rules.length(2, 120, "Contact person")(v) : ""),
    partnerEmail: rules.optionalEmail,
    partnerPhone: rules.phone,
    partnerArea: v => (kind === "franchise" ? rules.length(2, 120, "Proposed hub location")(v) : kind === "merchant" || v ? "" : "Choose an area"),
    websiteUrl: v => (kind === "merchant" && v.trim() && !/^(https?:\/\/)?[^\s/$.?#]+\.[^\s]+$/i.test(v.trim()) ? "Enter a website or Facebook page address, e.g. facebook.com/yourshop" : ""),
    ...(placeRules(BIZ, () => kind === "merchant") as Record<string, (v: string, all: Values) => string>),
    ...(placeRules(PU, all => kind === "merchant" && all.pickupSame !== "1") as Record<string, (v: string, all: Values) => string>),
    pickupContactName: v => (kind === "merchant" ? rules.length(2, 120, "Pickup contact name")(v) : ""),
    pickupContactPhone: v => (kind === "merchant" ? rules.phone(v) : ""),
    pickupTime: v => (kind === "merchant" && !v ? "Choose the preferred pickup time" : ""),
    partnerExperience: v => (kind === "franchise" && v.trim() && v.trim().length < 2 ? "Use at least 2 characters" : rules.optionalMax(300)(v)),
    partnerInvestment: v => (kind === "franchise" && !v ? "Choose a territory size" : ""),
    accountPassword: (v, all) => (inline && all.accountMode === "new" ? rules.password(v) : ""),
    accountLogin: (v, all) => (inline && all.accountMode === "existing" ? (all.accountMethod === "otp" ? rules.phone(v) : rules.identifier(v)) : ""),
    accountLoginPassword: (v, all) => (inline && all.accountMode === "existing" && all.accountMethod === "password" && !v ? "Enter your password" : ""),
    accountOtp: (v, all) => (inline && codeSent(all) ? rules.otp(v) : ""),
  });
  const { busy, run } = useBusy();
  const countdown = useCountdown();
  /** The invitation from the link (?invite=…): prefills the form and fixes the merchant type. */
  const [invite, setInvite] = useState<{ ok: true; info: InviteInfo } | { ok: false; message: string } | null>(null);
  const invitedType = invite?.ok && (invite.info.type === "ECOMMERCE" || invite.info.type === "BANKING_FINANCIAL") ? invite.info.type : null;
  /** Problems listed at the top of the form after a submit (fields by name, plus messages without a field). */
  const [summary, setSummary] = useState<{ names: string[]; extra: string[] } | null>(null);
  const [accountNote, setAccountNote] = useState("");
  // Keep what a signed-out visitor types (not passwords or codes) until the application is sent.
  useEffect(() => {
    if (!df().auth.user) saveDraft(kind, form.values);
  }, [kind, form.values]);
  // The pickup contact follows the contact person until it is changed by hand.
  const lastContact = useRef({ name: "", phone: "" });
  useEffect(() => {
    if (kind !== "merchant") return;
    const prev = lastContact.current;
    const next = { name: form.values.partnerContact, phone: form.values.partnerPhone };
    lastContact.current = next;
    form.setValues(v => ({
      ...v,
      pickupContactName: !v.pickupContactName || v.pickupContactName === prev.name ? next.name : v.pickupContactName,
      pickupContactPhone: !v.pickupContactPhone || v.pickupContactPhone === prev.phone ? next.phone : v.pickupContactPhone,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, form.values.partnerContact, form.values.partnerPhone]);
  /** "Drop at hub": the hub serving the pickup zone (GET /merchants/pickup-hub), shown read-only. */
  const [hub, setHub] = useState<{ key: string; hub: ServingHub; error?: string } | null>(null);
  const pickupPlace = form.values.pickupSame === "1" ? BIZ : PU;
  const hubKey = kind === "merchant" && form.values.handover === "HUB_DROP" && form.values[pickupPlace.district] && form.values[pickupPlace.zone] ? `${form.values[pickupPlace.district]}|${form.values[pickupPlace.zone]}` : "";
  useEffect(() => {
    if (!hubKey) return;
    let live = true;
    const [district, zone] = hubKey.split("|");
    df()
      .api<{ hub: ServingHub }>(`/merchants/pickup-hub?district=${encodeURIComponent(district)}&zone=${encodeURIComponent(zone)}`)
      .then(r => live && setHub({ key: hubKey, hub: r.hub }))
      .catch(err => live && setHub({ key: hubKey, hub: null, error: describe(err) }));
    return () => {
      live = false;
    };
  }, [hubKey]);

  // Prefill empty fields from the account, then from the invitation.
  useEffect(() => {
    if (user)
      form.setValues(v => {
        const nameField = kind === "merchant" ? "partnerContact" : "partnerName";
        return {
          ...v,
          [nameField]: v[nameField] || user.name,
          partnerPhone: v.partnerPhone || local10(user.phone),
          partnerEmail: v.partnerEmail || user.email || "",
          ...(kind === "merchant" ? { pickupContactName: v.pickupContactName || user.name, pickupContactPhone: v.pickupContactPhone || local10(user.phone) } : {}),
        };
      });
    // Invited merchants: prefill from the invitation (POST /merchants/invites/lookup).
    const token = kind === "merchant" ? inviteToken() : null;
    if (token)
      df()
        .api<InviteInfo>("/merchants/invites/lookup", { method: "POST", body: { token } })
        .then(info => {
          setInvite({ ok: true, info });
          const invited = info.type === "BANKING_FINANCIAL" || info.type === "ECOMMERCE" ? info.type : null;
          const signedOut = !df().auth.user;
          const accountPhone = df().auth.user?.phone ? local10(df().auth.user!.phone) : "";
          const invitedPhone = info.phone ? local10(info.phone) : "";
          form.setValues(v => ({
            ...v,
            merchantAccountType: invited === "BANKING_FINANCIAL" ? "Banking & Financial merchant" : invited === "ECOMMERCE" ? "E-commerce merchant" : v.merchantAccountType,
            // The invitation is the source of truth for who is applying: its business name, phone and
            // email win over the signed-in account and over an older saved draft.
            partnerName: info.businessName || v.partnerName || "",
            // An invitation's contact name can be a phone number typed by mistake: don't use that as a name.
            partnerContact: v.partnerContact || (info.name && !looksLikePhone(info.name) ? info.name : ""),
            partnerPhone: invitedPhone || v.partnerPhone,
            partnerEmail: info.email || v.partnerEmail || "",
            // The pickup contact follows the invited number unless it was changed to someone else.
            pickupContactPhone: invitedPhone && (!v.pickupContactPhone || v.pickupContactPhone === accountPhone) ? invitedPhone : v.pickupContactPhone,
            // The invited number already has an account: sign in instead of creating one.
            ...(signedOut && info.hasAccount ? { accountMode: "existing", accountMethod: "password", accountLogin: v.accountLogin || (info.phone ? `0${local10(info.phone)}` : info.email || "") } : {}),
          }));
        })
        .catch(err => {
          setInvite({ ok: false, message: describe(err) });
          // Used, expired or revoked: forget the link (a network error keeps it for the next try).
          if (isApiError(err) && err.status === 404)
            try {
              sessionStorage.removeItem(INVITE_KEY);
            } catch {}
        });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  const focusField = (name: string) => {
    const el = form.formRef.current?.querySelector<HTMLElement>(`#${CSS.escape(name)}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    el?.focus({ preventScroll: true });
  };

  /** Shows an API error under its fields and in the summary; `fallback` takes a message that has no field. */
  const showErrors = (err: unknown, paths: Record<string, string>, fallback?: string) => {
    const { fields, rest } = form.showServerError(err, paths as Record<string, keyof Values & string>);
    if (!fields.length && fallback) {
      form.setServerErrors({ [fallback]: describe(err) });
      setSummary({ names: [fallback], extra: [] });
      requestAnimationFrame(() => focusField(fallback));
      return;
    }
    const extra = fields.length ? rest : rest.length ? rest : [describe(err)];
    setSummary({ names: fields, extra });
    if (!fields.length) requestAnimationFrame(() => document.getElementById(`${kind}FormErrors`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
    if (extra.length) toast(extra.join(" · "));
  };

  /** Opens the sign-in page (two-step verification, forgotten password); the form and invitation are kept. */
  const toLoginPage = (message: string) => {
    saveDraft(kind, form.values);
    site()?.askToSignIn(kind, message);
  };

  /** Texts a sign-up or sign-in code to the number the account step uses. */
  const sendCode = async () => {
    const v = form.values;
    const target = otpTarget(v);
    if (!target) return;
    const phoneField = v.accountMode === "new" ? "partnerPhone" : "accountLogin";
    try {
      const result = await df().auth.requestOtp(target.phone, target.purpose);
      setOtp({ ...target, hint: result.devCode ? `Development code: ${result.devCode}` : `We sent a 6-digit code by SMS to +880 ${local10(target.phone)}. It expires in 5 minutes.` });
      form.set("accountOtp", "");
      countdown.start(cooldownFrom(result));
      toast(result.message);
      setTimeout(() => focusField("accountOtp"), 50);
    } catch (err) {
      const wait = cooldownFrom(null, err);
      if (wait) countdown.start(wait);
      showErrors(err, { phone: phoneField }, phoneField);
    }
  };

  const chooseMode = (mode: "new" | "existing") => {
    setAccountNote("");
    form.setValues(v => ({ ...v, accountMode: mode, accountLogin: v.accountLogin || (v.partnerPhone ? (v.accountMethod === "otp" ? v.partnerPhone : `0${v.partnerPhone}`) : "") }));
  };
  const toggleMethod = () =>
    form.setValues(v => ({
      ...v,
      accountMethod: v.accountMethod === "otp" ? "password" : "otp",
      // The SMS-code form takes the 10 digits after +880; the password form takes a phone or an email.
      accountLogin: v.accountMethod === "otp" ? (v.accountLogin ? `0${v.accountLogin}` : "") : v.accountLogin.includes("@") ? "" : local10(v.accountLogin),
    }));

  /**
   * Signed-out merchant: creates the account (SMS code to the contact phone) or signs in (password or
   * SMS code), right in the form. Returns true once there is a session.
   */
  const signInHere = async (): Promise<boolean> => {
    const v = form.values;
    const target = otpTarget(v);
    try {
      if (v.accountMode === "new") {
        if (!codeSent(v)) {
          await sendCode();
          return false;
        }
        await df().auth.signup({ name: v[accountName].trim(), phone: target!.phone, password: v.accountPassword, otp: v.accountOtp.trim() });
        toast("Your Delivery Fast account is ready. Sending your application…");
      } else {
        let result: SessionUser | MfaChallenge;
        if (v.accountMethod === "otp") {
          if (!codeSent(v)) {
            await sendCode();
            return false;
          }
          result = await df().auth.loginWithOtp(target!.phone, v.accountOtp.trim());
        } else result = await df().auth.login(v.accountLogin.trim(), v.accountLoginPassword);
        if (isChallenge(result)) {
          toLoginPage("Your account uses two-step verification. Finish signing in here, then we'll bring you back to your application.");
          return false;
        }
        toast(`Signed in as ${result.name}. Sending your application…`);
      }
    } catch (err) {
      if (isApiError(err) && err.code === "PHONE_IN_USE") {
        setOtp(null);
        form.setValues(c => ({ ...c, accountMode: "existing", accountMethod: "password", accountLogin: `0${local10(target!.phone)}`, accountOtp: "" }));
        setAccountNote("This number already has a Delivery Fast account. Sign in below to send your application.");
        setSummary({ names: [], extra: ["This number already has a Delivery Fast account. Sign in at the end of the form to send your application."] });
        setTimeout(() => focusField("accountLoginPassword"), 50);
        return false;
      }
      showErrors(
        err,
        { otp: "accountOtp", code: "accountOtp", password: v.accountMode === "new" ? "accountPassword" : "accountLoginPassword", identifier: "accountLogin", phone: v.accountMode === "new" ? "partnerPhone" : "accountLogin", name: accountName },
        codeSent(v) ? "accountOtp" : v.accountMode === "new" ? "accountPassword" : "accountLoginPassword",
      );
      return false;
    }
    setOtp(null);
    form.setValues(c => ({ ...c, accountPassword: "", accountOtp: "", accountLoginPassword: "" }));
    await site()
      ?.refreshAccount()
      .catch(() => undefined);
    return true;
  };

  /** Sends the application (signed in). */
  const sendApplication = async () => {
    const v = form.values;
    try {
      if (kind === "merchant") {
        const documents = isDoc(v);
        const same = v.pickupSame === "1";
        const category = documents ? v.merchantSector : v.businessCategory;
        const result = await df().api("/merchants/applications", {
          method: "POST",
          body: {
            type: documents ? "BANKING_FINANCIAL" : "ECOMMERCE",
            name: v.partnerName.trim(),
            contactName: v.partnerContact.trim(),
            contactPhone: e164(v.partnerPhone),
            contactEmail: v.partnerEmail.trim() || undefined,
            businessCategory: category || undefined,
            websiteUrl: v.websiteUrl.trim() || undefined,
            business: placeBody(v, BIZ),
            pickupSameAsBusiness: same,
            ...(same ? {} : { pickup: placeBody(v, PU) }),
            pickupContactName: v.pickupContactName.trim(),
            pickupContactPhone: e164(v.pickupContactPhone),
            pickupTime: v.pickupTime,
            handover: v.handover,
            inviteToken: inviteToken() || undefined,
          },
        });
        clearDraft();
        try {
          sessionStorage.removeItem(INVITE_KEY);
        } catch {}
        await site()?.merchantApplied(`Your ${documents ? "document" : "e-commerce"} merchant application ${result.merchant.code} was received.`, result.message);
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
      clearDraft();
      // Until approved, the applicant's only page is the application page (status and messages).
      await site()?.partnerApplied(`Your ${kind} application ${result.application.number} was received.`, result.message, "your application page", "/application");
    } catch (err) {
      showErrors(err, {
        name: "partnerName",
        contactName: "partnerContact",
        contactPhone: "partnerPhone",
        phone: "partnerPhone",
        contactEmail: "partnerEmail",
        email: "partnerEmail",
        ...placePaths("business", BIZ),
        ...placePaths("pickup", PU),
        pickupContactName: "pickupContactName",
        pickupContactPhone: "pickupContactPhone",
        pickupTime: "pickupTime",
        handover: "handover",
        businessCategory: "businessCategory",
        websiteUrl: "websiteUrl",
        type: "merchantAccountType",
        area: "partnerArea",
        location: "partnerArea",
        experience: "partnerExperience",
        territory: "partnerInvestment",
        vehicle: "riderVehicle",
      });
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    // Every problem shows under its field and in the summary at the top; the first one gets the focus.
    const bad = form.invalid();
    if (!form.validate()) return void setSummary({ names: bad, extra: [] });
    setSummary(null);
    // Signed out: create the account (or sign in) right here, then send the application.
    if (!df().auth.user) return void run(async () => void ((await signInHere()) && (await sendApplication())));
    void run(sendApplication);
  };

  const summaryItems = (summary?.names ?? [])
    .filter(name => form.error(name))
    .map(name => ({
      name,
      label: SUMMARY_LABELS[name] || form.formRef.current?.querySelector(`label[for="${CSS.escape(name)}"]`)?.textContent?.replace(/\s*\*\s*$/, "") || name,
      message: form.error(name),
    }));
  const summaryExtra = summary?.extra ?? [];
  const awaitingCode = inline && codeSent(form.values);
  const submitLabel = busy
    ? "Please wait…"
    : !inline
      ? `Send ${kind} application`
      : awaitingCode
        ? "Verify code and send application"
        : form.values.accountMode === "existing"
          ? form.values.accountMethod === "otp"
            ? "Text me a sign-in code"
            : "Sign in and send application"
          : "Create account and send application";
  const inviteLabel = invitedType === "BANKING_FINANCIAL" ? "a Banking & Financial merchant" : invitedType === "ECOMMERCE" ? "an E-commerce merchant" : "a merchant";

  const text = (name: keyof Values, label: string, placeholder: string, opts: { required?: boolean; type?: string; autoComplete?: string; hidden?: boolean } = {}) => (
    <div className="field" hidden={opts.hidden}>
      <label htmlFor={name}>{opts.required === false ? label : `${label} *`}</label>
      <TextInput bound={form.bind(name)} error={form.error(name)} type={opts.type ?? "text"} placeholder={placeholder} autoComplete={opts.autoComplete ?? "off"} />
      <FieldError id={name} message={form.error(name)} />
    </div>
  );
  const select = (name: keyof Values, label: string, options: (string | [string, string])[], placeholder?: string, hidden?: boolean, disabled?: boolean, required = true) => (
    // #merchantSectorField: the page script (01.js) toggles it when the account type changes.
    <div className="field" hidden={hidden} id={name === "merchantSector" ? "merchantSectorField" : undefined}>
      <label htmlFor={name}>{required ? `${label} *` : label}</label>
      <Select bound={form.bind(name)} error={form.error(name)} options={options} placeholder={placeholder} disabled={disabled} />
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
      {invite && kind === "merchant" ? (
        invite.ok ? (
          <div className="field full" id="inviteNotice" style={noticeStyle("ok")}>
            {`You're invited to join Delivery Fast as ${inviteLabel}${invite.info.businessName ? ` (${invite.info.businessName})` : ""}. ${
              user ? "Check the details and send your application." : invite.info.hasAccount ? "This number already has an account: fill in the form, then sign in at the end to send it." : "Fill in the form; you'll create your account at the end and send it in one step."
            }`}
            {user && invite.info.phone && local10(user.phone) !== local10(invite.info.phone) ? (
              <div id="inviteAccountMismatch" role="alert" style={{ ...noticeStyle("warn"), marginTop: 8 }}>
                {`You're signed in as ${user.name} (0${local10(user.phone)}), but this invitation is for 0${local10(invite.info.phone)}. `}
                <span
                  role="button"
                  tabIndex={0}
                  style={linkStyle}
                  onClick={() => void df().auth.logout().then(() => location.reload())}
                  onKeyDown={e => (e.key === "Enter" || e.key === " ") && void df().auth.logout().then(() => location.reload())}
                >
                  {"Sign out and continue as the invited merchant"}
                </span>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="field full" id="inviteNotice" role="alert" style={noticeStyle("warn")}>
            {`${invite.message} You can still apply without the invitation.`}
          </div>
        )
      ) : null}
      {summaryItems.length || summaryExtra.length ? (
        <div className="field full" id={`${kind}FormErrors`} role="alert" style={noticeStyle("error")}>
          <strong>{summaryItems.length ? `Please check ${summaryItems.length === 1 ? "this field" : `these ${summaryItems.length} fields`} before sending:` : "Your application wasn't sent:"}</strong>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {summaryExtra.map(message => (
              <li key={message}>{message}</li>
            ))}
            {summaryItems.map(item => (
              <li key={item.name}>
                <a href={`#${item.name}`} data-error-for={item.name} style={{ color: "inherit", textDecoration: "underline" }} onClick={e => (e.preventDefault(), focusField(item.name))}>
                  {`${item.label}: ${item.message}`}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {kind === "merchant" ? (
        <>
          <h2 className="field full">{"1. Business details"}</h2>
          {text("partnerName", "Business / institution name", "Registered business or institution name", { autoComplete: "organization" })}
          {select("merchantAccountType", "Merchant account type", [
            ["E-commerce merchant", "E-commerce merchant — online shop and product parcels"],
            ["Banking & Financial merchant", "Banking & Financial merchant — bank, fintech, or institution"],
          ], undefined, false, invitedType !== null)}
          {invitedType !== null ? <small className="field-hint field full">{"Your invitation is for this account type."}</small> : null}
          {select("merchantSector", "Institution type", ["Bank", "Fintech / payments", "Insurance / financial services", "Other institution"], "Select institution type", !isDoc(form.values))}
          {select("businessCategory", "Business category (optional)", Object.values(PRODUCT_TYPE_LABEL), "What you mostly send", isDoc(form.values), false, false)}
          {text("websiteUrl", "Facebook page / website", "facebook.com/yourshop", { required: false, autoComplete: "url" })}
          {text("partnerContact", "Contact person", "Your full name", { autoComplete: "name" })}
          {text("partnerEmail", "Business email", "you@business.com", { type: "email", required: false, autoComplete: "email" })}
          {phone}

          <h2 className="field full">{"2. Business address"}</h2>
          <MerchantPlaceFields form={form} names={BIZ} label="Business" />

          <h2 className="field full">{"3. Pickup location"}</h2>
          <label className="checkline field full">
            <input type="checkbox" id="pickupSame" checked={form.values.pickupSame === "1"} onChange={e => form.set("pickupSame", e.target.checked ? "1" : "")} />
            {"Pickup from the business address"}
          </label>
          {form.values.pickupSame === "1" ? null : <MerchantPlaceFields form={form} names={PU} label="Pickup" />}
          {text("pickupContactName", "Pickup contact person", "Who hands over the parcels", { autoComplete: "off" })}
          <div className="field">
            <label htmlFor="pickupContactPhone">{"Pickup contact phone *"}</label>
            <PhoneInput bound={form.bind("pickupContactPhone")} error={form.error("pickupContactPhone")} />
            <FieldError id="pickupContactPhone" message={form.error("pickupContactPhone")} />
          </div>
          <div className="field full">
            <span className="field-label">{"Preferred pickup time *"}</span>
            <div className="address-category-options" role="radiogroup" aria-label="Preferred pickup time">
              {PICKUP_TIMES.map(([value, label], i) => (
                <label className="address-category-option" key={value}>
                  <input id={i === 0 ? "pickupTime" : undefined} type="radio" name="pickupTime" value={value} checked={form.values.pickupTime === value} onChange={() => form.set("pickupTime", value)} />
                  {label}
                </label>
              ))}
            </div>
            <FieldError id="pickupTime" message={form.error("pickupTime")} />
          </div>

          <h2 className="field full">{"4. How you'll hand over parcels"}</h2>
          <div className="field full">
            <div className="address-category-options" role="radiogroup" aria-label="How you'll hand over parcels">
              {(
                [
                  ["RIDER_PICKUP", "Rider pickup — a rider collects from you"],
                  ["HUB_DROP", "Drop at hub — you bring parcels to our hub"],
                ] as const
              ).map(([value, label]) => (
                <label className="address-category-option" key={value}>
                  <input type="radio" name="handover" id={`handover-${value}`} value={value} checked={form.values.handover === value} onChange={() => form.set("handover", value)} />
                  {label}
                </label>
              ))}
            </div>
            {form.values.handover === "HUB_DROP" ? (
              <div className="review-item" id="servingHub" style={{ marginTop: 8 }} aria-live="polite">
                {!hubKey ? (
                  <small className="field-hint">{"Choose the pickup district and thana / upazila to see your hub."}</small>
                ) : !hub || hub.key !== hubKey ? (
                  <small className="field-hint">{"Finding your hub…"}</small>
                ) : hub.hub ? (
                  <>
                    <strong>{`${hub.hub.name} (${hub.hub.code})`}</strong>
                    <div className="field-hint">{`${hub.hub.address} · ${hub.hub.district}`}</div>
                    <small className="field-hint">{"Your serving hub for this pickup area. Bring your parcels here."}</small>
                  </>
                ) : (
                  <small className="field-hint">{hub.error || "No hub serves this area yet. Our team will assign your hub when they review the application."}</small>
                )}
              </div>
            ) : null}
          </div>
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
      {inline ? (
        <>
          <h2 className="field full">{kind === "merchant" ? "5. Your Delivery Fast account" : "Your Delivery Fast account"}</h2>
          {accountNote ? (
            <div className="field full" id="accountNote" role="status" style={noticeStyle("warn")}>
              {accountNote}
            </div>
          ) : null}
          <div className="field full">
            <div className="address-category-options" role="radiogroup" aria-label="Your Delivery Fast account">
              {(
                [
                  ["new", "I'm new: create my account"],
                  ["existing", "I already have an account: sign in"],
                ] as const
              ).map(([value, label]) => (
                <label className="address-category-option" key={value}>
                  <input type="radio" name="accountMode" id={`accountMode-${value}`} value={value} checked={form.values.accountMode === value} onChange={() => chooseMode(value)} />
                  {label}
                </label>
              ))}
            </div>
          </div>
          {form.values.accountMode === "new" ? (
            <div className="field">
              <label htmlFor="accountPassword">{"Create a password *"}</label>
              <TextInput bound={form.bind("accountPassword")} error={form.error("accountPassword")} type="password" placeholder="At least 10 characters with a number" autoComplete="new-password" />
              <small className="field-hint">{`Your account uses the phone number above${form.values.partnerPhone ? ` (+880 ${form.values.partnerPhone})` : ""}. We'll text a code to confirm it.`}</small>
              <FieldError id="accountPassword" message={form.error("accountPassword")} />
            </div>
          ) : (
            <>
              <div className="field">
                <label htmlFor="accountLogin">{form.values.accountMethod === "otp" ? "Phone number *" : "Email or phone *"}</label>
                {form.values.accountMethod === "otp" ? (
                  <PhoneInput bound={form.bind("accountLogin")} error={form.error("accountLogin")} />
                ) : (
                  <TextInput bound={form.bind("accountLogin")} error={form.error("accountLogin")} placeholder="you@example.com or 017XXXXXXXX" autoComplete="username" />
                )}
                <FieldError id="accountLogin" message={form.error("accountLogin")} />
              </div>
              {form.values.accountMethod === "password" ? (
                <div className="field">
                  <label htmlFor="accountLoginPassword">{"Password *"}</label>
                  <TextInput bound={form.bind("accountLoginPassword")} error={form.error("accountLoginPassword")} type="password" placeholder="Your password" autoComplete="current-password" />
                  <FieldError id="accountLoginPassword" message={form.error("accountLoginPassword")} />
                </div>
              ) : null}
              <p className="field full" style={{ display: "flex", gap: 16, flexWrap: "wrap", margin: 0, fontSize: 13 }}>
                <a role="button" tabIndex={0} id="accountMethodToggle" style={linkStyle} onClick={e => (e.preventDefault(), toggleMethod())}>
                  {form.values.accountMethod === "otp" ? "Use my password instead" : "Sign in with an SMS code instead"}
                </a>
                <a role="button" tabIndex={0} id="accountLoginPage" style={linkStyle} onClick={e => (e.preventDefault(), toLoginPage("Sign in here, then we'll bring you back to your application. What you typed is kept."))}>
                  {"Forgot your password? Sign in on the login page"}
                </a>
              </p>
            </>
          )}
          {awaitingCode && otp ? (
            <div className="field">
              <label htmlFor="accountOtp">{"SMS code *"}</label>
              <TextInput bound={form.bind("accountOtp")} error={form.error("accountOtp")} placeholder="6-digit code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} />
              <small className="field-hint">{otp.hint}</small>
              <small className="field-hint">
                {countdown.left > 0 ? (
                  `Didn't get it? You can request a new code in ${countdown.left} s.`
                ) : (
                  <a role="button" tabIndex={0} id="accountResend" style={linkStyle} onClick={e => (e.preventDefault(), void run(sendCode))}>
                    {"Send a new code"}
                  </a>
                )}
              </small>
              <FieldError id="accountOtp" message={form.error("accountOtp")} />
            </div>
          ) : null}
        </>
      ) : null}
      <div className="route-actions">
        <span className="route-note">
          {user
            ? "Your application goes to the Delivery Fast team. We'll contact you after review."
            : "We'll confirm your number by SMS, set up your account and send the application. What you type is kept on this device until it's sent."}
        </span>
        <button className="button button-primary" type="submit" disabled={busy}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
