"use client";

import { useEffect, useState } from "react";
import { df, describe, site, toast } from "./df";
import { inviteToken } from "./PartnerView";
import { AlreadySignedIn, pendingPartnerRoute, useAlreadySignedIn } from "./LoginView";
import { FieldError, PhoneInput, TextInput, cooldownFrom, e164, rules, useBusy, useCountdown, useForm } from "./form";

const linkStyle = { color: "var(--green)", fontWeight: 700, cursor: "pointer" } as const;

/** Customer sign-up: details → SMS code (resend after the server's cooldown) → account, then email verification. */
export default function SignupView() {
  // Already signed in: go to the panel / account instead (sign out first to create another account).
  const signedIn = useAlreadySignedIn();
  if (signedIn !== null) return <AlreadySignedIn user={signedIn} />;
  return <SignupForm />;
}

function SignupForm() {
  // Old invitation links (/#/signup?invite=…): sign up, then continue to the merchant application.
  useEffect(() => {
    if (!inviteToken()) return;
    try {
      sessionStorage.setItem("deliveryfast-customer-return-route", "merchant");
    } catch {}
  }, []);
  const [pendingApplication] = useState(() => pendingPartnerRoute() || (inviteToken() ? "merchant" : ""));
  const [codeFor, setCodeFor] = useState<{ phone: string; hint: string } | null>(null);
  const countdown = useCountdown();
  const form = useForm(
    { signupName: "", signupPhone: "", signupEmail: "", signupPassword: "", signupOtp: "" },
    {
      signupName: v => (v.trim().length < 2 ? "Enter your full name" : v.trim().length > 120 ? "Use at most 120 characters" : ""),
      signupPhone: rules.phone,
      signupEmail: rules.optionalEmail,
      signupPassword: rules.password,
      signupOtp: v => (codeFor ? rules.otp(v) : ""),
    },
  );
  const { busy, run } = useBusy();
  const paths = { name: "signupName", phone: "signupPhone", email: "signupEmail", password: "signupPassword", otp: "signupOtp" } as const;

  const sendCode = () =>
    run(async () => {
      if (!form.validate(["signupName", "signupPhone", "signupEmail", "signupPassword"])) return;
      const phone = e164(form.values.signupPhone);
      try {
        const result = await df().auth.requestOtp(phone, "SIGNUP");
        setCodeFor({ phone, hint: result.devCode ? `Development code: ${result.devCode}` : "We sent a 6-digit code by SMS. It expires in 5 minutes." });
        countdown.start(cooldownFrom(result));
        toast(result.message);
      } catch (err) {
        const wait = cooldownFrom(null, err);
        if (wait) countdown.start(wait);
        const { mapped } = form.showServerError(err, paths);
        if (!mapped) form.setServerErrors({ signupPhone: describe(err) });
      }
    });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    // A changed number needs a new code.
    if (!codeFor || codeFor.phone !== e164(form.values.signupPhone)) return void sendCode();
    if (!form.validate()) return;
    void run(async () => {
      try {
        const email = form.values.signupEmail.trim();
        const user = await df().auth.signup({
          name: form.values.signupName.trim(),
          phone: codeFor.phone,
          email: email || undefined,
          password: form.values.signupPassword,
          otp: form.values.signupOtp.trim(),
        });
        toast("Your Delivery Fast account is ready.");
        // Ask the new customer to confirm their email address (link + code by email).
        if (email) void df().auth.emailVerification.send().then(r => r.sent && toast(r.message)).catch(() => undefined);
        await site()?.signedIn(user);
      } catch (err) {
        const { mapped } = form.showServerError(err, paths);
        if (!mapped) form.setServerErrors({ signupOtp: describe(err) });
      }
    });
  };

  const field = (name: "signupName" | "signupEmail" | "signupPassword", label: string, placeholder: string, type = "text", required = true, autoComplete = "off") => (
    <div className="field">
      <label htmlFor={name}>{required ? `${label} *` : label}</label>
      <TextInput bound={form.bind(name)} error={form.error(name)} type={type} placeholder={placeholder} autoComplete={autoComplete} />
      <FieldError id={name} message={form.error(name)} />
    </div>
  );

  return (
    <div className="route-card">
      <h2>{pendingApplication ? "Create your Delivery Fast account" : "Join as a customer"}</h2>
      {pendingApplication ? (
        <p className="route-note" id="signupReturnNote">
          {`After you confirm your number we'll bring you back to your ${pendingApplication} application with what you typed.`}
        </p>
      ) : null}
      <form ref={form.formRef} id="signupForm" className="route-form" data-form="signup" data-react="1" noValidate onSubmit={submit}>
        {field("signupName", "Full name", "Your name", "text", true, "name")}
        <div className="field">
          <label htmlFor="signupPhone">Phone number *</label>
          <PhoneInput bound={form.bind("signupPhone")} error={form.error("signupPhone")} />
          <FieldError id="signupPhone" message={form.error("signupPhone")} />
        </div>
        {field("signupEmail", "Email address", "you@example.com", "email", false, "email")}
        {field("signupPassword", "Create password", "At least 10 characters with a number", "password", true, "new-password")}
        {codeFor ? (
          <div className="field">
            <label htmlFor="signupOtp">Verification code *</label>
            <TextInput bound={form.bind("signupOtp")} error={form.error("signupOtp")} placeholder="6-digit code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus />
            <small className="field-hint">{codeFor.hint}</small>
            <FieldError id="signupOtp" message={form.error("signupOtp")} />
          </div>
        ) : null}
        <div className="route-actions">
          <span className="route-note">
            {codeFor ? (
              countdown.left > 0 ? (
                `Didn't get it? You can request a new code in ${countdown.left} s.`
              ) : (
                <a role="button" tabIndex={0} style={linkStyle} onClick={e => (e.preventDefault(), void sendCode())}>
                  Send a new code
                </a>
              )
            ) : (
              "We'll text a 6-digit code to confirm your number."
            )}
          </span>
          <button className="button button-primary" type="submit" disabled={busy || (!codeFor && countdown.left > 0)}>
            {busy ? "Please wait…" : codeFor ? "Verify and create account" : countdown.left > 0 ? `Send code (${countdown.left} s)` : "Create customer account"}
          </button>
        </div>
      </form>
      <div className="route-reassure">
        {"Joining as a partner? Choose your application:"}
        <div className="route-split" style={{ marginTop: 11 }}>
          <a className="route-choice route-link" href="/merchant" data-route="merchant">
            {"Become a merchant →"}
          </a>
          <a className="route-choice route-link" href="/become-a-rider" data-route="rider">
            {"Apply as a rider →"}
          </a>
          <a className="route-choice route-link" href="/become-a-franchise" data-route="franchise">
            {"Become a franchise partner →"}
          </a>
          <a className="route-choice route-link" href="/login" data-route="login">
            {"Already have an account? Log in →"}
          </a>
        </div>
      </div>
    </div>
  );
}
