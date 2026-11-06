"use client";

import { useEffect, useState } from "react";
import { df, describe, site, toast, type EmailStatus } from "./df";
import { Field, PhoneInput, TextInput, cooldownFrom, rules, useBusy, useCountdown, useForm, local10 } from "./form";

const badge = (verified: boolean) =>
  ({
    display: "inline-block",
    marginLeft: 8,
    padding: "2px 8px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 700,
    background: verified ? "#e7f5ef" : "#fff4e5",
    color: verified ? "#087e67" : "#9a5b00",
  }) as const;

/** Profile: name and email (phone changes go through support), with email verification. */
export default function ProfileView() {
  const user = df().auth.user;
  const form = useForm(
    { profileName: user?.name ?? "", profilePhone: user ? local10(user.phone) : "", profileEmail: user?.email ?? "" },
    { profileName: v => (v.trim().length < 2 ? "Enter your full name" : v.trim().length > 120 ? "Use at most 120 characters" : ""), profileEmail: rules.optionalEmail },
  );
  const { busy, run } = useBusy();
  const [status, setStatus] = useState<EmailStatus | null>(null);

  const loadStatus = () =>
    df()
      .auth.emailVerification.status()
      .then(setStatus)
      .catch(() => setStatus(null));
  useEffect(() => {
    if (user) void loadStatus();
  }, [user]);

  if (!user) return null; // the page asks to sign in first

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.validate()) return;
    void run(async () => {
      const email = form.values.profileEmail.trim().toLowerCase();
      const emailChanged = email !== (user.email ?? "");
      try {
        const updated = await df().api("/me", { method: "PATCH", body: { name: form.values.profileName.trim(), email: email || null } });
        df().state.user = { ...user, ...updated };
        await site()?.refreshAccount();
        toast("Your profile has been updated.");
        if (emailChanged && email) {
          const sent = await df().auth.emailVerification.send().catch(() => null);
          if (sent?.sent) toast(sent.message);
        }
        await loadStatus();
      } catch (err) {
        const { mapped } = form.showServerError(err, { name: "profileName", email: "profileEmail" });
        if (!mapped) toast(describe(err));
      }
    });
  };

  const savedEmail = (user.email ?? "") === form.values.profileEmail.trim().toLowerCase();
  return (
    <div className="route-card">
      <h2>Profile details</h2>
      <p className="route-note">Update the contact information on your Delivery Fast account.</p>
      <form ref={form.formRef} id="profileForm" className="route-form customer-profile-form" data-form="profile" data-react="1" noValidate onSubmit={submit}>
        <Field label="Full name" required htmlFor="profileName" error={form.error("profileName")}>
          <TextInput bound={form.bind("profileName")} error={form.error("profileName")} autoComplete="name" />
        </Field>
        <Field label="Phone number" htmlFor="profilePhone" hint="Your sign-in number. Contact support to change it.">
          <PhoneInput bound={form.bind("profilePhone")} disabled />
        </Field>
        <Field
          label="Email address"
          full
          htmlFor="profileEmail"
          error={form.error("profileEmail")}
          hint={
            status?.email && savedEmail ? (
              <span data-email-status={status.verified ? "verified" : "unverified"}>
                {status.verified ? "Verified" : "Not verified yet"}
                <span style={badge(status.verified)}>{status.verified ? "✓ Verified" : "Unverified"}</span>
              </span>
            ) : form.values.profileEmail.trim() && !savedEmail ? (
              "We'll send a verification link to the new address after you save."
            ) : undefined
          }
        >
          <TextInput bound={form.bind("profileEmail")} error={form.error("profileEmail")} type="email" autoComplete="email" />
        </Field>
        <div className="route-actions">
          <button className="button button-primary" type="submit" disabled={busy}>
            {busy ? "Please wait…" : "Save profile"}
          </button>
        </div>
      </form>
      {status?.email && !status.verified && savedEmail ? <EmailVerificationBox status={status} onVerified={setStatus} /> : null}
      <TwoStepBox />
    </div>
  );
}

let mfaScript: Promise<void> | null = null;
/** The shared two-step verification dialog (public/legacy/shared/mfa.js), loaded on first use. */
function loadMfaDialog() {
  mfaScript ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/legacy/shared/mfa.js";
    script.onload = () => resolve();
    script.onerror = () => {
      mfaScript = null;
      reject(new Error("Could not open two-step verification. Check your connection and try again."));
    };
    document.head.append(script);
  });
  return mfaScript;
}

/** Optional two-step verification (authenticator app) for this account. */
function TwoStepBox() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const refresh = () =>
    df()
      .api<{ enabled: boolean }>("/auth/mfa")
      .then(s => setEnabled(s.enabled))
      .catch(() => setEnabled(null));
  useEffect(() => {
    void refresh();
  }, []);
  const open = async () => {
    try {
      await loadMfaDialog();
      (window as unknown as { DF: { mfa: { manage(o: { onChange: () => void }): void } } }).DF.mfa.manage({ onChange: () => void refresh() });
    } catch (error) {
      toast(describe(error));
    }
  };
  if (enabled === null) return null;
  return (
    <div className="route-form" data-two-step={enabled ? "on" : "off"} style={{ marginTop: 18 }}>
      <h3 className="field full" style={{ margin: 0 }}>
        {"Two-step verification"}
        <span style={badge(enabled)}>{enabled ? "On" : "Off"}</span>
      </h3>
      <p className="field full route-note">
        {enabled
          ? "Signing in needs a code from your authenticator app as well as your password or SMS code."
          : "Add a code from an authenticator app to your sign-in for extra protection. Optional."}
      </p>
      <div className="route-actions">
        <button className="button button-quiet" type="button" onClick={() => void open()}>
          {enabled ? "Manage two-step verification" : "Set up two-step verification"}
        </button>
      </div>
    </div>
  );
}

/** Resend the link, or type the 6-digit code from the email. */
function EmailVerificationBox({ status, onVerified }: { status: EmailStatus; onVerified: (s: EmailStatus) => void }) {
  const countdown = useCountdown();
  const { busy, run } = useBusy();
  const form = useForm({ emailCode: "" }, { emailCode: rules.otp });
  const [hint, setHint] = useState(status.pending ? `We sent a link and a code to ${status.email}.` : "");

  const send = () =>
    run(async () => {
      try {
        const result = await df().auth.emailVerification.send();
        setHint(result.devCode ? `${result.message} Development code: ${result.devCode}` : result.message);
        countdown.start(cooldownFrom(result));
        if (result.verified) onVerified(result);
      } catch (err) {
        const wait = cooldownFrom(null, err);
        if (wait) countdown.start(wait);
        toast(describe(err));
      }
    });

  const confirm = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.validate()) return;
    void run(async () => {
      try {
        const result = await df().auth.emailVerification.confirm({ code: form.values.emailCode.trim() });
        toast(result.message);
        onVerified(result);
      } catch (err) {
        const { mapped } = form.showServerError(err, { code: "emailCode" });
        if (!mapped) form.setServerErrors({ emailCode: describe(err) });
      }
    });
  };

  return (
    <form ref={form.formRef} className="route-form" data-form="email-verification" data-react="1" noValidate onSubmit={confirm} style={{ marginTop: 18 }}>
      <h3 className="field full" style={{ margin: 0 }}>
        Verify your email address
      </h3>
      <p className="field full route-note">{hint || `Confirm ${status.email} so we can send receipts and account notices there.`}</p>
      <Field label="Code from the email" htmlFor="emailCode" error={form.error("emailCode")}>
        <TextInput bound={form.bind("emailCode")} error={form.error("emailCode")} placeholder="6-digit code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} />
      </Field>
      <div className="route-actions">
        <button className="button button-quiet" type="button" onClick={() => void send()} disabled={busy || countdown.left > 0}>
          {countdown.left > 0 ? `Send again in ${countdown.left} s` : status.pending || hint ? "Send a new link" : "Send verification email"}
        </button>
        <button className="button button-primary" type="submit" disabled={busy}>
          Verify email
        </button>
      </div>
    </form>
  );
}

/** /account/verify-email?token=… from the email: confirms without signing in. */
export function VerifyEmailView() {
  const [state, setState] = useState<{ ok: boolean; message: string } | null>(null);
  useEffect(() => {
    const token = new URLSearchParams(location.search).get("token");
    if (!token) return void setState({ ok: false, message: "This verification link is incomplete. Open the link from the email again." });
    df()
      .auth.emailVerification.confirm({ token })
      .then(r => setState({ ok: true, message: r.email ? `${r.email} is verified. Thank you!` : r.message }))
      .catch(err => setState({ ok: false, message: describe(err) }));
  }, []);
  return (
    <div className="route-card" data-verify-email={state ? (state.ok ? "ok" : "failed") : "pending"}>
      <h2>{state ? (state.ok ? "Email verified" : "We couldn't verify your email") : "Verifying your email…"}</h2>
      <p className="route-note">{state?.message ?? "One moment."}</p>
      {state ? (
        <a className="button button-primary" href={df().auth.user ? "/account/profile" : "/login"} data-route={df().auth.user ? "profile" : "login"}>
          {df().auth.user ? "Go to your profile" : "Log in"}
        </a>
      ) : null}
    </div>
  );
}
