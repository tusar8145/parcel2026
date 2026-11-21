import { Icon } from "./Icon";
import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { describe } from "../lib/api";

type Tone = "default" | "good" | "bad";
interface Toast {
  id: number;
  text: string;
  tone: Tone;
}

let toasts: Toast[] = [];
let seq = 0;
const subs = new Set<() => void>();
const emit = () => subs.forEach(s => s());

/** A short message at the bottom of the screen (errors stay longer). */
export function toast(text: string, tone: Tone = "default") {
  const id = ++seq;
  toasts = [...toasts.slice(-3), { id, text, tone }];
  emit();
  setTimeout(() => dismiss(id), tone === "bad" ? 6500 : 3200);
}
export const toastError = (error: unknown) => toast(error instanceof Error && !("status" in error) ? error.message : describe(error), "bad");
function dismiss(id: number) {
  toasts = toasts.filter(t => t.id !== id);
  emit();
}

/**
 * The messages sit in the browser's top layer (a manual popover) so they show above an open dialog too: a <dialog>
 * opened with showModal() is in the top layer, where a z-index can't reach. Shown again (moved to the top) when a
 * message comes while a dialog is open, and when a dialog opens while a message shows (raiseToasts).
 */
let host: HTMLElement | null = null;
const canPop = (el: HTMLElement | null): el is HTMLElement & { showPopover(): void; hidePopover(): void } => !!el && typeof (el as { showPopover?: unknown }).showPopover === "function";
const isOpen = (el: HTMLElement) => {
  try {
    return el.matches(":popover-open");
  } catch {
    return false;
  }
};
function place(raise: boolean) {
  const el = host;
  if (!canPop(el)) return;
  try {
    if (!toasts.length) return void (isOpen(el) && el.hidePopover());
    if (isOpen(el) && !raise) return;
    if (isOpen(el)) el.hidePopover();
    el.showPopover();
  } catch {
    /* the popover can't open (old browser): the messages show as before */
  }
}
/** A dialog just opened: the messages that show stay above it. */
export const raiseToasts = () => place(true);

export function Toasts() {
  const list = useSyncExternalStore(
    cb => (subs.add(cb), () => void subs.delete(cb)),
    () => toasts,
  );
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    host = ref.current;
    // A new message while a dialog is open: above it.
    place(!!document.querySelector("dialog[open]"));
  }, [list]);
  return (
    <div ref={ref} className="toasts" role="status" aria-live="polite" popover="manual">
      {list.map(t => (
        <div key={t.id} className={`toast ${t.tone === "default" ? "" : t.tone}`}>
          <span>{t.text}</span>
          <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            <Icon name="x" size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
