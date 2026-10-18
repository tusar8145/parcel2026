"use client";

import { useEffect, useState } from "react";
import { df, describe, site, toast, type MfaChallenge, type SessionUser } from "./df";
import { Field, PhoneInput, TextInput, cooldownFrom, e164, rules, useBusy, useCountdown, useForm } from "./form";

type Step = "password" | "otp" | "reset" | "mfa" | "mfaSetup" | "recovery";

const isChallenge = (r: SessionUser | MfaChallenge): r is MfaChallenge => "mfaToken" in r && !!(r.mfaRequired || r.mfaSetupRequired);

const linkStyle = { color: "var(--green)", fontWeight: 700, cursor: "pointer" } as const;

/** A partner application waiting for this sign-in ("merchant", "rider", "franchise"), if any. */
export function pendingPartnerRoute(): string {
  try {
    const route = (sessionStorage.getItem("deliveryfast-customer-return-route") || "").split("/")[0];
    return ["merchant", "rider", "franchise"].includes(route) ? route : "";
  } catch {
    return "";
  }
}

/**
 * Someone already signed in who opens Login or Sign up goes straight to their own panel (or account),
 * the same way a fresh sign-in would. Using another account means signing out first.
 * Returns the signed-in user once the session check is done (null when signed out), or undefined while checking.
 */
export function useAlreadySignedIn(): SessionUser | null | undefined {
  const [state, setState] = useState<SessionUser | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    // Wait for "legacy-ready": the session is restored and the website bridge (DFWebsite) has loaded.
    const finish = () => {
      if (!live) return;
      const user = (window as unknown as { DF?: { auth?: { user?: SessionUser | null } } }).DF?.auth?.user ?? null;
      setState(user);
      if (user) void site()?.signedIn(user);
    };
    const root = document.documentElement;
    if (root.classList.contains("legacy-ready")) {
      finish();
      return () => {
        live = false;
      };
    }
    const observer = new MutationObserver(() => {
      if (!root.classList.contains("legacy-ready")) return;
      observer.disconnect();
      finish();
    });
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => {
      live = false;
      observer.disconnect();
    };
  }, []);
  return state;
}

/** Shown instead of the form while an already signed-in user is sent on to their panel. */
export function AlreadySignedIn({ user }: { user: SessionUser | null | undefined }) {
  if (user === undefined) return <div className="route-card route-form" aria-busy="true" style={{ minHeight: 120 }} />;
  if (!user) return null;
  return (
    <div className="route-card route-form" id="alreadySignedIn" role="status">
      <p style={{ margin: 0 }}>{`You're signed in as ${user.name}. Opening your workspace…`}</p>
      <p style={{ margin: "10px 0 0", fontSize: 13 }}>
        {"To use a different account, "}
        <span
          role="button"
          tabIndex={0}
          style={linkStyle}
          onClick={() => void df().auth.logout().then(() => location.reload())}
          onKeyDown={e => (e.key === "Enter" || e.key === " ") && void df().auth.logout().then(() => location.reload())}
        >
          {"sign out first"}
        </span>
        {"."}
      </p>
    </div>
  );
}

/** Sign-in: password or SMS code, forgot password, and the two-step verification screens. */
export default function LoginView() {
  const signedIn = useAlreadySignedIn();
  const [step, setStep] = useState<Step>("password");
  const [challenge, setChallenge] = useState<MfaChallenge | null>(null);
  const [recovery, setRecovery] = useState<{ codes: string[]; user: SessionUser } | null>(null);

  /** A session or a second-step challenge from any sign-in method. */
  const afterFirstStep = async (result: SessionUser | MfaChallenge) => {
    if (isChallenge(result)) {
      setChallenge(result);
      setStep(result.mfaSetupRequired ? "mfaSetup" : "mfa");
      return;
    }
    toast(`Signed in as ${result.name}.`);
    await site()?.signedIn(result);
  };

  // Already signed in (and not mid-way through a two-step sign-in started on this page): go to the panel.
  if (signedIn !== null && step === "password") return <AlreadySignedIn user={signedIn} />;
  if (step === "mfa" && challenge) return <MfaForm challenge={challenge} onBack={() => setStep("password")} />;
  if (step === "mfaSetup" && challenge)
    return (
      <MfaSetupForm
        challenge={challenge}
        onBack={() => setStep("password")}
        onEnabled={(user, codes) => {
          setRecovery({ user, codes });
          setStep("recovery");
        }}
      />
    );
  if (step === "recovery" && recovery) return <RecoveryCodes codes={recovery.codes} onDone={() => site()?.signedIn(recovery.user)} />;
  if (step === "otp" || step === "reset") return <CodeForm kind={step} onBack={() => setStep("password")} onSession={afterFirstStep} />;
  return <PasswordForm onSession={afterFirstStep} onFlow={setStep} />;
}

function PasswordForm({ onSession, onFlow }: { onSession: (r: SessionUser | MfaChallenge) => Promise<void>; onFlow: (s: Step) => void }) {
  const form = useForm({ loginIdentity: "", loginPassword: "" }, { loginIdentity: rules.identifier, loginPassword: v => (v ? "" : "Enter your password") });
  const { busy, run } = useBusy();
  const [pendingApplication] = useState(pendingPartnerRoute);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.validate()) return;
    void run(async () => {
      try {
        await onSession(await df().auth.login(form.values.loginIdentity.trim(), form.values.loginPassword));
      } catch (err) {
        const { mapped } = form.showServerError(err, { identifier: "loginIdentity", password: "loginPassword" });
        if (!mapped) form.setServerErrors({ loginPassword: describe(err) });
      }
    });
  };
  return (
    <form ref={form.formRef} id="loginForm" className="route-card route-form" data-form="login" data-react="1" noValidate onSubmit={submit}>
      {pendingApplication ? (
        <p className="field full route-reassure" id="loginReturnNote" style={{ margin: 0 }}>
          {`Sign in to send your ${pendingApplication} application. We'll bring you back to it with what you typed. New to Delivery Fast? `}
          <a href="/signup" data-route="signup">
            {"Create an account →"}
          </a>
        </p>
      ) : null}
      <Field label="Email or phone" required htmlFor="loginIdentity" error={form.error("loginIdentity")}>
        <TextInput bound={form.bind("loginIdentity")} error={form.error("loginIdentity")} placeholder="you@example.com or 017XXXXXXXX" autoComplete="username" />
      </Field>
      <Field label="Password" required htmlFor="loginPassword" error={form.error("loginPassword")}>
        <TextInput bound={form.bind("loginPassword")} error={form.error("loginPassword")} type="password" placeholder="Enter your password" autoComplete="current-password" />
      </Field>
      <div className="route-actions">
        <span className="route-note">{"Customers, merchants, riders and staff all sign in here."}</span>
        <button className="button button-primary" type="submit" disabled={busy}>
          {busy ? "Please wait…" : "Log in"}
        </button>
      </div>
      <p className="auth-links field full" style={{ display: "flex", gap: 16, flexWrap: "wrap", margin: "4px 0 0", fontSize: 13 }}>
        <a role="button" tabIndex={0} data-auth-flow="reset" style={linkStyle} onClick={e => (e.preventDefault(), onFlow("reset"))}>
          Forgot password?
        </a>
        <a role="button" tabIndex={0} data-auth-flow="otp" style={linkStyle} onClick={e => (e.preventDefault(), onFlow("otp"))}>
          Sign in with an SMS code
        </a>
      </p>
      <p className="field full route-reassure">
        {"New to Delivery Fast? "}
        <a href="/signup" data-route="signup">
          {"Create an account →"}
        </a>
      </p>
    </form>
  );
}

/** Phone → SMS code (→ new password). Resend waits for the server's cooldown. */
function CodeForm({ kind, onBack, onSession }: { kind: "otp" | "reset"; onBack: () => void; onSession: (r: SessionUser | MfaChallenge) => Promise<void> }) {
  const [sent, setSent] = useState<{ hint: string } | null>(null);
  const countdown = useCountdown();
  const form = useForm(
    { flowPhone: "", flowOtp: "", flowPassword: "" },
    {
      flowPhone: rules.phone,
      flowOtp: v => (sent ? rules.otp(v) : ""),
      flowPassword: v => (sent && kind === "reset" ? rules.password(v) : ""),
    },
  );
  const { busy, run } = useBusy();
  const purpose = kind === "reset" ? "PASSWORD_RESET" : "LOGIN";

  const sendCode = () =>
    run(async () => {
      if (!form.validate(["flowPhone"])) return;
      try {
        const result = await df().auth.requestOtp(e164(form.values.flowPhone), purpose);
        setSent({ hint: result.devCode ? `Development code: ${result.devCode}` : "We sent a 6-digit code by SMS." });
        countdown.start(cooldownFrom(result));
        toast(result.message);
      } catch (err) {
        const wait = cooldownFrom(null, err);
        if (wait) countdown.start(wait);
        const { mapped } = form.showServerError(err, { phone: "flowPhone" });
        if (!mapped) form.setServerErrors({ flowPhone: describe(err) });
      }
    });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!sent) return void sendCode();
    if (!form.validate()) return;
    void run(async () => {
      const phone = e164(form.values.flowPhone);
      try {
        if (kind === "reset") {
          const result = await df().auth.resetPassword({ phone, otp: form.values.flowOtp.trim(), password: form.values.flowPassword });
          toast(result.message);
          onBack();
          return;
        }
        await onSession(await df().auth.loginWithOtp(phone, form.values.flowOtp.trim()));
      } catch (err) {
        const { mapped } = form.showServerError(err, { phone: "flowPhone", otp: "flowOtp", password: "flowPassword" });
        if (!mapped) form.setServerErrors({ flowOtp: describe(err) });
      }
    });
  };

  return (
    <form ref={form.formRef} className="route-card route-form" data-form={kind === "reset" ? "reset" : "otp-login"} data-react="1" noValidate onSubmit={submit}>
      <h3 className="field full" style={{ margin: "0 0 6px" }}>
        {kind === "reset" ? "Reset your password" : "Sign in with an SMS code"}
      </h3>
      <Field label="Mobile number" required htmlFor="flowPhone" error={form.error("flowPhone")}>
        <PhoneInput bound={form.bind("flowPhone")} error={form.error("flowPhone")} />
      </Field>
      {sent ? (
        <>
          <Field label="Verification code" required htmlFor="flowOtp" error={form.error("flowOtp")} hint={sent.hint}>
            <TextInput bound={form.bind("flowOtp")} error={form.error("flowOtp")} placeholder="6-digit code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus />
          </Field>
          {kind === "reset" ? (
            <Field label="New password" required htmlFor="flowPassword" error={form.error("flowPassword")}>
              <TextInput bound={form.bind("flowPassword")} error={form.error("flowPassword")} type="password" placeholder="At least 10 characters with a number" autoComplete="new-password" />
            </Field>
          ) : null}
        </>
      ) : null}
      <div className="route-actions">
        <span className="route-note">
          {sent ? (
            countdown.left > 0 ? (
              `You can request a new code in ${countdown.left} s.`
            ) : (
              <a role="button" tabIndex={0} style={linkStyle} onClick={e => (e.preventDefault(), void sendCode())}>
                Send a new code
              </a>
            )
          ) : (
            "We'll send a 6-digit code to this number."
          )}
        </span>
        <div className="route-action-buttons">
          <button className="button button-quiet" type="button" data-auth-flow="back" onClick={onBack}>
            Back to sign in
          </button>
          <button className="button button-primary" type="submit" disabled={busy || (!sent && countdown.left > 0)}>
            {busy ? "Please wait…" : !sent ? (countdown.left > 0 ? `Send code (${countdown.left} s)` : "Send code") : kind === "reset" ? "Change password" : "Sign in"}
          </button>
        </div>
      </div>
    </form>
  );
}

/** Second step: a code from the authenticator app, or a recovery code. */
function MfaForm({ challenge, onBack }: { challenge: MfaChallenge; onBack: () => void }) {
  const [useRecovery, setUseRecovery] = useState(false);
  const form = useForm(
    { mfaCode: "" },
    { mfaCode: v => (!v.trim() ? "Enter the code" : useRecovery ? (v.replace(/[\s-]/g, "").length < 8 ? "Enter the whole recovery code" : "") : /^\d{6}$/.test(v.trim()) ? "" : "Enter the 6-digit code from your authenticator app") },
  );
  const { busy, run } = useBusy();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.validate()) return;
    void run(async () => {
      try {
        const user = await df().auth.loginMfa(challenge.mfaToken, form.values.mfaCode.trim());
        toast(`Signed in as ${user.name}.`);
        await site()?.signedIn(user);
      } catch (err) {
        if ((err as { code?: string }).code === "MFA_CHALLENGE_EXPIRED") {
          toast("That sign-in took too long. Please sign in again.");
          return onBack();
        }
        const { mapped } = form.showServerError(err, { code: "mfaCode" });
        if (!mapped) form.setServerErrors({ mfaCode: describe(err) });
      }
    });
  };
  return (
    <form ref={form.formRef} className="route-card route-form" data-form="mfa" data-react="1" noValidate onSubmit={submit}>
      <h3 className="field full" style={{ margin: "0 0 6px" }}>
        Two-step verification
      </h3>
      <p className="field full route-note">
        {useRecovery ? "Enter one of the recovery codes you saved when you turned on two-step verification. Each code works once." : "Open your authenticator app and enter the 6-digit code for Delivery Fast."}
      </p>
      <Field label={useRecovery ? "Recovery code" : "Authentication code"} required htmlFor="mfaCode" error={form.error("mfaCode")}>
        <TextInput
          bound={form.bind("mfaCode")}
          error={form.error("mfaCode")}
          placeholder={useRecovery ? "XXXX-XXXX" : "6-digit code"}
          inputMode={useRecovery ? "text" : "numeric"}
          autoComplete="one-time-code"
          autoFocus
        />
      </Field>
      <div className="route-actions">
        <span className="route-note">
          {challenge.methods?.includes("recovery") !== false ? (
            <a
              role="button"
              tabIndex={0}
              style={linkStyle}
              onClick={e => {
                e.preventDefault();
                setUseRecovery(r => !r);
                form.set("mfaCode", "");
              }}
            >
              {useRecovery ? "Use your authenticator app" : "Use a recovery code"}
            </a>
          ) : null}
        </span>
        <div className="route-action-buttons">
          <button className="button button-quiet" type="button" onClick={onBack}>
            Back
          </button>
          <button className="button button-primary" type="submit" disabled={busy}>
            {busy ? "Please wait…" : "Verify and sign in"}
          </button>
        </div>
      </div>
    </form>
  );
}

/** Roles that must use two-step verification enrol before their first session. */
function MfaSetupForm({ challenge, onBack, onEnabled }: { challenge: MfaChallenge; onBack: () => void; onEnabled: (user: SessionUser, codes: string[]) => void }) {
  const [setup, setSetup] = useState<{ qrDataUrl: string; otpauthUrl: string; secret?: string } | null>(null);
  const [loadError, setLoadError] = useState("");
  const form = useForm({ mfaSetupCode: "" }, { mfaSetupCode: v => (/^\d{6}$/.test(v.trim()) ? "" : "Enter the 6-digit code from your authenticator app") });
  const { busy, run } = useBusy();

  useEffect(() => {
    let live = true;
    df()
      .auth.mfaSetup(challenge.mfaToken)
      .then(result => live && setSetup(result))
      .catch(err => live && setLoadError(describe(err)));
    return () => {
      live = false;
    };
  }, [challenge.mfaToken]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.validate()) return;
    void run(async () => {
      try {
        const result = await df().auth.mfaEnable(challenge.mfaToken, form.values.mfaSetupCode.trim());
        onEnabled(result.user, result.recoveryCodes);
      } catch (err) {
        const { mapped } = form.showServerError(err, { code: "mfaSetupCode" });
        if (!mapped) form.setServerErrors({ mfaSetupCode: describe(err) });
      }
    });
  };
  const secret = setup?.secret ?? setup?.otpauthUrl.match(/secret=([A-Z2-7]+)/i)?.[1];
  return (
    <form ref={form.formRef} className="route-card route-form" data-form="mfa-setup" data-react="1" noValidate onSubmit={submit}>
      <h3 className="field full" style={{ margin: "0 0 6px" }}>
        Set up two-step verification
      </h3>
      <p className="field full route-note">
        {"Your account must use two-step verification. Scan this QR code with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password …), then enter the 6-digit code it shows."}
      </p>
      <div className="field full" style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
        {setup ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={setup.qrDataUrl} alt="QR code for your authenticator app" width={180} height={180} style={{ border: "1px solid #dfe8e2", borderRadius: 8 }} />
            {secret ? (
              <small style={{ maxWidth: 260 }}>
                {"Can't scan it? Enter this key: "}
                <code style={{ wordBreak: "break-all", fontWeight: 700 }}>{secret}</code>
              </small>
            ) : null}
          </>
        ) : (
          <span className="route-note">{loadError || "Preparing your QR code…"}</span>
        )}
      </div>
      <Field label="Code from the app" required htmlFor="mfaSetupCode" error={form.error("mfaSetupCode")}>
        <TextInput bound={form.bind("mfaSetupCode")} error={form.error("mfaSetupCode")} placeholder="6-digit code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} />
      </Field>
      <div className="route-actions">
        <span className="route-note">{"You'll get recovery codes next. Keep them somewhere safe."}</span>
        <div className="route-action-buttons">
          <button className="button button-quiet" type="button" onClick={onBack}>
            Cancel
          </button>
          <button className="button button-primary" type="submit" disabled={busy || !setup}>
            {busy ? "Please wait…" : "Turn on and sign in"}
          </button>
        </div>
      </div>
    </form>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <div className="route-card route-form" data-form="mfa-recovery">
      <h3 className="field full" style={{ margin: "0 0 6px" }}>
        Save your recovery codes
      </h3>
      <p className="field full route-note">{"If you lose your phone, each of these codes lets you sign in once. They won't be shown again."}</p>
      <div className="field full" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8, fontFamily: "monospace", fontSize: 15 }}>
        {codes.map(code => (
          <code key={code} style={{ padding: "8px 10px", border: "1px solid #dfe8e2", borderRadius: 8, background: "#f8faf8" }}>
            {code}
          </code>
        ))}
      </div>
      <div className="route-actions">
        <button className="button button-quiet" type="button" onClick={() => void navigator.clipboard?.writeText(codes.join("\n")).then(() => toast("Recovery codes copied."))}>
          Copy codes
        </button>
        <button className="button button-primary" type="button" onClick={onDone}>
          {"I've saved them — continue"}
        </button>
      </div>
    </div>
  );
}
