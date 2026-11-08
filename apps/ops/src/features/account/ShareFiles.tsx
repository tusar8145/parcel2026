/**
 * "Share files" (top bar, bridge-share.js; API /file-shares): files from a phone or another computer by QR code.
 *   1. POST /file-shares → a QR code and link, opened on the other device, which drops or chooses files.
 *   2. Each file arrives here (file_share.received, or GET /file-shares/:id every 20 s, which also keeps the link
 *      alive) and is listed with Download.
 *   3. Closing the dialog ends the link and deletes the files (DELETE /file-shares/:id). Nothing is kept.
 */
import { Icon } from "@panel/ui/Icon";
import { useEffect, useRef, useState } from "react";
import { api, apiRaw, describe } from "@panel/lib/api";
import { events } from "@panel/lib/events";
import { openCustom } from "@panel/ui/dialogs";
import { Button } from "@panel/ui/kit";
import { toast, toastError } from "@panel/ui/toast";

interface Share {
  id: string;
  url: string;
  qrSvg: string;
  maxFileMb: number;
}
interface SharedFile {
  id: string;
  name: string;
  size: number;
  at: string;
}
const size = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const end = (share: Share | null, keepalive = false) => {
  if (share) void apiRaw(`/file-shares/${encodeURIComponent(share.id)}`, { method: "DELETE", keepalive }).catch(() => undefined);
};

export const openShareFiles = () => openCustom(close => <ShareDialog close={() => close()} />);

function ShareDialog({ close }: { close: () => void }) {
  const [share, setShare] = useState<Share | null>(null);
  const [files, setFiles] = useState<SharedFile[]>([]);
  const [error, setError] = useState("");
  const shareRef = useRef<Share | null>(null);
  useEffect(() => {
    let closed = false;
    api<Share>("/file-shares", { method: "POST" }).then(
      s => (closed ? end(s) : ((shareRef.current = s), setShare(s))),
      e => setError(describe(e)),
    );
    // The tab closes or reloads with the dialog open: end the link too.
    const hide = () => end(shareRef.current, true);
    addEventListener("pagehide", hide);
    return () => {
      closed = true;
      removeEventListener("pagehide", hide);
      end(shareRef.current);
      shareRef.current = null;
    };
  }, []);
  useEffect(() => {
    if (!share) return;
    const refresh = async () => {
      try {
        const r = await api<{ files: SharedFile[] }>(`/file-shares/${encodeURIComponent(share.id)}`);
        setFiles(r.files);
      } catch (e) {
        if ((e as { status?: number }).status === 404) {
          clearInterval(timer);
          setError("The link expired. Close this window and open Share files again.");
        }
      }
    };
    const timer = setInterval(refresh, 20_000);
    const off = events.on("file_share.received", d => {
      const file = d.file as SharedFile | undefined;
      if (d.shareId !== share.id || !file) return;
      setFiles(list => (list.some(f => f.id === file.id) ? list : [...list, file]));
      toast(`File received: ${file.name}`);
    });
    return () => (clearInterval(timer), off());
  }, [share]);
  async function download(file: SharedFile) {
    if (!share) return;
    try {
      const response = await apiRaw(`/file-shares/${encodeURIComponent(share.id)}/files/${encodeURIComponent(file.id)}`);
      const url = URL.createObjectURL(await response.blob());
      const link = Object.assign(document.createElement("a"), { href: url, download: file.name });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      toastError(e);
    }
  }
  return (
    <>
      <div className="dialog-head">
        <div>
          <h2>Share files</h2>
          <p>Send files here from a phone or another computer.</p>
        </div>
        <button type="button" className="button ghost icon dialog-close" aria-label="Close" onClick={close}>
          <Icon name="x" size={18} />
        </button>
      </div>
      <div className="dialog-body">
        {!share ? (
          error ? (
            <p role="alert" style={{ color: "var(--bad)", fontWeight: 600 }}>
              {error}
            </p>
          ) : (
            <p className="faint" style={{ padding: "24px 0", textAlign: "center" }}>
              Creating the link…
            </p>
          )
        ) : (
          <div className="stack">
            <div className="row" style={{ alignItems: "center", gap: 14, flexWrap: "wrap" }}>
              <div style={{ width: 170, height: 170, flex: "none" }} dangerouslySetInnerHTML={{ __html: share.qrSvg.replace("<svg", '<svg style="width:100%;height:100%"') }} />
              <div className="stack" style={{ gap: 8, flex: 1, minWidth: 220 }}>
                <p style={{ margin: 0, fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
                  Scan the QR code with the phone's camera, or open the link on another device, then drop or choose files (up to {share.maxFileMb} MB each).
                </p>
                <div className="row" style={{ flexWrap: "nowrap" }}>
                  <input className="input sm" readOnly value={share.url} aria-label="Share link" onFocus={e => e.target.select()} />
                  <Button size="sm" onClick={() => navigator.clipboard?.writeText(share.url).then(() => toast("Link copied."), () => undefined)}>
                    Copy
                  </Button>
                </div>
              </div>
            </div>
            <div>
              <strong style={{ display: "block", fontSize: 13, marginBottom: 6 }}>Files received · {files.length}</strong>
              {files.length ? (
                <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6, maxHeight: 260, overflow: "auto" }}>
                  {files.map(f => (
                    <li key={f.id} className="row" style={{ flexWrap: "nowrap", padding: "8px 10px", border: "1px solid var(--line)", borderRadius: 8 }}>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <strong style={{ display: "block", fontSize: 13, overflowWrap: "anywhere" }}>{f.name}</strong>
                        <small className="faint">
                          {size(f.size)} · {new Date(f.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                        </small>
                      </span>
                      <Button size="sm" icon="download" onClick={() => download(f)}>
                        Download
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p style={{ margin: 0, padding: 14, border: "1px dashed var(--line-strong)", borderRadius: 8, textAlign: "center", color: "var(--faint)", fontSize: 13 }}>No files yet. They appear here as soon as they are sent.</p>
              )}
            </div>
            {error ? (
              <p role="alert" style={{ margin: 0, color: "var(--bad)", fontSize: 13 }}>
                {error}
              </p>
            ) : null}
          </div>
        )}
      </div>
      <div className="dialog-foot">
        <span className="faint" style={{ marginRight: "auto", fontSize: 12 }}>
          Closing ends the link and deletes the files.
        </span>
        <Button variant="primary" onClick={close}>
          Done
        </Button>
      </div>
    </>
  );
}
