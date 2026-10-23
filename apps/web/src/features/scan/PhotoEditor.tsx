"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Crop and rotate a parcel photo on the phone before it is sent (Scan with phone): the photo opens
 * upright (its EXIF orientation applied), turns a quarter at a time, and a frame dragged by its corners
 * (or moved by its middle) keeps only the label. Submit hands back the cropped photo as a JPEG of at
 * most `maxSide` px on its long side.
 */

interface Crop {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
type Mode = "move" | "nw" | "ne" | "sw" | "se";

const FULL: Crop = { x0: 0, y0: 0, x1: 1, y1: 1 };
/** The working copy's long side: sharp enough for the label, light enough for a phone. */
const WORK_SIDE = 2400;
const MIN = 0.1;

async function decode(file: Blob): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => null);
  const source: CanvasImageSource & { width: number; height: number } =
    bitmap ??
    (await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("This photo can't be opened. Take it again with the camera."));
      img.src = URL.createObjectURL(file);
    }));
  const scale = Math.min(1, WORK_SIDE / Math.max(source.width, source.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(source.width * scale);
  canvas.height = Math.round(source.height * scale);
  canvas.getContext("2d")!.drawImage(source, 0, 0, canvas.width, canvas.height);
  bitmap?.close();
  return canvas;
}

/** The picture turned a quarter clockwise (1) or anticlockwise (-1). */
function turn(source: HTMLCanvasElement, dir: 1 | -1) {
  const canvas = document.createElement("canvas");
  canvas.width = source.height;
  canvas.height = source.width;
  const ctx = canvas.getContext("2d")!;
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((dir * Math.PI) / 2);
  ctx.drawImage(source, -source.width / 2, -source.height / 2);
  return canvas;
}

export default function PhotoEditor({
  file,
  index,
  total,
  maxSide,
  quality,
  onSubmit,
  onSkip,
}: {
  file: Blob;
  index: number;
  total: number;
  maxSide: number;
  quality: number;
  onSubmit: (photo: Blob) => void;
  onSkip: () => void;
}) {
  const [work, setWork] = useState<HTMLCanvasElement | null>(null);
  const [crop, setCrop] = useState<Crop>(FULL);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const shown = useRef<HTMLCanvasElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ mode: Mode; x: number; y: number; start: Crop } | null>(null);

  useEffect(() => {
    let live = true;
    setWork(null);
    setCrop(FULL);
    setError("");
    decode(file).then(
      canvas => live && setWork(canvas),
      e => live && setError(e instanceof Error ? e.message : "This photo can't be opened."),
    );
    return () => {
      live = false;
    };
  }, [file]);

  // The working copy, drawn on screen (CSS fits it; the crop frame lies over it).
  useEffect(() => {
    const canvas = shown.current;
    if (!canvas || !work) return;
    canvas.width = work.width;
    canvas.height = work.height;
    canvas.getContext("2d")!.drawImage(work, 0, 0);
  }, [work]);

  const rotate = (dir: 1 | -1) => {
    if (!work) return;
    setWork(turn(work, dir));
    setCrop(FULL);
  };

  const start = (mode: Mode) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { mode, x: e.clientX, y: e.clientY, start: crop };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    const rect = frame.current?.getBoundingClientRect();
    if (!d || !rect) return;
    const dx = (e.clientX - d.x) / rect.width;
    const dy = (e.clientY - d.y) / rect.height;
    const s = d.start;
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    if (d.mode === "move") {
      const w = s.x1 - s.x0;
      const h = s.y1 - s.y0;
      const x0 = clamp(s.x0 + dx, 0, 1 - w);
      const y0 = clamp(s.y0 + dy, 0, 1 - h);
      return setCrop({ x0, y0, x1: x0 + w, y1: y0 + h });
    }
    const next = { ...s };
    if (d.mode.includes("w")) next.x0 = clamp(s.x0 + dx, 0, s.x1 - MIN);
    if (d.mode.includes("e")) next.x1 = clamp(s.x1 + dx, s.x0 + MIN, 1);
    if (d.mode.includes("n")) next.y0 = clamp(s.y0 + dy, 0, s.y1 - MIN);
    if (d.mode.includes("s")) next.y1 = clamp(s.y1 + dy, s.y0 + MIN, 1);
    setCrop(next);
  };
  const end = () => {
    drag.current = null;
  };

  const submit = async () => {
    if (!work || busy) return;
    setBusy(true);
    try {
      const sx = Math.round(crop.x0 * work.width);
      const sy = Math.round(crop.y0 * work.height);
      const sw = Math.max(1, Math.round((crop.x1 - crop.x0) * work.width));
      const sh = Math.max(1, Math.round((crop.y1 - crop.y0) * work.height));
      const scale = Math.min(1, maxSide / Math.max(sw, sh));
      const out = document.createElement("canvas");
      out.width = Math.round(sw * scale);
      out.height = Math.round(sh * scale);
      out.getContext("2d")!.drawImage(work, sx, sy, sw, sh, 0, 0, out.width, out.height);
      const blob = await new Promise<Blob>((resolve, reject) => out.toBlob(b => (b ? resolve(b) : reject(new Error("The photo couldn't be saved"))), "image/jpeg", quality));
      onSubmit(blob);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The photo couldn't be saved");
      setBusy(false);
    }
  };

  const pct = (v: number) => `${(v * 100).toFixed(3)}%`;
  return (
    <div className="editor" role="dialog" aria-modal="true" aria-label="Crop and rotate the photo">
      <div className="editor-head">
        <strong>{total > 1 ? `Photo ${index} of ${total}` : "Your photo"}</strong>
        <span>{"Drag the corners around the label, turn it upright, then Submit."}</span>
      </div>
      <div className="editor-stage">
        {error ? (
          <p className="problem" role="alert">
            {error}
          </p>
        ) : !work ? (
          <p className="loading">{"Opening the photo…"}</p>
        ) : (
          <div className="editor-frame" ref={frame} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
            <canvas ref={shown} aria-label="The photo" />
            <div
              className="editor-crop"
              data-crop
              style={{ left: pct(crop.x0), top: pct(crop.y0), width: pct(crop.x1 - crop.x0), height: pct(crop.y1 - crop.y0) }}
              onPointerDown={start("move")}
            >
              {(["nw", "ne", "sw", "se"] as const).map(corner => (
                <span key={corner} className={`handle ${corner}`} data-handle={corner} onPointerDown={start(corner)} aria-hidden="true" />
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="editor-tools">
        <button type="button" onClick={() => rotate(-1)} disabled={!work} aria-label="Rotate left">
          {"↺ Rotate left"}
        </button>
        <button type="button" onClick={() => rotate(1)} disabled={!work} aria-label="Rotate right">
          {"↻ Rotate right"}
        </button>
        <button type="button" onClick={() => setCrop(FULL)} disabled={!work}>
          {"Reset"}
        </button>
      </div>
      <div className="editor-actions">
        <button type="button" onClick={onSkip}>
          {"Skip"}
        </button>
        <button type="button" className="primary" data-submit onClick={() => void submit()} disabled={!work || busy}>
          {busy ? "Saving…" : "Submit"}
        </button>
      </div>
    </div>
  );
}

export const EDITOR_CSS = `
.editor{position:fixed;inset:0;z-index:20;display:flex;flex-direction:column;gap:10px;padding:12px 12px max(12px,env(safe-area-inset-bottom));background:#0f172a;color:#e2e8f0}
.editor-head{display:grid;gap:2px}
.editor-head strong{font-size:16px;color:#fff}
.editor-head span{font-size:13px;color:#94a3b8}
.editor-stage{flex:1;min-height:0;display:grid;place-items:center;overflow:hidden}
.editor-frame{position:relative;display:inline-block;max-width:100%;max-height:100%;overflow:hidden;touch-action:none;user-select:none;-webkit-user-select:none}
.editor-frame canvas{display:block;max-width:100%;max-height:calc(100vh - 230px);width:auto;height:auto}
.editor-crop{position:absolute;box-shadow:0 0 0 9999px rgba(2,6,23,.6);outline:2px solid #fff;cursor:move;touch-action:none}
.editor-crop .handle{position:absolute;width:30px;height:30px;border:3px solid #fff;background:rgba(47,98,227,.35);border-radius:6px;touch-action:none}
.editor-crop .handle.nw{left:-2px;top:-2px;cursor:nwse-resize}
.editor-crop .handle.ne{right:-2px;top:-2px;cursor:nesw-resize}
.editor-crop .handle.sw{left:-2px;bottom:-2px;cursor:nesw-resize}
.editor-crop .handle.se{right:-2px;bottom:-2px;cursor:nwse-resize}
.editor-tools,.editor-actions{display:grid;grid-template-columns:repeat(auto-fit,minmax(0,1fr));gap:8px}
.editor button{min-height:46px;background:#1e293b;border-color:#334155;color:#e2e8f0}
.editor button.primary{background:#2f62e3;border-color:#2f62e3;color:#fff}
.editor .loading{color:#94a3b8}
`;
