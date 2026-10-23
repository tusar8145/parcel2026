"use client";

import { useEffect, useRef } from "react";

export interface FoundPlace {
  district?: string;
  zone?: string;
  area?: string;
}

/**
 * The address field holds the full address: once it is typed (a pause), GET /catalog/place finds its
 * district, zone and area and `apply` picks them (the user can still change them; typing the address
 * again picks again). Only typing triggers it: an address loaded into the form (editing a saved one)
 * keeps the places it has. Same rule as the panels' DF.autoPlace (public/legacy/shared/api.js).
 */
export function usePlaceFromAddress(address: string, apply: (place: FoundPlace) => void, delayMs = 900) {
  const read = useRef(address.trim());
  const latest = useRef(apply);
  latest.current = apply;
  useEffect(() => {
    const text = address.trim();
    if (text.length < 4 || text === read.current) return;
    const timer = setTimeout(async () => {
      read.current = text;
      try {
        const res = await fetch(`/api/v1/catalog/place?address=${encodeURIComponent(text)}`);
        if (!res.ok) return;
        const place = (await res.json()) as FoundPlace;
        if (place.district || place.zone) latest.current(place);
      } catch {
        // Offline or the server busy: the fields stay as they are.
      }
    }, delayMs);
    return () => clearTimeout(timer);
  }, [address, delayMs]);
}
