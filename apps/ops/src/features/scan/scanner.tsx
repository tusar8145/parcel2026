/**
 * Barcode scanning (shared/scanner.js): USB / Bluetooth scanners type into the box (keyboard mode); the camera uses
 * the browser's BarcodeDetector and falls back to ZXing (/vendor/zxing). Every scan box gives the same feedback
 * (short high beep ok, long low beep error, vibration, the box flashing green / red). Boxes register themselves so a
 * code from the phone scanner (top bar) goes into the box in use, like a camera read.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Icon } from "@/ui/Icon";
import { openCustom } from "@/ui/dialogs";

export type ScanSource = "CAMERA" | "KEYBOARD" | "MANUAL";
const FORMATS = ["code_39", "code_128", "qr_code", "ean_13", "ean_8", "upc_a", "itf", "codabar", "data_matrix"];
const REPEAT_MS = 2500;

/** "*PP-261015-1001*" / " pp-261015-1001 " → "PP-261015-1001". */
export const normalizeScan = (code: string) =>
  String(code || "")
    .trim()
    .replace(/^\*+|\*+$/g, "")
    .toUpperCase();

let audio: AudioContext | null = null;
export function scanFeedback(ok: boolean) {
  try {
    navigator.vibrate?.(ok ? 60 : [80, 60, 80]);
    audio ||= new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    gain.gain.value = 0.15;
    osc.frequency.value = ok ? 1046 : 220;
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + (ok ? 0.09 : 0.35));
  } catch {
    /* no audio */
  }
}

let zxing: Promise<{ BrowserMultiFormatReader: new () => { decodeFromStream: (s: MediaStream, v: HTMLVideoElement, cb: (r: { getText(): string } | undefined) => void) => Promise<{ stop(): void }> } }> | null = null;
function loadZxing() {
  const w = window as unknown as { ZXingBrowser?: unknown };
  if (w.ZXingBrowser) return Promise.resolve(w.ZXingBrowser as never);
  zxing ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/vendor/zxing/zxing-browser.min.js";
    script.async = true;
    script.onload = () => (w.ZXingBrowser ? resolve(w.ZXingBrowser as never) : reject(new Error("ZXing did not load")));
    script.onerror = () => {
      zxing = null;
      reject(new Error("The barcode reader could not be loaded"));
    };
    document.head.append(script);
  });
  return zxing;
}

/** Starts the camera on `video`; onCode(code) per new read. Returns stop(). */
export async function startCamera(video: HTMLVideoElement, onCode: (code: string) => void): Promise<() => void> {
  if (!navigator.mediaDevices?.getUserMedia || window.isSecureContext === false) throw new Error("This browser can't use the camera here. Type or scan the code with a keyboard scanner instead.");
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } }, audio: false });
  video.srcObject = stream;
  video.setAttribute("playsinline", "");
  video.muted = true;
  await video.play().catch(() => undefined);
  let last = { code: "", at: 0 };
  const emit = (raw: string) => {
    const code = normalizeScan(raw);
    if (!code) return;
    const now = Date.now();
    if (code === last.code && now - last.at < REPEAT_MS) return;
    last = { code, at: now };
    onCode(code);
  };
  let stopLoop = () => undefined as void;
  const Detector = (window as unknown as { BarcodeDetector?: { new (o: { formats: string[] }): { detect(v: HTMLVideoElement): Promise<{ rawValue: string }[]> }; getSupportedFormats(): Promise<string[]> } }).BarcodeDetector;
  let detector: { detect(v: HTMLVideoElement): Promise<{ rawValue: string }[]> } | null = null;
  if (Detector) {
    try {
      const available = await Detector.getSupportedFormats();
      const usable = FORMATS.filter(f => available.includes(f));
      if (usable.includes("code_39") || usable.includes("code_128")) detector = new Detector({ formats: usable });
    } catch {
      detector = null;
    }
  }
  if (detector) {
    let running = true;
    stopLoop = () => void (running = false);
    const tick = async () => {
      if (!running) return;
      try {
        if (video.readyState >= 2) for (const r of await detector!.detect(video)) emit(r.rawValue);
      } catch {
        /* next frame */
      }
      setTimeout(tick, 180);
    };
    void tick();
  } else {
    const ZX = await loadZxing();
    const reader = new ZX.BrowserMultiFormatReader();
    const controls = await reader.decodeFromStream(stream, video, r => r && emit(r.getText()));
    stopLoop = () => controls?.stop();
  }
  return () => {
    try {
      stopLoop();
    } catch {
      /* stopped */
    }
    stream.getTracks().forEach(t => t.stop());
    video.srcObject = null;
  };
}

/** A camera dialog: continuous calls onCode for every read until closed; otherwise resolves with the first code. */
export function openCamera({ title = "Scan barcode", hint = "Point the camera at the barcode on the label.", onCode, continuous = false }: { title?: string; hint?: string; onCode?: (code: string, source: ScanSource) => void; continuous?: boolean }) {
  return openCustom<string | null>(close => <CameraDialog title={title} hint={hint} continuous={continuous} onCode={onCode} close={close} />);
}

function CameraDialog({ title, hint, continuous, onCode, close }: { title: string; hint: string; continuous: boolean; onCode?: (code: string, source: ScanSource) => void; close: (v?: string | null) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState("Starting the camera…");
  const [typed, setTyped] = useState("");
  const done = useRef(false);
  const accept = (raw: string, source: ScanSource) => {
    const code = normalizeScan(raw);
    if (!code || done.current) return;
    onCode?.(code, source);
    if (continuous) setStatus(`Read ${code}`);
    else {
      done.current = true;
      close(code);
    }
  };
  useEffect(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;
    startCamera(video.current!, code => accept(code, "CAMERA"))
      .then(s => {
        if (cancelled) return s();
        stop = s;
        setStatus(continuous ? "Scanning · close when you're done." : "Looking for a barcode…");
      })
      .catch((e: Error & { name?: string }) => setStatus(e?.name === "NotAllowedError" ? "Camera permission was denied. Type the code instead." : e?.message || "The camera isn't available. Type the code instead."));
    return () => {
      cancelled = true;
      stop?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <div className="dialog-head">
        <div>
          <h2>{title}</h2>
          <p>{hint}</p>
        </div>
      </div>
      <div className="dialog-body stack">
        <video ref={video} style={{ width: "100%", borderRadius: 10, background: "#101828", aspectRatio: "4 / 3", objectFit: "cover" }} />
        <p className="muted" role="status" aria-live="polite" style={{ margin: 0 }}>
          {status}
        </p>
        <form
          className="row"
          onSubmit={e => {
            e.preventDefault();
            accept(typed, "KEYBOARD");
            setTyped("");
          }}
        >
          <input className="input grow" placeholder="Or type the code" value={typed} onChange={e => setTyped(e.target.value)} aria-label="Type the code" />
          <button type="submit" className="button">
            Add
          </button>
        </form>
      </div>
      <div className="dialog-foot">
        <button type="button" className="button primary" onClick={() => close(null)}>
          {continuous ? "Done" : "Close"}
        </button>
      </div>
    </>
  );
}

// ── scan boxes (for codes from the phone scanner) ──
interface Box {
  el: HTMLInputElement;
  onScan: (code: string, source: ScanSource) => void;
}
const boxes: Box[] = [];
let lastBox: Box | null = null;
let pending: { resolve: (r: { delivered: boolean; ok: boolean; message?: string }) => void; timer: ReturnType<typeof setTimeout> } | null = null;
const visible = (el: HTMLElement) => el.isConnected && !(el as HTMLInputElement).disabled && el.offsetParent !== null;
export const hasScanBox = () => boxes.some(b => visible(b.el));
/** A code from another device: into the box in use (resolves with that box's result, or delivered: false). */
export function deliverScan(raw: string): Promise<{ delivered: boolean; ok: boolean; message?: string; code?: string }> {
  const code = normalizeScan(raw);
  const box = lastBox && boxes.includes(lastBox) && visible(lastBox.el) ? lastBox : boxes.find(b => visible(b.el));
  if (!code || !box) return Promise.resolve({ delivered: false, ok: false, code });
  return new Promise(resolve => {
    pending?.resolve({ delivered: true, ok: true });
    const timer = setTimeout(() => {
      if (pending?.timer === timer) pending = null;
      resolve({ delivered: true, ok: true });
    }, 6000);
    pending = { timer, resolve: r => (clearTimeout(timer), resolve(r)) };
    box.onScan(code, "CAMERA");
  });
}
/** F2: the first scan box on screen. */
export function focusScanBox() {
  const box = boxes.find(b => visible(b.el));
  box?.el.focus();
  box?.el.select();
  return !!box;
}

export interface ScanInputHandle {
  /** Flash green / red, beep, and answer a waiting phone-scanner delivery. */
  feedback: (ok: boolean, message?: string) => void;
  focus: () => void;
  input: HTMLInputElement | null;
}

/**
 * The scan box: Enter sends the code (KEYBOARD, or MANUAL when typed slowly by a person), the camera button scans
 * continuously. The box keeps the focus for the next parcel.
 */
export const ScanInput = forwardRef<ScanInputHandle, { onScan: (code: string, source: ScanSource) => void; label?: string; placeholder?: string; cameraTitle?: string; autoFocus?: boolean; big?: boolean; id?: string; disabled?: boolean; children?: React.ReactNode }>(
  function ScanInput({ onScan, label = "Scan or type the tracking ID", placeholder = "PP-… or CN", cameraTitle = "Scan parcels", autoFocus = true, big = true, id, disabled, children }, ref) {
    const input = useRef<HTMLInputElement>(null);
    const [flash, setFlash] = useState<"" | "ok" | "error">("");
    const typedSlow = useRef(false);
    const lastKey = useRef(0);
    const handler = useRef(onScan);
    handler.current = onScan;
    useImperativeHandle(ref, () => ({
      feedback(ok, message) {
        scanFeedback(ok);
        setFlash(ok ? "ok" : "error");
        setTimeout(() => setFlash(""), 900);
        if (pending) {
          const p = pending;
          pending = null;
          p.resolve({ delivered: true, ok, message });
        }
      },
      focus: () => input.current?.focus(),
      input: input.current,
    }));
    useEffect(() => {
      const box: Box = { el: input.current!, onScan: (c, s) => handler.current(c, s) };
      boxes.push(box);
      const focus = () => (lastBox = box);
      box.el.addEventListener("focus", focus);
      if (autoFocus) setTimeout(() => box.el.focus({ preventScroll: true }), 40);
      return () => {
        box.el.removeEventListener("focus", focus);
        boxes.splice(boxes.indexOf(box), 1);
        if (lastBox === box) lastBox = null;
      };
    }, [autoFocus]);
    return (
      <div className="field">
        <label className="field-label" htmlFor={id}>
          {label}
        </label>
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <input
            ref={input}
            id={id}
            className="input grow"
            autoComplete="off"
            spellCheck={false}
            placeholder={placeholder}
            disabled={disabled}
            data-scan-result={flash || undefined}
            style={{
              minHeight: big ? 48 : 38,
              fontSize: big ? 17 : 14,
              fontWeight: 650,
              letterSpacing: ".02em",
              transition: "box-shadow .15s, border-color .15s",
              ...(flash === "ok" ? { borderColor: "var(--good)", boxShadow: "0 0 0 4px rgb(10 122 60 / 22%)" } : flash === "error" ? { borderColor: "var(--bad)", boxShadow: "0 0 0 4px rgb(192 41 43 / 22%)" } : {}),
            }}
            onKeyDown={e => {
              if (e.key !== "Enter") {
                const now = performance.now();
                if (e.currentTarget.value && now - lastKey.current > 60) typedSlow.current = true;
                lastKey.current = now;
                return;
              }
              e.preventDefault();
              const value = e.currentTarget.value;
              e.currentTarget.value = "";
              const source: ScanSource = typedSlow.current ? "MANUAL" : "KEYBOARD";
              typedSlow.current = false;
              if (normalizeScan(value)) handler.current(normalizeScan(value), source);
            }}
          />
          <button
            type="button"
            className="button"
            title="Scan with the camera"
            disabled={disabled}
            style={{ minHeight: big ? 48 : 38 }}
            onClick={() => openCamera({ title: cameraTitle, continuous: true, onCode: c => handler.current(c, "CAMERA") })}
          >
            <Icon name="camera" />
            Camera
          </button>
          {children}
        </div>
      </div>
    );
  },
);
