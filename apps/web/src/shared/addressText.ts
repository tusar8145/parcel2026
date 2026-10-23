/**
 * How an address is shown: the address as typed (the full address). District, zone and area are kept
 * for operations and never appended to it; they stand in only when no address was typed. Same rule as
 * the API's `addressText` (apps/api/src/common/address.ts).
 */
export function addressText(street: string | null | undefined, ...places: (string | null | undefined)[]): string {
  const typed = (street ?? "").trim();
  if (typed) return typed;
  return [...new Set(places.map(p => (p ?? "").trim()).filter(Boolean))].join(", ");
}
