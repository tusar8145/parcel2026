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
  "customerParcelPricing",
  "serviceLevelFees",
];

/**
 * Old lists of the original pages, superseded by service packages or read by nothing: product
 * lists (the parcel products in Service plans → Products are the only product lists), document
 * types (now the package's handling options) and the demo "Service catalog" table. Dropped on
 * save and left out of every read, so a stale copy can't change any form.
 */
export const RETIRED_KEYS: readonly string[] = [
  "ecommerceProducts",
  "documentProducts",
  "documentProductTypes",
  "merchantProducts",
  "parcelProducts",
  "documentTypes",
  "serviceCatalog",
];

/** Keys PUT /settings/platform-config never stores. */
export const NOT_STORED_KEYS: readonly string[] = [...DERIVED_KEYS, ...RETIRED_KEYS];
