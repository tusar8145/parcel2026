/**
 * Scan desk and Parcel queue: "Set operation time" (bridge-nav.js operationTimeBar). Unticked, entries are recorded
 * now. Ticked, a date & time (now to start with) goes with every change on these pages (X-Operation-Time), up to
 * 30 days back, never ahead. It stays while you move between their tabs; other views use now.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { setOperationTime } from "@panel/lib/api";
import { Icon } from "@panel/ui/Icon";
import { toast } from "@panel/ui/toast";

const DAYS = 30;
const store = { on: false, value: null as Date | null };
const subs = new Set<() => void>();
const emit = () => subs.forEach(s => s());
const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const text = (d: Date) => d.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true });

/** Mount on the pages that use it; leaving them sends no time (now). */
export function useOperationTime() {
  useEffect(() => {
    setOperationTime(store.on && store.value ? store.value.toISOString() : null);
    return () => setOperationTime(null);
  }, []);
}

export function OperationTimeBar() {
  useOperationTime();
  const snap = useSyncExternalStore(
    cb => (subs.add(cb), () => void subs.delete(cb)),
    () => `${store.on}|${store.value?.getTime() ?? ""}`,
  );
  void snap;
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  const apply = () => {
    setOperationTime(store.on && store.value ? store.value.toISOString() : null);
    emit();
  };
  const custom = store.on && store.value;
  return (
    <div style={{ display: "grid", justifyItems: "end", gap: 4 }}>
      <div className="row">
        <label className="check" style={{ fontSize: 12.5, fontWeight: 600, color: "var(--muted)" }}>
          <input
            type="checkbox"
            checked={store.on}
            onChange={e => {
              store.on = e.target.checked;
              if (!store.on) store.value = null;
              apply();
            }}
          />
          <Icon name="clock" size={14} />
          Set operation time
        </label>
        {store.on ? (
          <input
            type="datetime-local"
            className="input sm"
            aria-label="Operation date and time"
            style={{ width: 210, borderColor: custom ? "var(--warn)" : undefined }}
            max={localInput(now)}
            min={localInput(new Date(now.getTime() - DAYS * 86_400_000))}
            value={localInput(store.value || now)}
            onChange={e => {
              const picked = e.target.value ? new Date(e.target.value) : null;
              const t = Date.now();
              if (!picked || Number.isNaN(picked.getTime()) || Math.abs(picked.getTime() - t) < 60_000) store.value = null;
              else if (picked.getTime() > t) {
                store.value = null;
                toast("The operation time can't be in the future; using now.");
              } else if (picked.getTime() < t - DAYS * 86_400_000) {
                store.value = null;
                toast(`The operation time can be at most ${DAYS} days back; using now.`);
              } else store.value = picked;
              apply();
            }}
          />
        ) : null}
      </div>
      <small style={{ fontSize: 12, color: custom ? "var(--warn)" : "var(--faint)" }}>
        {custom ? `Entries on this page are recorded at ${text(store.value!)}.` : store.on ? "Choose the date & time the work happened (up to 30 days back)." : "Entries are recorded at the current time."}
      </small>
    </div>
  );
}
