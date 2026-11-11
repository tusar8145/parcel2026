/**
 * Dialogs opened from anywhere (no prop drilling): confirm, prompt and forms, like Ops.confirm / Ops.prompt /
 * Ops.form in the legacy panel. One host renders them on the native <dialog> (focus trap, Escape, backdrop).
 *
 *   await confirm({ title, message, ok, danger })                → boolean
 *   await prompt({ title, message, label, value, required })     → string | null
 *   await openForm({ title, description, submit, wide, fields, validate, review, confirm, onSubmit })
 *     fields: { id, label, type: text|number|date|datetime-local|month|time|email|phone|select|textarea|static|checkbox|file,
 *               value, options [{value,label}], required, placeholder, hint, full, min, max, step, maxLength, rows,
 *               show: values => bool, render (static) }
 *     onSubmit(values) → a success message (toast) or nothing; throw to keep the dialog open with the error inside.
 *     Resolves the submitted values, or null when cancelled.
 *   openCustom(render) → a dialog with any content (render gets `close`).
 */
import { Select } from "./Select";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { dialogOpened } from "./dialogSignal";
import { Icon } from "./Icon";
import { bdPhoneProblem, normalizeBdPhone } from "@delivery-fast/shared/dist/phone.js";
import { describe } from "../lib/api";
import { toast } from "./toast";

export interface FieldOption {
  value: string;
  label: string;
  disabled?: boolean;
  group?: string;
}
export interface FormField {
  id: string;
  label: string;
  type?: "text" | "number" | "date" | "datetime-local" | "month" | "time" | "email" | "phone" | "select" | "textarea" | "static" | "checkbox" | "checks" | "file" | "password";
  value?: string | number | boolean | null;
  /** Fixed, or worked out from the other values (zones of the chosen district). */
  options?: FieldOption[] | ((values: FormValues) => FieldOption[]);
  required?: boolean;
  placeholder?: string;
  hint?: ReactNode;
  full?: boolean;
  min?: string | number;
  max?: string | number;
  step?: string | number;
  maxLength?: number;
  rows?: number;
  accept?: string;
  show?: (values: FormValues) => boolean;
  render?: ReactNode;
  /** A static field drawn from the form's current values (a message preview, a "Generate" button that fills a field). */
  live?: (values: FormValues, set: (id: string, value: string) => void) => ReactNode;
  /** Typed text with suggestions (a datalist). */
  suggestions?: string[];
}
export type FormValues = Record<string, string> & { __files?: Record<string, File | null> };
export interface FormConfig {
  title: string;
  description?: ReactNode;
  submit?: string;
  danger?: boolean;
  wide?: boolean;
  fields: FormField[];
  validate?: Record<string, (value: string, values: FormValues) => string | undefined | "">;
  review?: (values: FormValues) => [string, ReactNode][] | null;
  confirm?: string;
  onSubmit?: (values: FormValues) => Promise<string | void> | string | void;
}

type Entry = { id: number; render: (close: (value: unknown) => void) => ReactNode; resolve: (value: unknown) => void; size?: "wide" | "xwide" };
let entries: Entry[] = [];
let seq = 0;
const subs = new Set<() => void>();
const emit = () => subs.forEach(s => s());

function open<T>(render: Entry["render"], size?: Entry["size"]): Promise<T> {
  return new Promise<T>(resolve => {
    const id = ++seq;
    entries = [...entries, { id, render, resolve: resolve as (v: unknown) => void, size }];
    emit();
    dialogOpened();
  });
}
function close(id: number, value: unknown) {
  const entry = entries.find(e => e.id === id);
  entries = entries.filter(e => e.id !== id);
  emit();
  entry?.resolve(value);
}

export function openCustom<T = unknown>(render: (close: (value?: T) => void) => ReactNode, size?: Entry["size"]) {
  return open<T | undefined>(render as Entry["render"], size);
}

export const confirm = ({ title, message, ok = "OK", cancel = "Cancel", danger = false }: { title: string; message?: ReactNode; ok?: string; cancel?: string; danger?: boolean }) =>
  open<boolean>(done => (
    <>
      <DialogHead title={title} description={message} onClose={() => done(false)} />
      <div className="dialog-foot">
        <button type="button" className="button" onClick={() => done(false)}>
          {cancel}
        </button>
        <button type="button" className={`button ${danger ? "danger solid" : "primary"}`} autoFocus onClick={() => done(true)}>
          {ok}
        </button>
      </div>
    </>
  ));

export const alertDialog = ({ title, message }: { title: string; message?: ReactNode }) =>
  open<void>(done => (
    <>
      <DialogHead title={title} description={message} />
      <div className="dialog-foot">
        <button type="button" className="button primary" autoFocus onClick={() => done(undefined)}>
          OK
        </button>
      </div>
    </>
  ));

export async function prompt({ title, message, label = "", value = "", required = true, ok = "OK", multiline = false, placeholder }: { title: string; message?: ReactNode; label?: string; value?: string; required?: boolean; ok?: string; multiline?: boolean; placeholder?: string }) {
  const result = await openForm({ title, description: message, submit: ok, fields: [{ id: "value", label: label || title, type: multiline ? "textarea" : "text", value, required, placeholder }] });
  return result ? result.value : null;
}

export function openForm(config: FormConfig) {
  return open<FormValues | null>(done => <FormDialog config={config} done={done} />, config.wide ? "wide" : undefined);
}

function DialogHead({ title, description, onClose }: { title: ReactNode; description?: ReactNode; onClose?: () => void }) {
  return (
    <div className="dialog-head">
      <div>
        <h2>{title}</h2>
        {description ? typeof description === "string" ? <p>{description}</p> : <div style={{ marginTop: 6, color: "var(--muted)", fontSize: 13 }}>{description}</div> : null}
      </div>
      {onClose ? (
        <button type="button" className="button ghost icon dialog-close" aria-label="Close" onClick={onClose}>
          <Icon name="x" size={18} />
        </button>
      ) : null}
    </div>
  );
}

const initialValues = (fields: FormField[]): FormValues => {
  const out: FormValues = {};
  for (const f of fields) if (f.type !== "static") out[f.id] = f.type === "checkbox" ? (f.value ? "true" : "") : f.value == null ? "" : String(f.value);
  return out;
};

function FormDialog({ config, done }: { config: FormConfig; done: (v: unknown) => void }) {
  const [values, setValues] = useState<FormValues>(() => initialValues(config.fields));
  const [files, setFiles] = useState<Record<string, File | null>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<[string, ReactNode][] | null>(null);
  const visible = (f: FormField) => !f.show || f.show(values);

  const check = (f: FormField, v = values): string => {
    if (!visible(f) || f.type === "static") return "";
    const value = (v[f.id] ?? "").trim();
    if (f.type === "file") return f.required && !files[f.id] ? "Choose a file" : "";
    if (f.required && !value) return f.type === "select" ? "Choose one" : f.type === "checks" ? "Choose at least one" : "This field is required";
    if (f.type === "phone" && value) return bdPhoneProblem(value) ?? "";
    return config.validate?.[f.id]?.(value, v) || "";
  };
  const set = (id: string, value: string) => {
    const next = { ...values, [id]: value };
    setValues(next);
    if (errors[id]) setErrors(e => ({ ...e, [id]: check(config.fields.find(f => f.id === id)!, next) }));
  };
  const output = (): FormValues => {
    const out: FormValues = {};
    for (const f of config.fields) {
      if (f.type === "static") continue;
      const v = (values[f.id] ?? "").trim();
      out[f.id] = f.type === "phone" && v ? normalizeBdPhone(v) : v;
    }
    out.__files = files;
    return out;
  };

  async function submit(event?: React.FormEvent) {
    event?.preventDefault();
    if (busy) return;
    if (!review) {
      const found: Record<string, string> = {};
      for (const f of config.fields) {
        const message = check(f);
        if (message) found[f.id] = message;
      }
      setErrors(found);
      if (Object.keys(found).length) {
        document.getElementById(`of_${Object.keys(found)[0]}`)?.focus();
        return;
      }
      const lines = config.review?.(output());
      if (lines) return void setReview(lines);
    }
    setBusy(true);
    setFormError("");
    try {
      const message = await config.onSubmit?.(output());
      if (message) toast(message, "good");
      done(output());
    } catch (error) {
      setFormError(error instanceof Error && !("status" in error) ? error.message : describe(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <DialogHead title={config.title} description={review ? "Check the details, then confirm." : config.description} onClose={busy ? undefined : () => done(null)} />
      <div className="dialog-body">
        {review ? (
          <dl className="kv">
            {review.map(([k, v]) => (
              <div key={k} style={{ display: "contents" }}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <div className="form-grid">
            {config.fields.filter(visible).map(f => (
              <Field key={f.id} field={typeof f.options === "function" ? { ...f, options: f.options(values) } : f.live ? { ...f, render: f.live(values, set) } : f} value={values[f.id] ?? ""} error={errors[f.id]} onChange={v => set(f.id, v)} onFile={file => setFiles(x => ({ ...x, [f.id]: file }))} onBlur={() => setErrors(e => ({ ...e, [f.id]: check(f) }))} />
            ))}
          </div>
        )}
        {formError ? (
          <div className="form-error" role="alert">
            {formError}
          </div>
        ) : null}
      </div>
      <div className="dialog-foot">
        <button type="button" className="button" onClick={() => (review ? setReview(null) : done(null))} disabled={busy}>
          {review ? "Back" : "Cancel"}
        </button>
        <button type="submit" className={`button ${config.danger ? "danger solid" : "primary"}`} aria-busy={busy || undefined} disabled={busy}>
          {review ? config.confirm || "Confirm" : config.submit || "Save"}
        </button>
      </div>
    </form>
  );
}

function Field({ field: f, value, error, onChange, onFile, onBlur }: { field: FormField; value: string; error?: string; onChange: (v: string) => void; onFile: (f: File | null) => void; onBlur: () => void }) {
  const id = `of_${f.id}`;
  const full = f.full || f.type === "textarea" || f.type === "static" || f.type === "checks";
  const label = `${f.label}${f.required || f.type === "static" || f.type === "checkbox" ? "" : " (optional)"}`;
  const common = { id, name: f.id, "aria-invalid": error ? true : undefined, "aria-describedby": error ? `${id}_err` : undefined, onBlur };
  let control: ReactNode;
  if (f.type === "static") control = <div style={{ color: "var(--ink-2)" }}>{f.render ?? f.value}</div>;
  else if (f.type === "select")
    control = (
      <Select {...common} className="select" value={value} onChange={e => onChange(e.target.value)}>
        {!f.required || !(f.options as FieldOption[] | undefined)?.some(o => o.value === value) ? <option value="">— Choose —</option> : null}
        {groupOptions((f.options as FieldOption[] | undefined) || [])}
      </Select>
    );
  else if (f.type === "textarea") control = <textarea {...common} className="textarea" rows={f.rows || 3} value={value} placeholder={f.placeholder} maxLength={f.maxLength} onChange={e => onChange(e.target.value)} />;
  else if (f.type === "checks") control = <Checks label={f.label} options={(f.options as FieldOption[] | undefined) || []} value={value} onChange={onChange} />;
  else if (f.type === "checkbox")
    control = (
      <label className="check">
        <input id={id} type="checkbox" checked={value === "true"} onChange={e => onChange(e.target.checked ? "true" : "")} />
        <span>{f.hint}</span>
      </label>
    );
  else if (f.type === "file") control = <input {...common} className="input" type="file" accept={f.accept} onChange={e => onFile(e.target.files?.[0] ?? null)} />;
  else if (f.type === "phone")
    control = (
      <div className="phone-input">
        <span>+880</span>
        <input {...common} className="input" inputMode="tel" autoComplete="tel" placeholder={f.placeholder || "1XXXXXXXXX"} value={value.replace(/^\+?880/, "")} onChange={e => onChange(e.target.value)} />
      </div>
    );
  else
    control = (
      <input
        {...common}
        className="input"
        type={f.type || "text"}
        value={value}
        placeholder={f.placeholder}
        min={f.min}
        max={f.max}
        step={f.step}
        maxLength={f.maxLength}
        inputMode={f.type === "number" ? "decimal" : undefined}
        list={f.suggestions?.length ? `${id}_list` : undefined}
        onChange={e => onChange(e.target.value)}
      />
    );
  const list = f.suggestions?.length ? (
    <datalist id={`${id}_list`}>
      {f.suggestions.map(s => (
        <option key={s} value={s} />
      ))}
    </datalist>
  ) : null;
  return (
    <div className={`field ${full ? "full" : ""}`}>
      {f.type === "checkbox" ? <span className="field-label">{f.label}</span> : <label htmlFor={id} className="field-label">{label}</label>}
      {control}
      {list}
      {f.hint && f.type !== "checkbox" ? <small>{f.hint}</small> : null}
      {error ? (
        <span className="error" id={`${id}_err`}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Several ticks (e.g. the days of a shift); the value is the ticked option values, comma separated. Options with a
 * `group` show under its heading; a long list (over 10) gets a search box, and ticked options stay ticked while hidden.
 */
function Checks({ label, options, value, onChange }: { label: string; options: FieldOption[]; value: string; onChange: (v: string) => void }) {
  const [q, setQ] = useState("");
  const on = new Set(value ? value.split(",") : []);
  const term = q.trim().toLowerCase();
  const shown = term ? options.filter(o => o.label.toLowerCase().includes(term) || (o.group ?? "").toLowerCase().includes(term)) : options;
  const box = (o: FieldOption) => (
    <label key={o.value} className="check" style={{ fontWeight: 500 }}>
      <input
        type="checkbox"
        checked={on.has(o.value)}
        disabled={o.disabled}
        onChange={e => {
          const next = new Set(on);
          if (e.target.checked) next.add(o.value);
          else next.delete(o.value);
          onChange(options.map(x => x.value).filter(v => next.has(v)).join(","));
        }}
      />{" "}
      {o.label}
    </label>
  );
  const groups = [...new Set(shown.map(o => o.group).filter(Boolean))] as string[];
  const row = (items: FieldOption[]) => (
    <div className="row" style={{ gap: "6px 14px" }}>
      {items.map(box)}
    </div>
  );
  return (
    <div role="group" aria-label={label} style={{ display: "grid", gap: 8 }}>
      {options.length > 10 ? (
        <div className="row" style={{ gap: 8 }}>
          <input className="input sm" type="search" placeholder={`Search ${label.toLowerCase()}…`} aria-label={`Search ${label.toLowerCase()}`} value={q} onChange={e => setQ(e.target.value)} style={{ flex: "1 1 200px" }} />
          {on.size ? <span className="faint">{`${on.size} chosen`}</span> : null}
        </div>
      ) : null}
      <div style={options.length > 10 ? { maxHeight: 260, overflowY: "auto", display: "grid", gap: 8, paddingRight: 4 } : { display: "grid", gap: 8 }}>
        {!shown.length ? <span className="faint">Nothing matches.</span> : null}
        {shown.some(o => !o.group) ? row(shown.filter(o => !o.group)) : null}
        {groups.map(g => (
          <div key={g} style={{ display: "grid", gap: 4 }}>
            <div className="faint" style={{ fontSize: 11.5, fontWeight: 650, letterSpacing: ".05em", textTransform: "uppercase" }}>{g}</div>
            {row(shown.filter(o => o.group === g))}
          </div>
        ))}
      </div>
    </div>
  );
}

function groupOptions(options: FieldOption[]) {
  const groups = [...new Set(options.map(o => o.group).filter(Boolean))] as string[];
  const opt = (o: FieldOption) => (
    <option key={o.value} value={o.value} disabled={o.disabled}>
      {o.label}
    </option>
  );
  if (!groups.length) return options.map(opt);
  return [
    ...options.filter(o => !o.group).map(opt),
    ...groups.map(g => (
      <optgroup key={g} label={g}>
        {options.filter(o => o.group === g).map(opt)}
      </optgroup>
    )),
  ];
}

/** Renders the open dialogs (one at a time, stacked). */
export function DialogHost() {
  const list = useSyncExternalStore(
    cb => (subs.add(cb), () => void subs.delete(cb)),
    () => entries,
  );
  return (
    <>
      {list.map(e => (
        <ModalDialog key={e.id} size={e.size} onCancel={() => close(e.id, null)}>
          {e.render(v => close(e.id, v))}
        </ModalDialog>
      ))}
    </>
  );
}

function ModalDialog({ children, onCancel, size }: { children: ReactNode; onCancel: () => void; size?: "wide" | "xwide" }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog ${size ?? ""}`}
      onCancel={e => {
        e.preventDefault();
        onCancel();
      }}
      onMouseDown={e => {
        if (e.target === ref.current) {
          const r = ref.current.getBoundingClientRect();
          if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onCancel();
        }
      }}
    >
      {children}
    </dialog>
  );
}
