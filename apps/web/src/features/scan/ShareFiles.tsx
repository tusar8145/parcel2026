"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A "Share files" link opened on another device (QR code in Courier Operations › Share files): drop or
 * choose files; each is sent on its own (POST /file-shares/public/:token/files) and shows on the computer.
 * The link stops working when the dialog on the computer is closed.
 */

const API = "/api/v1/file-shares/public";

interface Item {
  key: number;
  name: string;
  size: number;
  state: "waiting" | "sending" | "sent" | "failed";
  progress: number;
  problem?: string;
}

const describe = (status: number, text: string) => {
  try {
    return (JSON.parse(text) as { error?: { message?: string } }).error?.message || `Error ${status}`;
  } catch {
    return `Error ${status}`;
  }
};
const size = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export default function ShareFiles({ token }: { token: string }) {
  const [state, setState] = useState<"loading" | "ready" | "closed">("loading");
  const [problem, setProblem] = useState("");
  const [maxMb, setMaxMb] = useState(25);
  const [items, setItems] = useState<Item[]>([]);
  const [over, setOver] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const queue = useRef(Promise.resolve());
  const next = useRef(0);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`${API}/${encodeURIComponent(token)}`, { cache: "no-store" });
        if (res.status === 410 || res.status === 404) return setState("closed");
        if (!res.ok) return setProblem(describe(res.status, await res.text()));
        const body = (await res.json()) as { maxFileMb: number; files: { name: string; size: number }[] };
        setMaxMb(body.maxFileMb);
        setItems(body.files.map(f => ({ key: next.current++, name: f.name, size: f.size, state: "sent", progress: 1 })));
        setState("ready");
      } catch {
        setProblem("No connection. Check the internet and open the link again.");
      }
    })();
  }, [token]);

  const update = (key: number, change: Partial<Item>) => setItems(list => list.map(i => (i.key === key ? { ...i, ...change } : i)));

  /** XHR for the upload progress. */
  const send = (key: number, file: File) =>
    new Promise<void>(resolve => {
      update(key, { state: "sending", progress: 0 });
      const form = new FormData();
      form.append("file", file, file.name);
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${API}/${encodeURIComponent(token)}/files`);
      xhr.upload.onprogress = e => e.lengthComputable && update(key, { progress: e.loaded / e.total });
      xhr.onload = () => {
        if (xhr.status === 410) setState("closed");
        if (xhr.status >= 200 && xhr.status < 300) update(key, { state: "sent", progress: 1 });
        else update(key, { state: "failed", problem: describe(xhr.status, xhr.responseText) });
        resolve();
      };
      xhr.onerror = () => (update(key, { state: "failed", problem: "Not sent: no connection." }), resolve());
      xhr.send(form);
    });

  const add = (files: FileList | File[] | null | undefined) => {
    if (!files?.length || state !== "ready") return;
    setProblem("");
    for (const file of Array.from(files)) {
      const key = next.current++;
      const tooBig = file.size > maxMb * 1024 * 1024;
      setItems(list => [...list, { key, name: file.name, size: file.size, state: tooBig ? "failed" : "waiting", progress: 0, problem: tooBig ? `Larger than ${maxMb} MB` : undefined }]);
      // One at a time, in order.
      if (!tooBig) queue.current = queue.current.then(() => send(key, file));
    }
  };

  const sending = items.some(i => i.state === "sending" || i.state === "waiting");
  const sent = items.filter(i => i.state === "sent").length;

  return (
    <main className="sf">
      <style>{CSS}</style>
      <header className="sf-head">
        <strong>{"Paira Express"}</strong>
        <span>{"Share files with the computer"}</span>
      </header>
      {state === "closed" ? (
        <section className="sf-card" role="alert">
          <h1>{"Link no longer works"}</h1>
          <p>{"The window on the computer was closed, or the link expired. Ask for a new QR code."}</p>
        </section>
      ) : (
        <>
          <button
            type="button"
            className={`sf-drop${over ? " over" : ""}`}
            disabled={state !== "ready"}
            onClick={() => picker.current?.click()}
            onDragOver={e => (e.preventDefault(), setOver(true))}
            onDragLeave={() => setOver(false)}
            onDrop={e => (e.preventDefault(), setOver(false), add(e.dataTransfer.files))}
          >
            <strong>{state === "loading" ? "Loading…" : "Drop files here"}</strong>
            <span>{`or tap to choose · up to ${maxMb} MB each`}</span>
          </button>
          <input ref={picker} type="file" multiple hidden onChange={e => (add(e.target.files), (e.target.value = ""))} />
          {problem ? (
            <p className="sf-problem" role="alert">
              {problem}
            </p>
          ) : null}
          {items.length ? (
            <section className="sf-card">
              <p className="sf-sum" role="status">
                {sending ? "Sending…" : `${sent} file${sent === 1 ? "" : "s"} on the computer`}
              </p>
              <ul className="sf-list">
                {items.map(i => (
                  <li key={i.key} className={i.state}>
                    <span className="sf-name">{i.name}</span>
                    <small>{i.state === "failed" ? i.problem || "Not sent" : i.state === "sent" ? `${size(i.size)} · sent ✓` : i.state === "sending" ? `${Math.round(i.progress * 100)}%` : "Waiting…"}</small>
                    {i.state === "sending" ? <progress max={1} value={i.progress} /> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </main>
  );
}

const CSS = `
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f4f6fa;color:#1d2939}
.sf{max-width:560px;margin:0 auto;padding:12px 14px 40px;display:grid;gap:12px}
.sf-head{display:grid;gap:2px;background:#2f62e3;color:#fff;border-radius:12px;padding:12px 14px}.sf-head span{font-size:14px;opacity:.9}
.sf-drop{display:grid;gap:6px;place-items:center;align-content:center;text-align:center;min-height:200px;padding:20px;border:2px dashed #c9d2df;border-radius:12px;color:#647184;background:#fff;font:inherit;cursor:pointer}
.sf-drop strong{font-size:18px;color:#344054}.sf-drop.over{border-color:#2f62e3;background:#eef3ff}.sf-drop:disabled{opacity:.6}
.sf-problem{margin:0;color:#b42318;font-weight:600;font-size:14px}
.sf-card{background:#fff;border:1px solid #e4e7ec;border-radius:12px;padding:14px 16px}.sf-card h1{margin:0 0 8px;font-size:20px}.sf-card p{margin:0;color:#475467;line-height:1.5}
.sf-sum{font-weight:600;margin-bottom:8px!important}
.sf-list{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.sf-list li{display:grid;gap:2px;padding:8px 10px;border-radius:8px;background:#f6f8fb}
.sf-list li.sent small{color:#0f7a3d}.sf-list li.failed small{color:#b42318}
.sf-name{font-weight:600;font-size:14px;overflow-wrap:anywhere}.sf-list small{color:#647184;font-size:12.5px}
.sf-list progress{width:100%;height:6px}
`;
