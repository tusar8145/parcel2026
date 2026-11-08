/**
 * The panel's dropdown (every select goes through it, ui/Select.tsx): a button that opens a floating list.
 * Long lists (merchants, riders, hubs, zones) get a search box, like shared/select-search.js; short ones just the list.
 * Keyboard: ↑ ↓ Home End Enter Esc Tab; typing opens it (searches, or jumps to the first choice starting with it).
 * ARIA combobox + listbox; groups kept; the list opens inside an open <dialog> so it sits above it.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./Icon";

export interface Option {
  value: string;
  label: string;
  hint?: string;
  group?: string;
  disabled?: boolean;
}

export function SearchSelect({
  options,
  value,
  onChange,
  placeholder = "Choose…",
  label,
  emptyLabel,
  size = "md",
  disabled,
  invalid,
  id,
  width,
  search = true,
  icon,
  title,
}: {
  options: Option[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label: string;
  /** An option for "" (e.g. "All merchants"). */
  emptyLabel?: string;
  size?: "sm" | "md";
  disabled?: boolean;
  invalid?: boolean;
  id?: string;
  width?: number | string;
  /** A search box above the list (long lists). */
  search?: boolean;
  /** An icon before the text (e.g. Print…). */
  icon?: IconName;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [active, setActive] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const listId = useId();
  const all = useMemo(() => (emptyLabel != null ? [{ value: "", label: emptyLabel }, ...options] : options), [options, emptyLabel]);
  const shown = useMemo(() => {
    const t = search ? term.trim().toLowerCase() : "";
    return t ? all.filter(o => `${o.label} ${o.hint ?? ""} ${o.group ?? ""}`.toLowerCase().includes(t)) : all;
  }, [all, term, search]);
  const selected = all.find(o => o.value === value);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 280, height: 340 });

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const w = Math.min(Math.max(r.width, search ? 280 : icon ? 260 : 180), window.innerWidth - 16);
    const groups = new Set(all.map(o => o.group).filter(Boolean)).size;
    const h = Math.min(340, (search ? 52 : 0) + 12 + all.length * 36 + groups * 28);
    const below = r.bottom + 4 + h <= window.innerHeight - 8 || r.top < h + 12;
    setPos({ top: below ? r.bottom + 4 : Math.max(8, r.top - 4 - h), left: Math.min(Math.max(8, r.left), window.innerWidth - w - 8), width: w, height: h });
    setActive(Math.max(0, shown.findIndex(o => o.value === value)));
    setTimeout(() => (search ? searchBox.current : list.current)?.focus(), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (pop.current?.contains(e.target as Node) || button.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", close);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("resize", close);
    };
  }, [open]);
  useEffect(() => {
    pop.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const choose = (o: Option | undefined) => {
    if (!o || o.disabled) return;
    onChange(o.value);
    setOpen(false);
    setTerm("");
    button.current?.focus();
  };
  /** No search box: typing jumps to the first choice that starts with what was typed (like a native select). */
  const jump = (key: string) => {
    const now = Date.now();
    typed.current = { text: now - typed.current.at < 700 ? typed.current.text + key.toLowerCase() : key.toLowerCase(), at: now };
    const i = shown.findIndex(o => !o.disabled && o.label.toLowerCase().startsWith(typed.current.text));
    if (i >= 0) setActive(i);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") (e.preventDefault(), setActive(i => Math.min(shown.length - 1, i + 1)));
    else if (e.key === "ArrowUp") (e.preventDefault(), setActive(i => Math.max(0, i - 1)));
    else if (e.key === "Home" && !search) (e.preventDefault(), setActive(0));
    else if (e.key === "End" && !search) (e.preventDefault(), setActive(shown.length - 1));
    else if (e.key === "Enter" || (e.key === " " && !search)) (e.preventDefault(), choose(shown[active]));
    else if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), setOpen(false), button.current?.focus());
    else if (e.key === "Tab") setOpen(false);
    else if (!search && e.key.length === 1 && !e.ctrlKey && !e.metaKey) jump(e.key);
  };

  let lastGroup: string | undefined;
  const empty = !selected || selected.value === "";
  return (
    <>
      <button
        ref={button}
        id={id}
        type="button"
        className={`select dropdown-button${size === "sm" ? " sm" : ""}${open ? " open" : ""}`}
        style={{ width, color: !empty ? "var(--ink)" : (emptyLabel != null && value === "") || icon ? "var(--ink-2)" : "var(--faint)" }}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={label}
        aria-invalid={invalid || undefined}
        title={title}
        disabled={disabled}
        onClick={() => setOpen(o => !o)}
        onKeyDown={e => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " " || e.key === "F4") {
            e.preventDefault();
            setOpen(true);
          } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
            if (search) setTerm(e.key);
            else jump(e.key);
            setOpen(true);
          }
        }}
      >
        {icon ? <Icon name={icon} size={15} /> : null}
        <span className="dropdown-text">{selected ? selected.label : placeholder}</span>
      </button>
      {open
        ? createPortal(
            <div ref={pop} className="menu dropdown-menu" style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.height }}>
              {search ? (
                <div className="dropdown-search">
                  <Icon name="search" size={15} />
                  <input
                    ref={searchBox}
                    className="input sm"
                    placeholder={`Search ${label.toLowerCase()}…`}
                    value={term}
                    role="searchbox"
                    aria-controls={listId}
                    aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
                    onChange={e => (setTerm(e.target.value), setActive(0))}
                    onKeyDown={onKey}
                  />
                </div>
              ) : null}
              <div
                ref={list}
                id={listId}
                role="listbox"
                aria-label={label}
                tabIndex={search ? undefined : -1}
                aria-activedescendant={!search && shown[active] ? `${listId}-${active}` : undefined}
                onKeyDown={search ? undefined : onKey}
                className="dropdown-list"
              >
                {shown.length ? (
                  shown.map((o, i) => {
                    const head = o.group && o.group !== lastGroup ? o.group : null;
                    lastGroup = o.group;
                    const isSelected = o.value === value;
                    return (
                      <div key={`${o.group}|${o.value}`}>
                        {head ? <div className="dropdown-group">{head}</div> : null}
                        <div
                          id={`${listId}-${i}`}
                          data-index={i}
                          role="option"
                          aria-selected={isSelected}
                          aria-disabled={o.disabled || undefined}
                          className={`dropdown-option${i === active ? " active" : ""}${isSelected ? " selected" : ""}`}
                          onMouseEnter={() => setActive(i)}
                          onMouseDown={e => e.preventDefault()}
                          onClick={() => choose(o)}
                        >
                          <span className="grow">
                            {o.label}
                            {o.hint ? <small>{o.hint}</small> : null}
                          </span>
                          {isSelected ? <Icon name="check" size={15} /> : null}
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div className="faint" style={{ padding: 10 }}>
                    Nothing matches “{term}”.
                  </div>
                )}
              </div>
            </div>,
            button.current?.closest("dialog") ?? document.body,
          )
        : null}
    </>
  );
}
