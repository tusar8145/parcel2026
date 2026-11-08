/**
 * Live updates: GET /events (server-sent events, filtered by the API to what this person may see).
 * One stream per tab, reconnecting with backoff; "reconnect" fires after a gap so views reload what they show.
 * Same contract as DF.events / DF.live in public/legacy/shared/api.js.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { API_BASE, currentToken, refresh } from "./api";

export type ConnectionState = "connecting" | "live" | "offline";
type Handler = (data: Record<string, unknown>, type: string) => void;

const listeners = new Map<string, Set<Handler>>();
let connection: ConnectionState = "connecting";
const connectionListeners = new Set<() => void>();
let running = false;
let stopped = false;
let controller: AbortController | null = null;

function emit(type: string, data: Record<string, unknown>) {
  for (const key of [type, "*"])
    for (const handler of listeners.get(key) ?? []) {
      try {
        handler(data, type);
      } catch (error) {
        console.error(error);
      }
    }
}

function setConnection(next: ConnectionState) {
  if (next === connection) return;
  connection = next;
  connectionListeners.forEach(l => l());
  emit("connection", { state: next });
}

async function stream() {
  if (running) return;
  running = true;
  stopped = false;
  let failures = 0;
  let first = true;
  while (!stopped) {
    try {
      if (!currentToken()) await refresh();
      const token = currentToken();
      if (!token) break;
      controller = new AbortController();
      const response = await fetch(`${API_BASE}/events`, { headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" }, signal: controller.signal });
      if (!response.ok || !response.body) throw new Error(`events ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const type = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
          const raw = /^data: (.*)$/m.exec(block)?.[1];
          let data: Record<string, unknown> = {};
          try {
            data = raw ? JSON.parse(raw) : {};
          } catch {
            /* a malformed event is skipped */
          }
          if (type === "ready") {
            failures = 0;
            setConnection("live");
            if (!first) emit("reconnect", data); // anything may have changed while disconnected
            first = false;
            continue;
          }
          if (type !== "ping") emit(type, data);
        }
      }
      // The server closes the stream when the token expires.
      emit("reconnect", {});
      first = true;
      setConnection("connecting");
    } catch {
      if (stopped) break;
      failures++;
      setConnection(failures > 1 || navigator.onLine === false ? "offline" : "connecting");
    }
    if (stopped) break;
    await new Promise(resolve => setTimeout(resolve, failures ? Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)) : 300));
  }
  running = false;
}

export const events = {
  start: () => void stream(),
  stop() {
    stopped = true;
    controller?.abort();
  },
  /** Calls handler(data, type) for each matching event ("*" for all); returns an unsubscribe function. */
  on(type: string, handler: Handler) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(handler);
    return () => void listeners.get(type)?.delete(handler);
  },
  get state() {
    return connection;
  },
};

window.addEventListener("online", () => events.start());

export function useConnection() {
  return useSyncExternalStore(
    cb => (connectionListeners.add(cb), () => void connectionListeners.delete(cb)),
    () => connection,
  );
}

/**
 * Keeps a view fresh (DF.live): runs `reload` (debounced) when one of `types` arrives or after a reconnect,
 * plus a slow safety poll. While the tab is hidden, one reload waits for it to come back.
 */
export function useLive(types: string[], reload: () => unknown, { debounceMs = 400, fallbackMs = 120_000, enabled = true } = {}) {
  const ref = useRef(reload);
  ref.current = reload;
  const key = types.join(",");
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending = false;
    const run = () => {
      if (document.visibilityState === "visible") Promise.resolve(ref.current()).catch(() => undefined);
      else pending = true;
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(run, debounceMs);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible" && pending) {
        pending = false;
        schedule();
      }
    };
    const offs = [...key.split(",").filter(Boolean), "reconnect"].map(t => events.on(t, schedule));
    const poll = setInterval(run, fallbackMs);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      offs.forEach(off => off());
      clearInterval(poll);
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [key, debounceMs, fallbackMs, enabled]);
}
