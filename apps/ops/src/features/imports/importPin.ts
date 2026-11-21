/**
 * Pinned imports (Import history › Pin): New orders and All parcels show only the pinned imports' parcels, whatever their status,
 * until they are unpinned or 6 hours pass (each pin on its own). Several imports can be pinned at once (at most 20).
 * Kept in this browser only (localStorage); other devices don't see them.
 */
import { useSyncExternalStore } from "react";

export interface ImportPin {
  /** The import's booking batch (GET /parcels?batchIds=…). */
  batchId: string;
  /** The batch number (BB-…) and the import number (IMP-…) for the Unpin buttons. */
  batch: string;
  number: string;
  pinnedAt: number;
}

const KEY = "ops.importPins";
/** The single pin kept before several were allowed: taken over once. */
const OLD_KEY = "ops.importPin";
const EVENT = "ops:import-pin";
export const PIN_HOURS = 6;
export const MAX_PINS = 20;
/** "IMP-…" or "IMP-… · BB-…" (the batch number when it differs from the import's). */
export const pinName = (pin: Pick<ImportPin, "number" | "batch">) => (pin.batch && pin.batch !== pin.number ? `${pin.number} · ${pin.batch}` : pin.number);

const live = (p: ImportPin) => !!p?.batchId && !!p.pinnedAt && Date.now() - p.pinnedAt <= PIN_HOURS * 3600_000;

function load(): ImportPin[] {
  try {
    const old = localStorage.getItem(OLD_KEY);
    if (old) {
      localStorage.removeItem(OLD_KEY);
      const pin = JSON.parse(old) as ImportPin;
      if (live(pin) && !localStorage.getItem(KEY)) localStorage.setItem(KEY, JSON.stringify([pin]));
    }
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const list = (JSON.parse(raw) as ImportPin[]).filter(live);
    return list;
  } catch {
    return [];
  }
}

function save(list: ImportPin[]) {
  try {
    if (list.length) localStorage.setItem(KEY, JSON.stringify(list));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage blocked: nothing to keep */
  }
  window.dispatchEvent(new Event(EVENT));
}

const EMPTY: ImportPin[] = [];
let cached: ImportPin[] = EMPTY;
let cachedRaw: string | null | undefined;
function snapshot() {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY) ?? localStorage.getItem(OLD_KEY);
  } catch {
    raw = null;
  }
  if (raw !== cachedRaw || cached.some(p => !live(p))) {
    cached = load();
    if (!cached.length) cached = EMPTY;
    try {
      cachedRaw = localStorage.getItem(KEY);
    } catch {
      cachedRaw = null;
    }
  }
  return cached;
}

/** Pins one more import (already pinned: its 6 hours start again). False when 20 are pinned already. */
export function pinImport(pin: Omit<ImportPin, "pinnedAt">) {
  const list = load().filter(p => p.batchId !== pin.batchId);
  if (list.length >= MAX_PINS) return false;
  save([...list, { ...pin, pinnedAt: Date.now() }]);
  return true;
}

/** Unpins one import (by its booking batch), or every pinned import. */
export function unpinImport(batchId?: string) {
  save(batchId ? load().filter(p => p.batchId !== batchId) : []);
}

function subscribe(change: () => void) {
  window.addEventListener(EVENT, change);
  window.addEventListener("storage", change);
  // Pins run out after 6 hours, also while the page stays open.
  const timer = window.setInterval(change, 60_000);
  return () => {
    window.removeEventListener(EVENT, change);
    window.removeEventListener("storage", change);
    window.clearInterval(timer);
  };
}

/** The pinned imports, oldest pin first (empty: none, or they ran out). */
export function useImportPins() {
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY);
}

/** The pinned imports now (outside React). */
export const pinnedImports = () => load();
