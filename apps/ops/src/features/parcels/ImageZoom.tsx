/**
 * A stored image (proof of delivery signature / photo) shown in place; clicking it opens it large over the page
 * (closes with a click, Esc or ✕), with a download button.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { apiRaw, download } from "@panel/lib/api";
import { Icon } from "@panel/ui/Icon";
import "./image-zoom.css";

export function ImageZoom({ path, alt, fileName, light = false }: { path: string; alt: string; fileName: string; light?: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    let url: string | null = null;
    let live = true;
    setFailed(false);
    void apiRaw(path)
      .then(r => {
        if (!r.ok) throw new Error(String(r.status));
        return r.blob();
      })
      .then(b => {
        url = URL.createObjectURL(b);
        if (live) setSrc(url);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path]);

  const show = () => {
    setOpen(true);
    requestAnimationFrame(() => setShown(true));
  };
  const hide = () => {
    setShown(false);
    setTimeout(() => setOpen(false), 200);
  };
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && hide();
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [open]);

  if (failed) return <p className="muted" style={{ margin: "8px 0 0" }}>{`The ${alt.toLowerCase()} couldn't be loaded.`}</p>;
  return (
    <>
      <button type="button" className={`iz-thumb${light ? " light" : ""}`} onClick={show} disabled={!src} aria-label={`Open the ${alt.toLowerCase()} large`} title="Click to open it large">
        {src ? <img src={src} alt={alt} /> : <span className="iz-loading">Loading…</span>}
        {src ? (
          <span className="iz-hint">
            <Icon name="search" size={13} /> Click to enlarge
          </span>
        ) : null}
      </button>
      {open && src
        ? createPortal(
            <div className={`iz-backdrop${shown ? " in" : ""}`} role="dialog" aria-modal="true" aria-label={alt} onMouseDown={e => e.target === e.currentTarget && hide()}>
              <div className="iz-frame">
                <img src={src} alt={alt} className={light ? "light" : ""} onClick={hide} />
                <div className="iz-tools">
                  <button type="button" className="iz-btn" onClick={() => download(path, fileName)}>
                    <Icon name="download" size={15} /> Download
                  </button>
                  <button type="button" className="iz-btn" aria-label="Close" onClick={hide}>
                    <Icon name="x" size={15} />
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
