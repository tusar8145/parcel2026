/**
 * How an address is shown everywhere (screens, PDFs, exports): the address as it was typed, which is
 * the full address (house, road, area, city). District, zone and area are kept for operations (routing,
 * pricing, hubs) and shown in their own columns, never appended to it. Only when no address was typed
 * (old or incomplete records) do the place names stand in for it.
 */
export function addressText(street: string | null | undefined, ...places: (string | null | undefined)[]): string {
  const typed = (street ?? "").trim();
  if (typed) return typed;
  return [...new Set(places.map(p => (p ?? "").trim()).filter(Boolean))].join(", ");
}
