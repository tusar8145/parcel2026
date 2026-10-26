/**
 * The Android apps (mobile/merchant_app, mobile/rider_app), served from public/downloads. A new build replaces
 * the file and its numbers here (the APKs are built for phones only: ARM 32/64-bit).
 */
export const MOBILE_APPS = {
  merchant: { href: "/downloads/delivery-fast-merchant.apk", fileName: "DeliveryFast-Merchant-1.2.0.apk", version: "1.2.0", sizeMb: 49 },
  rider: { href: "/downloads/delivery-fast-rider.apk", fileName: "DeliveryFast-Rider-1.0.0.apk", version: "1.0.0", sizeMb: 49 },
} as const;

export type MobileApp = keyof typeof MOBILE_APPS;
