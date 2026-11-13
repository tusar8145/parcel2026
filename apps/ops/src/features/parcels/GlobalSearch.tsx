/**
 * The top bar's search: a box that opens the search window (click it, or press "/"). Type or scan a tracking ID, CN
 * or phone: the parcel's full details open at once over the whole window (three columns), with its status under the
 * search box; other matches show there as tags, one click away. A zone or area name shows the hub that serves it. The
 * window closes with Esc, the ✕ or a click outside. Parcels opened anywhere else still open in the side panel.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { api, describe } from "@panel/lib/api";
import { when } from "@panel/lib/format";
import { useOps } from "@/lib/ops";
import { Icon } from "@panel/ui/Icon";
import { focusScanBox } from "@/features/scan/scanner";
import { toast } from "@panel/ui/toast";
import { findParcels, useCatalog } from "./search";
import { DrawerContent } from "./ParcelDrawer";
import { failureBadge, failureText, slaOf, type Parcel } from "./model";
import "./global-search.css";

type Place = { district: string; zone: string; area?: string; hub: { name: string } | null };
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

/** The chosen parcel's status, under the search box (the details below have no header of their own). */
function StatusLine({ id }: { id: string }) {
  const q = useQuery({ queryKey: ["parcel", id], queryFn: () => api<Parcel>(`/parcels/${encodeURIComponent(id)}`), staleTime: 5_000 });
  const p = q.data;
  if (!p) return <span className="gs-status faint">Loading…</span>;
  const badge = failureBadge(p);
  return (
    <span className="gs-status">
      <span className={`pill ${TONE[p.status] ?? ""}`}>{p.statusLabel}</span>
      <span className="pill">{slaOf(p)}</span>
      {badge ? <span className="pill bad" title={failureText(p, when)}>{`Failed ×${badge.count}${badge.reason ? ` · ${badge.reason.slice(0, 26)}` : ""}`}</span> : null}
      <span className="gs-status-meta">{[p.merchant?.name ?? p.sender?.name, p.currentHub?.name].filter(Boolean).join(" · ")}</span>
    </span>
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
      setPicked(null);
      setError("");
      return [] as Parcel[];
    }
    setBusy(true);
    try {
      const found = await findParcels(text);
      if (mine !== seq.current) return found;
      setResults(found);
      // The first match's details at once.
      setPicked(found[0]?.trackingId ?? null);
      setError("");
      return found;
    } catch (e) {
      if (mine === seq.current) setError(describe(e));
      return [] as Parcel[];
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

  // Enter (a scanner's, too): search now.
  const onKey = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const raw = value.trim();
    if (!raw) return;
    const found = await run(raw);
    if (!found.length) toast(`No parcel found for “${raw}”.`);
    input.current?.select();
  };

  const text = value.trim();
  const list = results ?? [];
  return createPortal(
    <div className={`gs-backdrop${shown ? " in" : ""}`} role="presentation" onMouseDown={e => e.target === e.currentTarget && close()}>
      <section className="gs-panel" role="dialog" aria-modal="true" aria-label="Search parcels">
        <header className="gs-head">
          <div className="gs-head-row">
            <label className="gs-field">
              <Icon name="search" size={18} />
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
          </div>
          {picked ? (
            <div className="gs-head-row gs-sub">
              <StatusLine id={picked} />
              {list.length > 1 ? (
                <span className="gs-chips" aria-label="Other matches">
                  <small className="faint">{`${list.length} matches:`}</small>
                  {list.slice(0, 12).map(p => (
                    <button key={p.trackingId} type="button" className={`gs-chip${p.trackingId === picked ? " on" : ""}`} onClick={() => setPicked(p.trackingId)}>
                      {p.trackingId}
                    </button>
                  ))}
                </span>
              ) : null}
            </div>
          ) : null}
        </header>
        {picked ? (
          <div className="gs-full" key={picked}>
            <DrawerContent id={picked} matches={[]} close={() => setPicked(null)} closeRef={detailClose} wide />
          </div>
        ) : (
          <div className="gs-results">
            {error ? <div className="callout bad" style={{ margin: "0 0 10px" }}>{error}</div> : null}
            {!text ? (
              <div className="gs-empty">
                <span className="gs-empty-icon">
                  <Icon name="search" size={26} />
                </span>
                <strong>Find a parcel</strong>
                <span>Type or scan a tracking ID or CN, or a phone number: the parcel opens here. A zone or area name shows the hub that serves it.</span>
                <span className="gs-keys">
                  <kbd>Enter</kbd> search · <kbd>Esc</kbd> close
                </span>
              </div>
            ) : text.length < 3 ? (
              <div className="gs-empty">
                <span>Type at least 3 characters.</span>
              </div>
            ) : busy || !results ? (
              <div className="gs-empty">
                <span>Searching…</span>
              </div>
            ) : !places.length ? (
              <div className="gs-empty">
                <strong>No parcel found</strong>
                <span>{`Nothing matches “${text}”. Check the tracking ID, CN or phone number.`}</span>
              </div>
            ) : null}
            {places.length && !busy ? (
              <>
                <div className="gs-section">Which hub serves it</div>
                <ul className="gs-grid">
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
          </div>
        )}
      </section>
    </div>,
    document.body,
  );
}
