/**
 * "Phone scanner" (top bar, bridge-phone-scanner.js; API /phone-scanner): a phone becomes this tab's barcode scanner.
 *   1. Connect: POST /phone-scanner/links → a QR code and link opened on the phone. The link belongs to this tab.
 *   2. Each code the phone reads (phone_scanner.scan, this tab's link) goes into the open page's scan box as a camera
 *      read (deliverScan); the result (✓ / ✗ and its message) goes back to the phone (POST …/results).
 *   3. The link stays alive while this tab is open (every minute; kept across a reload) and Disconnect ends it.
 *      With no scan box open, the code is offered as "Open parcel".
 */
import { Icon } from "@panel/ui/Icon";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router";
import { api, describe } from "@panel/lib/api";
import { events } from "@panel/lib/events";
import { openCustom } from "@panel/ui/dialogs";
import { Button, Pill } from "@panel/ui/kit";
import { toast } from "@panel/ui/toast";
import { deliverScan } from "./scanner";

interface Link {
  id: string;
  url: string;
  qrSvg: string;
  phoneConnected: boolean;
  scans: number;
}
const STORE = "df-phone-scanner";
let link: Link | null = null;
let stray: string | null = null; // a code scanned with no scan box open
let timer: ReturnType<typeof setInterval> | undefined;
const subs = new Set<() => void>();
let version = 0;
const emit = () => {
  version++;
  try {
    if (link) sessionStorage.setItem(STORE, JSON.stringify(link));
    else sessionStorage.removeItem(STORE);
  } catch {
    /* private mode */
  }
  subs.forEach(s => s());
};
const set = (patch: Partial<Link> | null) => {
  link = patch === null ? null : link ? { ...link, ...patch } : null;
  emit();
};

async function connect() {
  const l = await api<{ id: string; url: string; qrSvg: string }>("/phone-scanner/links", { method: "POST" });
  link = { id: l.id, url: l.url, qrSvg: l.qrSvg, phoneConnected: false, scans: 0 };
  keepAlive();
  emit();
}
function keepAlive() {
  clearInterval(timer);
  if (link) timer = setInterval(() => void ping(), 60_000);
}
async function ping() {
  if (!link) return;
  try {
    const v = await api<{ phoneConnected: boolean; scans: number }>(`/phone-scanner/links/${encodeURIComponent(link.id)}/keepalive`, { method: "POST" });
    set({ phoneConnected: v.phoneConnected, scans: v.scans });
  } catch (e) {
    if ((e as { status?: number }).status === 404) {
      ended();
      toast("The phone scanner was disconnected.");
    }
  }
}
function ended() {
  clearInterval(timer);
  set(null);
}
async function disconnect() {
  const l = link;
  if (!l) return;
  ended();
  await api(`/phone-scanner/links/${encodeURIComponent(l.id)}`, { method: "DELETE" }).catch(() => undefined);
  toast("Phone scanner disconnected: its link no longer works.");
}
function report(n: unknown, ok: boolean, message?: string) {
  if (!link) return;
  void api(`/phone-scanner/links/${encodeURIComponent(link.id)}/results`, { method: "POST", body: { n, ok, ...(message ? { message: String(message).slice(0, 200) } : {}) } }).catch(() => undefined);
}

let started = false;
function start() {
  if (started) return;
  started = true;
  events.on("phone_scanner.scan", async d => {
    if (!link || d.linkId !== link.id) return; // another tab's phone
    set({ phoneConnected: true, scans: Math.max(link.scans || 0, Number(d.n) || 0) });
    const code = String(d.code ?? "");
    const result = await deliverScan(code);
    if (!result.delivered) {
      stray = code;
      emit();
      return report(d.n, false, "No scan box is open on the computer. Open a Scan desk tab or a scan page.");
    }
    report(d.n, result.ok, result.message);
  });
  events.on("phone_scanner.status", d => {
    if (!link || d.linkId !== link.id) return;
    set({ phoneConnected: !!d.phoneConnected });
    if (d.phoneConnected) toast("Phone connected: scan labels with it.", "good");
  });
  // Kept across a reload of this tab: check it still works, then keep it alive.
  try {
    link = JSON.parse(sessionStorage.getItem(STORE) || "null");
  } catch {
    link = null;
  }
  if (link) {
    keepAlive();
    void ping();
  }
  emit();
}

const usePhoneScanner = () => {
  useSyncExternalStore(
    cb => (subs.add(cb), () => void subs.delete(cb)),
    () => version,
  );
  return { link, stray };
};

/** The top bar button (its label shows the state) and the "Scanned on the phone" note. */
export function PhoneScannerButton() {
  useEffect(start, []);
  const { link: l, stray: code } = usePhoneScanner();
  const [, setParams] = useSearchParams();
  const label = !l ? "Phone scanner" : l.phoneConnected ? `Phone connected${l.scans ? ` · ${l.scans}` : ""}` : "Phone: waiting…";
  const style = !l ? undefined : l.phoneConnected ? { borderColor: "#12a150", color: "#0f7a3d" } : { borderColor: "#8a5a00", color: "#8a5a0b" };
  return (
    <>
      <Button size="sm" icon="phoneScan" aria-haspopup="dialog" title="Use a phone as this screen's barcode scanner" style={style} data-state={!l ? "off" : l.phoneConnected ? "connected" : "waiting"} onClick={() => void openCustom(close => <PhoneDialog close={() => close()} />)}>
        <span className="hide-sm">{label}</span>
      </Button>
      {code
        ? createPortal(
            <div role="status" style={{ position: "fixed", right: 18, bottom: 18, zIndex: 130, background: "#fff", border: "1px solid var(--line)", borderRadius: 10, boxShadow: "var(--shadow-lg)", padding: "12px 14px", display: "grid", gap: 8, maxWidth: 320, fontSize: 13 }}>
              <div>
                <strong>Scanned on the phone</strong>
                <div style={{ fontFamily: "ui-monospace, monospace", marginTop: 3 }}>{code}</div>
                <small className="faint">No scan box is open on this page.</small>
              </div>
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <Button size="sm" onClick={() => ((stray = null), emit())}>
                  Dismiss
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    setParams(p => (p.set("parcel", code), p));
                    stray = null;
                    emit();
                  }}
                >
                  Open parcel
                </Button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function PhoneDialog({ close }: { close: () => void }) {
  const { link: l } = usePhoneScanner();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!link) void connect().catch(e => setError(describe(e)));
  }, []);
  return (
    <>
      <div className="dialog-head">
        <div>
          <h2>Phone scanner</h2>
          <p>Use a phone as this screen's barcode scanner.</p>
        </div>
        <button type="button" className="button ghost icon dialog-close" aria-label="Close" onClick={close}>
          <Icon name="x" size={18} />
        </button>
      </div>
      <div className="dialog-body">
        {!l ? (
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
          <div style={{ display: "grid", gap: 12, justifyItems: "center", textAlign: "center" }}>
            <div style={{ width: 220, height: 220 }} dangerouslySetInnerHTML={{ __html: l.qrSvg.replace("<svg", '<svg style="width:100%;height:100%"') }} />
            {l.phoneConnected ? <Pill tone="good">{`Phone connected · ${l.scans || 0} scan${l.scans === 1 ? "" : "s"}`}</Pill> : <Pill tone="warn">Waiting for the phone…</Pill>}
            <p style={{ margin: 0, fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
              Scan this QR code with the phone's camera, or open the link on the phone. Codes the phone reads go into the scan box of the page open here (Scan desk, Parcel queue, Transfers…), and the phone beeps with the result.
            </p>
            <div className="row" style={{ width: "100%", flexWrap: "nowrap" }}>
              <input className="input sm" readOnly value={l.url} aria-label="Phone link" onFocus={e => e.target.select()} />
              <Button size="sm" onClick={() => navigator.clipboard?.writeText(l.url).then(() => toast("Link copied. Open it on the phone."), () => undefined)}>
                Copy
              </Button>
            </div>
            <small className="faint">The link works only for this tab, while it is open. Another tab or computer connects its own phone.</small>
          </div>
        )}
      </div>
      <div className="dialog-foot">
        {l ? (
          <Button style={{ color: "var(--bad)", marginRight: "auto" }} onClick={() => (close(), void disconnect())}>
            Disconnect
          </Button>
        ) : null}
        <Button variant="primary" onClick={close}>
          Done
        </Button>
      </div>
    </>
  );
}
