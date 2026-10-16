/*
 * Rider app offline storage and action queue (window.DFOffline). Loaded before shared/api.js.
 *
 * IndexedDB "df-rider":
 * - kv      the signed-in rider (so the app can open without a connection) and the last task
 *           list, summary, earnings… per user, for reading offline.
 * - queue   actions taken offline (pickups, start delivery, delivery outcomes with their proof
 *           images): replayed in order with their Idempotency-Key when the connection is back.
 * - points  GPS fixes taken while offline, sent later in one batch.
 *
 * Signing out deletes everything (api.js calls DFOffline.clear()).
 *
 * send(action) runs an action now when online, else queues it. While older actions are still
 * queued, new ones queue behind them so they reach the server in the order they happened.
 * flush() replays the queue: a refusal (409 PARCEL_CHANGED, 403, 422…) marks that action as
 * failed with the server's message for the rider to review; a network problem, a server error
 * or an expired session stops the run and keeps the rest for later.
 */
(() => {
  const DB_NAME = "df-rider";
  const DB_VERSION = 1;
  const SESSION_MAX_AGE_MS = 7 * 86_400_000; // after this the rider must sign in online again
  const MAX_POINTS = 3000;
  const listeners = new Set();
  let dbPromise = null;
  let flushing = null;

  const supported = () => {
    try {
      return typeof indexedDB !== "undefined" && !!indexedDB;
    } catch {
      return false;
    }
  };

  function open() {
    if (!supported()) return Promise.reject(new Error("IndexedDB is not available"));
    dbPromise ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
        if (!db.objectStoreNames.contains("queue")) db.createObjectStore("queue", { keyPath: "id", autoIncrement: true }).createIndex("user", "userId");
        if (!db.objectStoreNames.contains("points")) db.createObjectStore("points", { keyPath: "id", autoIncrement: true });
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        dbPromise = null;
        reject(request.error);
      };
    });
    return dbPromise;
  }

  /** Runs fn(store) in a transaction; resolves with fn's request result once committed. */
  async function run(storeName, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      let result;
      const request = fn(store);
      if (request && "onsuccess" in request) request.onsuccess = () => (result = request.result);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
    });
  }

  const kv = {
    get: key => run("kv", "readonly", s => s.get(key)).catch(() => undefined),
    set: (key, value) => run("kv", "readwrite", s => s.put(value, key)).catch(() => undefined),
  };

  let lastUserId = null;
  /** The signed-in rider (remembered, so queued actions stay visible if the session lapses). */
  const userId = () => (lastUserId = window.DF?.auth?.user?.id ?? lastUserId);
  const changed = () => {
    for (const fn of listeners) {
      try {
        fn();
      } catch (error) {
        console.error(error);
      }
    }
  };
  const uuid = () =>
    crypto.randomUUID?.() ??
    "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16));
  /** A failure where the request may never have reached the server (no connection, proxy down). */
  const isNetworkError = error => !(window.DF && error instanceof window.DF.ApiError) || error.status === 0 || error.status === 502 || error.status === 503 || error.status === 504;

  // ───────────── session and read cache ─────────────

  async function saveSession(user) {
    if (!user?.roles?.includes("RIDER")) return;
    await kv.set("session", { user, savedAt: Date.now() });
  }
  /** The last signed-in rider, when the app opens without a connection. */
  async function restoreSession() {
    const saved = await kv.get("session");
    if (!saved?.user || Date.now() - saved.savedAt > SESSION_MAX_AGE_MS) return null;
    return saved.user;
  }
  async function save(name, value) {
    const id = userId();
    if (id) await kv.set(`cache:${id}:${name}`, { value, savedAt: Date.now() });
  }
  async function load(name) {
    const id = userId();
    return id ? (await kv.get(`cache:${id}:${name}`)) || null : null;
  }

  /**
   * Loads fresh data and keeps a copy; without a connection, returns the copy (and remembers
   * how old it is in DFOffline.staleSince[name]). Refusals from the API are passed on.
   */
  async function cached(name, loader) {
    try {
      const value = await loader();
      delete api.staleSince[name];
      void save(name, value);
      return value;
    } catch (error) {
      if (!isNetworkError(error)) throw error;
      const copy = await load(name);
      if (!copy) throw error;
      api.staleSince[name] = copy.savedAt;
      changed();
      return copy.value;
    }
  }

  // ───────────── action queue ─────────────

  const queue = {
    all: async () => ((await run("queue", "readonly", s => s.index("user").getAll(userId() ?? ""))) || []).sort((a, b) => a.id - b.id),
    add: item => run("queue", "readwrite", s => s.add(item)),
    put: item => run("queue", "readwrite", s => s.put(item)),
    remove: id => run("queue", "readwrite", s => s.delete(id)),
  };

  /**
   * Runs the action now, or queues it when offline. Resolves { queued: false, result } or
   * { queued: true, item }; an API refusal while online is thrown as usual.
   */
  async function send({ path, method = "POST", body, trackingId, op, label }) {
    const DF = window.DF;
    const item = { userId: userId(), path, method, body, trackingId, op, label, key: uuid(), createdAt: new Date().toISOString(), attempts: 0, state: "pending" };
    let backlog = false;
    try {
      backlog = (await queue.all()).some(i => i.state === "pending");
    } catch {}
    if (!backlog && navigator.onLine !== false) {
      try {
        return { queued: false, result: await DF.api(path, { method, body, headers: { "Idempotency-Key": item.key } }) };
      } catch (error) {
        if (!isNetworkError(error)) throw error;
      }
    }
    if (!supported()) throw new Error("You're offline and this browser can't save actions for later. Reconnect and try again.");
    item.id = await queue.add(item);
    changed();
    if (navigator.onLine !== false) void flush();
    return { queued: true, item };
  }

  /** Replays queued actions in order. Resolves { synced, failed, pending, stoppedBy }. */
  function flush() {
    flushing ??= (async () => {
      const DF = window.DF;
      let synced = 0;
      let stoppedBy = null;
      const items = await queue.all().catch(() => []);
      for (const item of items) {
        if (item.state !== "pending") continue;
        item.attempts++;
        item.lastAttemptAt = new Date().toISOString();
        try {
          await DF.api(item.path, { method: item.method, body: item.body, headers: { "Idempotency-Key": item.key } });
          await queue.remove(item.id);
          synced++;
          changed();
        } catch (error) {
          const network = isNetworkError(error);
          const retryLater = network || error.status === 401 || error.status === 429 || error.status >= 500 || error.code === "IDEMPOTENT_REQUEST_IN_PROGRESS";
          item.lastError = { status: error.status ?? 0, code: error.code ?? "NETWORK", message: network ? "No connection" : DF.describe(error) };
          if (!retryLater) item.state = "failed";
          await queue.put(item).catch(() => undefined);
          changed();
          if (retryLater) {
            stoppedBy = error.status === 401 ? "signin" : network ? "offline" : "server";
            break;
          }
        }
      }
      const after = await queue.all().catch(() => []);
      return { synced, failed: after.filter(i => i.state === "failed").length, pending: after.filter(i => i.state === "pending").length, stoppedBy };
    })().finally(() => (flushing = null));
    return flushing;
  }

  async function retry(id) {
    const item = (await queue.all()).find(i => i.id === id);
    if (!item) return;
    item.state = "pending";
    // A new key: the old one may be stored with the refused request.
    item.key = uuid();
    await queue.put(item);
    changed();
    return flush();
  }
  async function discard(id) {
    await queue.remove(id);
    changed();
  }

  const LABEL = { OUT_FOR_DELIVERY: "Out for delivery" };
  /** The task lists as they will be once the queued actions sync (queued items are marked). */
  function withPending(tasks, items) {
    const pickups = [...(tasks?.pickups || [])];
    const deliveries = [...(tasks?.deliveries || [])];
    const drop = (list, id) => {
      const i = list.findIndex(p => p.trackingId === id);
      return i >= 0 ? list.splice(i, 1)[0] : null;
    };
    for (const item of items) {
      if (item.state !== "pending") continue;
      if (item.op === "pickup") {
        const parcel = drop(pickups, item.trackingId);
        if (parcel && item.body?.outcome === "COLLECTED_DELIVER_DIRECT" && !deliveries.some(d => d.trackingId === item.trackingId))
          deliveries.push({ ...parcel, status: "OUT_FOR_DELIVERY", statusLabel: LABEL.OUT_FOR_DELIVERY, _queued: true });
      } else if (item.op === "start-delivery") {
        const i = deliveries.findIndex(p => p.trackingId === item.trackingId);
        if (i >= 0) deliveries[i] = { ...deliveries[i], status: "OUT_FOR_DELIVERY", statusLabel: LABEL.OUT_FOR_DELIVERY, _queued: true };
      } else if (item.op === "delivery") {
        drop(deliveries, item.trackingId);
      }
    }
    return { ...tasks, pickups, deliveries };
  }

  /** api.js rider.reload: fresh tasks (or the saved copy offline) with queued actions applied. */
  async function tasks(loader) {
    const fresh = await cached("tasks", loader);
    const items = await queue.all().catch(() => []);
    return withPending(fresh, items);
  }

  // ───────────── GPS points recorded offline ─────────────

  const points = {
    async add(list) {
      if (!list.length) return;
      await run("points", "readwrite", s => {
        for (const p of list) s.add({ ...p, userId: userId() });
      });
      const count = await points.count();
      if (count > MAX_POINTS) {
        const ids = ((await run("points", "readonly", s => s.getAllKeys())) || []).slice(0, count - MAX_POINTS);
        await run("points", "readwrite", s => ids.forEach(id => s.delete(id)));
      }
    },
    count: () => run("points", "readonly", s => s.count()).catch(() => 0),
    /** Oldest points of the signed-in rider, at most `limit`. */
    async take(limit = 500) {
      const all = (await run("points", "readonly", s => s.getAll())) || [];
      return all.filter(p => p.userId === userId()).slice(0, limit);
    },
    remove: ids => run("points", "readwrite", s => ids.forEach(id => s.delete(id))),
  };

  /** Deletes everything stored for the rider app on this device. */
  async function clear() {
    if (!supported()) return;
    try {
      const db = await dbPromise;
      db?.close();
    } catch {}
    dbPromise = null;
    await new Promise(resolve => {
      const request = indexedDB.deleteDatabase(DB_NAME);
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
    changed();
  }

  const api = {
    supported,
    staleSince: {},
    saveSession,
    restoreSession,
    cached,
    save,
    load,
    tasks,
    send,
    flush,
    retry,
    discard,
    queued: () => queue.all().catch(() => []),
    points,
    clear,
    isNetworkError,
    /** fn() runs whenever the queue or the cached data changes; returns an unsubscribe function. */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    get flushing() {
      return !!flushing;
    },
  };
  window.DFOffline = api;
})();
