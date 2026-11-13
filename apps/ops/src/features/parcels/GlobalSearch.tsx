/**
 * The top bar's search: a box that opens a search window (click it, or press "/"). Type or scan a tracking ID, CN or
 * phone: matching parcels show as you type; Enter or a click opens the parcel in its side panel (the usual drawer),
 * with the other matches one click away. A zone or area name also shows the hub that serves it. The window closes with
 * Esc, the ✕ or a click outside.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router";
import { api } from "@panel/lib/api";
import { describe } from "@panel/lib/api";
import { useOps } from "@/lib/ops";
import { Icon } from "@panel/ui/Icon";
import { focusScanBox } from "@/features/scan/scanner";
import { toast } from "@panel/ui/toast";
import { findParcels, useCatalog } from "./search";
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
      <button type="button" className="search gs-trigger" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label="Search parcels: tracking ID, CN, phone or zone">
        <Icon name="search" />
        <span>Tracking ID, CN, phone or zone…</span>
        <kbd>/</kbd>
      </button>
      {open ? <SearchDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function SearchDialog({ onClose }: { onClose: () => void }) {
  const [, setParams] = useSearchParams();
  const catalog = useCatalog();
  const { hubs } = useOps();
  const input = useRef<HTMLInputElement>(null);
  const [shown, setShown] = useState(false);
  const [value, setValue] = useState("");
  const [results, setResults] = useState<Parcel[] | null>(null);
  const [places, setPlaces] = useState<Place[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [active, setActive] = useState(0);
  const seq = useRef(0);

  // Opens with a short fade-and-rise; closes the same way before it is removed.
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    input.current?.focus();
    return () => cancelAnimationFrame(id);
  }, []);
  const close = useCallback(() => {
    setShown(false);
    setTimeout(onClose, 180);
  }, [onClose]);

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
      setError("");
    } catch (e) {
      if (mine === seq.current) setError(describe(e));
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  }, []);

  // Parcels as you type (a scanner's Enter searches at once).
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

  const openParcel = (p: Parcel, list: Parcel[]) => {
    setParams(sp => {
      sp.set("parcel", p.trackingId);
      if (list.length > 1) sp.set("matches", list.slice(0, 20).map(x => x.trackingId).join(","));
      else sp.delete("matches");
      return sp;
    });
    close();
  };

  const onKey = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") return close();
    const list = results ?? [];
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(a => Math.min(a + 1, Math.max(0, list.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(a => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const raw = value.trim();
      if (!raw) return;
      // Scanned / typed and Enter at once: search now, then open the first match.
      if (!results || busy) {
        const found = await findParcels(raw).catch(err => (setError(describe(err)), [] as Parcel[]));
        setResults(found);
        if (found.length) openParcel(found[0], found);
        else toast(`No parcel found for “${raw}”.`);
        return;
      }
      if (list[active]) openParcel(list[active], list);
      else toast(`No parcel found for “${raw}”.`);
    }
  };

  const text = value.trim();
  return createPortal(
    <div className={`gs-backdrop${shown ? " in" : ""}`} role="presentation" onMouseDown={e => e.target === e.currentTarget && close()}>
      <section className="gs-panel" role="dialog" aria-modal="true" aria-label="Search parcels">
        <header className="gs-head">
          <Icon name="search" size={20} />
          <input ref={input} className="gs-input" type="search" autoComplete="off" placeholder="Tracking ID, CN, phone or zone…" aria-label="Tracking ID, CN, phone or zone" value={value} onChange={e => setValue(e.target.value)} onKeyDown={e => void onKey(e)} />
          {busy ? <span className="gs-spin" aria-label="Searching" /> : null}
          <button type="button" className="gs-close" aria-label="Close" onClick={close}>
            <Icon name="x" />
          </button>
        </header>
        <div className="gs-body">
          {!text ? (
            <div className="gs-empty">
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
              {results ? (
                <>
                  <div className="gs-section">{results.length ? `Parcels · ${results.length}${results.length >= 20 ? "+" : ""}` : busy ? "Searching…" : "No parcel found"}</div>
                  <ul className="gs-list" role="listbox" aria-label="Parcels">
                    {results.map((p, i) => (
                      <li key={p.trackingId} role="option" aria-selected={i === active}>
                        <button type="button" className={`gs-item${i === active ? " active" : ""}`} onMouseEnter={() => setActive(i)} onClick={() => openParcel(p, results)} style={{ animationDelay: `${Math.min(i, 8) * 25}ms` }}>
                          <span className="gs-item-top">
                            <strong className="gs-id">{p.trackingId}</strong>
                            <span className={`pill ${TONE[p.status] ?? ""}`}>{p.statusLabel}</span>
                            {money(p.codAmount) ? <span className="gs-cod">{`COD ${money(p.codAmount)}`}</span> : null}
                          </span>
                          <span className="gs-item-grid">
                            <span>
                              <small>Recipient</small>
                              {[p.recipient?.name, p.recipient?.phone].filter(Boolean).join(" · ") || "—"}
                            </span>
                            <span>
                              <small>Merchant</small>
                              {p.merchant?.name ?? p.sender?.name ?? "Customer"}
                            </span>
                            <span>
                              <small>To</small>
                              {[p.delivery?.zone, p.delivery?.district].filter(Boolean).join(", ") || "—"}
                            </span>
                            <span>
                              <small>Hub</small>
                              {p.currentHub?.name ?? "—"}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <div className="gs-empty">
                  <span>Searching…</span>
                </div>
              )}
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
      </section>
    </div>,
    document.body,
  );
}
