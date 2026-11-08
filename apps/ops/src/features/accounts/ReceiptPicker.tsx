/**
 * A receipt / proof photo for money actions (bridge-accounts.js receipt): upload a photo (shrunk to 1600 px JPEG), or
 * "Use phone": a one-photo QR link (POST /photo-links) the phone opens; the photo arrives here ("photo_link.done"
 * event, polled every 3 s). The link is deleted when the dialog closes.
 */
import { useEffect, useRef, useState } from "react";
import { api, describe } from "@/lib/api";
import { events } from "@/lib/events";

export interface ReceiptValue {
  dataUrl: string | null;
}

const shrinkPhoto = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
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

export default function ReceiptPicker({ title, value }: { title: string; value: ReceiptValue }) {
  const [dataUrl, setDataUrl] = useState<string | null>(value.dataUrl);
  const [link, setLink] = useState<{ id: string; qrSvg: string } | null>(null);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const linkRef = useRef(link);
  linkRef.current = link;
  useEffect(() => void (value.dataUrl = dataUrl), [dataUrl, value]);
  useEffect(
    () => () => {
      if (linkRef.current) void api(`/photo-links/${encodeURIComponent(linkRef.current.id)}`, { method: "DELETE" }).catch(() => undefined);
    },
    [],
  );
  useEffect(() => {
    if (!link) return;
    const check = async () => {
      try {
        const r = await api<{ status: string; dataUrl?: string }>(`/photo-links/${encodeURIComponent(link.id)}`);
        if (r.status !== "done") return;
        setDataUrl(r.dataUrl ?? null);
        setLink(null);
      } catch (e) {
        if ((e as { status?: number })?.status === 404) {
          setLink(null);
          setError("The phone link expired. Try again.");
        }
      }
    };
    const timer = setInterval(check, 3000);
    const off = events.on("photo_link.done", d => d.linkId === link.id && void check());
    return () => (clearInterval(timer), off());
  }, [link]);

  return (
    <div>
      {dataUrl ? (
        <div className="row">
          <img src={dataUrl} alt="Receipt" style={{ width: 96, height: 96, objectFit: "cover", borderRadius: 8, border: "1px solid var(--line)" }} />
          <span className="pill good">Attached</span>
          <button type="button" className="button sm" onClick={() => setDataUrl(null)}>
            Remove
          </button>
        </div>
      ) : link ? (
        <div className="row" style={{ alignItems: "center" }}>
          <div style={{ width: 150, height: 150 }} dangerouslySetInnerHTML={{ __html: link.qrSvg.replace("<svg", '<svg style="width:100%;height:100%"') }} />
          <div className="stack" style={{ gap: 6, maxWidth: 300 }}>
            <strong>Scan with the phone</strong>
            <span className="muted">Take the photo and tap Done. It appears here; the link then stops working.</span>
            <button
              type="button"
              className="button sm"
              onClick={() => {
                void api(`/photo-links/${encodeURIComponent(link.id)}`, { method: "DELETE" }).catch(() => undefined);
                setLink(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="row">
            <button type="button" className="button sm" onClick={() => input.current?.click()}>
              Upload photo
            </button>
            <button
              type="button"
              className="button sm"
              onClick={async () => {
                setError("");
                try {
                  setLink(await api<{ id: string; qrSvg: string }>("/photo-links", { method: "POST", body: { title } }));
                } catch (e) {
                  setError(describe(e));
                }
              }}
            >
              Use phone
            </button>
            <input
              ref={input}
              type="file"
              accept="image/*"
              hidden
              onChange={async e => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                try {
                  setDataUrl(await shrinkPhoto(f));
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            />
          </div>
          <small className="faint">Optional: a photo of the bank slip or wallet screen.</small>
        </>
      )}
      {error ? (
        <p role="alert" style={{ margin: "6px 0 0", color: "var(--bad)", fontSize: 13 }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
