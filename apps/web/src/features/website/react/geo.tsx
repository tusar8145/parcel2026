"use client";

import { useEffect, useId, useRef, useState } from "react";
import { df } from "./df";

/** A place from GET /geo/search or /geo/reverse (OpenStreetMap Nominatim, via the API). */
export interface Place {
  label: string;
  lat: number;
  lng: number;
  street: string | null;
  area: string | null;
  zone: string | null;
  district: string | null;
}

const DHAKA = { lat: 23.7808, lng: 90.4093 };

let leaflet: Promise<any> | null = null;
/** Leaflet from /vendor/leaflet (copied from node_modules by scripts/vendor.mjs), loaded once. */
function loadLeaflet(): Promise<any> {
  if (window.L) return Promise.resolve(window.L);
  leaflet ??= new Promise((resolve, reject) => {
    if (!document.querySelector('link[href="/vendor/leaflet/leaflet.css"]')) {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = "/vendor/leaflet/leaflet.css";
      document.head.appendChild(css);
    }
    const script = document.createElement("script");
    script.src = "/vendor/leaflet/leaflet.js";
    script.onload = () => resolve(window.L);
    script.onerror = () => {
      leaflet = null;
      reject(new Error("The map could not be loaded"));
    };
    document.head.appendChild(script);
  });
  return leaflet;
}

/**
 * Address autocomplete: suggestions appear after 3 characters (debounced, cached by the
 * API). Choosing one fills the form through `onPick`; typing freely always works too.
 */
export function AddressSearch({ id, onPick, placeholder = "Search for a road, area or landmark" }: { id: string; onPick: (place: Place) => void; placeholder?: string }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Place[]>([]);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [active, setActive] = useState(-1);
  const listId = useId();
  const seq = useRef(0);

  useEffect(() => {
    const text = q.trim();
    if (text.length < 3) {
      setItems([]);
      setNote("");
      return;
    }
    const mine = ++seq.current;
    const timer = setTimeout(() => {
      df()
        .api<{ items: Place[] }>(`/geo/search?q=${encodeURIComponent(text)}&limit=5`)
        .then(r => {
          if (mine !== seq.current) return;
          setItems(r.items);
          setNote(r.items.length ? "" : "No matches. Type the address in the fields below.");
          setOpen(true);
          setActive(-1);
        })
        .catch(err => mine === seq.current && setNote(df().describe(err)));
    }, 450);
    return () => clearTimeout(timer);
  }, [q]);

  const pick = (place: Place) => {
    onPick(place);
    setQ(place.label);
    setOpen(false);
  };

  return (
    <div className="df-address-search" style={{ position: "relative" }}>
      <input
        id={id}
        value={q}
        onChange={e => setQ(e.target.value)}
        onFocus={() => items.length && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={e => {
          if (!open || !items.length) return;
          if (e.key === "ArrowDown") (e.preventDefault(), setActive(a => Math.min(items.length - 1, a + 1)));
          if (e.key === "ArrowUp") (e.preventDefault(), setActive(a => Math.max(0, a - 1)));
          if (e.key === "Enter" && active >= 0) (e.preventDefault(), pick(items[active]));
          if (e.key === "Escape") setOpen(false);
        }}
        placeholder={placeholder}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
      />
      {open && items.length ? (
        <ul
          id={listId}
          role="listbox"
          style={{
            position: "absolute",
            zIndex: 20,
            left: 0,
            right: 0,
            top: "100%",
            margin: "4px 0 0",
            padding: 4,
            listStyle: "none",
            background: "#fff",
            border: "1px solid #dfe8e2",
            borderRadius: 8,
            boxShadow: "0 10px 24px #0f2b2014",
          }}
        >
          {items.map((place, i) => (
            <li
              key={`${place.lat},${place.lng},${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={e => (e.preventDefault(), pick(place))}
              style={{ padding: "8px 10px", borderRadius: 6, cursor: "pointer", fontSize: 13, background: i === active ? "#eef6f2" : undefined }}
            >
              {place.label}
            </li>
          ))}
        </ul>
      ) : null}
      {note ? <small className="field-hint">{note}</small> : null}
    </div>
  );
}

/**
 * A map (OpenStreetMap tiles) with a draggable pin. Clicking or dragging moves the pin
 * and, after a short pause, looks up the address there (`onAddress`).
 */
export function MapPin({
  value,
  onChange,
  onAddress,
  height = 220,
}: {
  value: { lat: number; lng: number } | null;
  onChange: (pin: { lat: number; lng: number }) => void;
  onAddress?: (place: Place) => void;
  height?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<any>(null);
  const marker = useRef<any>(null);
  const [failed, setFailed] = useState("");
  const latest = useRef({ onChange, onAddress });
  latest.current = { onChange, onAddress };

  useEffect(() => {
    let disposed = false;
    let lookup: ReturnType<typeof setTimeout> | undefined;
    loadLeaflet()
      .then(L => {
        if (disposed || !box.current) return;
        const start = value ?? DHAKA;
        map.current = L.map(box.current, { scrollWheelZoom: false }).setView([start.lat, start.lng], value ? 16 : 12);
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        }).addTo(map.current);
        const icon = L.icon({ iconUrl: "/vendor/leaflet/images/marker-icon.png", iconRetinaUrl: "/vendor/leaflet/images/marker-icon-2x.png", shadowUrl: "/vendor/leaflet/images/marker-shadow.png", iconSize: [25, 41], iconAnchor: [12, 41] });
        marker.current = L.marker([start.lat, start.lng], { draggable: true, icon, opacity: value ? 1 : 0.55 }).addTo(map.current);
        const moved = (lat: number, lng: number) => {
          marker.current.setOpacity(1);
          const pin = { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
          latest.current.onChange(pin);
          clearTimeout(lookup);
          if (latest.current.onAddress)
            lookup = setTimeout(() => {
              df()
                .api<{ place: Place | null }>(`/geo/reverse?lat=${pin.lat}&lng=${pin.lng}`)
                .then(r => r.place && latest.current.onAddress?.(r.place))
                .catch(() => undefined);
            }, 700);
        };
        marker.current.on("dragend", () => {
          const { lat, lng } = marker.current.getLatLng();
          moved(lat, lng);
        });
        map.current.on("click", (e: { latlng: { lat: number; lng: number } }) => {
          marker.current.setLatLng(e.latlng);
          moved(e.latlng.lat, e.latlng.lng);
        });
      })
      .catch(err => setFailed(err.message));
    return () => {
      disposed = true;
      clearTimeout(lookup);
      map.current?.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow pins set from outside (a chosen suggestion).
  useEffect(() => {
    if (!value || !map.current || !marker.current) return;
    const current = marker.current.getLatLng();
    if (Math.abs(current.lat - value.lat) < 1e-6 && Math.abs(current.lng - value.lng) < 1e-6) return;
    marker.current.setLatLng([value.lat, value.lng]).setOpacity(1);
    map.current.setView([value.lat, value.lng], Math.max(map.current.getZoom(), 16));
  }, [value]);

  if (failed) return <small className="field-hint">{"The map isn't available right now. The typed address is enough."}</small>;
  return (
    <div>
      <div ref={box} className="df-map" style={{ height, borderRadius: 10, border: "1px solid #dfe8e2", overflow: "hidden", isolation: "isolate", zIndex: 0 }} aria-label="Map: click or drag the pin to the exact spot" />
      <small className="field-hint">{value ? `Pin set at ${value.lat.toFixed(5)}, ${value.lng.toFixed(5)}. Drag it to adjust.` : "Optional: click the map to drop a pin at the exact door."}</small>
    </div>
  );
}

/** Picks the catalog option that matches a place's name (case-insensitive, "Dhaka" ≈ "Dhaka North"). */
export function matchOption(options: string[], ...names: (string | null | undefined)[]) {
  for (const name of names) {
    if (!name) continue;
    const n = name.toLowerCase();
    const exact = options.find(o => o.toLowerCase() === n);
    if (exact) return exact;
    const partial = options.find(o => o.toLowerCase().includes(n) || n.includes(o.toLowerCase()));
    if (partial) return partial;
  }
  return "";
}
