/**
 * System guide (GET /guide): numbers (PP, MR, HS, ST…), the parcel lifecycle and its SMS / email / push, money steps,
 * roles and where things are changed. The guide is drawn by the same module the super admin console uses
 * (legacy/shared/system-guide.js, so both always show the same text); it only needs DF.api and DF.describe.
 */
import { Icon } from "@/ui/Icon";
import { useEffect, useRef, useState } from "react";
import { api, describe } from "@/lib/api";
import { openCustom } from "@/ui/dialogs";

type Guide = { mount: (el: HTMLElement) => Promise<void> | void };
const w = window as unknown as { DF?: Record<string, unknown> & { systemGuide?: Guide } };
let loading: Promise<Guide> | null = null;

function loadGuide() {
  w.DF = { ...(w.DF ?? {}), api, describe };
  loading ??= new Promise<Guide>((resolve, reject) => {
    if (w.DF?.systemGuide) return resolve(w.DF.systemGuide);
    const script = Object.assign(document.createElement("script"), { src: "/legacy/shared/system-guide.js", async: true });
    script.onload = () => (w.DF?.systemGuide ? resolve(w.DF.systemGuide) : reject(new Error("The guide couldn't be loaded.")));
    script.onerror = () => {
      loading = null;
      reject(new Error("The guide couldn't be loaded. Check the connection and try again."));
    };
    document.head.append(script);
  });
  return loading;
}

export const openSystemGuide = () => openCustom(close => <GuideDialog close={() => close()} />, "xwide");

function GuideDialog({ close }: { close: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    loadGuide()
      .then(g => host.current && g.mount(host.current))
      .catch(e => setError((e as Error).message));
  }, []);
  return (
    <>
      <div className="dialog-head">
        <div>
          <h2>System guide</h2>
          <p>Numbers, parcel lifecycle, notifications, money flow, roles and where things are changed.</p>
        </div>
        <button type="button" className="button ghost icon dialog-close" aria-label="Close" onClick={close}>
          <Icon name="x" size={18} />
        </button>
      </div>
      <div className="dialog-body" style={{ background: "#f6f8fb", maxHeight: "calc(100vh - 140px)" }}>
        {error ? <p style={{ color: "var(--bad)" }}>{error}</p> : null}
        <div ref={host} />
      </div>
    </>
  );
}
