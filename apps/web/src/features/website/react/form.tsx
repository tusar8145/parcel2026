"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { bdPhoneProblem, emailSchema, otpCodeSchema, passwordSchema } from "@paira-express/shared";
import { fieldErrors, retryAfter } from "./df";

/**
 * Inline validation for the website's forms, with the same rules as the API
 * (packages/shared). Messages appear under a field after it was left once (blur) and
 * then update while typing; submitting shows all of them and focuses the first.
 */

export type Rule<V> = (value: string, values: V) => string | undefined | "";
export type Rules<V> = Partial<Record<keyof V & string, Rule<V>>>;

export function useForm<V extends Record<string, string>>(initial: V, rules: Rules<V>) {
  const [values, setValues] = useState<V>(initial);
  const [touched, setTouched] = useState<Partial<Record<string, boolean>>>({});
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const formRef = useRef<HTMLFormElement>(null);

  const problem = useCallback(
    (name: keyof V & string, all: V = values) => {
      const rule = rules[name];
      return (rule ? rule(all[name] ?? "", all) : "") || "";
    },
    [rules, values],
  );

  const error = (name: keyof V & string) => serverErrors[name] || (touched[name] ? problem(name) : "");

  const set = (name: keyof V & string, value: string) => {
    setValues(v => ({ ...v, [name]: value }));
    if (serverErrors[name]) setServerErrors(({ [name]: _, ...rest }) => rest);
  };

  const bind = (name: keyof V & string) => ({
    id: name,
    name,
    value: values[name] ?? "",
    onChange: (e: { target: { value: string } }) => set(name, e.target.value),
    onBlur: () => setTouched(t => ({ ...t, [name]: true })),
    "aria-invalid": error(name) ? true : undefined,
    "aria-describedby": error(name) ? `${name}-error` : undefined,
  });

  /** The given fields (all ruled fields by default) that currently have a problem, in rule order. */
  const invalid = (names: (keyof V & string)[] = Object.keys(rules) as (keyof V & string)[]) => names.filter(n => problem(n));

  /** Validates the given fields (all ruled fields by default); focuses the first problem. */
  const validate = (names: (keyof V & string)[] = Object.keys(rules) as (keyof V & string)[]) => {
    setTouched(t => ({ ...t, ...Object.fromEntries(names.map(n => [n, true])) }));
    const bad = names.find(n => problem(n));
    if (bad) requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>(`#${CSS.escape(bad)}`)?.focus());
    return !bad;
  };

  /**
   * Shows an API error under its fields. `paths` maps API detail paths (e.g. "sender.phone")
   * to field names; unmapped messages are returned for a toast.
   */
  const showServerError = (err: unknown, paths: Record<string, keyof V & string> = {}) => {
    const byPath = fieldErrors(err);
    const mapped: Record<string, string> = {};
    const rest: string[] = [];
    for (const [path, message] of Object.entries(byPath)) {
      const field = paths[path] ?? (path in values ? (path as keyof V & string) : undefined);
      if (field) mapped[field] = message;
      else rest.push(message);
    }
    setServerErrors(mapped);
    const first = Object.keys(mapped)[0];
    if (first) requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>(`#${CSS.escape(first)}`)?.focus());
    return { mapped: Object.keys(mapped).length > 0, rest, fields: Object.keys(mapped) as (keyof V & string)[] };
  };

  return { values, setValues, set, bind, error, validate, invalid, showServerError, setServerErrors, formRef, touched, setTouched };
}

// ───────────── shared rules (same as the API) ─────────────

const zodMessage = (schema: { safeParse(v: unknown): { success: boolean; error?: { issues: { message: string }[] } } }, value: unknown) => {
  const result = schema.safeParse(value);
  return result.success ? "" : result.error!.issues[0]?.message || "Check this field";
};

export const rules = {
  required:
    (message = "This field is required") =>
    (v: string) =>
      v.trim() ? "" : message,
  length:
    (min: number, max: number, label = "This field") =>
    (v: string) =>
      !v.trim() ? `${label} is required` : v.trim().length < min ? `Use at least ${min} characters` : v.trim().length > max ? `Use at most ${max} characters` : "",
  optionalMax: (max: number) => (v: string) => (v.trim().length > max ? `Use at most ${max} characters` : ""),
  phone: (v: string) => bdPhoneProblem(v) || "",
  optionalEmail: (v: string) => (v.trim() ? zodMessage(emailSchema, v) : ""),
  email: (v: string) => (v.trim() ? zodMessage(emailSchema, v) : "Enter your email address"),
  password: (v: string) => (v ? zodMessage(passwordSchema, v) : "Create a password"),
  otp: (v: string) => (v.trim() ? zodMessage(otpCodeSchema, v) : "Enter the 6-digit code"),
  identifier: (v: string) => {
    const value = v.trim();
    if (value.length < 3) return "Enter your email or mobile number";
    if (value.includes("@")) return zodMessage(emailSchema, value);
    if (/^[+\d\s-]+$/.test(value)) return bdPhoneProblem(value) || "";
    return "";
  },
};

/** The 10 digits after +880 ("+8801712345678" -> "1712345678"), what a +880 phone field shows. */
export const local10 = (phone: string | null | undefined) => String(phone ?? "").replace(/^\+?880/, "").replace(/^0(?=1)/, "");

/** "+8801712345678" for a BD number typed any accepted way (the API normalises too). */
export const e164 = (v: string) => {
  const digits = v.replace(/\D/g, "").replace(/^880/, "").replace(/^0(?=1)/, "");
  return digits ? `+880${digits}` : "";
};

// ───────────── fields (the website's own markup and classes) ─────────────

const errorStyle = { display: "block", marginTop: 4, color: "#c2410c", fontSize: 12 } as const;

export function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <small className="df-field-error" id={`${id}-error`} role="alert" style={errorStyle}>
      {message}
    </small>
  );
}

type Bound = ReturnType<ReturnType<typeof useForm>["bind"]>;

export function Field({
  label,
  required,
  full,
  hidden,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string;
  required?: boolean;
  full?: boolean;
  hidden?: boolean;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  htmlFor: string;
}) {
  return (
    <div className={full ? "field full" : "field"} hidden={hidden}>
      <label htmlFor={htmlFor}>{required ? `${label} *` : label}</label>
      {children}
      {hint ? <small className="field-hint">{hint}</small> : null}
      <FieldError id={htmlFor} message={error} />
    </div>
  );
}

const invalidBorder = (error?: string) => (error ? { borderColor: "#c2410c" } : undefined);

export function TextInput({ bound, error, ...rest }: { bound: Bound; error?: string } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "onBlur" | "id" | "name">) {
  return <input {...rest} {...bound} style={{ ...rest.style, ...invalidBorder(error) }} />;
}

/** Fixed +880 prefix; people may type 17XXXXXXXX or 017XXXXXXXX (the 0 is dropped). */
export function PhoneInput({ bound, error, placeholder = "17XXXXXXXX", disabled }: { bound: Bound; error?: string; placeholder?: string; disabled?: boolean }) {
  return (
    <div className="df-phone" style={{ display: "flex", alignItems: "stretch", width: "100%" }}>
      <span
        aria-hidden="true"
        style={{
          display: "inline-flex",
          alignItems: "center",
          padding: "0 10px",
          border: "1px solid #d9e2dc",
          borderRight: 0,
          borderRadius: "9px 0 0 9px",
          background: "#f4f7f5",
          color: "#5d6f6a",
          fontWeight: 600,
          fontSize: 14,
        }}
      >
        +880
      </span>
      <input
        {...bound}
        onChange={e => bound.onChange({ target: { value: e.target.value.replace(/\D/g, "").replace(/^880/, "").replace(/^0(?=1)/, "").slice(0, 10) } })}
        type="tel"
        inputMode="numeric"
        autoComplete="tel-national"
        placeholder={placeholder}
        maxLength={14}
        disabled={disabled}
        style={{ flex: 1, borderTopLeftRadius: 0, borderBottomLeftRadius: 0, ...invalidBorder(error) }}
      />
    </div>
  );
}

/** `search`: a searchable list (shared/select-search.js turns it into DF.searchSelect's popup). */
export function Select({ bound, error, options, placeholder, disabled, search }: { bound: Bound; error?: string; options: (string | [string, string])[]; placeholder?: string; disabled?: boolean; search?: boolean }) {
  return (
    <select {...bound} style={invalidBorder(error)} disabled={disabled} {...(search ? { "data-search": "" } : {})}>
      {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
      {options.map(o => {
        const [value, label] = Array.isArray(o) ? o : [o, o];
        return (
          <option key={value} value={value}>
            {label}
          </option>
        );
      })}
    </select>
  );
}

/** A countdown in seconds (e.g. until another code may be requested). */
export function useCountdown() {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (left <= 0) return;
    const timer = setTimeout(() => setLeft(s => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [left]);
  return { left, start: (seconds: number) => setLeft(Math.max(0, Math.ceil(seconds))) };
}

/** Starts the countdown from a 429's retry-after, or the server's resendAfterSeconds. */
export function cooldownFrom(result: { resendAfterSeconds?: number } | unknown, error?: unknown) {
  if (error) return retryAfter(error);
  return (result as { resendAfterSeconds?: number })?.resendAfterSeconds ?? 60;
}

/** Disables the submit button while a request runs (same look as the original buttons). */
export function useBusy() {
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}
