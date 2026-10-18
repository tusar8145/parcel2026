/*
 * "I'm travelling in this vehicle" (rider app rider/bridge-vehicle.js; Courier Operations Transfers,
 * courier-operation/bridge-linehaul.js): this phone's position becomes a linehaul trip's vehicle position.
 *
 *   DFVehicleShare.load()          GET /vehicle-shares/mine (resumes sending after a reload)
 *   DFVehicleShare.trips(q)        GET /vehicle-shares/trips → trips this user may share
 *   DFVehicleShare.start(trip)     POST /vehicle-shares { trip: id | MF-… } then sends positions
 *   DFVehicleShare.stop()          POST /vehicle-shares/:id/stop
 *   DFVehicleShare.sendNow()       one fresh position at once
 *   DFVehicleShare.state           { share, settings, status, lastSentAt, error }
 *   DFVehicleShare.onChange(fn)    called after every change (to redraw a panel)
 *
 * Sending: a position every `intervalMinutes` (GET /settings/location; the super admin's "Rider location
 * interval") and at once after a move of `movementMeters`, until the user stops or the trip arrives (the
 * server answers `{ stopped: true }` and sharing ends here too). Browsers only share location while the
 * page is open and in the foreground; a closed app or a locked phone pauses it (a native app would be
 * needed for true background tracking). Positions taken without a connection are not queued.
 */
(() => {
  const DF = window.DF;
  if (!DF || window.DFVehicleShare) return;

  const MIN_GAP_MS = 15_000;
  const MAX_ACCURACY_M = 1000;
  const REASON = {
    STOPPED: "Vehicle location sharing stopped.",
    TRIP_ARRIVED: "The trip has arrived: vehicle location sharing ended.",
    TRIP_CLOSED: "The trip was closed: vehicle location sharing ended.",
    TRIP_CANCELLED: "The trip was cancelled: vehicle location sharing ended.",
    REPLACED: "You started sharing another trip.",
    TAKEN_OVER: "Someone else on this trip is now sharing the vehicle's location.",
  };

  const distance = (a, b) => {
    const R = 6371000;
    const toRad = d => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };

  const listeners = new Set();
  const state = { share: null, settings: { intervalMinutes: 5, movementMeters: 50 }, status: "idle", lastSentAt: null, lastSent: null, error: null, loaded: false };
  let watchId = null;
  let sending = null;
  const changed = () => listeners.forEach(fn => {
    try {
      fn(state);
    } catch (error) {
      console.error(error);
    }
  });
  const toast = message => (DF.toast ? DF.toast(message) : window.showToast?.(message));
  const intervalMs = () => (state.settings?.intervalMinutes || 5) * 60_000;

  function watch() {
    if (watchId !== null || !navigator.geolocation || !state.share) return;
    state.status = "waiting";
    watchId = navigator.geolocation.watchPosition(onFix, onError, { enableHighAccuracy: true, maximumAge: 15_000, timeout: 60_000 });
    changed();
  }
  function unwatch() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  function onFix(position, { force = false } = {}) {
    const c = position.coords;
    const fix = { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy, heading: Number.isFinite(c.heading) ? c.heading : null, speed: Number.isFinite(c.speed) ? c.speed : null, at: position.timestamp || Date.now() };
    if (state.status === "waiting") state.status = "on";
    const since = state.lastSentAt ? Date.now() - state.lastSentAt : Infinity;
    const moved = state.lastSent ? distance(state.lastSent, fix) : Infinity;
    const due = since >= intervalMs();
    if (!force && !due && (since < MIN_GAP_MS || moved < (state.settings?.movementMeters || 50) || fix.accuracy > MAX_ACCURACY_M)) return;
    sending = send(fix);
  }
  function onError(error) {
    state.error = error.code === 1 ? "denied" : error.code === 3 ? "timeout" : "unavailable";
    if (error.code === 1) {
      state.status = "denied";
      unwatch();
      toast("Location is blocked for this site. Allow location in the browser settings to share the vehicle's position.");
    }
    changed();
  }

  async function send(fix) {
    const share = state.share;
    if (!share) return "idle";
    state.lastSent = fix;
    state.lastSentAt = Date.now();
    try {
      const result = await DF.api(`/vehicle-shares/${encodeURIComponent(share.id)}/location`, {
        method: "POST",
        body: { lat: fix.lat, lng: fix.lng, accuracy: Math.min(10_000, fix.accuracy), heading: fix.heading, speed: fix.speed != null ? Math.min(100, fix.speed) : null, at: new Date(fix.at).toISOString() },
      });
      if (result?.stopped) {
        ended(result.reason);
        return "stopped";
      }
      state.status = "on";
      state.error = null;
      changed();
      return "sent";
    } catch (error) {
      state.error = DF.describe(error);
      changed();
      return "failed";
    }
  }

  function ended(reason) {
    unwatch();
    const was = state.share;
    state.share = null;
    state.status = "idle";
    state.lastSent = null;
    state.lastSentAt = null;
    changed();
    if (was) toast(REASON[reason] || REASON.STOPPED);
  }

  const current = () =>
    new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(Object.assign(new Error("unsupported"), { code: 0 }));
      navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 });
    });

  // Regular update: watchPosition only reports movement, so a vehicle waiting in traffic still sends every interval.
  setInterval(() => {
    if (!state.share || state.status === "denied" || document.visibilityState !== "visible") return;
    if (state.lastSentAt && Date.now() - state.lastSentAt < intervalMs()) return;
    current()
      .then(position => onFix(position))
      .catch(() => undefined);
  }, 30_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.share) {
      watch();
      if (!state.lastSentAt || Date.now() - state.lastSentAt >= intervalMs()) void api.sendNow({ quiet: true });
    }
  });

  const api = {
    state,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async load() {
      try {
        const mine = await DF.api("/vehicle-shares/mine");
        state.settings = mine.settings || state.settings;
        state.share = mine.share;
        state.loaded = true;
        if (mine.ended) toast(`${mine.ended.trip.number}: ${REASON[mine.ended.reason] || REASON.STOPPED}`);
        if (state.share) watch();
        else unwatch();
      } catch (error) {
        state.loaded = true;
        if (error?.status !== 403) state.error = DF.describe(error);
      }
      changed();
      return state;
    },
    async trips(q = "") {
      const r = await DF.api(`/vehicle-shares/trips${q ? `?q=${encodeURIComponent(q)}` : ""}`);
      return r.items;
    },
    async start(trip) {
      const r = await DF.api("/vehicle-shares", { method: "POST", body: { trip } });
      state.share = r.share;
      state.settings = r.settings || state.settings;
      state.lastSent = null;
      state.lastSentAt = null;
      state.error = null;
      watch();
      changed();
      void api.sendNow({ quiet: true });
      return r.share;
    },
    async stop() {
      const share = state.share;
      if (!share) return;
      await DF.api(`/vehicle-shares/${encodeURIComponent(share.id)}/stop`, { method: "POST" });
      ended("STOPPED");
    },
    async sendNow({ quiet = false } = {}) {
      if (!state.share) return;
      try {
        const position = await current();
        onFix(position, { force: true });
        const result = await sending;
        if (!quiet && result !== "stopped") toast(result === "sent" ? "Vehicle location sent." : `The vehicle's location couldn't be sent${state.error ? `: ${state.error}` : ""}.`);
      } catch (error) {
        if (error?.code === 1) onError(error);
        else if (!quiet) toast(error?.code === 3 ? "No GPS fix yet. Try again near a window." : "The location isn't available right now.");
      }
    },
    /** "Sharing DHK-… · Gulshan Hub → Dhanmondi Hub · last sent 2 min ago". */
    describe() {
      const s = state.share;
      if (!s) return "";
      const minutes = state.lastSentAt ? Math.floor((Date.now() - state.lastSentAt) / 60_000) : null;
      const sent = state.status === "denied" ? "location blocked" : minutes == null ? "waiting for a GPS fix…" : `last sent ${minutes < 1 ? "just now" : `${minutes} min ago`}`;
      return `Sharing ${s.trip.vehicleRegNo} · ${s.trip.route} (${s.trip.number}) · ${sent}`;
    },
    REASON,
  };
  window.DFVehicleShare = api;
})();
