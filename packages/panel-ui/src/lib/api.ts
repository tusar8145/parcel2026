/**
 * API client for /api/v1 (same origin). The access token lives in memory only; the refresh token is the
 * API's httpOnly cookie (path /api/v1/auth), so a reload restores the session with POST /auth/refresh.
 * Mirrors public/legacy/shared/api.js: one refresh at a time, retry once on TOKEN_EXPIRED / SESSION_REVOKED,
 * `x-df-client: web`, and the Scan desk operation time sent as X-Operation-Time on changes.
 */
export const API_BASE = "/api/v1";

export interface ApiErrorBody {
  code?: string;
  message?: string;
  details?: { path?: string; message: string }[] | unknown;
  requestId?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly requestId?: string;
  constructor(status: number, error?: ApiErrorBody) {
    super(error?.message || `Request failed (${status})`);
    this.status = status;
    this.code = error?.code || "ERROR";
    this.details = error?.details;
    this.requestId = error?.requestId;
  }
}

export interface SessionUser {
  id: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  roles: string[];
  permissions?: string[];
  panel?: string | null;
  avatarUrl?: string | null;
  impersonation?: { readOnly?: boolean; adminName?: string } | null;
  [key: string]: unknown;
}

interface SessionResult {
  accessToken: string;
  expiresIn: number;
  user: SessionUser;
}

let accessToken: string | null = null;
let accessExpiresAt = 0;
let refreshing: Promise<SessionUser | null> | null = null;
let operationTime: string | null = null;
const sessionListeners = new Set<(user: SessionUser | null) => void>();

/** Scan desk / Parcel queue: the date & time entries are recorded at (ISO), or null for now. */
export function setOperationTime(iso: string | null) {
  operationTime = iso;
}
export const getOperationTime = () => operationTime;

export function onSessionChange(listener: (user: SessionUser | null) => void) {
  sessionListeners.add(listener);
  return () => void sessionListeners.delete(listener);
}
const announce = (user: SessionUser | null) => sessionListeners.forEach(l => l(user));

export const currentToken = () => accessToken;

function headers(method: string, extra: Record<string, string>, json: boolean, auth: boolean) {
  return {
    "x-df-client": "web",
    ...(json ? { "content-type": "application/json" } : {}),
    ...(auth && accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    ...(operationTime && method !== "GET" ? { "x-operation-time": operationTime } : {}),
    ...extra,
  };
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
  auth?: boolean;
  signal?: AbortSignal;
}

async function rawFetch<T>(path: string, { method = "GET", body, headers: extra = {}, auth = true, signal }: RequestOptions = {}): Promise<T> {
  const response = await fetch(API_BASE + path, {
    method,
    credentials: "same-origin",
    headers: headers(method, extra, body !== undefined, auth),
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!response.ok) throw new ApiError(response.status, (data as { error?: ApiErrorBody } | undefined)?.error);
  return data as T;
}

export function acceptSession(result: SessionResult) {
  accessToken = result.accessToken;
  accessExpiresAt = Date.now() + (result.expiresIn - 30) * 1000;
  announce(result.user);
  return result.user;
}

/** One refresh at a time; resolves to the user, or null when signed out. Throws only when the server can't be reached. */
export function refresh(): Promise<SessionUser | null> {
  refreshing ??= rawFetch<SessionResult>("/auth/refresh", { method: "POST", auth: false })
    .then(acceptSession)
    .catch(error => {
      accessToken = null;
      if (!(error instanceof ApiError)) throw error;
      announce(null);
      return null;
    })
    .finally(() => (refreshing = null));
  return refreshing;
}

const RETRY_CODES = ["TOKEN_EXPIRED", "SESSION_REVOKED"];

/** Authenticated JSON call; refreshes the access token when it expires. */
export async function api<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  if (accessToken && Date.now() > accessExpiresAt) await refresh();
  try {
    return await rawFetch<T>(path, options);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401 && RETRY_CODES.includes(error.code) && (await refresh())) return rawFetch<T>(path, options);
    if (error instanceof ApiError && error.status === 401 && options.auth !== false) announce(null);
    throw error;
  }
}

/** Requests that aren't JSON (FormData uploads, file downloads). Resolves the Response. */
export async function apiRaw(path: string, { method = "GET", body, headers: extra = {}, keepalive = false }: { method?: string; body?: BodyInit; headers?: Record<string, string>; keepalive?: boolean } = {}) {
  if (accessToken && Date.now() > accessExpiresAt) await refresh();
  const send = () => fetch(API_BASE + path, { method, credentials: "same-origin", keepalive, headers: headers(method, extra, false, true), body });
  let response = await send();
  if (response.status === 401) {
    const data = await response.clone().json().catch(() => null);
    if (RETRY_CODES.includes(data?.error?.code) && (await refresh())) response = await send();
  }
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new ApiError(response.status, data?.error);
  }
  return response;
}

/** Downloads a file from the API (CSV, Excel, PDF), named by Content-Disposition. */
export async function download(path: string, fallbackName = "download") {
  const response = await apiRaw(path);
  const disposition = response.headers.get("content-disposition") || "";
  const match = /filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i.exec(disposition);
  const name = match ? decodeURIComponent(match[1] || match[2]) : fallbackName;
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return name;
}

/** Opens an API-generated PDF (labels, run sheets, invoices) in a new tab. */
export async function openPdf(path: string) {
  const tab = window.open("about:blank", "_blank");
  try {
    const blob = await (await apiRaw(path)).blob();
    const url = URL.createObjectURL(blob);
    if (tab && !tab.closed) tab.location.href = url;
    else window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) {
    tab?.close();
    throw error;
  }
}

/** Public, unauthenticated auth calls. */
export const authApi = {
  login: (identifier: string, password: string) => rawFetch<SessionResult | MfaChallenge>("/auth/login", { method: "POST", body: { identifier, password }, auth: false }),
  requestOtp: (phone: string) => rawFetch<{ sent?: boolean; devOtp?: string }>("/auth/otp", { method: "POST", body: { phone, purpose: "LOGIN" }, auth: false }),
  loginWithOtp: (phone: string, otp: string) => rawFetch<SessionResult | MfaChallenge>("/auth/login/otp", { method: "POST", body: { phone, otp }, auth: false }),
  loginMfa: (mfaToken: string, code: string) => rawFetch<SessionResult>("/auth/login/mfa", { method: "POST", body: { mfaToken, code }, auth: false }),
  mfaSetup: (mfaToken: string) => rawFetch<{ otpauthUrl: string; qrDataUrl: string; secret: string }>("/auth/mfa/setup", { method: "POST", body: { mfaToken }, auth: false }),
  mfaEnable: (mfaToken: string, code: string) => rawFetch<SessionResult & { recoveryCodes?: string[] }>("/auth/mfa/enable", { method: "POST", body: { mfaToken, code }, auth: false }),
  async logout() {
    await rawFetch("/auth/logout", { method: "POST", auth: false }).catch(() => undefined);
    accessToken = null;
    announce(null);
  },
};

export interface MfaChallenge {
  mfaRequired?: boolean;
  mfaSetupRequired?: boolean;
  mfaToken: string;
  [key: string]: unknown;
}
export const isSession = (r: SessionResult | MfaChallenge): r is SessionResult => "accessToken" in r && !!(r as SessionResult).accessToken;

/** A readable message for any error (validation details joined), like DF.describe. */
export function describe(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "VALIDATION_FAILED" && Array.isArray(error.details) && error.details.length) return (error.details as { message: string }[]).map(d => d.message).join(" · ");
    if (error.status === 0 || error.status >= 500) return "We couldn't reach Delivery Fast. Please try again.";
    return error.message;
  }
  return "We couldn't reach Delivery Fast. Check your connection and try again.";
}
