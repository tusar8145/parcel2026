/**
 * Sign in to a panel (Operations console, merchant panel): password (email or phone) or a one-time SMS code, then two-step verification when the
 * account uses it (or must set it up). Same endpoints and rules as the website's sign-in.
 */
import { useState } from "react";
import { bdPhoneProblem, normalizeBdPhone } from "@delivery-fast/shared/dist/phone.js";
import { acceptSession, authApi, describe, isSession, type MfaChallenge } from "../lib/api";

type Step = { kind: "form" } | { kind: "mfa"; token: string } | { kind: "setup"; token: string; qr?: string; secret?: string } | { kind: "codes"; codes: string[]; finish: () => void };

export default function Login({ notAllowed, product = "Operations console", heading = "Sign in to Operations" }: { notAllowed?: string; product?: string; heading?: string }) {
  const [mode, setMode] = useState<"password" | "otp">("password");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [code, setCode] = useState("");
  const [step, setStep] = useState<Step>({ kind: "form" });
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }
  async function next(result: Awaited<ReturnType<typeof authApi.login>>) {
    if (isSession(result)) return void acceptSession(result);
    const challenge = result as MfaChallenge;
    if (challenge.mfaSetupRequired) {
      setStep({ kind: "setup", token: challenge.mfaToken });
      const setup = await authApi.mfaSetup(challenge.mfaToken);
      setStep({ kind: "setup", token: challenge.mfaToken, qr: setup.qrDataUrl, secret: setup.secret });
    } else setStep({ kind: "mfa", token: challenge.mfaToken });
  }

  const brand = (
    <div className="auth-brand">
      <img src={`${import.meta.env.BASE_URL}logo.png`} alt="Delivery Fast" width={528} height={100} />
      <small className="faint">{product}</small>
    </div>
  );

  if (step.kind === "codes")
    return (
      <div className="center-page">
        <div className="auth-card">
          {brand}
          <h1>Save your recovery codes</h1>
          <p>Each code signs you in once if you lose your authenticator. Keep them somewhere safe; they are not shown again.</p>
          <pre style={{ padding: 12, background: "var(--surface-3)", borderRadius: 9, columns: 2, fontSize: 14 }}>{step.codes.join("\n")}</pre>
          <button className="button primary" style={{ width: "100%", marginTop: 12 }} onClick={step.finish}>
            I've saved them · continue
          </button>
        </div>
      </div>
    );

  return (
    <div className="center-page">
      <form
        className="auth-card"
        noValidate
        onSubmit={e => {
          e.preventDefault();
          if (busy) return;
          if (step.kind === "mfa") return void run(async () => void acceptSession(await authApi.loginMfa(step.token, code.trim())));
          if (step.kind === "setup")
            return void run(async () => {
              const result = await authApi.mfaEnable(step.token, code.trim());
              const codes = result.recoveryCodes ?? [];
              if (codes.length) setStep({ kind: "codes", codes, finish: () => acceptSession(result) });
              else acceptSession(result);
            });
          if (mode === "password") {
            if (!identifier.trim() || !password) return setError("Enter your email or phone and your password.");
            const id = identifier.includes("@") ? identifier.trim() : bdPhoneProblem(identifier) ? identifier.trim() : normalizeBdPhone(identifier);
            return void run(async () => next(await authApi.login(id, password)));
          }
          const problem = bdPhoneProblem(phone);
          if (problem) return setError(problem);
          if (!otpSent)
            return void run(async () => {
              const sent = await authApi.requestOtp(normalizeBdPhone(phone));
              setOtpSent(true);
              setNote(`We sent a code to ${phone}.${(sent as { devCode?: string }).devCode ? ` (Development code: ${(sent as { devCode?: string }).devCode})` : ""}`);
            });
          if (!otp.trim()) return setError("Enter the code from the SMS.");
          return void run(async () => next(await authApi.loginWithOtp(normalizeBdPhone(phone), otp.trim())));
        }}
      >
        {brand}
        {step.kind === "form" ? (
          <>
            <h1>{heading}</h1>
            {notAllowed ? <div className="callout warn">{notAllowed}</div> : <p style={{ margin: "6px 0 0" }}>For hub, dispatch, finance and support staff.</p>}
            <div className="segmented" role="group" aria-label="How to sign in">
              <button type="button" aria-pressed={mode === "password"} onClick={() => (setMode("password"), setError(""))}>
                Password
              </button>
              <button type="button" aria-pressed={mode === "otp"} onClick={() => (setMode("otp"), setError(""))}>
                SMS code
              </button>
            </div>
            {mode === "password" ? (
              <div className="stack">
                <label className="field">
                  <span>Email or phone</span>
                  <input className="input" autoComplete="username" value={identifier} onChange={e => setIdentifier(e.target.value)} autoFocus />
                </label>
                <label className="field">
                  <span>Password</span>
                  <input className="input" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} />
                </label>
                <a href="/forgot-password" style={{ fontSize: 13, justifySelf: "end" }}>
                  Forgot password?
                </a>
              </div>
            ) : (
              <div className="stack">
                <label className="field">
                  <span>Mobile number</span>
                  <div className="phone-input">
                    <span>+880</span>
                    <input className="input" inputMode="tel" autoComplete="tel" placeholder="1XXXXXXXXX" value={phone} onChange={e => (setPhone(e.target.value), setOtpSent(false))} autoFocus />
                  </div>
                </label>
                {otpSent ? (
                  <label className="field">
                    <span>Code from the SMS</span>
                    <input className="input" inputMode="numeric" autoComplete="one-time-code" value={otp} onChange={e => setOtp(e.target.value)} autoFocus />
                  </label>
                ) : null}
                {note ? <small className="muted">{note}</small> : null}
              </div>
            )}
          </>
        ) : step.kind === "mfa" ? (
          <>
            <h1>Two-step verification</h1>
            <p>Enter the 6-digit code from your authenticator app, or one of your recovery codes.</p>
            <label className="field">
              <span>Code</span>
              <input className="input" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={e => setCode(e.target.value)} autoFocus />
            </label>
          </>
        ) : (
          <>
            <h1>Set up two-step verification</h1>
            <p>Your role must use it. Scan the code with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password), then enter the 6-digit code it shows.</p>
            {step.qr ? <img src={step.qr} alt="QR code for your authenticator app" width={180} height={180} style={{ display: "block", margin: "8px auto" }} /> : <div className="spinner" style={{ margin: "16px auto" }} />}
            {step.secret ? (
              <p style={{ fontSize: 12, textAlign: "center" }}>
                Or type this key: <code>{step.secret}</code>
              </p>
            ) : null}
            <label className="field">
              <span>Code</span>
              <input className="input" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={e => setCode(e.target.value)} autoFocus />
            </label>
          </>
        )}
        {error ? (
          <div className="form-error" role="alert">
            {error}
          </div>
        ) : null}
        <button className="button primary" type="submit" style={{ width: "100%", marginTop: 16, minHeight: 40 }} aria-busy={busy || undefined} disabled={busy}>
          {step.kind !== "form" ? "Verify" : mode === "otp" && !otpSent ? "Send code" : "Sign in"}
        </button>
        {step.kind !== "form" ? (
          <button type="button" className="button ghost" style={{ width: "100%", marginTop: 8 }} onClick={() => (setStep({ kind: "form" }), setCode(""), setError(""))}>
            Back
          </button>
        ) : null}
      </form>
    </div>
  );
}
