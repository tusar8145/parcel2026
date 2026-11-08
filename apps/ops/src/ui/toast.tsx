import { Icon } from "./Icon";
import { useSyncExternalStore } from "react";
import { describe } from "@/lib/api";

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

export function Toasts() {
  const list = useSyncExternalStore(
    cb => (subs.add(cb), () => void subs.delete(cb)),
    () => toasts,
  );
  return (
    <div className="toasts" role="status" aria-live="polite">
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
