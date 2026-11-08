/** Small building blocks used by every view. */
import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./Icon";
import { toastError } from "./toast";
import { onDialogOpen } from "./dialogSignal";

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> & {
  variant?: "primary" | "danger" | "ghost" | "default";
  size?: "sm" | "md";
  icon?: IconName;
  /** A returned promise shows a spinner and disables the button until it settles; a rejection becomes a toast. */
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => unknown;
};

/** A button that does API work: busy while its promise runs (DF.busy), errors shown as a toast. */
export function Button({ variant = "default", size = "md", icon, onClick, children, className = "", disabled, type = "button", ...rest }: ButtonProps) {
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => void (mounted.current = false);
  }, []);
  const classes = ["button", variant !== "default" ? variant : "", size === "sm" ? "sm" : "", !children ? "icon" : "", className].filter(Boolean).join(" ");
  return (
    <button
      {...rest}
      type={type}
      className={classes}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      onClick={event => {
        // Work that opens a dialog waits for it to close: the button is free again once the dialog is up. Listen
        // before the work starts, since a dialog can open at once (no request first).
        let opened = false;
        const off = onDialogOpen(() => {
          opened = true;
          if (mounted.current) setBusy(false);
        });
        let result: unknown;
        try {
          result = onClick?.(event);
        } catch (error) {
          off();
          throw error;
        }
        if (result && typeof (result as Promise<unknown>).then === "function") {
          if (!opened) setBusy(true);
          (result as Promise<unknown>)
            .catch(toastError)
            .finally(() => {
              off();
              if (mounted.current) setBusy(false);
            });
        } else off();
      }}
    >
      {icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
}

type Tone = "good" | "warn" | "bad" | "info" | "neutral" | "violet";
const TONES: Record<string, Tone> = {
  delivered: "good",
  active: "good",
  paid: "good",
  settled: "good",
  approved: "good",
  received: "good",
  completed: "good",
  online: "good",
  met: "good",
  exception: "bad",
  cancelled: "bad",
  "pickup cancelled": "bad",
  rejected: "bad",
  failed: "bad",
  void: "bad",
  missing: "bad",
  late: "bad",
  "at risk": "warn",
  "retry scheduled": "warn",
  "return scheduled": "warn",
  "pending operations confirmation": "warn",
  pending: "warn",
  "needs info": "warn",
  draft: "neutral",
  offline: "neutral",
  returned: "violet",
};

/** A status as a coloured pill (good / warn / bad / info), from its label. */
export function Pill({ children, tone }: { children: ReactNode; tone?: Tone }) {
  const text = String(children ?? "").toLowerCase();
  const auto: Tone = tone ?? TONES[text] ?? (text.includes("deliver") ? "good" : text.includes("risk") || text.includes("review") ? "warn" : "info");
  return <span className={`pill ${auto === "info" ? "" : auto}`}>{children}</span>;
}

export function Metric({ label, value, icon, foot, note, onClick, href }: { label: string; value: ReactNode; icon?: IconName; foot?: ReactNode; note?: ReactNode; onClick?: () => void; href?: string }) {
  const body = (
    <>
      <div className="metric-head">
        <span>{label}</span>
        {icon ? <Icon name={icon} /> : null}
      </div>
      <div className="metric-value">{value}</div>
      {foot || note ? (
        <div className="metric-foot">
          <span>{foot}</span>
          <span>{note}</span>
        </div>
      ) : null}
    </>
  );
  if (href) return <a className="metric" href={href} onClick={e => (onClick ? (e.preventDefault(), onClick()) : undefined)}>{body}</a>;
  if (onClick) return <button type="button" className="metric" onClick={onClick}>{body}</button>;
  return <article className="metric">{body}</article>;
}

export function Panel({ title, subtitle, tools, children, footer, className = "", id }: { title?: ReactNode; subtitle?: ReactNode; tools?: ReactNode; children?: ReactNode; footer?: ReactNode; className?: string; id?: string }) {
  return (
    <section className={`panel ${className}`} id={id}>
      {title || tools ? (
        <div className="panel-head">
          <div>
            {title ? <h2 className="panel-title">{title}</h2> : null}
            {subtitle ? <p className="panel-subtitle">{subtitle}</p> : null}
          </div>
          {tools ? <div className="tools">{tools}</div> : null}
        </div>
      ) : null}
      {children}
      {footer ? <div className="panel-foot">{footer}</div> : null}
    </section>
  );
}

export function Empty({ title, children }: { title?: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {title ? <strong>{title}</strong> : null}
      {children}
    </div>
  );
}

export function Loading({ rows = 5 }: { rows?: number }) {
  return (
    <div style={{ padding: 16, display: "grid", gap: 12 }} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="skeleton" style={{ width: `${90 - ((i * 13) % 40)}%` }} />
      ))}
    </div>
  );
}

export function PageHeading({ eyebrow, title, subtitle, actions }: { eyebrow?: ReactNode; title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
        {subtitle ? <p className="subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="heading-actions">{actions}</div> : null}
    </div>
  );
}

export interface MenuItem {
  label: string;
  onSelect: () => unknown;
  icon?: IconName;
  danger?: boolean;
  hidden?: boolean;
  disabled?: boolean;
  title?: string;
}

/** "More ▾": a floating menu placed under (or above) its button; closes on outside click, Escape and scroll. */
export function MoreMenu({ items, label = "More", size = "sm", icon }: { items: (MenuItem | "sep" | null | false)[]; label?: string; size?: "sm" | "md"; icon?: IconName }) {
  const shown = items.filter((i): i is MenuItem | "sep" => !!i && (i === "sep" || !i.hidden));
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0, visible: false });

  useLayoutEffect(() => {
    if (!open || !button.current || !menu.current) return;
    const rect = button.current.getBoundingClientRect();
    const { offsetWidth: w, offsetHeight: h } = menu.current;
    const below = rect.bottom + 4 + h <= window.innerHeight - 8;
    setPos({ top: Math.max(8, below ? rect.bottom + 4 : rect.top - 4 - h), left: Math.min(Math.max(8, rect.right - w), window.innerWidth - w - 8), visible: true });
    menu.current.querySelector<HTMLButtonElement>("button")?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event.type === "mousedown" && (menu.current?.contains(event.target as Node) || button.current?.contains(event.target as Node))) return;
      setOpen(false);
      setPos(p => ({ ...p, visible: false }));
    };
    const key = (event: KeyboardEvent) => event.key === "Escape" && (setOpen(false), button.current?.focus());
    document.addEventListener("mousedown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  if (!shown.some(i => i !== "sep")) return null;
  return (
    <>
      <button ref={button} type="button" className={`button ${size === "sm" ? "sm" : ""}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        {icon ? <Icon name={icon} /> : null}
        {label} <Icon name="chevronDown" size={13} />
      </button>
      {open
        ? createPortal(
            <div ref={menu} className="menu" role="menu" style={{ top: pos.top, left: pos.left, visibility: pos.visible ? "visible" : "hidden" }}>
              {shown.map((item, i) =>
                item === "sep" ? (
                  <div key={`sep${i}`} className="menu-sep" />
                ) : (
                  <button
                    key={item.label}
                    type="button"
                    role="menuitem"
                    className={`menu-item ${item.danger ? "danger" : ""}`}
                    disabled={item.disabled}
                    title={item.title}
                    onClick={() => {
                      setOpen(false);
                      Promise.resolve()
                        .then(item.onSelect)
                        .catch(toastError);
                    }}
                  >
                    {item.icon ? <Icon name={item.icon} size={15} /> : null}
                    {item.label}
                  </button>
                ),
              )}
            </div>,
            button.current?.closest("dialog") ?? document.body,
          )
        : null}
    </>
  );
}

/** Tabs bar (role=tablist). */
export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: { id: T; label?: ReactNode; count?: number | null; hidden?: boolean; badge?: ReactNode; title?: string }[]; value: T; onChange: (id: T) => void; label: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs
        .filter(t => !t.hidden)
        .map(t => (
          <button key={t.id} type="button" role="tab" className="tab" aria-selected={t.id === value} title={t.title} onClick={() => onChange(t.id)}>
            {t.label ?? t.id}
            {t.count != null ? <span className="count">{t.count.toLocaleString("en-US")}</span> : null}
            {t.badge}
          </button>
        ))}
    </div>
  );
}

/** Debounced value (search boxes). */
export function useDebounced<T>(value: T, ms = 350) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Remembered per browser (scope, page size…); survives blocked storage. */
export function useStored<T extends string>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      return (localStorage.getItem(key) as T) || initial;
    } catch {
      return initial;
    }
  });
  return [
    value,
    v => {
      setValue(v);
      try {
        localStorage.setItem(key, v);
      } catch {
        /* storage blocked */
      }
    },
  ];
}
