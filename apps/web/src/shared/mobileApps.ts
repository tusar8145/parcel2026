/**
 * The Android apps (mobile/merchant_app, mobile/rider_app, mobile/ops_app), served from public/downloads. A new build replaces
 * the file and its numbers here (the APKs run on phones (ARM 32/64-bit) and the Android emulator (x86_64)).
 */
export const MOBILE_APPS = {
  merchant: { href: "/downloads/delivery-fast-merchant.apk", fileName: "DeliveryFast-Merchant-1.3.0.apk", version: "1.3.0", sizeMb: 69 },
  rider: { href: "/downloads/delivery-fast-rider.apk", fileName: "DeliveryFast-Rider-1.2.0.apk", version: "1.2.0", sizeMb: 68 },
  operations: { href: "/downloads/delivery-fast-operations.apk", fileName: "DeliveryFast-Operations-1.0.0.apk", version: "1.0.0", sizeMb: 69 },
} as const;

export type MobileApp = keyof typeof MOBILE_APPS;
