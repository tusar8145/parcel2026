"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A one-photo link opened on a phone (QR code on the computer, e.g. Mark settlement paid › Payment
 * receipt › Use phone): take or choose the photo, check it, Done. It is shrunk (JPEG, at most 1600 px)
 * and sent once (POST /photo-links/public/:token/photo); the computer shows it, and the link stops working.
 */

const API = "/api/v1/photo-links/public";
const MAX_SIDE = 1600;

const describe = async (res: Response) => {
  try {
    return ((await res.json()) as { error?: { message?: string } }).error?.message || `Error ${res.status}`;
  } catch {
    return `Error ${res.status}`;
  }
};

function shrink(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL("image/jpeg", 0.8));
    };
    img.onerror = () => reject(new Error("That file isn't a photo."));
    img.src = URL.createObjectURL(file);
  });
}

export default function PhotoLink({ token }: { token: string }) {
  const [title, setTitle] = useState("");
  const [state, setState] = useState<"loading" | "ready" | "sending" | "sent" | "closed">("loading");
  const [problem, setProblem] = useState("");
  const [photo, setPhoto] = useState<string | null>(null);
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`${API}/${encodeURIComponent(token)}`, { cache: "no-store" });
        if (res.status === 410 || res.status === 404) return setState("closed");
        if (!res.ok) return setProblem(await describe(res));
        setTitle(((await res.json()) as { title: string }).title);
        setState("ready");
      } catch {
        setProblem("No connection. Check the phone's internet.");
      }
    })();
  }, [token]);

  const picked = async (file: File | undefined) => {
    if (!file) return;
    setProblem("");
    try {
      setPhoto(await shrink(file));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The photo couldn't be read.");
    }
  };

  const send = async () => {
    if (!photo) return;
    setState("sending");
    setProblem("");
    try {
      const res = await fetch(`${API}/${encodeURIComponent(token)}/photo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ image: photo }) });
      if (res.status === 410) return setState("closed");
      if (!res.ok) {
        setState("ready");
        return setProblem(await describe(res));
      }
      setState("sent");
    } catch {
      setState("ready");
      setProblem("Not sent: no connection. Try again.");
    }
  };

  return (
    <main className="pl">
      <style>{CSS}</style>
      <header className="pl-head">
        <strong>{"Paira Express"}</strong>
        <span>{title || "Photo"}</span>
      </header>
      {state === "closed" ? (
        <section className="pl-card" role="alert">
          <h1>{"Link no longer works"}</h1>
          <p>{"It was already used, has expired, or was closed on the computer. Ask for a new QR code."}</p>
        </section>
      ) : state === "sent" ? (
        <section className="pl-card pl-done" role="status">
          <h1>{"✓ Photo sent"}</h1>
          <p>{"It's on the computer now. You can close this page; the link no longer works."}</p>
        </section>
      ) : (
        <>
          {photo ? <img className="pl-preview" src={photo} alt="The photo to send" /> : <div className="pl-empty">{state === "loading" ? "Loading…" : "Take a clear photo of the receipt (the whole slip, readable)."}</div>}
          {problem ? <p className="pl-problem" role="alert">{problem}</p> : null}
          <div className="pl-tools">
            <button type="button" className="pl-btn pl-primary" disabled={state !== "ready"} onClick={() => camera.current?.click()}>
              {photo ? "Retake" : "Take photo"}
            </button>
            <button type="button" className="pl-btn" disabled={state !== "ready"} onClick={() => gallery.current?.click()}>
              {"Choose from gallery"}
            </button>
          </div>
          <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={e => void picked(e.target.files?.[0])} />
          <input ref={gallery} type="file" accept="image/*" hidden onChange={e => void picked(e.target.files?.[0])} />
          <button type="button" className="pl-btn pl-send" disabled={!photo || state !== "ready"} onClick={() => void send()}>
            {state === "sending" ? "Sending…" : "Done"}
          </button>
        </>
      )}
    </main>
  );
}

const CSS = `
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f4f6fa;color:#1d2939}
.pl{max-width:520px;margin:0 auto;padding:12px 14px 40px;display:grid;gap:12px}
.pl-head{display:grid;gap:2px;background:#2f62e3;color:#fff;border-radius:12px;padding:12px 14px}.pl-head span{font-size:14px;opacity:.9}
.pl-empty{display:grid;place-items:center;text-align:center;min-height:240px;padding:20px;border:2px dashed #c9d2df;border-radius:12px;color:#647184;background:#fff}
.pl-preview{width:100%;max-height:60vh;object-fit:contain;border-radius:12px;background:#101828}
.pl-tools{display:flex;gap:8px;flex-wrap:wrap}
.pl-btn{flex:1;font:inherit;font-weight:600;padding:12px 14px;border:1px solid #d0d5dd;border-radius:10px;background:#fff;color:#344054}
.pl-btn:disabled{opacity:.5}.pl-primary{background:#fcc118;border-color:#fcc118;color:#1d2939}
.pl-send{width:100%;font-size:17px;padding:14px;background:#12a150;border-color:#12a150;color:#fff}
.pl-problem{margin:0;color:#b42318;font-weight:600;font-size:14px}
.pl-card{background:#fff;border:1px solid #e4e7ec;border-radius:12px;padding:18px}.pl-card h1{margin:0 0 8px;font-size:20px}.pl-card p{margin:0;color:#475467;line-height:1.5}
.pl-done h1{color:#0f7a3d}
`;
