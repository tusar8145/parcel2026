/*
 * Connects the public website's original scripts to the API.
 *
 * The forms (sign-in with MFA, sign-up, booking, partner applications, profile, addresses)
 * and the /track page are React components (src/features/website/react) mounted into the
 * views the page scripts draw. This file keeps what the page scripts still do themselves:
 * the home page's tracking card, the customer's overview and orders lists, the
 * "application received" view, and the hooks React calls after signing in (window.DFWebsite).
 */
(() => {
  const DF = window.DF;
  const RETURN_ROUTE_KEY = "deliveryfast-customer-return-route";
  const PROOF = { SIGNATURE: "Signature", OTP: "OTP", PHOTO: "Photo" };
  const PARTNER_ROUTES = ["merchant", "rider", "franchise"];
  const ACCOUNT_ROUTES = ["account", "orders"];
  /** The customer area: only website customers use it; merchants, staff and riders go to their panel. */
  const CUSTOMER_ONLY_ROUTES = ["account", "orders", "addresses", "profile", "request"];
  /** Account pages: signed-out visitors are asked to log in first. */
  const SIGNED_IN_ROUTES = ["account", "orders", "addresses", "profile"];
  const isCustomer = () => DF.auth.isWebsiteCustomer();
  const currentRoute = () => DF.route.path().split("/")[0] || "home";

  // Routes the original page didn't have.
  routeInfo["verify-email"] = ["Email verification", "Verify your email", "Confirm the email address on your Delivery Fast account."];

  // Demo shipments from the original page; real tracking comes from the API.
  for (const id of Object.keys(sampleTracking)) delete sampleTracking[id];
  try {
    sessionStorage.removeItem("deliveryfast-demo-shipments");
  } catch {}

  // ───────────── after sign-in (called by the React forms) ─────────────

  async function refreshAccount() {
    if (!isCustomer()) return false;
    const before = localStorage.getItem("deliveryfast-customer-address-book");
    const [parcelsChanged] = await Promise.all([DF.parcels.reload(), DF.api("/me/addresses").then(DF.setAddressBook)]);
    return parcelsChanged || before !== localStorage.getItem("deliveryfast-customer-address-book");
  }

  async function signedIn(user) {
    let pending = null;
    try {
      pending = sessionStorage.getItem(RETURN_ROUTE_KEY);
    } catch {}
    // Someone signing in to send a partner application stays on the website, whatever their role.
    if (pending && PARTNER_ROUTES.includes(pending.split("/")[0]) && !DF.auth.hasRole("CUSTOMER")) {
      takeCustomerReturnRoute();
      navigate(pending);
      return;
    }
    if (user.panel && !user.panel.startsWith("/#") && user.panel !== "/account") {
      showToast(`Welcome back, ${user.name}. Opening your workspace…`);
      setTimeout(() => (location.href = DF.auth.destination()), 400);
      return;
    }
    DF.setCustomerSession(user);
    saveCustomerSession({ name: user.name, phone: DF.localPhone(user.phone), email: user.email || "", updatedAt: new Date().toISOString() });
    await refreshAccount().catch(() => undefined);
    const destination = takeCustomerReturnRoute();
    navigate(destination === "home" ? "account" : destination);
  }

  function askToSignIn(route, message) {
    try {
      sessionStorage.setItem(RETURN_ROUTE_KEY, route);
    } catch {}
    navigate("login");
    showToast(message);
  }

  /** Signed in with a panel (merchant, staff, rider) on a customer-only page: open the panel instead. */
  let leaving = false;
  function guardCustomerArea() {
    const user = DF.auth.user;
    const route = currentRoute();
    // Signed out (never signed in, signed out elsewhere, or the account was suspended): the account pages ask
    // to log in and come back afterwards. Booking stays open to guests (SMS-verified guest booking).
    if (!leaving && !user && SIGNED_IN_ROUTES.includes(route)) {
      leaving = true;
      setTimeout(() => {
        leaving = false;
        askToSignIn(DF.route.path() || route, "Please log in to see your account.");
      }, 0);
      return true;
    }
    if (leaving || !user || isCustomer() || !CUSTOMER_ONLY_ROUTES.includes(route)) return false;
    leaving = true;
    showToast(`The customer area is for customers. Opening your ${user.merchant ? "merchant panel" : "workspace"}…`);
    setTimeout(() => location.replace(DF.auth.destination()), 400);
    return true;
  }

  /**
   * A partner application was sent. Merchants now hold the merchant role (pending review); rider and franchise
   * applicants the APPLICANT role. Re-read the session and open that panel (merchant panel, or /application),
   * where the application status and next steps are shown; never the customer area. `only`: open that panel only
   * (someone who already has another panel, e.g. a merchant applying to ride, stays and sees "received").
   */
  async function partnerApplied(title, message, opening = "your merchant panel", only = null) {
    const user = await DF.auth.refresh().catch(() => null);
    if (user?.panel && user.panel !== "/account" && (!only || user.panel === only)) {
      try {
        sessionStorage.removeItem(RETURN_ROUTE_KEY);
      } catch {}
      leaving = true;
      showToast(`${title} Opening ${opening}…`);
      setTimeout(() => (location.href = user.panel), 600);
      return;
    }
    applicationSent(title, message);
  }

  let lastApplication = null;
  function applicationSent(title, message) {
    lastApplication = { title, message };
    navigate("submitted");
    showToast(title);
  }

  window.DFWebsite = {
    signedIn,
    askToSignIn,
    applicationSent,
    merchantApplied: partnerApplied,
    partnerApplied,
    async refreshAccount() {
      await refreshAccount().catch(() => undefined);
      if (DF.auth.user && isCustomer()) {
        // The sidebar shows the customer's name.
        DF.setCustomerSession(DF.auth.user);
        saveCustomerSession({ name: DF.auth.user.name, phone: DF.localPhone(DF.auth.user.phone), email: DF.auth.user.email || "", updatedAt: new Date().toISOString() });
      }
    },
  };

  /** Per-route touches after the page script rendered a view. */
  function decorateRoute() {
    const route = currentRoute();
    if (route === "submitted" && lastApplication) {
      const view = $("pageView");
      const card = view?.querySelector(".route-card:not(form)");
      const heading = card?.querySelector("h2");
      const note = card?.querySelector(".route-note");
      if (heading && note && !card.dataset.application) {
        card.dataset.application = "1";
        const intro = view.querySelector(".route-intro p:last-child");
        if (intro) intro.textContent = "Your application has been sent to the Delivery Fast team.";
        heading.textContent = "Application received";
        note.textContent = `${lastApplication.title} ${lastApplication.message}`;
      }
    }
  }
  const $ = id => document.getElementById(id);

  // ───────────── customer overview and orders (page-script views) ─────────────

  async function refreshAccountView({ keepScroll = false } = {}) {
    const changed = await refreshAccount();
    if (!changed || !ACCOUNT_ROUTES.includes(currentRoute())) return;
    const y = window.scrollY;
    renderRoute();
    if (keepScroll) window.scrollTo({ top: y, behavior: "instant" });
  }
  // Parcel changes arrive as events (signed-in customers); a slow poll covers missed ones.
  DF.live(["parcel.updated", "parcel.created"], () => (ACCOUNT_ROUTES.includes(currentRoute()) ? refreshAccountView({ keepScroll: true }) : Promise.resolve()));

  // ───────────── home page tracking card (page script) ─────────────

  window.addEventListener(
    "click",
    event => {
      if (event.target.closest("#accountLogout")) {
        void DF.auth.logout(); // the page then clears its own view
        return;
      }
      const cancel = event.target.closest("[data-cancel-pickup]");
      if (cancel) {
        event.preventDefault();
        event.stopImmediatePropagation();
        // Owners cancel from the parcel's tracking page (signed in, or with their booking link).
        navigate(`tracking/${encodeURIComponent(cancel.dataset.cancelPickup)}`);
      }
    },
    true,
  );

  const when = iso => (iso ? new Date(iso).toLocaleString() : undefined);

  /** API tracking data -> the object the original tracking card renders. */
  function trackingItem(t) {
    const events = [...t.events].reverse().map(e => ({ time: when(e.at), title: e.title, place: e.location || "", detail: e.description || "" }));
    const latest = t.events[t.events.length - 1];
    return {
      status: t.statusLabel,
      detail: latest?.description || "",
      location: t.currentLocation || latest?.location || "In progress",
      when: when(latest?.at) || "Just now",
      stage: t.stage,
      eta: t.estimatedDeliveryAt ? new Date(t.estimatedDeliveryAt).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }) : undefined,
      service: t.canCancel ? "Customer parcel" : t.serviceLevel,
      sender: t.sender,
      recipient: t.recipient,
      senderArea: t.origin,
      address: t.destination,
      destination: t.destination,
      destinationArea: t.destination,
      contents: "",
      weight: t.weightKg ? `${t.weightKg} kg` : "",
      packageType: t.packaging || "",
      payment: t.codAmount ? `Cash on delivery · ৳${t.codAmount}` : "Prepaid",
      codAmount: t.codAmount,
      proof: t.proofMethod ? `${PROOF[t.proofMethod]} proof recorded` : undefined,
      deliveredAt: when(t.deliveredAt),
      events,
    };
  }

  // The page's own record overlay would replace this data with its older format.
  window.syncPickupTrackingRecord = () => {};

  const originalTrack = window.track;
  const loading = new Set();
  window.track = function (id) {
    const clean = String(id || "").trim().toUpperCase();
    // The /track page is React's (TrackingView); open it there.
    if (currentRoute() === "tracking") {
      if (clean && decodeURIComponent(DF.route.path().split("/")[1] || "").toUpperCase() !== clean) navigate(`tracking/${encodeURIComponent(clean)}`);
      return;
    }
    if (!clean || sampleTracking[clean] || loading.has(clean)) return originalTrack(clean);
    loading.add(clean);
    DF.api(`/track/${encodeURIComponent(clean)}`)
      .then(t => (sampleTracking[clean] = trackingItem(t)))
      .catch(error => {
        if (!(error instanceof DF.ApiError && error.status === 404)) showToast(DF.describe(error));
      })
      .finally(() => {
        loading.delete(clean);
        if (currentRoute() !== "tracking") originalTrack(clean);
        setTimeout(() => delete sampleTracking[clean], 30_000); // refetch on the next lookup
      });
  };

  // The home tracking card's sample IDs don't exist; signed-in customers get their own recent parcels.
  function homeSamples() {
    const hint = document.querySelector("#tracking .track-hint, .tracking-section .track-hint");
    if (!hint || hint.dataset.ownParcels) return;
    hint.dataset.ownParcels = "1";
    const recent = DF.parcels.cache.slice(0, 2).map(p => p.trackingId);
    if (!isCustomer() || !recent.length) return void (hint.hidden = true);
    hint.innerHTML = `Your recent parcels: ${recent.map(id => `<button type="button" data-track-sample="${escapeHtml(id)}">${escapeHtml(id)}</button>`).join(" · ")}`;
  }

  // ───────────── page changes ─────────────

  function onRoute() {
    if (guardCustomerArea()) return;
    decorateRoute();
    homeSamples();
    if (ACCOUNT_ROUTES.includes(currentRoute())) refreshAccountView().catch(error => console.error("Your account data could not be refreshed.", error));
  }
  window.addEventListener("hashchange", () => setTimeout(onRoute, 0));
  // Views re-rendered without a route change (navigate() to the current route, refreshes).
  const originalRenderRoute = renderRoute;
  renderRoute = function () {
    originalRenderRoute();
    if (guardCustomerArea()) return;
    decorateRoute();
  };
  onRoute();
})();
