"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { IScannerControls } from "@zxing/browser";

/**
 * The phone side of Courier Operations › "Phone scanner": the phone is one panel tab's barcode
 * scanner. Codes read with the camera (BarcodeDetector, else ZXing), from a photo (when the browser
 * doesn't allow the live camera, e.g. plain http) or typed are sent through the link
 * (POST /phone-scanner/public/:token/scans); the panel puts them into its open scan box and its
 * result comes back here (GET …/:token, polled): a high beep for ✓, a low buzz for ✗. The link
 * stops working when the panel disconnects it or its tab closes.
 */

interface View {
  name: string;
  panel: string;
  scans: number;
  results: { n: number; ok: boolean; message?: string }[];
}
interface Scan {
  key: number;
  code: string;
  n?: number;
  state: "sending" | "sent" | "ok" | "error";
  message?: string;
}

const API = "/api/v1/phone-scanner/public";
const POLL_MS = 2000;
const REPEAT_MS = 2500;
const FORMATS = ["code_39", "code_128", "qr_code", "ean_13", "ean_8", "upc_a", "itf", "codabar", "data_matrix"];
const normalize = (raw: string) => raw.trim().replace(/^\*+|\*+$/g, "").toUpperCase();

const describe = async (res: Response) => {
  try {
    return ((await res.json()) as { error?: { message?: string } }).error?.message || `Error ${res.status}`;
  } catch {
    return `Error ${res.status}`;
  }
};

/** Beeps (Web Audio, unlocked by the Start tap) and vibration. */
function useSound() {
  const ctx = useRef<AudioContext | null>(null);
  const unlock = () => {
    try {
      ctx.current ??= new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      void ctx.current.resume();
    } catch {}
  };
  const tone = (freq: number, ms: number, at = 0) => {
    const c = ctx.current;
    if (!c) return;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.frequency.value = freq;
    gain.gain.value = 0.12;
    osc.connect(gain).connect(c.destination);
    osc.start(c.currentTime + at);
    osc.stop(c.currentTime + at + ms / 1000);
  };
  return {
    unlock,
    read: () => (tone(1200, 70), navigator.vibrate?.(40)),
    ok: () => (tone(880, 90), tone(1320, 110, 0.12), navigator.vibrate?.(60)),
    error: () => (tone(220, 380), navigator.vibrate?.([120, 80, 120])),
  };
}

export default function PhoneScanner({ token }: { token: string }) {
  const [view, setView] = useState<View | null>(null);
  const [closed, setClosed] = useState(false);
  const [problem, setProblem] = useState("");
  const [scans, setScans] = useState<Scan[]>([]);
  const [running, setRunning] = useState(false);
  const [cameraNote, setCameraNote] = useState("");
  const [typed, setTyped] = useState("");
  const video = useRef<HTMLVideoElement>(null);
  const photo = useRef<HTMLInputElement>(null);
  const stopCamera = useRef<() => void>(() => undefined);
  const last = useRef({ code: "", at: 0 });
  const seq = useRef(0);
  const sound = useSound();
  const told = useRef(new Set<number>());

  const patch = (key: number, change: Partial<Scan>) => setScans(list => list.map(s => (s.key === key ? { ...s, ...change } : s)));

  // The link (and the panel's results), polled.
  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${API}/${encodeURIComponent(token)}`, { cache: "no-store" });
      if (res.status === 410 || res.status === 404) {
        setClosed(true);
        stopCamera.current();
        return;
      }
      if (!res.ok) return setProblem(await describe(res));
      setProblem("");
      const v = (await res.json()) as View;
      setView(v);
      for (const r of v.results) {
        if (told.current.has(r.n)) continue;
        setScans(list => {
          const hit = list.find(s => s.n === r.n);
          if (!hit || hit.state === "ok" || hit.state === "error") return list;
          told.current.add(r.n);
          if (r.ok) sound.ok();
          else sound.error();
          return list.map(s => (s.n === r.n ? { ...s, state: r.ok ? "ok" : "error", message: r.message } : s));
        });
      }
    } catch {
      setProblem("No connection. Check the phone's internet.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const send = useCallback(
    async (raw: string) => {
      const code = normalize(raw);
      if (!code) return;
      const now = Date.now();
      if (code === last.current.code && now - last.current.at < REPEAT_MS) return;
      last.current = { code, at: now };
      sound.read();
      const key = ++seq.current;
      setScans(list => [{ key, code, state: "sending" as const }, ...list].slice(0, 50));
      try {
        const res = await fetch(`${API}/${encodeURIComponent(token)}/scans`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
        if (res.status === 410) {
          setClosed(true);
          stopCamera.current();
          return patch(key, { state: "error", message: "Disconnected" });
        }
        if (!res.ok) {
          sound.error();
          return patch(key, { state: "error", message: await describe(res) });
        }
        const body = (await res.json()) as { n: number };
        patch(key, { state: "sent", n: body.n });
      } catch {
        sound.error();
        patch(key, { state: "error", message: "Not sent: no connection" });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [token],
  );

  /** Live camera: BarcodeDetector where the browser has it, else ZXing. */
  const start = async () => {
    sound.unlock();
    setCameraNote("");
    if (!navigator.mediaDevices?.getUserMedia || window.isSecureContext === false) {
      setCameraNote("This browser allows the live camera only on a secure (https) link. Use Take photo below, or type the code.");
      return;
    }
    const el = video.current!;
    try {
      const Detector = (window as unknown as { BarcodeDetector?: { new (o: { formats: string[] }): { detect(v: HTMLVideoElement): Promise<{ rawValue: string }[]> }; getSupportedFormats(): Promise<string[]> } }).BarcodeDetector;
      const formats = Detector ? (await Detector.getSupportedFormats().catch(() => [] as string[])).filter(f => FORMATS.includes(f)) : [];
      if (Detector && (formats.includes("code_128") || formats.includes("code_39"))) {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } }, audio: false });
        el.srcObject = stream;
        await el.play().catch(() => undefined);
        const detector = new Detector({ formats });
        let on = true;
        const tick = async () => {
          if (!on) return;
          try {
            if (el.readyState >= 2) for (const r of await detector.detect(el)) void send(r.rawValue);
          } catch {}
          setTimeout(tick, 160);
        };
        void tick();
        stopCamera.current = () => {
          on = false;
          stream.getTracks().forEach(t => t.stop());
          el.srcObject = null;
          setRunning(false);
        };
      } else {
        const { BrowserMultiFormatReader } = await import("@zxing/browser");
        const reader = new BrowserMultiFormatReader();
        const controls: IScannerControls = await reader.decodeFromConstraints({ video: { facingMode: { ideal: "environment" } }, audio: false }, el, result => result && void send(result.getText()));
        stopCamera.current = () => {
          controls.stop();
          setRunning(false);
        };
      }
      setRunning(true);
    } catch (error) {
      const name = (error as { name?: string })?.name;
      setCameraNote(name === "NotAllowedError" ? "Camera permission was denied. Allow the camera for this site, or use Take photo." : "The camera couldn't start. Use Take photo, or type the code.");
    }
  };
  useEffect(() => () => stopCamera.current(), []);

  /** A photo of the label (no live camera): read with ZXing. */
  const fromPhoto = async (file: File | undefined) => {
    if (!file) return;
    sound.unlock();
    const url = URL.createObjectURL(file);
    try {
      const { BrowserMultiFormatReader } = await import("@zxing/browser");
      const result = await new BrowserMultiFormatReader().decodeFromImageUrl(url);
      void send(result.getText());
    } catch {
      sound.error();
      setCameraNote("No barcode found in that photo. Hold the label flat and closer, and try again.");
    } finally {
      URL.revokeObjectURL(url);
      if (photo.current) photo.current.value = "";
    }
  };

  if (closed)
    return (
      <main className="psc">
        <style>{CSS}</style>
        <section className="psc-card psc-closed" role="alert">
          <h1>{"Disconnected"}</h1>
          <p>{"This phone is no longer the scanner of that screen. To connect again, open Phone scanner on the computer and scan its new QR code."}</p>
        </section>
      </main>
    );

  return (
    <main className="psc">
      <style>{CSS}</style>
      <header className="psc-head">
        <div>
          <strong>{"Paira Express · Phone scanner"}</strong>
          <span>{view ? `${view.panel} · ${view.name}` : "Connecting…"}</span>
        </div>
        <span className="psc-count">{view ? `${view.scans} scan${view.scans === 1 ? "" : "s"}` : ""}</span>
      </header>
      {problem ? <p className="psc-problem" role="alert">{problem}</p> : null}
      <section className="psc-camera">
        <video ref={video} muted playsInline aria-label="Camera" />
        {running ? <div className="psc-frame" aria-hidden="true" /> : null}
        {!running ? (
          <button type="button" className="psc-start" onClick={() => void start()}>
            {"Start scanning"}
          </button>
        ) : null}
      </section>
      {cameraNote ? <p className="psc-note">{cameraNote}</p> : null}
      <div className="psc-tools">
        {running ? (
          <button type="button" className="psc-btn" onClick={() => stopCamera.current()}>
            {"Stop camera"}
          </button>
        ) : null}
        <button type="button" className="psc-btn" onClick={() => (sound.unlock(), photo.current?.click())}>
          {"Take photo"}
        </button>
        <input ref={photo} type="file" accept="image/*" capture="environment" hidden onChange={e => void fromPhoto(e.target.files?.[0])} />
      </div>
      <form
        className="psc-type"
        onSubmit={e => {
          e.preventDefault();
          sound.unlock();
          last.current = { code: "", at: 0 };
          void send(typed);
          setTyped("");
        }}
      >
        <input value={typed} onChange={e => setTyped(e.target.value)} placeholder="Or type a tracking ID" aria-label="Type a code" autoComplete="off" autoCapitalize="characters" spellCheck={false} />
        <button type="submit" className="psc-btn" disabled={!typed.trim()}>
          {"Send"}
        </button>
      </form>
      <ul className="psc-list" aria-live="polite">
        {scans.map(s => (
          <li key={s.key} data-state={s.state}>
            <code>{s.code}</code>
            <span>{s.state === "sending" ? "Sending…" : s.state === "sent" ? "Sent" : s.state === "ok" ? `✓ ${s.message || "Done"}` : `✗ ${s.message || "Not done"}`}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}

const CSS = `
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f4f6fa;color:#1d2939}
.psc{max-width:560px;margin:0 auto;padding:12px 14px 40px;display:grid;gap:10px}
.psc-head{display:flex;justify-content:space-between;align-items:center;gap:10px;background:#2f62e3;color:#fff;border-radius:12px;padding:12px 14px}
.psc-head div{display:grid;gap:2px}.psc-head span{font-size:13px;opacity:.9}.psc-count{font-weight:700;white-space:nowrap}
.psc-camera{position:relative;border-radius:12px;overflow:hidden;background:#101828;aspect-ratio:4/3;display:grid;place-items:center}
.psc-camera video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.psc-frame{position:absolute;left:10%;right:10%;top:36%;height:28%;border:2px solid #fcc118;border-radius:8px;box-shadow:0 0 0 999px #10182855}
.psc-start{position:relative;z-index:1;font:inherit;font-size:17px;font-weight:700;padding:14px 22px;border:0;border-radius:10px;background:#fcc118;color:#1d2939}
.psc-tools{display:flex;gap:8px;flex-wrap:wrap}
.psc-btn{font:inherit;font-weight:600;padding:10px 14px;border:1px solid #d0d5dd;border-radius:9px;background:#fff;color:#344054}
.psc-btn:disabled{opacity:.5}
.psc-type{display:flex;gap:8px}.psc-type input{flex:1;min-width:0;font:inherit;font-size:16px;padding:10px 12px;border:1px solid #d0d5dd;border-radius:9px;text-transform:uppercase}
.psc-note{margin:0;font-size:14px;color:#8a5a0b;background:#fef6e7;border-radius:9px;padding:9px 11px}
.psc-problem{margin:0;font-size:14px;color:#b42318;font-weight:600}
.psc-list{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.psc-list li{display:flex;justify-content:space-between;gap:10px;align-items:center;background:#fff;border:1px solid #e4e7ec;border-left:4px solid #98a2b3;border-radius:9px;padding:9px 11px;font-size:14px}
.psc-list li code{font-size:14px;font-weight:700;word-break:break-all}.psc-list li span{text-align:right;color:#475467}
.psc-list li[data-state="ok"]{border-left-color:#12a150}.psc-list li[data-state="ok"] span{color:#0f7a3d}
.psc-list li[data-state="error"]{border-left-color:#d92d20}.psc-list li[data-state="error"] span{color:#b42318}
.psc-card{background:#fff;border-radius:12px;padding:18px;border:1px solid #e4e7ec}.psc-closed h1{margin:0 0 8px;font-size:20px}.psc-closed p{margin:0;color:#475467;line-height:1.5}
`;
