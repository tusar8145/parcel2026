/*
 * Delivery Fast web client: API access, sign-in state and the bridge that lets the
 * original page scripts run on real data.
 *
 * - DF.api(path, options) calls /api/v1 (proxied by Next.js, so it's same-origin). The
 *   access token lives in memory only; the refresh token is an httpOnly cookie.
 * - DF.boot(app) runs before the page scripts: restores the session, enforces which
 *   roles may open the panel and preloads the data the page reads.
 * - API-backed localStorage keys are served from memory (see VIRTUAL_KEYS), so the
 *   page scripts keep their synchronous reads but nothing personal is left in the
 *   browser after sign-out.
 */
(() => {
  const BASE = "/api/v1";
  const PARCELS_KEY = "deliveryfast-customer-parcels";
  const SESSION_KEY = "deliveryfast-customer-session";
  const ADDRESS_KEY = "deliveryfast-customer-address-book";
  const CONFIG_KEY = "deliveryfast-demo-config";
  const RETURN_KEY = "deliveryfast-after-login";

  /** Which roles may open each panel. */
  const PANEL_ROLES = {
    "courier-operation": ["SUPER_ADMIN", "OPS_MANAGER", "HUB_OPERATOR", "FINANCE", "SUPPORT_AGENT"],
    rider: ["RIDER"],
    "ecommerce-merchant": ["MERCHANT_OWNER", "MERCHANT_STAFF", "SUPER_ADMIN"],
    "banking-merchant": ["MERCHANT_OWNER", "MERCHANT_STAFF", "SUPER_ADMIN"],
    "super-admin": ["SUPER_ADMIN"],
    franchise: ["FRANCHISE"],
    // Rider / franchise applicants waiting for approval: only their application page.
    application: ["APPLICANT"],
  };

  let accessToken = null;
  let accessExpiresAt = 0;
  let refreshing = null;

  // Support access ("view as" from super admin, "Log in as" from Courier Operations): this tab runs
  // on a short-lived, non-refreshable token kept for this tab only. It never touches the admin's
  // own session, and the rider app keeps nothing of it on the device (offline.js).
  const SUPPORT_KEY = "df-support-access";
  let supportAccess = null;
  try {
    if (new URLSearchParams(location.search).has("support-access")) {
      const handed = window.opener?.DF?.takeSupportAccess?.();
      if (handed) sessionStorage.setItem(SUPPORT_KEY, JSON.stringify(handed));
      history.replaceState(null, "", location.pathname + location.hash);
    }
    const stored = JSON.parse(sessionStorage.getItem(SUPPORT_KEY) || "null");
    if (stored?.accessToken && stored.expiresAt > Date.now()) supportAccess = stored;
    else sessionStorage.removeItem(SUPPORT_KEY);
  } catch {}
  const state = { user: null, app: document.body.dataset.app || "website", catalog: null, platformConfig: null, hubs: [], riders: [] };

  class ApiError extends Error {
    constructor(status, error) {
      super(error?.message || `Request failed (${status})`);
      this.status = status;
      this.code = error?.code || "ERROR";
      this.details = error?.details;
      this.requestId = error?.requestId;
    }
  }

  async function rawFetch(path, { method = "GET", body, headers = {}, auth = true } = {}) {
    const response = await fetch(BASE + path, {
      method,
      credentials: "same-origin",
      headers: {
        "x-df-client": "web",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(auth && accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!response.ok) throw new ApiError(response.status, data?.error);
    return data;
  }

  function acceptSession(result) {
    accessToken = result.accessToken;
    accessExpiresAt = Date.now() + (result.expiresIn - 30) * 1000;
    state.user = result.user;
    return result.user;
  }

  /** One refresh at a time; resolves to the user or null. */
  function refresh() {
    if (supportAccess) {
      // Support access can't be refreshed: it ends when its token expires.
      if (Date.now() >= supportAccess.expiresAt) return Promise.resolve(endSupportAccess("expired"));
      accessToken = supportAccess.accessToken;
      accessExpiresAt = supportAccess.expiresAt;
      refreshing ??= rawFetch("/auth/me")
        .then(user => (state.user = user))
        .catch(() => {
          endSupportAccess("ended");
          supportEnded?.("ended");
          return null;
        })
        .finally(() => (refreshing = null));
      return refreshing;
    }
    refreshing ??= rawFetch("/auth/refresh", { method: "POST", auth: false })
      .then(user => {
        state.networkDown = false;
        return acceptSession(user);
      })
      .catch(error => {
        accessToken = null;
        // No answer at all (offline, server unreachable) is not the same as a signed-out session.
        state.networkDown = !(error instanceof ApiError);
        // A rider working offline keeps going; queued actions wait for a fresh sign-in.
        if (!state.offlineSession) state.user = null;
        return null;
      })
      .finally(() => (refreshing = null));
    return refreshing;
  }

  /** Authenticated call; refreshes the access token when it expires. */
  async function api(path, options = {}) {
    // A session restored offline (rider app) gets its token once the connection is back.
    if ((accessToken && Date.now() > accessExpiresAt) || (!accessToken && state.offlineSession)) await refresh();
    try {
      return await rawFetch(path, options);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401 && ["TOKEN_EXPIRED", "SESSION_REVOKED"].includes(error.code) && (await refresh())) {
        return rawFetch(path, options);
      }
      throw error;
    }
  }

  /**
   * Authenticated request that isn't JSON: `body` may be FormData (file uploads); resolves to the
   * Response (e.g. `.blob()` for downloads). Errors throw ApiError like DF.api.
   */
  async function apiRaw(path, { method = "GET", body, headers = {} } = {}) {
    if ((accessToken && Date.now() > accessExpiresAt) || (!accessToken && state.offlineSession)) await refresh();
    const send = () =>
      fetch(BASE + path, { method, credentials: "same-origin", headers: { "x-df-client": "web", ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}), ...headers }, body });
    let response = await send();
    if (response.status === 401) {
      const data = await response.clone().json().catch(() => null);
      if (["TOKEN_EXPIRED", "SESSION_REVOKED"].includes(data?.error?.code) && (await refresh())) response = await send();
    }
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new ApiError(response.status, data?.error);
    }
    return response;
  }

  /** Downloads a file from the API with the session (the token isn't a cookie) and saves it. */
  async function download(path, fallbackName = "download") {
    const response = await apiRaw(path);
    const disposition = response.headers.get("content-disposition") || "";
    const name = disposition.match(/filename="?([^";]+)"?/)?.[1] || fallbackName;
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return name;
  }

  /**
   * A sign-in response is either a session (→ the user) or a second-step challenge:
   * { mfaRequired, mfaToken, methods } or { mfaSetupRequired, mfaToken } (no session yet).
   * Callers check `result.mfaRequired || result.mfaSetupRequired`.
   */
  const sessionOrChallenge = result => (result && result.accessToken ? acceptSession(result) : result);

  function endSupportAccess(reason) {
    try {
      sessionStorage.removeItem(SUPPORT_KEY);
    } catch {}
    // Rider app: nothing of the opened account stays on this device (session, cached tasks, queue).
    const opened = supportAccess && (supportAccess.userId || state.user?.id);
    if (opened) void window.DFOffline?.forget?.(opened);
    supportAccess = null;
    accessToken = null;
    state.user = null;
    if (reason) document.title = `Support access ${reason} · Delivery Fast`;
    return null;
  }

  const auth = {
    get user() {
      return state.user;
    },
    hasRole: (...roles) => !!state.user && state.user.roles.some(r => roles.includes(r)),
    /**
     * The website's customer area (account, orders, addresses, profile, booking as a customer) is for
     * customers only: an account whose home is a panel (merchant, staff, rider) never uses it, even
     * when it also holds the CUSTOMER role from signing up on the website.
     */
    isWebsiteCustomer: () => !!state.user && state.user.roles.includes("CUSTOMER") && (!state.user.panel || state.user.panel === "/account"),
    /** Re-reads the session (e.g. after a merchant application adds the merchant role); resolves to the user or null. */
    refresh: () => refresh(),
    requestOtp: (phone, purpose) => rawFetch("/auth/otp", { method: "POST", body: { phone, purpose }, auth: false }),
    login: async (identifier, password) => sessionOrChallenge(await rawFetch("/auth/login", { method: "POST", body: { identifier, password }, auth: false })),
    loginWithOtp: async (phone, otp) => sessionOrChallenge(await rawFetch("/auth/login/otp", { method: "POST", body: { phone, otp }, auth: false })),
    /** Second step: an authenticator code or a recovery code. */
    loginMfa: async (mfaToken, code) => acceptSession(await rawFetch("/auth/login/mfa", { method: "POST", body: { mfaToken, code }, auth: false })),
    /** Enrolment during sign-in (roles that must use two-step verification): { otpauthUrl, qrDataUrl, secret }. */
    mfaSetup: mfaToken => rawFetch("/auth/mfa/setup", { method: "POST", body: { mfaToken }, auth: false }),
    /** Confirms enrolment; signs in and returns { user, recoveryCodes }. */
    async mfaEnable(mfaToken, code) {
      const result = await rawFetch("/auth/mfa/enable", { method: "POST", body: { mfaToken, code }, auth: false });
      return { user: acceptSession(result), recoveryCodes: result.recoveryCodes || [] };
    },
    signup: async input => acceptSession(await rawFetch("/auth/signup", { method: "POST", body: input, auth: false })),
    resetPassword: input => rawFetch("/auth/password/reset", { method: "POST", body: input, auth: false }),
    /** Guest booking: SMS code to the sender's phone, then a one-booking verification token. */
    guestVerification: phone => rawFetch("/guest/verification", { method: "POST", body: { phone }, auth: false }),
    guestConfirm: (phone, code) => rawFetch("/guest/verification/confirm", { method: "POST", body: { phone, code }, auth: false }),
    /** Email verification for the signed-in user: status, send (link + code), confirm ({ token } or { code }). */
    emailVerification: {
      status: () => api("/auth/email-verification"),
      send: () => api("/auth/email-verification", { method: "POST" }),
      confirm: body => api("/auth/email-verification/confirm", { method: "POST", body }),
    },
    async logout() {
      if (supportAccess) {
        // Ends support access only; the administrator's own session is untouched.
        await rawFetch(`/admin/impersonations/${supportAccess.id}/end`, { method: "POST" }).catch(() => undefined);
        endSupportAccess();
        memory.clear();
        return;
      }
      await rawFetch("/auth/logout", { method: "POST", auth: false }).catch(() => undefined);
      accessToken = null;
      state.user = null;
      state.offlineSession = false;
      memory.clear();
      await window.DFOffline?.clear?.(); // rider app: saved tasks and queued actions on this device
    },
    /** Where to go after signing in: a remembered panel the user may open, else their own panel. */
    destination() {
      let next = null;
      try {
        next = sessionStorage.getItem(RETURN_KEY);
        sessionStorage.removeItem(RETURN_KEY);
      } catch {}
      const app = next && next.replace(/^\//, "").split(/[/?#]/)[0];
      if (next && app && PANEL_ROLES[app] && auth.hasRole(...PANEL_ROLES[app])) return next;
      return state.user?.panel || "/account";
    },
  };

  // ───────────── website routes (real URLs, History API) ─────────────
  //
  // The website's page scripts were written for hash routes ("#/tracking/PP-…"). The site now
  // uses real paths ("/track/PP-…"); DF.route translates between them. Navigation pushes a
  // history entry and fires a synthetic "hashchange", so the page scripts' existing listeners
  // re-render as before. The path table comes from the server (src/features/website/routes.ts,
  // serialized into #dfRoutes).

  const routeTable = (() => {
    try {
      return JSON.parse(document.getElementById("dfRoutes")?.textContent || "null");
    } catch {
      return null;
    }
  })() || { routes: [] };
  const LEGACY_TO_PATH = Object.fromEntries(routeTable.routes.map(r => [r.legacy, r.path]));
  const PATH_TO_LEGACY = Object.fromEntries(routeTable.routes.map(r => [r.path, r.legacy]));

  /** "/track/PP-1" -> "tracking/PP-1"; "/" -> "" (home). */
  function routeFromPathname(pathname) {
    const clean = decodeURIComponent(pathname).replace(/^\/+|\/+$/g, "");
    if (!clean) return "";
    if (clean in PATH_TO_LEGACY) return PATH_TO_LEGACY[clean] === "home" ? "" : PATH_TO_LEGACY[clean];
    const [first, ...rest] = clean.split("/");
    if (first in PATH_TO_LEGACY && rest.length) return [PATH_TO_LEGACY[first], ...rest.map(encodeURIComponent)].join("/");
    return clean;
  }

  /** "tracking/PP-1?x=1" -> "/track/PP-1?x=1"; "home" / "" -> "/". */
  function urlForRoute(route) {
    const [pathPart, query] = String(route || "").replace(/^#?\/?/, "").split("?");
    const [name, ...rest] = pathPart.split("/");
    if (!name || name === "home") return `/${query ? `?${query}` : ""}`;
    const base = name in LEGACY_TO_PATH ? LEGACY_TO_PATH[name] : name;
    return `/${[base, ...rest].filter(Boolean).join("/")}${query ? `?${query}` : ""}`;
  }

  const isStaticPage = () => !!document.querySelector("main[data-static-page]");
  let lastLocation = location.pathname + location.search;

  function announceRoute(oldURL) {
    lastLocation = location.pathname + location.search;
    try {
      window.dispatchEvent(new HashChangeEvent("hashchange", { oldURL, newURL: location.href }));
    } catch {
      window.dispatchEvent(new Event("hashchange"));
    }
    window.dispatchEvent(new CustomEvent("df:route", { detail: { route: DF.route.path() } }));
  }

  const route = {
    /** The current route in the page scripts' terms ("tracking/PP-1"), "" for home. */
    path: () => routeFromPathname(location.pathname),
    /** The same as the old location.hash ("#/tracking/PP-1"), "" for home. */
    hash: () => {
      const path = routeFromPathname(location.pathname);
      return path ? `#/${path}` : "";
    },
    url: urlForRoute,
    /** Title of a route, as rendered by the server. */
    title(name) {
      const found = routeTable.routes.find(r => r.legacy === (name || "home"));
      if (isStaticPage() && (!name || name === "home")) return routeTable.initialTitle || document.title;
      return found?.title || routeTable.routes.find(r => r.legacy === "home")?.title || document.title;
    },
    /** Navigates (pushState) and lets the page re-render. Server-only pages (legal) do a full load. */
    go(target, { replace = false } = {}) {
      const url = urlForRoute(target);
      if (isStaticPage()) return void location.assign(url);
      const oldURL = location.href;
      if (url !== location.pathname + location.search || location.hash) history[replace ? "replaceState" : "pushState"](null, "", url);
      announceRoute(oldURL);
    },
    /** Changes the address without re-rendering (e.g. a new ticket number). */
    replace(target) {
      history.replaceState(null, "", urlForRoute(target));
      lastLocation = location.pathname + location.search;
    },
  };

  if (state.app === "website") {
    routeTable.initialTitle = document.title;
    // Old links (/#/tracking/PP-…, /#/signup?invite=…) keep working.
    if (location.hash.startsWith("#/")) history.replaceState(null, "", urlForRoute(location.hash.slice(2)));
    lastLocation = location.pathname + location.search;
    // Links the page scripts still write as "#/route": turn them into paths before the page's
    // own hashchange listeners (registered later) read the route.
    window.addEventListener("hashchange", event => {
      if (!location.hash.startsWith("#/")) return;
      if (isStaticPage()) return void location.assign(urlForRoute(location.hash.slice(2)));
      history.replaceState(null, "", urlForRoute(location.hash.slice(2)));
      lastLocation = location.pathname + location.search;
      window.dispatchEvent(new CustomEvent("df:route", { detail: { route: route.path() } }));
    });
    // Back / forward between paths. (Fragment-only changes fire their own hashchange.)
    window.addEventListener("popstate", () => {
      if (location.pathname + location.search === lastLocation) return;
      announceRoute(location.href);
    });
  }

  // ───────────── data shown by the page scripts ─────────────

  const memory = new Map();
  const VIRTUAL_KEYS = new Set([PARCELS_KEY, SESSION_KEY, ADDRESS_KEY]);
  const nativeGet = Storage.prototype.getItem;
  const nativeSet = Storage.prototype.setItem;
  const nativeRemove = Storage.prototype.removeItem;
  const isLocal = store => {
    try {
      return store === window.localStorage;
    } catch {
      return false;
    }
  };

  let configMemo = null;
  Storage.prototype.getItem = function (key) {
    if (isLocal(this)) {
      if (VIRTUAL_KEYS.has(key)) return memory.has(key) ? memory.get(key) : null;
      if (key === CONFIG_KEY && (state.platformConfig || state.catalog)) {
        // Server settings (edited in super admin) win over anything left in this browser.
        // The page scripts read this often and it carries the whole country's geography:
        // rebuild it only when one of its sources changed.
        const local = nativeGet.call(this, key);
        const memo = configMemo;
        if (memo && memo.local === local && memo.platform === state.platformConfig && memo.catalog === state.catalog) return memo.json;
        const config = { ...safeParse(local), ...(state.platformConfig || {}) };
        const json = JSON.stringify(state.catalog ? withServerPricing(config) : config);
        configMemo = { local, platform: state.platformConfig, catalog: state.catalog, json };
        return json;
      }
    }
    return nativeGet.call(this, key);
  };
  Storage.prototype.setItem = function (key, value) {
    if (isLocal(this) && VIRTUAL_KEYS.has(key)) return void memory.set(key, String(value));
    return nativeSet.call(this, key, value);
  };
  Storage.prototype.removeItem = function (key) {
    if (isLocal(this) && VIRTUAL_KEYS.has(key)) return void memory.delete(key);
    return nativeRemove.call(this, key);
  };
  // Clear anything the demo used to persist for these keys.
  for (const key of VIRTUAL_KEYS) {
    try {
      nativeRemove.call(window.localStorage, key);
    } catch {}
  }

  const safeParse = value => {
    try {
      return JSON.parse(value || "{}") || {};
    } catch {
      return {};
    }
  };

  /** The website's price preview uses the server's active rate card and catalog. */
  function withServerPricing(config) {
    const c = state.catalog;
    const card = c.customerRateCard;
    const serviceFees = { Regular: card.serviceFees.REGULAR, "Same day": card.serviceFees.SAME_DAY, Express: card.serviceFees.EXPRESS };
    return {
      ...config,
      customerParcelPricing: { sameZone: card.sameZone, crossZone: card.crossZone, extraWeight: card.extraWeight, codFeePercent: card.codFeePercent, serviceFees },
      serviceLevelFees: serviceFees,
      deliveryServices: Object.values(c.serviceLevels),
      geoCatalog: { district: c.districts, zone: [...new Set(Object.values(c.zonesByDistrict).flat())], area: [...new Set(Object.values(c.areasByZone).flat())] },
      geoHierarchy: { zonesByDistrict: c.zonesByDistrict, areasByZone: c.areasByZone },
    };
  }

  const localPhone = phone => (phone || "").replace(/^\+88/, "");
  const when = iso => (iso ? new Date(iso).toLocaleString() : undefined);
  const CATEGORY = { HOME: "Home", OFFICE: "Office", OTHER: "Other" };
  const PROOF = { SIGNATURE: "Signature", OTP: "OTP", PHOTO: "Photo" };

  /** The rider the page should show as "assigned" for this status ("Unassigned" while at a hub). */
  function currentRider(p) {
    if (["PICKUP_ASSIGNED", "PICKUP_CONFIRMED", "PICKED_UP"].includes(p.status)) return p.pickupRider?.label;
    if (["ASSIGNED", "OUT_FOR_DELIVERY", "RETRY_SCHEDULED", "DELIVERED"].includes(p.status)) return p.deliveryRider?.label;
    if (["AT_HUB", "IN_TRANSIT", "RETURN_SCHEDULED", "RETURNED"].includes(p.status)) return "Unassigned";
    if (p.status === "EXCEPTION") return p.deliveryRider?.label || p.pickupRider?.label || "Unassigned";
    return undefined;
  }

  /** API parcel -> the record shape the original pages read from storage. */
  function toLegacyRecord(p) {
    return {
      trackingId: p.trackingId,
      sender: p.sender.name,
      senderPhone: localPhone(p.sender.phone),
      pickupAddress: p.pickup.label,
      pickupCategory: CATEGORY[p.pickup.category],
      pickupStreet: p.pickup.street,
      pickupDistrict: p.pickup.district,
      pickupZone: p.pickup.zone,
      // Imported orders may still miss recipient details ("Needs info": p.incomplete, p.missingLabels).
      recipient: p.recipient.name || "Recipient not set",
      recipientPhone: localPhone(p.recipient.phone),
      destination: p.delivery.label,
      deliveryCategory: CATEGORY[p.delivery.category],
      deliveryStreet: p.delivery.street || "",
      incomplete: !!p.incomplete,
      deliveryDistrict: p.delivery.district,
      deliveryZone: p.delivery.zone,
      deliveryArea: p.delivery.area || "",
      service: p.merchant ? "Merchant parcel" : "Customer parcel",
      serviceLevel: p.serviceLevelLabel,
      weight: String(p.weightKg),
      packaging: p.packaging || "",
      product: p.contents || "",
      baseDeliveryFee: p.charges.base,
      weightFee: p.charges.weight,
      serviceFee: p.charges.service,
      codAmount: p.codAmount,
      codFee: p.charges.codFee,
      codFeePercent: p.codAmount ? Math.round((p.charges.codFee / p.codAmount) * 1000) / 10 : 1,
      deliveryFee: p.charges.total,
      status: p.statusLabel,
      customerCanCancel: p.canCancel,
      createdAt: when(p.createdAt),
      createdAtISO: p.createdAt,
      updatedAt: when(p.updatedAt),
      statusUpdatedAt: p.updatedAt,
      rider: currentRider(p),
      pickupRider: p.pickupRider?.label,
      hub: p.currentHub?.name,
      location: p.currentHub?.name,
      pickedUpAt: p.pickedUpAt || undefined,
      proof: p.proof ? `${PROOF[p.proof.method]} proof recorded` : undefined,
      deliveredAt: when(p.deliveredAt),
      events: p.events.filter(e => !e.internal).map(e => ({ time: when(e.at), title: e.title, place: e.location || "", detail: e.description || "" })),
      _api: p,
    };
  }

  const parcels = {
    cache: [],
    byTrackingId: id => parcels.cache.find(p => p.trackingId === id),
    /** Reloads the visible parcels; tells the page (via a storage event) only if something changed. */
    async reload(query = "") {
      const all = [];
      let cursor = null;
      do {
        const page = await api(`/parcels?limit=200${query}${cursor ? `&cursor=${cursor}` : ""}`);
        all.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor && all.length < 2000);
      return parcels.set(all);
    },
    set(items) {
      parcels.cache = items;
      const json = JSON.stringify(items.map(toLegacyRecord));
      const changed = memory.get(PARCELS_KEY) !== json;
      memory.set(PARCELS_KEY, json);
      if (changed) emitStorage(PARCELS_KEY);
      return changed;
    },
  };

  function emitStorage(key) {
    try {
      window.dispatchEvent(new StorageEvent("storage", { key, storageArea: window.localStorage }));
    } catch {}
  }

  function setCustomerSession(user) {
    if (!user) return void memory.delete(SESSION_KEY);
    const session = { name: user.name, phone: localPhone(user.phone), email: user.email || "", updatedAt: new Date().toLocaleString() };
    memory.set(SESSION_KEY, JSON.stringify(session));
    window.deliveryFastCustomerSession = session;
  }

  function setAddressBook(addresses) {
    const rows = addresses.map(a => ({
      name: a.contactName,
      phone: localPhone(a.phone),
      category: CATEGORY[a.category] || "Home",
      address: a.street,
      district: a.district,
      zone: a.zone,
      area: a.area || "",
      role: a.role === "RECEIVER" ? "receiver" : "pickup",
      savedAt: a.createdAt,
      _id: a.id,
    }));
    memory.set(ADDRESS_KEY, JSON.stringify(rows));
  }

  /** Readable message for a failed call. */
  function describe(error) {
    if (error instanceof ApiError) {
      if (error.code === "VALIDATION_FAILED" && Array.isArray(error.details) && error.details.length) return error.details.map(d => d.message).join(" · ");
      if (error.status === 0 || error.status >= 500) return "We couldn't reach Delivery Fast. Please try again.";
      return error.message;
    }
    return "We couldn't reach Delivery Fast. Check your connection and try again.";
  }

  function toast(message) {
    if (typeof window.showToast === "function") window.showToast(message);
    else console.warn(message);
  }

  function goToLogin() {
    try {
      sessionStorage.setItem(RETURN_KEY, location.pathname + location.search + location.hash); // deep links come back after sign-in
    } catch {}
    location.replace("/login");
  }

  /** Set while the banner is up: closes the view when support access ends some other way (revoked, expired). */
  let supportEnded = null;

  /**
   * A bar across the page while support access is on: "Viewing as <name> (read-only) · ends in
   * 12 min · End", who opened it, and a live countdown. When it ends (End, expiry, or ended by an
   * administrator elsewhere) the page is covered and the tab closes.
   */
  function supportBanner(user) {
    const imp = user.impersonation || {};
    const mode = imp.readOnly === false ? "full access" : "read-only";
    const bar = document.createElement("div");
    bar.id = "dfSupportBanner";
    bar.setAttribute("role", "status");
    bar.dataset.mode = imp.readOnly === false ? "full" : "read-only";
    bar.style.cssText =
      "position:fixed;left:0;right:0;bottom:0;z-index:2147483000;display:flex;gap:12px;align-items:center;justify-content:center;flex-wrap:wrap;padding:10px 16px;background:#7c2d12;color:#fff;font:600 13px/1.4 system-ui,sans-serif;box-shadow:0 -2px 12px rgba(0,0,0,.25)";
    const text = document.createElement("span");
    text.id = "dfSupportBannerText";
    const by = document.createElement("small");
    by.style.cssText = "font-weight:400;opacity:.85";
    by.textContent = `Opened by ${imp.adminName || "an administrator"} · every action is recorded${imp.readOnly === false ? "" : " · changes are blocked"}`;
    const end = document.createElement("button");
    end.type = "button";
    end.id = "dfSupportEnd";
    end.textContent = "End";
    end.title = "End this session and close the tab";
    end.style.cssText = "border:1px solid #fff;background:transparent;color:#fff;border-radius:6px;padding:4px 12px;font:inherit;cursor:pointer";
    const tick = () => {
      const left = supportAccess ? Math.max(0, supportAccess.expiresAt - Date.now()) : 0;
      const minutes = Math.max(1, Math.ceil(left / 60000));
      text.textContent = `Viewing as ${user.name} (${mode}) · ends in ${minutes} min`;
    };
    tick();
    const timer = setInterval(tick, 15000);
    let done = false;
    /** Covers the page (nothing of the account stays on screen) and closes the tab. */
    const finish = message => {
      if (done) return;
      done = true;
      clearInterval(timer);
      clearTimeout(expiry);
      supportEnded = null;
      memory.clear();
      bar.style.top = "0";
      bar.style.flexDirection = "column";
      bar.style.fontSize = "16px";
      text.textContent = message;
      by.textContent = "You can close this tab.";
      end.remove();
      setTimeout(() => window.close(), 800);
    };
    supportEnded = reason => finish(reason === "expired" ? `Viewing as ${user.name} ended: the time ran out.` : `Viewing as ${user.name} has ended.`);
    end.addEventListener("click", async () => {
      end.disabled = true;
      await auth.logout();
      finish(`Viewing as ${user.name} has ended.`);
    });
    bar.append(text, by, end);
    const add = () => document.body.append(bar);
    document.body ? add() : document.addEventListener("DOMContentLoaded", add);
    const expiry = setTimeout(() => {
      endSupportAccess("expired");
      finish(`Viewing as ${user.name} ended: the time ran out.`);
    }, Math.max(0, supportAccess.expiresAt - Date.now()));
  }

  // The administrator's side: starts support access and opens it in a new tab, which collects its
  // token once through DF.takeSupportAccess (window.opener) — never through storage or the URL.
  let supportHandoff = null;
  /**
   * Starts support access ("view as" / "Log in as") and points `tab` (opened by the caller during
   * the click, e.g. window.open("about:blank")) at the user's panel. `panel` overrides the
   * account's default panel. Resolves the API result; closes the tab on failure.
   */
  async function startSupportAccess(body, { tab, panel } = {}) {
    try {
      const result = await api("/admin/impersonations", { method: "POST", body });
      supportHandoff = { id: result.impersonation.id, userId: result.user.id, accessToken: result.accessToken, expiresAt: Date.now() + result.expiresIn * 1000 - 5000 };
      setTimeout(() => (supportHandoff = null), 60_000);
      const [path, hash = ""] = (panel || result.user.panel || "/").split("#");
      const url = `${path}${path.includes("?") ? "&" : "?"}support-access=1${hash ? `#${hash}` : ""}`;
      if (tab && !tab.closed) tab.location.href = url;
      return { ...result, opened: !!(tab && !tab.closed) };
    } catch (error) {
      tab?.close();
      throw error;
    }
  }
  function takeSupportAccess() {
    const handed = supportHandoff;
    supportHandoff = null;
    return handed;
  }

  /** Runs before the page scripts. Resolves once the page may start. */
  async function boot() {
    const app = state.app;
    let user = await refresh();
    if (supportAccess && user) supportBanner(user);
    // Rider app without a connection: open with the last signed-in rider (legacy/rider/offline.js).
    if (!user && state.networkDown && app === "rider" && window.DFOffline) {
      user = await window.DFOffline.restoreSession().catch(() => null);
      if (user) {
        state.user = user;
        state.offlineSession = true;
      }
    } else if (user && app === "rider" && !supportAccess) void window.DFOffline?.saveSession(user);
    const required = PANEL_ROLES[app];
    if (required && !auth.hasRole(...required)) {
      goToLogin();
      return new Promise(() => {}); // navigating away; never start the page
    }
    // Platform settings managed in super admin (GET /settings/platform-config, 404 until saved).
    const jobs = [rawFetch("/settings/platform-config", { auth: false }).then(c => (state.platformConfig = c)).catch(() => undefined)];
    if (app === "website") {
      jobs.push(rawFetch("/catalog", { auth: false }).then(c => (state.catalog = c)).catch(() => undefined));
      setCustomerSession(auth.isWebsiteCustomer() ? user : null);
      memory.set(PARCELS_KEY, "[]");
      memory.set(ADDRESS_KEY, "[]");
      if (auth.isWebsiteCustomer()) {
        jobs.push(parcels.reload().catch(() => undefined));
        jobs.push(api("/me/addresses").then(setAddressBook).catch(() => undefined));
      }
    }
    if (app === "courier-operation") {
      // Parcels are loaded per table on screen (server-paged lists, courier-operation/bridge-lists.js).
      // Not every operations role may list riders (e.g. finance); the page copes without them.
      if (auth.hasRole("SUPER_ADMIN", "OPS_MANAGER", "HUB_OPERATOR", "SUPPORT_AGENT"))
        jobs.push(api("/riders?active=true").then(r => (state.riders = r)).catch(() => (state.riders = [])));
      jobs.push(api("/hubs").then(h => (state.hubs = h)).catch(() => (state.hubs = [])));
    }
    if (app === "rider") {
      jobs.push(DF.rider.reload());
      const hubs = () => api("/hubs");
      jobs.push((window.DFOffline ? window.DFOffline.cached("hubs", hubs) : hubs()).then(h => (state.hubs = h)).catch(() => (state.hubs = [])));
    }
    await Promise.all(jobs);
  }

  const DF = {
    api,
    apiRaw,
    download,
    ApiError,
    auth,
    get supportAccess() {
      return supportAccess ? { ...supportAccess, accessToken: undefined } : null;
    },
    startSupportAccess,
    takeSupportAccess,
    route,
    state,
    parcels,
    toLegacyRecord,
    describe,
    toast,
    emitStorage,
    goToLogin,
    setCustomerSession,
    setAddressBook,
    localPhone,
    rider: {
      tasks: { pickups: [], deliveries: [] },
      /** The rider's own pickups and deliveries, exposed to the page as the parcel list. */
      async reload() {
        const load = () => api("/rider/tasks");
        // Offline: the saved task list, with actions still waiting to sync applied.
        const tasks = window.DFOffline ? await window.DFOffline.tasks(load) : await load();
        DF.rider.tasks = tasks;
        return parcels.set([...tasks.pickups, ...tasks.deliveries]);
      },
    },
    /** Shows the signed-in person in the panel sidebar; clicking their profile signs out. */
    showSignedInUser(roleLabel) {
      const user = state.user;
      if (!user) return;
      const initials = user.name.split(/\s+/).map(part => part[0]).slice(0, 2).join("").toUpperCase();
      for (const profile of document.querySelectorAll(".user-profile, .admin-profile")) {
        const name = profile.querySelector("strong");
        const role = profile.querySelector("small");
        const avatar = profile.querySelector(".avatar");
        if (name) name.textContent = user.name;
        if (role && roleLabel) role.textContent = roleLabel;
        if (avatar) avatar.textContent = initials;
        profile.style.cursor = "pointer";
        profile.title = "Sign out";
        profile.addEventListener("click", async () => {
          if (!(await DF.confirm({ title: "Sign out?", message: `Sign out ${user.name} on this device?`, confirm: "Sign out" }))) return;
          await auth.logout();
          location.href = "/login";
        });
      }
      const topAvatar = document.querySelector(".topbar .avatar");
      if (topAvatar) topAvatar.textContent = initials;
    },
    /** Polls while the tab is visible, so panels pick up other people's changes. */
    poll(fn, ms = 20000) {
      setInterval(() => {
        if (document.visibilityState === "visible") fn().catch(() => undefined);
      }, ms);
    },
  };

  // ───────────── panel URLs (DF.nav): every page and tab has its own address ─────────────
  //
  // One scheme for every panel: /<panel>?page=<page-slug>[&tab=<tab-slug>], kebab-case slugs of the
  // menu names (e.g. /courier-operation?page=hub-desk&tab=receive, /super-admin?page=approval-center,
  // /ecommerce-merchant?page=payments). Old page names and old slugs still open the page and the
  // address is rewritten to the new slug. Deep links: ?parcel=<tracking ID> opens the parcel,
  // ?ticket=<number> the support ticket. Other parameters (period, from, to, filters) are kept.
  // Navigating pushes a history entry (Back / Forward work); redraws replace it. The title follows:
  // "Page › Tab · Delivery Fast · Panel". Each panel connects with DF.nav.start(adapter):
  //   { panel: "Courier Operations", home: "Overview", pages: () => [{ name, label?, slug?, aliases?, tabs?: [{ name, label?, slug?, aliases? }] }],
  //     open(pageName, tabName), openParcel?(id), openTicket?(number) }
  // and calls DF.nav.entered(pageName, tabName[, { replace: true }]) whenever a page or tab is on screen.
  const nav = (() => {
    const slug = value =>
      String(value ?? "")
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/['’]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    const ONE_SHOT = ["parcel", "ticket"];
    let adapter = null;
    let restoring = false;
    let current = null; // { page, tab, key } on screen
    let pending = null;
    const handled = { parcel: null, ticket: null };
    const ready = () => document.documentElement.classList.contains("legacy-ready");
    const pageSlug = p => p.slug || slug(p.label || p.name);
    const tabSlug = t => t.slug || slug(t.label || t.name);
    const keyOf = found => `${pageSlug(found.page)}|${found.tab ? tabSlug(found.tab) : ""}`;

    /** A page / tab from a URL value, a name or an old name (any case) → the entries, or null. */
    function find(page, tab) {
      if (!page || !adapter) return null;
      const want = slug(page);
      const entry = adapter.pages().find(p => pageSlug(p) === want || slug(p.name) === want || (p.label && slug(p.label) === want) || (p.aliases || []).some(a => slug(a) === want));
      if (!entry) return null;
      let tabEntry = null;
      if (tab && entry.tabs?.length) {
        const t = slug(tab);
        tabEntry = entry.tabs.find(x => tabSlug(x) === t || slug(x.name) === t || (x.aliases || []).some(a => slug(a) === t)) || null;
      }
      return { page: entry, tab: tabEntry };
    }

    function flush() {
      const next = pending;
      pending = null;
      if (!next) return;
      if (next.url !== location.pathname + location.search + location.hash) history[next.push ? "pushState" : "replaceState"](history.state, "", next.url);
    }
    /** Writes the address. Next.js's router must be up first: until html.legacy-ready only the latest URL waits (as a replace). */
    function write(url, push) {
      if (ready()) {
        pending = { url, push };
        return flush();
      }
      pending = { url, push: false };
      if (write.observer) return;
      write.observer = new MutationObserver(() => {
        if (!ready()) return;
        write.observer.disconnect();
        setTimeout(flush, 0);
      });
      write.observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    }

    /** The address of a page / tab, keeping the other parameters (not the one-shot parcel / ticket). */
    function url(page, tab, extra = {}) {
      const found = find(page, tab);
      const params = new URLSearchParams(pending ? new URL(pending.url, location.href).search : location.search);
      for (const k of ["page", "tab", ...ONE_SHOT]) params.delete(k);
      const fresh = new URLSearchParams();
      if (found) {
        fresh.set("page", pageSlug(found.page));
        if (found.tab) fresh.set("tab", tabSlug(found.tab));
      }
      for (const [k, v] of params) fresh.append(k, v);
      for (const [k, v] of Object.entries(extra)) if (v !== null && v !== undefined && v !== "") fresh.set(k, v);
      const query = fresh.toString();
      return location.pathname + (query ? `?${query}` : "");
    }

    function setTitle(found) {
      const name = found.page.label || found.page.name;
      const tab = found.tab && found.page.tabs?.length > 1 ? ` › ${found.tab.label || found.tab.name}` : "";
      const title = `${name}${tab} · Delivery Fast · ${adapter.panel}`;
      document.title = title;
      // React may redraw the server's <title> after a history change.
      setTimeout(() => document.title !== title && (document.title = title), 0);
    }

    /** The page / tab now on screen: updates the address (a new entry when it moved, else in place) and the title. */
    function entered(page, tab, { replace = false } = {}) {
      const found = find(page, tab);
      if (!found) return;
      const key = keyOf(found);
      const before = current?.key ?? null;
      current = { page: found.page.name, tab: found.tab?.name ?? null, key };
      setTitle(found);
      const params = new URLSearchParams(location.search);
      const canonical = params.get("page") === pageSlug(found.page) && (params.get("tab") || "") === (found.tab ? tabSlug(found.tab) : "");
      if (canonical && !pending) return;
      const inUrl = find(params.get("page"), params.get("tab"));
      // Another page than the address: a new history entry. The same one (an old name, a missing slug): rewritten in place.
      const moved = !restoring && !replace && before !== null && before !== key && (!inUrl || keyOf(inUrl) !== key);
      write(url(found.page.name, found.tab?.name), moved);
    }

    /** Sets or clears one parameter in place (e.g. ?parcel= while the drawer is open). */
    function setParam(name, value) {
      const params = new URLSearchParams(pending ? new URL(pending.url, location.href).search : location.search);
      if (value === null || value === undefined || value === "") params.delete(name);
      else params.set(name, value);
      if (ONE_SHOT.includes(name)) handled[name] = value || null;
      const query = params.toString();
      write(location.pathname + (query ? `?${query}` : "") + location.hash, false);
    }

    function openExtra(name, value) {
      const fn = name === "parcel" ? adapter?.openParcel : adapter?.openTicket;
      if (!fn) return;
      handled[name] = value;
      Promise.resolve(fn(value.trim().toUpperCase())).catch(() => undefined);
    }
    /** ?parcel= / ?ticket= in the address: opens each value once. */
    function extras() {
      if (!adapter) return;
      const params = new URLSearchParams(location.search);
      for (const name of ONE_SHOT) {
        const value = params.get(name);
        if (value && value !== handled[name]) openExtra(name, value);
        if (!value) handled[name] = null;
      }
    }

    /** What the address asks for: { page, tab } names (old names resolved; ?ticket= alone → Support) or null. */
    function requested(search = location.search) {
      const params = new URLSearchParams(search);
      const found = find(params.get("page") || (params.get("ticket") ? "support" : ""), params.get("tab"));
      return found ? { page: found.page.name, tab: found.tab?.name ?? null } : null;
    }

    function openRestoring(page, tab) {
      restoring = true;
      try {
        adapter.open(page, tab);
      } finally {
        restoring = false;
      }
    }

    window.addEventListener("popstate", () => {
      if (!adapter) return;
      const want = requested() || (adapter.home ? { page: adapter.home, tab: null } : null);
      const found = want && find(want.page, want.tab);
      if (found && (!current || current.key !== keyOf(found))) openRestoring(want.page, want.tab);
      else if (found) setTitle(found);
      extras();
    });

    return {
      slug,
      /** Connects a panel; returns what the address asks for ({ page, tab } or null). */
      start(a) {
        adapter = a;
        return requested();
      },
      entered,
      /** Runs fn (e.g. a role's landing page) without adding a history entry. */
      quietly(fn) {
        const was = restoring;
        restoring = true;
        try {
          return fn();
        } finally {
          restoring = was;
        }
      },
      url,
      find,
      requested,
      setParam,
      extras,
      /** Opens a panel link ("/courier-operation?page=…&tab=…", "…?parcel=…"): in place when it is this panel, else loads it. */
      go(link) {
        const target = new URL(link, location.href);
        if (target.origin !== location.origin || target.pathname !== location.pathname || !adapter) return void location.assign(target.href);
        const want = requested(target.search);
        if (want) adapter.open(want.page, want.tab);
        for (const name of ONE_SHOT) {
          const value = target.searchParams.get(name);
          if (!value) continue;
          setParam(name, value);
          openExtra(name, value);
        }
      },
      get current() {
        return current;
      },
      get panel() {
        return adapter?.panel || null;
      },
    };
  })();
  DF.nav = nav;

  // ───────────── live updates (GET /events, Server-Sent Events) ─────────────

  const listeners = new Map(); // type -> Set<handler>; "*" gets everything, "reconnect" after a gap
  let streaming = false;
  /** The live stream's state: "connecting" | "live" | "offline" (DF.events.state; "connection" events on change). */
  let connection = "connecting";
  const setConnection = next => {
    if (next === connection) return;
    connection = next;
    emit("connection", { state: next });
  };

  async function streamEvents() {
    if (streaming) return;
    streaming = true;
    let failures = 0;
    while (state.user) {
      try {
        if (!accessToken || Date.now() > accessExpiresAt) await refresh();
        if (!accessToken) break;
        const response = await fetch(`${BASE}/events`, { headers: { authorization: `Bearer ${accessToken}`, accept: "text/event-stream" } });
        if (!response.ok || !response.body) throw new Error(`events ${response.status}`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let first = true;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index;
          while ((index = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const type = block.match(/^event: (.*)$/m)?.[1] ?? "message";
            const raw = block.match(/^data: (.*)$/m)?.[1];
            const data = raw ? JSON.parse(raw) : {};
            if (type === "ready") {
              failures = 0;
              setConnection("live");
              // Anything may have changed while we weren't connected.
              if (!first) emit("reconnect", data);
              first = false;
              continue;
            }
            if (type !== "ping") emit(type, data);
          }
        }
        emit("reconnect", {}); // the server closes the stream when the token expires
        setConnection("connecting");
      } catch {
        failures++;
        setConnection(failures > 1 || navigator.onLine === false ? "offline" : "connecting");
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(30_000, 1000 * 2 ** Math.min(failures, 5))));
    }
    streaming = false;
  }

  function emit(type, data) {
    for (const key of [type, "*"]) for (const handler of listeners.get(key) ?? []) {
      try {
        handler(data, type);
      } catch (error) {
        console.error(error);
      }
    }
  }

  DF.events = {
    /** Calls handler(data, type) for each matching event; returns an unsubscribe function. */
    on(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
      if (state.user) void streamEvents();
      return () => listeners.get(type)?.delete(handler);
    },
    /** Reconnects the stream (e.g. when the device comes back online). */
    restart() {
      if (state.user) void streamEvents();
    },
    /** "connecting" | "live" | "offline"; subscribe to "connection" for changes. */
    get state() {
      return connection;
    },
  };

  // Geography / catalog changes (super admin) reach every open page: the booking catalog and the
  // platform settings overlay (geoCatalog / geoHierarchy) are reloaded for the next read.
  DF.events.on("catalog.updated", () => {
    if (state.catalog) rawFetch("/catalog", { auth: false }).then(c => (state.catalog = c)).catch(() => undefined);
    if (state.platformConfig) rawFetch("/settings/platform-config", { auth: false }).then(c => (state.platformConfig = c)).catch(() => undefined);
  });

  /**
   * Keeps a view fresh: reloads (debounced) when one of `types` arrives or after a
   * reconnect, plus a slow safety poll in case events were missed.
   */
  DF.live = (types, reload, { debounceMs = 400, fallbackMs = 120_000 } = {}) => {
    let timer = null;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (document.visibilityState === "visible") Promise.resolve(reload()).catch(() => undefined);
        else pendingWhileHidden = true;
      }, debounceMs);
    };
    let pendingWhileHidden = false;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && pendingWhileHidden) {
        pendingWhileHidden = false;
        schedule();
      }
    });
    for (const type of [...types, "reconnect"]) DF.events.on(type, schedule);
    DF.poll(() => Promise.resolve(reload()), fallbackMs);
  };

  // ───────────── forms: +880 phone fields and inline validation ─────────────

  const PHONE = /^(?:\+?880|0)?(1[3-9]\d{8})$/;
  /** Same rules as the API (packages/shared phone.ts). Returns a message or "" when valid. */
  DF.phoneProblem = value => {
    const digits = String(value || "").replace(/[\s\-().]/g, "").replace(/^\+?880|^0/, "");
    if (!digits) return "Enter a mobile number";
    if (!/^\d+$/.test(digits)) return "Use digits only";
    if (!digits.startsWith("1")) return "Bangladeshi mobile numbers start with 1 (e.g. 17XXXXXXXX)";
    if (digits.length !== 10) return "Enter the 10 digits after +880 (e.g. 1712345678)";
    if (!/^1[3-9]/.test(digits)) return "This isn't a valid Bangladeshi operator prefix";
    return "";
  };
  DF.normalizePhone = value => {
    const match = String(value || "").replace(/[\s\-().]/g, "").match(PHONE);
    return match ? `+880${match[1]}` : null;
  };

  /**
   * Turns an <input> into a phone field with a fixed "+880" prefix. People may type
   * 17XXXXXXXX or 017XXXXXXXX; the value submitted is the 10 digits after +880.
   */
  DF.phoneInput = input => {
    if (!input || input.dataset.dfPhone) return input;
    input.dataset.dfPhone = "1";
    const wrapper = document.createElement("div");
    wrapper.className = "df-phone";
    wrapper.style.cssText = "display:flex;align-items:stretch;width:100%";
    const prefix = document.createElement("span");
    prefix.textContent = "+880";
    prefix.setAttribute("aria-hidden", "true");
    prefix.style.cssText = "display:inline-flex;align-items:center;padding:0 10px;border:1px solid #d9e2dc;border-right:0;border-radius:9px 0 0 9px;background:#f4f7f5;color:#5d6f6a;font-weight:600;font-size:14px";
    input.parentNode.insertBefore(wrapper, input);
    wrapper.append(prefix, input);
    input.style.borderTopLeftRadius = input.style.borderBottomLeftRadius = "0";
    input.style.flex = "1";
    input.type = "tel";
    input.inputMode = "numeric";
    input.autocomplete = "tel-national";
    input.placeholder = "17XXXXXXXX";
    input.maxLength = 14;
    const tidy = () => {
      const digits = input.value.replace(/\D/g, "").replace(/^880/, "").replace(/^0(?=1)/, "");
      if (digits !== input.value) input.value = digits;
    };
    input.addEventListener("input", tidy);
    tidy();
    DF.validate.field(input, () => DF.phoneProblem(input.value));
    return input;
  };

  /**
   * Inline validation for the panels' plain forms. rules: { fieldId: value => message|"" }.
   * Messages appear under each field as people type (after the first blur) and on submit;
   * submit is blocked while anything is invalid.
   */
  DF.validate = (form, rules = {}) => {
    if (!form) return () => true;
    const checks = [];
    for (const [id, rule] of Object.entries(rules)) {
      const field = form.querySelector(`#${CSS.escape(id)}`);
      if (field) checks.push(DF.validate.field(field, () => rule(field.value, field)));
    }
    const all = () => checks.map(check => check(true)).every(Boolean);
    form.addEventListener("submit", event => {
      if (!all()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        form.querySelector("[aria-invalid=true]")?.focus();
      }
    }, true);
    return all;
  };
  /** Attaches one rule to one field; returns check(force) -> valid. */
  DF.validate.field = (field, rule) => {
    let touched = false;
    const message = document.createElement("small");
    message.className = "df-field-error";
    message.setAttribute("role", "alert");
    message.style.cssText = "display:block;margin-top:4px;color:#c2410c;font-size:12px;min-height:0";
    const anchor = field.closest(".df-phone") || field;
    anchor.after(message);
    const check = force => {
      if (force) touched = true;
      const problem = (rule() || (field.required && !String(field.value).trim() ? "This field is required" : "")) || "";
      const show = touched && problem;
      message.textContent = show ? problem : "";
      field.setAttribute("aria-invalid", show ? "true" : "false");
      field.style.borderColor = show ? "#c2410c" : "";
      return !problem;
    };
    field.addEventListener("blur", () => check(true));
    field.addEventListener("input", () => touched && check(false));
    return check;
  };

  // ───────────── small in-page dialogs (replace window.confirm / prompt / alert) ─────────────

  /**
   * One consistent small dialog for every panel (own inline styles, above any page modal):
   *   await DF.confirm("Delete it?") / DF.confirm({ title, message, confirm: "Delete", danger: true }) → true|false
   *   await DF.prompt({ title, message, label, value, required, multiline, placeholder, maxLength, validate }) → string|null
   *   await DF.choose({ title, message, label, options: [{ value, label }], value }) → value|null
   *   await DF.alert({ title, message }) → undefined
   * Esc / Cancel / the backdrop resolve false|null. Browser tests: `.df-dialog [data-df-dialog-ok]`,
   * `[data-df-dialog-cancel]`, the field `#dfDialogInput` (tests/e2e/support.ts `confirmDialog`).
   */
  const dialogEsc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  function smallDialog({ title, message = "", field = null, ok = "OK", cancel = "Cancel", danger = false, alertOnly = false }) {
    return new Promise(resolve => {
      const previous = document.activeElement;
      const overlay = document.createElement("div");
      overlay.className = "df-dialog";
      overlay.setAttribute("role", alertOnly ? "alertdialog" : "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.setAttribute("aria-labelledby", "dfDialogTitle");
      overlay.style.cssText = "position:fixed;inset:0;z-index:2147483000;background:rgba(20,32,51,.45);display:grid;place-items:center;padding:16px;font-family:inherit";
      const accent = danger ? "#b42318" : "#0f7b5f";
      const control = field
        ? field.options
          ? `<select id="dfDialogInput" style="width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #d6dde6;border-radius:9px;font:inherit;background:#fff">${field.options.map(o => `<option value="${dialogEsc(o.value)}" ${String(o.value) === String(field.value ?? "") ? "selected" : ""}>${dialogEsc(o.label)}</option>`).join("")}</select>`
          : field.multiline
          ? `<textarea id="dfDialogInput" rows="3" maxlength="${field.maxLength || 500}" placeholder="${dialogEsc(field.placeholder || "")}" style="width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #d6dde6;border-radius:9px;font:inherit;resize:vertical">${dialogEsc(field.value || "")}</textarea>`
          : `<input id="dfDialogInput" type="${field.type || "text"}" value="${dialogEsc(field.value || "")}" maxlength="${field.maxLength || 200}" placeholder="${dialogEsc(field.placeholder || "")}" style="width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #d6dde6;border-radius:9px;font:inherit">`
        : "";
      overlay.innerHTML = `<form style="width:min(440px,100%);background:#fff;color:#172033;border-radius:14px;padding:20px 20px 16px;box-shadow:0 24px 70px rgba(16,24,40,.28)" novalidate>
        <h2 id="dfDialogTitle" style="margin:0 0 6px;font-size:17px;line-height:1.3">${dialogEsc(title || (field ? "Please confirm" : "Are you sure?"))}</h2>
        ${message ? `<p style="margin:0 0 12px;color:#5b6576;font-size:14px;line-height:1.45;white-space:pre-line">${dialogEsc(message)}</p>` : ""}
        ${field ? `<label for="dfDialogInput" style="display:block;margin:0 0 6px;font-size:13px;font-weight:600">${dialogEsc(field.label || "Value")}${field.required ? "" : ` <span style="font-weight:400;color:#8a94a3">(optional)</span>`}</label>${control}` : ""}
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">
          ${alertOnly ? "" : `<button type="button" data-df-dialog-cancel style="padding:8px 14px;border:1px solid #d6dde6;border-radius:9px;background:#fff;color:#172033;font:inherit;font-weight:600;cursor:pointer">${dialogEsc(cancel)}</button>`}
          <button type="submit" data-df-dialog-ok style="padding:8px 14px;border:1px solid ${accent};border-radius:9px;background:${accent};color:#fff;font:inherit;font-weight:600;cursor:pointer">${dialogEsc(ok)}</button>
        </div></form>`;
      document.body.append(overlay);
      const form = overlay.querySelector("form");
      const input = overlay.querySelector("#dfDialogInput");
      let check = () => true;
      if (input) check = DF.validate.field(input, () => (field.required && !input.value.trim() ? "This field is required" : field.validate?.(input.value.trim()) || ""));
      const finish = value => {
        overlay.remove();
        document.removeEventListener("keydown", onKey, true);
        try {
          previous?.focus?.();
        } catch {}
        resolve(value);
      };
      const cancelValue = alertOnly ? undefined : field ? null : false;
      const onKey = event => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopImmediatePropagation();
          finish(cancelValue);
        }
      };
      document.addEventListener("keydown", onKey, true);
      overlay.addEventListener("mousedown", event => event.target === overlay && finish(cancelValue));
      overlay.querySelector("[data-df-dialog-cancel]")?.addEventListener("click", () => finish(cancelValue));
      form.addEventListener("submit", event => {
        event.preventDefault();
        event.stopPropagation();
        if (input && !check(true)) return void input.focus();
        finish(alertOnly ? undefined : input ? input.value.trim() : true);
      });
      (input || overlay.querySelector("[data-df-dialog-ok]")).focus();
    });
  }
  const asOptions = (value, fallbackTitle) => (typeof value === "string" ? { message: value, title: fallbackTitle } : value || {});
  DF.confirm = options => {
    const o = asOptions(options);
    return smallDialog({ title: o.title, message: o.message, ok: o.confirm || "Confirm", cancel: o.cancel || "Cancel", danger: !!o.danger });
  };
  DF.prompt = options => {
    const o = asOptions(options);
    return smallDialog({ title: o.title, message: o.message, ok: o.confirm || "Save", cancel: o.cancel || "Cancel", danger: !!o.danger, field: { label: o.label, value: o.value, required: !!o.required, multiline: !!o.multiline, placeholder: o.placeholder, maxLength: o.maxLength, validate: o.validate, type: o.type } });
  };
  DF.choose = options => smallDialog({ title: options.title, message: options.message, ok: options.confirm || "Continue", cancel: options.cancel || "Cancel", field: { label: options.label, value: options.value, required: true, options: options.options || [] } });
  DF.alert = options => {
    const o = asOptions(options, "Notice");
    return smallDialog({ title: o.title, message: o.message, ok: o.confirm || "OK", alertOnly: true });
  };

  DF.ready = boot().catch(error => {
    console.error("Delivery Fast could not start", error);
  });
  window.DF = DF;
})();
