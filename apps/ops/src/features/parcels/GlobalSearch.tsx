/**
 * The top bar's search: a box that opens the search window (click it, or press "/"). Type or scan a tracking ID, CN
 * or phone: matching parcels show on the left as you type, and the chosen one's full details (everything the side
 * panel shows, with its actions) on the right. A zone or area name also shows the hub that serves it. The window
 * closes with Esc, the ✕ or a click outside. Parcels opened anywhere else still open in the side panel.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, describe } from "@panel/lib/api";
import { useOps } from "@/lib/ops";
import { Icon } from "@panel/ui/Icon";
import { focusScanBox } from "@/features/scan/scanner";
import { toast } from "@panel/ui/toast";
import { findParcels, useCatalog } from "./search";
import { DrawerContent } from "./ParcelDrawer";
import type { Parcel } from "./model";
import "./global-search.css";

type Place = { district: string; zone: string; area?: string; hub: { name: string } | null };
const money = (v: number | null | undefined) => (v ? `৳${Number(v).toLocaleString("en-BD")}` : "");
const TONE: Record<string, string> = { DELIVERED: "good", RETURNED: "warn", PICKUP_CANCELLED: "bad", EXCEPTION: "bad", OUT_FOR_DELIVERY: "info", AT_HUB: "info" };

export default function GlobalSearch() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "F2" && !document.querySelector("dialog[open]")) {
        e.preventDefault();
        if (!focusScanBox()) toast("No scan box on this page.");
        return;
      }
      if (e.key === "/" && !e.ctrlKey && !e.metaKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !t.isContentEditable && !document.querySelector("dialog[open]")) {
        e.preventDefault();
        setOpen(true);
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
  return (
    <>
      <button type="button" className="gs-trigger" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label="Search parcels: tracking ID, CN, phone or zone">
        <Icon name="search" />
        <span className="gs-trigger-text">Tracking ID, CN, phone or zone…</span>
        <kbd>/</kbd>
      </button>
      {open ? <SearchDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function SearchDialog({ onClose }: { onClose: () => void }) {
  const catalog = useCatalog();
  const { hubs } = useOps();
  const input = useRef<HTMLInputElement>(null);
  const detailClose = useRef<HTMLButtonElement>(null);
  const [shown, setShown] = useState(false);
  const [value, setValue] = useState("");
  const [results, setResults] = useState<Parcel[] | null>(null);
  const [places, setPlaces] = useState<Place[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const seq = useRef(0);

  // Opens with a short fade-and-rise; closes the same way before it is removed.
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    input.current?.focus();
    return () => cancelAnimationFrame(id);
  }, []);
  const close = useCallback(() => {
    setShown(false);
    setTimeout(onClose, 200);
  }, [onClose]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && !document.querySelector("dialog[open]") && close();
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [close]);

  const run = useCallback(async (raw: string) => {
    const text = raw.trim();
    const mine = ++seq.current;
    if (text.length < 3) {
      setResults(null);
      setError("");
      return;
    }
    setBusy(true);
    try {
      const found = await findParcels(text);
      if (mine !== seq.current) return;
      setResults(found);
      setActive(0);
      // The first match's details at once (a scan opens straight to it).
      setPicked(found[0]?.trackingId ?? null);
      setError("");
    } catch (e) {
      if (mine === seq.current) setError(describe(e));
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void run(value), 350);
    return () => clearTimeout(t);
  }, [value, run]);

  // A zone or area name: which hub serves it.
  useEffect(() => {
    const text = value.trim();
    if (text.length < 3 || /\d/.test(text) || !catalog) return setPlaces([]);
    const t = text.toLowerCase();
    const found: { district: string; zone: string; area?: string }[] = [];
    for (const district of catalog.districts || []) for (const zone of catalog.zonesByDistrict?.[district] || []) if (zone.toLowerCase().includes(t)) found.push({ district, zone });
    for (const district of catalog.districts || [])
      for (const zone of catalog.zonesByDistrict?.[district] || [])
        for (const area of catalog.areasByZone?.[zone] || []) if (area.toLowerCase().includes(t) && !found.some(p => p.zone === zone && p.district === district && !p.area)) found.push({ district, zone, area });
    const top = found.slice(0, 6);
    let live = true;
    const timer = setTimeout(async () => {
      const withHubs = await Promise.all(
        top.map(async p => {
          let hub: { name: string } | null = null;
          try {
            const page = await api<{ items: { name: string; hub?: { name: string } | null }[] }>(`/zones?limit=20&district=${encodeURIComponent(p.district)}&q=${encodeURIComponent(p.zone)}`);
            hub = page.items.find(z => z.name.toLowerCase() === p.zone.toLowerCase() && z.hub)?.hub ?? null;
          } catch {
            /* the hubs' own zones below */
          }
          hub ??= hubs.find(h => h.active !== false && h.district === p.district && (h.zone || "").toLowerCase() === p.zone.toLowerCase()) ?? null;
          return { ...p, hub };
        }),
      );
      if (live) setPlaces(withHubs);
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [value, catalog, hubs]);

  const onKey = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    const list = results ?? [];
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const i = Math.min(active + 1, Math.max(0, list.length - 1));
      setActive(i);
      if (list[i]) setPicked(list[i].trackingId);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const i = Math.max(0, active - 1);
      setActive(i);
      if (list[i]) setPicked(list[i].trackingId);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const raw = value.trim();
      if (!raw) return;
      // Scanned / typed and Enter at once: search now.
      const found = !results || busy ? await findParcels(raw).catch(err => (setError(describe(err)), [] as Parcel[])) : list;
      if (found !== list) setResults(found);
      if (!found.length) return toast(`No parcel found for “${raw}”.`);
      setPicked(found[Math.min(active, found.length - 1)]?.trackingId ?? found[0].trackingId);
    }
  };

  const text = value.trim();
  const list = results ?? [];
  return createPortal(
    <div className={`gs-backdrop${shown ? " in" : ""}`} role="presentation" onMouseDown={e => e.target === e.currentTarget && close()}>
      <section className={`gs-panel${picked ? " has-detail" : ""}`} role="dialog" aria-modal="true" aria-label="Search parcels">
        <header className="gs-head">
          <label className="gs-field">
            <Icon name="search" size={20} />
            <input ref={input} className="gs-input" type="search" autoComplete="off" placeholder="Tracking ID, CN, phone or zone…" aria-label="Tracking ID, CN, phone or zone" value={value} onChange={e => setValue(e.target.value)} onKeyDown={e => void onKey(e)} />
            {busy ? <span className="gs-spin" aria-label="Searching" /> : text ? (
              <button type="button" className="gs-clear" aria-label="Clear" onClick={() => (setValue(""), setResults(null), setPicked(null), input.current?.focus())}>
                Clear
              </button>
            ) : null}
          </label>
          <button type="button" className="gs-close" aria-label="Close" onClick={close}>
            <Icon name="x" />
          </button>
        </header>
        <div className="gs-main">
          <div className="gs-results">
            {!text ? (
              <div className="gs-empty">
                <span className="gs-empty-icon">
                  <Icon name="search" size={26} />
                </span>
                <strong>Find a parcel</strong>
                <span>Type or scan a tracking ID or CN, a phone number, or a zone / area name to see the hub that serves it.</span>
                <span className="gs-keys">
                  <kbd>↑</kbd> <kbd>↓</kbd> choose · <kbd>Enter</kbd> open · <kbd>Esc</kbd> close
                </span>
              </div>
            ) : text.length < 3 ? (
              <div className="gs-empty">
                <span>Type at least 3 characters.</span>
              </div>
            ) : (
              <>
                {error ? <div className="callout bad" style={{ margin: "0 0 10px" }}>{error}</div> : null}
                <div className="gs-section">{results ? (list.length ? `Parcels · ${list.length}${list.length >= 20 ? "+" : ""}` : busy ? "Searching…" : "No parcel found") : "Searching…"}</div>
                <ul className="gs-list" role="listbox" aria-label="Parcels">
                  {list.map((p, i) => (
                    <li key={p.trackingId} role="option" aria-selected={p.trackingId === picked}>
                      <button
                        type="button"
                        className={`gs-item${p.trackingId === picked ? " picked" : ""}${i === active ? " active" : ""}`}
                        onClick={() => (setActive(i), setPicked(p.trackingId))}
                        style={{ animationDelay: `${Math.min(i, 8) * 25}ms` }}
                      >
                        <span className="gs-item-top">
                          <strong className="gs-id">{p.trackingId}</strong>
                          <span className={`pill ${TONE[p.status] ?? ""}`}>{p.statusLabel}</span>
                        </span>
                        <span className="gs-item-line">
                          <Icon name="users" size={13} />
                          {[p.recipient?.name, p.recipient?.phone].filter(Boolean).join(" · ") || "Recipient not set"}
                        </span>
                        <span className="gs-item-line">
                          <Icon name="box" size={13} />
                          {p.merchant?.name ?? p.sender?.name ?? "Customer"}
                          {money(p.codAmount) ? <b className="gs-cod">{`COD ${money(p.codAmount)}`}</b> : null}
                        </span>
                        <span className="gs-item-line">
                          <Icon name="pin" size={13} />
                          {[p.delivery?.zone, p.delivery?.district].filter(Boolean).join(", ") || "Destination not set"}
                          {p.currentHub?.name ? <span className="gs-hub">{p.currentHub.name}</span> : null}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                {places.length ? (
                  <>
                    <div className="gs-section">Which hub serves it</div>
                    <ul className="gs-list">
                      {places.map(p => (
                        <li key={`${p.district}|${p.zone}|${p.area}`} className="gs-place">
                          <span>
                            <strong>{p.area || p.zone}</strong>
                            <small>{p.area ? `${p.zone}, ${p.district}` : p.district}</small>
                          </span>
                          <span style={{ textAlign: "right" }}>{p.hub ? <strong>{p.hub.name}</strong> : <small>No hub set for this zone</small>}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </>
            )}
          </div>
          <div className="gs-detail">
            {picked ? (
              <div className="gs-detail-inner" key={picked}>
                <button type="button" className="gs-back" onClick={() => setPicked(null)}>
                  ← Results
                </button>
                <DrawerContent id={picked} matches={[]} close={() => setPicked(null)} closeRef={detailClose} />
              </div>
            ) : (
              <div className="gs-empty gs-detail-empty">
                <span className="gs-empty-icon">
                  <Icon name="box" size={26} />
                </span>
                <strong>Parcel details</strong>
                <span>Choose a parcel on the left to see everything about it here: status, recipient, charges, messages, history and its actions.</span>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
