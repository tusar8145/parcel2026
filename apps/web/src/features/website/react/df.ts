/**
 * Typed access to the browser client (public/legacy/shared/api.js → window.DF) and to the
 * website bridge (public/legacy/website/bridge.js → window.DFWebsite) from React.
 */

export interface ApiErrorLike extends Error {
  status: number;
  code: string;
  details?: unknown;
}

export interface SessionUser {
  id: string;
  name: string;
  phone: string;
  email?: string | null;
  roles: string[];
  panel?: string;
}

export type MfaChallenge = { mfaRequired?: boolean; mfaSetupRequired?: boolean; mfaToken: string; methods?: string[] };

interface DFClient {
  api<T = any>(path: string, options?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<T>;
  ApiError: new (...args: any[]) => ApiErrorLike;
  ready?: Promise<unknown>;
  describe(error: unknown): string;
  /** The shared small confirm dialog (public/legacy/shared/api.js). */
  confirm(options: string | { title?: string; message?: string; confirm?: string; cancel?: string; danger?: boolean }): Promise<boolean>;
  localPhone(phone: string): string;
  state: { user: SessionUser | null; catalog: Catalog | null };
  route: {
    path(): string;
    hash(): string;
    url(route: string): string;
    go(route: string, opts?: { replace?: boolean }): void;
    replace(route: string): void;
  };
  auth: {
    user: SessionUser | null;
    hasRole(...roles: string[]): boolean;
    requestOtp(phone: string, purpose: "SIGNUP" | "LOGIN" | "PASSWORD_RESET"): Promise<OtpSent>;
    login(identifier: string, password: string): Promise<SessionUser | MfaChallenge>;
    loginWithOtp(phone: string, otp: string): Promise<SessionUser | MfaChallenge>;
    loginMfa(mfaToken: string, code: string): Promise<SessionUser>;
    mfaSetup(mfaToken: string): Promise<{ otpauthUrl: string; qrDataUrl: string; secret?: string }>;
    mfaEnable(mfaToken: string, code: string): Promise<{ user: SessionUser; recoveryCodes: string[] }>;
    signup(input: Record<string, unknown>): Promise<SessionUser>;
    resetPassword(input: { phone: string; otp: string; password: string }): Promise<{ message: string }>;
    guestVerification(phone: string): Promise<OtpSent>;
    guestConfirm(phone: string, code: string): Promise<{ verificationToken: string; phone: string; expiresAt: string }>;
    emailVerification: {
      status(): Promise<EmailStatus>;
      send(): Promise<EmailStatus & { sent: boolean; message: string; resendAfterSeconds?: number; devCode?: string }>;
      confirm(body: { token?: string; code?: string }): Promise<EmailStatus & { message: string }>;
    };
  };
  parcels: { reload(): Promise<boolean>; cache: any[] };
  setAddressBook(rows: unknown[]): void;
  events?: { on(type: string, handler: (data: any) => void): () => void };
}

export interface OtpSent {
  message: string;
  expiresInSeconds?: number;
  resendAfterSeconds?: number;
  devCode?: string;
}

export interface EmailStatus {
  email: string | null;
  verified: boolean;
  verifiedAt: string | null;
  pending: boolean;
}

export interface Catalog {
  districts: string[];
  zonesByDistrict: Record<string, string[]>;
  areasByZone: Record<string, string[]>;
  packaging: string[];
  products: string[];
  /** Products whose "Send SMS & email" switch is off (no parcel messages for them). */
  productsWithoutMessages?: string[];
  weightsKg: number[];
  serviceLevels: Record<string, string>;
  /** The website customer package (service packages): the choices it offers, labels, messages and hubs. */
  customerPackage?: CustomerPackage;
}

export interface CustomerPackage {
  options: { firstMiles: string[]; lastMiles: string[]; speeds: string[]; cod: boolean; defaultFirstMile?: string; defaultLastMile?: string };
  labels: { firstMile: Record<string, string>; lastMile: Record<string, string>; speed: Record<string, string> };
  notifications: { code: string; title: string }[];
  dropHubs: { id: string; name: string; address: string }[];
  collectHubs: { id: string; name: string; address: string }[];
}

interface WebsiteBridge {
  /** After a session starts: customers go to their account (or where they were going), others to their panel. */
  signedIn(user: SessionUser): Promise<void>;
  /** Remembers where to come back to, then opens the sign-in page. */
  askToSignIn(route: string, message: string): void;
  /** Re-reads parcels and saved addresses into the page scripts' data. */
  refreshAccount(): Promise<void>;
  applicationSent(title: string, message: string): void;
}

declare global {
  interface Window {
    DFWebsite?: WebsiteBridge;
    DFReact?: { owns(route: string): boolean };
    showToast?: (message: string) => void;
    L?: any;
  }
}

// window.DF is declared loosely in src/shared/LegacyScripts.tsx; this is its full shape.
export const df = (): DFClient => (window as unknown as { DF: DFClient }).DF;
export const site = (): WebsiteBridge | undefined => window.DFWebsite;
export const toast = (message: string) => (window.showToast ? window.showToast(message) : console.info(message));
export const navigate = (route: string) => df().route.go(route);

export const isApiError = (error: unknown): error is ApiErrorLike =>
  !!error && typeof error === "object" && "status" in error && "code" in error;

/** Field messages from a VALIDATION_FAILED (or similar) error: { "sender.phone": "…" }. */
export function fieldErrors(error: unknown): Record<string, string> {
  if (!isApiError(error) || !Array.isArray(error.details)) return {};
  const out: Record<string, string> = {};
  for (const d of error.details as { path?: string | (string | number)[]; message?: string }[]) {
    const path = Array.isArray(d.path) ? d.path.join(".") : d.path;
    if (path && d.message && !out[path]) out[path] = d.message;
  }
  return out;
}

/** Seconds to wait from a 429 (details.retryAfterSeconds / Retry-After), else 0. */
export function retryAfter(error: unknown): number {
  if (!isApiError(error) || error.status !== 429) return 0;
  const details = error.details as { retryAfterSeconds?: number } | undefined;
  return Math.max(0, Math.ceil(details?.retryAfterSeconds ?? 60));
}

export const describe = (error: unknown) => df().describe(error);
