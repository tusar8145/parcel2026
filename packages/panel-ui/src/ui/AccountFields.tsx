/**
 * The account part of the "add" forms (super admin › Riders, Franchises, Invite a merchant): an optional password
 * (typed or generated, shared by hand), and the sign-in SMS, off by default, with the exact text shown first
 * (POST /accounts/invite-preview).
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { FormField, FormValues } from "./dialogs";

export interface PreviewInput {
  kind: "rider" | "franchise" | "merchant" | "merchant_onboard";
  name?: string;
  hubId?: string;
  code?: string;
  franchiseName?: string;
  businessName?: string;
  merchantType?: string;
}

/** A password the rules accept: 12 characters, letters and digits, no look-alikes. */
export function generatePassword() {
  const letters = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  const pick = (set: string) => set[crypto.getRandomValues(new Uint32Array(1))[0] % set.length];
  const chars = Array.from({ length: 10 }, () => pick(letters + digits));
  chars.push(pick(digits), pick(letters));
  return chars.sort(() => crypto.getRandomValues(new Uint8Array(1))[0] - 128).join("");
}

function Preview({ input }: { input: PreviewInput }) {
  // Typing settles first.
  const [settled, setSettled] = useState(input);
  const key = JSON.stringify(input);
  useEffect(() => {
    const t = setTimeout(() => setSettled(input), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const q = useQuery({
    queryKey: ["invite-preview", JSON.stringify(settled)],
    queryFn: () => api<{ sms: string | null; segments: { segments: number; length: number } | null; emailSubject: string | null }>("/accounts/invite-preview", { method: "POST", body: settled }),
    staleTime: 60_000,
  });
  if (q.isLoading) return <span className="faint">Preparing the message…</span>;
  if (q.isError || !q.data) return <span className="faint">The message preview isn't available.</span>;
  if (!q.data.sms) return <span className="faint">The SMS for this message is switched off in Notification settings.</span>;
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <div style={{ whiteSpace: "pre-wrap", padding: "9px 11px", border: "1px solid var(--line)", borderRadius: 8, background: "var(--surface-2, #f6f8fb)", fontSize: 13, color: "var(--ink)" }}>{q.data.sms}</div>
      <small className="faint">
        {[q.data.segments ? `${q.data.segments.length} characters · ${q.data.segments.segments} SMS` : "", q.data.emailSubject ? `Email too, when there is an address: “${q.data.emailSubject}”` : ""].filter(Boolean).join(" · ")}
      </small>
    </div>
  );
}

/**
 * The fields: password, a Generate button, the "Send SMS" switch (off) and the message preview.
 * `preview` turns the form's values into the preview request.
 */
export function accountFields(preview: (values: FormValues) => PreviewInput, opts: { password?: boolean; passwordHint?: string } = {}): FormField[] {
  return [
    ...(opts.password === false
      ? []
      : ([
          {
            id: "password",
            label: "Password",
            maxLength: 128,
            placeholder: "At least 10 characters, a letter and a number",
            hint: opts.passwordHint ?? "Set it to share it yourself (it isn't sent). Empty: they sign in with a code sent to their mobile.",
          },
          {
            id: "passwordTools",
            label: "",
            type: "static",
            live: (_values: FormValues, set: (id: string, value: string) => void) => (
              <button type="button" className="button sm" onClick={() => set("password", generatePassword())}>
                Generate a password
              </button>
            ),
          },
        ] as FormField[])),
    { id: "sendSms", label: "Send the sign-in message now (SMS, and email when given)", type: "checkbox", value: false, full: true },
    {
      id: "smsPreview",
      label: "Message",
      type: "static",
      live: (values: FormValues) => (
        <div style={{ display: "grid", gap: 4 }}>
          <small className="faint">{values.sendSms === "true" ? "This goes out when you save:" : "Not sent (switch above is off). This is what it would say:"}</small>
          <Preview input={preview(values)} />
        </div>
      ),
    },
  ];
}

/** The form's password check (empty is fine). */
export const passwordProblem = (v: string) => (!v ? "" : v.length < 10 ? "Use at least 10 characters" : !/[A-Za-z]/.test(v) || !/\d/.test(v) ? "Use at least one letter and one number" : "");
