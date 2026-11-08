/**
 * Two-step verification (TOTP) for the signed-in user (shared/mfa.js): set it up (QR code + first code → recovery
 * codes), create new recovery codes, or turn it off (not allowed when the role requires it).
 *   GET /auth/mfa · POST /auth/mfa/setup · /auth/mfa/enable · /auth/mfa/recovery-codes · /auth/mfa/disable
 */
import { useEffect, useRef, useState } from "react";
import { api, describe } from "../lib/api";
import { saveText } from "../lib/csv";
import { openCustom } from "./dialogs";
import { Button, Loading, Pill } from "./kit";

interface Status {
  enabled: boolean;
  enabledAt?: string | null;
  recoveryCodesRemaining: number;
  required?: boolean;
}
type Step = { kind: "overview" } | { kind: "setup"; qrDataUrl: string; secret: string } | { kind: "codes"; codes: string[] } | { kind: "newCodes" } | { kind: "off" };

export const manageMfa = () => openCustom(close => <MfaDialog close={() => close()} />);

function MfaDialog({ close }: { close: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [step, setStep] = useState<Step>({ kind: "overview" });
  useEffect(() => {
    api<Status>("/auth/mfa").then(setStatus, e => setError(describe(e)));
  }, []);
  const refresh = async () => setStatus(await api<Status>("/auth/mfa"));
  async function setup() {
    setError("");
    try {
      const data = await api<{ qrDataUrl: string; secret: string }>("/auth/mfa/setup", { method: "POST", body: {} });
      setStep({ kind: "setup", ...data });
    } catch (e) {
      setError(describe(e));
    }
  }
  const head = (title: React.ReactNode, text?: React.ReactNode) => (
    <div className="dialog-head">
      <div>
        <h2>{title}</h2>
        {text ? <p>{text}</p> : null}
      </div>
    </div>
  );

  if (!status)
    return (
      <>
        {head("Two-step verification")}
        <div className="dialog-body">{error ? <p style={{ color: "var(--bad)" }}>{error}</p> : <Loading rows={2} />}</div>
        <div className="dialog-foot">
          <Button onClick={close}>Close</Button>
        </div>
      </>
    );

  if (step.kind === "setup")
    return (
      <CodeForm
        head={head("Scan the QR code", "Scan it with your authenticator app, then enter the 6-digit code it shows.")}
        before={
          <>
            <img src={step.qrDataUrl} alt="QR code for your authenticator app" style={{ display: "block", margin: "8px auto", width: 200, height: 200 }} />
            <p style={{ margin: "0 0 6px", color: "var(--muted)" }}>Can't scan? Enter this key in the app:</p>
            <code style={{ display: "block", wordBreak: "break-all", background: "var(--surface-3)", borderRadius: 8, padding: "8px 10px", fontSize: 13 }}>{(step.secret || "").replace(/(.{4})/g, "$1 ").trim()}</code>
          </>
        }
        label="Code from the app"
        button="Turn on"
        sixDigits
        onCancel={close}
        onSubmit={async code => {
          const result = await api<{ recoveryCodes: string[] }>("/auth/mfa/enable", { method: "POST", body: { code } });
          await refresh();
          setStep({ kind: "codes", codes: result.recoveryCodes });
        }}
      />
    );
  if (step.kind === "newCodes")
    return (
      <CodeForm
        head={head("New recovery codes", "Your old recovery codes stop working. Confirm with a code from your authenticator app.")}
        label="Code from the app"
        button="Create new codes"
        sixDigits
        onCancel={close}
        onSubmit={async code => {
          const result = await api<{ recoveryCodes: string[] }>("/auth/mfa/recovery-codes", { method: "POST", body: { code } });
          await refresh();
          setStep({ kind: "codes", codes: result.recoveryCodes });
        }}
      />
    );
  if (step.kind === "off")
    return (
      <CodeForm
        head={head("Turn off two-step verification", "Signing in will only need your password or SMS code. Confirm with a code from your app or a recovery code.")}
        label="Code"
        button="Turn off"
        danger
        onCancel={close}
        onSubmit={async code => {
          await api("/auth/mfa/disable", { method: "POST", body: { code } });
          await refresh();
          setStep({ kind: "overview" });
        }}
      />
    );
  if (step.kind === "codes") {
    const text = `Delivery Fast recovery codes (${new Date().toLocaleDateString()})\n\n${step.codes.join("\n")}\n`;
    return (
      <>
        {head("Save your recovery codes", "Each code signs you in once if you lose your phone. Keep them somewhere safe: they are shown only now.")}
        <div className="dialog-body">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, font: "600 14px ui-monospace, monospace" }}>
            {step.codes.map(c => (
              <span key={c} style={{ background: "var(--surface-3)", borderRadius: 6, padding: "6px 8px", textAlign: "center" }}>
                {c}
              </span>
            ))}
          </div>
        </div>
        <div className="dialog-foot">
          <CopyButton text={text} />
          <Button onClick={() => saveText("delivery-fast-recovery-codes.txt", text, "text/plain")}>Download</Button>
          <Button variant="primary" onClick={() => setStep({ kind: "overview" })}>
            I saved them
          </Button>
        </div>
      </>
    );
  }
  const on = status.enabled;
  return (
    <>
      {head(
        <>
          Two-step verification <Pill tone={on ? "good" : "bad"}>{on ? "On" : "Off"}</Pill>
        </>,
        <>
          {on
            ? `Signing in needs a code from your authenticator app${status.enabledAt ? ` (on since ${new Date(status.enabledAt).toLocaleDateString()})` : ""}. ${status.recoveryCodesRemaining} recovery code${status.recoveryCodesRemaining === 1 ? "" : "s"} left.`
            : "Protect your account with a code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…) in addition to your password or SMS code."}
          {status.required ? " Your role requires it." : ""}
        </>,
      )}
      {error ? (
        <div className="dialog-body">
          <p role="alert" style={{ color: "var(--bad)", margin: 0 }}>
            {error}
          </p>
        </div>
      ) : null}
      <div className="dialog-foot">
        {on ? (
          <>
            {status.required ? null : (
              <Button variant="danger" onClick={() => setStep({ kind: "off" })}>
                Turn off
              </Button>
            )}
            <Button onClick={() => setStep({ kind: "newCodes" })}>New recovery codes</Button>
            <Button variant="primary" onClick={close}>
              Done
            </Button>
          </>
        ) : (
          <>
            <Button onClick={close}>Not now</Button>
            <Button variant="primary" onClick={setup}>
              Set up
            </Button>
          </>
        )}
      </div>
    </>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return <Button onClick={() => navigator.clipboard?.writeText(text).then(() => setCopied(true), () => undefined)}>{copied ? "Copied" : "Copy"}</Button>;
}

function CodeForm({ head, before, label, button, danger, sixDigits, onSubmit, onCancel }: { head: React.ReactNode; before?: React.ReactNode; label: string; button: string; danger?: boolean; sixDigits?: boolean; onSubmit: (code: string) => Promise<void>; onCancel: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const value = code.trim().replace(/\s+/g, "");
    if (!(sixDigits ? /^\d{6}$/ : /^(\d{6}|[A-Za-z0-9]{5}-?[A-Za-z0-9]{5})$/).test(value)) return setError(sixDigits ? "Enter the 6-digit code from your authenticator app" : "Enter a 6-digit code or a recovery code");
    setBusy(true);
    setError("");
    try {
      await onSubmit(value);
    } catch (err) {
      setError(describe(err));
      setBusy(false);
      input.current?.select();
    }
  }
  return (
    <form onSubmit={submit} noValidate>
      {head}
      <div className="dialog-body">
        {before}
        <label className="field" style={{ marginTop: 10 }}>
          <span>{label}</span>
          <input ref={input} className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={20} value={code} onChange={e => setCode(e.target.value)} style={{ letterSpacing: ".08em" }} />
          {error ? (
            <span className="error" role="alert">
              {error}
            </span>
          ) : null}
        </label>
      </div>
      <div className="dialog-foot">
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant={danger ? "danger" : "primary"} disabled={busy} aria-busy={busy || undefined}>
          {button}
        </Button>
      </div>
    </form>
  );
}
