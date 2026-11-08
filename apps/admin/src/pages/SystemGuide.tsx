/**
 * System guide (bridge-guide.js, GET /guide): what the numbers (PP, MR, HS…) mean, the parcel lifecycle and its SMS /
 * email / push, money steps, roles, and where each setting is changed. Drawn by the same module as the classic panel
 * and the Operations console (legacy/shared/system-guide.js), so all show the same text.
 */
import { useEffect, useRef, useState } from "react";
import { api, describe } from "@panel/lib/api";
import { PageHeading } from "@panel/ui/kit";

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

export default function SystemGuide() {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    loadGuide()
      .then(g => host.current && g.mount(host.current))
      .catch(e => setError((e as Error).message));
  }, []);
  return (
    <>
      <PageHeading eyebrow="Platform control · reference" title="System guide" subtitle="What the numbers (PP, MR, HS…) mean, the parcel lifecycle and its SMS / email / push, money steps, roles, and where each setting is changed." />
      {error ? <div className="callout bad">{error}</div> : null}
      <div ref={host} />
    </>
  );
}
