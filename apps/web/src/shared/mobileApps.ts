/**
 * The Android apps (mobile/merchant_app, mobile/rider_app, mobile/ops_app), served from public/downloads. Their names and icon are neutral; the company's name, logo and
 * contact details come from the server (Super admin › Branding & company). A new build replaces
 * the file and its numbers here (the APKs run on phones (ARM 32/64-bit) and the Android emulator (x86_64)).
 */
export const MOBILE_APPS = {
  merchant: { href: "/downloads/merchant.apk", fileName: "Merchant-1.4.0.apk", version: "1.4.0", sizeMb: 69 },
  rider: { href: "/downloads/rider.apk", fileName: "Rider-1.3.0.apk", version: "1.3.0", sizeMb: 68 },
  operations: { href: "/downloads/operations.apk", fileName: "Operations-1.1.0.apk", version: "1.1.0", sizeMb: 69 },
} as const;

export type MobileApp = keyof typeof MOBILE_APPS;
