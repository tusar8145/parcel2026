/**
 * Settings that only mirror server data (PUT /catalog and the rate cards in force). They are
 * filled in from that data on every read and never stored, so no page can show places or
 * prices other than the ones bookings are validated and priced with.
 */
export const DERIVED_KEYS: readonly string[] = [
  "deliveryServices",
  "geoCatalog",
  "geoHierarchy",
  "ecommercePackaging",
  "ecommerceProducts",
  "customerParcelPricing",
  "serviceLevelFees",
];
