"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The phone side of "Scan with phone" (Courier Operations › New orders): take or choose photos of
 * parcel labels. Each photo is sent at once, no editing or waiting: turned upright, compressed on the
 * phone (JPEG, at most 1600 px) and uploaded in the background (a few at a time) through the one-time
 * link (POST /parcel-scans/public/:token/photos), so the next photo can be taken straight away. The
 * computer reads them (several at the same time) and the modal lists them as they are read. The link
 * stops working when the modal is closed.
 * Three ways to take them: Live camera (the camera stays on in the page; Capture takes the frame and the
 * camera keeps running for the next parcel), Take photo (the phone's camera app, one photo at a time) and
 * Choose photos (the gallery).
 */

interface Session {
  kindLabel: string;
  merchantName: string | null;
  photos: number;
  maxPhotos: number;
  scans: { number: number; status: "READING" | "READ" | "FAILED" }[];
  /** Scans left (super admin's scan balance); null = no limit. */
  scansLeft?: number | null;
}
interface Upload {
  key: number;
  preview: string;
  state: "sending" | "sent" | "failed";
  number?: number;
  error?: string;
  /** The photo as taken; compressed just before it is sent. */
  file: File;
  /** The compressed photo (kept for a retry). */
  photo?: Blob;
}

const API = "/api/v1/parcel-scans/public";
const MAX_SIDE = 1600;
const QUALITY = 0.85;
const POLL_MS = 4000;
/** Photos uploading at the same time. */
const PARALLEL = 3;

/** The photo upright (EXIF), at most MAX_SIDE px, as JPEG. */
async function compress(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => null);
  const source: CanvasImageSource & { width: number; height: number } =
    bitmap ??
    (await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("This photo can't be opened. Take it again."));
      img.src = URL.createObjectURL(file);
    }));
  const scale = Math.min(1, MAX_SIDE / Math.max(source.width, source.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(source.width * scale);
  canvas.height = Math.round(source.height * scale);
  canvas.getContext("2d")!.drawImage(source, 0, 0, canvas.width, canvas.height);
  bitmap?.close();
  return new Promise<Blob>((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error("The photo couldn't be prepared"))), "image/jpeg", QUALITY));
}

/** The live camera's current frame, at most MAX_SIDE px, as JPEG. */
function grab(video: HTMLVideoElement): Promise<Blob> {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return Promise.reject(new Error("The camera isn't ready yet"));
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise<Blob>((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error("The photo couldn't be prepared"))), "image/jpeg", QUALITY));
}

const describe = async (res: Response) => {
  try {
    return ((await res.json()) as { error?: { message?: string } }).error?.message || `Error ${res.status}`;
  } catch {
    return `Error ${res.status}`;
  }
};

const STATUS: Record<string, string> = { READING: "Reading…", READ: "Read", FAILED: "Type in on computer" };

export default function ScanPhone({ token }: { token: string }) {
  const [session, setSession] = useState<Session | null>(null);
  const [expired, setExpired] = useState(false);
  const [problem, setProblem] = useState("");
  const [uploads, setUploads] = useState<Upload[]>([]);
  /** Uploads waiting for a free slot, and how many are running. */
  const waiting = useRef<Upload[]>([]);
  const running = useRef(0);
  const seq = useRef(0);
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  // Live camera: stays on between captures until Stop, leaving the page or the link ending.
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const wakeLock = useRef<{ release(): Promise<void> } | null>(null);
  const [live, setLive] = useState<"off" | "starting" | "on">("off");
  const [liveProblem, setLiveProblem] = useState("");
  const [torch, setTorch] = useState<boolean | null>(null);
  const [flash, setFlash] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${API}/${encodeURIComponent(token)}`, { cache: "no-store" });
      if (res.status === 410 || res.status === 404) return setExpired(true);
      if (!res.ok) return setProblem(await describe(res));
      setProblem("");
      setSession((await res.json()) as Session);
    } catch {
      setProblem("No connection. Check the phone's internet.");
    }
  }, [token]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const patch = (key: number, change: Partial<Upload>) => setUploads(list => list.map(u => (u.key === key ? { ...u, ...change } : u)));

  /** One upload: compress (first time), then POST. */
  const upload = useCallback(
    async (item: Upload) => {
      try {
        patch(item.key, { state: "sending", error: undefined });
        const photo = item.photo ?? (await compress(item.file));
        item.photo = photo;
        const form = new FormData();
        form.append("photo", photo, `parcel-${item.key}.jpg`);
        const res = await fetch(`${API}/${encodeURIComponent(token)}/photos`, { method: "POST", body: form });
        if (res.status === 410) {
          setExpired(true);
          return patch(item.key, { state: "failed", error: "The link has expired" });
        }
        if (!res.ok) return patch(item.key, { state: "failed", error: await describe(res) });
        const body = (await res.json()) as { number: number };
        patch(item.key, { state: "sent", number: body.number });
        void refresh();
      } catch (error) {
        patch(item.key, { state: "failed", error: error instanceof Error ? error.message : "Not sent" });
      }
    },
    [token, refresh],
  );

  /** Queued: up to PARALLEL uploads run at once; the rest wait their turn. */
  const send = useCallback(
    (item: Upload) => {
      waiting.current.push(item);
      const next = () => {
        while (running.current < PARALLEL && waiting.current.length) {
          const job = waiting.current.shift()!;
          running.current++;
          void upload(job).finally(() => {
            running.current--;
            next();
          });
        }
      };
      next();
    },
    [upload],
  );

  const stopLive = useCallback(() => {
    stream.current?.getTracks().forEach(t => t.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
    void wakeLock.current?.release().catch(() => undefined);
    wakeLock.current = null;
    setTorch(null);
    setLive("off");
  }, []);

  async function startLive() {
    setLiveProblem("");
    if (!navigator.mediaDevices?.getUserMedia || window.isSecureContext === false) {
      setLiveProblem("This browser can't keep the camera on here. Use Take photo instead.");
      return;
    }
    setLive("starting");
    try {
      const media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      stream.current = media;
      const el = video.current!;
      el.srcObject = media;
      await el.play().catch(() => undefined);
      const track = media.getVideoTracks()[0];
      // A light (torch) only where the browser offers it.
      setTorch((track?.getCapabilities?.() as { torch?: boolean } | undefined)?.torch ? false : null);
      // Keep the screen on while the camera is in use (ignored where the browser doesn't allow it).
      const nav = navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } };
      wakeLock.current = (await nav.wakeLock?.request("screen").catch(() => null)) ?? null;
      setLive("on");
    } catch (error) {
      stopLive();
      const name = error instanceof Error ? error.name : "";
      setLiveProblem(name === "NotAllowedError" ? "Camera permission was refused. Allow the camera for this site in the browser settings, or use Take photo." : "The camera couldn't be started. Use Take photo instead.");
    }
  }

  async function toggleTorch() {
    const track = stream.current?.getVideoTracks()[0];
    if (!track || torch === null) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torch } as MediaTrackConstraintSet] });
      setTorch(!torch);
    } catch {
      setTorch(null);
    }
  }

  /** Capture: the current frame is sent like a photo; the camera keeps running for the next parcel. */
  async function capture() {
    if (!video.current || live !== "on") return;
    try {
      const photo = await grab(video.current);
      setFlash(true);
      setTimeout(() => setFlash(false), 140);
      navigator.vibrate?.(35);
      const item: Upload = { key: ++seq.current, preview: URL.createObjectURL(photo), state: "sending", file: new File([photo], `parcel-${seq.current}.jpg`, { type: "image/jpeg" }), photo };
      setUploads(list => [item, ...list]);
      send(item);
    } catch (error) {
      setLiveProblem(error instanceof Error ? error.message : "The photo couldn't be taken");
    }
  }

  // The camera goes off with the page, when the tab is hidden (the phone pauses it anyway) and when the link ends.
  useEffect(() => stopLive, [stopLive]);
  useEffect(() => {
    const hidden = () => {
      if (document.hidden && stream.current) stopLive();
    };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, [stopLive]);
  useEffect(() => {
    if (expired || session?.scansLeft === 0) stopLive();
  }, [expired, session?.scansLeft, stopLive]);

  /** Taken or chosen: every photo is sent straight away (newest on top). */
  const choose = (files: FileList | null) => {
    const picked = [...(files ?? [])].filter(f => f.type.startsWith("image/") || !f.type);
    for (const file of picked) {
      const item: Upload = { key: ++seq.current, preview: URL.createObjectURL(file), state: "sending", file };
      setUploads(list => [item, ...list]);
      send(item);
    }
  };

  const statusOf = (number?: number) => (number ? session?.scans.find(s => s.number === number)?.status : undefined);

  return (
    <main className="scan">
      <style>{CSS}</style>
      <header>
        <strong>Delivery Fast</strong>
        <span>Scan parcels</span>
      </header>
      {expired ? (
        <section className="card expired" role="alert">
          <h1>This link has expired</h1>
          <p>The scanning window on the computer was closed. Open “Scan with phone” again and scan the new QR code.</p>
        </section>
      ) : (
        <>
          <section className="card">
            <h1>Photograph each parcel label</h1>
            <p className="meta">
              {session ? `${session.kindLabel}${session.merchantName ? ` · ${session.merchantName}` : ""} · ${session.photos} sent` : "Connecting…"}
              {session?.scansLeft != null ? ` · ${session.scansLeft} scan${session.scansLeft === 1 ? "" : "s"} left` : ""}
            </p>
            {session?.scansLeft === 0 ? (
              <p className="problem" role="alert" style={{ margin: "0 0 12px" }}>
                No scans left. Ask the super admin to add scan balance.
              </p>
            ) : null}
            <p className="hint">Hold the label flat, fill the frame with it and use good light. Each photo is sent at once and becomes one order on the computer: take the next one straight away.</p>
            <div className={`live${live === "off" ? " hidden" : ""}`}>
              <video ref={video} playsInline muted autoPlay aria-label="Camera" />
              <div className="frame" aria-hidden="true" />
              {flash ? <div className="flash" aria-hidden="true" /> : null}
              {live === "starting" ? <div className="starting">Starting the camera…</div> : null}
            </div>
            {live !== "off" ? (
              <div className="live-actions">
                <button type="button" className="shutter" onClick={() => void capture()} disabled={live !== "on"} aria-label="Capture">
                  {"Capture"}
                </button>
                <div className="live-row">
                  {torch !== null ? (
                    <button type="button" onClick={() => void toggleTorch()} aria-pressed={torch}>
                      {torch ? "🔦 Light off" : "🔦 Light on"}
                    </button>
                  ) : null}
                  <button type="button" onClick={stopLive}>
                    {"Stop camera"}
                  </button>
                </div>
                <p className="hint small">The camera stays on: capture the next parcel straight away. Photos are sent in the background.</p>
              </div>
            ) : null}
            {liveProblem ? (
              <p className="problem" role="alert" style={{ margin: "0 0 12px" }}>
                {liveProblem}
              </p>
            ) : null}
            <div className="actions">
              {live === "off" ? (
                <button type="button" className="primary" onClick={() => void startLive()} disabled={!session || session.scansLeft === 0}>
                  {"📹 Live camera"}
                </button>
              ) : null}
              <button
                type="button"
                className={live === "off" ? "" : "secondary"}
                onClick={() => {
                  // The phone's camera app takes the camera: the live one stops (start it again after).
                  stopLive();
                  camera.current?.click();
                }}
                disabled={!session || session.scansLeft === 0}
              >
                {"📷 Take photo"}
              </button>
              <button type="button" onClick={() => gallery.current?.click()} disabled={!session || session.scansLeft === 0}>
                {"🖼 Choose photos"}
              </button>
            </div>
            <input
              ref={camera}
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              onChange={e => {
                choose(e.target.files);
                e.target.value = "";
              }}
            />
            <input
              ref={gallery}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={e => {
                choose(e.target.files);
                e.target.value = "";
              }}
            />
            {problem ? (
              <p className="problem" role="alert">
                {problem}
              </p>
            ) : null}
          </section>
          {uploads.length ? (
            <ul className="list" aria-live="polite">
              {uploads.map(u => {
                const read = statusOf(u.number);
                return (
                  <li key={u.key}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={u.preview} alt="" />
                    <div>
                      <strong>{u.number ? `Parcel #${u.number}` : "Photo"}</strong>
                      <span className={`state ${u.state}`}>
                        {u.state === "sending"
                            ? "Sending…"
                            : u.state === "failed"
                              ? u.error || "Not sent"
                              : `Sent · ${STATUS[read ?? "READING"]}`}
                      </span>
                    </div>
                    {u.state === "failed" && !expired ? (
                      <button type="button" onClick={() => send(u)}>
                        {"Retry"}
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </>
      )}
    </main>
  );
}

const CSS = `
*{box-sizing:border-box}
body{margin:0;background:#f4f5f7;color:#12161c;font:15px/1.45 "Geist Variable","Noto Sans Bengali Variable",system-ui,sans-serif}
.scan{max-width:520px;margin:0 auto;padding:0 16px 32px}
.scan header{display:flex;justify-content:space-between;align-items:center;padding:16px 0}
.scan header strong{color:#1d5fd0;font-size:17px}
.scan header span{color:#6b7482;font-size:13px}
.card{background:#fff;border:1px solid #e3e6ea;border-radius:12px;padding:18px}
.card h1{margin:0 0 4px;font-size:19px}
.meta{margin:0 0 10px;color:#1d5fd0;font-weight:600;font-size:14px}
.hint{margin:0 0 16px;color:#4c5563;font-size:14px}
.actions{display:grid;gap:10px}
.live{position:relative;margin:0 0 12px;border-radius:12px;overflow:hidden;background:#0b0e13;aspect-ratio:3/4;max-height:62vh}
.live.hidden{display:none}
.live video{width:100%;height:100%;object-fit:cover;display:block}
.live .frame{position:absolute;inset:9%;border:2px solid #ffffffcc;border-radius:12px;box-shadow:0 0 0 999px #0000002e;pointer-events:none}
.live .flash{position:absolute;inset:0;background:#fff;opacity:.75;pointer-events:none}
.live .starting{position:absolute;inset:0;display:grid;place-items:center;color:#fff;font-size:15px}
.live-actions{display:grid;gap:10px;margin:0 0 14px}
.live-actions .shutter{min-height:64px;font-size:19px;background:#1d5fd0;border-color:#1d5fd0;color:#fff;border-radius:999px}
.live-row{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:10px}
.live-row button{min-height:46px}
.hint.small{margin:0;font-size:13px}
.actions button{min-height:52px;font-size:16px}
button{font:inherit;font-weight:600;border:1px solid #cdd2d9;background:#fff;color:#12161c;border-radius:8px;padding:10px 14px;cursor:pointer}
button.primary{background:#1d5fd0;border-color:#1d5fd0;color:#fff}
button:disabled{opacity:.5}
.problem{margin:12px 0 0;color:#b42318;font-size:14px}
.expired h1{color:#b42318}
.list{list-style:none;margin:14px 0 0;padding:0;display:grid;gap:8px}
.list li{display:flex;align-items:center;gap:12px;background:#fff;border:1px solid #e3e6ea;border-radius:12px;padding:8px}
.list img{width:56px;height:56px;object-fit:cover;border-radius:8px;background:#eef2f7;flex:none}
.list div{flex:1;min-width:0;display:grid}
.list .state{color:#6b7482;font-size:13px}
.list .state.sent{color:#067647}
.list .state.failed{color:#b42318}
.list button{padding:8px 12px}
`;
