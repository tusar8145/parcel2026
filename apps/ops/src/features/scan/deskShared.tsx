/** Shared by the Scan desk tabs: the scan log and the photo shrinker. */

export interface LogEntry {
  tone: "" | "bad" | "info";
  message: string;
  at: Date;
}

export function LogList({ entries }: { entries: LogEntry[] }) {
  if (!entries.length) return <p className="muted" style={{ marginTop: 14 }}>Scanned parcels appear here.</p>;
  return (
    <ul style={{ listStyle: "none", margin: "14px 0 0", padding: 0, display: "grid", gap: 5, maxHeight: 340, overflow: "auto" }} aria-live="polite">
      {entries.map((e, i) => (
        <li key={i} style={{ fontSize: 13, padding: "7px 10px", borderRadius: 8, background: e.tone === "bad" ? "var(--bad-soft)" : e.tone === "info" ? "var(--surface-3)" : "var(--good-soft)", color: e.tone === "bad" ? "var(--bad)" : e.tone === "info" ? "var(--ink-2)" : "var(--good)" }}>
          <time className="faint" style={{ marginRight: 8 }}>
            {e.at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </time>
          {e.message}
        </li>
      ))}
    </ul>
  );
}

/** The camera photo, shrunk: longest side 1280 px, JPEG, about 100–250 KB. */
export function shrink(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The photo couldn't be read"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("That file isn't a photo"));
      img.onload = () => {
        const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
        let quality = 0.6;
        let url = canvas.toDataURL("image/jpeg", quality);
        while (url.length > 1_000_000 && quality > 0.25) url = canvas.toDataURL("image/jpeg", (quality -= 0.1));
        resolve(url);
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

/** A data URL as a Blob (multipart uploads). */
export function dataUrlBlob(url: string): Blob {
  const [head, data] = url.split(",");
  const mime = /data:([^;]+)/.exec(head)?.[1] || "image/jpeg";
  const bytes = atob(data);
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes.charCodeAt(i);
  return new Blob([out], { type: mime });
}
