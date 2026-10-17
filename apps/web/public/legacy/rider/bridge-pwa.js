/*
 * Rider app as an installable, offline-capable app.
 *
 * - Service worker /rider-sw.js (scope /rider): caches the app shell; when a new version is
 *   waiting, an "Update ready" bar offers to reload into it.
 * - Sync status chip in the top bar: offline · N actions pending · syncing · N need attention ·
 *   synced. Tapping it lists the queued actions (offline.js) with Retry / Discard. The queue is
 *   replayed when the connection comes back, when the app is reopened and every minute while
 *   anything is pending. A refusal (e.g. 409 PARCEL_CHANGED: operations changed the parcel) is
 *   shown to the rider with the server's message.
 * - Live GPS while on shift: POST /rider/location when the rider has moved ~50 m or every
 *   2 minutes; fixes taken offline are kept on the phone and sent with POST /rider/location/batch.
 *   Browsers only share location while the app is open: Settings explains this and offers
 *   "Keep screen on" (Screen Wake Lock) and a battery saver (network location, fewer fixes).
 * - Settings → "Location & offline" panel; manifest shortcuts open a page with ?page=…
 */
(() => {
  const DF = window.DF;
  const Off = window.DFOffline;
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const clock = ms => (ms ? new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "—");
  const page = () => $("breadcrumbPage")?.textContent;
  const pref = {
    get: (key, fallback) => {
      try {
        const v = localStorage.getItem(`df-rider-${key}`);
        return v === null ? fallback : v === "1";
      } catch {
        return fallback;
      }
    },
    set: (key, on) => {
      try {
        localStorage.setItem(`df-rider-${key}`, on ? "1" : "0");
      } catch {}
    },
  };

  const app = { version: null, registration: null, updateReady: false, installPrompt: null, installed: matchMedia("(display-mode: standalone)").matches || navigator.standalone === true };
  const sync = { items: [], running: false, lastSyncedAt: null, stoppedBy: null, syncedFlash: 0 };

  // ───────────── service worker and updates ─────────────

  function showUpdateBar() {
    if (app.updateReady || !app.registration?.waiting) return;
    app.updateReady = true;
    const bar = document.createElement("div");
    bar.id = "dfUpdateBar";
    bar.setAttribute("role", "status");
    bar.style.cssText = "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:60;display:flex;gap:10px;align-items:center;max-width:calc(100% - 32px);padding:10px 12px;background:#1f2937;color:#fff;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.18);font-size:13px";
    bar.innerHTML = `<span>A new version of the rider app is ready.</span><button type="button" class="button button-sm button-primary" id="dfUpdateNow">Update</button><button type="button" class="button button-sm" id="dfUpdateLater" aria-label="Later">Later</button>`;
    document.body.append(bar);
    $("dfUpdateNow").addEventListener("click", () => applyUpdate());
    $("dfUpdateLater").addEventListener("click", () => bar.remove());
    renderSettingsPanel();
  }

  async function applyUpdate() {
    const pending = sync.items.filter(i => i.state === "pending").length;
    if (pending && navigator.onLine) await Off?.flush().catch(() => undefined);
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    });
    app.registration?.waiting?.postMessage({ type: "skip-waiting" });
  }

  async function registerWorker() {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
    try {
      const reg = await navigator.serviceWorker.register("/rider-sw.js", { scope: "/rider" });
      app.registration = reg;
      if (reg.waiting && navigator.serviceWorker.controller) showUpdateBar();
      reg.addEventListener("updatefound", () => {
        const worker = reg.installing;
        worker?.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) showUpdateBar();
        });
      });
      const ready = await navigator.serviceWorker.ready;
      // Cache what this page loaded before the worker was in control (Next.js chunks, fonts).
      const urls = performance
        .getEntriesByType("resource")
        .map(e => e.name)
        .filter(u => u.startsWith(location.origin) && !u.includes("/api/"));
      ready.active?.postMessage({ type: "cache-urls", urls: [...new Set(urls)] });
      const channel = new MessageChannel();
      channel.port1.onmessage = event => {
        app.version = event.data?.version || null;
        renderSettingsPanel();
      };
      ready.active?.postMessage({ type: "version" }, [channel.port2]);
      setInterval(() => document.visibilityState === "visible" && navigator.onLine && reg.update().catch(() => undefined), 30 * 60_000);
    } catch (error) {
      console.warn("Delivery Fast: the offline app could not be installed", error);
    }
  }

  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    app.installPrompt = event;
    renderSettingsPanel();
  });
  window.addEventListener("appinstalled", () => {
    app.installed = true;
    app.installPrompt = null;
    DF.toast("Delivery Fast Rider is installed. Open it from your home screen.");
    renderSettingsPanel();
  });

  // ───────────── sync status ─────────────

  function chip() {
    let el = $("dfSyncChip");
    if (!el) {
      const shift = $("shiftChip");
      if (!shift) return null;
      el = document.createElement("button");
      el.type = "button";
      el.id = "dfSyncChip";
      el.className = "shift-chip";
      el.style.cssText = "border:0;cursor:pointer;font:inherit;font-size:13px;font-weight:650";
      el.setAttribute("aria-live", "polite");
      shift.before(el);
    }
    return el;
  }

  function renderChip() {
    const el = chip();
    if (!el) return;
    const pending = sync.items.filter(i => i.state === "pending").length;
    const failed = sync.items.filter(i => i.state === "failed").length;
    const offline = navigator.onLine === false;
    let text = "";
    let tone = "";
    if (failed) [text, tone] = [`${failed} need${failed === 1 ? "s" : ""} attention`, "red"];
    else if (pending && sync.stoppedBy === "signin") [text, tone] = ["Sign in to sync", "red"];
    else if (offline) [text, tone] = [pending ? `Offline · ${pending} pending` : "Offline", "amber"];
    else if (pending) [text, tone] = [sync.running ? `Syncing ${pending}…` : `${pending} pending`, "blue"];
    else if (Date.now() - sync.syncedFlash < 4000) [text, tone] = ["All synced", "green"];
    el.hidden = !text;
    el.innerHTML = `<i></i> ${esc(text)}`;
    const colors = { red: ["var(--red-soft)", "var(--red)"], amber: ["var(--amber-soft)", "var(--amber)"], blue: ["var(--blue-soft)", "var(--blue)"], green: ["var(--green-soft)", "var(--green)"] }[tone] || ["", ""];
    el.style.background = colors[0];
    el.style.color = colors[1];
    el.querySelector("i").style.background = colors[1];
    el.title = "Actions saved on this phone";
  }

  async function reloadQueue() {
    sync.items = Off ? await Off.queued() : [];
    renderChip();
    renderOfflineStrip();
    if (activeAction?.type === "df-sync") fillSyncModal();
    renderSettingsPanel();
  }

  async function flush({ quiet = false } = {}) {
    if (!Off || sync.running || navigator.onLine === false) return;
    const before = new Set((await Off.queued()).filter(i => i.state === "failed").map(i => i.id));
    if (!(await Off.queued()).some(i => i.state === "pending")) {
      await flushPoints();
      return;
    }
    sync.running = true;
    renderChip();
    try {
      const result = await Off.flush();
      sync.stoppedBy = result.stoppedBy;
      if (result.synced) {
        sync.lastSyncedAt = Date.now();
        if (!result.pending && !result.failed) sync.syncedFlash = Date.now();
        setTimeout(renderChip, 4100);
        await DF.riderRefresh?.().catch(() => undefined);
        if (!quiet) DF.toast(`${result.synced} offline update${result.synced === 1 ? "" : "s"} synced.`);
      }
      const newlyFailed = (await Off.queued()).filter(i => i.state === "failed" && !before.has(i.id));
      if (newlyFailed.length) {
        const first = newlyFailed[0];
        DF.toast(`${first.trackingId || "An update"} couldn't be synced: ${first.lastError?.message || "refused"}. Tap the status chip to review.`);
        await DF.riderRefresh?.().catch(() => undefined);
      }
      if (result.stoppedBy === "signin") DF.toast("Your session has ended. Sign in again to sync your saved updates.");
    } finally {
      sync.running = false;
      await reloadQueue();
    }
    await flushPoints();
  }

  /** The queued actions, in the action dialog (Retry / Discard; "Sync now"). */
  const OP = { pickup: "Pickup", "start-delivery": "Out for delivery", delivery: "Delivery outcome" };
  const describeItem = i => {
    const b = i.body || {};
    if (i.op === "delivery") return b.outcome === "DELIVERED" ? `Delivered · ${b.proof?.method === "OTP" ? "code" : (b.proof?.method || "").toLowerCase()} proof` : `Failed attempt · ${b.reason}`;
    if (i.op === "pickup") return b.outcome === "COLLECTED_DELIVER_DIRECT" ? "Picked up · delivering directly" : b.outcome === "COLLECTED_TO_HUB" ? "Picked up · to hub" : "Pickup exception";
    return OP[i.op] || i.op;
  };
  function fillSyncModal() {
    const items = sync.items;
    const offline = navigator.onLine === false;
    $("modalDescription").textContent = items.length
      ? `${items.length} update${items.length === 1 ? "" : "s"} saved on this phone. ${offline ? "They sync automatically when you're back online." : sync.stoppedBy === "signin" ? "Sign in again to sync them." : "They're sent in the order you made them."}`
      : "Everything you did has reached Delivery Fast.";
    $("submitAction").textContent = sync.stoppedBy === "signin" ? "Sign in" : offline ? "Close" : "Sync now";
    $("modalFields").innerHTML = `<div class="field full">${
      items
        .map(
          i =>
            `<div class="activity"><span class="activity-icon">${icon(i.state === "failed" ? "alert" : "scan")}</span><div class="activity-copy"><strong>${esc(i.trackingId || "")}</strong> · ${esc(describeItem(i))}<small>Saved ${esc(new Date(i.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}${i.attempts ? ` · ${i.attempts} attempt${i.attempts === 1 ? "" : "s"}` : ""}</small>${
              i.state === "failed"
                ? `<span style="display:block;margin-top:4px;color:var(--red)">${esc(i.lastError?.message || "Refused")}${i.lastError?.code === "PARCEL_CHANGED" ? " Operations changed this parcel while you were offline; check it and record the outcome again if needed." : ""}</span><span style="display:flex;gap:6px;margin-top:6px"><button type="button" class="button button-sm" data-df-queue-retry="${i.id}">Retry</button><button type="button" class="button button-sm button-danger" data-df-queue-discard="${i.id}">Discard</button></span>`
                : `<span style="display:block;margin-top:4px;color:#8a94a3">${i.lastError && i.lastError.code !== "NETWORK" ? esc(i.lastError.message) : "Waiting to sync"}</span>`
            }</div></div>`,
        )
        .join("") || `<div class="empty-state">No updates waiting.</div>`
    }</div>`;
  }
  function openSyncModal() {
    activeAction = { type: "df-sync" };
    $("modalTitle").textContent = "Updates saved on this phone";
    fillSyncModal();
    $("actionModal").classList.add("open");
  }

  window.addEventListener(
    "click",
    event => {
      if (event.target.closest("#dfSyncChip")) {
        event.stopImmediatePropagation();
        return void openSyncModal();
      }
      const retry = event.target.closest("[data-df-queue-retry]");
      const discard = event.target.closest("[data-df-queue-discard]");
      if (retry) {
        event.stopImmediatePropagation();
        if (navigator.onLine === false) return void DF.toast("You're offline. It will be retried when you're back online.");
        void Off.retry(Number(retry.dataset.dfQueueRetry)).then(() => flush());
      }
      if (discard) {
        event.stopImmediatePropagation();
        const queued = Number(discard.dataset.dfQueueDiscard);
        void DF.confirm({ title: "Discard this update?", message: "It won't be sent to Delivery Fast.", confirm: "Discard", danger: true }).then(ok => ok && Off.discard(queued).then(() => DF.riderRefresh?.().catch(() => undefined)));
      }
      const syncNow = event.target.closest("[data-df-sync-now]");
      if (syncNow) {
        event.stopImmediatePropagation();
        void flush();
      }
    },
    true,
  );
  window.addEventListener(
    "submit",
    event => {
      if (event.target.id !== "actionForm" || activeAction?.type !== "df-sync") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (sync.stoppedBy === "signin") return void DF.goToLogin();
      closeModal();
      if (navigator.onLine !== false) void flush();
    },
    true,
  );

  // Signing out deletes the saved tasks and queued updates on this phone: warn first.
  window.addEventListener(
    "click",
    event => {
      if (!event.target.closest(".user-profile")) return;
      const pending = sync.items.length;
      if (!pending) return;
      // One dialog instead of the usual "Sign out?" (shared/api.js): warn about the unsynced updates.
      event.stopImmediatePropagation();
      void DF.confirm({ title: "Sign out?", message: `${pending} update${pending === 1 ? " hasn't" : "s haven't"} synced yet. Signing out deletes ${pending === 1 ? "it" : "them"} from this phone.`, confirm: "Sign out anyway", danger: true }).then(async ok => {
        if (!ok) return;
        await DF.auth.logout();
        location.href = "/login";
      });
    },
    true,
  );

  /** "You're offline" strip above the page, with how old the saved task list is. */
  function renderOfflineStrip() {
    $("dfOfflineStrip")?.remove();
    const offline = navigator.onLine === false;
    const stale = Off?.staleSince?.tasks;
    if (!offline && !stale) return;
    const main = $("mainContent");
    if (!main) return;
    main.insertAdjacentHTML(
      "afterbegin",
      `<div id="dfOfflineStrip" role="status" style="margin-bottom:14px;padding:10px 12px;border-radius:9px;background:var(--amber-soft);color:var(--amber);font-size:13px;font-weight:600">${
        offline ? "You're offline." : "Delivery Fast can't be reached right now."
      } ${stale ? `Showing your tasks as saved at ${esc(clock(stale))}.` : ""} Pickups, scans and deliveries you record are saved on this phone and sync automatically.</div>`,
    );
  }

  const baseRender = render;
  render = function (name) {
    baseRender(name);
    try {
      renderOfflineStrip();
      if (name === "Settings") renderSettingsPanel(true);
    } catch (error) {
      console.error("Delivery Fast: offline extras failed", error);
    }
  };

  window.addEventListener("online", () => {
    renderChip();
    renderOfflineStrip();
    DF.events.restart?.();
    void flush();
    gps.resume();
  });
  window.addEventListener("offline", () => {
    renderChip();
    renderOfflineStrip();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void flush({ quiet: true });
      gps.wake();
    }
  });
  Off?.onChange(() => void reloadQueue());
  setInterval(() => {
    if (sync.items.some(i => i.state === "pending") && navigator.onLine !== false && document.visibilityState === "visible") void flush({ quiet: true });
  }, 60_000);

  // ───────────── live GPS while on shift ─────────────

  const MIN_DISTANCE_M = 50;
  const MIN_INTERVAL_MS = 15_000;
  const HEARTBEAT_MS = 120_000;
  const MAX_ACCURACY_M = 500;

  const distance = (a, b) => {
    const R = 6371000;
    const toRad = d => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };

  const gps = (DF.gps = {
    state: navigator.geolocation ? "off" : "unsupported",
    last: null,
    lastSent: null,
    lastSentAt: null,
    queued: 0,
    watchId: null,
    wakeLock: null,
    error: null,
    onShift: () => DF.riderState?.status === "ONLINE",
    start() {
      if (!navigator.geolocation || gps.watchId !== null) return;
      gps.state = "waiting";
      const saver = pref.get("gps-saver", false);
      gps.watchId = navigator.geolocation.watchPosition(gps.onFix, gps.onError, { enableHighAccuracy: !saver, maximumAge: saver ? 60_000 : 15_000, timeout: 60_000 });
      void gps.wake();
      renderSettingsPanel();
    },
    stop() {
      if (gps.watchId !== null) navigator.geolocation.clearWatch(gps.watchId);
      gps.watchId = null;
      if (gps.state !== "denied" && gps.state !== "unsupported") gps.state = "off";
      void gps.wakeLock?.release().catch(() => undefined);
      gps.wakeLock = null;
      renderSettingsPanel();
    },
    restart() {
      gps.stop();
      if (gps.onShift()) gps.start();
    },
    resume() {
      if (gps.onShift()) gps.start();
      void flushPoints();
    },
    /** Screen Wake Lock while on shift, if the rider asked for it (re-acquired when the app is reopened). */
    async wake() {
      if (!gps.onShift() || !pref.get("keep-awake", false) || !navigator.wakeLock || gps.wakeLock || document.visibilityState !== "visible") return;
      try {
        gps.wakeLock = await navigator.wakeLock.request("screen");
        gps.wakeLock.addEventListener("release", () => (gps.wakeLock = null));
      } catch {}
    },
    onFix(position) {
      const c = position.coords;
      const fix = { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy, heading: Number.isFinite(c.heading) ? c.heading : null, speed: Number.isFinite(c.speed) ? c.speed : null, at: position.timestamp || Date.now() };
      gps.last = fix;
      gps.state = "on";
      gps.error = null;
      const now = Date.now();
      const since = gps.lastSentAt ? now - gps.lastSentAt : Infinity;
      const moved = gps.lastSent ? distance(gps.lastSent, fix) : Infinity;
      const heartbeat = since >= HEARTBEAT_MS;
      if (!heartbeat && (since < MIN_INTERVAL_MS || moved < MIN_DISTANCE_M || fix.accuracy > MAX_ACCURACY_M)) return;
      gps.lastSent = fix;
      gps.lastSentAt = now;
      void gps.send(fix);
      if (page() === "Settings") renderSettingsPanel();
    },
    onError(error) {
      gps.error = error.code === 1 ? "denied" : error.code === 3 ? "timeout" : "unavailable";
      if (error.code === 1) {
        gps.state = "denied";
        gps.stop();
        gps.state = "denied";
        DF.toast("Location is blocked for this app. Allow location in your browser settings so dispatch can see you on the map.");
      }
      renderSettingsPanel();
    },
    async send(fix) {
      const body = { lat: fix.lat, lng: fix.lng, accuracy: Math.min(10_000, fix.accuracy), heading: fix.heading, speed: fix.speed != null ? Math.min(100, fix.speed) : null, at: new Date(fix.at).toISOString() };
      if (navigator.onLine === false) return gps.keep(body);
      try {
        await DF.api("/rider/location", { method: "POST", body });
      } catch (error) {
        if (Off?.isNetworkError(error)) return gps.keep(body);
        if (error.code === "RIDER_OFF_SHIFT") return gps.stop();
        if (error.status === 401) return gps.keep(body);
        console.warn("Delivery Fast: location not accepted", error);
      }
    },
    async keep(body) {
      await Off?.points.add([body]).catch(() => undefined);
      gps.queued = (await Off?.points.count()) || 0;
    },
  });

  async function flushPoints() {
    if (!Off || navigator.onLine === false || gps.flushing) return;
    gps.flushing = true;
    try {
      for (let round = 0; round < 10; round++) {
        const batch = await Off.points.take(500);
        if (!batch.length) break;
        try {
          await DF.api("/rider/location/batch", { method: "POST", body: { points: batch.map(({ id, userId, ...p }) => p) } });
          await Off.points.remove(batch.map(p => p.id));
        } catch (error) {
          // Refused points (e.g. too old) are dropped; a network problem leaves them for later.
          if (Off.isNetworkError(error) || error.status === 401 || error.status === 429) break;
          await Off.points.remove(batch.map(p => p.id));
        }
      }
    } finally {
      gps.flushing = false;
      gps.queued = await Off.points.count();
    }
  }

  document.addEventListener("df:rider-status", event => {
    if (event.detail.status === "ONLINE") gps.start();
    else gps.stop();
  });

  // ───────────── Settings: location & offline ─────────────

  const GPS_TEXT = {
    on: "Sharing your location with dispatch",
    waiting: "Waiting for a GPS fix…",
    off: "Off · starts when you start your shift",
    denied: "Blocked · allow location for this site in your browser settings",
    unsupported: "Not available on this device",
  };
  function renderSettingsPanel(fresh = false) {
    if (page() !== "Settings") return;
    const main = $("mainContent");
    if (!main) return;
    const existing = $("dfDevicePanel");
    if (!existing && !fresh) return;
    const pending = sync.items.filter(i => i.state === "pending").length;
    const failed = sync.items.filter(i => i.state === "failed").length;
    const saved = Off?.staleSince?.tasks;
    const toggle = (key, on, label) => `<button type="button" class="button button-sm" data-df-pref="${key}" aria-pressed="${on}">${on ? "On" : "Off"}</button>`;
    const html = `<section class="panel" id="dfDevicePanel" style="margin-top:14px"><div class="panel-heading"><div><h2 class="panel-title">Location & offline</h2><p class="panel-subtitle">How this phone shares your position and keeps working without a connection</p></div></div>
      <div class="earnings-row" style="margin-top:12px"><span>Live location</span><strong>${esc(GPS_TEXT[gps.state] || gps.state)}</strong></div>
      <div class="earnings-row"><span>Last position sent</span><strong>${gps.lastSentAt ? `${esc(clock(gps.lastSentAt))}${gps.last ? ` · ±${Math.round(gps.last.accuracy)} m` : ""}` : "—"}${gps.queued ? ` · ${gps.queued} saved offline` : ""}</strong></div>
      <div class="earnings-row"><span>Battery saver <small style="display:block;color:#8a94a3">Network location and fewer fixes; less precise</small></span>${toggle("gps-saver", pref.get("gps-saver", false))}</div>
      <div class="earnings-row"><span>Keep screen on during shift <small style="display:block;color:#8a94a3">${navigator.wakeLock ? "Stops the phone sleeping while the app is open" : "Not supported by this browser"}</small></span>${toggle("keep-awake", pref.get("keep-awake", false))}</div>
      <p class="panel-subtitle" style="margin:10px 0 4px">Browsers share location only while the rider app is open. If you switch to another app or the screen turns off, Android may pause it until you come back; your position then updates again automatically. Keep the app open on your phone mount during deliveries.</p>
      <div class="earnings-row"><span>Updates waiting to sync</span><strong>${pending}${failed ? ` · ${failed} need attention` : ""}</strong></div>
      <div class="earnings-row"><span>Saved task list</span><strong>${saved ? `from ${esc(clock(saved))} (offline copy)` : navigator.onLine === false ? "offline copy" : "up to date"}</strong></div>
      <div class="earnings-row"><span>App version</span><strong>${esc(app.version || "—")}${app.installed ? " · installed" : ""}</strong></div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px">${pending || failed ? `<button type="button" class="button button-sm" data-df-sync-now>Sync now</button>` : ""}${
        app.installPrompt && !app.installed ? `<button type="button" class="button button-sm button-primary" data-df-install>Install app</button>` : ""
      }${app.updateReady ? `<button type="button" class="button button-sm button-primary" data-df-update>Update app</button>` : ""}</div></section>`;
    if (existing) existing.outerHTML = html;
    else main.insertAdjacentHTML("beforeend", html);
    for (const row of document.querySelectorAll("#mainContent .earnings-row")) if (row.querySelector("span")?.textContent === "App version" && !row.closest("#dfDevicePanel")) row.querySelector("strong").textContent = app.version || "1.0";
  }

  window.addEventListener(
    "click",
    event => {
      const prefButton = event.target.closest("[data-df-pref]");
      if (prefButton) {
        event.stopImmediatePropagation();
        const key = prefButton.dataset.dfPref;
        pref.set(key, !pref.get(key, false));
        if (key === "gps-saver") gps.restart();
        if (key === "keep-awake") pref.get(key, false) ? void gps.wake() : void gps.wakeLock?.release().catch(() => undefined);
        renderSettingsPanel();
      }
      if (event.target.closest("[data-df-install]")) {
        event.stopImmediatePropagation();
        app.installPrompt?.prompt();
        void app.installPrompt?.userChoice.finally(() => {
          app.installPrompt = null;
          renderSettingsPanel();
        });
      }
      if (event.target.closest("[data-df-update]")) {
        event.stopImmediatePropagation();
        void applyUpdate();
      }
    },
    true,
  );

  // ───────────── start ─────────────

  void registerWorker();
  void reloadQueue();
  Promise.resolve(DF.bridgeReady).finally(() => {
    if (gps.onShift()) gps.start();
    if (navigator.onLine !== false) void flush({ quiet: false });
    // Home-screen shortcuts: /rider?page=Scan%20parcel
    const wanted = new URLSearchParams(location.search).get("page");
    if (wanted && document.querySelector(`#navigation [data-page="${CSS.escape(wanted)}"]`)) render(wanted);
  });
})();
