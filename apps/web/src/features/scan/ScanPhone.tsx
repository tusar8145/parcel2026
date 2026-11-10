"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The phone side of "Scan with phone" (Courier Operations › New orders): take or choose photos of
 * parcel labels. Each photo is sent at once, no editing or waiting: turned upright, compressed on the
 * phone (JPEG, at most 1600 px) and uploaded in the background (a few at a time) through the one-time
 * link (POST /parcel-scans/public/:token/photos), so the next photo can be taken straight away. The
 * computer reads them (several at the same time) and the modal lists them as they are read. The link
 * stops working when the modal is closed.
 */

interface Session {
  kindLabel: string;
  merchantName: string | null;
  photos: number;
  maxPhotos: number;
  scans: { number: number; status: "READING" | "READ" | "FAILED" }[];
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
            </p>
            <p className="hint">Hold the label flat, fill the frame with it and use good light. Each photo is sent at once and becomes one order on the computer: take the next one straight away.</p>
            <div className="actions">
              <button type="button" className="primary" onClick={() => camera.current?.click()} disabled={!session}>
                {"📷 Take photo"}
              </button>
              <button type="button" onClick={() => gallery.current?.click()} disabled={!session}>
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
