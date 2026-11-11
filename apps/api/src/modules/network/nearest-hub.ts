/** Great-circle distance in km. */
export function distanceKm(aLat: number, aLng: number, bLat: number, bLng: number) {
  const r = (d: number) => (d * Math.PI) / 180;
  const dLat = r(bLat - aLat);
  const dLng = r(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The nearest of these places (with a location) to a point, or null. */
export function nearestOf<T extends { lat: number | null; lng: number | null }>(places: readonly T[], lat: number, lng: number): T | null {
  let best: { p: T; km: number } | null = null;
  for (const p of places) {
    if (p.lat == null || p.lng == null) continue;
    const km = distanceKm(lat, lng, p.lat, p.lng);
    if (!best || km < best.km) best = { p, km };
  }
  return best?.p ?? null;
}
