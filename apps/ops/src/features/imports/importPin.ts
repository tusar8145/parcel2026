/**
 * A pinned import (Import history › Pin): New orders shows only that import's parcels, whatever their status, until
 * it is unpinned or 6 hours pass. Kept in this browser only (localStorage); other devices don't see it.
 */
import { useSyncExternalStore } from "react";

export interface ImportPin {
  /** The import's booking batch (GET /parcels?batchId=…). */
  batchId: string;
  /** The batch number (BB-…) and the import number (IMP-…) for the Unpin button. */
  batch: string;
  number: string;
  pinnedAt: number;
}

const KEY = "ops.importPin";
const EVENT = "ops:import-pin";
export const PIN_HOURS = 6;
/** "IMP-…" or "IMP-… · BB-…" (the batch number when it differs from the import's). */
export const pinName = (pin: Pick<ImportPin, "number" | "batch">) => (pin.batch && pin.batch !== pin.number ? `${pin.number} · ${pin.batch}` : pin.number);

function read(): ImportPin | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const pin = JSON.parse(raw) as ImportPin;
    if (!pin?.batchId || !pin.pinnedAt || Date.now() - pin.pinnedAt > PIN_HOURS * 3600_000) {
      localStorage.removeItem(KEY);
      return null;
    }
    return pin;
  } catch {
    return null;
  }
}

let cached: ImportPin | null = null;
let cachedRaw: string | null | undefined;
function snapshot() {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    raw = null;
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = read();
  } else if (cached && Date.now() - cached.pinnedAt > PIN_HOURS * 3600_000) {
    cached = read();
    cachedRaw = null;
  }
  return cached;
}

export function pinImport(pin: Omit<ImportPin, "pinnedAt">) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...pin, pinnedAt: Date.now() }));
  } catch {
    /* storage blocked: nothing to keep */
  }
  window.dispatchEvent(new Event(EVENT));
}

export function unpinImport() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing kept */
  }
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(change: () => void) {
  window.addEventListener(EVENT, change);
  window.addEventListener("storage", change);
  // The pin runs out after 6 hours, also while the page stays open.
  const timer = window.setInterval(change, 60_000);
  return () => {
    window.removeEventListener(EVENT, change);
    window.removeEventListener("storage", change);
    window.clearInterval(timer);
  };
}

/** The pinned import (null: none, or it ran out). */
export function useImportPin() {
  return useSyncExternalStore(subscribe, snapshot, () => null);
}
